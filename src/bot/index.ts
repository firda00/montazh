// Telegram bot — the first user interface (SPEC §6, stage 7): video → instruction → MP4s.
// Pipeline functions are called directly (no CLI subprocess); every update is isolated in try/catch.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createJob, exists, jobDir, loadJob, readJson, runStep, writeJson, WORKSPACE_ROOT } from "../lib/workspace.ts";
import { PlanError } from "../plan/backend/types.ts";
import { MediaSchema, TranscriptSchema, type Edl, type Transcript } from "../schemas/index.ts";
import { makeBotApi, TelegramError, type BotApi, type CallMethod, type DownloadFn, type Limits, type TgMessage, type TgUpdate } from "./telegram-api.ts";
import { getVoice, isLocal, NO_VOICE, piperVoiceFor, voicesListText, type VoiceDef } from "../voice/catalog.ts";
import { detectAspect, isAspect, type Aspect } from "../lib/aspect.ts";

// same hints as src/cli.ts (cli.ts runs commander on import, so the table is duplicated here)
export const HINTS: Partial<Record<PlanError["code"], string>> = {
  no_backend: "варианты: ANTHROPIC_API_KEY в .env (бэкенд api) · `claude /login` (бэкенд agent по подписке) · готовый план: vedit cut <job> --edl <file>",
  auth: "проверьте ключ/вход: ANTHROPIC_API_KEY в .env или `claude /login`",
  refusal: "модель отказалась; переформулируйте инструкцию или выберите другой фрагмент",
  budget: "поднимите лимит: --budget <usd> (по умолчанию 1.50) или упростите инструкцию",
  invalid: "если модель вернула черновик, он сохранён как edl.draft.json — исправьте вручную и запустите vedit cut <job> --edl <file>; иначе уточните инструкцию",
  loop: "лимит запросов исчерпан; попробуйте --effort high или более конкретную инструкцию",
  nothing_to_plan: "запустите понимание видео: vedit understand <job> (или уберите --skip-understand)",
  missing_inputs: "сначала vedit run <video> или vedit ingest + vedit understand",
  model: "проверьте --model (по умолчанию claude-opus-5-5) и доступ организации к модели",
};

export const MSG = {
  help: [
    "Я монтирую короткие ролики из вашего видео.",
    "",
    "1. Пришлите видео (как видео или файлом, до 20 МБ).",
    "2. Напишите задачу, например: «3 рилса по 30 секунд, динамично, субтитры на узбекском».",
    "3. Получите готовые MP4 — по одному сообщению на каждый выход.",
    "",
    "Команды:",
    "/status — состояние последней задачи",
    "/revise <что изменить> — правка последнего монтажа (перережу и перерендерю только затронутое)",
    "/make <тема> — ролик по теме из ничего: тренды, сценарий, настоящие фото, моушн-графика, музыка. Вертикальный 9:16; для YouTube — /make 16:9 тема (или «… для ютуба»)",
    "Несколько видео подряд (или альбомом) → /viral — соберу один самый вирусный ролик из всех; /clear — новая подборка",
    "/style pop | split | calm — стиль монтажа (split: сверху сгенерированные картинки с карточками, снизу спикер)",
    "/voice — голоса для озвучки: /voice denis — выбрать (пришлю пробу), /voice off — без голоса; голос озвучит /make и /avatar",
    "/send file | video | both — как присылать ролики: файлом в исходном качестве (по умолчанию), видео с плеером (Telegram пережмёт) или и так и так",
    "/avatar <текст или тема> — говорящий аватар (бесплатно, через Google Colab): пришлите заранее фото (лицо анфас) и голосовое 5–10 с — аватар будет с вашим лицом и голосом; без них — вымышленный ведущий. Готовый avatar_result.zip пришлите сюда — смонтирую рилс",
    "/cancel — отменить текущую работу (после текущего шага)",
    "/start — эта справка",
  ].join("\n"),
  needVideo: "Сначала пришлите видео (как видео или файлом), потом напишите задачу.",
  batchSaved: (n: number) => `Видео ${n} в подборке. Пришлите ещё или напишите задачу — например /viral (соберу один самый вирусный ролик из всех). /clear — начать подборку заново.`,
  cleared: "Подборка очищена. Пришлите новые видео.",
  viral: "Собери один самый вирусный ролик 30–45 секунд из всех видео: самый сильный хук в первые 2 секунды, только лучшие моменты (эмоция, сильная мысль, неожиданный поворот, смешное), динамичный темп, каждый клип — законченная фраза, финал с законченной мыслью. Субтитры на языке речи.",
  busy: "ещё работаю над предыдущим — дождитесь результата или отправьте /cancel",
  videoSaved: "Видео получено. Теперь напишите задачу: что смонтировать (например, «2 рилса по 20 секунд с субтитрами»).",
  notVideo: "Это не похоже на видео. Пришлите ролик как видео или файлом с типом video/*.",
  noJob: "Пока нет задач. Пришлите видео и напишите задачу.",
  reviseUsage: "Напишите, что изменить: /revise в reel_1 убери приветствие",
  makeUsage: "Напишите тему: /make почему кофе дорожает в 2026",
  styleUsage: (cur: string) => `Сейчас: ${cur}. Варианты: /style pop — динамичные субтитры; /style split — сверху картинки и карточки, снизу спикер (как у новостных техно-блогеров); /style calm — спокойный.`,
  makeStart: "Делаю ролик по теме: тренды → сценарий → фото и графика → рендер. Это 3–6 минут.",
  reviseNoJob: "Нечего править: сначала смонтируйте видео (пришлите видео и задачу).",
  nothingToCancel: "Сейчас ничего не выполняется.",
  cancelling: "Отменяю — остановлюсь после текущего шага.",
  cancelled: "Отменено.",
  start: "Принято, начинаю монтаж. Это займёт несколько минут.",
  reviseStart: "Принято, правлю монтаж.",
  unknownCommand: "Не знаю такой команды. /start — справка.",
  avatarUsage: "Напишите текст или тему: /avatar почему кофе дорожает (тема — монолог напишу сам) или /avatar текст: Привет! Сегодня расскажу… Фото и голосовое для аватара можно прислать заранее; /avatar сброс — забыть их.",
  avatarStart: (photo: boolean, voice: boolean, voiceId?: string) =>
    `Готовлю задание для аватара: ${photo ? "ваше фото" : "вымышленный ведущий (сгенерирую портрет)"}, ${voice ? "ваш голос (клон)" : voiceId ? `голос ${voiceId}` : "стандартный голос"}. Это 1–3 минуты.`,
  voiceList: (current?: string) =>
    [
      `Голоса для озвучки (${current ? `сейчас: ${current}` : "сейчас без голоса"}):`,
      voicesListText(current),
      "",
      "/voice <id> — выбрать (пришлю пробу), /voice off — без голоса.",
      "Piper-голоса (denis, dmitri, ljspeech, john, cori) звучат и в /make, и в /avatar; chatterbox_* — только в /avatar (синтез в Colab).",
      "Ваше голосовое сообщение для /avatar важнее выбранного голоса.",
    ].join("\n"),
  voiceSet: (v: VoiceDef) => `Голос: ${v.id} — ${v.name}. Лицензия: ${v.license}.\n${isLocal(v) ? "Им будут озвучены /make и /avatar." : "Им будет говорить /avatar (Colab); для /make возьму локальный " + (piperVoiceFor(v)?.id ?? "голос по языку") + "."}`,
  voiceOff: "Озвучка выключена: /make снова без голоса, /avatar — стандартный голос Chatterbox (или ваше голосовое).",
  voiceUnknown: (id: string) => `Не знаю голос «${id}». /voice — список.`,
  sendUsage: (cur: string) => `Сейчас: ${cur}. /send file — файлом в исходном качестве (по умолчанию); /send video — видео с плеером (Telegram сжимает); /send both — и то и другое.`,
  sendSet: (mode: SendMode) => (mode === "file" ? "Ролики буду присылать файлом — без пережатия, можно сразу выкладывать." : mode === "video" ? "Ролики буду присылать как видео (с плеером; Telegram их сжимает)." : "Ролики буду присылать и видео (посмотреть), и файлом (для публикации)."),
  avatarPhotoSaved: "Фото сохранено для аватара. Теперь /avatar <текст или тема>.",
  avatarVoiceSaved: "Голос сохранён: аватар будет говорить им (нужно 5–10 с чистой речи на языке текста). Теперь /avatar <текст или тема>.",
  avatarReset: "Фото и голос для аватара забыты.",
  avatarNoJob: "Не нашёл задачу для этого архива: сначала /avatar <текст>, затем пришлите avatar_result.zip из Colab.",
  avatarImportStart: (jobId: string) => `Принял avatar_result.zip (задача ${jobId}). Монтирую рилс: аватар снизу, картинки сверху, субтитры, музыка.`,
  avatarInstructions: (jobId: string, lines: string[], warnings: string[]) =>
    [
      `Задание для аватара готово (задача ${jobId}) — файл avatar_job.zip выше.`,
      "",
      "Как получить видео (бесплатно, Google Colab):",
      "1. Откройте ноутбук colab_vedit_avatar.ipynb (из папки tools/avatar проекта) в colab.research.google.com → File → Upload notebook.",
      "2. Runtime → Change runtime type → T4 GPU, затем Runtime → Run all.",
      "3. В ячейке «Загрузка» выберите avatar_job.zip.",
      "4. Первый запуск ~10 минут (установка и модели), потом 2–5 минут.",
      "5. Скачается avatar_result.zip — пришлите его сюда документом, я смонтирую рилс.",
      ...(lines.length ? ["", "Текст:", ...lines.slice(0, 8).map((l, i) => `${i + 1}. ${l}`), ...(lines.length > 8 ? [`… ещё ${lines.length - 8}`] : [])] : []),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n"),
};

function tooLarge(sizeBytes: number, limits: Limits) {
  const mb = (n: number) => `${Math.round(n / 1024 / 1024)} МБ`;
  return [
    `Файл слишком большой: ${mb(sizeBytes)}, а облачный Bot API отдаёт ботам файлы только до ${mb(limits.downloadBytes)}.`,
    "Варианты: сожмите видео или обрежьте лишнее; либо запустите локальный сервер Bot API (github.com/tdlib/telegram-bot-api, флаг --local) и укажите TELEGRAM_API_BASE=http://localhost:8081 — тогда лимит 2000 МБ.",
  ].join("\n");
}

// ── pipeline contract (the real one is runFullPipeline/runRevisePipeline; tests inject fakes) ──

export interface PipelineOutput {
  id: string;
  file: string;
  duration?: number;
  aspect?: string;
}
export interface PipelineResult {
  jobId: string;
  outputs: PipelineOutput[];
  /** files sent as documents before the videos (e.g. avatar_job.zip) */
  documents?: { file: string; caption?: string }[];
  /** replaces the closing "Готово: N ролик(ов)…" message */
  message?: string;
  /** a short name for the files sent (make topic / title); default: the job id */
  title?: string;
  failed?: { id: string; error: string }[];
  reasoning?: string;
  notes?: string[];
}
export interface PipelineArgs {
  source: string;
  /** several videos: joined into one source before the pipeline */
  sources?: string[];
  instruction: string;
  preset: string;
  progress: (text: string) => Promise<void>;
  /** called as soon as the job id is known, so /status and /revise can find it even if a later step fails */
  onJob: (jobId: string) => void;
  signal: AbortSignal;
  log: (line: string) => void;
}
export interface ReviseArgs {
  jobId: string;
  edit: string;
  progress: (text: string) => Promise<void>;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type PipelineFn = (args: PipelineArgs) => Promise<PipelineResult>;
export type ReviseFn = (args: ReviseArgs) => Promise<PipelineResult>;
export interface MakeArgs {
  topic: string;
  /** catalogue voice for the voiceover (/voice) */
  voice?: string;
  /** output frame: "/make 16:9 тема", or detected from the words ("для ютуба" → 16:9, "шортс" → 9:16) */
  aspect?: Aspect;
  progress: (text: string) => Promise<void>;
  onJob: (jobId: string) => void;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type MakeFn = (args: MakeArgs) => Promise<PipelineResult>;

/** "/make 16:9 тема" → { aspect: "16:9", topic: "тема" }; without a leading ratio the words decide (default 9:16). */
export function parseMakeArgs(arg: string): { topic: string; aspect: Aspect } {
  const m = /^\s*(9:16|16:9|1:1)\s+([\s\S]*)$/.exec(arg);
  const topic = (m ? m[2] : arg).trim();
  return { topic, aspect: m && isAspect(m[1]) ? m[1] : (detectAspect(topic) ?? "9:16") };
}

export interface AvatarExportArgs {
  /** "/avatar" argument: a topic or the text itself */
  input: string;
  photo?: string;
  /** the user's voice note (cloned); wins over voiceId */
  voice?: string;
  /** catalogue voice chosen with /voice */
  voiceId?: string;
  /** job source label, so the job counts as a bot job */
  sourceLabel: string;
  progress: (text: string) => Promise<void>;
  onJob: (jobId: string) => void;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type AvatarExportFn = (args: AvatarExportArgs) => Promise<PipelineResult>;
export interface AvatarImportArgs {
  jobId: string;
  /** avatar_result.zip on disk */
  result: string;
  instruction?: string;
  preset: string;
  progress: (text: string) => Promise<void>;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type AvatarImportFn = (args: AvatarImportArgs) => Promise<PipelineResult>;

/** /avatar: text or topic (+ photo, + voice) → avatar_job.zip and instructions for the Colab notebook. */
export const runAvatarExport: AvatarExportFn = async ({ input, photo, voice, voiceId, sourceLabel, progress, onJob, log }) => {
  const { exportAvatarJob } = await import("../avatar/export.ts");
  const r = await exportAvatarJob({
    input,
    photo,
    voice,
    voiceId: voice ? undefined : voiceId,
    sourceLabel,
    onEvent: (l) => {
      if (/^job /.test(l)) onJob(l.slice(4).trim());
      else if (/^▸/.test(l)) void progress(l);
      else log(`  ${l.trim()}`);
    },
  });
  return {
    jobId: r.jobId,
    outputs: [],
    documents: [{ file: r.bundle, caption: `avatar_job.zip · задача ${r.jobId} · ≈${r.state.estimated_seconds.toFixed(0)} с речи` }],
    message: MSG.avatarInstructions(r.jobId, r.state.lines, r.warnings),
  };
};

/** avatar_result.zip → import into its job → montage (split_news by default) → reels. */
export const runAvatarImport: AvatarImportFn = async ({ jobId, result, instruction, preset, progress, signal, log }) => {
  const { importAvatarResult, runAvatarMontage } = await import("../avatar/import.ts");
  const imp = await importAvatarResult(jobId, result);
  for (const w of imp.warnings) log(`  ⚠ ${w}`);
  checkCancel(signal);
  const m = await runAvatarMontage(jobId, { prompt: instruction, design: preset, progress, checkpoint: () => checkCancel(signal), onEvent: (l) => log(`  ${l.trim()}`) });
  return { jobId, outputs: m.outputs, failed: m.failed, reasoning: m.reasoning, notes: [...imp.warnings, ...m.notes].slice(0, 4) };
};

/** /make: topic → video from nothing (trends → script → motion graphics → render). */
export const runMakePipeline: MakeFn = async ({ topic, voice, aspect, progress, onJob, signal, log }) => {
  const { make, creditsText } = await import("../make/index.ts");
  const r = await make(topic, {
    signal,
    voice,
    aspect,
    onEvent: (l) => {
      if (/^job /.test(l)) onJob(l.slice(4).trim());
      else if (/^▸/.test(l)) void progress(l);
      else log(`  ${l.trim()}`);
    },
  });
  const notes = r.warnings.slice(0, 3);
  const credits = creditsText(r);
  return { jobId: r.jobId, title: topic, outputs: [{ id: "make", file: r.output, duration: r.duration, aspect: r.aspect }], reasoning: `${r.title}\n${r.script.beats.map((b) => `· ${b.text}`).join("\n")}${r.script.hashtags.length ? `\n#${r.script.hashtags.join(" #")}` : ""}${credits ? `\n${credits}` : ""}`, notes };
};

class CancelledError extends Error {
  constructor() {
    super("отменено");
    this.name = "CancelledError";
  }
}
function checkCancel(signal: AbortSignal) {
  if (signal.aborted) throw new CancelledError();
}

function planSummary(edl: Edl, report: { usd: number; estimate: boolean; backend: string }) {
  const lines = [`▸ план готов: ${edl.outputs.length} выход(ов)`];
  for (const o of edl.outputs) {
    const dur = o.clips.reduce((s, c) => s + (c.src_end - c.src_start) / (c.speed ?? 1), 0);
    const caps = o.captions.enabled ? `, субтитры${o.captions.language ? ` ${o.captions.language}` : ""}` : "";
    lines.push(`• ${o.id}: ${o.aspect}, ≈${dur.toFixed(0)} с, ${o.clips.length} клип(ов)${caps}`);
  }
  if (edl.reasoning) lines.push(`«${excerpt(edl.reasoning, 400)}»`);
  lines.push(`стоимость плана: ${report.estimate ? "≈" : ""}$${report.usd.toFixed(3)} (${report.backend})`);
  return lines.join("\n");
}

async function loadTranscript(jobId: string): Promise<Transcript | undefined> {
  const file = path.join(jobDir(jobId), "transcript.json");
  return (await exists(file)) ? readJson(file, TranscriptSchema) : undefined;
}

/** Renders `ids` through HyperFrames, reporting "▸ рендер <id> (i/n)…" before each output. */
async function renderIds(jobId: string, ids: string[], edl: Edl, progress: (t: string) => Promise<void>, log: (l: string) => void) {
  const { HyperFramesRenderer } = await import("../render/hyperframes.ts");
  const { renderOutputs } = await import("../render/index.ts");
  const renderer = new HyperFramesRenderer();
  await renderer.prepare();
  let i = 0;
  const pending: Promise<void>[] = [];
  const r = await runStep(jobId, "render", () =>
    renderOutputs(jobId, {
      renderer,
      quality: "looks",
      only: ids,
      edl,
      onEvent: (line) => {
        log(`  ${line}`);
        const m = /^▸ design (\S+)/.exec(line);
        if (m) pending.push(progress(`▸ рендер ${m[1]} (${++i}/${ids.length})…`));
      },
    }),
  );
  await Promise.all(pending);
  const outputs: PipelineOutput[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const o of r.outputs) {
    if (o.status === "ok" && o.output) outputs.push({ id: o.id, file: o.output, duration: o.duration, aspect: edl.outputs.find((e) => e.id === o.id)?.aspect });
    else failed.push({ id: o.id, error: o.error ?? o.status });
  }
  return { outputs, failed };
}

/** createJob → ingest → understand → plan → cut → render (HyperFrames), with progress messages. */
export const runFullPipeline: PipelineFn = async ({ source, sources, instruction, preset, progress, onJob, signal, log }) => {
  const { ingest } = await import("../ingest/index.ts");
  const { understand } = await import("../understand/index.ts");
  const { plan } = await import("../plan/index.ts");
  const { cut } = await import("../cut/index.ts");

  const many = (sources ?? []).length > 1;
  const job = await createJob(many ? `combined:${sources!.length} videos` : source, { prompt: instruction, preset });
  onJob(job.id);
  log(`job ${job.id}`);

  let input = source;
  if (many) {
    const { combineSources, SourcesSchema } = await import("../ingest/combine.ts");
    await progress(`▸ склеиваю ${sources!.length} видео в один материал…`);
    input = path.join(jobDir(job.id), "combined.mp4");
    const map = await combineSources(sources!, input);
    await writeJson(path.join(jobDir(job.id), "sources.json"), SourcesSchema, map);
    log(`  combined: ${map.sources.map((s) => `${s.id} ${s.start}-${s.end}s`).join(", ")}${map.sources.some((s) => s.cropped) ? " (часть обрезана под общий формат)" : ""}`);
  }
  checkCancel(signal);

  await progress("▸ подготовка видео…");
  const media = await runStep(job.id, "ingest", () => ingest(job.id, input));
  checkCancel(signal);

  await progress(`▸ анализ речи… (${media.duration.toFixed(0)} с видео)`);
  const u = await runStep(job.id, "understand", () => understand(job.id, media, { onLog: (l) => log(`    ${l}`) }));
  checkCancel(signal);

  await progress("▸ план…");
  const p = await runStep(job.id, "plan", () => plan(job.id, { instruction, preset, onEvent: (l) => log(`  ${l.trim()}`) }));
  const edl = p.edl!;
  await progress(planSummary(edl, p.report));
  checkCancel(signal);

  await progress("▸ нарезка…");
  const cutReport = await runStep(job.id, "cut", () => cut(job.id, edl, media, { transcript: u.transcript, snap: true, scenes: u.scenes }));
  const failed = cutReport.outputs.filter((o) => o.status !== "ok").map((o) => ({ id: o.id, error: o.error ?? "ошибка нарезки" }));
  const okIds = cutReport.outputs.filter((o) => o.status === "ok").map((o) => o.id);
  checkCancel(signal);

  const rendered = okIds.length ? await renderIds(job.id, okIds, edl, progress, log) : { outputs: [], failed: [] };
  return { jobId: job.id, outputs: rendered.outputs, failed: [...failed, ...rendered.failed], reasoning: edl.reasoning, notes: p.report.warnings.slice(0, 3) };
};

/** revise(job) → cut affected → render outputs whose design/render changed (same rule as `vedit revise`). */
export const runRevisePipeline: ReviseFn = async ({ jobId, edit, progress, signal, log }) => {
  const { revise } = await import("../plan/revise.ts");
  const { cut, loadScenes } = await import("../cut/index.ts");
  await loadJob(jobId);

  await progress("▸ правка плана…");
  const r = await runStep(jobId, "revise", () => revise(jobId, { edit, onEvent: (l) => log(`  ${l.trim()}`) }));
  const d = r.report.diff;
  await progress(
    [
      `▸ план обновлён: изменено ${d.changed.map((c) => `${c.id} (${c.fields.join(", ")})`).join(", ") || "—"}; добавлено ${d.added.join(", ") || "—"}; удалено ${d.removed.join(", ") || "—"}`,
      ...r.report.warnings.slice(0, 3).map((w) => `⚠ ${w}`),
    ].join("\n"),
  );
  checkCancel(signal);

  const failed: { id: string; error: string }[] = [];
  if (r.affected.length) {
    await progress(`▸ нарезка (${r.affected.join(", ")})…`);
    const media = await readJson(path.join(jobDir(jobId), "media.json"), MediaSchema);
    const transcript = await loadTranscript(jobId);
    const scenes = await loadScenes(jobId);
    const rep = await runStep(jobId, "cut", () => cut(jobId, r.edl, media, { only: r.affected, transcript, snap: true, scenes }));
    failed.push(...rep.outputs.filter((o) => o.status !== "ok").map((o) => ({ id: o.id, error: o.error ?? "ошибка нарезки" })));
  }
  checkCancel(signal);
  const toRender = [...d.added, ...d.changed.map((c) => c.id)].filter(
    (id, i, arr) => arr.indexOf(id) === i && (d.stages[id] ?? []).some((s) => s === "design" || s === "render") && !failed.some((f) => f.id === id),
  );
  if (!toRender.length) {
    await progress("▸ перерендер не нужен: оформление и нарезка не менялись");
    return { jobId, outputs: [], failed, reasoning: r.edl.reasoning };
  }
  const rendered = await renderIds(jobId, toRender, r.edl, progress, log);
  return { jobId, outputs: rendered.outputs, failed: [...failed, ...rendered.failed], reasoning: r.edl.reasoning };
};

// ── state ──────────────────────────────────────────────────────────────────────

export const ChatStateSchema = z.object({
  source: z.string().optional(),
  /** videos collected for the next run (several → one combined source) */
  sources: z.array(z.string()).default([]),
  /** a run used the batch: the next video starts a new one */
  batch_closed: z.boolean().default(false),
  /** design preset chosen with /style (bold_pop, split_news, calm) */
  style: z.string().optional(),
  jobId: z.string().optional(),
  prompt: z.string().optional(),
  /** /avatar: the last photo and voice sample sent to the chat, and the job of the last avatar_job.zip */
  avatar_photo: z.string().optional(),
  avatar_voice: z.string().optional(),
  avatar_job: z.string().optional(),
  /** /voice: catalogue voice for /make voiceovers and /avatar */
  voice: z.string().optional(),
  /** /send: how finished reels are delivered (default file — no Telegram recompression) */
  send: z.enum(["file", "video", "both"]).optional(),
  updated_at: z.string().optional(),
});
export type SendMode = "file" | "video" | "both";
export const SEND_MODES: Record<string, SendMode> = { file: "file", document: "file", doc: "file", файл: "file", файлом: "file", video: "video", видео: "video", both: "both", оба: "both", все: "both" };
export const BotStateSchema = z.object({
  version: z.literal(1).default(1),
  offset: z.number().int().optional(),
  chats: z.record(z.string(), ChatStateSchema).default({}),
});
export type ChatState = z.infer<typeof ChatStateSchema>;

/** /style names → presets */
export const STYLES: Record<string, string> = { pop: "bold_pop", bold: "bold_pop", bold_pop: "bold_pop", split: "split_news", news: "split_news", split_news: "split_news", calm: "calm" };

/** a style named in the instruction itself ("в стиле сплит", "как у aleko") */
export function styleFromText(text: string): string | undefined {
  if (/(сплит|split|как у aleko|как aleko|новостн\w* сплит|карточк\w* сверху)/i.test(text)) return "split_news";
  return undefined;
}
export type BotState = z.infer<typeof BotStateSchema>;

interface Running {
  kind: "run" | "revise" | "make" | "avatar";
  stage: string;
  startedAt: number;
  ac: AbortController;
}

// ── bot ────────────────────────────────────────────────────────────────────────

export interface BotOptions {
  token: string;
  /** when set, updates from other user ids are ignored */
  allowedUserIds?: number[];
  /** directory holding `_bot/` (downloads + state.json); default WORKSPACE_ROOT. Jobs always go to VEDIT_WORKSPACE. */
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
  /** long-polling timeout, seconds (default 30) */
  pollTimeout?: number;
  /** how long to wait for the rest of an album before acting (ms, default 4000) */
  albumDelayMs?: number;
  /** pause after a failed getUpdates, ms (default 3000) */
  retryDelayMs?: number;
}

export interface Bot {
  readonly api: BotApi;
  readonly state: BotState;
  readonly botDir: string;
  handleUpdate(update: TgUpdate): Promise<void>;
  /** resolves when no pipeline is running */
  idle(): Promise<void>;
  isBusy(chatId: number): boolean;
  /** writes state.json (serialized with every other state write) */
  save(): Promise<void>;
}

export function errorText(err: unknown): string {
  if (err instanceof CancelledError) return MSG.cancelled;
  const first = (err instanceof Error ? err.message : String(err)).split("\n")[0].trim();
  if (err instanceof PlanError) {
    const hint = HINTS[err.code];
    return `✖ план: ${first}${hint ? `\n→ ${hint}` : ""}`;
  }
  return `✖ ${first}`;
}

const excerpt = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

export function videoCaption(o: PipelineOutput, reasoning?: string) {
  const head = [o.id, o.duration !== undefined ? `${o.duration.toFixed(1)} с` : null, o.aspect ?? null].filter(Boolean).join(" · ");
  return reasoning ? `${head}\n«${excerpt(reasoning, 300)}»` : head;
}

function isVideoMessage(m: TgMessage) {
  if (m.video) return { fileId: m.video.file_id, size: m.video.file_size };
  const d = m.document;
  if (d && (d.mime_type?.startsWith("video/") || /\.(mp4|mov|m4v|mkv|webm|avi)$/i.test(d.file_name ?? ""))) return { fileId: d.file_id, size: d.file_size };
  return null;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

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

/** the Colab notebook's output: avatar_result.zip (browsers may add " (1)" or "-2" to repeated downloads) */
export function isAvatarResult(fileName?: string): boolean {
  return /^avatar_result[^/\\]*\.zip$/i.test(fileName ?? "");
}

export async function createBot(o: BotOptions): Promise<Bot> {
  const log = o.onLog ?? ((l: string) => console.log(l));
  const api = o.api ?? makeBotApi(o.token, { callMethod: o.callMethod, download: o.download, apiBase: o.apiBase, limits: o.limits });
  const pipelineFn = o.pipeline ?? runFullPipeline;
  const reviseFn = o.revise ?? runRevisePipeline;
  const makeFn = o.make ?? runMakePipeline;
  const avatarExportFn = o.avatarExport ?? runAvatarExport;
  const avatarImportFn = o.avatarImport ?? runAvatarImport;
  const voiceSampleFn = o.voiceSample ?? defaultVoiceSample;
  const shrinkFn = o.shrinkVideo ?? shrinkForTelegram;
  const preset = o.preset ?? "bold_pop";
  const botDir = path.join(path.resolve(o.workspace ?? WORKSPACE_ROOT), "_bot");
  const stateFile = path.join(botDir, "state.json");
  const allowed = o.allowedUserIds?.length ? new Set(o.allowedUserIds) : null;

  let state: BotState = { version: 1, chats: {} };
  if (await exists(stateFile)) {
    try {
      state = await readJson(stateFile, BotStateSchema);
    } catch (err) {
      log(`⚠ state.json не прочитан, начинаю с пустого: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }

  // writeJson uses one tmp name per process — serialize writes so two chats never race on it
  let saving: Promise<unknown> = Promise.resolve();
  const saveState = () => {
    saving = saving.then(() => writeJson(stateFile, BotStateSchema, state)).catch((err) => log(`⚠ state.json не записан: ${err instanceof Error ? err.message : err}`));
    return saving;
  };
  const chat = (id: number): ChatState => (state.chats[String(id)] ??= { sources: [], batch_closed: false });
  /** the preset for a run: /style, or a style named in the instruction, or the bot default */
  const presetFor = (chatId: number, instruction: string) => styleFromText(instruction) ?? chat(chatId).style ?? preset;
  const updateChat = async (id: number, patch: Partial<ChatState>) => {
    Object.assign(chat(id), patch, { updated_at: new Date().toISOString() });
    await saveState();
  };

  const running = new Map<number, Running>();
  const albums = new Map<string, { caption?: string; timer?: ReturnType<typeof setTimeout> }>();
  const albumDelayMs = o.albumDelayMs ?? 4000;
  const tasks = new Set<Promise<void>>();

  const say = async (chatId: number, text: string) => {
    try {
      await api.sendMessage(chatId, text);
    } catch (err) {
      log(`⚠ sendMessage(${chatId}) не удался: ${err instanceof Error ? err.message : err}`);
    }
  };
  const action = (chatId: number, a: Parameters<BotApi["sendChatAction"]>[1]) => api.sendChatAction(chatId, a).catch(() => {});

  async function deliver(chatId: number, result: PipelineResult) {
    for (const doc of result.documents ?? []) {
      await action(chatId, "upload_document");
      try {
        await api.sendDocument(chatId, doc.file, doc.caption);
      } catch (err) {
        await say(chatId, `Не удалось отправить ${path.basename(doc.file)} (${err instanceof TelegramError ? err.description : String(err)}). Он лежит на сервере: ${doc.file}`);
      }
    }
    const mode: SendMode = chat(chatId).send ?? "file";
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
          log(`⚠ сжатие ${out.id}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
          await say(chatId, `${caption}\nФайл ${mb(size)} больше лимита отправки ботом (${mb(api.limits.uploadBytes)}) — он лежит на сервере: ${out.file}`);
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
      if (mode === "both") {
        await asVideo().catch((err) => log(`⚠ sendVideo ${out.id}: ${err instanceof Error ? err.message : err}`));
      }
      try {
        await first();
      } catch (err) {
        log(`⚠ ${mode === "video" ? "sendVideo" : "sendDocument"} ${out.id}: ${err instanceof Error ? err.message : err} — пробую ${mode === "video" ? "документом" : "видео"}`);
        try {
          await second();
        } catch (err2) {
          await say(chatId, `${caption}\nНе удалось отправить файл (${err2 instanceof TelegramError ? err2.description : String(err2)}). Он лежит на сервере: ${file}`);
        }
      }
    }
    const lines: string[] = [];
    for (const f of result.failed ?? []) lines.push(`✖ ${f.id}: ${f.error.split("\n")[0]}`);
    for (const n of [...notes, ...(result.notes ?? [])]) lines.push(`⚠ ${n}`);
    if (result.message) {
      await say(chatId, [result.message, ...lines].join("\n"));
      return;
    }
    const head = result.outputs.length ? `Готово: ${result.outputs.length} ролик(ов), задача ${result.jobId}.` : `Новых роликов нет (задача ${result.jobId}).`;
    await say(chatId, [head, ...lines, result.outputs.length ? "Правка: /revise <что изменить>" : ""].filter(Boolean).join("\n"));
  }

  function launch(chatId: number, kind: Running["kind"], work: (r: Running) => Promise<PipelineResult>) {
    const r: Running = { kind, stage: "старт", startedAt: Date.now(), ac: new AbortController() };
    running.set(chatId, r);
    const task = (async () => {
      try {
        const result = await work(r);
        if (r.ac.signal.aborted) throw new CancelledError();
        r.stage = "отправка";
        await deliver(chatId, result);
        log(`[${chatId}] ${kind} ok: ${result.jobId}, ${result.outputs.length} файл(ов)`);
      } catch (err) {
        log(`[${chatId}] ${kind} ошибка: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        await say(chatId, errorText(err));
      } finally {
        running.delete(chatId);
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }

  const progressFor = (chatId: number, r: Running) => async (text: string) => {
    r.stage = text.split("\n")[0].replace(/^▸\s*/, "").replace(/…$/, "");
    log(`[${chatId}] ${text.split("\n")[0]}`);
    await action(chatId, "typing");
    await say(chatId, text);
  };

  async function startRun(chatId: number, instruction: string) {
    const c = chat(chatId);
    if (!c.source || !(await exists(c.source))) {
      await say(chatId, MSG.needVideo);
      return;
    }
    const source = c.source;
    const batch = [];
    for (const f of c.sources ?? []) if (await exists(f)) batch.push(f);
    const sources = batch.length > 1 ? batch : undefined;
    await updateChat(chatId, { prompt: instruction, batch_closed: true });
    await say(chatId, sources ? `${MSG.start}\nВидео в подборке: ${sources.length} — склею и выберу лучшее из всех.` : MSG.start);
    const runPreset = presetFor(chatId, instruction);
    if (runPreset !== preset) log(`[${chatId}] стиль: ${runPreset}`);
    launch(chatId, "run", (r) =>
      pipelineFn({
        source,
        sources,
        instruction,
        preset: runPreset,
        progress: progressFor(chatId, r),
        onJob: (jobId) => void updateChat(chatId, { jobId }),
        signal: r.ac.signal,
        log: (l) => log(`[${chatId}] ${l}`),
      }),
    );
  }

  async function startMake(chatId: number, arg: string) {
    const { topic, aspect } = parseMakeArgs(arg);
    if (!topic) return say(chatId, MSG.makeUsage);
    await updateChat(chatId, { prompt: topic });
    await say(chatId, `${MSG.makeStart}${aspect !== "9:16" ? ` Кадр ${aspect}.` : ""}`);
    const voice = chat(chatId).voice;
    launch(chatId, "make", (r) => makeFn({ topic, voice, aspect, progress: progressFor(chatId, r), onJob: (jobId) => void updateChat(chatId, { jobId }), signal: r.ac.signal, log: (l) => log(`[${chatId}] ${l}`) }));
  }

  async function startRevise(chatId: number, edit: string) {
    const jobId = chat(chatId).jobId;
    if (!edit) return say(chatId, MSG.reviseUsage);
    if (!jobId) return say(chatId, MSG.reviseNoJob);
    await say(chatId, MSG.reviseStart);
    launch(chatId, "revise", (r) => reviseFn({ jobId, edit, progress: progressFor(chatId, r), signal: r.ac.signal, log: (l) => log(`[${chatId}] ${l}`) }));
  }

  async function startAvatar(chatId: number, input: string) {
    if (!input) return say(chatId, MSG.avatarUsage);
    if (/^(сброс|reset|clear)$/i.test(input)) {
      await updateChat(chatId, { avatar_photo: undefined, avatar_voice: undefined });
      return say(chatId, MSG.avatarReset);
    }
    const c = chat(chatId);
    const photo = c.avatar_photo && (await exists(c.avatar_photo)) ? c.avatar_photo : undefined;
    const voice = c.avatar_voice && (await exists(c.avatar_voice)) ? c.avatar_voice : undefined;
    // the user's own voice note wins over the catalogue voice
    const voiceId = voice ? undefined : c.voice;
    await updateChat(chatId, { prompt: input });
    await say(chatId, MSG.avatarStart(!!photo, !!voice, voiceId));
    launch(chatId, "avatar", (r) =>
      avatarExportFn({
        input,
        photo,
        voice,
        voiceId,
        sourceLabel: path.join(botDir, String(chatId), "avatar"),
        progress: progressFor(chatId, r),
        onJob: (jobId) => void updateChat(chatId, { jobId, avatar_job: jobId }),
        signal: r.ac.signal,
        log: (l) => log(`[${chatId}] ${l}`),
      }),
    );
  }

  /** avatar_result*.zip: find its job (meta.json inside, else the chat's last avatar job) and run the montage. */
  async function onAvatarResult(m: TgMessage, d: { file_id: string; file_size?: number; file_name?: string }) {
    const chatId = m.chat.id;
    if (running.has(chatId)) return say(chatId, MSG.busy);
    if (d.file_size !== undefined && d.file_size > api.limits.downloadBytes) return say(chatId, tooLarge(d.file_size, api.limits));
    const file = await api.getFile(d.file_id);
    if (file.file_size !== undefined && file.file_size > api.limits.downloadBytes) return say(chatId, tooLarge(file.file_size, api.limits));
    const dest = path.join(botDir, String(chatId), `${safeName(d.file_id)}.zip`);
    if (!(await exists(dest))) await api.download(file, dest);
    let jobId: string | undefined;
    try {
      const { readZip } = await import("../lib/zip.ts");
      const meta = (await readZip(dest)).get("meta.json");
      const fromZip = meta ? (JSON.parse(meta.toString("utf8")) as { job?: string }).job : undefined;
      if (fromZip && /^[\w-]+$/.test(fromZip) && (await exists(path.join(jobDir(fromZip), "job.json")))) jobId = fromZip;
    } catch (err) {
      return say(chatId, `✖ архив не читается: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
    const c = chat(chatId);
    if (!jobId && c.avatar_job && (await exists(path.join(jobDir(c.avatar_job), "job.json")))) jobId = c.avatar_job;
    if (!jobId) return say(chatId, MSG.avatarNoJob);
    const instruction = m.caption?.trim() || undefined;
    const runPreset = (instruction ? styleFromText(instruction) : undefined) ?? c.style ?? "split_news";
    await updateChat(chatId, { jobId, avatar_job: jobId, ...(instruction ? { prompt: instruction } : {}) });
    await say(chatId, MSG.avatarImportStart(jobId));
    const id = jobId;
    launch(chatId, "avatar", (r) => avatarImportFn({ jobId: id, result: dest, instruction, preset: runPreset, progress: progressFor(chatId, r), signal: r.ac.signal, log: (l) => log(`[${chatId}] ${l}`) }));
  }

  /** a photo (or an image file) / a voice note (or an audio file) for the next /avatar */
  async function onAvatarMedia(m: TgMessage, kind: "photo" | "voice", f: { file_id: string; file_size?: number }, ext: string) {
    const chatId = m.chat.id;
    if (f.file_size !== undefined && f.file_size > api.limits.downloadBytes) return say(chatId, tooLarge(f.file_size, api.limits));
    const file = await api.getFile(f.file_id);
    const dest = path.join(botDir, String(chatId), `avatar_${kind}_${safeName(f.file_id).slice(-24)}${ext}`);
    if (!(await exists(dest))) await api.download(file, dest);
    await updateChat(chatId, kind === "photo" ? { avatar_photo: dest } : { avatar_voice: dest });
    log(`[${chatId}] ${kind} для аватара: ${dest}`);
    const caption = m.caption?.trim();
    const cmd = caption ? /^\/avatar(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(caption) : null;
    if (cmd) {
      if (running.has(chatId)) return say(chatId, MSG.busy);
      return startAvatar(chatId, (cmd[1] ?? "").trim());
    }
    return say(chatId, kind === "photo" ? MSG.avatarPhotoSaved : MSG.avatarVoiceSaved);
  }

  /** /voice [id|off]: list, choose (with a sample for local voices) or turn off the voiceover */
  async function voiceCommand(chatId: number, arg: string) {
    const c = chat(chatId);
    if (!arg) return say(chatId, MSG.voiceList(c.voice));
    if (NO_VOICE.test(arg)) {
      await updateChat(chatId, { voice: undefined });
      return say(chatId, MSG.voiceOff);
    }
    const v = getVoice(arg);
    if (!v) return say(chatId, MSG.voiceUnknown(arg));
    await updateChat(chatId, { voice: v.id });
    await say(chatId, MSG.voiceSet(v));
    const src = piperVoiceFor(v);
    if (!src) return;
    // the sample is synthesised in the background (first use downloads the voice, ~60 MB)
    const task = (async () => {
      try {
        await action(chatId, "upload_voice");
        const dest = path.join(botDir, "_voices", `${src.id}.ogg`);
        const file = (await exists(dest)) ? dest : await voiceSampleFn(src.id, dest);
        await api.sendVoice(chatId, file, `проба: ${src.id}${src.id !== v.id ? ` (тембр для ${v.id})` : ""}`);
      } catch (err) {
        log(`[${chatId}] проба голоса ${v.id}: ${err instanceof Error ? err.message : err}`);
        await say(chatId, `Пробу голоса прислать не получилось (${err instanceof Error ? err.message.split("\n")[0] : err}), но голос выбран.`);
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  }

  async function status(chatId: number) {
    const c = chat(chatId);
    const r = running.get(chatId);
    const lines: string[] = [];
    if (r) lines.push(`Сейчас: ${r.kind === "run" ? "монтаж" : r.kind === "make" ? "ролик по теме" : r.kind === "avatar" ? "аватар" : "правка"}, шаг «${r.stage}», ${((Date.now() - r.startedAt) / 1000).toFixed(0)} с${r.ac.signal.aborted ? " (отменяется)" : ""}`);
    if (c.source) lines.push(`Видео: ${path.basename(c.source)}`);
    if (c.prompt) lines.push(`Задача: ${excerpt(c.prompt, 200)}`);
    if (c.jobId) {
      try {
        const job = await loadJob(c.jobId);
        lines.push(`job ${job.id} (создана ${job.created_at.slice(0, 16).replace("T", " ")})`);
        for (const [step, s] of Object.entries(job.steps)) {
          const took = s.started_at && s.finished_at ? ` ${((+new Date(s.finished_at) - +new Date(s.started_at)) / 1000).toFixed(0)} с` : "";
          lines.push(`  ${step}: ${s.status}${took}${s.error ? ` — ${s.error.split("\n")[0].slice(0, 200)}` : ""}`);
        }
        const outs = (await fs.readdir(jobDir(job.id)).catch(() => [] as string[])).filter((f) => /^output_.+\.mp4$/.test(f));
        if (outs.length) lines.push(`готовые файлы: ${outs.join(", ")}`);
      } catch {
        lines.push(`job ${c.jobId}: не найдена в workspace`);
      }
    }
    await say(chatId, lines.length ? lines.join("\n") : MSG.noJob);
  }

  async function onVideo(m: TgMessage, v: { fileId: string; size?: number }) {
    const chatId = m.chat.id;
    if (v.size !== undefined && v.size > api.limits.downloadBytes) {
      await say(chatId, tooLarge(v.size, api.limits));
      return;
    }
    await action(chatId, "typing");
    const file = await api.getFile(v.fileId);
    if (file.file_size !== undefined && file.file_size > api.limits.downloadBytes) {
      await say(chatId, tooLarge(file.file_size, api.limits));
      return;
    }
    const dest = path.join(botDir, String(chatId), `${safeName(v.fileId)}.mp4`);
    if (!(await exists(dest))) await api.download(file, dest);
    const c = chat(chatId);
    const batch = c.batch_closed ? [dest] : [...(c.sources ?? []).filter((f) => f !== dest), dest];
    await updateChat(chatId, { source: dest, sources: batch, batch_closed: false });
    log(`[${chatId}] видео сохранено: ${dest} (в подборке ${batch.length})`);
    const caption = m.caption?.trim();
    const group = m.media_group_id;
    if (group) {
      // an album arrives as separate messages: act once, after the last one
      const g = albums.get(group) ?? { caption: undefined as string | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined };
      if (caption) g.caption = caption;
      if (g.timer) clearTimeout(g.timer);
      g.timer = setTimeout(() => {
        albums.delete(group);
        const task = (async () => {
          if (g.caption && !g.caption.startsWith("/")) {
            if (running.has(chatId)) await say(chatId, MSG.busy);
            else await startRun(chatId, g.caption);
          } else if (g.caption && /^\/viral\b/i.test(g.caption)) {
            if (running.has(chatId)) await say(chatId, MSG.busy);
            else await startRun(chatId, MSG.viral);
          } else await say(chatId, MSG.batchSaved(chat(chatId).sources.length));
        })();
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }, albumDelayMs);
      albums.set(group, g);
      return;
    }
    if (caption && !caption.startsWith("/")) {
      // video sent with a caption = video + instruction in one message
      if (running.has(chatId)) await say(chatId, MSG.busy);
      else await startRun(chatId, caption);
    } else if (caption && /^\/viral\b/i.test(caption)) {
      if (running.has(chatId)) await say(chatId, MSG.busy);
      else await startRun(chatId, MSG.viral);
    } else if (running.has(chatId)) await say(chatId, `Видео сохранено. ${MSG.busy}`);
    else await say(chatId, batch.length > 1 ? MSG.batchSaved(batch.length) : MSG.videoSaved);
  }

  async function handleMessage(m: TgMessage) {
    const chatId = m.chat.id;
    const video = isVideoMessage(m);
    if (video) return onVideo(m, video);
    if (m.document && isAvatarResult(m.document.file_name)) return onAvatarResult(m, m.document);
    if (m.photo?.length) return onAvatarMedia(m, "photo", m.photo[m.photo.length - 1], ".jpg");
    if (m.document?.mime_type?.startsWith("image/")) return onAvatarMedia(m, "photo", m.document, path.extname(m.document.file_name ?? "") || ".jpg");
    if (m.voice) return onAvatarMedia(m, "voice", m.voice, ".ogg");
    if (m.audio) return onAvatarMedia(m, "voice", m.audio, path.extname(m.audio.file_name ?? "") || ".mp3");
    if (m.document) return say(chatId, MSG.notVideo);
    const text = m.text?.trim();
    if (!text) return;

    const cmd = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
    if (cmd) {
      const name = cmd[1].toLowerCase();
      const arg = (cmd[2] ?? "").trim();
      switch (name) {
        case "start":
        case "help":
          return say(chatId, MSG.help);
        case "status":
          return status(chatId);
        case "cancel": {
          const r = running.get(chatId);
          if (!r) return say(chatId, MSG.nothingToCancel);
          r.ac.abort();
          return say(chatId, MSG.cancelling);
        }
        case "revise":
          if (running.has(chatId)) return say(chatId, MSG.busy);
          return startRevise(chatId, arg);
        case "make":
          if (running.has(chatId)) return say(chatId, MSG.busy);
          return startMake(chatId, arg);
        case "avatar":
          if (running.has(chatId) && !/^(сброс|reset|clear)$/i.test(arg)) return say(chatId, MSG.busy);
          return startAvatar(chatId, arg);
        case "viral":
          if (running.has(chatId)) return say(chatId, MSG.busy);
          return startRun(chatId, arg ? `${MSG.viral} Дополнительно: ${arg}` : MSG.viral);
        case "style": {
          const want = STYLES[arg.trim().toLowerCase()];
          if (!want) return say(chatId, MSG.styleUsage(chat(chatId).style ?? preset));
          await updateChat(chatId, { style: want });
          return say(chatId, `Стиль: ${want}. Следующий монтаж будет в нём.`);
        }
        case "clear":
          await updateChat(chatId, { sources: [], batch_closed: false });
          return say(chatId, MSG.cleared);
        case "voice":
        case "voices":
          return voiceCommand(chatId, arg);
        case "send": {
          const want = SEND_MODES[arg.trim().toLowerCase()];
          if (!want) return say(chatId, MSG.sendUsage(chat(chatId).send ?? "file"));
          await updateChat(chatId, { send: want });
          return say(chatId, MSG.sendSet(want));
        }
        default:
          return say(chatId, MSG.unknownCommand);
      }
    }
    if (running.has(chatId)) return say(chatId, MSG.busy);
    return startRun(chatId, text);
  }

  async function handleUpdate(update: TgUpdate) {
    const m = update.message;
    if (!m) return;
    try {
      const from = m.from?.id;
      if (allowed && (from === undefined || !allowed.has(from))) {
        log(`[${m.chat.id}] пропущено: пользователь ${from ?? "?"} не в TELEGRAM_ALLOWED_USERS`);
        return;
      }
      await handleMessage(m);
    } catch (err) {
      log(`[${m.chat.id}] ошибка обработки update ${update.update_id}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
      await say(m.chat.id, errorText(err));
    }
  }

  return {
    api,
    get state() {
      return state;
    },
    botDir,
    handleUpdate,
    isBusy: (chatId) => running.has(chatId),
    save: async () => {
      await saveState();
    },
    async idle() {
      while (tasks.size) await Promise.allSettled([...tasks]);
      await saving;
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

/** Long-polling loop. Never throws: getUpdates failures back off, each update is handled in try/catch. */
export async function startBot(o: BotOptions): Promise<RunningBot> {
  const log = o.onLog ?? ((l: string) => console.log(l));
  const bot = await createBot(o);
  const ac = new AbortController();
  const timeout = o.pollTimeout ?? 30;
  const retryDelay = o.retryDelayMs ?? 3000;
  let offset = bot.state.offset ?? 0;

  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(resolve, ms);
      ac.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });

  const done = (async () => {
    log(`бот запущен; рабочая папка ${bot.botDir}`);
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
      if (updates.length && bot.state.offset !== offset) {
        bot.state.offset = offset;
        await bot.save();
      }
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
