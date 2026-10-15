import path from "node:path";
import { jobDir, loadJob, writeJson } from "../lib/workspace.ts";
import { JobSchema } from "../schemas/index.ts";

/** Switches a job's design preset (a bot job that turned out to be sports footage renders with sport_highlights). */
export async function updateJobPreset(jobId: string, preset: string) {
  const job = await loadJob(jobId);
  job.preset = preset;
  await writeJson(path.join(jobDir(jobId), "job.json"), JobSchema, job);
}
