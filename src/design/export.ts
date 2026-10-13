// Exports a renderer-independent design job for one output: the output timeline
// (words/phrases/titles in output seconds), the preset's design spec and media paths.
//   npx tsx src/design/export.ts <job_id> <output_id> [out.json] [--translate]
import path from "node:path";
import fs from "node:fs/promises";
import { exists, jobDir, readJson } from "../lib/workspace.ts";
import { EdlSchema, MediaSchema, TranscriptSchema, PresetSchema, JobSchema, ScenesSchema, type Scenes } from "../schemas/index.ts";
import { CutReportSchema, clipFocus } from "../cut/index.ts";
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
  warnings: string[];
  /** vertical centre of the face/subject over the output's clips (0 = top), from the vision step; absent without focus data */
  face_y?: number;
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
  // no transcript (e.g. --skip-understand) → no captions, the overlay still gets titles/outro
  const transcriptFile = path.join(dir, "transcript.json");
  const transcript = (await exists(transcriptFile)) ? await readJson(transcriptFile, TranscriptSchema) : { language: "unknown", segments: [] };
  const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
  const output = edl.outputs.find((o) => o.id === outputId);
  if (!output) throw new Error(`output ${outputId} not in edl.json (${edl.outputs.map((o) => o.id).join(", ")})`);
  const { preset } = await loadPreset(job.preset ?? "bold_pop");
  const design = PresetSchema.parse(preset).design;
  // the cut may have snapped/clamped clip edges: build the timeline from what was actually cut
  const cutFile = path.join(dir, "cut.json");
  const cutRecord = (await exists(cutFile)) ? (await readJson(cutFile, CutReportSchema)).outputs.find((o) => o.id === outputId) : undefined;
  const usedClips = cutRecord?.status === "ok" && cutRecord.clips ? cutRecord.clips : output.clips;
  const timeline = buildDesignTimeline(output, transcript, media, cutRecord?.status === "ok" ? cutRecord.clips : undefined);
  // the house style decides the title look: an EDL title left at the schema default ("hero") follows the preset
  if (preset.title_style === "card") timeline.titles = timeline.titles.map((t) => (t.style === "hero" ? { ...t, style: "card" } : t));
  const scenesFile = path.join(dir, "scenes.json");
  const faceY = (await exists(scenesFile)) ? faceCentreY(usedClips, await readJson(scenesFile, ScenesSchema)) : undefined;

  const target = output.captions.enabled ? (output.captions.language ?? null) : null;
  let translated = false;
  const warnings: string[] = [];
  if (opts.translate && target && timeline.phrases.some((p) => p.lang !== target)) {
    try {
      const llm = opts.llm ?? selectStructuredLlm();
      const translations = await translatePhrases(jobId, timeline.phrases, target, llm, { model: opts.model });
      timeline.phrases = applyTranslations(timeline.phrases, translations, target);
      translated = translations.size > 0;
    } catch (err) {
      // captions stay in the spoken language rather than failing the whole output
      warnings.push(`перевод субтитров на ${target} не выполнен: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  const pages = timeline.phrases.flatMap((p) => paginate(p, design.captions.max_words, design.captions.max_chars).map((words) => ({ start: words[0].start, end: words[words.length - 1].end, words })));
  return { job_id: jobId, rough_path: path.join(dir, `rough_${outputId}.mp4`), timeline, pages, design, preset: preset.name, captions_language: target, translated, warnings, ...(faceY !== undefined ? { face_y: faceY } : {}) };
}

/** Duration-weighted mean of the clips' focus y (each clip's focus = overlap-weighted scene focus); undefined without any focus. */
export function faceCentreY(clips: { src_start: number; src_end: number }[], scenes: Scenes): number | undefined {
  let sum = 0;
  let weight = 0;
  for (const c of clips) {
    const f = clipFocus(c, scenes);
    if (!f) continue;
    const w = Math.max(0, c.src_end - c.src_start);
    sum += f.y * w;
    weight += w;
  }
  return weight > 0 ? Math.round((sum / weight) * 1000) / 1000 : undefined;
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
