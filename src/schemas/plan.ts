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
  accent_words: z.array(z.string()).optional().describe("hook title only: the 1 word of the text (a name, a brand or a number) drawn in the accent colour, copied verbatim from the text"),
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
  inserts: z.array(z.string()).optional().describe("optional: named things (companies, products, people, places, objects) said in this output that deserve a B-roll insert, as spoken; the editor decides timing"),
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
    /**
     * stage 33 (format A of docs/abror-format.md): centre of the caption block over the parts where the speaker fills
     * the whole frame (the split preset's final quarter, full-frame inserts); absent = anchor_y everywhere
     */
    anchor_y_full: z.number().min(0).max(1).optional(),
    max_words: z.number().int().default(4),
    max_chars: z.number().int().default(22),
    font_size: z.number().default(72), // px at 1080 wide; scaled by width/1080
    line_height: z.number().default(1.15),
    uppercase: z.boolean().default(true),
    /**
     * stage 27: letter case of the caption words — "as_spoken" (the transcript's own case), "upper", "lower";
     * absent → `uppercase` decides (true = upper, false = as_spoken)
     */
    letter_case: z.enum(["as_spoken", "upper", "lower"]).optional(),
    /** px, scaled like font_size */
    stroke_width: z.number().default(8),
    /** opacity of the soft drop shadow under the letters */
    shadow_opacity: z.number().min(0).max(1).default(0.55),
    /** drop shadow offset and blur (px at 1080 wide); clean_min: a tight 0 2px 6px */
    shadow_y: z.number().default(3),
    shadow_blur: z.number().default(14),
    /**
     * how the spoken word is emphasised: "pop" (scale + highlight, back to normal), "fill" (highlight colour, back),
     * "none", "reveal" (stage 27, karaoke reveal: the whole line is on screen, words not yet said are dim — `dim_color` —
     * and each word lights up to `colors.text` when it is said and stays lit; no scale)
     */
    word_animation: z.enum(["pop", "fill", "none", "reveal"]).default("pop"),
    /** "reveal": colour of the words not yet said */
    dim_color: z.string().default("rgba(255,255,255,0.3)"),
    /** "serif": words with digits are set in a narrow serif (Playfair Display) — numbers stand out without colour (reel #15) */
    numbers_font: z.enum(["same", "serif"]).default("same"),
    pop_scale: z.number().default(1.12),
    page_animation: z.enum(["fade_up", "none"]).default("fade_up"),
    /** rounded translucent box behind every caption line (legibility over faces and busy backgrounds) */
    backing: z.object({
      enabled: z.boolean().default(false),
      color: z.string().default("rgba(0,0,0,0.42)"),
      /** px at 1080 wide, vertical / horizontal */
      padding: z.number().default(10),
      radius: z.number().default(18),
      /** stage 33 (variant A2): one strip across the whole width (the white band on the seam) instead of a box per line */
      full_width: z.boolean().default(false),
    }).prefault({}),
    /**
     * stage 23: keep every caption page (and titles, callouts) off the faces: a face track of the rough cut
     * (MediaPipe, or the scenes' focus points as a fallback) moves a page from anchor_y to a free band inside
     * the Reels safe area (top 8 %, bottom 16 %), with hysteresis between pages
     */
    avoid_face: z.boolean().default(true),
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
    /** colour of a title's accent_words (stage 27 hook title); empty = colors.highlight */
    accent_color: z.string().default(""),
    /** "plain" titles (stage 27 hook: no card, shadow only, caps): vertical centre, under the face */
    plain_anchor_y: z.number().default(0.76),
    /** "plain" titles: font weight and uppercase */
    plain_weight: z.number().default(800),
    plain_uppercase: z.boolean().default(true),
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
    /**
     * stage 33 — per-section layout: from this share of the runtime on, the speaker fills the whole frame (moral + CTA,
     * docs/abror-format.md format A: the last ~25 %); 1 = split to the end. The switch lands on the nearest phrase start.
     */
    full_from: z.number().min(0).max(1).default(1),
    /** stage 33: the hook on the seam — "magazine" (three display lines, stage 13) or "plate" (design.hook_plate) */
    hook: z.enum(["magazine", "plate"]).default("magazine"),
    /** stage 33: the top panel — "card" (a framed card on a grid, stage 13) or "edge" (edge to edge, cover crop, no frame) */
    panel_frame: z.enum(["card", "edge"]).default("card"),
  }).prefault({}),
  /**
   * stage 33: the blue hook plate (H1 of docs/abror-format.md §2.1): a gradient box with a white border (thicker at the
   * bottom), 2 lines in caps, the first larger; it holds 3–5 s and leaves to the left with a motion blur
   */
  hook_plate: z.object({
    enabled: z.boolean().default(false),
    background: z.string().default("linear-gradient(180deg,#2F55D6 0%,#1D3DB8 100%)"),
    border_color: z.string().default("#FFFFFF"),
    /** px at 1080 wide; the bottom edge is thicker (the «plate on a plate» look) */
    border: z.number().default(4),
    border_bottom: z.number().default(7),
    radius: z.number().default(18),
    /** share of the frame width the plate may take */
    width: z.number().min(0.3).max(0.95).default(0.72),
    padding: z.number().default(24),
    /** first line, px at 1080; the second line is line2_scale of it */
    font_size: z.number().default(62),
    line2_scale: z.number().min(0.5).max(1).default(0.8),
    weight: z.number().default(800),
    color: z.string().default("#FFFFFF"),
    /** centre: over the seam in a split; under the face when the speaker (or an insert) fills the frame */
    anchor_y: z.number().min(0).max(1).default(0.4),
    anchor_y_full: z.number().min(0).max(1).default(0.74),
    /** seconds on screen before the exit (clamped to 3–5) */
    hold: z.number().default(4),
    max_words: z.number().int().default(6),
  }).prefault({}),
  /**
   * stage 27: B-roll inserts for a talking head (src/design/inserts.ts): named things and numbers of the speech →
   * full-frame cutaways, a cut-out photo of a person on the chest, a scroll of a company's website, a logo with fact chips
   */
  inserts: z.object({
    enabled: z.boolean().default(false),
    /** share of the runtime under inserts: low ≈ 18 %, normal ≈ 30 %, high ≈ 35 % (never more) */
    density: z.enum(["low", "normal", "high"]).default("normal"),
    /** a company's mobile website recorded by headless Chrome (official URL from Wikidata P856 / the dictionary) */
    site_capture: z.boolean().default(true),
    /** a person talked about: a cut-out photo on the chest (else a rounded card) */
    pip: z.boolean().default(true),
    /** numbers: a logo card + stacking fact chips */
    chips: z.boolean().default(true),
    /** a soft whoosh / pop on every insert */
    sfx: z.boolean().default(true),
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
    /**
     * stage 33 CTA overlays (docs/abror-format.md §2.3): "card" (the text above, centred), "keyword" (a comment word in
     * quotes, huge caps over the captions: «"MAN"» + «… so'zini yozib qoldiring»), "phone" (a Telegram / phone number card)
     */
    kind: z.enum(["card", "keyword", "phone"]).default("card"),
    /** keyword: the word to comment; phone: the number or @handle */
    keyword: z.string().default(""),
    phone: z.string().default(""),
    /** the small line under the keyword / number ("so'zini yozib qoldiring", "Telegram"); per language, falls back to `label` */
    label: z.string().default(""),
    label_by_lang: z.record(z.string(), z.string()).default({}),
    /** keyword / phone: vertical centre */
    anchor_y: z.number().min(0).max(1).default(0.62),
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
  /**
   * stage 27: "plan" = the plan / music_default decide the music bed; "off" = expert talking head, never a music bed
   * (reels #14, #15) — only an explicit --music overrides it
   */
  music: z.enum(["plan", "off"]).default("plan"),
  /**
   * stage 33: speech recognition for this style — a forced language (Uzbek with Russian loanwords drifts to ru/kk/tr in
   * auto-detection) and the engine: "gemini" = Gemini audio transcription first, whisper as the fallback
   */
  asr: z.object({ language: z.string().optional(), engine: z.enum(["auto", "gemini", "whisper"]).default("auto") }).optional(),
  notes: z.array(z.string()).default([]),
  design: DesignSpecSchema.prefault({}),
});
export type Preset = z.infer<typeof PresetSchema>;
