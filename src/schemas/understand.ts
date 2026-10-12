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
      speaker: z.string().optional(), // S1, S2… from speaker labelling (S1 talks the most)
    }),
  ),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** speakers.json — who talks how much; ids match transcript segments' `speaker`. */
export const SpeakersSchema = z.object({
  engine: z.string(),
  speakers: z.array(
    z.object({
      id: z.string(),
      seconds: z.number(),
      phrases: z.number().int(),
      first_at: z.number(),
      sample: z.string(),
    }),
  ),
});
export type Speakers = z.infer<typeof SpeakersSchema>;

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
    /** where the main face/subject sits, as fractions of the frame — drives crop: auto_face; absent from the stub */
    focus: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).optional(),
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
