import fs from "node:fs/promises";
import path from "node:path";
import { exists, jobDir, loadJob, readJson, writeJson } from "../lib/workspace.ts";
import { EdlSchema, ReviseReportSchema, type Edl, type ReviseReport } from "../schemas/index.ts";
import { PlanError } from "./backend/types.ts";
import { diffEdl, needsCut } from "./diff.ts";
import { buildReport, loadPlanInputs, runPlanning, type PlanOptions } from "./index.ts";
import type { LoopTask } from "./loop.ts";

export interface ReviseOptions extends Omit<PlanOptions, "instruction"> {
  edit: string;
}

export interface ReviseResult {
  report: ReviseReport;
  edl: Edl;
  affected: string[];
  partial: boolean;
}

/** REVISE: text edit + current edl.json → new edl.json (+ versioned backup, diff, affected outputs). */
export async function revise(jobId: string, opts: ReviseOptions): Promise<ReviseResult> {
  const startedAt = Date.now();
  const dir = jobDir(jobId);
  const job = await loadJob(jobId);
  const edlFile = path.join(dir, "edl.json");
  if (!(await exists(edlFile))) throw new PlanError(`в задаче ${jobId} нет edl.json — сначала vedit plan ${jobId} -p "…"`, "missing_inputs");
  const current = await readJson(edlFile, EdlSchema);
  const inputs = await loadPlanInputs(jobId, opts.preset ?? job.preset ?? "bold_pop");

  const task: LoopTask = { kind: "revise", instruction: opts.edit, currentEdl: current, presetName: inputs.presetName };
  const run = await runPlanning({ jobId, ctx: inputs.ctx, task, opts: { ...opts, instruction: opts.edit }, step: "revise" });
  const base = buildReport("revise", run.loop, { backend: run.backend, contract: run.contract, effort: run.effort, ctx: inputs.ctx, instruction: opts.edit, preset: inputs.presetName, toolCalls: run.toolCalls, warnings: [...inputs.warnings, ...run.warnings], startedAt });

  if (!run.loop.resolved?.edl || base.status === "failed") {
    const report = ReviseReportSchema.parse({ ...base, edit: opts.edit, diff: diffEdl(current, current), affected: [], previous_edl: "edl.json" });
    await writeJson(path.join(dir, "revise.json"), ReviseReportSchema, report);
    if (run.loop.draft) await fs.writeFile(path.join(dir, "edl.draft.json"), JSON.stringify(run.loop.draft, null, 2));
    throw new PlanError(report.error ?? "правка не применена", (report.error_code as PlanError["code"] | undefined) ?? "invalid", { report });
  }

  // a partial result must not lose an output the model failed to re-express: keep its previous version
  const next = { ...run.loop.resolved.edl };
  const kept: string[] = [];
  for (const o of current.outputs) {
    const attempted = run.loop.resolved.outputs.some((r) => r.id === o.id);
    const survived = next.outputs.some((r) => r.id === o.id);
    if (attempted && !survived) {
      next.outputs.push(o);
      kept.push(o.id);
    }
  }
  next.outputs.sort((a, b) => current.outputs.findIndex((o) => o.id === a.id) - current.outputs.findIndex((o) => o.id === b.id));
  const warnings = [...base.warnings, ...kept.map((id) => `${id}: правка не применена (ошибки валидации), оставлен прежний вариант`)];

  // keep the previous plan as edl.v<N>.json
  let n = 1;
  while (await exists(path.join(dir, `edl.v${n}.json`))) n += 1;
  const backup = `edl.v${n}.json`;
  await fs.copyFile(edlFile, path.join(dir, backup));
  const edl = await writeJson(edlFile, EdlSchema, next);
  const diff = diffEdl(current, edl);
  const affected = needsCut(diff);
  const report = ReviseReportSchema.parse({ ...base, warnings, edit: opts.edit, diff, affected, previous_edl: backup });
  await writeJson(path.join(dir, "revise.json"), ReviseReportSchema, report);
  return { report, edl, affected, partial: report.status === "partial" };
}
