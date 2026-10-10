// Exports a renderer-independent design job for one output: the output timeline
// (words/phrases/titles in output seconds), the preset's design spec and media paths.
//   npx tsx src/design/export.ts <job_id> <output_id> [out.json] [--translate]
import path from "node:path";
import fs from "node:fs/promises";
import { jobDir, readJson } from "../lib/workspace.ts";
import { EdlSchema, MediaSchema, TranscriptSchema, PresetSchema, JobSchema } from "../schemas/index.ts";
import { loadPreset } from "../plan/presets.ts";
import { buildDesignTimeline, paginate, type DesignTimeline, type OutPhrase } from "./timeline.ts";
import { applyTranslations, translatePhrases } from "./translate.ts";
import { selectStructuredLlm, type StructuredFn } from "../lib/llm.ts";
import type { DesignSpec } from "../schemas/index.ts";

export interface DesignJob {
  job_id: string;
  rough_path: string;
  timeline: DesignTimeline;
  pages: { start: number; end: number; words: OutPhrase["words"] }[];
  design: DesignSpec;
  preset: string;
  captions_language: string | null;
  translated: boolean;
}

export interface ExportOptions {
  /** translate captions into output.captions.language when the speech is in another language */
  translate?: boolean;
  llm?: StructuredFn;
  model?: string;
}

export async function exportDesignJob(jobId: string, outputId: string, opts: ExportOptions = {}): Promise<DesignJob> {
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

  const target = output.captions.enabled ? (output.captions.language ?? null) : null;
  let translated = false;
  if (opts.translate && target && timeline.phrases.some((p) => p.lang !== target)) {
    const llm = opts.llm ?? selectStructuredLlm();
    const translations = await translatePhrases(jobId, timeline.phrases, target, llm, { model: opts.model });
    timeline.phrases = applyTranslations(timeline.phrases, translations, target);
    translated = translations.size > 0;
  }

  const pages = timeline.phrases.flatMap((p) => paginate(p, design.captions.max_words, design.captions.max_chars).map((words) => ({ start: words[0].start, end: words[words.length - 1].end, words })));
  return { job_id: jobId, rough_path: path.join(dir, `rough_${outputId}.mp4`), timeline, pages, design, preset: preset.name, captions_language: target, translated };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("design", "export.ts"))) {
  const args = process.argv.slice(2);
  const translate = args.includes("--translate");
  const [jobId, outputId, out] = args.filter((a) => !a.startsWith("--"));
  if (!jobId || !outputId) throw new Error("usage: tsx src/design/export.ts <job_id> <output_id> [out.json] [--translate]");
  const job = await exportDesignJob(jobId, outputId, { translate });
  const text = JSON.stringify(job, null, 2);
  if (out) await fs.writeFile(out, text);
  else process.stdout.write(text);
}
