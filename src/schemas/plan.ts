import { z } from "zod";
import { AspectSchema } from "./edl.ts";

// ---- what the model returns: a draft that references boundaries by id, never seconds ----

export const RefSchema = z
  .string()
  .describe('boundary ref: "p12" (phrase), "s3" (scene), "g7" (silence gap), "p12.start" | "p12.end", "p12.w4" (word 4 of phrase 12, 0-based) — never seconds');

export const DraftClipSchema = z.object({
  start: RefSchema,
  end: RefSchema,
  speed: z.number().optional().describe("playback speed; 1.0 on speech, 1.25–2.0 only on speech-free clips"),
  crop: z.enum(["center", "auto_face"]).optional().describe("auto_face keeps the speaker in frame for 9:16"),
  note: z.string().optional().describe("why this clip, one short sentence"),
  punch_in: z.boolean().optional().describe("reference style only: a camera punch-in on this clip (key thought, number, emotion)"),
});

export const DraftTitleSchema = z.object({
  at: z.number().describe("seconds on the OUTPUT timeline"),
  duration: z.number().optional(),
  text: z.string().describe("≤ 40 chars, only facts that appear in the phrases"),
  style: z.string().optional(),
});

export const DraftOutputSchema = z.object({
  id: z.string().describe("filename-safe id such as reel_1"),
  aspect: AspectSchema,
  target_duration: z.number().optional().describe("seconds"),
  hook: z.string().optional().describe("what grabs attention in the first 3 seconds"),
  clips: z.array(DraftClipSchema),
  captions: z.object({
    enabled: z.boolean(),
    language: z.string().optional().describe("ISO code the user asked for, e.g. uz, even if speech is ru"),
    style: z.string().optional(),
  }),
  titles: z.array(DraftTitleSchema),
  music: z.object({ enabled: z.boolean() }),
});

export const DraftBriefSchema = z.object({
  outputs_requested: z.number().optional(),
  target_duration_s: z.number().optional(),
  aspect: AspectSchema.optional(),
  captions_language: z.string().optional(),
  style_words: z.array(z.string()).describe("style words taken from the instruction, e.g. динамично"),
});

export const PlanDraftSchema = z.object({
  brief: DraftBriefSchema.describe("how you understood the instruction"),
  outputs: z.array(DraftOutputSchema),
  reasoning: z.string().describe("2–6 sentences for the user, in the language of the instruction"),
});
export type PlanDraft = z.infer<typeof PlanDraftSchema>;

// ---- validation issues ----

export const IssueCodeSchema = z.enum([
  "invalid_json",
  "schema",
  "no_outputs",
  "bad_id",
  "duplicate_id",
  "no_clips",
  "unknown_ref",
  "raw_time",
  "empty_clip",
  "out_of_media",
  "bad_speed",
  "speech_speed",
  "gap_cut",
  "mid_phrase",
  "cuts_word",
  "overlap",
  "duration_off",
  "count_mismatch",
  "captions_no_language",
  "title_outside",
  "title_long",
]);
export type IssueCode = z.infer<typeof IssueCodeSchema>;

export const PlanIssueSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: IssueCodeSchema,
  output: z.string().optional(),
  clip: z.number().int().optional(),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type PlanIssue = z.infer<typeof PlanIssueSchema>;

// ---- reports ----

export const PlanUsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  thinking_tokens: z.number().default(0),
});
export type PlanUsage = z.infer<typeof PlanUsageSchema>;

export const ToolCallRecordSchema = z.object({
  name: z.string(),
  input: z.unknown(),
  ok: z.boolean(),
  ms: z.number(),
  summary: z.string(),
  image: z.boolean().optional(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

export const CallUsageSchema = z.object({
  model: z.string(),
  usage: PlanUsageSchema,
  usd: z.number(),
  priced: z.boolean(),
  stop_reason: z.string().nullable(),
  tools: z.array(z.string()),
});
export type CallUsage = z.infer<typeof CallUsageSchema>;

export const PlanOutputSummarySchema = z.object({
  id: z.string(),
  /** kept = a revise could not re-express this output, its previous version stays */
  status: z.enum(["ok", "dropped", "kept"]),
  aspect: z.string(),
  duration_s: z.number(),
  target_s: z.number().nullable(),
  clips: z.number().int(),
  captions_language: z.string().nullable(),
});

export const PlanReportSchema = z.object({
  kind: z.enum(["plan", "revise"]),
  status: z.enum(["ok", "partial", "failed"]),
  backend: z.string(),
  backend_note: z.string(),
  backend_account: z.record(z.string(), z.unknown()).optional(),
  contract: z.enum(["format", "submit"]),
  model: z.string(),
  effort: z.string(),
  mode: z.enum(["full", "compact", "shortlist"]),
  /** speaker filter / long-video windows used to build the pack; revise reuses them so refs stay stable */
  speaker: z.string().optional(),
  windows: z.array(z.object({ id: z.string(), start: z.number(), end: z.number(), why: z.string(), source: z.enum(["model", "highlights"]) })).optional(),
  pack_hash: z.string(),
  pack_tokens_estimate: z.number(),
  prompt_version: z.string(),
  instruction: z.string(),
  preset: z.string(),
  calls: z.number().int(),
  repairs: z.number().int(),
  tool_calls: z.array(ToolCallRecordSchema),
  tools_seen: z.array(z.string()).optional(),
  per_call: z.array(CallUsageSchema),
  usage: PlanUsageSchema,
  usd: z.number(),
  priced: z.boolean(),
  estimate: z.boolean(),
  outputs: z.array(PlanOutputSummarySchema),
  fixed: z.array(PlanIssueSchema),
  issues: z.array(PlanIssueSchema),
  warnings: z.array(z.string()),
  draft: z.unknown().optional(),
  error: z.string().optional(),
  error_code: z.string().optional(),
  wall_seconds: z.number(),
});
export type PlanReport = z.infer<typeof PlanReportSchema>;

export const EdlDiffSchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  changed: z.array(z.object({ id: z.string(), fields: z.array(z.string()) })),
  unchanged: z.array(z.string()),
  stages: z.record(z.string(), z.array(z.string())),
});
export type EdlDiff = z.infer<typeof EdlDiffSchema>;

export const ReviseReportSchema = PlanReportSchema.extend({
  edit: z.string(),
  diff: EdlDiffSchema,
  affected: z.array(z.string()),
  previous_edl: z.string(),
});
export type ReviseReport = z.infer<typeof ReviseReportSchema>;

// ---- style presets ----

/** Visual spec shared by every renderer (stage 4): fonts, colours, caption layout and motion. */
export const DesignSpecSchema = z.object({
  font: z.object({
    family: z.string().default("Inter"),
    file: z.string().default("assets/fonts/Inter-Variable.ttf"), // repo-relative; must cover Cyrillic + Latin
    weight: z.number().default(800),
  }).prefault({}),
  colors: z.object({
    text: z.string().default("#FFFFFF"),
    highlight: z.string().default("#FFD600"), // the word being spoken
    stroke: z.string().default("#000000"),
    title: z.string().default("#FFFFFF"),
    title_bg: z.string().default("rgba(0,0,0,0.55)"),
  }).prefault({}),
  captions: z.object({
    /** vertical anchor as a fraction of the frame height (centre of the caption block) */
    anchor_y: z.number().default(0.72),
    max_words: z.number().int().default(4),
    max_chars: z.number().int().default(22),
    font_size: z.number().default(72), // px at 1080 wide; scaled by width/1080
    line_height: z.number().default(1.15),
    uppercase: z.boolean().default(true),
    /** px, scaled like font_size */
    stroke_width: z.number().default(8),
    /** opacity of the soft drop shadow under the letters */
    shadow_opacity: z.number().min(0).max(1).default(0.55),
    /** how the spoken word is emphasised */
    word_animation: z.enum(["pop", "fill", "none"]).default("pop"),
    pop_scale: z.number().default(1.12),
    page_animation: z.enum(["fade_up", "none"]).default("fade_up"),
    /** rounded translucent box behind every caption line (legibility over faces and busy backgrounds) */
    backing: z.object({
      enabled: z.boolean().default(false),
      color: z.string().default("rgba(0,0,0,0.42)"),
      /** px at 1080 wide, vertical / horizontal */
      padding: z.number().default(10),
      radius: z.number().default(18),
    }).prefault({}),
    /** soft dark gradient over the lower part of the frame, under the captions */
    shade: z.object({
      enabled: z.boolean().default(false),
      /** opacity at the bottom edge */
      strength: z.number().min(0).max(1).default(0.45),
      /** where the gradient starts, fraction of the height */
      from: z.number().min(0).max(1).default(0.55),
    }).prefault({}),
  }).prefault({}),
  titles: z.object({
    anchor_y: z.number().default(0.18),
    font_size: z.number().default(88),
    max_lines: z.number().int().default(2),
    animation: z.enum(["slide_up", "fade", "none"]).default("slide_up"),
    padding: z.number().default(24),
    radius: z.number().default(20),
    /** when the located face sits high in the frame (centre above face_zone), the title moves below it, above the captions */
    avoid_face: z.boolean().default(true),
    face_zone: z.number().default(0.42),
  }).prefault({}),
  safe_area: z.object({ x: z.number().default(0.06), y: z.number().default(0.08) }).prefault({}),
  /** "split": speaker in the bottom half, generated visuals + UI cards on top, hook title on the seam */
  layout: z.enum(["full", "split"]).default("full"),
  split: z.object({
    /** seam position as a fraction of the height */
    seam: z.number().default(0.5),
    panel_bg: z.string().default("#0D0A1A"),
    accent: z.string().default("#8B6CFF"),
    image_style: z.string().default("cinematic, moody purple and blue neon light, shallow depth of field, high detail"),
    /**
     * speaker cutout (MediaPipe matte, tools/matte): "on" cuts the speaker out over a designed background,
     * "auto" does it when the matte passes the quality check (plain video otherwise), "off" never
     */
    cutout: z.enum(["off", "on", "auto"]).default("off"),
    /** how far the cut-out head may break above the seam, fraction of the height */
    pop_out: z.number().min(0).max(0.15).default(0.06),
  }).prefault({}),
  /** small graphic overlays (stage 22, reference style): a thin progress bar along the top edge */
  overlays: z.object({
    progress_bar: z.boolean().default(false),
  }).prefault({}),
  /** call-to-action card over the last seconds (overlay only: the cut and its audio are untouched) */
  outro: z.object({
    enabled: z.boolean().default(false),
    duration: z.number().default(1.8),
    text: z.string().default(""),
    /** per caption language; falls back to `text` */
    text_by_lang: z.record(z.string(), z.string()).default({}),
    font_size: z.number().default(80),
    backdrop: z.string().default("rgba(0,0,0,0.45)"),
  }).prefault({}),
});
export type DesignSpec = z.infer<typeof DesignSpecSchema>;

export const PresetSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  pace: z.enum(["dynamic", "calm", "neutral"]),
  clip_seconds: z.object({ min: z.number().positive(), max: z.number().positive() }),
  caption_style: z.string(),
  title_style: z.string().default("hero"),
  default_aspect: AspectSchema.default("9:16"),
  music_default: z.boolean().default(false),
  notes: z.array(z.string()).default([]),
  design: DesignSpecSchema.prefault({}),
});
export type Preset = z.infer<typeof PresetSchema>;
