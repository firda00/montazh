import { z } from "zod";

// Contracts for stage 2 (understand). Defined now so later modules share one source of truth.

export const WordSchema = z.object({ w: z.string(), start: z.number(), end: z.number() });

export const TranscriptSchema = z.object({
  language: z.string(),
  segments: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      text: z.string(),
      words: z.array(WordSchema),
      lang: z.string().optional(), // per-phrase language when the video mixes languages
    }),
  ),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

export const ScenesSchema = z.array(
  z.object({
    start: z.number(),
    end: z.number(),
    description: z.string(),
    objects: z.array(z.string()),
    people_count: z.number().int().min(0),
    emotion: z.string(),
    shot_type: z.string(),
    quality_score: z.number().min(0).max(1),
  }),
);
export type Scenes = z.infer<typeof ScenesSchema>;

export const HighlightsSchema = z.array(
  z.object({
    start: z.number(),
    end: z.number(),
    reason: z.string(),
    score: z.number().min(0).max(1),
  }),
);
export type Highlights = z.infer<typeof HighlightsSchema>;
