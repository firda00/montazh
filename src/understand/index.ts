import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { jobDir, writeJson } from "../lib/workspace.ts";
import { HighlightsSchema, ScenesSchema, TranscriptSchema, type Highlights, type Media, type Scenes, type Transcript } from "../schemas/index.ts";
import { loudnessTimeline, type LoudnessPoint } from "./loudness.ts";
import { detectShots, extractShotFrames, type Shot } from "./shots.ts";
import { selectVisionProvider, type AnalysisChunk, type VisionChoice } from "./vision/index.ts";
import { transcribe, type TimestampMethod } from "./whisper.ts";

export const UnderstandReportSchema = z.object({
  transcriber: z
    .object({
      engine: z.string(),
      model: z.string(),
      method: z.string(),
      language: z.string(),
      languages: z.array(z.string()),
      speech_chunks: z.number().int(),
      wall_seconds: z.number(),
    })
    .nullable(),
  vision: z.object({ provider: z.string(), note: z.string() }),
  shots: z.number().int(),
  chunks: z.array(z.object({ index: z.number(), start: z.number(), end: z.number() })),
  phrases: z.number().int(),
  words: z.number().int(),
  warnings: z.array(z.string()),
  wall_seconds: z.number(),
});
export type UnderstandReport = z.infer<typeof UnderstandReportSchema>;

export interface UnderstandOptions {
  threads?: number;
  language?: string;
  method?: TimestampMethod;
  vision?: VisionChoice;
  chunkSeconds?: number;
  sceneThreshold?: number;
}

/** Groups shots into analysis chunks of ~target seconds, cutting only on shot boundaries. */
export function makeChunks(shots: Shot[], target = 180, max = 300): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  let start = shots[0]?.start ?? 0;
  for (const [i, s] of shots.entries()) {
    const last = i === shots.length - 1;
    // a single very long shot is split at `max` regardless of boundaries
    while (s.end - start > max) {
      chunks.push({ start, end: start + max });
      start += max;
    }
    if (last || s.end - start >= target) {
      if (s.end > start) chunks.push({ start, end: s.end });
      start = s.end;
    }
  }
  return chunks;
}

export async function understand(jobId: string, media: Media, opts: UnderstandOptions = {}) {
  const dir = jobDir(jobId);
  const warnings: string[] = [];
  const t0 = Date.now();

  // 1. speech → words with timestamps
  let transcript: Transcript = { language: "unknown", segments: [] };
  let transcriber: UnderstandReport["transcriber"] = null;
  if (media.audio_path) {
    try {
      const r = await transcribe(media.audio_path, media.duration, dir, { threads: opts.threads, language: opts.language, method: opts.method });
      transcript = r.transcript;
      transcriber = {
        engine: "whisper.cpp",
        model: r.model,
        method: r.method,
        language: transcript.language,
        languages: [...new Set(r.chunks.map((c) => c.language))],
        speech_chunks: r.chunks.length,
        wall_seconds: r.wall_seconds,
      };
      warnings.push(...r.warnings);
      await addCost(jobId, {
        step: "understand",
        provider: "whisper.cpp (local)",
        model: r.model,
        units: { audio_seconds: media.duration, wall_seconds: r.wall_seconds },
        usd: 0,
      });
    } catch (err) {
      warnings.push(`transcription failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    warnings.push("no audio track — transcript is empty");
  }
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, transcript);

  // 2. shot boundaries + one frame per shot
  const shots = await detectShots(media.normalized_path, media.duration, opts.sceneThreshold);
  await extractShotFrames(media.normalized_path, shots, dir);

  // 3. loudness curve (for highlight ranking)
  let loudness: LoudnessPoint[] = [];
  if (media.audio_path) {
    try {
      loudness = await loudnessTimeline(media.audio_path);
    } catch (err) {
      warnings.push(`loudness analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. vision model per chunk
  const { provider, note } = selectVisionProvider(opts.vision);
  const chunks = makeChunks(shots, opts.chunkSeconds);
  const scenes: Scenes = [];
  const highlights: Highlights = [];
  for (const [index, c] of chunks.entries()) {
    const chunk: AnalysisChunk = {
      index,
      start: c.start,
      end: c.end,
      shots: shots.filter((s) => s.start < c.end && s.end > c.start),
      phrases: transcript.segments.filter((p) => p.start < c.end && p.end > c.start),
    };
    try {
      const r = await provider.analyze(chunk, { media, language: transcript.language, loudness });
      scenes.push(...r.scenes);
      highlights.push(...r.highlights);
      await addCost(jobId, { step: "understand", provider: provider.name, model: r.cost.model, units: r.cost.units, usd: r.cost.usd });
    } catch (err) {
      warnings.push(`chunk ${index} (${c.start}-${c.end}s) analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  highlights.sort((a, b) => b.score - a.score);
  await writeJson(path.join(dir, "scenes.json"), ScenesSchema, scenes);
  await writeJson(path.join(dir, "highlights.json"), HighlightsSchema, highlights);

  const report = await writeJson(path.join(dir, "understand.json"), UnderstandReportSchema, {
    transcriber,
    vision: { provider: provider.name, note },
    shots: shots.length,
    chunks: chunks.map((c, index) => ({ index, ...c })),
    phrases: transcript.segments.length,
    words: transcript.segments.reduce((n, s) => n + s.words.length, 0),
    warnings,
    wall_seconds: (Date.now() - t0) / 1000,
  });
  const partial = warnings.some((w) => w.includes("failed"));
  return { ...report, transcript, scenes, highlights, partial };
}
