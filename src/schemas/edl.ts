import { z } from "zod";

export const AspectSchema = z.enum(["9:16", "1:1", "16:9"]);
export type Aspect = z.infer<typeof AspectSchema>;

export const ClipSchema = z
  .object({
    src_start: z.number().min(0),
    src_end: z.number().positive(),
    speed: z.number().min(0.25).max(4).default(1),
    // auto_face: keep the speaker in frame (stage 1 falls back to center until face tracking lands)
    crop: z.enum(["center", "auto_face"]).default("center"),
    /** gain on the clip's own audio (highlights: court noise low under the music, people talking at 1) */
    volume: z.number().min(0).max(4).optional(),
    /**
     * punch-in toward a point (fractions of the cropped frame): scale goes from `from` to `to` over
     * `ease` seconds of OUTPUT time after `at` (ease-out cubic), then holds
     */
    zoom: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), from: z.number().min(1).max(3), to: z.number().min(1).max(3), ease: z.number().min(0).max(5).default(0.3), at: z.number().min(0).default(0) })
      .optional(),
    /** accents at OUTPUT seconds from the clip start: a short white flash, a decaying shake */
    flash: z.array(z.number().min(0)).optional(),
    shake: z.array(z.number().min(0)).optional(),
    /** cut from the original file at its full frame rate (smooth slow motion from 50/60 fps sources) */
    hfr: z.boolean().optional(),
  })
  .refine((c) => c.src_end > c.src_start, { message: "src_end must be greater than src_start" });
export type Clip = z.infer<typeof ClipSchema>;

export const TitleSchema = z.object({
  at: z.number().min(0),
  duration: z.number().positive().optional(),
  text: z.string().min(1),
  style: z.string().default("hero"),
});

export const OutputSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "id must be filename-safe"),
  aspect: AspectSchema,
  target_duration: z.number().positive().optional(),
  clips: z.array(ClipSchema).min(1),
  captions: z
    .object({
      enabled: z.boolean(),
      language: z.string().optional(),
      style: z.string().optional(),
    })
    .default({ enabled: false }),
  titles: z.array(TitleSchema).default([]),
  music: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  /** sound design decided at plan time (highlights): effects on the output timeline and the music bed */
  sfx: z.array(z.object({ t: z.number().min(0), kind: z.string(), gain: z.number().optional() })).optional(),
  audio: z
    .object({
      /** music file (already chosen, e.g. because the cuts are snapped to its beats) */
      music: z.string().optional(),
      /** seconds into the music file where the bed starts */
      music_offset: z.number().min(0).default(0),
      /** music level before the final −14 LUFS (LUFS) */
      music_lufs: z.number().optional(),
      /** gain on the video's own audio in the mix (dB) */
      orig_gain_db: z.number().default(0),
      /** output ranges where people talk: the music dips there (instead of side-chain ducking on every bounce) */
      duck: z.array(z.object({ start: z.number(), end: z.number() })).default([]),
    })
    .optional(),
  /** colour grade of every clip (reference style): ffmpeg eq + an optional colour-balance tint */
  grade: z
    .object({ contrast: z.number().min(0.5).max(2), saturation: z.number().min(0).max(3), brightness: z.number().min(-0.3).max(0.3), tint: z.string().default("") })
    .optional(),
  /** music level under speech relative to the voice (reference style), dB; null = no side-chain ducking */
  music_duck_db: z.number().nullable().optional(),
  transitions: z.enum(["cut"]).default("cut"),
});
export type Output = z.infer<typeof OutputSchema>;

export const EdlSchema = z
  .object({
    outputs: z.array(OutputSchema).min(1),
    reasoning: z.string().default(""),
  })
  .refine((e) => new Set(e.outputs.map((o) => o.id)).size === e.outputs.length, {
    message: "output ids must be unique",
  });
export type Edl = z.infer<typeof EdlSchema>;
