import { z } from "zod";

/**
 * Style DNA (stage 22): the editing style of a reference reel, reverse-engineered by Gemini and by local
 * measurements, in three blocks that map 1:1 onto vedit's own variables (src/style/map.ts):
 *   planner_rules     → the planner prompt (pace, silence threshold, fillers, hook/body rhythm) and the jump-cut pass
 *   hyperframes_theme → DesignSpec.captions/font/colors (HyperFrames overlay), clip zoom punch-ins, overlays
 *   audio_and_color   → music bed and ducking (src/audio/mix.ts), sfx cues, the ffmpeg eq colour grade in the cut
 * Every field is an enum, a number with a safe range (clamped after parsing) or a #RRGGBB colour.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
const hex = (what: string) => z.string().regex(HEX).describe(`${what}, #RRGGBB`);

export const PACING = ["calm", "moderate", "fast", "aggressive"] as const;
export const LAYOUT_PRESETS = ["single_word_impact", "two_words_pop", "karaoke_two_lines", "minimal_clean_box", "none"] as const;
export const FONT_WEIGHTS = ["400_regular", "700_bold", "900_black"] as const;
export const BACKGROUND_BOXES = ["none", "rounded_pill", "full_strip"] as const;
export const WORD_ANIMATIONS = ["none", "spring_scale", "fade_up", "color_switch_only", "slide_in"] as const;
export const ZOOM_FREQUENCIES = ["none", "rare_emphasis", "every_2_3_sentences", "every_cut_aggressive"] as const;
export const ZOOM_STYLES = ["none", "instant_punch_in", "smooth_ken_burns", "fast_ease_out"] as const;
export const SFX_INTENSITIES = ["none", "subtle_whoosh", "heavy_cinematic"] as const;
export const GRADE_PRESETS = ["neutral_natural", "high_contrast_warm", "cinematic_moody", "bright_airy", "desaturated_clean"] as const;

export const PlannerRulesSchema = z.object({
  pacing_profile: z.enum(PACING).describe("overall editing tempo"),
  hook_cut_duration_sec: z.number().describe("average shot length in the first 3 seconds, s (0.3–4)"),
  body_avg_cut_duration_sec: z.number().describe("average shot length after the hook, s (0.5–15)"),
  silence_cut_threshold_ms: z.number().describe("pauses between words longer than this are cut out: 150–250 = jump-cut style, 350–600 = natural (100–1500)"),
  remove_fillers_and_retakes: z.boolean().describe("fillers (um, uh, ну, э) and repeated takes are removed"),
  speech_wpm_estimate: z.number().describe("speech rate after editing, words per minute (60–260)"),
});

export const CaptionsDnaSchema = z.object({
  enabled: z.boolean().describe("burned-in captions of the speech are present"),
  layout_preset: z.enum(LAYOUT_PRESETS),
  max_words_per_screen: z.number().int().describe("max words visible at once (1–8)"),
  max_chars_per_line: z.number().int().describe("max characters per line (6–40)"),
  font_weight: z.enum(FONT_WEIGHTS),
  uppercase: z.boolean(),
  position_y_percent: z.number().describe("vertical centre of the caption block, % of frame height from the top (10–92)"),
  primary_text_color: hex("colour of ordinary caption words"),
  active_word_color: hex("colour of the word being spoken (same as primary if there is no highlight)"),
  secondary_accent_color: hex("other accent colour used in the graphics"),
  stroke_color: hex("outline colour of the letters"),
  stroke_width_px: z.number().describe("outline width in px on a 1080-wide frame (0–14)"),
  shadow_opacity: z.number().describe("drop shadow opacity 0–1"),
  background_box: z.enum(BACKGROUND_BOXES),
  word_animation: z.enum(WORD_ANIMATIONS),
  active_word_scale: z.number().describe("scale of the active word, 1.0–1.4"),
});

export const CameraMotionSchema = z.object({
  zoom_frequency: z.enum(ZOOM_FREQUENCIES),
  zoom_style: z.enum(ZOOM_STYLES),
  zoom_scale_factor: z.number().describe("how far a punch-in zooms, 1.0–1.3"),
  zoom_on_hook: z.boolean().describe("the first seconds start with or contain a punch-in"),
  split_screen_detected: z.boolean().describe("the frame is split into two halves (speaker + visuals)"),
});

export const OverlaysSchema = z.object({
  progress_bar: z.boolean(),
  emoji_popups: z.boolean(),
  title_banner_first_3s: z.boolean().describe("a big title / hook text in the first 3 seconds"),
});

export const HyperframesThemeSchema = z.object({
  captions: CaptionsDnaSchema,
  camera_motion: CameraMotionSchema,
  overlays: OverlaysSchema,
});

export const ColorGradeSchema = z.object({
  preset: z.enum(GRADE_PRESETS),
  contrast_multiplier: z.number().describe("0.9–1.2"),
  saturation_multiplier: z.number().describe("0.85–1.25"),
  brightness_offset: z.number().describe("-0.05–0.05"),
});

export const AudioAndColorSchema = z.object({
  has_background_music: z.boolean(),
  music_ducking_db: z.number().describe("music level under speech relative to the voice, dB: -26…-12; 0 = no ducking"),
  sfx_on_cuts_and_zooms: z.boolean(),
  sfx_intensity: z.enum(SFX_INTENSITIES),
  color_grade: ColorGradeSchema,
});

export const StyleDNASchema = z.object({
  style_summary: z.string().describe("1–2 sentences in Russian: what makes this edit recognisable"),
  planner_rules: PlannerRulesSchema,
  hyperframes_theme: HyperframesThemeSchema,
  audio_and_color: AudioAndColorSchema,
});
export type StyleDNA = z.infer<typeof StyleDNASchema>;

/** A neutral, readable default (what a field falls back to when the model leaves it out or breaks it). */
export const DEFAULT_DNA: StyleDNA = {
  style_summary: "Динамичный монтаж с крупными субтитрами.",
  planner_rules: { pacing_profile: "moderate", hook_cut_duration_sec: 1.5, body_avg_cut_duration_sec: 3, silence_cut_threshold_ms: 400, remove_fillers_and_retakes: true, speech_wpm_estimate: 160 },
  hyperframes_theme: {
    captions: {
      enabled: true,
      layout_preset: "two_words_pop",
      max_words_per_screen: 3,
      max_chars_per_line: 18,
      font_weight: "900_black",
      uppercase: true,
      position_y_percent: 70,
      primary_text_color: "#FFFFFF",
      active_word_color: "#FFD600",
      secondary_accent_color: "#FFD600",
      stroke_color: "#000000",
      stroke_width_px: 6,
      shadow_opacity: 0.5,
      background_box: "none",
      word_animation: "spring_scale",
      active_word_scale: 1.12,
    },
    camera_motion: { zoom_frequency: "rare_emphasis", zoom_style: "instant_punch_in", zoom_scale_factor: 1.12, zoom_on_hook: false, split_screen_detected: false },
    overlays: { progress_bar: false, emoji_popups: false, title_banner_first_3s: false },
  },
  audio_and_color: {
    has_background_music: false,
    music_ducking_db: -18,
    sfx_on_cuts_and_zooms: false,
    sfx_intensity: "none",
    color_grade: { preset: "neutral_natural", contrast_multiplier: 1, saturation_multiplier: 1, brightness_offset: 0 },
  },
};

/** Safe ranges of every number (applied after parsing: a model's 3.0 zoom becomes 1.3, not a broken render). */
export const RANGES = {
  "planner_rules.hook_cut_duration_sec": [0.3, 4],
  "planner_rules.body_avg_cut_duration_sec": [0.5, 15],
  "planner_rules.silence_cut_threshold_ms": [100, 1500],
  "planner_rules.speech_wpm_estimate": [60, 260],
  "hyperframes_theme.captions.max_words_per_screen": [1, 8],
  "hyperframes_theme.captions.max_chars_per_line": [6, 40],
  "hyperframes_theme.captions.position_y_percent": [10, 92],
  "hyperframes_theme.captions.stroke_width_px": [0, 14],
  "hyperframes_theme.captions.shadow_opacity": [0, 1],
  "hyperframes_theme.captions.active_word_scale": [1, 1.4],
  "hyperframes_theme.camera_motion.zoom_scale_factor": [1, 1.3],
  "audio_and_color.color_grade.contrast_multiplier": [0.9, 1.2],
  "audio_and_color.color_grade.saturation_multiplier": [0.85, 1.25],
  "audio_and_color.color_grade.brightness_offset": [-0.05, 0.05],
} as const satisfies Record<string, readonly [number, number]>;

const INTS = new Set(["hyperframes_theme.captions.max_words_per_screen", "hyperframes_theme.captions.max_chars_per_line"]);

/** music_ducking_db: 0 (no ducking) or −26…−12 dB */
export function clampDucking(db: number): number {
  if (!Number.isFinite(db)) return DEFAULT_DNA.audio_and_color.music_ducking_db;
  if (db > -6) return 0; // "0 = none" and anything near it
  return Math.min(-12, Math.max(-26, Math.round(db)));
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/**
 * Walks the schema next to the raw value: a leaf that validates is kept (numbers clamped to RANGES), anything
 * missing or broken (unknown enum, "red" instead of #RRGGBB, a string number) falls back to DEFAULT_DNA.
 * `fixed` lists the paths that were defaulted or clamped.
 */
export function parseDNA(raw: unknown): { dna: StyleDNA; fixed: string[] } {
  const fixed: string[] = [];
  const walk = (schema: z.ZodType, value: unknown, def: unknown, at: string): unknown => {
    if (schema instanceof z.ZodObject) {
      const obj = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      if (value === undefined || obj !== value) fixed.push(at || "(root)");
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries(schema.shape as Record<string, z.ZodType>)) out[k] = walk(s, obj[k], (def as Record<string, unknown>)[k], at ? `${at}.${k}` : k);
      return out;
    }
    let v = value;
    // a number sent as a string ("1.15") is still a number
    if (typeof v === "string" && typeof def === "number" && v.trim() !== "" && Number.isFinite(Number(v))) v = Number(v);
    if (typeof v === "string" && typeof def === "string" && HEX.test(`#${v}`) && !v.startsWith("#")) v = `#${v}`;
    let r = schema.safeParse(v);
    if (!r.success && typeof v === "number" && INTS.has(at)) r = schema.safeParse(Math.round(v));
    if (!r.success) {
      if (value !== undefined) fixed.push(at);
      else fixed.push(`${at} (missing)`);
      return def;
    }
    let out = r.data as unknown;
    if (typeof out === "number") {
      const range = (RANGES as Record<string, readonly [number, number]>)[at];
      let c = out;
      if (at === "audio_and_color.music_ducking_db") c = clampDucking(out);
      else if (range) c = clamp(out, range[0], range[1]);
      if (INTS.has(at)) c = Math.round(c);
      if (c !== out) fixed.push(`${at}: ${out} → ${c}`);
      out = c;
    }
    if (typeof out === "string" && at.endsWith("_color")) out = (out as string).toUpperCase();
    return out;
  };
  const dna = walk(StyleDNASchema, raw, DEFAULT_DNA, "") as StyleDNA;
  if (!dna.style_summary.trim()) dna.style_summary = DEFAULT_DNA.style_summary;
  return { dna: StyleDNASchema.parse(dna), fixed };
}

const GEMINI_KEEP = new Set(["type", "format", "description", "nullable", "enum", "properties", "required", "items", "minimum", "maximum", "pattern", "minItems", "maxItems"]);

/**
 * zod → Gemini responseSchema (the OpenAPI 3.0 subset of generateContent): enums stay enums (enforced at
 * decode time), every property is required, propertyOrdering follows the zod key order (Gemini emits the
 * fields in that order, so the cheap summary comes first and the numbers after the model has looked).
 */
export function toGeminiSchema(schema: z.ZodType): Record<string, unknown> {
  const conv = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(conv);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (!GEMINI_KEEP.has(k)) continue;
      if (k === "properties") out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, conv(pv)]));
      else out[k] = typeof v === "object" ? conv(v) : v;
    }
    if (out.properties) out.propertyOrdering = Object.keys(out.properties as object);
    return out;
  };
  return conv(z.toJSONSchema(schema, { target: "openapi-3.0" })) as Record<string, unknown>;
}

/** The responseSchema sent with the style request. */
export const STYLE_DNA_RESPONSE_SCHEMA = toGeminiSchema(StyleDNASchema);
