// Telegram bot — multi-user product (stage 19) on top of the stage-7 bot: registration, buttons-first UX in
// ru/uz/en, per-user settings in SQLite, quotas and credits, a fair global job queue with real cancel,
// progress cards edited in place, admin panel, retention cleanup. Pipelines live in ./pipelines.ts; every
// update is isolated in try/catch, so one bad update never stops the bot.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exists, jobDir, loadJob, readJson, WORKSPACE_ROOT } from "../lib/workspace.ts";
import { withJobSignal } from "../lib/abort.ts";
import { detectAspect, isAspect, type Aspect } from "../lib/aspect.ts";
import { PlanError } from "../plan/backend/types.ts";
import { CostSchema } from "../schemas/index.ts";
import { getVoice, isCloud, NO_VOICE, piperVoiceFor, sampleVoiceFor, type VoiceDef } from "../voice/catalog.ts";
import { downloadLink, findLinks, LinkError, linkKey, linkMaxBytes, textWithoutLinks, type DownloadLinkOptions } from "../ingest/links.ts";
import { isFileTooBig, makeBotApi, TelegramError, type BotApi, type CallMethod, type DownloadFn, type InlineKeyboard, type Limits, type ReplyMarkup, type TgCallbackQuery, type TgMessage, type TgUpdate, type TgUser } from "./telegram-api.ts";
import { BotDb, isLang, type JobKind, type JobRow, type Lang, type UserRow } from "./db.ts";
import { hasGoogleTtsKey, menuAction, STRINGS, t, voiceLabel, type MenuAction, type SendMode, type Strings } from "./i18n.ts";
import { adminHandlers } from "./admin.ts";
import { JobQueue, type JobOutcome } from "./queue.ts";
import { canonicalUrl, findUrl, StyleCache, tgAlias } from "../style/cache.ts";
import type { ExtractInput, ExtractResult } from "../style/extract.ts";
import { mapStyle, styleSummary } from "../style/map.ts";
import { StyleProfileSchema } from "../style/profile.ts";
import { runRetention, type RetentionReport } from "./retention.ts";
import { dailyBudgetUsdFromEnv, dayStart, freePlanFromEnv, maxJobsFromEnv, retentionDaysFromEnv, tzOffsetFromEnv, userDailyJobsFromEnv, type JobClass, type PlanLimits } from "./plans.ts";
import {
  cancelKb,
  langKb,
  mainMenu,
  makeKb,
  montageKb,
  PRESET_STYLE,
  purposeKb,
  resultKb,
  retryKb,
  settingsKb,
  STYLE_PRESET,
  termsKb,
  voicesKb,
  byteLength,
  CALLBACK_LIMIT,
  type MakeDraft,
  type MontageDraft,
  type MontageMode,
} from "./keyboards.ts";
import {
  CancelledError,
  excerpt,
  HINTS,
  runAvatarExport,
  runAvatarImport,
  runFullPipeline,
  runMakePipeline,
  runRevisePipeline,
  type AvatarExportFn,
  type AvatarImportFn,
  type MakeFn,
  type PipelineFn,
  type PipelineOutput,
  type PipelineResult,
  type ReviseFn,
} from "./pipelines.ts";

export * from "./pipelines.ts";
export { STRINGS, t, menuAction } from "./i18n.ts";
export type { SendMode } from "./i18n.ts";

/** the instruction behind /viral and the «Один вирусный ролик» button (goes to the planner, always Russian) */
export const VIRAL_INSTRUCTION =
  "Собери один самый вирусный ролик 30–45 секунд из всех видео: самый сильный хук в первые 2 секунды, только лучшие моменты (эмоция, сильная мысль, неожиданный поворот, смешное), динамичный темп, каждый клип — законченная фраза, финал с законченной мыслью. Субтитры на языке речи.";

/** Russian UI strings (the default language) + the /viral instruction — kept for the stage 7–16 tests and callers */
export const MSG = { ...STRINGS.ru, viral: VIRAL_INSTRUCTION };

// ── per-user state ─────────────────────────────────────────────────────────────

export const SessionSchema = z.object({
  /** the last uploaded video and the batch for the next run (several → one combined source) */
  source: z.string().optional(),
  sources: z.array(z.string()).default([]),
  /** a run used the batch: the next video starts a new one */
  batch_closed: z.boolean().default(false),
  /** seconds per uploaded file (Telegram metadata or ffprobe) — long-job detection */
  durations: z.record(z.string(), z.number()).default({}),
  /** the pipeline job of the last run (for /revise and /status) */
  jobId: z.string().optional(),
  prompt: z.string().optional(),
  avatar_photo: z.string().optional(),
  avatar_voice: z.string().optional(),
  avatar_job: z.string().optional(),
  /** what the next text means: topic | avatar | edit:<botJob> | admin_find | admin_broadcast */
  awaiting: z.string().optional(),
  /** the mode chosen in the menu before uploading (🏀 → hl) */
  intent: z.enum(["reels", "viral", "hl", "pp"]).optional(),
  draft: z.object({ mode: z.enum(["reels", "viral", "hl", "pp"]), count: z.number(), seconds: z.number(), aspect: z.string(), style: z.string() }).optional(),
  /** the option card of the open batch: more uploads edit it instead of sending a new card */
  card: z.number().optional(),
  make: z.object({ topic: z.string(), aspect: z.string(), voice: z.string() }).optional(),
  /** «🎯 Монтаж как в примере»: the style profile of the reference (workspace/_cache/style/<key>.json) */
  ref: z.string().optional(),
  /** the analysis was just made and is not yet billed to a job */
  ref_fresh: z.boolean().optional(),
  broadcast: z.string().optional(),
  /** what the user is doing (last menu choice or upload): a photo during a montage is not an avatar photo */
  ctx: z.enum(["montage", "avatar", "make"]).optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// stage 7–18 state.json (one entry per chat) — read once and migrated into the DB
export const ChatStateSchema = z.object({
  source: z.string().optional(),
  sources: z.array(z.string()).default([]),
  batch_closed: z.boolean().default(false),
  style: z.string().optional(),
  jobId: z.string().optional(),
  prompt: z.string().optional(),
  avatar_photo: z.string().optional(),
  avatar_voice: z.string().optional(),
  avatar_job: z.string().optional(),
  voice: z.string().optional(),
  send: z.enum(["file", "video", "both"]).optional(),
  updated_at: z.string().optional(),
});
export const BotStateSchema = z.object({
  version: z.literal(1).default(1),
  offset: z.number().int().optional(),
  chats: z.record(z.string(), ChatStateSchema).default({}),
});
export type ChatState = z.infer<typeof ChatStateSchema>;
export type BotState = z.infer<typeof BotStateSchema>;

export const SEND_MODES: Record<string, SendMode> = { file: "file", document: "file", doc: "file", файл: "file", файлом: "file", fayl: "file", video: "video", видео: "video", both: "both", оба: "both", все: "both", ikkalasi: "both" };

/** /style names → presets */
export const STYLES: Record<string, string> = { pop: "bold_pop", bold: "bold_pop", bold_pop: "bold_pop", clean: "clean_min", clean_min: "clean_min", expert: "clean_min", box: "box_reveal", box_reveal: "box_reveal", karaoke: "box_reveal", split: "split_news", news: "split_news", split_news: "split_news", calm: "calm" };

/** a style named in the instruction itself ("в стиле сплит", "как у aleko") */
export function styleFromText(text: string): string | undefined {
  if (/(сплит|split|как у aleko|как aleko|новостн\w* сплит|карточк\w* сверху)/i.test(text)) return "split_news";
  if (/(как у эксперт\w*|экспертн\w* стил\w*|как у маргулан\w*|чист\w* субтитр\w*)/i.test(text)) return "clean_min";
  if (/(плашк\w* с подсветк\w*|караоке|как у таневск\w*)/i.test(text)) return "box_reveal";
  return undefined;
}

/** "/make 16:9 тема" → { aspect: "16:9", topic: "тема" }; without a leading ratio the words decide (default 9:16). */
export function parseMakeArgs(arg: string): { topic: string; aspect: Aspect } {
  const m = /^\s*(9:16|16:9|1:1)\s+([\s\S]*)$/.exec(arg);
  const topic = (m ? m[2] : arg).trim();
  return { topic, aspect: m && isAspect(m[1]) ? m[1] : (detectAspect(topic) ?? "9:16") };
}

/** the frame was asked for (a leading ratio or format words) — otherwise the user's ⚙️ format applies */
export const makeAspectExplicit = (arg: string) => /^\s*(9:16|16:9|1:1)\s/.test(arg) || !!detectAspect(arg);

/** technical error text (admins, logs): first line + the planner hint */
export function errorText(err: unknown): string {
  if (err instanceof CancelledError) return MSG.cancelled;
  const first = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
  if (err instanceof PlanError) {
    const hint = HINTS[err.code];
    return `✖ план: ${first}${hint ? `\n→ ${hint}` : ""}`;
  }
  return `✖ ${first}`;
}

export function videoCaption(o: PipelineOutput, reasoning?: string) {
  const head = [o.id, o.duration !== undefined ? `${o.duration.toFixed(1)} с` : null, o.aspect ?? null].filter(Boolean).join(" · ");
  return reasoning ? `${head}\n«${excerpt(reasoning, 300)}»` : head;
}

/** video file extensions accepted as documents (case-insensitive: iPhone sends IMG_0001.MOV) */
export const VIDEO_FILE_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3g2|mts|m2ts|ts|mpg|mpeg|wmv|flv|hevc|qt)$/i;

/** a video in any form Telegram sends it: video, round video note, animation (GIF/silent MP4), or a file —
 *  video/* mime, a video extension, or application/octet-stream without a telling extension (checked by ffprobe later) */
export function isVideoMessage(m: TgMessage) {
  if (m.video) return { fileId: m.video.file_id, size: m.video.file_size, duration: m.video.duration, fileUniqueId: m.video.file_unique_id };
  if (m.video_note) return { fileId: m.video_note.file_id, size: m.video_note.file_size, duration: m.video_note.duration, fileUniqueId: m.video_note.file_unique_id };
  if (m.animation) return { fileId: m.animation.file_id, size: m.animation.file_size, duration: m.animation.duration, fileUniqueId: m.animation.file_unique_id };
  const d = m.document;
  if (!d) return null;
  const name = d.file_name ?? "";
  const mime = (d.mime_type ?? "").toLowerCase();
  const octet = mime === "application/octet-stream" || mime === "";
  if (mime.startsWith("video/") || VIDEO_FILE_EXT.test(name) || (octet && !/\.[A-Za-z0-9]{1,5}$/.test(name))) return { fileId: d.file_id, size: d.file_size, duration: undefined, fileUniqueId: d.file_unique_id };
  return null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** words sent next to a link read as a montage task ("2 рилса по 20 секунд"), not as small talk ("вот видео") */
export function looksLikeTask(text: string): boolean {
  const t = text.trim();
  if (t.length < 3) return false;
  if (/^\/viral\b/i.test(t)) return true;
  if (/(рилс|ролик|reels?\b|shorts?|шортс|секунд|сек\b|second|минут|minute|монтаж|смонтир|сделай|склей|нарежь|обреж|хайлайт|highlight|вирус|viral|субтитр|subtit|caption|формат|9:16|16:9|1:1|rils|rolik|montaj|qilib|qil\b|soniya|kesib|make\b|edit\b|cut\b)/i.test(t)) return true;
  return t.split(/\s+/).length >= 5;
}

/** "<title-or-job>_<output>.mp4": a readable file name for a reel sent as a document */
export function outputFileName(result: Pick<PipelineResult, "jobId" | "title">, outputId: string): string {
  const slug = (result.title ?? "").normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 48).replace(/_+$/, "");
  return `${slug || result.jobId}_${outputId.replace(/[^\p{L}\p{N}_-]+/gu, "_")}.mp4`;
}

/** Re-encodes a video to fit `limitBytes` (bitrate from the duration), next to the original as *_tg.mp4. */
export async function shrinkForTelegram(file: string, limitBytes: number): Promise<string> {
  const { ffmpeg, ffprobe } = await import("../lib/ffmpeg.ts");
  const duration = Number((await ffprobe(file)).format.duration ?? 0);
  if (!(duration > 0)) throw new Error("не удалось прочитать длительность");
  const totalKbps = Math.floor((limitBytes * 8 * 0.9) / duration / 1000);
  const v = totalKbps - 128;
  if (v < 400) throw new Error(`ролик ${duration.toFixed(0)} с слишком длинный для ${Math.round(limitBytes / 1024 / 1024)} МБ`);
  const out = file.replace(/\.mp4$/i, "") + "_tg.mp4";
  await ffmpeg(["-i", file, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-b:v", `${v}k`, "-maxrate", `${Math.round(v * 1.3)}k`, "-bufsize", `${v * 2}k`, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", out]);
  if ((await fs.stat(out)).size > limitBytes) throw new Error("сжатая копия всё ещё больше лимита");
  return out;
}

async function defaultVoiceSample(voiceId: string, dest: string): Promise<string> {
  const { voiceSample } = await import("../voice/piper.ts");
  return voiceSample(voiceId, dest);
}

export interface UploadProbe {
  /** a real video stream; false: readable media without video (audio, an image…); undefined: ffprobe could not read it */
  video?: boolean;
  duration?: number;
}

async function defaultProbeUpload(file: string): Promise<UploadProbe> {
  try {
    const { ffprobe, isVideoStream } = await import("../lib/ffmpeg.ts");
    const p = await ffprobe(file);
    const d = Number(p.format.duration ?? NaN);
    return { video: p.streams.some(isVideoStream), duration: Number.isFinite(d) && d > 0 ? d : undefined };
  } catch {
    return {};
  }
}

/** the Colab notebook's output: avatar_result.zip (browsers may add " (1)" or "-2" to repeated downloads) */
export function isAvatarResult(fileName?: string): boolean {
  return /^avatar_result[^/\\]*\.zip$/i.test(fileName ?? "");
}

const ru3 = (n: number, one: string, few: string, many: string) => {
  const a = n % 10;
  const b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
};

/** the button card → an instruction for the planner (Russian: the planner and the highlights intent read it) */
export function draftInstruction(d: MontageDraft): string {
  const fmt = `формат ${d.aspect}`;
  switch (d.mode) {
    case "reels":
      return `${d.count} ${ru3(d.count, "рилс", "рилса", "рилсов")} по ${d.seconds} секунд из самых сильных моментов, ${fmt}, субтитры на языке речи`;
    case "viral":
      return VIRAL_INSTRUCTION.replace("30–45 секунд", `около ${d.seconds} секунд`).replace("Субтитры на языке речи.", `${fmt[0].toUpperCase()}${fmt.slice(1)}. Субтитры на языке речи.`);
    case "hl":
      return `хайлайты игры: лучшие броски и ключевые моменты, ${d.seconds} секунд, музыка, ${fmt}`;
    case "pp":
      return `хайлайты игры по отдельности на каждого игрока: броски каждого, ${fmt}`;
  }
}

const DOCS_DIR = fileURLToPath(new URL("../../docs/legal/", import.meta.url));

// ── progress card ──────────────────────────────────────────────────────────────

type StageKey = "start" | "prepare" | "understand" | "plan" | "cut" | "render" | "audio" | "script" | "design" | "send";
interface Card {
  chatId: number;
  msgId?: number;
  stage: StageKey;
  pct: number;
  renderPct: number;
  detail?: string;
  lastText?: string;
  lastAt: number;
  timer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
}

/** a pipeline progress line → stage and overall percent (monotonic: never goes back) */
export function parseStage(text: string, prev: { stage: StageKey; pct: number }): { stage: StageKey; pct: number; renderPct?: number } {
  const s = text.split("\n")[0];
  const r = /рендер (\S+) \((\d+)\/(\d+)\)(?: (\d{1,3})%)?/.exec(s);
  let next: { stage: StageKey; pct: number; renderPct?: number } | undefined;
  if (r) {
    const i = Number(r[2]);
    const n = Math.max(1, Number(r[3]));
    const p = r[4] ? Number(r[4]) : 0;
    const renderPct = Math.round((100 * (i - 1 + p / 100)) / n);
    next = { stage: "render", pct: 60 + Math.round(0.35 * renderPct), renderPct };
  } else if (/склеива|подготовк/.test(s)) next = { stage: "prepare", pct: 8 };
  else if (/анализ речи|ищу броски|понима/.test(s)) next = { stage: "understand", pct: 20 };
  else if (/план готов|попаданий|роликов:|план обновл/.test(s)) next = { stage: "plan", pct: 50 };
  else if (/▸ план|правка плана|разбираю, кто бросал/.test(s)) next = { stage: "plan", pct: 40 };
  else if (/нарезк/.test(s)) next = { stage: "cut", pct: 58 };
  else if (/тренды/.test(s)) next = { stage: "script", pct: 10 };
  else if (/сценари|монолог/.test(s)) next = { stage: "script", pct: 25 };
  else if (/озвучк/.test(s)) next = { stage: "audio", pct: 35 };
  else if (/арт-директор|композиция|фото|картинк|портрет/.test(s)) next = { stage: "design", pct: 50 };
  else if (/^▸ рендер/.test(s)) next = { stage: "render", pct: 70, renderPct: 0 };
  else if (/звук|сведени|музык/.test(s)) next = { stage: "audio", pct: 92 };
  if (!next) return prev;
  return { ...next, pct: Math.max(prev.pct, next.pct) };
}

const bar = (pct: number) => {
  const full = Math.round(pct / 10);
  return "▓".repeat(full) + "░".repeat(10 - full);
};
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// ── bot ────────────────────────────────────────────────────────────────────────

export interface BotOptions {
  token: string;
  /** closed beta: only these user ids are served (others are ignored); unset → open registration */
  allowedUserIds?: number[];
  /** admins (TELEGRAM_ADMIN_IDS); default: the first allowed user id */
  adminIds?: number[];
  /** directory holding `_bot/` (vedit.db, voice samples) and `users/<tg_id>/` (uploads); default WORKSPACE_ROOT. Jobs always go to VEDIT_WORKSPACE. */
  workspace?: string;
  onLog?: (line: string) => void;
  preset?: string;
  /** Bot API transport: a ready BotApi, or pieces to build one (tests inject fakes here) */
  api?: BotApi;
  callMethod?: CallMethod;
  download?: DownloadFn;
  apiBase?: string;
  limits?: Partial<Limits>;
  pipeline?: PipelineFn;
  revise?: ReviseFn;
  make?: MakeFn;
  avatarExport?: AvatarExportFn;
  avatarImport?: AvatarImportFn;
  /** /voice <id>: a short OGG/Opus sample of a Piper voice (tests inject a fake) */
  voiceSample?: (voiceId: string, dest: string) => Promise<string>;
  /** a copy of an output that fits the upload limit (default: ffmpeg re-encode to the size budget) */
  shrinkVideo?: (file: string, limitBytes: number) => Promise<string>;
  /** «🎯 Монтаж как в примере»: reference → Style DNA (default src/style/extract.ts; tests inject a stub) */
  styleExtract?: (input: ExtractInput, o: { cache: StyleCache; onLog: (l: string) => void }) => Promise<ExtractResult>;
  /** an uploaded file: has a video stream (undefined: unreadable) and its duration, s (default ffprobe) */
  probeUpload?: (file: string) => Promise<UploadProbe>;
  /** video by link (Google Drive, Yandex Disk, Dropbox, direct, yt-dlp): size cap (default VEDIT_LINK_MAX_MB, 2048 MB) and test hooks */
  links?: Partial<Pick<DownloadLinkOptions, "fetch" | "ytdlp" | "idleMs" | "totalMs" | "progressMs">> & { maxBytes?: number };
  /** long-polling timeout, seconds (default 30) */
  pollTimeout?: number;
  /** how long to wait for the rest of an album before acting (ms, default 4000) */
  albumDelayMs?: number;
  /** pause after a failed getUpdates, ms (default 3000) */
  retryDelayMs?: number;
  /** registration (language → purpose → terms) before anything else; false: users are registered on first contact in Russian (private deployments, stage 7–18 tests) */
  onboarding?: boolean;
  /** daily limits and credits; false: unlimited */
  quotas?: boolean;
  /** pipelines running at once (default VEDIT_MAX_JOBS: 1 on < 12 GB RAM, else 2) */
  maxJobs?: number;
  /** hard cap of jobs per user per day, credits or not (default VEDIT_USER_DAILY_JOBS, 10; 0 = none) */
  userDailyJobs?: number;
  /** global API spend per day, $ — new jobs of non-admins are refused above it (default VEDIT_BUDGET_DAILY_USD, 10; 0 = none) */
  dailyBudgetUsd?: number;
  /** free-plan overrides (on top of env; the admin's live changes in the DB win over both) */
  plan?: Partial<PlanLimits>;
  /** uploads and finished jobs older than this are deleted (default VEDIT_RETENTION_DAYS, 7) */
  retentionDays?: number;
  /** how often the retention cleanup runs, ms (default daily; 0 = never — call bot.retention()) */
  cleanupIntervalMs?: number;
  /** minimum pause between edits of one progress card, ms (default 1500) */
  statusEditMs?: number;
  /** pause between broadcast messages, ms (default 50 → 20 msg/s) */
  broadcastDelayMs?: number;
  /** legal texts (terms|privacy).<lang>.md (default docs/legal) */
  docsDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface Bot {
  readonly api: BotApi;
  readonly db: BotDb;
  readonly queue: JobQueue;
  readonly botDir: string;
  readonly usersDir: string;
  /** getUpdates offset (persisted in the DB) */
  offset: number;
  handleUpdate(update: TgUpdate): Promise<void>;
  /** resolves when no job is running or waiting and every background send is done */
  idle(): Promise<void>;
  /** the user has a job running or waiting */
  isBusy(userId: number): boolean;
  session(userId: number): Session;
  settings(userId: number): Record<string, string>;
  user(userId: number): UserRow | undefined;
  /** deletes old uploads and job folders now */
  retention(now?: number): Promise<RetentionReport>;
  /** kept for the stage-7 API: everything is already in the DB */
  save(): Promise<void>;
  /** stops timers and closes the DB (running jobs are not waited for) */
  close(): void;
}

const newBotJobId = () => `j${Date.now().toString(36).slice(-5)}${randomBytes(2).toString("hex")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

export async function createBot(o: BotOptions): Promise<Bot> {
  const log = o.onLog ?? ((l: string) => console.log(l));
  const env = o.env ?? process.env;
  const api = o.api ?? makeBotApi(o.token, { callMethod: o.callMethod, download: o.download, apiBase: o.apiBase, limits: o.limits });
  const pipelineFn = o.pipeline ?? runFullPipeline;
  const reviseFn = o.revise ?? runRevisePipeline;
  const makeFn = o.make ?? runMakePipeline;
  const avatarExportFn = o.avatarExport ?? runAvatarExport;
  const avatarImportFn = o.avatarImport ?? runAvatarImport;
  const voiceSampleFn = o.voiceSample ?? defaultVoiceSample;
  const shrinkFn = o.shrinkVideo ?? shrinkForTelegram;
  const probeUpload = o.probeUpload ?? defaultProbeUpload;
  const linkMax = o.links?.maxBytes ?? linkMaxBytes(env);
  const styleFn =
    o.styleExtract ??
    (async (input: ExtractInput, x: { cache: StyleCache; onLog: (l: string) => void }) => (await import("../style/extract.ts")).extractStyle(input, { cache: x.cache, onLog: x.onLog, deleteInput: true }));
  const preset = o.preset ?? "bold_pop";
  const root = path.resolve(o.workspace ?? WORKSPACE_ROOT);
  const botDir = path.join(root, "_bot");
  const usersDir = path.join(root, "users");
  const allowed = o.allowedUserIds?.length ? new Set(o.allowedUserIds) : null;
  const envAdmins = new Set(o.adminIds?.length ? o.adminIds : o.allowedUserIds?.length ? [o.allowedUserIds[0]] : []);
  const onboardingOn = o.onboarding ?? true;
  const quotasOn = o.quotas ?? true;
  const basePlan: PlanLimits = { ...freePlanFromEnv(env), ...o.plan };
  const tz = tzOffsetFromEnv(env);
  const userDailyJobs = o.userDailyJobs ?? userDailyJobsFromEnv(env);
  const dailyBudgetUsd = o.dailyBudgetUsd ?? dailyBudgetUsdFromEnv(env);
  const retentionDays = o.retentionDays ?? retentionDaysFromEnv(env);
  const statusEditMs = o.statusEditMs ?? 1500;
  const docsDir = o.docsDir ?? DOCS_DIR;

  await fs.mkdir(botDir, { recursive: true });
  const db = new BotDb(path.join(botDir, "vedit.db"));
  // users registered before the menu moved to inline buttons still carry the persistent reply keyboard
  const inlineMenuSince = db.getKv("kb.inline_since") ?? new Date().toISOString();
  db.setKv("kb.inline_since", inlineMenuSince);
  const tasks = new Set<Promise<unknown>>();
  const track = (p: Promise<unknown>) => {
    tasks.add(p);
    void p.finally(() => tasks.delete(p));
  };

  // ── users, sessions, settings ──
  const isAdmin = (uid: number) => envAdmins.has(uid) || db.getUser(uid)?.role === "admin";
  const langOf = (uid: number): Lang => db.getUser(uid)?.lang ?? "ru";
  const T = (uid: number): Strings => t(langOf(uid));
  const plan = (): PlanLimits => db.planLimits(basePlan);
  const today = () => dayStart(Date.now(), tz);

  const sessions = new Map<number, Session>();
  const sess = (uid: number): Session => {
    let s = sessions.get(uid);
    if (!s) {
      const raw = db.getSession<unknown>(uid);
      const parsed = SessionSchema.safeParse(raw ?? {});
      s = parsed.success ? parsed.data : SessionSchema.parse({});
      sessions.set(uid, s);
    }
    return s;
  };
  const patchSess = (uid: number, patch: Partial<Session>) => {
    const s = sess(uid);
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete (s as Record<string, unknown>)[k];
      else (s as Record<string, unknown>)[k] = v;
    }
    db.setSession(uid, s);
  };
  const settingsOf = (uid: number) => db.getSettings(uid);
  const aspectOf = (uid: number) => settingsOf(uid).aspect ?? "9:16";
  const styleOf = (uid: number) => settingsOf(uid).style ?? preset;
  const sendOf = (uid: number): SendMode => (settingsOf(uid).send as SendMode | undefined) ?? "file";
  const voiceOf = (uid: number) => settingsOf(uid).voice;

  // ── migration of the stage 7–18 state.json (chat → user: private chats have chat id = user id) ──
  const stateFile = path.join(botDir, "state.json");
  if (existsSync(stateFile)) {
    try {
      const old = await readJson(stateFile, BotStateSchema);
      db.transaction(() => {
        if (old.offset !== undefined && db.getKv("offset") === undefined) db.setKv("offset", String(old.offset));
        for (const [chatId, c] of Object.entries(old.chats)) {
          const uid = Number(chatId);
          if (!Number.isSafeInteger(uid) || uid <= 0) continue;
          if (!db.getUser(uid)) db.touchUser(uid, {}, { lang: "ru", onboarding: onboardingOn ? "terms" : "done", ...(onboardingOn ? {} : { accepted_terms_at: new Date().toISOString() }) });
          if (c.style) db.setSetting(uid, "style", c.style);
          if (c.voice) db.setSetting(uid, "voice", c.voice);
          if (c.send) db.setSetting(uid, "send", c.send);
          const s = SessionSchema.parse({ source: c.source, sources: c.sources, batch_closed: c.batch_closed, jobId: c.jobId, prompt: c.prompt, avatar_photo: c.avatar_photo, avatar_voice: c.avatar_voice, avatar_job: c.avatar_job });
          db.setSession(uid, s);
        }
      });
      await fs.rename(stateFile, `${stateFile}.migrated`);
      log(`state.json перенесён в базу: ${Object.keys(old.chats).length} чат(ов)`);
    } catch (err) {
      log(`⚠ state.json не перенесён: ${errMsg(err)}`);
    }
  }

  const say = async (chatId: number, text: string, markup?: ReplyMarkup): Promise<number | undefined> => {
    try {
      return (await api.sendMessage(chatId, text, markup ? { reply_markup: markup } : undefined)).message_id;
    } catch (err) {
      log(`⚠ sendMessage(${chatId}) не удался: ${err instanceof Error ? err.message : err}`);
      return undefined;
    }
  };
  const edit = async (chatId: number, msgId: number, text: string, markup?: InlineKeyboard) => {
    try {
      await api.editMessageText(chatId, msgId, text, markup);
    } catch (err) {
      log(`⚠ editMessageText(${chatId}/${msgId}): ${err instanceof Error ? err.message : err}`);
    }
  };
  const editMarkup = async (chatId: number, msgId: number, markup?: InlineKeyboard) => {
    try {
      await api.editMessageReplyMarkup(chatId, msgId, markup);
    } catch (err) {
      log(`⚠ editMessageReplyMarkup(${chatId}/${msgId}): ${err instanceof Error ? err.message : err}`);
    }
  };
  const action = (chatId: number, a: Parameters<BotApi["sendChatAction"]>[1]) => api.sendChatAction(chatId, a).catch(() => {});
  /** callback_data ≤ 64 bytes: longer payloads go through the DB id map */
  const cbEncode = (data: string) => (byteLength(data) <= CALLBACK_LIMIT ? data : `~${db.putCallback(data)}`);
  const encodeKb = (kb: InlineKeyboard): InlineKeyboard => ({ inline_keyboard: kb.inline_keyboard.map((row) => row.map((b) => (b.callback_data ? { ...b, callback_data: cbEncode(b.callback_data) } : b))) });

  // ── progress cards ──
  const cards = new Map<string, Card>();

  function cardText(job: JobRow, c: Card): { text: string; kb?: InlineKeyboard } {
    const lang = langOf(job.user);
    const L = t(lang);
    const lines = [`${L.kind[job.kind] ?? job.kind} · ${job.id}`];
    const started = job.started_at ? Date.parse(job.started_at) : Date.now();
    if (job.status === "queued") {
      lines.push(L.stage.queued(Math.max(1, queue.position(job.id))));
    } else if (job.status === "running") {
      if (lang === "ru" && c.detail) lines.push(c.detail.length > 900 ? `${c.detail.slice(0, 899)}…` : c.detail);
      const label = c.stage === "render" ? L.stage.render(c.renderPct) : L.stage[c.stage];
      lines.push(`${bar(c.pct)} ${c.pct}% · ${label}`);
      lines.push(`⏱ ${mmss(Date.now() - started)}`);
    } else if (job.status === "done") lines.push(`${L.stage.done} · ⏱ ${mmss((job.finished_at ? Date.parse(job.finished_at) : Date.now()) - started)}`);
    else if (job.status === "cancelled") lines.push(L.stage.cancelled);
    else lines.push(L.stage.failed);
    if (job.paid_credits && (job.status === "queued" || job.status === "running")) lines.push(L.paidNote(job.paid_credits, db.getUser(job.user)?.credits ?? 0));
    const active = job.status === "queued" || job.status === "running";
    return { text: lines.join("\n"), kb: active ? encodeKb(cancelKb(L, job.id)) : undefined };
  }

  /** re-renders a job's card; throttled to one edit per statusEditMs unless `now` */
  function pushCard(jobId: string, now = false): Promise<void> {
    const c = cards.get(jobId);
    if (!c?.msgId) return Promise.resolve();
    const doEdit = () => {
      c.timer = undefined;
      const job = db.getJob(jobId);
      if (!job) return;
      const { text, kb } = cardText(job, c);
      if (text === c.lastText) return;
      c.lastText = text;
      c.lastAt = Date.now();
      c.chain = c.chain.then(() => edit(c.chatId, c.msgId!, text, kb));
      track(c.chain);
    };
    if (now || statusEditMs <= 0) {
      if (c.timer) clearTimeout(c.timer);
      doEdit();
      return c.chain;
    }
    if (c.timer) return c.chain;
    const wait = c.lastAt + statusEditMs - Date.now();
    if (wait <= 0) doEdit();
    else {
      c.timer = setTimeout(doEdit, wait);
      c.timer.unref?.();
    }
    return c.chain;
  }

  const queue = new JobQueue({
    maxJobs: o.maxJobs ?? maxJobsFromEnv(env),
    run: (id, signal) => runJob(id, signal),
    onChange: () => {
      for (const j of db.jobsByStatus("queued")) pushCard(j.id);
    },
    log,
  });

  // ── quotas ──
  function freeLeft(uid: number, cls: JobClass) {
    const p = plan();
    const limit = cls === "long" ? p.longPerDay : p.standardPerDay;
    return { used: db.countFreeJobs(uid, cls, today()), limit };
  }

  /** creates a job (quota/credits checked, card sent) and puts it in the queue */
  async function submit(uid: number, chatId: number, kind: JobKind, payload: Record<string, unknown>, cls: JobClass): Promise<JobRow | undefined> {
    const L = T(uid);
    if (!queue.canEnqueue(uid)) {
      await say(chatId, L.busy);
      return undefined;
    }
    // server guards (admins exempt): the global daily API budget, then the per-user daily cap
    if (!isAdmin(uid) && cls !== "light") {
      if (dailyBudgetUsd > 0 && db.costSince(today()) >= dailyBudgetUsd) {
        log(`[${uid}] отказ: дневной бюджет $${dailyBudgetUsd} исчерпан`);
        await say(chatId, L.budgetPaused);
        return undefined;
      }
      if (userDailyJobs > 0 && db.countJobs(uid, today()) >= userDailyJobs) {
        await say(chatId, L.userDailyCap(userDailyJobs));
        return undefined;
      }
    }
    let paid = 0;
    if (quotasOn && !isAdmin(uid) && cls !== "light") {
      const { used, limit } = freeLeft(uid, cls);
      if (used >= limit) {
        const p = plan();
        const cost = cls === "long" ? p.creditsLong : p.creditsStandard;
        const have = db.getUser(uid)?.credits ?? 0;
        if (have < cost) {
          await say(chatId, L.quotaExceeded(cls === "long", cost, have));
          return undefined;
        }
        paid = cost;
      }
    }
    const id = newBotJobId();
    const job = db.transaction(() => {
      if (paid) db.addCredits(uid, -paid);
      return db.insertJob({ id, user: uid, chat_id: chatId, kind, class: cls, payload: JSON.stringify(payload), paid_credits: paid });
    });
    if (paid) db.addUsage({ user: uid, kind: `credits:${kind}`, units: paid, cost_usd: 0, job_id: id });
    const card: Card = { chatId, stage: "start", pct: 0, renderPct: 0, lastAt: 0, chain: Promise.resolve() };
    cards.set(id, card);
    const first = cardText({ ...job, status: "queued" }, card);
    card.msgId = await say(chatId, first.text.replace(/\n⏳.*$/m, "\n⏳"), first.kb);
    card.lastAt = Date.now();
    if (card.msgId) db.updateJob(id, { status_msg_id: card.msgId });
    log(`[${uid}] задача ${id}: ${kind} (${cls}${paid ? `, ${paid} кр.` : ""})`);
    queue.enqueue(id, uid);
    await pushCard(id, true);
    return job;
  }

  // ── running a job ──
  async function runJob(jobId: string, signal: AbortSignal): Promise<JobOutcome> {
    const job = db.getJob(jobId);
    if (!job) return "failed";
    const uid = job.user;
    const chatId = job.chat_id;
    const card = cards.get(jobId) ?? { chatId, msgId: job.status_msg_id ?? undefined, stage: "start" as StageKey, pct: 0, renderPct: 0, lastAt: 0, chain: Promise.resolve() };
    cards.set(jobId, card);
    db.updateJob(jobId, { status: "running", started_at: new Date().toISOString(), stage: "start", percent: 0 });
    void pushCard(jobId, true);
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    const ulog = (l: string) => log(`[${uid}] ${l}`);
    const progress = async (text: string) => {
      const next = parseStage(text, card);
      card.stage = next.stage;
      card.pct = next.pct;
      if (next.renderPct !== undefined) card.renderPct = next.renderPct;
      card.detail = text.trim();
      db.updateJob(jobId, { stage: card.stage, percent: card.pct });
      ulog(text.split("\n")[0]);
      await pushCard(jobId);
    };
    const onJob = (veditJob: string) => {
      db.updateJob(jobId, { vedit_job: veditJob });
      if (job.kind === "avatar") patchSess(uid, { jobId: veditJob, avatar_job: veditJob });
      else patchSess(uid, { jobId: veditJob });
    };
    const finish = async (status: "done" | "failed" | "cancelled", patch: Partial<JobRow> = {}) => {
      if (status !== "done" && job.paid_credits) db.addCredits(uid, job.paid_credits); // refund
      db.updateJob(jobId, { status, finished_at: new Date().toISOString(), ...patch });
      await pushCard(jobId, true);
      cards.delete(jobId);
    };
    try {
      const result = await withJobSignal(signal, () => execute(job.kind, payload, { progress, onJob, signal, log: ulog, uid }));
      if (signal.aborted) throw new CancelledError();
      card.stage = "send";
      card.pct = Math.max(card.pct, 97);
      await pushCard(jobId, true);
      await deliver(uid, chatId, jobId, result);
      const cost = await jobCost(result.jobId);
      db.addUsage({ user: uid, kind: job.kind, units: job.paid_credits, cost_usd: cost, job_id: jobId });
      await finish("done", { vedit_job: result.jobId, cost_usd: cost, percent: 100, stage: "done" });
      log(`[${uid}] ${job.kind} ok: ${result.jobId}, ${result.outputs.length} файл(ов), $${cost.toFixed(3)}`);
      return "done";
    } catch (err) {
      if (signal.aborted || err instanceof CancelledError) {
        log(`[${uid}] ${job.kind} отменена (${jobId})`);
        await finish("cancelled");
        return "cancelled";
      }
      log(`[${uid}] ${job.kind} ошибка: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      // what the failed run already spent on APIs still counts toward the daily budget
      const spent = await (async () => {
        const vj = db.getJob(jobId)?.vedit_job;
        return vj ? jobCost(vj) : 0;
      })();
      if (spent > 0) db.addUsage({ user: uid, kind: `${job.kind}:failed`, units: 0, cost_usd: spent, job_id: jobId });
      await finish("failed", { error: errMsg(err).slice(0, 500), ...(spent > 0 ? { cost_usd: spent } : {}) });
      const L = T(uid);
      // the user sees a friendly text (admins see the technical one); other admins get the details
      await say(chatId, isAdmin(uid) ? errorText(err) : L.failed, encodeKb(retryKb(L, jobId)));
      for (const a of new Set([...envAdmins, ...db.adminIds()])) if (a !== uid) await say(a, t(langOf(a)).adminJobFailed(uid, jobId, job.kind, errorText(err)));
      return "failed";
    }
  }

  interface ExecCtx {
    progress: (text: string) => Promise<void>;
    onJob: (jobId: string) => void;
    signal: AbortSignal;
    log: (l: string) => void;
    uid: number;
  }
  async function execute(kind: JobKind, p: Record<string, unknown>, x: ExecCtx): Promise<PipelineResult> {
    const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    switch (kind) {
      case "run":
        return pipelineFn({ source: s("source")!, sources: Array.isArray(p.sources) ? (p.sources as string[]) : undefined, instruction: s("instruction")!, preset: s("preset") ?? preset, progress: x.progress, onJob: x.onJob, signal: x.signal, log: x.log, ...(s("like") ? { like: s("like"), likeFresh: p.likeFresh === true } : {}) });
      case "make":
        return makeFn({ topic: s("topic")!, voice: s("voice"), aspect: (s("aspect") as Aspect | undefined) ?? "9:16", fromJob: s("fromJob"), progress: x.progress, onJob: x.onJob, signal: x.signal, log: x.log });
      case "revise":
        return reviseFn({ jobId: s("jobId")!, edit: s("edit")!, progress: x.progress, signal: x.signal, log: x.log });
      case "avatar":
        return avatarExportFn({ input: s("input")!, photo: s("photo"), voice: s("voice"), voiceId: s("voiceId"), sourceLabel: s("sourceLabel")!, progress: x.progress, onJob: x.onJob, signal: x.signal, log: x.log });
      case "avatar_import":
        x.onJob(s("jobId")!);
        return avatarImportFn({ jobId: s("jobId")!, result: s("result")!, instruction: s("instruction"), preset: s("preset") ?? "split_news", progress: x.progress, signal: x.signal, log: x.log });
    }
  }

  async function jobCost(veditJob: string): Promise<number> {
    try {
      return (await readJson(path.join(jobDir(veditJob), "cost.json"), CostSchema)).total_usd;
    } catch {
      return 0;
    }
  }

  async function deliver(uid: number, chatId: number, jobId: string, result: PipelineResult) {
    const L = T(uid);
    for (const doc of result.documents ?? []) {
      await action(chatId, "upload_document");
      try {
        await api.sendDocument(chatId, doc.file, doc.caption);
      } catch (err) {
        await say(chatId, `✖ ${path.basename(doc.file)}: ${err instanceof TelegramError ? err.description : String(err)}`);
      }
    }
    const mode = sendOf(uid);
    const notes: string[] = [];
    for (const out of result.outputs) {
      const caption = videoCaption(out, result.reasoning);
      let size = 0;
      try {
        size = (await fs.stat(out.file)).size;
      } catch {
        await say(chatId, `✖ ${out.id}: файл не найден (${out.file})`);
        continue;
      }
      let file = out.file;
      if (size > api.limits.uploadBytes) {
        const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} МБ`;
        try {
          await action(chatId, "upload_document");
          file = await shrinkFn(out.file, api.limits.uploadBytes);
          notes.push(`${out.id}: оригинал ${mb(size)} больше лимита отправки ботом (${mb(api.limits.uploadBytes)}) — отправил сжатую копию; оригинал на сервере: ${out.file}`);
        } catch (err) {
          log(`⚠ сжатие ${out.id}: ${errMsg(err)}`);
          await say(chatId, isAdmin(uid) ? `${caption}\nФайл ${mb(size)} больше лимита отправки ботом (${mb(api.limits.uploadBytes)}) — он лежит на сервере: ${out.file}` : `${caption}\n✖ ${L.tooBigToSend}`);
          continue;
        }
      }
      const name = outputFileName(result, out.id);
      const asDocument = async () => {
        await action(chatId, "upload_document");
        await api.sendDocument(chatId, file, caption, { fileName: name, disableContentTypeDetection: true });
      };
      const asVideo = async () => {
        await action(chatId, "upload_video");
        await api.sendVideo(chatId, file, { caption, duration: out.duration });
      };
      const [first, second] = mode === "video" ? [asVideo, asDocument] : [asDocument, asVideo];
      if (mode === "both") await asVideo().catch((err) => log(`⚠ sendVideo ${out.id}: ${err instanceof Error ? err.message : err}`));
      try {
        await first();
      } catch (err) {
        log(`⚠ ${mode === "video" ? "sendVideo" : "sendDocument"} ${out.id}: ${err instanceof Error ? err.message : err} — пробую ${mode === "video" ? "документом" : "видео"}`);
        try {
          await second();
        } catch (err2) {
          await say(chatId, isAdmin(uid) ? `${caption}\nНе удалось отправить файл (${err2 instanceof TelegramError ? err2.description : String(err2)}). Он лежит на сервере: ${file}` : `${caption}\n✖ ${L.tooBigToSend}`);
        }
      }
    }
    // technical details (errors, warnings, server paths) go to admins only
    const tech = isAdmin(uid);
    const lines: string[] = [];
    for (const f of result.failed ?? []) lines.push(tech ? `✖ ${f.id}: ${f.error.split("\n")[0]}` : `✖ ${f.id}`);
    if (tech) for (const n of [...notes, ...(result.notes ?? [])]) lines.push(`⚠ ${n}`);
    if (result.avatar) {
      await say(chatId, [L.avatarInstructions(result.jobId, result.avatar.lines, result.avatar.warnings), ...lines].join("\n"));
      return;
    }
    if (result.message) {
      await say(chatId, [result.message, ...lines].join("\n"));
      return;
    }
    const head = result.outputs.length ? L.done(result.outputs.length, result.jobId) : L.noNew(result.jobId);
    const text = [head, ...lines, result.outputs.length ? `${L.reviseHint}\n${L.rateAsk}` : ""].filter(Boolean).join("\n");
    const msgId = await say(chatId, text, result.outputs.length ? encodeKb(resultKb(L, jobId)) : undefined);
    if (msgId) db.updateJob(jobId, { result_msg_id: msgId });
    // the format of the result, for «📐 Другой формат»
    const aspect = result.outputs.find((x) => x.aspect)?.aspect;
    if (aspect) {
      const j = db.getJob(jobId);
      if (j) db.updateJob(jobId, { payload: JSON.stringify({ ...JSON.parse(j.payload), resultAspect: aspect }) });
    }
  }

  // ── starting work ──
  function isLongRun(seconds: number, highlights: boolean) {
    if (highlights) return true;
    return seconds > plan().longMinutes * 60;
  }

  async function startRun(uid: number, chatId: number, instruction: string, opts: { preset?: string; highlights?: boolean; single?: boolean; like?: string | null } = {}): Promise<JobRow | undefined> {
    const s = sess(uid);
    if (!s.source || !(await exists(s.source))) {
      await say(chatId, T(uid).needVideo);
      return undefined;
    }
    const source = s.source;
    const batch: string[] = [];
    for (const f of s.sources ?? []) if (await exists(f)) batch.push(f);
    const sources = !opts.single && batch.length > 1 ? batch : undefined;
    const seconds = (sources ?? [source]).reduce((sum, f) => sum + (s.durations[f] ?? 0), 0);
    const { highlightsIntent } = await import("../highlights/intent.ts");
    // «🎯 как в примере»: the reference picked earlier (unless the card switched it off: like = null)
    const like = opts.like === null ? undefined : (opts.like ?? (s.ref && (await exists(s.ref)) ? s.ref : undefined));
    const highlights = like ? false : (opts.highlights ?? (!sources && highlightsIntent(instruction) === "strong"));
    patchSess(uid, { prompt: instruction, batch_closed: true, awaiting: undefined });
    let runPreset = opts.preset ?? styleFromText(instruction) ?? styleOf(uid);
    if (like) {
      try {
        runPreset = mapStyle((await readJson(like, StyleProfileSchema)).dna).basePreset;
      } catch {}
    }
    if (runPreset !== preset) log(`[${uid}] стиль: ${runPreset}${like ? " (как в примере)" : ""}`);
    const job = await submit(uid, chatId, "run", { source, sources, instruction, preset: runPreset, ...(like ? { like, likeFresh: s.ref_fresh === true && like === s.ref } : {}) }, isLongRun(seconds, highlights) ? "long" : "standard");
    // the fresh analysis is billed to this job only
    if (job && like && like === s.ref && s.ref_fresh) patchSess(uid, { ref_fresh: false });
    return job;
  }

  async function startMake(uid: number, chatId: number, topic: string, aspect: string, voiceChoice?: string, fromJob?: string): Promise<JobRow | undefined> {
    if (!topic) return void (await say(chatId, T(uid).makeUsage));
    patchSess(uid, { prompt: topic, awaiting: undefined, make: undefined });
    // no choice → "auto" (Gemini with a key, else Piper); "off" → silent
    const chosen = voiceChoice ?? voiceOf(uid);
    const voice = chosen === "off" ? undefined : chosen && chosen !== "auto" ? chosen : "auto";
    return submit(uid, chatId, "make", { topic, voice, aspect, fromJob }, "standard");
  }

  async function startRevise(uid: number, chatId: number, editText: string, veditJob?: string) {
    const L = T(uid);
    const jobId = veditJob ?? sess(uid).jobId;
    if (!editText) return void (await say(chatId, L.reviseUsage));
    if (!jobId) return void (await say(chatId, L.reviseNoJob));
    patchSess(uid, { awaiting: undefined });
    await submit(uid, chatId, "revise", { jobId, edit: editText }, "standard");
  }

  async function startAvatar(uid: number, chatId: number, input: string) {
    const L = T(uid);
    if (!input) return void (await say(chatId, L.avatarUsage));
    if (/^(сброс|reset|clear)$/i.test(input)) {
      patchSess(uid, { avatar_photo: undefined, avatar_voice: undefined });
      return void (await say(chatId, L.avatarReset));
    }
    const s = sess(uid);
    const photo = s.avatar_photo && (await exists(s.avatar_photo)) ? s.avatar_photo : undefined;
    const voice = s.avatar_voice && (await exists(s.avatar_voice)) ? s.avatar_voice : undefined;
    const chosen = voiceOf(uid);
    // the user's own voice note wins over the catalogue voice
    const voiceId = voice || chosen === "off" ? undefined : chosen;
    patchSess(uid, { prompt: input, awaiting: undefined });
    await say(chatId, L.avatarStart(!!photo, !!voice, voiceId));
    await submit(uid, chatId, "avatar", { input, photo, voice, voiceId, sourceLabel: path.join(usersDir, String(uid), "avatar") }, "light");
  }

  // ── uploads ──
  const uploadLimit = (uid: number) => (isAdmin(uid) ? api.limits.downloadBytes : Math.min(api.limits.downloadBytes, plan().uploadMb * 1024 * 1024));
  const MBn = (n: number) => Math.round(n / 1024 / 1024);
  async function tooLargeReply(uid: number, chatId: number, size: number) {
    const L = T(uid);
    const limit = uploadLimit(uid);
    // the user is told what to do: a link (Google Drive / Yandex Disk / Dropbox / YouTube) or a compressed copy
    await say(chatId, [L.tooLarge(MBn(size), MBn(limit), limit >= api.limits.downloadBytes), isAdmin(uid) && !api.local ? L.tooLargeAdmin : ""].filter(Boolean).join("\n"));
  }
  const uploadDir = (uid: number) => path.join(usersDir, String(uid), "uploads");

  function draftFor(uid: number, n: number): MontageDraft {
    const s = sess(uid);
    // 🏀 from the menu preselects highlights for one game video; several videos default to one clip from all of them
    const mode: MontageMode = n > 1 ? (s.intent === "pp" ? "pp" : "viral") : (s.intent ?? "reels");
    // a reference picked in «🎯 Монтаж как в примере»: one reel in its style by default
    if (s.ref) return { mode: n > 1 ? "viral" : "reels", count: 1, seconds: 30, aspect: aspectOf(uid), style: "ref" };
    return { mode, count: 3, seconds: mode === "reels" ? 30 : 60, aspect: aspectOf(uid), style: PRESET_STYLE[styleOf(uid)] ?? "pop" };
  }

  /** one option card per batch: the first upload sends it, later uploads to the same batch edit it */
  async function montageCard(uid: number, chatId: number, n: number) {
    const L = T(uid);
    const s = sess(uid);
    // keep the user's choices when the card is refreshed; only the default mode follows the batch size
    const d = s.card && s.draft ? { ...s.draft, mode: n > 1 && (s.draft.mode === "reels" || s.draft.mode === "hl") ? ("viral" as const) : s.draft.mode } : draftFor(uid, n);
    const text = n > 1 ? L.batchSaved(n) : L.videoSaved;
    const kb = encodeKb(montageKb(L, d, !!s.ref));
    if (s.card) {
      try {
        await api.editMessageText(chatId, s.card, text, kb);
        patchSess(uid, { draft: d });
        return;
      } catch {
        // too old / deleted: fall through to a new card
      }
    }
    const id = await say(chatId, text, kb);
    patchSess(uid, { draft: d, card: id });
  }

  /** a downloaded file joins the open batch (or starts a new one after a run) */
  function addToBatch(uid: number, dest: string, seconds?: number) {
    const s = sess(uid);
    const batch = s.batch_closed ? [dest] : [...(s.sources ?? []).filter((f) => f !== dest), dest];
    patchSess(uid, {
      source: dest,
      sources: batch,
      batch_closed: false,
      ctx: "montage",
      ...(s.batch_closed ? { card: undefined } : {}),
      durations: { ...(s.batch_closed ? {} : s.durations), ...(seconds ? { [dest]: seconds } : {}) },
    });
    log(`[${uid}] видео сохранено: ${dest} (в подборке ${batch.length})`);
  }

  /**
   * Uploads run in the background, one after another per user (a 2 GB link or the local Bot API server must not
   * hold the polling loop, and other users keep being served). Messages that arrive while a user's uploads are
   * still downloading wait for them ("video, then «сделай рилс»" must see the video). The card (or the run of a
   * caption) comes once, `albumDelayMs` after the last upload of a burst is in — not after each file.
   */
  interface UploadState {
    chain: Promise<void>;
    /** uploads received, not yet finished */
    pending: number;
    /** files added in this burst */
    added: number;
    chatId: number;
    caption?: string;
    timer?: ReturnType<typeof setTimeout>;
    release?: () => void;
    /** the link download in progress (🛑 and /cancel abort it) */
    dl?: AbortController;
  }
  const uploads = new Map<number, UploadState>();
  const albumDelayMs = o.albumDelayMs ?? 4000;
  const upState = (uid: number, chatId: number) => {
    let st = uploads.get(uid);
    if (!st) uploads.set(uid, (st = { chain: Promise.resolve(), pending: 0, added: 0, chatId }));
    st.chatId = chatId;
    return st;
  };
  const uploadsPending = (uid: number) => (uploads.get(uid)?.pending ?? 0) > 0;
  /** stops the burst timer (a new file came in) — the caption and the count of the burst are kept */
  const disarm = (st: UploadState) => {
    if (st.timer) clearTimeout(st.timer);
    st.timer = undefined;
    st.release?.(); // the superseded timer must not keep idle() waiting
    st.release = undefined;
  };

  /** after the burst: a caption with a task runs it, otherwise one option card for all the files */
  async function afterBurst(uid: number, chatId: number, caption?: string) {
    const s = sess(uid);
    // a run already took this batch (a text task or ▶️ waited for the uploads and went first)
    if (s.batch_closed || !s.sources.length) return;
    if (caption && !caption.startsWith("/")) await startRun(uid, chatId, caption);
    else if (caption && /^\/viral\b/i.test(caption)) await startRun(uid, chatId, VIRAL_INSTRUCTION);
    else await montageCard(uid, chatId, s.sources.length);
  }

  /** the burst is in: act now (no debounce) or albumDelayMs later, unless another file comes first */
  async function settle(uid: number, st: UploadState) {
    const take = () => {
      const cap = st.caption;
      const added = st.added;
      st.caption = undefined;
      st.added = 0;
      return { cap, added };
    };
    // nothing new (too big, not a video, a failed link): the error was already said
    if (!st.added) return void take();
    if (albumDelayMs <= 0) return afterBurst(uid, st.chatId, take().cap); // no debounce (tests)
    disarm(st);
    let release!: () => void;
    track(new Promise<void>((r) => (release = r)));
    st.release = release;
    st.timer = setTimeout(() => {
      st.timer = undefined;
      st.release = undefined;
      const task = afterBurst(uid, st.chatId, take().cap).catch((err) => log(`[${uid}] подборка: ${errMsg(err)}`));
      track(task);
      void task.finally(release);
    }, albumDelayMs);
  }

  /** queues an upload task (returns true when it added a file); resolves when it ran (tests await it) */
  function queueUpload(uid: number, chatId: number, caption: string | undefined, task: () => Promise<boolean>): Promise<void> {
    const st = upState(uid, chatId);
    st.pending++;
    // a new file of the burst: the card waits for it too (the caption is kept for the whole burst)
    disarm(st);
    if (caption) st.caption = caption;
    const run = st.chain.then(async () => {
      try {
        if (await task()) st.added++;
      } catch (err) {
        log(`[${uid}] загрузка: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        await say(chatId, isAdmin(uid) ? `${T(uid).uploadFailed}\n${errorText(err)}` : T(uid).uploadFailed);
      } finally {
        st.pending--;
      }
      if (st.pending === 0) await settle(uid, st);
    });
    st.chain = run;
    track(run);
    return run;
  }

  /** runs `fn` after this user's uploads in flight (or now, when there are none) */
  function afterUploads(uid: number, fn: () => Promise<unknown>): Promise<void> {
    const st = uploads.get(uid);
    if (!st?.pending) return fn().then(() => undefined);
    const run = st.chain.then(() => fn()).then(
      () => undefined,
      async (err) => {
        log(`[${uid}] после загрузки: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        await say(st.chatId, isAdmin(uid) ? errorText(err) : `✖ ${T(uid).failed}`);
      },
    );
    st.chain = run;
    track(run);
    return run;
  }

  /** a Telegram file (video, video note, animation, video document) → the batch; false when refused */
  async function onVideo(uid: number, m: TgMessage, v: { fileId: string; size?: number; duration?: number }): Promise<boolean> {
    const chatId = m.chat.id;
    const L = T(uid);
    const limit = uploadLimit(uid);
    if (v.size !== undefined && v.size > limit) return void (await tooLargeReply(uid, chatId, v.size)), false;
    await action(chatId, "typing");
    let file;
    try {
      file = await api.getFile(v.fileId);
    } catch (err) {
      // no size in the message and over the Bot API limit: Telegram refuses getFile
      if (isFileTooBig(err)) return void (await tooLargeReply(uid, chatId, v.size ?? 0)), false;
      throw err;
    }
    if (file.file_size !== undefined && file.file_size > limit) return void (await tooLargeReply(uid, chatId, file.file_size)), false;
    const dest = path.join(uploadDir(uid), `${safeName(v.fileId)}.mp4`);
    if (!(await exists(dest))) {
      try {
        await api.download(file, dest);
      } catch (err) {
        log(`[${uid}] файл не скачан: ${errMsg(err)}`);
        await fs.rm(dest, { force: true }).catch(() => {});
        await say(chatId, isAdmin(uid) ? `${L.uploadFailed}\n${errorText(err)}` : L.uploadFailed);
        return false;
      }
    }
    // tiny files cannot be real videos (test doubles): no ffprobe for them
    const size = file.file_size ?? v.size ?? (await fs.stat(dest).catch(() => ({ size: 0 }))).size;
    const probe = size >= 4096 ? await probeUpload(dest) : {};
    if (probe.video === false) {
      log(`[${uid}] не видео: ${dest}`);
      await fs.rm(dest, { force: true }).catch(() => {});
      await say(chatId, L.notVideo);
      return false;
    }
    addToBatch(uid, dest, v.duration ?? probe.duration);
    return true;
  }

  /** files already downloaded from this link (the same link twice is not downloaded again) */
  async function linkFiles(dir: string, key: string): Promise<string[]> {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    return names
      .filter((n) => (n.startsWith(`${key}.`) || n.startsWith(`${key}_`)) && !n.endsWith(".part"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((n) => path.join(dir, n));
  }

  function linkErrorText(uid: number, err: unknown): string {
    const L = T(uid);
    let text = L.linkFailed;
    if (err instanceof LinkError) {
      const by: Partial<Record<LinkError["code"], string>> = {
        too_big: L.linkTooBig(err.bytes ? MBn(err.bytes) : 0, MBn(linkMax)),
        private: L.linkPrivate,
        folder: L.linkFolder,
        not_video: L.linkNotVideo,
        empty: L.linkNotVideo,
        no_ytdlp: L.linkNoYtdlp,
        timeout: L.linkTimeout,
        cancelled: L.linkCancelled,
      };
      text = by[err.code] ?? L.linkFailed;
    }
    // admins see the technical reason too
    return isAdmin(uid) && !(err instanceof LinkError && err.code === "cancelled") ? `${text}\n(${errMsg(err)})` : text;
  }

  /** links in a message → downloaded videos in the batch; false when nothing was added */
  async function onLinks(uid: number, chatId: number, urls: string[]): Promise<boolean> {
    const L = T(uid);
    const st = upState(uid, chatId);
    const dir = uploadDir(uid);
    let added = 0;
    for (const url of urls.slice(0, 5)) {
      const key = linkKey(url);
      let files = await linkFiles(dir, key);
      if (!files.length) {
        const ac = new AbortController();
        st.dl = ac;
        const cancelKbd = encodeKb({ inline_keyboard: [[{ text: L.btnCancelDownload, callback_data: "XD" }]] });
        const statusId = await say(chatId, L.linkStart, cancelKbd);
        let shown = "";
        let lastEdit = 0;
        const editEvery = o.links?.progressMs ?? 3000;
        const durations = new Map<string, number>();
        log(`[${uid}] ссылка: ${url}`);
        try {
          const got = await downloadLink(url, dir, key, {
            maxBytes: linkMax,
            signal: ac.signal,
            fetch: o.links?.fetch,
            ytdlp: o.links?.ytdlp,
            idleMs: o.links?.idleMs,
            totalMs: o.links?.totalMs,
            progressMs: Math.min(editEvery, 2000),
            log: (l) => log(`[${uid}] ${l}`),
            // strict for links: a page or an archive is refused here, not in the middle of a montage
            probe: async (f) => {
              const p = await probeUpload(f);
              if (p.duration) durations.set(f, p.duration);
              return p.video === true;
            },
            onProgress: (bytes, total) => {
              const text = L.linkProgress(MBn(bytes), total ? MBn(total) : 0);
              if (!statusId || text === shown || Date.now() - lastEdit < editEvery) return;
              shown = text;
              lastEdit = Date.now();
              void edit(chatId, statusId, text, cancelKbd);
            },
          });
          files = got.map((f) => f.file);
          log(`[${uid}] по ссылке скачано: ${got.map((f) => `${path.basename(f.file)} ${MBn(f.bytes)} МБ`).join(", ")}`);
          if (statusId) await edit(chatId, statusId, L.linkDone(got.length, MBn(got.reduce((s, f) => s + f.bytes, 0))));
        } catch (err) {
          log(`[${uid}] ссылка не скачана: ${errMsg(err)}`);
          const text = linkErrorText(uid, err);
          if (statusId) await edit(chatId, statusId, text);
          else await say(chatId, text);
          continue;
        } finally {
          if (st.dl === ac) st.dl = undefined;
        }
        for (const f of files) addToBatch(uid, f, durations.get(f));
      } else {
        // downloaded before: only the durations are needed
        for (const f of files) addToBatch(uid, f, (await probeUpload(f)).duration);
      }
      added += files.length;
    }
    return added > 0;
  }

  // ── «🎯 Монтаж как в примере»: reference → Style DNA (cached by file_unique_id / link / content) ──
  const styleCache = new StyleCache(path.join(root, "_cache", "style"));
  const refBusy = new Set<number>();

  async function onReference(uid: number, chatId: number, src: { video?: { fileId: string; size?: number; fileUniqueId?: string }; url?: string; name?: string }) {
    const L = T(uid);
    if (refBusy.has(uid)) return void (await say(chatId, L.refBusy));
    if (src.video?.size !== undefined && src.video.size > uploadLimit(uid)) return tooLargeReply(uid, chatId, src.video.size);
    refBusy.add(uid);
    const task = (async () => {
      try {
        const canon = src.url ? canonicalUrl(src.url) : null;
        const alias = src.video?.fileUniqueId ? tgAlias(src.video.fileUniqueId) : canon ? `url:${canon}` : undefined;
        let result: ExtractResult | undefined;
        // a forwarded / repeated reference: no download, no model
        const known = alias ? db.styleKey(alias) : undefined;
        const hit = known ? await styleCache.get(known) : null;
        if (hit) result = { profile: hit, cached: true, file: styleCache.file(hit.key) };
        if (!result) {
          await action(chatId, "typing");
          await say(chatId, L.refAnalyzing);
          let file: string | undefined;
          if (src.video) {
            const f = await api.getFile(src.video.fileId);
            if (f.file_size !== undefined && f.file_size > uploadLimit(uid)) return void (await tooLargeReply(uid, chatId, f.file_size));
            file = path.join(usersDir, String(uid), "refs", `${safeName(src.video.fileId)}.mp4`);
            await api.download(f, file);
          }
          result = await styleFn({ file, url: src.url, fileUniqueId: src.video?.fileUniqueId, name: src.name }, { cache: styleCache, onLog: (l) => log(`[${uid}] ${l}`) });
        }
        if (alias) db.putStyleKey(alias, result.profile.key, result.profile.dna.style_summary);
        log(`[${uid}] пример: ${result.cached ? "из кэша" : "разобран"} — ${result.profile.dna.style_summary}`);
        patchSess(uid, { awaiting: undefined, ref: result.file, ref_fresh: !result.cached, sources: [], batch_closed: false, card: undefined, draft: undefined, intent: undefined });
        await say(chatId, L.refReady(styleSummary(result.profile.dna, langOf(uid)), result.cached));
      } catch (err) {
        log(`[${uid}] пример не разобран: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        await say(chatId, err instanceof Error && err.name === "RefLinkError" ? L.refLinkFailed : L.refFailed);
      } finally {
        refBusy.delete(uid);
      }
    })();
    track(task);
    if (albumDelayMs <= 0) await task; // tests: synchronous
  }

  /** avatar_result*.zip: find its job (meta.json inside, else the user's last avatar job) and run the montage. */
  async function onAvatarResult(uid: number, m: TgMessage, d: { file_id: string; file_size?: number; file_name?: string }) {
    const chatId = m.chat.id;
    const L = T(uid);
    if (d.file_size !== undefined && d.file_size > uploadLimit(uid)) return tooLargeReply(uid, chatId, d.file_size);
    const file = await api.getFile(d.file_id);
    if (file.file_size !== undefined && file.file_size > uploadLimit(uid)) return tooLargeReply(uid, chatId, file.file_size);
    const dest = path.join(uploadDir(uid), `${safeName(d.file_id)}.zip`);
    if (!(await exists(dest))) await api.download(file, dest);
    let jobId: string | undefined;
    try {
      const { readZip } = await import("../lib/zip.ts");
      const meta = (await readZip(dest)).get("meta.json");
      const fromZip = meta ? (JSON.parse(meta.toString("utf8")) as { job?: string }).job : undefined;
      if (fromZip && /^[\w-]+$/.test(fromZip) && (await exists(path.join(jobDir(fromZip), "job.json")))) jobId = fromZip;
    } catch (err) {
      return void (await say(chatId, `✖ архив не читается: ${errMsg(err)}`));
    }
    const s = sess(uid);
    if (!jobId && s.avatar_job && (await exists(path.join(jobDir(s.avatar_job), "job.json")))) jobId = s.avatar_job;
    if (!jobId) return void (await say(chatId, L.avatarNoJob));
    const instruction = m.caption?.trim() || undefined;
    const runPreset = (instruction ? styleFromText(instruction) : undefined) ?? settingsOf(uid).style ?? "split_news";
    patchSess(uid, { jobId, avatar_job: jobId, ...(instruction ? { prompt: instruction } : {}) });
    await say(chatId, L.avatarImportStart(jobId));
    await submit(uid, chatId, "avatar_import", { jobId, result: dest, instruction, preset: runPreset }, "standard");
  }

  /** a photo (or an image file) / a voice note (or an audio file) for the next /avatar */
  async function onAvatarMedia(uid: number, m: TgMessage, kind: "photo" | "voice", f: { file_id: string; file_size?: number }, ext: string) {
    const chatId = m.chat.id;
    const L = T(uid);
    if (f.file_size !== undefined && f.file_size > uploadLimit(uid)) return tooLargeReply(uid, chatId, f.file_size);
    const file = await api.getFile(f.file_id);
    const dest = path.join(usersDir, String(uid), "avatar", `avatar_${kind}_${safeName(f.file_id).slice(-24)}${ext}`);
    if (!(await exists(dest))) await api.download(file, dest);
    patchSess(uid, kind === "photo" ? { avatar_photo: dest } : { avatar_voice: dest });
    log(`[${uid}] ${kind} для аватара: ${dest}`);
    const caption = m.caption?.trim();
    const cmd = caption ? /^\/avatar(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(caption) : null;
    if (cmd) return startAvatar(uid, chatId, (cmd[1] ?? "").trim());
    await say(chatId, kind === "photo" ? L.avatarPhotoSaved : L.avatarVoiceSaved);
  }

  // ── voices ──
  async function sendSample(uid: number, chatId: number, v: VoiceDef, quiet = false) {
    const L = T(uid);
    // Gemini voices without a key: the sample comes from their Piper fallback (that is what will actually speak)
    const src = isCloud(v) && !hasGoogleTtsKey() ? piperVoiceFor(v) : sampleVoiceFor(v);
    if (!src) return void (quiet ? undefined : await say(chatId, L.noSample));
    const task = (async () => {
      try {
        await action(chatId, "upload_voice");
        const dest = path.join(botDir, "_voices", `${src.id}.ogg`);
        const file = (await exists(dest)) ? dest : await voiceSampleFn(src.id, dest);
        await api.sendVoice(chatId, file, L.sampleCaption(src.id, v.id));
      } catch (err) {
        log(`[${uid}] проба голоса ${v.id}: ${err instanceof Error ? err.message : err}`);
        await say(chatId, L.sampleFailed(errMsg(err)));
      }
    })();
    track(task);
  }

  /** /voice [id|off]: list, choose (with a sample) or turn off the voiceover */
  async function voiceCommand(uid: number, chatId: number, arg: string) {
    const L = T(uid);
    if (!arg) return void (await say(chatId, L.voiceList(voiceOf(uid)), encodeKb(voicesKb(L, langOf(uid), voiceOf(uid)))));
    if (NO_VOICE.test(arg)) {
      db.setSetting(uid, "voice", "off");
      return void (await say(chatId, L.voiceOff));
    }
    const v = getVoice(arg);
    if (!v) return void (await say(chatId, L.voiceUnknown(arg)));
    db.setSetting(uid, "voice", v.id);
    await say(chatId, L.voiceSet(v));
    await sendSample(uid, chatId, v, true);
  }

  // ── /status ──
  async function status(uid: number, chatId: number) {
    const L = T(uid);
    const s = sess(uid);
    const lines: string[] = [];
    const mine = queue.jobsOf(uid);
    for (const id of mine.running) {
      const j = db.getJob(id);
      const c = cards.get(id);
      if (j) lines.push(L.statusNow(L.kind[j.kind] ?? j.kind, c ? (c.stage === "render" ? L.stage.render(c.renderPct) : L.stage[c.stage]) : "…", Math.round((Date.now() - Date.parse(j.started_at ?? j.created_at)) / 1000), queue.isAborted(id)));
    }
    for (const id of mine.waiting) {
      const j = db.getJob(id);
      if (j) lines.push(L.statusQueued(L.kind[j.kind] ?? j.kind, queue.position(id)));
    }
    if (s.source) lines.push(L.statusVideo(path.basename(s.source)));
    if (s.prompt) lines.push(L.statusTask(excerpt(s.prompt, 200)));
    if (s.jobId) {
      try {
        const job = await loadJob(s.jobId);
        lines.push(`job ${job.id} (${job.created_at.slice(0, 16).replace("T", " ")})`);
        for (const [step, st] of Object.entries(job.steps)) {
          const took = st.started_at && st.finished_at ? ` ${((+new Date(st.finished_at) - +new Date(st.started_at)) / 1000).toFixed(0)} с` : "";
          lines.push(`  ${step}: ${st.status}${took}${st.error ? ` — ${st.error.split("\n")[0].slice(0, 200)}` : ""}`);
        }
        const outs = (await fs.readdir(jobDir(job.id)).catch(() => [] as string[])).filter((f) => /^output_.+\.mp4$/.test(f));
        if (outs.length) lines.push(`MP4: ${outs.join(", ")}`);
      } catch {
        lines.push(L.statusJobMissing(s.jobId));
      }
    }
    await say(chatId, lines.length ? lines.join("\n") : L.noJob);
  }

  /** cancels a job; returns what happened */
  async function cancelJob(jobId: string): Promise<"queued" | "running" | null> {
    const r = queue.cancel(jobId);
    if (r === "queued") {
      const job = db.getJob(jobId);
      if (job) {
        if (job.paid_credits) db.addCredits(job.user, job.paid_credits);
        db.updateJob(jobId, { status: "cancelled", finished_at: new Date().toISOString() });
        await pushCard(jobId, true);
        cards.delete(jobId);
      }
    }
    return r;
  }

  // ── menu & settings ──
  /** the menu lives in inline buttons; the persistent reply keyboard of the first build is dropped once per user */
  async function dropReplyKeyboard(uid: number, chatId: number) {
    const key = `kb.removed.${uid}`;
    const created = db.getUser(uid)?.created_at;
    if (db.getKv(key) || !created || created >= inlineMenuSince) return;
    await say(chatId, "👇", { remove_keyboard: true });
    db.setKv(key, "1");
  }

  async function sayMenu(uid: number, chatId: number, text: string) {
    await dropReplyKeyboard(uid, chatId);
    await say(chatId, text, encodeKb(mainMenu(T(uid))));
  }

  async function showMenu(uid: number, chatId: number) {
    await sayMenu(uid, chatId, T(uid).menuText);
  }

  function settingsView(uid: number) {
    const L = T(uid);
    const st = settingsOf(uid);
    const v = st.voice;
    const voiceName = v === "off" ? L.voiceNone : v ? (getVoice(v) ? voiceLabel(getVoice(v)!, langOf(uid)) : v) : L.voiceAuto;
    const u = db.getUser(uid);
    const view = { aspect: st.aspect ?? "9:16", style: L.styleNames[st.style ?? preset] ?? st.style ?? preset, voice: voiceName, send: sendOf(uid), lang: langOf(uid), news: (u?.news ?? 1) === 1 };
    return { text: L.settings(view), kb: encodeKb(settingsKb(L, { aspect: view.aspect, style: st.style ?? preset, send: view.send, lang: view.lang, news: view.news })) };
  }

  async function balance(uid: number, chatId: number) {
    const L = T(uid);
    const p = plan();
    const u = db.getUser(uid);
    await say(chatId, L.balance({ plan: u?.plan ?? "free", credits: u?.credits ?? 0, usedStd: freeLeft(uid, "standard").used, std: p.standardPerDay, usedLong: freeLeft(uid, "long").used, long: p.longPerDay, cs: p.creditsStandard, cl: p.creditsLong, longMinutes: p.longMinutes, admin: isAdmin(uid) || !quotasOn }));
  }

  async function onMenu(uid: number, chatId: number, a: MenuAction) {
    const L = T(uid);
    const mb = Math.round(uploadLimit(uid) / 1024 / 1024);
    patchSess(uid, { awaiting: undefined });
    switch (a) {
      // a new batch gets a new option card (the old card may be far up the chat)
      case "montage":
        patchSess(uid, { intent: undefined, sources: [], batch_closed: false, ref: undefined, ref_fresh: undefined, card: undefined, draft: undefined, ctx: "montage" });
        return void (await say(chatId, L.montageAsk(mb)));
      case "ref":
        patchSess(uid, { awaiting: "ref", intent: undefined, sources: [], batch_closed: false, card: undefined, draft: undefined, ctx: "montage" });
        return void (await say(chatId, L.refAsk(mb)));
      case "highlights":
        patchSess(uid, { intent: "hl", sources: [], batch_closed: false, card: undefined, draft: undefined, ctx: "montage" });
        return void (await say(chatId, L.highlightsAsk(mb)));
      case "make":
        patchSess(uid, { awaiting: "topic", ctx: "make" });
        return void (await say(chatId, L.makeAskTopic));
      case "avatar":
        patchSess(uid, { awaiting: "avatar", ctx: "avatar" });
        return void (await say(chatId, L.avatarMenu, encodeKb({ inline_keyboard: [[{ text: L.btnAvatarReset, callback_data: "AV:reset" }]] })));
      case "settings": {
        const v = settingsView(uid);
        return void (await say(chatId, v.text, v.kb));
      }
      case "balance":
        return balance(uid, chatId);
      case "help":
        return sayMenu(uid, chatId, L.help);
    }
  }

  async function makeCardFor(uid: number, chatId: number, rawTopic: string) {
    const L = T(uid);
    const parsed = parseMakeArgs(rawTopic);
    if (!parsed.topic) return void (await say(chatId, L.makeUsage));
    const d: MakeDraft = { topic: parsed.topic, aspect: makeAspectExplicit(rawTopic) ? parsed.aspect : aspectOf(uid), voice: voiceOf(uid) ?? "auto" };
    patchSess(uid, { make: d, awaiting: undefined });
    await say(chatId, L.makeCard(d.topic), encodeKb(makeKb(L, langOf(uid), d)));
  }

  // ── onboarding ──
  async function sendDoc(uid: number, chatId: number, which: "terms" | "privacy") {
    const lang = langOf(uid);
    const file = path.join(docsDir, `${which}.${lang}.md`);
    let text: string;
    try {
      text = (await fs.readFile(file, "utf8")).replace(/^#+\s*/gm, "").trim();
    } catch {
      text = T(uid).docMissing;
    }
    for (let i = 0; i < text.length; i += 4000) await say(chatId, text.slice(i, i + 4000));
  }

  async function onboardingPrompt(user: UserRow, chatId: number) {
    const L = t(user.lang);
    if (user.onboarding === "lang") await say(chatId, L.langPrompt, langKb());
    else if (user.onboarding === "purpose") await say(chatId, `${L.intro}\n\n${L.askPurpose}`, purposeKb(L));
    else if (user.onboarding === "terms") await say(chatId, L.terms(retentionDays), termsKb(L));
  }

  async function finishOnboarding(uid: number, chatId: number) {
    const p = plan();
    db.updateUser(uid, { onboarding: "done", accepted_terms_at: new Date().toISOString() });
    const credits = quotasOn ? db.addCredits(uid, p.trialCredits) : db.getUser(uid)?.credits ?? 0;
    if (quotasOn && p.trialCredits) db.addUsage({ user: uid, kind: "credits:trial", units: -p.trialCredits, cost_usd: 0 });
    const L = T(uid);
    await sayMenu(uid, chatId, L.welcome(credits, p.standardPerDay, p.longPerDay, p.longMinutes));
    log(`[${uid}] регистрация завершена`);
  }

  const admin = adminHandlers({
    db,
    api,
    envAdmins,
    isAdmin,
    T,
    say: (chatId, text, markup) => say(chatId, text, markup ? encodeKb(markup) : undefined),
    edit: (chatId, msgId, text, markup) => edit(chatId, msgId, text, markup ? encodeKb(markup) : undefined),
    getAwaiting: (uid) => sess(uid).awaiting,
    setAwaiting: (uid, v) => patchSess(uid, { awaiting: v }),
    getBroadcast: (uid) => sess(uid).broadcast,
    setBroadcast: (uid, v) => patchSess(uid, { broadcast: v }),
    plan,
    queueCounts: () => ({ ...queue.counts(), max: queue.maxJobs }),
    dayStart: today,
    track,
    broadcastDelayMs: o.broadcastDelayMs ?? 50,
    log,
  });

  // ── messages ──
  /** background work of an update: awaited only without debounce (tests), the polling loop does not wait for it */
  const bg = (p: Promise<void>) => (albumDelayMs <= 0 ? p : undefined);

  async function handleMessage(user: UserRow, m: TgMessage) {
    const uid = user.tg_id;
    const chatId = m.chat.id;
    const L = t(user.lang);
    const s = sess(uid);
    // avatar_result.zip before the video check (an octet-stream zip is not a video)
    if (m.document && isAvatarResult(m.document.file_name)) return uploadsPending(uid) ? bg(afterUploads(uid, () => onAvatarResult(uid, m, m.document!))) : onAvatarResult(uid, m, m.document);
    const video = isVideoMessage(m);
    if (video && s.awaiting === "ref") return onReference(uid, chatId, { video, name: m.document?.file_name });
    if (video) return bg(queueUpload(uid, chatId, m.caption?.trim() || undefined, () => onVideo(uid, m, video)));
    const image = m.photo?.length ? m.photo[m.photo.length - 1] : m.document?.mime_type?.startsWith("image/") ? m.document : undefined;
    if (image) {
      // a photo in the middle of a montage is not meant for the avatar: say what to send instead of saving it silently
      if (s.ctx === "montage" && s.awaiting !== "avatar" && !/^\/avatar\b/i.test(m.caption ?? "")) return void (await say(chatId, L.photoInMontage));
      return onAvatarMedia(uid, m, "photo", image, m.photo?.length ? ".jpg" : path.extname(m.document?.file_name ?? "") || ".jpg");
    }
    if (m.voice) return onAvatarMedia(uid, m, "voice", m.voice, ".ogg");
    if (m.audio) return onAvatarMedia(uid, m, "voice", m.audio, path.extname(m.audio.file_name ?? "") || ".mp3");
    if (m.document) return void (await say(chatId, L.notVideo));
    const text = m.text?.trim();
    if (!text) return;
    // a message while this user's uploads are still downloading waits for them ("video, then «2 рилса»" must see
    // the video) — except the controls
    if (uploadsPending(uid) && !/^\/(cancel|status|start|menu|help)\b/i.test(text)) return bg(afterUploads(uid, () => handleText(user, m, text)));
    return handleText(user, m, text);
  }

  async function handleText(user: UserRow, m: TgMessage, text: string) {
    const uid = user.tg_id;
    const chatId = m.chat.id;
    const L = t(user.lang);

    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      const arg = (cmd[2] ?? "").trim();
      if (name !== "cancel" && name !== "status") patchSess(uid, { awaiting: undefined });
      switch (name) {
        case "start":
        case "menu":
          return showMenu(uid, chatId);
        case "help":
          return void (await say(chatId, L.help));
        case "status":
          return status(uid, chatId);
        case "cancel": {
          const mine = queue.jobsOf(uid);
          const ids = [...mine.running, ...mine.waiting];
          // a link download in progress stops too
          const dl = uploads.get(uid)?.dl;
          if (dl) dl.abort();
          if (!ids.length) return void (dl ? undefined : await say(chatId, L.nothingToCancel));
          await say(chatId, L.cancelling);
          for (const id of ids) await cancelJob(id);
          return;
        }
        case "revise":
          return startRevise(uid, chatId, arg);
        case "make": {
          const p = parseMakeArgs(arg);
          return startMake(uid, chatId, p.topic, makeAspectExplicit(arg) ? p.aspect : aspectOf(uid));
        }
        case "avatar":
          return startAvatar(uid, chatId, arg);
        case "viral":
          return startRun(uid, chatId, arg ? `${VIRAL_INSTRUCTION} Дополнительно: ${arg}` : VIRAL_INSTRUCTION);
        case "style": {
          const want = STYLES[arg.trim().toLowerCase()];
          if (!want) return void (await say(chatId, L.styleUsage(styleOf(uid))));
          db.setSetting(uid, "style", want);
          return void (await say(chatId, L.styleSet(want)));
        }
        case "clear":
          patchSess(uid, { sources: [], batch_closed: false, durations: {}, intent: undefined, draft: undefined, card: undefined, ref: undefined, ref_fresh: undefined });
          return void (await say(chatId, L.cleared));
        case "voice":
        case "voices":
          return voiceCommand(uid, chatId, arg);
        case "send": {
          const want = SEND_MODES[arg.trim().toLowerCase()];
          if (!want) return void (await say(chatId, L.sendUsage(sendOf(uid))));
          db.setSetting(uid, "send", want);
          return void (await say(chatId, L.sendSet(want)));
        }
        case "settings":
          return onMenu(uid, chatId, "settings");
        case "balance":
          return onMenu(uid, chatId, "balance");
        case "admin":
          if (!isAdmin(uid)) return void (await say(chatId, L.unknownCommand));
          return admin.menu(uid, chatId);
        default:
          return void (await say(chatId, L.unknownCommand));
      }
    }
    const menu = menuAction(text);
    if (menu) return onMenu(uid, chatId, menu);

    const awaiting = sess(uid).awaiting;
    if (awaiting?.startsWith("admin_")) {
      if (isAdmin(uid) && (await admin.text(uid, chatId, text))) return;
      patchSess(uid, { awaiting: undefined });
    }
    if (awaiting === "ref") {
      const url = findUrl(text);
      if (url) return onReference(uid, chatId, { url });
      return void (await say(chatId, L.refNeedFileOrLink));
    }
    if (awaiting === "topic") return makeCardFor(uid, chatId, text);
    if (awaiting === "avatar") return startAvatar(uid, chatId, text);
    if (awaiting?.startsWith("edit:")) return applyEdit(uid, chatId, awaiting.slice(5), text);
    // a link to a video (Google Drive, Yandex Disk, Dropbox, YouTube…) is an upload, like a file; words next to it
    // that read as a task run once it is downloaded, like a caption
    const links = findLinks(text);
    if (links.length) {
      const rest = textWithoutLinks(text);
      return bg(queueUpload(uid, chatId, looksLikeTask(rest) ? rest : undefined, () => onLinks(uid, chatId, links)));
    }
    return startRun(uid, chatId, text);
  }

  /** «✏️ Поправить» → text: revise the montage (or re-make the topic with the note) */
  async function applyEdit(uid: number, chatId: number, botJob: string, text: string) {
    patchSess(uid, { awaiting: undefined });
    const job = db.getJob(botJob);
    if (!job || job.user !== uid) return void (await say(chatId, T(uid).jobGone));
    const p = JSON.parse(job.payload) as Record<string, string>;
    if (job.kind === "make") return startMake(uid, chatId, `${p.topic}. Учти правку: ${text}`, p.aspect ?? aspectOf(uid), p.voice ?? "off");
    if (!job.vedit_job) return void (await say(chatId, T(uid).jobGone));
    return startRevise(uid, chatId, text, job.vedit_job);
  }

  // ── callbacks ──
  async function handleCallback(q: TgCallbackQuery) {
    const uid = q.from.id;
    const chatId = q.message?.chat.id ?? uid;
    const msgId = q.message?.message_id;
    let toast: string | undefined;
    let answered = false;
    const answer = async (text?: string) => {
      if (answered) return;
      answered = true;
      await api.answerCallbackQuery(q.id, text).catch(() => {});
    };
    try {
      if (allowed && !allowed.has(uid)) return void log(`[${chatId}] кнопка пропущена: ${uid} не в TELEGRAM_ALLOWED_USERS`);
      const user = touch(q.from);
      const L = t(user.lang);
      if (user.status === "banned" && !isAdmin(uid)) return void (await answer(L.banned));
      let data = q.data ?? "";
      if (data.startsWith("~")) data = db.getCallback(Number(data.slice(1))) ?? "";
      const [p, a, b, c] = data.split(":");
      // registration buttons work before "done"; everything else needs it
      if (onboardingOn && user.onboarding !== "done" && !["L", "P", "T"].includes(p)) {
        await answer(L.needStart);
        return onboardingPrompt(user, chatId);
      }
      switch (p) {
        case "noop":
          break;
        case "H": {
          await answer();
          if (a && a in L.menu) return onMenu(uid, chatId, a as MenuAction);
          break;
        }
        case "L": {
          if (!isLang(a)) break;
          db.updateUser(uid, { lang: a });
          const L2 = t(a);
          if (user.onboarding === "lang") {
            db.updateUser(uid, { onboarding: "purpose" });
            if (msgId) await edit(chatId, msgId, `${L2.intro}\n\n${L2.askPurpose}`, purposeKb(L2));
          }
          toast = L2.langName;
          break;
        }
        case "P": {
          if (user.onboarding !== "purpose" && user.onboarding !== "done") break;
          db.updateUser(uid, { purpose: a, ...(user.onboarding === "purpose" ? { onboarding: "terms" } : {}) });
          if (user.onboarding === "purpose" && msgId) await edit(chatId, msgId, L.terms(retentionDays), termsKb(L));
          break;
        }
        case "T": {
          if (a === "terms" || a === "privacy") {
            await answer();
            await sendDoc(uid, chatId, a);
            break;
          }
          if (a === "ok" && user.onboarding !== "done") {
            if (msgId) await edit(chatId, msgId, `${L.terms(retentionDays)}\n\n${L.btnAccept}`);
            await answer();
            await finishOnboarding(uid, chatId);
          }
          break;
        }
        case "M":
          // ▶️ while videos are still downloading: started right after them
          if (a === "go" && uploadsPending(uid)) {
            toast = L.uploadsPending;
            await bg(afterUploads(uid, () => montageCallback(uid, chatId, msgId, a)));
            break;
          }
          toast = await montageCallback(uid, chatId, msgId, a, b === undefined ? undefined : [b, c].filter(Boolean).join(":"));
          break;
        case "XD": {
          const dl = uploads.get(uid)?.dl;
          if (dl) dl.abort();
          toast = dl ? L.linkCancelled : L.nothingToCancel;
          break;
        }
        case "K":
          toast = await makeCallback(uid, chatId, msgId, a, [b, c].filter(Boolean).join(":"));
          break;
        case "S":
          toast = await settingsCallback(uid, chatId, msgId, a, [b, c].filter(Boolean).join(":"));
          break;
        case "V": {
          const id = a;
          if (id === "auto") db.setSetting(uid, "voice", undefined);
          else if (id === "off") db.setSetting(uid, "voice", "off");
          else if (getVoice(id)) db.setSetting(uid, "voice", getVoice(id)!.id);
          if (msgId) await editMarkup(chatId, msgId, encodeKb(voicesKb(L, user.lang, voiceOf(uid))));
          const v = getVoice(id);
          toast = L.voiceChosen(id === "auto" ? L.voiceAuto : id === "off" ? L.voiceNone : v ? voiceLabel(v, user.lang) : id);
          if (v) {
            await answer(toast);
            await sendSample(uid, chatId, v);
          }
          break;
        }
        case "VP": {
          const v = getVoice(a);
          await answer();
          if (v) await sendSample(uid, chatId, v);
          break;
        }
        case "AV":
          if (a === "reset") {
            patchSess(uid, { avatar_photo: undefined, avatar_voice: undefined });
            toast = L.avatarReset;
          }
          break;
        case "X": {
          const job = db.getJob(a);
          if (!job) break;
          if (job.user !== uid && !isAdmin(uid)) {
            toast = L.notYours;
            break;
          }
          const r = await cancelJob(a);
          toast = r === "queued" ? L.cancelled : r === "running" ? L.cancelling : L.nothingToCancel;
          break;
        }
        case "R":
        case "A":
        case "F":
          toast = await repeatJob(uid, chatId, p, a);
          break;
        case "E": {
          const job = db.getJob(a);
          if (!job || job.user !== uid) {
            toast = L.jobGone;
            break;
          }
          patchSess(uid, { awaiting: `edit:${a}` });
          await answer();
          await say(chatId, L.askEdit);
          break;
        }
        case "r": {
          const job = db.getJob(a);
          const n = Number(b);
          if (!job || job.user !== uid || job.status !== "done" || !(n >= 1 && n <= 5)) break;
          db.updateJob(a, { rating: n });
          if (msgId) await editMarkup(chatId, msgId, encodeKb(resultKb(L, a, n)));
          toast = L.rated(n);
          break;
        }
        case "a":
          if (!isAdmin(uid)) {
            toast = L.unknownCommand;
            break;
          }
          await answer();
          toast = await admin.callback(uid, chatId, msgId, data);
          if (toast) await say(chatId, toast);
          toast = undefined;
          break;
      }
    } catch (err) {
      log(`[${chatId}] ошибка кнопки ${q.data}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
    } finally {
      await answer(toast);
    }
  }

  async function montageCallback(uid: number, chatId: number, msgId: number | undefined, op: string, val?: string): Promise<string | undefined> {
    const L = T(uid);
    const s = sess(uid);
    const d: MontageDraft = s.draft ?? draftFor(uid, s.sources.length);
    if (op === "go") {
      // a second tap on ▶️ (or ▶️ on an older card): no second job with the same videos
      if (msgId && s.card !== msgId) return L.cardStale;
      const hl = d.mode === "hl" || d.mode === "pp";
      const ref = d.style === "ref" && !hl ? s.ref : undefined;
      // 🏀 on a batch: every video goes into the highlights (combined), not only the last one
      const job = await startRun(uid, chatId, draftInstruction(d), { preset: hl || ref ? undefined : STYLE_PRESET[d.style], highlights: hl, like: ref ?? null });
      // the card keeps its buttons when the job was not accepted (limit, full queue) — the user can retry
      if (job) {
        patchSess(uid, { draft: undefined, intent: undefined, card: undefined });
        if (msgId) await editMarkup(chatId, msgId, undefined);
      }
      return undefined;
    }
    if (op === "m" && (val === "reels" || val === "viral" || val === "hl" || val === "pp")) {
      d.mode = val;
      if (val !== "reels" && d.seconds === 30) d.seconds = 60;
    } else if (op === "n") d.count = Number(val) || d.count;
    else if (op === "s") d.seconds = Number(val) || d.seconds;
    else if (op === "a" && (val === "9:16" || val === "16:9")) d.aspect = val;
    else if (op === "y" && val === "ref" && s.ref) d.style = d.style === "ref" ? (PRESET_STYLE[styleOf(uid)] ?? "pop") : "ref";
    else if (op === "y" && val && STYLE_PRESET[val]) d.style = val;
    patchSess(uid, { draft: d });
    if (msgId) await editMarkup(chatId, msgId, encodeKb(montageKb(L, d, !!s.ref)));
    return undefined;
  }

  async function makeCallback(uid: number, chatId: number, msgId: number | undefined, op: string, val: string): Promise<string | undefined> {
    const L = T(uid);
    const d = sess(uid).make;
    if (!d) return L.jobGone;
    if (op === "go") {
      const job = await startMake(uid, chatId, d.topic, d.aspect, d.voice);
      if (job && msgId) await editMarkup(chatId, msgId, undefined);
      else if (!job) patchSess(uid, { make: d });
      return undefined;
    }
    if (op === "p") {
      const v = getVoice(val);
      if (v) await sendSample(uid, chatId, v);
      return undefined;
    }
    if (op === "a" && isAspect(val)) d.aspect = val;
    else if (op === "v" && (val === "auto" || val === "off" || getVoice(val))) d.voice = val;
    patchSess(uid, { make: d });
    if (msgId) await editMarkup(chatId, msgId, encodeKb(makeKb(L, langOf(uid), d)));
    return undefined;
  }

  async function settingsCallback(uid: number, chatId: number, msgId: number | undefined, op: string, val: string): Promise<string | undefined> {
    if (op === "v") {
      const L = T(uid);
      if (msgId) await edit(chatId, msgId, L.voicePick, encodeKb(voicesKb(L, langOf(uid), voiceOf(uid))));
      return undefined;
    }
    if (op === "a" && isAspect(val)) db.setSetting(uid, "aspect", val);
    else if (op === "y" && STYLE_PRESET[val]) db.setSetting(uid, "style", STYLE_PRESET[val]);
    else if (op === "s" && (val === "file" || val === "video" || val === "both")) db.setSetting(uid, "send", val);
    else if (op === "l" && isLang(val)) db.updateUser(uid, { lang: val });
    else if (op === "n") db.updateUser(uid, { news: (db.getUser(uid)?.news ?? 1) ? 0 : 1 });
    const v = settingsView(uid);
    if (msgId) await edit(chatId, msgId, v.text, v.kb);
    // a new language also changes the main menu labels
    if (op === "l") await showMenu(uid, chatId);
    return T(uid).saved;
  }

  /** 🔁 retry (R), 🔁 another take (A), 📐 other format (F) of a finished job */
  async function repeatJob(uid: number, chatId: number, op: string, botJob: string): Promise<string | undefined> {
    const L = T(uid);
    const job = db.getJob(botJob);
    if (!job || (job.user !== uid && !isAdmin(uid))) return L.jobGone;
    const p = JSON.parse(job.payload) as Record<string, unknown>;
    const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
    if (op === "R") {
      if (job.kind === "run" && str("source") && !(await exists(str("source")!))) return L.needVideo;
      const { resultAspect: _ra, ...clean } = p;
      await submit(uid, chatId, job.kind, clean, job.class);
      return undefined;
    }
    if (op === "A") {
      const note = "Сделай другой вариант: другие моменты и другой хук, чем в прошлый раз.";
      if (job.kind === "run") {
        if (!(await exists(str("source") ?? ""))) return L.needVideo;
        await submit(uid, chatId, "run", { ...p, instruction: `${str("instruction")} ${note}`, resultAspect: undefined }, job.class);
      } else if (job.kind === "make") await submit(uid, chatId, "make", { topic: str("topic"), voice: str("voice"), aspect: str("aspect") }, "standard");
      else if (job.vedit_job) await startRevise(uid, chatId, note, job.vedit_job);
      return undefined;
    }
    // F: the other frame (9:16 ↔ 16:9)
    const cur = str("resultAspect") ?? str("aspect") ?? aspectOf(uid);
    const other = cur === "16:9" ? "9:16" : "16:9";
    if (job.kind === "make") {
      await submit(uid, chatId, "make", { topic: str("topic"), voice: str("voice"), aspect: other, fromJob: job.vedit_job ?? undefined }, "standard");
      return undefined;
    }
    if (!job.vedit_job) return L.jobGone;
    await startRevise(uid, chatId, `Переделай все выходы в формате ${other}: тот же монтаж, только кадр ${other}.`, job.vedit_job);
    return undefined;
  }

  // ── updates ──
  function touch(from: TgUser): UserRow {
    const uid = from.id;
    // the operators (TELEGRAM_ADMIN_IDS) skip registration: they run the service
    const registered = !onboardingOn || envAdmins.has(uid);
    const init: Partial<UserRow> = { ...(envAdmins.has(uid) ? { role: "admin" } : {}), ...(registered ? { onboarding: "done", accepted_terms_at: new Date().toISOString() } : {}) };
    const u = db.touchUser(uid, from, init);
    if (envAdmins.has(uid) && (u.role !== "admin" || u.onboarding !== "done")) {
      db.updateUser(uid, { role: "admin", onboarding: "done" });
      return { ...u, role: "admin", onboarding: "done" };
    }
    return u;
  }

  async function handleUpdate(update: TgUpdate) {
    if (update.callback_query) return handleCallback(update.callback_query);
    const m = update.message;
    if (!m) return;
    try {
      const from = m.from;
      // the bot works in private chats only: in a group every message would become a task
      if (m.chat.type !== "private") return void log(`[${m.chat.id}] пропущено: чат типа ${m.chat.type}`);
      if (!from || (allowed && !allowed.has(from.id))) {
        log(`[${m.chat.id}] пропущено: пользователь ${from?.id ?? "?"} не в TELEGRAM_ALLOWED_USERS`);
        return;
      }
      const user = touch(from);
      if (user.status === "banned" && !isAdmin(from.id)) return void (await say(m.chat.id, t(user.lang).banned));
      if (onboardingOn && user.onboarding !== "done") return void (await onboardingPrompt(user, m.chat.id));
      await handleMessage(user, m);
    } catch (err) {
      log(`[${m.chat.id}] ошибка обработки update ${update.update_id}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      const uid = m.from?.id ?? 0;
      await say(m.chat.id, isAdmin(uid) ? errorText(err) : `✖ ${T(uid).failed}`);
    }
  }

  // ── restart recovery: jobs that were running are failed (refunded, user told); waiting ones go back in the queue ──
  for (const job of db.jobsByStatus("running")) {
    if (job.paid_credits) db.addCredits(job.user, job.paid_credits);
    db.updateJob(job.id, { status: "failed", error: "бот перезапущен", finished_at: new Date().toISOString() });
    const L = T(job.user);
    track(
      (async () => {
        if (job.status_msg_id) await edit(job.chat_id, job.status_msg_id, `${L.kind[job.kind] ?? job.kind} · ${job.id}\n${L.stage.failed}`);
        await say(job.chat_id, L.restarted, encodeKb(retryKb(L, job.id)));
      })(),
    );
  }
  for (const job of db.jobsByStatus("queued")) {
    cards.set(job.id, { chatId: job.chat_id, msgId: job.status_msg_id ?? undefined, stage: "start", pct: 0, renderPct: 0, lastAt: 0, chain: Promise.resolve() });
    queue.enqueue(job.id, job.user);
    log(`задача ${job.id} снова в очереди после перезапуска`);
  }

  // a batch whose option card was still waiting for the end of the burst when the bot stopped: the card now
  for (const { user: uid, data } of db.sessionsSince<unknown>(new Date(Date.now() - 6 * 3_600_000).toISOString())) {
    const s = SessionSchema.safeParse(data);
    if (!s.success || !s.data.sources.length || s.data.batch_closed || s.data.card || db.getUser(uid)?.onboarding !== "done") continue;
    log(`[${uid}] подборка из ${s.data.sources.length} видео без карточки после перезапуска — отправляю карточку`);
    track(montageCard(uid, uid, s.data.sources.length).catch((err) => log(`⚠ карточка ${uid}: ${errMsg(err)}`)));
  }

  // ── retention ──
  const retention = (now?: number) => runRetention({ db, usersDir, jobsRoot: WORKSPACE_ROOT, days: retentionDays, now });
  const timers: ReturnType<typeof setTimeout>[] = [];
  const cleanupEvery = o.cleanupIntervalMs ?? 86_400_000;
  if (cleanupEvery > 0) {
    const tick = () =>
      void retention()
        .then((r) => (r.files || r.jobs ? log(`очистка: файлов ${r.files} (${(r.bytes / 1024 / 1024).toFixed(0)} МБ), задач ${r.jobs}${r.errors.length ? `, ошибок ${r.errors.length}` : ""}`) : undefined))
        .catch((err) => log(`⚠ очистка: ${errMsg(err)}`));
    const first = setTimeout(tick, Math.min(60_000, cleanupEvery));
    first.unref?.();
    const every = setInterval(tick, cleanupEvery);
    every.unref?.();
    timers.push(first, every);
  }

  return {
    api,
    db,
    queue,
    botDir,
    usersDir,
    get offset() {
      return Number(db.getKv("offset") ?? 0);
    },
    set offset(v: number) {
      db.setKv("offset", String(v));
    },
    handleUpdate,
    isBusy: (uid) => {
      const j = queue.jobsOf(uid);
      return j.running.length + j.waiting.length > 0;
    },
    session: (uid) => sess(uid),
    settings: (uid) => settingsOf(uid),
    user: (uid) => db.getUser(uid),
    retention,
    save: async () => {},
    async idle() {
      for (;;) {
        await Promise.allSettled([...tasks]);
        await queue.idle();
        await Promise.allSettled([...cards.values()].map((c) => c.chain));
        const c = queue.counts();
        if (!tasks.size && !c.running && !c.waiting && ![...cards.values()].some((x) => x.timer)) break;
        await sleep(5);
      }
    },
    close() {
      for (const tm of timers) clearTimeout(tm);
      for (const c of cards.values()) if (c.timer) clearTimeout(c.timer);
      // burst timers and link downloads (an open batch gets its card again after the next start)
      for (const st of uploads.values()) {
        disarm(st);
        st.dl?.abort();
      }
      db.close();
    },
  };
}

export interface RunningBot {
  bot: Bot;
  /** stops polling (running pipelines continue until the process exits) */
  stop(): Promise<void>;
  /** resolves when the polling loop has exited */
  done: Promise<void>;
}

/** the Telegram command menu, per language */
async function setCommands(api: BotApi, log: (l: string) => void) {
  const sets: Record<Lang, [string, string][]> = {
    ru: [["start", "Меню"], ["make", "Ролик по теме"], ["viral", "Один вирусный ролик из видео"], ["settings", "Настройки"], ["balance", "Баланс и лимиты"], ["status", "Что сейчас делается"], ["cancel", "Отменить"], ["help", "Помощь"]],
    uz: [["start", "Menyu"], ["make", "Mavzu bo‘yicha rolik"], ["viral", "Videolardan bitta virusli rolik"], ["settings", "Sozlamalar"], ["balance", "Balans va limitlar"], ["status", "Hozir nima bajarilmoqda"], ["cancel", "Bekor qilish"], ["help", "Yordam"]],
    en: [["start", "Menu"], ["make", "Video on a topic"], ["viral", "One viral clip from videos"], ["settings", "Settings"], ["balance", "Balance and limits"], ["status", "What is running"], ["cancel", "Cancel"], ["help", "Help"]],
  };
  for (const [lang, cmds] of Object.entries(sets) as [Lang, [string, string][]][]) {
    try {
      await api.setMyCommands(
        cmds.map(([command, description]) => ({ command, description })),
        lang === "ru" ? undefined : lang,
      );
    } catch (err) {
      log(`⚠ setMyCommands(${lang}): ${errMsg(err)}`);
    }
  }
}

/** Long-polling loop. Never throws: getUpdates failures back off, each update is handled in try/catch. */
export async function startBot(o: BotOptions): Promise<RunningBot> {
  const log = o.onLog ?? ((l: string) => console.log(l));
  const bot = await createBot(o);
  const ac = new AbortController();
  const timeout = o.pollTimeout ?? 30;
  const retryDelay = o.retryDelayMs ?? 3000;
  let offset = bot.offset;
  void setCommands(bot.api, log);

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const tm = setTimeout(resolve, ms);
      ac.signal.addEventListener("abort", () => (clearTimeout(tm), resolve()), { once: true });
    });

  const done = (async () => {
    log(`бот запущен; рабочая папка ${bot.botDir}; задач одновременно: ${bot.queue.maxJobs}`);
    while (!ac.signal.aborted) {
      let updates: TgUpdate[];
      try {
        updates = await bot.api.getUpdates(offset, timeout, ac.signal);
      } catch (err) {
        if (ac.signal.aborted) break;
        log(`⚠ getUpdates: ${err instanceof Error ? err.message : err}`);
        if (err instanceof TelegramError && err.errorCode === 401) {
          log("✖ токен отклонён Telegram (401) — проверьте TELEGRAM_BOT_TOKEN; бот остановлен");
          break;
        }
        await wait(retryDelay);
        continue;
      }
      for (const u of updates) {
        if (ac.signal.aborted) break;
        offset = Math.max(offset, u.update_id + 1);
        await bot.handleUpdate(u);
      }
      if (updates.length && bot.offset !== offset) bot.offset = offset;
    }
    log("бот остановлен");
  })();

  return {
    bot,
    done,
    async stop() {
      ac.abort();
      await done;
    },
  };
}
