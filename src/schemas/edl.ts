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
