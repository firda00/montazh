import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import { ingest } from "./ingest/index.ts";
import { cut, loadScenes, type CutReport } from "./cut/index.ts";
import type { VisionChoice } from "./understand/vision/index.ts";
import type { AsrChoice } from "./understand/asr.ts";
import { understand, UnderstandReportSchema } from "./understand/index.ts";
import { plan, loadPlanInputs, type PlanOptions, type PlanResult } from "./plan/index.ts";
import { revise, type ReviseResult } from "./plan/revise.ts";
import { PlanError, selectBackend, DEFAULT_MODEL, type BackendChoice, type Effort } from "./plan/backend/index.ts";
import { renderOutputs, RenderReportSchema, type RenderReport } from "./render/index.ts";
import { HyperFramesRenderer } from "./render/hyperframes.ts";
import type { CutoutMode } from "./design/matte.ts";
import type { RenderQuality } from "./design/renderer.ts";
import { createJob, exists, jobDir, loadJob, readJson, runStep, writeJson } from "./lib/workspace.ts";
import { EdlSchema, MediaSchema, CostSchema, TranscriptSchema, HighlightsSchema, PlanReportSchema, ReviseReportSchema, type Edl, type Scenes, type Transcript, type PlanReport } from "./schemas/index.ts";

try {
  process.loadEnvFile(); // .env in cwd, optional
} catch {}

const program = new Command();
program.name("vedit").description("AI video editing agent — MVP").version("0.3.0");

const HINTS: Partial<Record<PlanError["code"], string>> = {
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

function fail(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n✖ ${err instanceof PlanError ? "plan: " : ""}${msg}`);
  if (err instanceof PlanError && HINTS[err.code]) console.error(`  → ${HINTS[err.code]}`);
  process.exit(1);
}

function printCutReport(report: CutReport) {
  for (const o of report.outputs) {
    if (o.status === "ok") {
      console.log(`  ✔ ${o.id}: ${o.duration?.toFixed(2)}s (план ${o.expected_duration.toFixed(2)}s) → ${o.path}`);
    } else {
      console.log(`  ✖ ${o.id}: ${o.error}`);
    }
    for (const w of o.warnings) console.log(`    ⚠ ${w}`);
  }
}

function printUnderstand(r: Awaited<ReturnType<typeof understand>>) {
  if (r.transcriber) {
    const langs = r.transcriber.languages.length > 1 ? ` [${r.transcriber.languages.join(", ")}]` : "";
    console.log(`  речь: ${r.transcriber.language}${langs}, ${r.phrases} фраз, ${r.words} слов, ${r.transcriber.speech_chunks} чанк(ов) речи (${r.transcriber.engine} ${r.transcriber.model}, ${r.transcriber.method}, ${r.transcriber.wall_seconds.toFixed(1)}s)`);
  }
  if (r.speakers) console.log(`  говорящие: ${r.speakers.count} (${r.speakers.engine}, ${r.speakers.wall_seconds.toFixed(1)}s)`);
  console.log(`  сцены: ${r.shots} шотов, ${r.chunks.length} чанк(ов), ${r.vision.note}`);
  for (const h of r.highlights.slice(0, 3)) console.log(`  ★ ${h.score.toFixed(2)} ${h.start.toFixed(1)}–${h.end.toFixed(1)}s ${h.reason}`);
  for (const w of r.warnings) console.log(`  ⚠ ${w}`);
}

function costLine(r: PlanReport) {
  const usd = `${r.estimate ? "≈" : ""}$${r.usd.toFixed(3)}${r.priced ? "" : " (часть без цены)"}`;
  return `${r.calls} запрос(ов), ${r.repairs} исправлени${r.repairs === 1 ? "е" : "й"}, ${usd} (${r.backend}, ${r.model}, ${r.effort})`;
}

function printPlan(r: PlanResult | ReviseResult) {
  const rep = r.report;
  console.log(`  ${rep.backend_note}`);
  for (const o of rep.outputs) {
    const tgt = o.target_s ? `/${o.target_s}s` : "";
    const caps = o.captions_language ? `, субтитры ${o.captions_language}` : "";
    const mark = o.status === "ok" ? "✔" : o.status === "kept" ? "↺" : "✖";
    const tail = o.status === "dropped" ? " — отброшен" : o.status === "kept" ? " — правка не применена, оставлен прежний вариант" : "";
    console.log(`  ${mark} ${o.id} ${o.aspect} ${o.duration_s}s${tgt}, ${o.clips} клип(ов)${caps}${tail}`);
  }
  for (const i of rep.issues.filter((x) => x.severity === "warning")) console.log(`    ⚠ ${i.output ? `${i.output}: ` : ""}${i.message}`);
  for (const i of rep.issues.filter((x) => x.severity === "error")) console.log(`    ✖ ${i.output ? `${i.output}: ` : ""}${i.message}`);
  if (rep.tool_calls.length) console.log(`  инструменты: ${rep.tool_calls.map((t) => t.name).join(", ")}`);
  for (const w of rep.warnings) console.log(`  ⚠ ${w}`);
  console.log(`  ${costLine(rep)}`);
  const reasoning = (rep.draft as { reasoning?: string } | undefined)?.reasoning;
  if (reasoning) console.log(`  «${reasoning.slice(0, 300)}${reasoning.length > 300 ? "…" : ""}»`);
}

function printRenderReport(r: RenderReport) {
  for (const o of r.outputs) {
    if (o.status === "ok") {
      const caps = o.captions_language ? `, субтитры ${o.captions_language}${o.translated ? " (перевод)" : ""}` : "";
      console.log(`  ✔ ${o.id}: ${o.duration?.toFixed(2)}s, ${o.pages} стр. субтитров${caps}, ${o.loudness_after?.toFixed(1)} LUFS → ${o.output}`);
      console.log(`    сборка ${o.build_seconds?.toFixed(1)}s · рендер ${o.render_seconds?.toFixed(1)}s · финализация ${o.finalize_seconds?.toFixed(1)}s`);
    } else console.log(`  ${o.status === "skipped" ? "–" : "✖"} ${o.id}: ${o.error}`);
    for (const w of o.warnings) console.log(`    ⚠ ${w}`);
  }
  console.log(`  итого ${r.wall_seconds.toFixed(1)}s (${r.renderer}, ${r.quality})`);
}

interface RenderCliOpts {
  quality: RenderQuality;
  workers?: number;
  translate: boolean;
  renderer: string;
  bgMusic?: string;
  design?: string;
  cutout?: string;
}

function withRenderOptions(cmd: Command) {
  return cmd
    .option("--quality <q>", "draft | looks | delivery", "looks")
    .option("--workers <n>", "воркеры Chrome (по умолчанию — по свободной памяти)", (v) => Number(v))
    .option("--no-translate", "не переводить субтитры на язык из плана")
    .option("--renderer <name>", "hyperframes (другие — после этапа 4)", "hyperframes")
    .option("--bg-music <m>", "музыка под речью: auto | upbeat|chill|… | файл | none (по умолчанию — из пресета)")
    .option("--design <preset>", "пресет оформления вместо пресета задачи (например split_news)")
    .option("--cutout <mode>", "сплит: вырезать фон спикера (MediaPipe) — on | off | auto (по умолчанию — из пресета)");
}

function makeRenderer(o: RenderCliOpts) {
  if (o.renderer !== "hyperframes") throw new Error(`рендерер "${o.renderer}" не подключён; доступен: hyperframes`);
  if (!["draft", "looks", "delivery"].includes(o.quality)) throw new Error("--quality: ожидается draft | looks | delivery");
  if (o.cutout !== undefined && !["on", "off", "auto"].includes(o.cutout)) throw new Error("--cutout: ожидается on | off | auto");
  return new HyperFramesRenderer({ workers: o.workers });
}

async function runRender(jobId: string, o: RenderCliOpts & { only?: string[] }, edl?: Edl) {
  const renderer = makeRenderer(o);
  await renderer.prepare();
  const r = await runStep(jobId, "render", () => renderOutputs(jobId, { renderer, quality: o.quality, only: o.only, translate: o.translate, edl, music: o.bgMusic, preset: o.design, cutout: o.cutout as CutoutMode | undefined, onEvent: (l) => console.log(l) }));
  printRenderReport(r);
  return r;
}

async function stageEdl(jobId: string, edlPath: string): Promise<Edl> {
  const edl = await readJson(path.resolve(edlPath), EdlSchema);
  return writeJson(path.join(jobDir(jobId), "edl.json"), EdlSchema, edl);
}

async function loadTranscript(jobId: string): Promise<Transcript | undefined> {
  const file = path.join(jobDir(jobId), "transcript.json");
  return (await exists(file)) ? readJson(file, TranscriptSchema) : undefined;
}

interface PlannerCliOpts {
  backend: BackendChoice;
  model?: string;
  effort: Effort;
  budget?: number;
  maxRepairs?: number;
  tools: boolean;
  frames?: number;
  cacheTtl?: "5m" | "1h";
  contract?: "format" | "submit";
  verbose?: boolean;
  speaker?: string;
  long?: boolean;
  windows?: number;
}

function withPlannerOptions(cmd: Command) {
  return cmd
    .option("--backend <name>", "auto | api | agent | mock (env VEDIT_PLANNER)", (process.env.VEDIT_PLANNER as BackendChoice) || "auto")
    .option("--model <id>", `модель планировщика (по умолчанию ${DEFAULT_MODEL}, env VEDIT_PLANNER_MODEL)`)
    .option("--effort <level>", "low | medium | high | xhigh | max", "medium")
    .option("--budget <usd>", "лимит стоимости одного планирования", (v) => Number(v))
    .option("--max-repairs <n>", "сколько раз просить модель исправить план", (v) => Number(v))
    .option("--no-tools", "один structured-вызов без инструментов")
    .option("--frames <n>", "лимит превью-кадров", (v) => Number(v))
    .option("--cache-ttl <ttl>", "5m | 1h — TTL кэша промпта (бэкенд api)")
    .option("--contract <kind>", "format | submit — способ получить план от модели")
    .option("--speaker <who>", "резать только этого человека: S1 | S2 | время (12:34) | most")
    .option("--long", "режим длинного видео: сначала отобрать окна-кандидаты (по умолчанию — по размеру)")
    .option("--no-long", "никогда не отбирать окна, планировать по всему видео")
    .option("--windows <n>", "сколько окон отобрать в режиме длинного видео", (v) => Number(v))
    .option("--verbose", "печатать вызовы инструментов");
}

const BACKENDS = ["auto", "api", "agent", "mock"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function plannerOpts(o: PlannerCliOpts): Omit<PlanOptions, "instruction"> {
  if (!BACKENDS.includes(o.backend)) throw new Error(`--backend: ожидается ${BACKENDS.join(" | ")}, получено "${o.backend}"`);
  if (!EFFORTS.includes(o.effort)) throw new Error(`--effort: ожидается ${EFFORTS.join(" | ")}, получено "${o.effort}"`);
  if (o.contract !== undefined && !["format", "submit"].includes(o.contract)) throw new Error(`--contract: ожидается format | submit`);
  if (o.cacheTtl !== undefined && !["5m", "1h"].includes(o.cacheTtl)) throw new Error(`--cache-ttl: ожидается 5m | 1h`);
  if (o.windows !== undefined && (!Number.isInteger(o.windows) || o.windows < 1)) throw new Error(`--windows: ожидается целое число ≥ 1`);
  for (const [name, v] of [["--budget", o.budget], ["--max-repairs", o.maxRepairs], ["--frames", o.frames]] as const) {
    if (v !== undefined && !(Number.isFinite(v) && v >= 0)) throw new Error(`${name}: ожидается неотрицательное число`);
  }
  return {
    speaker: o.speaker,
    long: o.long,
    maxWindows: o.windows,
    backend: o.backend,
    model: o.model,
    effort: o.effort,
    budget: { ...(o.budget !== undefined ? { maxUsd: o.budget } : {}), ...(o.maxRepairs !== undefined ? { maxRepairs: o.maxRepairs } : {}), ...(o.frames !== undefined ? { frameBudget: o.frames } : {}) },
    tools: o.tools,
    contract: o.contract,
    cacheTtl: o.cacheTtl,
    verbose: o.verbose,
    onEvent: (line) => console.log(line.startsWith("  ") ? line : `  ${line}`),
  };
}

withRenderOptions(
  withPlannerOptions(
    program
      .command("run")
      .description("полный пайплайн: ingest → understand → plan → cut → render")
      .argument("<video>", "путь к исходному видео")
      .option("-p, --prompt <text>", "инструкция по монтажу (агент-планировщик)")
      .option("--preset <name>", "пресет стиля", "bold_pop")
      .option("-e, --edl <file>", "готовый edl.json вместо планировщика")
      .option("--skip-understand", "не запускать транскрипцию и анализ сцен")
      .option("--no-snap", "не подтягивать границы клипов к границам слов")
      .option("--no-render", "остановиться после черновой нарезки")
      .option("--language <code>", "язык речи для whisper (по умолчанию auto)")
      .option("--vision <provider>", "stub | auto | gemini | agy", "auto")
      .option("--asr <engine>", "auto | cpp | faster | import — движок распознавания речи (import = из vedit asr-import, env VEDIT_ASR)", "auto")
      .option("--no-diarize", "не размечать говорящих")
      .option("--speakers <n>", "сколько говорящих ожидать (по умолчанию определяется)", (v) => Number(v))
      .option("--mode <m>", "auto | highlights | normal — highlights: нарезка спорта/экшена без речи (auto — по инструкции)", "auto")
      .option("--target <s>", "highlights: длина ролика, с", (v) => Number(v))
      .option("--no-editor", "highlights: без вызова Claude (титр и порядок по правилам)"),
  ),
).action(async (video: string, opts: { prompt?: string; preset: string; edl?: string; skipUnderstand?: boolean; snap: boolean; render: boolean; language?: string; vision: VisionChoice; asr: AsrChoice; diarize: boolean; speakers?: number; mode: string; target?: number; editor: boolean } & PlannerCliOpts & RenderCliOpts) => {
  try {
    if (!["auto", "highlights", "normal"].includes(opts.mode)) throw new Error("--mode: ожидается auto | highlights | normal");
    if (!opts.edl && opts.mode !== "normal") {
      const { highlightsIntent, wantsHighlights } = await import("./highlights/intent.ts");
      const intent = opts.mode === "highlights" ? "strong" : highlightsIntent(opts.prompt);
      let ratio: number | null = null;
      if (intent === "weak") {
        console.log("▸ инструкция похожа на хайлайты — проверяю, есть ли в видео речь…");
        const { speechRatioProbe } = await import("./highlights/index.ts");
        const { ffprobe } = await import("./lib/ffmpeg.ts");
        const os = await import("node:os");
        ratio = await speechRatioProbe(video, Number((await ffprobe(video)).format.duration), path.join(os.tmpdir(), `vedit-probe-${process.pid}`));
        console.log(`  речь ≈ ${Math.round(ratio * 100)} % звука`);
      }
      if (wantsHighlights(intent, ratio)) {
        await runHighlightsCli(video, opts);
        return;
      }
    }
    if (opts.edl) await readJson(path.resolve(opts.edl), EdlSchema); // validate the plan before spending time on ingest
    if (opts.prompt && opts.skipUnderstand) throw new PlanError("--skip-understand вместе с --prompt: планировать не по чему (нет фраз и сцен)", "nothing_to_plan");
    const planner = opts.prompt ? plannerOpts(opts) : null; // option errors surface before ingest/understand run
    const job = await createJob(video, { prompt: opts.prompt, preset: opts.preset });
    console.log(`job ${job.id}`);
    const t0 = Date.now();

    console.log("▸ ingest");
    const media = await runStep(job.id, "ingest", () => ingest(job.id, video));
    console.log(`  ${media.width}x${media.height} @ ${media.fps}fps, ${media.duration.toFixed(2)}s, audio: ${media.has_audio}`);

    let transcript: Transcript | undefined;
    let scenes: Scenes | undefined;
    if (!opts.skipUnderstand) {
      console.log("▸ understand");
      const r = await runStep(job.id, "understand", () => understand(job.id, media, { language: opts.language, vision: opts.vision, asr: opts.asr, diarize: opts.diarize, numSpeakers: opts.speakers, onLog: (l) => console.log(`    ${l}`) }));
      printUnderstand(r);
      transcript = r.transcript;
      scenes = r.scenes;
    }

    let edl: Edl;
    if (opts.edl) {
      edl = await stageEdl(job.id, opts.edl);
      console.log(`▸ plan: edl.json из ${opts.edl} (${edl.outputs.length} выход(ов))`);
    } else if (opts.prompt) {
      console.log("▸ plan");
      const r = await runStep(job.id, "plan", () => plan(job.id, { instruction: opts.prompt!, preset: opts.preset, ...planner! }));
      printPlan(r);
      edl = r.edl!;
    } else {
      console.log(`\nнет инструкции: передайте --prompt "…" (планировщик) или готовый план --edl <file>; анализ сохранён в workspace/${job.id}/`);
      return;
    }

    console.log("▸ cut");
    const report = await runStep(job.id, "cut", () => cut(job.id, edl, media, { transcript, snap: opts.snap, scenes }));
    printCutReport(report);
    if (opts.render) {
      const okIds = report.outputs.filter((o) => o.status === "ok").map((o) => o.id);
      await runRender(job.id, { ...opts, only: okIds }, edl);
    }
    console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)}s — workspace/${job.id}/`);
  } catch (err) {
    fail(err);
  }
});

interface HighlightsCliOpts extends RenderCliOpts {
  prompt?: string;
  perPerson?: boolean;
  target?: number;
  editor: boolean;
  render: boolean;
}

function printHighlights(r: import("./highlights/index.ts").HighlightsReport) {
  const e = r.events;
  console.log(`  события: ${e.total}, бросков ${e.shots}, попаданий ${e.makes} (по кадрам у кольца ${e.makes_local}, модель видела ${e.makes_model}), подходили люди: ${e.social}`);
  console.log(`  Gemini: ${r.gemini.requests} запрос(ов), ${r.gemini.input_tokens} вх. / ${r.gemini.output_tokens} вых. токенов, из кэша ${r.gemini.cached_chunks} чанк(ов)`);
  console.log(`  титр «${r.title}», ${r.timeline.length} момент(ов), ${r.duration.toFixed(1)} с${r.music ? `, музыка «${r.music.title}» ${r.music.bpm ?? "?"} BPM` : ""}`);
  for (const t of r.timeline) console.log(`    ${t.start.toFixed(1).padStart(5)}–${t.end.toFixed(1).padEnd(5)} ${t.role.padEnd(6)} ${t.id}${t.replay ? " +повтор" : ""}${t.callout ? ` [${t.callout}]` : ""}${t.beat_aligned ? " ♪" : ""} — ${t.description}`);
  for (const n of r.notes) console.log(`  ⚠ ${n}`);
}

/** ingest (light) → events → highlights plan → cut → render with the sport_highlights design. */
async function runHighlightsCli(video: string, opts: HighlightsCliOpts) {
  const { ingestLight } = await import("./ingest/index.ts");
  const job = await createJob(video, { prompt: opts.prompt, preset: "sport_highlights" });
  console.log(`job ${job.id} (режим highlights)`);
  const t0 = Date.now();
  console.log("▸ ingest");
  const media = await runStep(job.id, "ingest", () => ingestLight(job.id, video));
  console.log(`  ${media.width}x${media.height} @ ${media.fps.toFixed(2)}fps, ${media.duration.toFixed(1)}s`);
  await highlightsPipeline(job.id, media, opts);
  console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)}s — workspace/${job.id}/`);
}

async function highlightsPipeline(jobId: string, media: import("./schemas/index.ts").Media, opts: HighlightsCliOpts) {
  const { planHighlights } = await import("./highlights/index.ts");
  const { selectStructuredLlm } = await import("./lib/llm.ts");
  let llm = null;
  if (opts.editor) {
    try {
      llm = selectStructuredLlm();
    } catch {
      console.log("  (нет входа Claude — титр и порядок по правилам)");
    }
  }
  const { perPersonIntent } = await import("./highlights/intent.ts");
  if (opts.perPerson || perPersonIntent(opts.prompt)) {
    const { planPerPerson, whoIsWhoSheet } = await import("./highlights/perperson.ts");
    console.log("▸ understand + plan: события, броски по кадрам, кто бросал (Gemini + цвет одежды), ролик на каждого");
    const r = await runStep(jobId, "plan", () => planPerPerson(jobId, media, { instruction: opts.prompt, llm, music: opts.bgMusic, onLog: (l) => console.log(`    ${l}`) }));
    for (const x of r.report.reels) console.log(`  ${x.id} «${x.title}»: ${x.look}; попаданий ${x.makes_in_reel}/${x.makes}${x.misses_in_reel ? ` + ${x.misses_in_reel} у дужки` : ""}, ${x.duration.toFixed(1)} с`);
    for (const x of r.report.skipped) console.log(`  – ${x.person} (${x.look}): ${x.why}`);
    for (const n of r.report.notes) console.log(`  ⚠ ${n}`);
    const sheet = await whoIsWhoSheet(media.source_path, r.players, path.join(jobDir(jobId), "persons.jpg"), { persons: r.report.reels.map((x) => x.person) }).catch((err) => `(лист не собран: ${err instanceof Error ? err.message.split("\n")[0] : err})`);
    console.log(`  кто есть кто: ${sheet}`);
    console.log("▸ cut");
    printCutReport(await runStep(jobId, "cut", () => cut(jobId, r.edl, media, { snap: false })));
    if (opts.render) await runRender(jobId, { ...opts, design: opts.design ?? "sport_highlights", bgMusic: undefined }, r.edl);
    return;
  }
  console.log("▸ understand + plan: события (Gemini), уточнение бросков по кадрам, отбор, музыка");
  const r = await runStep(jobId, "plan", () => planHighlights(jobId, media, { instruction: opts.prompt, target: opts.target, llm, music: opts.bgMusic, onLog: (l) => console.log(`    ${l}`) }));
  printHighlights(r.report);
  console.log("▸ cut");
  const report = await runStep(jobId, "cut", () => cut(jobId, r.edl, media, { snap: false }));
  printCutReport(report);
  // the music was chosen at plan time (cuts sit on its beats): the render takes it from the EDL
  if (opts.render) await runRender(jobId, { ...opts, design: opts.design ?? "sport_highlights", bgMusic: undefined }, r.edl);
}

withRenderOptions(
  program
    .command("highlights")
    .description("хайлайты спорта/экшена: события → лучшие моменты → замедления, наезды на кольцо, музыка по битам")
    .argument("<job_or_video>", "id задачи или путь к видео")
    .option("-p, --prompt <text>", "инструкция (длина, формат, титр в «кавычках»)")
    .option("--target <s>", "длина ролика, с", (v) => Number(v))
    .option("--no-editor", "без вызова Claude")
    .option("--per-person", "отдельный ролик на каждого игрока (так же по словам «по отдельности», «на каждого игрока»)")
    .option("--no-render", "остановиться после черновой нарезки"),
).action(async (target: string, opts: HighlightsCliOpts) => {
  try {
    if (await exists(path.resolve(target))) {
      await runHighlightsCli(target, opts);
      return;
    }
    const job = await loadJob(target);
    const media = await readJson(path.join(jobDir(target), "media.json"), MediaSchema);
    await highlightsPipeline(target, media, { ...opts, prompt: opts.prompt ?? job.prompt });
  } catch (err) {
    fail(err);
  }
});

withRenderOptions(
  program
    .command("render")
    .description("оформление + финальный рендер по edl.json и черновым нарезкам (output_<id>.mp4)")
    .argument("<job_id>")
    .option("-o, --only <ids...>", "рендерить только указанные выходы"),
).action(async (jobId: string, opts: RenderCliOpts & { only?: string[] }) => {
  try {
    await loadJob(jobId);
    await runRender(jobId, opts);
  } catch (err) {
    fail(err);
  }
});

program
  .command("ingest")
  .description("создать задачу и нормализовать видео")
  .argument("<video>")
  .action(async (video: string) => {
    try {
      const job = await createJob(video);
      const media = await runStep(job.id, "ingest", () => ingest(job.id, video));
      console.log(`job ${job.id}`);
      console.log(JSON.stringify(media, null, 2));
    } catch (err) {
      fail(err);
    }
  });

program
  .command("understand")
  .description("транскрипция + сцены + лучшие моменты для существующей задачи")
  .argument("<job_id>")
  .option("--language <code>", "язык речи для whisper (по умолчанию auto)")
  .option("--threads <n>", "потоки whisper", (v) => Number(v))
  .option("--method <m>", "dtw | tokens — способ пословных таймкодов", "dtw")
  .option("--vision <provider>", "stub | auto | gemini | agy", "auto")
  .option("--asr <engine>", "auto | cpp | faster | import — движок распознавания речи (import = из vedit asr-import, env VEDIT_ASR)", "auto")
  .option("--no-diarize", "не размечать говорящих")
  .option("--speakers <n>", "сколько говорящих ожидать (по умолчанию определяется)", (v) => Number(v))
  .option("--events", "только события спорта/экшена (Gemini по видео + уточнение бросков по кадрам) → events.json")
  .action(async (jobId: string, opts: { language?: string; threads?: number; method: "dtw" | "tokens"; vision: VisionChoice; asr: AsrChoice; diarize: boolean; speakers?: number; events?: boolean }) => {
    try {
      const job = await loadJob(jobId);
      const media = await readJson(path.join(jobDir(jobId), "media.json"), MediaSchema);
      if (opts.events) {
        const { ensureEvents, localPass } = await import("./highlights/index.ts");
        const log = (l: string) => console.log(`    ${l}`);
        let ev = await runStep(jobId, "understand", () => ensureEvents(jobId, media, { instruction: job.prompt, onLog: log }));
        ev = await localPass(jobId, ev, media, log);
        for (const e of ev.events) console.log(`  ${e.id.padEnd(5)} ${e.key.toFixed(2).padStart(8)}s ${e.type.padEnd(16)} ${e.outcome.padEnd(5)} ${e.refined ? `[${e.refined.local_verdict}]` : ""} ${e.description}`);
        console.log(`  Gemini: ${ev.usage.requests} запрос(ов), ${ev.usage.input_tokens}/${ev.usage.output_tokens} токенов, ${ev.wall_seconds.toFixed(0)} с`);
        return;
      }
      const r = await runStep(jobId, "understand", () => understand(jobId, media, { ...opts, numSpeakers: opts.speakers, onLog: (l) => console.log(`    ${l}`) }));
      printUnderstand(r);
    } catch (err) {
      fail(err);
    }
  });

withPlannerOptions(
  program
    .command("plan")
    .description("построить план монтажа (edl.json) по инструкции для существующей задачи")
    .argument("<job_id>")
    .requiredOption("-p, --prompt <text>", "инструкция по монтажу")
    .option("--preset <name>", "пресет стиля")
    .option("--cut", "сразу нарезать по полученному плану")
    .option("--no-snap", "не подтягивать границы клипов к границам слов")
    .option("--dry-run", "показать пакет контекста и бэкенд, модель не вызывать"),
).action(async (jobId: string, opts: { prompt: string; preset?: string; cut?: boolean; snap: boolean; dryRun?: boolean } & PlannerCliOpts) => {
  try {
    const job = await loadJob(jobId);
    if (opts.dryRun) {
      const { ctx, warnings, presetName } = await loadPlanInputs(jobId, opts.preset ?? job.preset ?? "bold_pop");
      const backend = selectBackend(opts.backend, { model: opts.model ?? process.env.VEDIT_PLANNER_MODEL ?? DEFAULT_MODEL, effort: opts.effort });
      console.log(`${backend.note}\nпресет: ${presetName}; режим: ${ctx.mode}; ≈${ctx.tokenEstimate} токенов; sha256 ${ctx.packHash.slice(0, 12)}`);
      console.log(`фраз ${ctx.phrases.length}, сцен ${ctx.scenes.length}, пауз ${ctx.gaps.length}, highlights ${ctx.highlights.length}, длительность ${ctx.duration.toFixed(1)}s`);
      for (const w of warnings) console.log(`⚠ ${w}`);
      console.log(ctx.packText);
      return;
    }
    const planner = plannerOpts(opts);
    const r = await runStep(jobId, "plan", () => plan(jobId, { instruction: opts.prompt, preset: opts.preset, ...planner }));
    printPlan(r);
    if (opts.cut) {
      const media = await readJson(path.join(jobDir(jobId), "media.json"), MediaSchema);
      const transcript = await loadTranscript(jobId);
      const scenes = await loadScenes(jobId);
      console.log("▸ cut");
      printCutReport(await runStep(jobId, "cut", () => cut(jobId, r.edl!, media, { transcript, snap: opts.snap, scenes })));
    } else console.log(`нарезать: vedit cut ${jobId}`);
  } catch (err) {
    fail(err);
  }
});

withRenderOptions(
  withPlannerOptions(
    program
      .command("revise")
      .description("правка плана диалогом: изменить edl.json, перерезать и перерендерить затронутые выходы")
      .argument("<job_id>")
      .requiredOption("-p, --prompt <text>", "что изменить")
      .option("--no-cut", "только обновить план, не резать и не рендерить")
      .option("--no-render", "перерезать, но не рендерить")
      .option("--no-snap", "не подтягивать границы клипов к границам слов"),
  ),
).action(async (jobId: string, opts: { prompt: string; cut: boolean; render: boolean; snap: boolean } & PlannerCliOpts & RenderCliOpts) => {
  try {
    await loadJob(jobId);
    const planner = plannerOpts(opts);
    const r = await runStep(jobId, "revise", () => revise(jobId, { edit: opts.prompt, ...planner }));
    printPlan(r);
    const d = r.report.diff;
    console.log(`  изменено: ${d.changed.map((c) => `${c.id} (${c.fields.join(", ")})`).join(", ") || "—"}; без изменений: ${d.unchanged.join(", ") || "—"}; добавлено: ${d.added.join(", ") || "—"}; удалено: ${d.removed.join(", ") || "—"}`);
    console.log(`  предыдущий план: ${r.report.previous_edl}`);
    if (!opts.cut) return;
    if (r.affected.length) {
      const media = await readJson(path.join(jobDir(jobId), "media.json"), MediaSchema);
      const transcript = await loadTranscript(jobId);
      const scenes = await loadScenes(jobId);
      console.log(`▸ cut (${r.affected.join(", ")})`);
      printCutReport(await runStep(jobId, "cut", () => cut(jobId, r.edl, media, { only: r.affected, transcript, snap: opts.snap, scenes })));
    } else console.log("  нарезка не нужна: клипы не менялись");
    // design/render-stage changes (captions, titles) need a new overlay even when the cut is untouched
    const toRender = [...d.added, ...d.changed.map((c) => c.id)].filter((id, i, arr) => arr.indexOf(id) === i && (d.stages[id] ?? []).some((s) => s === "design" || s === "render"));
    if (!opts.render) return;
    if (toRender.length) await runRender(jobId, { ...opts, only: toRender }, r.edl);
    else console.log("  рендер не нужен: оформление не менялось");
  } catch (err) {
    fail(err);
  }
});

program
  .command("cut")
  .description("перерезать задачу по edl.json")
  .argument("<job_id>")
  .option("-e, --edl <file>", "заменить edl.json задачи этим файлом")
  .option("-o, --only <ids...>", "резать только указанные выходы")
  .option("--no-snap", "не подтягивать границы клипов к границам слов")
  .action(async (jobId: string, opts: { edl?: string; only?: string[]; snap: boolean }) => {
    try {
      await loadJob(jobId);
      const dir = jobDir(jobId);
      const media = await readJson(path.join(dir, "media.json"), MediaSchema);
      const edl = opts.edl ? await stageEdl(jobId, opts.edl) : await readJson(path.join(dir, "edl.json"), EdlSchema);
      const transcript = await loadTranscript(jobId);
      const scenes = await loadScenes(jobId);
      const report = await runStep(jobId, "cut", () => cut(jobId, edl, media, { only: opts.only, transcript, snap: opts.snap, scenes }));
      printCutReport(report);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("status")
  .description("состояние задачи")
  .argument("<job_id>")
  .action(async (jobId: string) => {
    try {
      const job = await loadJob(jobId);
      const dir = jobDir(jobId);
      console.log(`job ${job.id}  (создана ${job.created_at})`);
      console.log(`источник: ${job.source}`);
      if (job.prompt) console.log(`промпт:   ${job.prompt}`);
      for (const [step, s] of Object.entries(job.steps)) {
        const took = s.started_at && s.finished_at ? ` ${((+new Date(s.finished_at) - +new Date(s.started_at)) / 1000).toFixed(1)}s` : "";
        console.log(`  ${step.padEnd(10)} ${s.status}${took}${s.error ? `\n    ${s.error.split("\n")[0]}` : ""}`);
      }
      const uFile = path.join(dir, "understand.json");
      if (await exists(uFile)) {
        const u = await readJson(uFile, UnderstandReportSchema);
        console.log(`анализ: ${u.transcriber ? `${u.transcriber.language}, ${u.phrases} фраз, ${u.words} слов; ` : ""}${u.shots} шотов; ${u.vision.note}`);
        const hFile = path.join(dir, "highlights.json");
        if (await exists(hFile)) {
          for (const h of (await readJson(hFile, HighlightsSchema)).slice(0, 3)) console.log(`  ★ ${h.score.toFixed(2)} ${h.start.toFixed(1)}–${h.end.toFixed(1)}s ${h.reason}`);
        }
      }
      const pFile = path.join(dir, "plan.json");
      if (await exists(pFile)) {
        const p = await readJson(pFile, PlanReportSchema);
        console.log(`план: ${p.status}, ${costLine(p)}; выходы: ${p.outputs.map((o) => `${o.id} ${o.duration_s}s`).join(", ") || "—"}`);
        for (const w of p.warnings.slice(0, 3)) console.log(`  ⚠ ${w}`);
      }
      const rFile = path.join(dir, "revise.json");
      if (await exists(rFile)) {
        const r = await readJson(rFile, ReviseReportSchema);
        console.log(`правка: ${r.status} «${r.edit.slice(0, 60)}» — изменено ${r.diff.changed.map((c) => c.id).join(", ") || "—"}, перерезано ${r.affected.join(", ") || "—"}`);
      }
      const renFile = path.join(dir, "render.json");
      if (await exists(renFile)) {
        const r = await readJson(renFile, RenderReportSchema);
        console.log(`рендер: ${r.outputs.map((o) => `${o.id} ${o.status}${o.render_seconds ? ` ${o.render_seconds.toFixed(0)}s` : ""}`).join(", ")} (${r.renderer}, ${r.quality}, ${r.wall_seconds.toFixed(0)}s)`);
      }
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".mp4") || f.endsWith(".json"));
      console.log(`файлы: ${files.join(", ")}`);
      const costFile = path.join(dir, "cost.json");
      if (await exists(costFile)) {
        const cost = await readJson(costFile, CostSchema);
        const est = cost.entries.some((e) => e.units.estimate === 1);
        console.log(`стоимость API: ${est ? "≈" : ""}$${cost.total_usd.toFixed(4)}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("asr-export")
  .description("упаковать звук задачи для распознавания на внешнем GPU (Colab): <job>/asr_upload.ogg")
  .argument("<job_id>")
  .action(async (jobId: string) => {
    try {
      await loadJob(jobId);
      const { exportAsrAudio } = await import("./understand/asr-import.ts");
      const r = await exportAsrAudio(jobId);
      console.log(`✔ ${r.file} (${(r.bytes / 1024 / 1024).toFixed(1)} МБ)`);
      console.log("дальше: загрузите файл и tools/asr/vedit_asr.py в tools/asr/colab_vedit_asr.ipynb (Colab, GPU T4), скачайте asr_bundle.zip и выполните:");
      console.log(`  vedit asr-import ${jobId} asr_bundle.zip && vedit understand ${jobId} --asr import`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("asr-import")
  .description("импортировать распознанную на внешнем GPU речь (asr_bundle.zip или папку с faster.json)")
  .argument("<job_id>")
  .argument("<bundle>", "zip или папка с faster.json, phrases.json, speakers_raw.json")
  .action(async (jobId: string, bundle: string) => {
    try {
      await loadJob(jobId);
      const { importAsrBundle } = await import("./understand/asr-import.ts");
      const r = await importAsrBundle(jobId, bundle);
      console.log(`✔ речь: ${r.marker.language}, ${r.transcript.segments.length} фраз, ${r.transcript.segments.reduce((n, s) => n + s.words.length, 0)} слов (${r.marker.model} на ${r.marker.device}, ${r.marker.wall_seconds}s)`);
      if (r.speakers) console.log(`✔ говорящие: ${r.speakers.speakers.map((s) => `${s.id} ${s.seconds}s`).join(", ")}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
      console.log(`дальше: vedit understand ${jobId} --asr import`);
    } catch (err) {
      fail(err);
    }
  });

program
  .command("make")
  .description("ролик по теме из ничего: тренды (Antigravity) → сценарий (Claude) → иконки и моушн-графика (HyperFrames) → MP4")
  .argument("<topic>", "тема ролика")
  .option("--lang <code>", "язык: ru | uz | en", "ru")
  .option("--seconds <n>", "целевая длина, с", (v) => Number(v), 35)
  .option("--audience <text>", "для кого ролик")
  .option("--no-trends", "без исследования трендов")
  .option("--music <m>", "музыка: auto (по настроению от арт-директора) | upbeat|chill|dramatic|inspiring|tech|funky|emotional | файл | none", "auto")
  .option("--no-sfx", "без звуковых эффектов")
  .option("--quality <q>", "draft | looks | delivery", "looks")
  .option("--model <id>", "модель сценариста")
  .option("--script <file>", "отрендерить сохранённый script.json как есть (без трендов и модели)")
  .option("--from <job>", "взять сценарий, дизайн и картинки из прошлой задачи make (перерендер)")
  .option("--no-director", "без арт-директора: простая композиция с иконками")
  .option("--images <mode>", "картинки: photo (настоящие фото Openverse CC0/PD/CC BY, по умолчанию) | ai (генерация Antigravity) | none", "photo")
  .option("--no-images", "без картинок (то же, что --images none)")
  .option("--aspect <a>", "кадр: 9:16 (Reels/Shorts) | 16:9 (YouTube) | 1:1 | auto (по словам темы: «для ютуба» → 16:9)", "auto")
  .option("--voice <id>", "озвучка голосом из каталога (vedit voices), например gemini_charon или denis; auto (по умолчанию) — Gemini Charon при ключе Google, иначе Piper dmitri; none — без голоса", "auto")
  .option("--voice-captions", "субтитры озвучки поверх сцен (по умолчанию нет: текст уже на экране)")
  .option("--voice-speed <x>", "темп голоса: 0.8 — быстрее, 1.2 — медленнее", (v) => Number(v))
  .action(async (topic: string, opts: { lang: string; seconds: number; audience?: string; trends: boolean; music?: string; sfx: boolean; quality: "draft" | "looks" | "delivery"; model?: string; script?: string; from?: string; director: boolean; images: string | boolean; aspect: string; voice: string; voiceCaptions?: boolean; voiceSpeed?: number }) => {
    try {
      if (!["draft", "looks", "delivery"].includes(opts.quality)) throw new Error("--quality: ожидается draft | looks | delivery");
      if (!Number.isFinite(opts.seconds) || opts.seconds < 15 || opts.seconds > 90) throw new Error("--seconds: ожидается 15–90");
      if (opts.voiceSpeed !== undefined && !(opts.voiceSpeed >= 0.5 && opts.voiceSpeed <= 2)) throw new Error("--voice-speed: ожидается 0.5–2");
      if (typeof opts.images === "string" && !["photo", "ai", "none"].includes(opts.images)) throw new Error("--images: ожидается photo | ai | none");
      const { isAspect } = await import("./lib/aspect.ts");
      if (opts.aspect !== "auto" && !isAspect(opts.aspect)) throw new Error("--aspect: ожидается 9:16 | 16:9 | 1:1 | auto");
      const { requireVoice, NO_VOICE, AUTO_VOICE } = await import("./voice/catalog.ts");
      if (!NO_VOICE.test(opts.voice) && !AUTO_VOICE.test(opts.voice)) requireVoice(opts.voice);
      const { make, creditsText } = await import("./make/index.ts");
      const r = await make(topic, { language: opts.lang, seconds: opts.seconds, audience: opts.audience, trends: opts.trends, music: opts.music, sfx: opts.sfx, quality: opts.quality, model: opts.model, scriptFile: opts.script, fromJob: opts.from, director: opts.director, images: opts.images as boolean | "photo" | "ai" | "none", aspect: isAspect(opts.aspect) ? opts.aspect : undefined, voice: opts.voice, voiceCaptions: opts.voiceCaptions, voiceLengthScale: opts.voiceSpeed, onEvent: (l) => console.log(l) });
      console.log(`\n✔ ${r.output} (${r.aspect} ${r.width}×${r.height}, ${r.duration.toFixed(1)} с, ${r.beats} битов${r.voice ? `, голос ${r.voice}` : ""}, рендер ${r.render_seconds.toFixed(0)} с${r.usd ? `, ≈$${r.usd.toFixed(3)}` : ""})`);
      if (r.script.hashtags.length) console.log(`  #${r.script.hashtags.join(" #")}`);
      const credits = creditsText(r);
      if (credits) console.log(`  ${credits.split("\n").join("\n  ")}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    } catch (err) {
      fail(err);
    }
  });

const avatar = program.command("avatar").description("говорящий аватар: текст/тема → avatar_job.zip → Colab (Chatterbox + JoyVASA) → avatar_result.zip → монтаж");

avatar
  .command("export")
  .description("собрать avatar_job.zip для ноутбука tools/avatar/colab_vedit_avatar.ipynb")
  .option("--text <text>", "что говорит аватар (абзацы — с новой строки)")
  .option("--text-file <file>", "текст из файла")
  .option("--topic <topic>", "тема: монолог напишет Claude")
  .option("--photo <file>", "портрет (фронтально, лицо крупно); без него — сгенерированный вымышленный ведущий")
  .option("--voice <id|file>", "голос из каталога (vedit voices: denis — синтез локально, chatterbox_denis — клон в Colab) или файл-образец 5–10 с для клонирования")
  .option("--speech <file>", "своя запись речи: без синтеза, аватар говорит ею")
  .option("--lang <code>", "язык речи (Chatterbox: ru, en, tr, de, …)", "ru")
  .option("--seconds <n>", "длина монолога по теме, с", (v) => Number(v), 40)
  .option("--voice-only", "только голос, без видео аватара")
  .option("--no-images", "не генерировать портрет (нужен --photo)")
  .option("--model <id>", "модель сценариста")
  .action(async (opts: { text?: string; textFile?: string; topic?: string; photo?: string; voice?: string; speech?: string; lang: string; seconds: number; voiceOnly?: boolean; images: boolean; model?: string }) => {
    try {
      if (!Number.isFinite(opts.seconds) || opts.seconds < 10 || opts.seconds > 180) throw new Error("--seconds: ожидается 10–180");
      if ([opts.text, opts.textFile, opts.topic].filter(Boolean).length > 1) throw new Error("укажите что-то одно: --text, --text-file или --topic");
      const text = opts.textFile ? await fs.readFile(path.resolve(opts.textFile), "utf8") : opts.text;
      const { exportAvatarJob, colabSteps } = await import("./avatar/export.ts");
      const { getVoice } = await import("./voice/catalog.ts");
      const voiceId = opts.voice && getVoice(opts.voice) && !(await fs.stat(opts.voice).then(() => true, () => false)) ? opts.voice : undefined;
      const r = await exportAvatarJob({ text, topic: opts.topic, photo: opts.photo, voice: voiceId ? undefined : opts.voice, voiceId, speech: opts.speech, language: opts.lang, seconds: opts.seconds, mode: opts.voiceOnly ? "voice_only" : "avatar", images: opts.images, model: opts.model, onEvent: (l) => console.log(l) });
      console.log(`\n✔ ${r.bundle} (${(r.bytes / 1024 / 1024).toFixed(1)} МБ)`);
      console.log(`  ${r.state.lines.length} строк, ≈${r.state.estimated_seconds.toFixed(0)} с речи; портрет: ${r.state.portrait}; голос: ${r.state.voice}`);
      for (const [i, l] of r.state.lines.slice(0, 12).entries()) console.log(`  ${String(i + 1).padStart(2)}. ${l}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
      console.log("\nДальше (Google Colab, бесплатный GPU T4):");
      for (const s of colabSteps(r.jobId)) console.log(`  ${s}`);
    } catch (err) {
      fail(err);
    }
  });

withRenderOptions(
  withPlannerOptions(
    avatar
      .command("import")
      .description("принять avatar_result.zip из Colab и смонтировать рилс (по умолчанию split_news: аватар снизу, картинки сверху)")
      .argument("<job_id>")
      .argument("<result>", "avatar_result.zip или папка с avatar.mp4 и meta.json")
      .option("-p, --prompt <text>", "инструкция по монтажу", undefined)
      .option("--vision <provider>", "stub | auto | gemini | agy", "auto")
      .option("--asr <engine>", "auto | cpp | faster", "auto")
      .option("--no-render", "остановиться после черновой нарезки")
      .option("--no-panel-images", "split_news без генерации картинок панелей"),
  ),
).action(async (jobId: string, result: string, opts: { prompt?: string; vision: VisionChoice; asr: AsrChoice; render: boolean; panelImages: boolean } & PlannerCliOpts & RenderCliOpts) => {
  try {
    const planner = plannerOpts(opts);
    const { importAvatarResult, runAvatarMontage } = await import("./avatar/import.ts");
    const t0 = Date.now();
    const r = await importAvatarResult(jobId, result);
    console.log(`✔ avatar.mp4 ${r.width}×${r.height}, ${r.duration.toFixed(1)} с (${r.meta.tts.engine ?? "?"} / ${r.meta.animate?.engine ?? "?"} на ${r.meta.animate?.device ?? "?"})`);
    for (const w of r.warnings) console.log(`  ⚠ ${w}`);
    if (opts.renderer !== "hyperframes") throw new Error(`рендерер "${opts.renderer}" не подключён; доступен: hyperframes`);
    const m = await runAvatarMontage(jobId, {
      prompt: opts.prompt,
      design: opts.design ?? "split_news",
      backend: planner.backend,
      vision: opts.vision,
      asr: opts.asr,
      music: opts.bgMusic,
      render: opts.render,
      panelImages: opts.panelImages,
      quality: opts.quality,
      workers: opts.workers,
      onEvent: (l) => console.log(l),
    });
    for (const o of m.outputs) console.log(`  ✔ ${o.id}: ${o.duration?.toFixed(1)} с → ${o.file}`);
    for (const f of m.failed) console.log(`  ✖ ${f.id}: ${f.error.split("\n")[0]}`);
    for (const n of m.notes) console.log(`  ⚠ ${n}`);
    console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)}s — workspace/${jobId}/`);
  } catch (err) {
    fail(err);
  }
});

program
  .command("voices")
  .description("каталог голосов для озвучки (make --voice) и аватара (avatar export --voice)")
  .option("--json", "вывести JSON")
  .option("--sample <id>", "синтезировать пробу голоса (Piper локально / Gemini API) в workspace/_voices/<id>.wav")
  .option("--text <text>", "текст пробы")
  .action(async (opts: { json?: boolean; sample?: string; text?: string }) => {
    try {
      const { VOICES, formatVoices, requireVoice, isLocal, sampleVoiceFor, GEMINI_LICENSE_NOTE } = await import("./voice/catalog.ts");
      const { piperStatus, synthesize } = await import("./voice/piper.ts");
      const { geminiApiKey, geminiTtsModels } = await import("./voice/gemini.ts");
      const { cloudApiKey, cloudGeminiModels } = await import("./voice/cloudtts.ts");
      const { TTS_KEYS_HELP } = await import("./voice/piper.ts");
      if (opts.sample) {
        const v = requireVoice(opts.sample);
        const p = sampleVoiceFor(v);
        if (!p) throw new Error(`${v.id} звучит только в Colab (встроенный голос Chatterbox); локальная проба невозможна`);
        const { WORKSPACE_ROOT } = await import("./lib/workspace.ts");
        const out = path.join(WORKSPACE_ROOT, "_voices", `${v.id}.wav`);
        const text = opts.text ?? (p.language === "ru" ? "Привет! Это проба голоса. В 2026 году кофе подорожал на 30%." : "Hi! This is a voice sample. Coffee got 30% more expensive in 2026.");
        const r = await synthesize(text, p.id, out, { onEvent: (l) => console.log(l) });
        console.log(`✔ ${out} (${r.duration.toFixed(1)} с, ${r.engine}${r.model ? ` ${r.model}` : ""}${r.voice !== v.id ? `; говорил ${r.voice}` : ""})`);
        for (const x of r.sentences) console.log(`  ${x.start.toFixed(2)}–${x.end.toFixed(2)}  ${x.spoken}`);
        return;
      }
      const st = await piperStatus();
      const gemini = { key: !!geminiApiKey(), models: geminiTtsModels() };
      const cloud = { key: !!cloudApiKey(), models: [...cloudGeminiModels(), "chirp3-hd"] };
      if (opts.json) {
        console.log(JSON.stringify({ piper: st, gemini, cloud, voices: VOICES.map((v) => ({ ...v, local: isLocal(v), downloaded: !!v.piper && st.models.includes(v.piper.key) })) }, null, 2));
        return;
      }
      console.log(formatVoices());
      console.log(`
Piper: ${st.binary ? "установлен" : "скачается при первом синтезе (~22 МБ)"}; скачанные голоса: ${st.models.join(", ") || "нет (каждый ~60 МБ, при первом использовании)"}`);
      console.log(`Google Cloud TTS (GOOGLE_CLOUD_API_KEY): ${cloud.key ? `ключ есть — gemini_* через Gemini-TTS (${cloud.models.slice(0, -1).join(" → ")}), chirp_* через Chirp 3 HD` : "ключа нет"}`);
      console.log(`Gemini API (GEMINI_API_KEY): ${gemini.key ? `ключ есть${cloud.key ? " (запасной)" : `, модели ${gemini.models.join(" → ")}`}` : "ключа нет"}`);
      console.log(GEMINI_LICENSE_NOTE);
      if (!gemini.key && !cloud.key) console.log(`gemini_* и chirp_* пока звучат голосом Piper.
${TTS_KEYS_HELP}`);
      console.log("Свой голос: аватар — vedit avatar export --voice мой_голос.ogg (клон) или --speech запись.ogg; в боте — голосовое сообщение.");
      console.log('Примеры: vedit make "тема" --voice gemini_charon (или auto) · vedit make "тема" --voice denis · vedit avatar export --text "…" --voice chatterbox_denis · vedit voices --sample dmitri');
    } catch (err) {
      fail(err);
    }
  });

program
  .command("doctor")
  .description("самопроверка: режим (сервер / локальные входы), какой бэкенд у каждого модуля, каких бинарников и ключей не хватает; код 1 — нет обязательного")
  .option("--bot", "проверить и то, что нужно Telegram-боту (токен, node:sqlite)")
  .option("--json", "вывести JSON")
  .action(async (opts: { bot?: boolean; json?: boolean }) => {
    try {
      const { runDoctor, formatDoctor } = await import("./doctor.ts");
      const r = await runDoctor({ bot: opts.bot });
      console.log(opts.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      fail(err);
    }
  });

program
  .command("modules")
  .description("реестр модулей: бэкенд, готовность, использование и стоимость по задачам")
  .option("--days <n>", "окно статистики, дней", (v) => Number(v), 30)
  .option("--json", "вывести JSON")
  .option("--licenses", "показать зависимости и лицензии каждого бэкенда")
  .action(async (opts: { days: number; json?: boolean; licenses?: boolean }) => {
    try {
      const { moduleStatus, formatModules, MODULES } = await import("./modules.ts");
      const s = await moduleStatus({ days: opts.days });
      if (opts.json) {
        console.log(JSON.stringify({ ...s, registry: MODULES.map((m) => ({ id: m.id, stage: m.stage, title: m.title, what: m.what, selector: m.selector, backends: m.backends })) }, null, 2));
        return;
      }
      console.log(formatModules(s, opts.days));
      if (opts.licenses) {
        console.log("");
        for (const m of MODULES) {
          console.log(`${m.id} — ${m.title}: ${m.what}\n  выбор: ${m.selector}`);
          for (const b of m.backends) console.log(`  · ${b.id}: ${b.title} — ${b.deps} — ${b.license}`);
        }
      }
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();
