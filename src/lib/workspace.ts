import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { JobSchema, CostSchema, type Job, type StepName, type StepState } from "../schemas/index.ts";

export const WORKSPACE_ROOT = path.resolve(process.env.VEDIT_WORKSPACE || "workspace");

export function jobDir(jobId: string) {
  return path.join(WORKSPACE_ROOT, jobId);
}

export async function readJson<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  const raw = await fs.readFile(file, "utf8");
  const parsed = schema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`${path.basename(file)} is invalid:\n${formatIssues(parsed.error)}`);
  }
  return parsed.data;
}

export async function writeJson<T extends z.ZodType>(file: string, schema: T, data: z.input<T>): Promise<z.infer<T>> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`refusing to write invalid ${path.basename(file)}:\n${formatIssues(parsed.error)}`);
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  // write-then-rename so a crash never leaves a half-written JSON in the cache
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(parsed.data, null, 2));
  await fs.rename(tmp, file);
  return parsed.data;
}

export function formatIssues(err: z.ZodError) {
  return err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

export async function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

function newJobId() {
  const d = new Date();
  const stamp = d.toISOString().slice(0, 10).replace(/-/g, "");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export async function createJob(source: string, extra: Partial<Pick<Job, "prompt" | "preset">> = {}): Promise<Job> {
  const id = newJobId();
  await fs.mkdir(jobDir(id), { recursive: true });
  const job: Job = { id, created_at: new Date().toISOString(), source: path.resolve(source), steps: {}, ...extra };
  await writeJson(path.join(jobDir(id), "job.json"), JobSchema, job);
  await writeJson(path.join(jobDir(id), "cost.json"), CostSchema, { total_usd: 0, entries: [] });
  return job;
}

export async function loadJob(jobId: string): Promise<Job> {
  const file = path.join(jobDir(jobId), "job.json");
  if (!(await exists(file))) throw new Error(`job ${jobId} not found in ${WORKSPACE_ROOT}`);
  return readJson(file, JobSchema);
}

export async function updateStep(jobId: string, step: StepName, patch: Partial<StepState>) {
  const job = await loadJob(jobId);
  const prev: StepState = job.steps[step] ?? { status: "pending" };
  job.steps[step] = { ...prev, ...patch };
  await writeJson(path.join(jobDir(jobId), "job.json"), JobSchema, job);
  return job;
}

/**
 * Runs one pipeline step with bookkeeping in job.json. A failure is recorded and
 * rethrown, so callers decide whether the rest of the pipeline can continue.
 */
export async function runStep<T>(jobId: string, step: StepName, fn: () => Promise<T>): Promise<T> {
  await updateStep(jobId, step, { status: "running", started_at: new Date().toISOString(), error: undefined });
  try {
    const result = await fn();
    const partial = (result as { partial?: boolean } | undefined)?.partial === true;
    await updateStep(jobId, step, { status: partial ? "partial" : "ok", finished_at: new Date().toISOString() });
    return result;
  } catch (err) {
    await updateStep(jobId, step, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
