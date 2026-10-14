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
}

function withRenderOptions(cmd: Command) {
  return cmd
    .option("--quality <q>", "draft | looks | delivery", "looks")
    .option("--workers <n>", "воркеры Chrome (по умолчанию — по свободной памяти)", (v) => Number(v))
    .option("--no-translate", "не переводить субтитры на язык из плана")
    .option("--renderer <name>", "hyperframes (другие — после этапа 4)", "hyperframes")
    .option("--bg-music <m>", "музыка под речью: auto | upbeat|chill|… | файл | none (по умолчанию — из пресета)")
    .option("--design <preset>", "пресет оформления вместо пресета задачи (например split_news)");
}

function makeRenderer(o: RenderCliOpts) {
  if (o.renderer !== "hyperframes") throw new Error(`рендерер "${o.renderer}" не подключён; доступен: hyperframes`);
  if (!["draft", "looks", "delivery"].includes(o.quality)) throw new Error("--quality: ожидается draft | looks | delivery");
  return new HyperFramesRenderer({ workers: o.workers });
}

async function runRender(jobId: string, o: RenderCliOpts & { only?: string[] }, edl?: Edl) {
  const renderer = makeRenderer(o);
  await renderer.prepare();
  const r = await runStep(jobId, "render", () => renderOutputs(jobId, { renderer, quality: o.quality, only: o.only, translate: o.translate, edl, music: o.bgMusic, preset: o.design, onEvent: (l) => console.log(l) }));
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
      .option("--speakers <n>", "сколько говорящих ожидать (по умолчанию определяется)", (v) => Number(v)),
  ),
).action(async (video: string, opts: { prompt?: string; preset: string; edl?: string; skipUnderstand?: boolean; snap: boolean; render: boolean; language?: string; vision: VisionChoice; asr: AsrChoice; diarize: boolean; speakers?: number } & PlannerCliOpts & RenderCliOpts) => {
  try {
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
  .action(async (jobId: string, opts: { language?: string; threads?: number; method: "dtw" | "tokens"; vision: VisionChoice; asr: AsrChoice; diarize: boolean; speakers?: number }) => {
    try {
      await loadJob(jobId);
      const media = await readJson(path.join(jobDir(jobId), "media.json"), MediaSchema);
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
  .option("--no-images", "без генерации картинок")
  .action(async (topic: string, opts: { lang: string; seconds: number; audience?: string; trends: boolean; music?: string; sfx: boolean; quality: "draft" | "looks" | "delivery"; model?: string; script?: string; from?: string; director: boolean; images: boolean }) => {
    try {
      if (!["draft", "looks", "delivery"].includes(opts.quality)) throw new Error("--quality: ожидается draft | looks | delivery");
      if (!Number.isFinite(opts.seconds) || opts.seconds < 15 || opts.seconds > 90) throw new Error("--seconds: ожидается 15–90");
      const { make } = await import("./make/index.ts");
      const r = await make(topic, { language: opts.lang, seconds: opts.seconds, audience: opts.audience, trends: opts.trends, music: opts.music, sfx: opts.sfx, quality: opts.quality, model: opts.model, scriptFile: opts.script, fromJob: opts.from, director: opts.director, images: opts.images, onEvent: (l) => console.log(l) });
      console.log(`\n✔ ${r.output} (${r.duration.toFixed(1)} с, ${r.beats} битов, рендер ${r.render_seconds.toFixed(0)} с${r.usd ? `, ≈$${r.usd.toFixed(3)}` : ""})`);
      if (r.script.hashtags.length) console.log(`  #${r.script.hashtags.join(" #")}`);
      if (r.music_attribution) console.log(`  ${r.music_attribution}`);
      for (const w of r.warnings) console.log(`  ⚠ ${w}`);
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
