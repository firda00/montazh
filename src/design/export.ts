// Exports a renderer-independent design job for one output: the output timeline
// (words/phrases/titles in output seconds), the preset's design spec and media paths.
//   npx tsx src/design/export.ts <job_id> <output_id> [out.json]
import path from "node:path";
import fs from "node:fs/promises";
import { jobDir, readJson } from "../lib/workspace.ts";
import { EdlSchema, MediaSchema, TranscriptSchema, PresetSchema, JobSchema } from "../schemas/index.ts";
import { loadPreset } from "../plan/presets.ts";
import { buildDesignTimeline, paginate, type DesignTimeline } from "./timeline.ts";
import type { DesignSpec } from "../schemas/index.ts";

export interface DesignJob {
  job_id: string;
  rough_path: string;
  timeline: DesignTimeline;
  pages: { start: number; end: number; words: DesignTimeline["phrases"][number]["words"] }[];
  design: DesignSpec;
  preset: string;
}

export async function exportDesignJob(jobId: string, outputId: string): Promise<DesignJob> {
  const dir = jobDir(jobId);
  const job = await readJson(path.join(dir, "job.json"), JobSchema);
  const media = await readJson(path.join(dir, "media.json"), MediaSchema);
  const transcript = await readJson(path.join(dir, "transcript.json"), TranscriptSchema);
  const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
  const output = edl.outputs.find((o) => o.id === outputId);
  if (!output) throw new Error(`output ${outputId} not in edl.json (${edl.outputs.map((o) => o.id).join(", ")})`);
  const { preset } = await loadPreset(job.preset ?? "bold_pop");
  const design = PresetSchema.parse(preset).design;
  const timeline = buildDesignTimeline(output, transcript, media);
  const pages = timeline.phrases.flatMap((p) => paginate(p, design.captions.max_words, design.captions.max_chars).map((words) => ({ start: words[0].start, end: words[words.length - 1].end, words })));
  return { job_id: jobId, rough_path: path.join(dir, `rough_${outputId}.mp4`), timeline, pages, design, preset: preset.name };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("design", "export.ts"))) {
  const [jobId, outputId, out] = process.argv.slice(2);
  if (!jobId || !outputId) throw new Error("usage: tsx src/design/export.ts <job_id> <output_id> [out.json]");
  const job = await exportDesignJob(jobId, outputId);
  const text = JSON.stringify(job, null, 2);
  if (out) await fs.writeFile(out, text);
  else process.stdout.write(text);
}
