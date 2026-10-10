import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import { ingest } from "./ingest/index.ts";
import { cut, type CutReport } from "./cut/index.ts";
import { createJob, exists, jobDir, loadJob, readJson, runStep, writeJson } from "./lib/workspace.ts";
import { EdlSchema, MediaSchema, CostSchema, type Edl } from "./schemas/index.ts";

const program = new Command();
program.name("vedit").description("AI video editing agent — MVP").version("0.1.0");

function fail(err: unknown): never {
  console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
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

async function stageEdl(jobId: string, edlPath: string): Promise<Edl> {
  const edl = await readJson(path.resolve(edlPath), EdlSchema);
  return writeJson(path.join(jobDir(jobId), "edl.json"), EdlSchema, edl);
}

program
  .command("run")
  .description("полный пайплайн: ingest → (understand → plan) → cut")
  .argument("<video>", "путь к исходному видео")
  .option("-p, --prompt <text>", "инструкция по монтажу (агент — этап 3)")
  .option("--preset <name>", "пресет стиля", "bold_pop")
  .option("-e, --edl <file>", "готовый edl.json (пока агент-планировщик не подключён)")
  .action(async (video: string, opts: { prompt?: string; preset: string; edl?: string }) => {
    try {
      if (!opts.edl) {
        throw new Error("агент-планировщик появится на этапе 3 — пока передайте план монтажа через --edl <file>");
      }
      // validate the plan before spending time on ingest
      await readJson(path.resolve(opts.edl), EdlSchema);
      const job = await createJob(video, { prompt: opts.prompt, preset: opts.preset });
      console.log(`job ${job.id}`);
      const t0 = Date.now();

      console.log("▸ ingest");
      const media = await runStep(job.id, "ingest", () => ingest(job.id, video));
      console.log(`  ${media.width}x${media.height} @ ${media.fps}fps, ${media.duration.toFixed(2)}s, audio: ${media.has_audio}`);

      const edl = await stageEdl(job.id, opts.edl);
      console.log(`▸ plan: edl.json из ${opts.edl} (${edl.outputs.length} выход(ов))`);

      console.log("▸ cut");
      const report = await runStep(job.id, "cut", () => cut(job.id, edl, media));
      printCutReport(report);
      console.log(`\nготово за ${((Date.now() - t0) / 1000).toFixed(1)}s — workspace/${job.id}/`);
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
  .command("cut")
  .description("перерезать задачу по edl.json")
  .argument("<job_id>")
  .option("-e, --edl <file>", "заменить edl.json задачи этим файлом")
  .option("-o, --only <ids...>", "резать только указанные выходы")
  .action(async (jobId: string, opts: { edl?: string; only?: string[] }) => {
    try {
      await loadJob(jobId);
      const dir = jobDir(jobId);
      const media = await readJson(path.join(dir, "media.json"), MediaSchema);
      const edl = opts.edl ? await stageEdl(jobId, opts.edl) : await readJson(path.join(dir, "edl.json"), EdlSchema);
      const report = await runStep(jobId, "cut", () => cut(jobId, edl, media, opts.only));
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
      const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".mp4") || f.endsWith(".json"));
      console.log(`файлы: ${files.join(", ")}`);
      const costFile = path.join(dir, "cost.json");
      if (await exists(costFile)) {
        const cost = await readJson(costFile, CostSchema);
        console.log(`стоимость API: $${cost.total_usd.toFixed(4)}`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("revise")
  .description("правка диалогом (этап 5)")
  .argument("<job_id>")
  .requiredOption("-p, --prompt <text>")
  .action(() => fail("revise появится на этапе 5"));

program.parseAsync();
