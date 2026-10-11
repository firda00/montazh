// Stage 6 harness: runs the whole pipeline over a folder of real videos and writes a summary.
//   npx tsx src/batch.ts <dir-with-mp4s> -p "3 рилса по 30 секунд" [--preset bold_pop] [--quality draft] [--no-render] [--limit N]
import fs from "node:fs/promises";
import path from "node:path";
import { createJob, jobDir, runStep } from "./lib/workspace.ts";
import { ingest } from "./ingest/index.ts";
import { understand } from "./understand/index.ts";
import { plan } from "./plan/index.ts";
import { cut } from "./cut/index.ts";
import { renderOutputs } from "./render/index.ts";
import { HyperFramesRenderer } from "./render/hyperframes.ts";
import type { RenderQuality } from "./design/renderer.ts";

try {
  process.loadEnvFile();
} catch {}

interface Row {
  file: string;
  job?: string;
  duration?: number;
  understand_s?: number;
  phrases?: number;
  plan_calls?: number;
  plan_repairs?: number;
  plan_usd?: number;
  plan_status?: string;
  outputs?: { id: string; duration_s: number; target_s: number | null; warnings: number }[];
  cut_warnings?: string[];
  render_s?: number;
  render_status?: string;
  error?: string;
  wall_s: number;
}

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a) => !a.startsWith("-") && !args.includes(`-${a}`) && (args.indexOf(a) === 0 || !args[args.indexOf(a) - 1].startsWith("-")));
const prompt = get("-p") ?? get("--prompt");
if (!dir || !prompt) throw new Error('usage: tsx src/batch.ts <dir> -p "инструкция" [--preset bold_pop] [--quality draft] [--no-render] [--limit N]');
const preset = get("--preset") ?? "bold_pop";
const quality = (get("--quality") ?? "looks") as RenderQuality;
const doRender = !args.includes("--no-render");
const limit = Number(get("--limit") ?? 0) || Infinity;

const files = (await fs.readdir(dir)).filter((f) => /\.(mp4|mov|mkv|webm)$/i.test(f)).sort().slice(0, limit);
if (files.length === 0) throw new Error(`в ${dir} нет видео`);
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
const outDir = path.resolve("workspace", `batch-${stamp}`);
await fs.mkdir(outDir, { recursive: true });
console.log(`batch: ${files.length} видео, промпт «${prompt}», пресет ${preset}, рендер ${doRender ? quality : "выкл"} → ${outDir}`);

const rows: Row[] = [];
for (const [i, f] of files.entries()) {
  const t0 = Date.now();
  const row: Row = { file: f, wall_s: 0 };
  rows.push(row);
  console.log(`\n[${i + 1}/${files.length}] ${f}`);
  try {
    const job = await createJob(path.join(dir, f), { prompt, preset });
    row.job = job.id;
    const media = await runStep(job.id, "ingest", () => ingest(job.id, path.join(dir, f)));
    row.duration = media.duration;
    const tu = Date.now();
    const u = await runStep(job.id, "understand", () => understand(job.id, media, {}));
    row.understand_s = (Date.now() - tu) / 1000;
    row.phrases = u.phrases;
    console.log(`  ${media.duration.toFixed(0)}s, речь ${u.transcriber?.language ?? "—"}, ${u.phrases} фраз, анализ ${row.understand_s.toFixed(0)}s`);
    const p = await runStep(job.id, "plan", () => plan(job.id, { instruction: prompt, preset }));
    row.plan_status = p.report.status;
    row.plan_calls = p.report.calls;
    row.plan_repairs = p.report.repairs;
    row.plan_usd = p.report.usd;
    row.outputs = p.report.outputs.map((o) => ({ id: o.id, duration_s: o.duration_s, target_s: o.target_s, warnings: p.report.issues.filter((x) => x.output === o.id).length }));
    console.log(`  план: ${p.report.status}, ${p.report.calls} запрос(ов), ${p.report.repairs} испр., ≈$${p.report.usd.toFixed(2)}; ${row.outputs.map((o) => `${o.id} ${o.duration_s}s`).join(", ")}`);
    const c = await runStep(job.id, "cut", () => cut(job.id, p.edl!, media, { transcript: u.transcript, snap: true }));
    row.cut_warnings = c.outputs.flatMap((o) => o.warnings.filter((w) => !/auto_face/.test(w)));
    if (doRender) {
      const tr = Date.now();
      const renderer = new HyperFramesRenderer();
      await renderer.prepare();
      const r = await runStep(job.id, "render", () => renderOutputs(job.id, { renderer, quality, only: c.outputs.filter((o) => o.status === "ok").map((o) => o.id), edl: p.edl! }));
      row.render_s = (Date.now() - tr) / 1000;
      row.render_status = r.partial ? "partial" : "ok";
      console.log(`  рендер: ${r.outputs.map((o) => `${o.id} ${o.status}`).join(", ")} за ${row.render_s.toFixed(0)}s`);
    }
  } catch (err) {
    row.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.log(`  ✖ ${row.error}`);
  }
  row.wall_s = (Date.now() - t0) / 1000;
  await fs.writeFile(path.join(outDir, "summary.json"), JSON.stringify({ prompt, preset, quality, rows }, null, 2));
}

const md = [
  `# Batch ${stamp} — «${prompt}» (${preset}, ${doRender ? quality : "без рендера"})`,
  "",
  "| файл | job | длит. | анализ | план | $ | выходы | предупр. нарезки | рендер | всего | ошибка |",
  "|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.file} | ${r.job ?? ""} | ${r.duration?.toFixed(0) ?? ""}s | ${r.understand_s?.toFixed(0) ?? ""}s | ${r.plan_status ?? ""} ${r.plan_calls ?? ""}/${r.plan_repairs ?? ""} | ${r.plan_usd?.toFixed(2) ?? ""} | ${(r.outputs ?? []).map((o) => `${o.id} ${o.duration_s}s${o.target_s ? `/${o.target_s}` : ""}`).join("<br>")} | ${r.cut_warnings?.length ?? ""} | ${r.render_status ?? ""} ${r.render_s?.toFixed(0) ?? ""}s | ${r.wall_s.toFixed(0)}s | ${r.error ?? ""} |`),
  "",
  `Итого: ${rows.filter((r) => !r.error).length}/${rows.length} без ошибок, ${rows.reduce((s, r) => s + r.wall_s, 0).toFixed(0)}s, ≈$${rows.reduce((s, r) => s + (r.plan_usd ?? 0), 0).toFixed(2)} на планы.`,
  "",
  "Чек-лист просмотра — docs/stage6-checklist.md; контактные листы: `npx tsx tests/contact-sheet.ts <job>`.",
];
await fs.writeFile(path.join(outDir, "summary.md"), md.join("\n"));
console.log(`\nсводка: ${path.join(outDir, "summary.md")}`);
