// Telegram bot — the first user interface (SPEC §6, stage 7): video → instruction → MP4s.
// Pipeline functions are called directly (no CLI subprocess); every update is isolated in try/catch.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createJob, exists, jobDir, loadJob, readJson, runStep, writeJson, WORKSPACE_ROOT } from "../lib/workspace.ts";
import { PlanError } from "../plan/backend/types.ts";
import { MediaSchema, TranscriptSchema, type Edl, type Transcript } from "../schemas/index.ts";
import { makeBotApi, TelegramError, type BotApi, type CallMethod, type DownloadFn, type Limits, type TgMessage, type TgUpdate } from "./telegram-api.ts";

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
    "/cancel — отменить текущую работу (после текущего шага)",
    "/start — эта справка",
  ].join("\n"),
  needVideo: "Сначала пришлите видео (как видео или файлом), потом напишите задачу.",
  busy: "ещё работаю над предыдущим — дождитесь результата или отправьте /cancel",
  videoSaved: "Видео получено. Теперь напишите задачу: что смонтировать (например, «2 рилса по 20 секунд с субтитрами»).",
  notVideo: "Это не похоже на видео. Пришлите ролик как видео или файлом с типом video/*.",
  noJob: "Пока нет задач. Пришлите видео и напишите задачу.",
  reviseUsage: "Напишите, что изменить: /revise в reel_1 убери приветствие",
  reviseNoJob: "Нечего править: сначала смонтируйте видео (пришлите видео и задачу).",
  nothingToCancel: "Сейчас ничего не выполняется.",
  cancelling: "Отменяю — остановлюсь после текущего шага.",
  cancelled: "Отменено.",
  start: "Принято, начинаю монтаж. Это займёт несколько минут.",
  reviseStart: "Принято, правлю монтаж.",
  unknownCommand: "Не знаю такой команды. /start — справка.",
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
  failed?: { id: string; error: string }[];
  reasoning?: string;
  notes?: string[];
}
export interface PipelineArgs {
  source: string;
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
export const runFullPipeline: PipelineFn = async ({ source, instruction, preset, progress, onJob, signal, log }) => {
  const { ingest } = await import("../ingest/index.ts");
  const { understand } = await import("../understand/index.ts");
  const { plan } = await import("../plan/index.ts");
  const { cut } = await import("../cut/index.ts");

  const job = await createJob(source, { prompt: instruction, preset });
  onJob(job.id);
  log(`job ${job.id}`);

  await progress("▸ подготовка видео…");
  const media = await runStep(job.id, "ingest", () => ingest(job.id, source));
  checkCancel(signal);

  await progress(`▸ анализ речи… (${media.duration.toFixed(0)} с видео)`);
  const u = await runStep(job.id, "understand", () => understand(job.id, media, {}));
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
  jobId: z.string().optional(),
  prompt: z.string().optional(),
  updated_at: z.string().optional(),
});
export const BotStateSchema = z.object({
  version: z.literal(1).default(1),
  offset: z.number().int().optional(),
  chats: z.record(z.string(), ChatStateSchema).default({}),
});
export type ChatState = z.infer<typeof ChatStateSchema>;
export type BotState = z.infer<typeof BotStateSchema>;

interface Running {
  kind: "run" | "revise";
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
  /** long-polling timeout, seconds (default 30) */
  pollTimeout?: number;
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

export async function createBot(o: BotOptions): Promise<Bot> {
  const log = o.onLog ?? ((l: string) => console.log(l));
  const api = o.api ?? makeBotApi(o.token, { callMethod: o.callMethod, download: o.download, apiBase: o.apiBase, limits: o.limits });
  const pipelineFn = o.pipeline ?? runFullPipeline;
  const reviseFn = o.revise ?? runRevisePipeline;
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
  const chat = (id: number): ChatState => (state.chats[String(id)] ??= {});
  const updateChat = async (id: number, patch: Partial<ChatState>) => {
    Object.assign(chat(id), patch, { updated_at: new Date().toISOString() });
    await saveState();
  };

  const running = new Map<number, Running>();
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
    for (const out of result.outputs) {
      const caption = videoCaption(out, result.reasoning);
      let size = 0;
      try {
        size = (await fs.stat(out.file)).size;
      } catch {
        await say(chatId, `✖ ${out.id}: файл не найден (${out.file})`);
        continue;
      }
      if (size > api.limits.uploadBytes) {
        await say(chatId, `${caption}\nФайл ${(size / 1024 / 1024).toFixed(0)} МБ больше лимита отправки ботом (${(api.limits.uploadBytes / 1024 / 1024).toFixed(0)} МБ) — он лежит на сервере: ${out.file}`);
        continue;
      }
      await action(chatId, "upload_video");
      try {
        await api.sendVideo(chatId, out.file, { caption, duration: out.duration });
      } catch (err) {
        log(`⚠ sendVideo ${out.id}: ${err instanceof Error ? err.message : err} — пробую документом`);
        try {
          await api.sendDocument(chatId, out.file, caption);
        } catch (err2) {
          await say(chatId, `${caption}\nНе удалось отправить файл (${err2 instanceof TelegramError ? err2.description : String(err2)}). Он лежит на сервере: ${out.file}`);
        }
      }
    }
    const lines: string[] = [];
    for (const f of result.failed ?? []) lines.push(`✖ ${f.id}: ${f.error.split("\n")[0]}`);
    for (const n of result.notes ?? []) lines.push(`⚠ ${n}`);
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
    await updateChat(chatId, { prompt: instruction });
    await say(chatId, MSG.start);
    launch(chatId, "run", (r) =>
      pipelineFn({
        source,
        instruction,
        preset,
        progress: progressFor(chatId, r),
        onJob: (jobId) => void updateChat(chatId, { jobId }),
        signal: r.ac.signal,
        log: (l) => log(`[${chatId}] ${l}`),
      }),
    );
  }

  async function startRevise(chatId: number, edit: string) {
    const jobId = chat(chatId).jobId;
    if (!edit) return say(chatId, MSG.reviseUsage);
    if (!jobId) return say(chatId, MSG.reviseNoJob);
    await say(chatId, MSG.reviseStart);
    launch(chatId, "revise", (r) => reviseFn({ jobId, edit, progress: progressFor(chatId, r), signal: r.ac.signal, log: (l) => log(`[${chatId}] ${l}`) }));
  }

  async function status(chatId: number) {
    const c = chat(chatId);
    const r = running.get(chatId);
    const lines: string[] = [];
    if (r) lines.push(`Сейчас: ${r.kind === "run" ? "монтаж" : "правка"}, шаг «${r.stage}», ${((Date.now() - r.startedAt) / 1000).toFixed(0)} с${r.ac.signal.aborted ? " (отменяется)" : ""}`);
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
    await updateChat(chatId, { source: dest });
    log(`[${chatId}] видео сохранено: ${dest}`);
    const caption = m.caption?.trim();
    if (caption && !caption.startsWith("/")) {
      // video sent with a caption = video + instruction in one message
      if (running.has(chatId)) await say(chatId, MSG.busy);
      else await startRun(chatId, caption);
    } else await say(chatId, running.has(chatId) ? `Видео сохранено. ${MSG.busy}` : MSG.videoSaved);
  }

  async function handleMessage(m: TgMessage) {
    const chatId = m.chat.id;
    const video = isVideoMessage(m);
    if (video) return onVideo(m, video);
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
