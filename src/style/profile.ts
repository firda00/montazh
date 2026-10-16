import path from "node:path";
import { z } from "zod";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import type { Preset } from "../schemas/index.ts";
import { StyleDNASchema } from "./dna.ts";
import { applyStyleToPreset, mapStyle, type StyleMapping } from "./map.ts";

/** What was measured locally on the reference (ffmpeg scene cuts, whisper words, loudness, signalstats). */
export const MeasuredSchema = z.object({
  duration: z.number(),
  /** cut times (s) from the scene detector */
  cuts: z.array(z.number()),
  total_cuts: z.number().int(),
  /** average shot length over the whole reel, s */
  asl: z.number(),
  hook_cuts: z.number().int(),
  /** average shot length inside the first 3 s */
  hook_asl: z.number(),
  /** average shot length after the first 3 s */
  body_asl: z.number(),
  speech: z
    .object({
      words: z.number().int(),
      language: z.string(),
      /** words per minute of speaking time (first word → last word) */
      wpm: z.number(),
      /** gaps between consecutive words, ms */
      pause_median_ms: z.number(),
      pause_p90_ms: z.number(),
      /** gaps longer than 300 ms per minute of speech (a jump-cut edit has almost none) */
      long_pauses_per_min: z.number(),
      /** share of the reel covered by words */
      speech_ratio: z.number(),
      /** hesitations / fillers heard (э, ну, um…) */
      fillers: z.number().int(),
    })
    .nullable(),
  audio: z
    .object({
      /** integrated loudness of the speech parts and of the gaps between words, LUFS */
      speech_lufs: z.number().nullable(),
      gap_lufs: z.number().nullable(),
      /** the gaps are loud: something (music) keeps playing under and between the words */
      music_likely: z.boolean(),
    })
    .nullable(),
  /**
   * stage 23: music under the voice from the audio itself (src/audio/musicdetect.ts — tonality of the quiet moments,
   * silent gaps); beats Gemini's ear. Absent in profiles made before stage 23.
   */
  music: z
    .object({
      version: z.string(),
      verdict: z.enum(["music", "no_music", "uncertain"]),
      score: z.number(),
      floor_tonality: z.number(),
      gap_db: z.number().nullable(),
      reasons: z.array(z.string()),
    })
    .optional(),
  picture: z
    .object({
      /** mean luma 0–255, mean luma spread (YHIGH − YLOW), mean saturation 0–~180 (signalstats) */
      yavg: z.number(),
      yrange: z.number(),
      satavg: z.number(),
      width: z.number().int(),
      height: z.number().int(),
    })
    .nullable(),
});
export type Measured = z.infer<typeof MeasuredSchema>;

export const ProvenanceSchema = z.enum(["measured", "gemini", "default", "merged"]);

export const StyleProfileSchema = z.object({
  version: z.literal(1).default(1),
  /** content key: sha256(size + first 512 KB + last 512 KB) */
  key: z.string(),
  source: z.object({ kind: z.enum(["file", "url", "telegram"]), name: z.string(), url: z.string().optional(), file_unique_id: z.string().optional() }),
  created_at: z.string(),
  dna: StyleDNASchema,
  measured: MeasuredSchema,
  /** where each decision came from (DNA path → measured / gemini / default / merged) */
  provenance: z.record(z.string(), ProvenanceSchema).default({}),
  gemini: z
    .object({ model: z.string(), requests: z.number(), input_tokens: z.number(), output_tokens: z.number(), usd: z.number(), priced: z.boolean(), seconds: z.number() })
    .nullable()
    .default(null),
  fixed: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  timings: z.record(z.string(), z.number()).default({}),
});
export type StyleProfile = z.infer<typeof StyleProfileSchema>;

/** workspace/<job>/style.json — its presence switches a job to the reference style */
export const STYLE_FILE = "style.json";

export async function loadJobStyle(jobId: string): Promise<{ profile: StyleProfile; mapping: StyleMapping } | null> {
  const f = path.join(jobDir(jobId), STYLE_FILE);
  if (!(await exists(f))) return null;
  let profile = await readJson(f, StyleProfileSchema);
  // a style attached before stage 23: re-decide its music with the stage-23 rule (no local evidence → no bed)
  if (!profile.measured.music) profile = (await (await import("./extract.ts")).refreshMusic(profile)).profile;
  return { profile, mapping: mapStyle(profile.dna) };
}

export async function writeJobStyle(jobId: string, profile: StyleProfile): Promise<void> {
  await writeJson(path.join(jobDir(jobId), STYLE_FILE), StyleProfileSchema, profile);
}

/** The preset a stage should use: the job's preset, with the reference style on top when the job has one. */
export async function styledPreset(jobId: string, preset: Preset): Promise<{ preset: Preset; mapping: StyleMapping | null }> {
  const s = await loadJobStyle(jobId);
  if (!s) return { preset, mapping: null };
  return { preset: applyStyleToPreset(preset, s.mapping), mapping: s.mapping };
}

/**
 * Attaches a reference style to a job: style.json + the Gemini analysis in the job's cost.json (a cache hit is free
 * and logs nothing). The reference analysis is part of the job — no separate charge in the bot.
 */
export async function attachStyle(jobId: string, profile: StyleProfile, cached: boolean): Promise<void> {
  await writeJobStyle(jobId, profile);
  if (!cached && profile.gemini) {
    const { addCost } = await import("../lib/cost.ts");
    const g = profile.gemini;
    await addCost(jobId, { step: "understand", provider: "gemini-style", model: g.model, units: { requests: g.requests, input_tokens: g.input_tokens, output_tokens: g.output_tokens, ...(g.priced ? {} : { unpriced: 1 }) }, usd: g.usd });
  }
}
