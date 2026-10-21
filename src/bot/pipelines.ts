// Pipelines the bot runs: montage (runFullPipeline), highlights, revise, make-from-topic, avatar bundle/montage.
// The bot calls them directly (no CLI subprocess); tests inject fakes through BotOptions.
import path from "node:path";
import { createJob, exists, jobDir, loadJob, readJson, runStep, writeJson } from "../lib/workspace.ts";
import { PlanError } from "../plan/backend/types.ts";
import { MediaSchema, TranscriptSchema, type Edl, type Transcript } from "../schemas/index.ts";
import type { Aspect } from "../lib/aspect.ts";
import { STRINGS } from "./i18n.ts";
import { NoHighlightsError } from "../highlights/index.ts";

/** what the planner gets when "highlights" footage turns out to have no game moments (someone talking, etc.) */
export const SPEECH_FALLBACK_INSTRUCTION =
  "Смонтируй один ролик 30–60 секунд из самых сильных моментов речи: хук в первые 2 секунды, каждый клип — законченная фраза, динамичный темп, финал с законченной мыслью. Субтитры на языке речи.";

// same hints as src/cli.ts (cli.ts runs commander on import, so the table is duplicated here)
export const HINTS: Partial<Record<PlanError["code"], string>> = {
  no_backend: "варианты: GEMINI_API_KEY в .env (бэкенд gemini, достаточно его одного) · ANTHROPIC_API_KEY (бэкенд api) · `claude /login` (бэкенд agent по подписке) · готовый план: vedit cut <job> --edl <file>",
  auth: "проверьте ключ/вход: ANTHROPIC_API_KEY / GEMINI_API_KEY в .env или `claude /login`",
  refusal: "модель отказалась; переформулируйте инструкцию или выберите другой фрагмент",
  budget: "поднимите лимит: --budget <usd> (по умолчанию 1.50) или упростите инструкцию",
  invalid: "если модель вернула черновик, он сохранён как edl.draft.json — исправьте вручную и запустите vedit cut <job> --edl <file>; иначе уточните инструкцию",
  loop: "лимит запросов исчерпан; попробуйте --effort high или более конкретную инструкцию",
  nothing_to_plan: "запустите понимание видео: vedit understand <job> (или уберите --skip-understand)",
  missing_inputs: "сначала vedit run <video> или vedit ingest + vedit understand",
  model: "проверьте --model (по умолчанию claude-opus-5-5; для gemini — VEDIT_GEMINI_PLANNER_MODEL, по умолчанию gemini-3.8-flash) и доступ к модели",
};

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
  /** avatar bundle: the bot shows the Colab instructions in the user's language */
  avatar?: { lines: string[]; warnings: string[] };
  /** a short name for the files sent (make topic / title); default: the job id */
  title?: string;
  failed?: { id: string; error: string }[];
  reasoning?: string;
  notes?: string[];
  /** stage 30: «📎 Источник: …» of a video from someone else's platform, shown in the delivered message */
  credit?: string;
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
  /** «🎯 Монтаж как в примере»: the reference's style profile (workspace/_cache/style/<key>.json) */
  like?: string;
  /** the analysis behind `like` was just made for this run: its Gemini cost goes into this job */
  likeFresh?: boolean;
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
  /** reuse the script of an earlier make job (📐 another format: same script, new frame) */
  fromJob?: string;
  /** stage 31: "promo" — product promo / explainer in the clean UI format */
  format?: "reel" | "promo";
  progress: (text: string) => Promise<void>;
  onJob: (jobId: string) => void;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type MakeFn = (args: MakeArgs) => Promise<PipelineResult>;

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
    message: STRINGS.ru.avatarInstructions(r.jobId, r.state.lines, r.warnings),
    avatar: { lines: r.state.lines, warnings: r.warnings },
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
export const runMakePipeline: MakeFn = async ({ topic, voice, aspect, fromJob, format, progress, onJob, signal, log }) => {
  const { make, creditsText } = await import("../make/index.ts");
  const r = await make(topic, {
    signal,
    voice,
    aspect,
    fromJob,
    format,
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

export class CancelledError extends Error {
  constructor() {
    super("отменено");
    this.name = "CancelledError";
  }
}
export function checkCancel(signal: AbortSignal) {
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
  let current = "";
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
        if (m) {
          current = m[1];
          pending.push(progress(`▸ рендер ${m[1]} (${++i}/${ids.length})…`));
        }
        // HyperFrames progress ("    capture 50%", in 25 % steps) → "▸ рендер reel_1 (1/3) 50%…" for the status card
        const pct = /^\s+\S+ (\d{1,3})%$/.exec(line);
        if (pct && current) pending.push(progress(`▸ рендер ${current} (${i}/${ids.length}) ${pct[1]}%…`));
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
export const runFullPipeline: PipelineFn = async ({ source, sources, instruction, preset, progress, onJob, signal, log, like, likeFresh }) => {
  const { ingest } = await import("../ingest/index.ts");
  const { understand } = await import("../understand/index.ts");
  const { plan } = await import("../plan/index.ts");
  const { cut } = await import("../cut/index.ts");

  const many = (sources ?? []).length > 1;
  // sports / action footage ("как мы играем в баскет", "броски", "трюки"): highlights mode, no speech plan
  const { highlightsIntent, wantsHighlights } = await import("../highlights/intent.ts");
  // a reference style is a speech montage: never highlights; several videos: only an explicit highlights request (🏀 on the card)
  const asked = like ? null : highlightsIntent(instruction);
  const intent = many && asked !== "strong" ? null : asked;
  const style = like ? await readJson(like, (await import("../style/profile.ts")).StyleProfileSchema) : null;
  if (intent === "strong") {
    try {
      return await runHighlightsBot({ source, sources: many ? sources : undefined, instruction, progress, onJob, signal, log });
    } catch (err) {
      if (!(err instanceof NoHighlightsError)) throw err;
      // talking-head or other non-game footage sent as "highlights": make a normal montage instead of failing
      log(`  ${err.message} — обычный монтаж`);
      await progress("▸ игровых моментов не нашлось — делаю обычный монтаж по речи…");
      instruction = SPEECH_FALLBACK_INSTRUCTION;
    }
  }
  const job = await createJob(many ? `combined:${sources!.length} videos` : source, { prompt: instruction, preset });
  onJob(job.id);
  log(`job ${job.id}`);
  if (style) {
    await (await import("../style/profile.ts")).attachStyle(job.id, style, !likeFresh);
    log(`  стиль примера: ${style.dna.style_summary}`);
  }

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
  const u = await runStep(job.id, "understand", () => understand(job.id, media, { hint: instruction, onLog: (l) => log(`    ${l}`) }));
  checkCancel(signal);
  // "лучшие моменты" of a video that is mostly not speech → highlights on the same job
  if (intent === "weak") {
    const spoken = u.transcript.segments.reduce((s, seg) => s + seg.words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0), 0);
    if (wantsHighlights(intent, spoken / Math.max(1, media.duration))) {
      try {
        return await runHighlightsBot({ source, instruction, progress, onJob, signal, log, jobId: job.id, media });
      } catch (err) {
        if (!(err instanceof NoHighlightsError)) throw err;
        log(`  ${err.message} — обычный монтаж`);
        await progress("▸ игровых моментов не нашлось — делаю обычный монтаж по речи…");
      }
    }
  }

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
  const credits = await photoCredits(job.id, rendered.outputs);
  return { jobId: job.id, outputs: rendered.outputs, failed: [...failed, ...rendered.failed], reasoning: `${edl.reasoning}${credits ? `
${credits}` : ""}`, notes: p.report.warnings.slice(0, 3) };
};

/** Highlights for sports footage: events (Gemini) → best moments → slow motion, punch-ins, music on the beat. */
async function runHighlightsBot(a: Pick<PipelineArgs, "source" | "sources" | "instruction" | "progress" | "onJob" | "signal" | "log"> & { jobId?: string; media?: import("../schemas/index.ts").Media }): Promise<PipelineResult> {
  const { ingestLight } = await import("../ingest/index.ts");
  const { planHighlights } = await import("../highlights/index.ts");
  const { cut } = await import("../cut/index.ts");
  const { selectStructuredLlm } = await import("../lib/llm.ts");
  const { updateJobPreset } = await import("../highlights/job.ts");
  let jobId = a.jobId;
  let media = a.media;
  if (!jobId || !media) {
    const many = (a.sources ?? []).length > 1;
    const job = await createJob(many ? `combined:${a.sources!.length} videos` : a.source, { prompt: a.instruction, preset: "sport_highlights" });
    jobId = job.id;
    a.onJob(jobId);
    a.log(`job ${jobId} (highlights)`);
    let input = a.source;
    if (many) {
      // several game videos (🏀 on a batch): one combined source, so every video is searched for moments
      const { combineSources, SourcesSchema } = await import("../ingest/combine.ts");
      await a.progress(`▸ склеиваю ${a.sources!.length} видео в один материал…`);
      input = path.join(jobDir(jobId), "combined.mp4");
      await writeJson(path.join(jobDir(jobId), "sources.json"), SourcesSchema, await combineSources(a.sources!, input));
      checkCancel(a.signal);
    }
    await a.progress("▸ подготовка видео…");
    media = await runStep(jobId, "ingest", () => ingestLight(jobId!, input));
  } else await updateJobPreset(jobId, "sport_highlights");
  checkCancel(a.signal);
  await a.progress(`▸ ищу броски и лучшие моменты… (${Math.round(media.duration / 60)} мин видео)`);
  let llm = null;
  try {
    llm = selectStructuredLlm();
  } catch {}
  // "по отдельности", "на каждого игрока": one reel per person, all sent
  const { perPersonIntent } = await import("../highlights/intent.ts");
  if (perPersonIntent(a.instruction)) {
    const { planPerPerson } = await import("../highlights/perperson.ts");
    await a.progress("▸ разбираю, кто бросал: отдельный ролик на каждого игрока…");
    const pp = await runStep(jobId, "plan", () => planPerPerson(jobId!, media!, { instruction: a.instruction, llm, onLog: (l) => a.log(`  ${l}`) }));
    await a.progress(`▸ роликов: ${pp.report.reels.length} — ${pp.report.reels.map((x) => `«${x.title}» (${x.makes_in_reel} попаданий, ${x.duration.toFixed(0)} с)`).join("; ")}`);
    checkCancel(a.signal);
    const cr = await runStep(jobId, "cut", () => cut(jobId!, pp.edl, media!, { snap: false }));
    const failedPP = cr.outputs.filter((o) => o.status !== "ok").map((o) => ({ id: o.id, error: o.error ?? "ошибка нарезки" }));
    const okPP = cr.outputs.filter((o) => o.status === "ok").map((o) => o.id);
    const rendered = okPP.length ? await renderIds(jobId, okPP, pp.edl, a.progress, a.log) : { outputs: [], failed: [] };
    const credits = [...new Set(pp.report.reels.map((x) => x.music_attribution).filter(Boolean))].join("\n");
    return { jobId, outputs: rendered.outputs, failed: [...failedPP, ...rendered.failed], reasoning: `${pp.edl.reasoning}${credits ? `\n${credits}` : ""}`, notes: pp.report.notes.slice(0, 3) };
  }
  const r = await runStep(jobId, "plan", () => planHighlights(jobId!, media!, { instruction: a.instruction, llm, onLog: (l) => a.log(`  ${l}`) }));
  const e = r.report.events;
  await a.progress(`▸ попаданий ${e.makes} из ${e.shots} бросков; в ролике ${r.report.timeline.length} момент(ов), ${r.report.duration.toFixed(0)} с${r.report.music ? `, музыка «${r.report.music.title}»` : ""}`);
  checkCancel(a.signal);
  await a.progress("▸ нарезка: замедления и наезды…");
  const cr = await runStep(jobId, "cut", () => cut(jobId!, r.edl, media!, { snap: false }));
  const failed = cr.outputs.filter((o) => o.status !== "ok").map((o) => ({ id: o.id, error: o.error ?? "ошибка нарезки" }));
  checkCancel(a.signal);
  const ok = cr.outputs.filter((o) => o.status === "ok").map((o) => o.id);
  const rendered = ok.length ? await renderIds(jobId, ok, r.edl, a.progress, a.log) : { outputs: [], failed: [] };
  const credit = r.report.music?.attribution ? `\n${r.report.music.attribution}` : "";
  return { jobId, outputs: rendered.outputs, failed: [...failed, ...rendered.failed], reasoning: `${r.edl.reasoning}${credit}`, notes: r.report.notes.slice(0, 3) };
}

/** attribution of real photos on split panels (empty when there are none) */
async function photoCredits(jobId: string, outputs: { id: string }[]): Promise<string> {
  try {
    const { panelCreditsText } = await import("../design/export.ts");
    return await panelCreditsText(jobId, outputs.map((o) => o.id));
  } catch {
    return "";
  }
}

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
  const credits = await photoCredits(jobId, rendered.outputs);
  return { jobId, outputs: rendered.outputs, failed: [...failed, ...rendered.failed], reasoning: `${r.edl.reasoning}${credits ? `
${credits}` : ""}` };
};

export const excerpt = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

// ── stage 30: dubbing («🌐 Русская версия») and an avatar from someone else's video ──

export interface DubArgs {
  /** the video to dub (an upload or a downloaded link) */
  source: string;
  lang: string;
  voice?: string;
  mode?: "voiceover" | "replace";
  progress: (text: string) => Promise<void>;
  onJob: (jobId: string) => void;
  signal: AbortSignal;
  log: (line: string) => void;
}
export type DubFn = (args: DubArgs) => Promise<PipelineResult>;

export interface DubOutputsArgs {
  jobId: string;
  outputs: PipelineOutput[];
  lang: string;
  voice?: string;
  progress: (text: string) => Promise<void>;
  signal: AbortSignal;
  log: (line: string) => void;
}
/** dubs the reels of a finished montage: their dubbed copies + a summary line */
export type DubOutputsFn = (args: DubOutputsArgs) => Promise<{ outputs: PipelineOutput[]; summary: string; notes: string[] }>;

export interface AvatarFromVideoArgs extends Omit<AvatarExportArgs, "input"> {
  /** the video whose speech becomes the (retold) script */
  video: string;
}
export type AvatarFromVideoFn = (args: AvatarFromVideoArgs) => Promise<PipelineResult>;

const dubEvents = (progress: (t: string) => Promise<void>, log: (l: string) => void, onJob?: (id: string) => void) => (l: string) => {
  if (/^job /.test(l)) onJob?.(l.slice(4).trim());
  else if (/^▸/.test(l)) void progress(l);
  else log(`  ${l.trim()}`);
};

/** A whole video → its dubbed copy (voice-over), captions as a soft track and an .srt document. */
export const runDubPipeline: DubFn = async ({ source, lang, voice, mode, progress, onJob, signal, log }) => {
  const { dubVideo, dubSummary } = await import("../dub/index.ts");
  const r = await dubVideo(source, { lang, voice, mode, signal, onEvent: dubEvents(progress, log, onJob) });
  return {
    jobId: r.jobId,
    title: `${path.basename(source).replace(/\.[^.]+$/, "")}_${lang}`,
    outputs: [{ id: `dub_${lang}`, file: r.out, duration: r.report.duration }],
    documents: r.srt ? [{ file: r.srt, caption: `${r.report.label} · субтитры ${lang}` }] : [],
    reasoning: dubSummary(r.report),
    notes: r.report.warnings.slice(0, 3),
  };
};

/** The reels of a montage → output_<id>_<lang>.mp4 each (phrases from the plan, the captions' translation cache shared). */
export const runDubOutputs: DubOutputsFn = async ({ jobId, outputs, lang, voice, progress, signal, log }) => {
  const { dubJobOutputs, dubSummary } = await import("../dub/index.ts");
  const rs = await dubJobOutputs(jobId, { lang, voice, signal, outputs: outputs.map((o) => ({ id: o.id, file: o.file })), onEvent: dubEvents(progress, log) });
  return {
    outputs: rs.map((r, k) => ({ id: `${outputs[k].id}_${lang}`, file: r.out, duration: outputs[k].duration, aspect: outputs[k].aspect })),
    summary: rs.length ? dubSummary(rs[0].report) : "",
    notes: rs.flatMap((r) => r.report.warnings).slice(0, 3),
  };
};

/** Someone else's video → its speech → retold in our own words (never copied verbatim) → an avatar bundle. */
export const runAvatarFromVideo: AvatarFromVideoFn = async (a) => {
  const fs = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { ffprobe } = await import("../lib/ffmpeg.ts");
  const { defaultAsr } = await import("../dub/index.ts");
  const dir = path.join(a.sourceLabel, "from_video", createHash("sha1").update(a.video).digest("hex").slice(0, 12));
  await fs.mkdir(dir, { recursive: true });
  await a.progress("▸ анализ речи видео…");
  const duration = Number((await ffprobe(a.video)).format.duration ?? 0);
  const t = await defaultAsr(a.video, dir, duration, { onEvent: (l) => a.log(`  ${l}`) });
  checkCancel(a.signal);
  const said = t.segments.map((s) => s.text.trim()).filter(Boolean).join(" ");
  if (said.length < 20) throw new Error("в видео не нашлось речи для сценария");
  const input = `тема: Перескажи своими словами главную мысль этого видео для короткого ролика — не дословно, без длинных цитат, от своего лица: «${excerpt(said, 3500)}»`;
  return runAvatarExport({ ...a, input });
};
