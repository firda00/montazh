import { z } from "zod";

export const MediaSchema = z.object({
  source_path: z.string(),
  normalized_path: z.string(),
  audio_path: z.string().nullable(),
  duration: z.number().positive(),
  fps: z.number().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  has_audio: z.boolean(),
  source: z.object({
    fps: z.number(),
    width: z.number().int(),
    height: z.number().int(),
    video_codec: z.string().nullable(),
    audio_codec: z.string().nullable(),
    rotation: z.number(),
  }),
});
export type Media = z.infer<typeof MediaSchema>;
