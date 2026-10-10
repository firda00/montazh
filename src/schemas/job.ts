import { z } from "zod";

export const StepNameSchema = z.enum(["ingest", "understand", "plan", "cut", "design", "render", "revise"]);
export type StepName = z.infer<typeof StepNameSchema>;

export const StepStateSchema = z.object({
  status: z.enum(["pending", "running", "ok", "failed", "partial"]),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  error: z.string().optional(),
  outputs: z.record(z.string(), z.string()).optional(),
});
export type StepState = z.infer<typeof StepStateSchema>;

export const JobSchema = z.object({
  id: z.string(),
  created_at: z.string(),
  source: z.string(),
  prompt: z.string().optional(),
  preset: z.string().optional(),
  steps: z.partialRecord(StepNameSchema, StepStateSchema),
});
export type Job = z.infer<typeof JobSchema>;

export const CostEntrySchema = z.object({
  at: z.string(),
  step: StepNameSchema,
  provider: z.string(),
  model: z.string(),
  units: z.record(z.string(), z.number()),
  usd: z.number().min(0),
});
export const CostSchema = z.object({
  total_usd: z.number(),
  entries: z.array(CostEntrySchema),
});
export type Cost = z.infer<typeof CostSchema>;
