import { z } from "zod";

/**
 * Files exchanged with the Colab notebook (tools/avatar/colab_vedit_avatar.ipynb → tools/avatar/vedit_avatar.py):
 *   avatar_job.zip    = script.json + portrait.png [+ voice_ref.wav | speech_in.wav] + vedit_avatar.py
 *   avatar_result.zip = avatar.mp4 + speech.wav + meta.json   (voice only: speech.wav + meta.json)
 * and the job's own record of the round trip (workspace/<job>/avatar.json).
 */

/** Languages Chatterbox Multilingual speaks (chatterbox-tts 0.1.7). Others need the user's own recording. */
export const TTS_LANGUAGES = ["ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"] as const;

export const AvatarModeSchema = z.enum(["avatar", "voice_only"]);
export type AvatarMode = z.infer<typeof AvatarModeSchema>;

export const TTS_DEFAULTS = { exaggeration: 0.5, cfg_weight: 0.4, line_pause_ms: 450, sentence_pause_ms: 220 };
export const ANIMATE_DEFAULTS = { cfg_scale: 2.0, max_chunk_seconds: 20 };

export const AvatarScriptSchema = z
  .object({
    version: z.literal(1),
    /** vedit job id the result belongs to */
    job: z.string().min(1),
    title: z.string().default(""),
    language: z.string().min(2),
    /** what the avatar says, one entry per paragraph (sentences inside are split by the sidecar) */
    lines: z.array(z.string().min(1).max(600)).max(80),
    /** reference clip for voice cloning, 24 kHz mono WAV, ≤ 12 s */
    voice_ref: z.string().optional(),
    /** the user's own recording: TTS is skipped, the avatar lip-syncs to it */
    speech: z.string().optional(),
    portrait: z.string().default("portrait.png"),
    mode: AvatarModeSchema.default("avatar"),
    tts: z
      .object({
        exaggeration: z.number().min(0).max(2),
        cfg_weight: z.number().min(0).max(1),
        line_pause_ms: z.number().int().min(0).max(3000),
        sentence_pause_ms: z.number().int().min(0).max(3000),
      })
      .default(TTS_DEFAULTS),
    animate: z
      .object({
        cfg_scale: z.number().min(0).max(10),
        max_chunk_seconds: z.number().min(0).max(120),
      })
      .default(ANIMATE_DEFAULTS),
  })
  .refine((s) => s.lines.length > 0 || !!s.speech, { message: "нужен текст (lines) или своя запись речи (speech)" });
export type AvatarScript = z.infer<typeof AvatarScriptSchema>;

const LineTimingSchema = z.object({ i: z.number().int(), text: z.string(), start: z.number().nullable(), end: z.number().nullable() });

export const AvatarMetaSchema = z.looseObject({
  version: z.literal(1),
  job: z.string().nullable().optional(),
  mode: AvatarModeSchema,
  language: z.string().nullable().optional(),
  duration: z.number().positive(),
  lines: z.array(LineTimingSchema).default([]),
  fps: z.number().optional(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  tts: z.looseObject({ engine: z.string().nullable().optional(), voice: z.string().nullable().optional(), wall_seconds: z.number().nullable().optional() }),
  animate: z.looseObject({ engine: z.string().nullable().optional(), device: z.string().nullable().optional(), wall_seconds: z.number().nullable().optional() }).optional(),
  created_at: z.string().optional(),
});
export type AvatarMeta = z.infer<typeof AvatarMetaSchema>;

/** workspace/<job>/avatar.json */
export const AvatarStateSchema = z.object({
  job: z.string(),
  created_at: z.string(),
  /** where the words came from */
  source: z.enum(["text", "topic", "recording"]),
  topic: z.string().optional(),
  title: z.string().default(""),
  language: z.string(),
  lines: z.array(z.string()),
  hashtags: z.array(z.string()).default([]),
  mode: AvatarModeSchema,
  portrait: z.enum(["photo", "generated", "none"]),
  voice: z.enum(["default", "clone", "own-recording"]),
  bundle: z.string(),
  bundle_bytes: z.number(),
  /** estimated speech length, s (≈ 14 characters per second) */
  estimated_seconds: z.number(),
  warnings: z.array(z.string()).default([]),
  imported_at: z.string().optional(),
  result: z.string().optional(),
  video: z.string().optional(),
  meta: AvatarMetaSchema.optional(),
});
export type AvatarState = z.infer<typeof AvatarStateSchema>;
