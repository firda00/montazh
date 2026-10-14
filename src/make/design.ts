import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { LANGUAGE_NAMES, type Script } from "./script.ts";
import { MOODS } from "../audio/music.ts";
import type { Aspect } from "../lib/aspect.ts";

/**
 * The art director: script → a visual identity for the whole video + one composed scene per beat.
 * The model chooses freely from a vocabulary of layouts, accents, entrances and image framings;
 * normalizeDesign() then makes the answer safe to render (verbatim accents, fields a layout needs,
 * colour sanity, fallbacks) without flattening the choices.
 */

export const LAYOUTS = ["hero_number", "headline", "statement", "media_full", "media_card", "media_split", "media_number", "list", "chat", "timeline", "compare", "quote", "orbit_title", "depth_cards", "tunnel_number"] as const;
/** layouts that show a photo (an image found or generated for the beat) */
export const MEDIA_LAYOUTS = ["media_full", "media_card", "media_split", "media_number"] as const satisfies readonly Layout[];
/** 3D motion-graphics layouts (CSS 3D on the one GSAP timeline, see scenes.ts) */
export const LAYOUTS_3D = ["orbit_title", "depth_cards", "tunnel_number"] as const satisfies readonly Layout[];
export type Layout = (typeof LAYOUTS)[number];
export const ACCENT_STYLES = ["marker", "color", "serif", "gradient", "outline"] as const;
export const ENTRANCES = ["rise", "mask", "pop", "type", "slide"] as const;
export const MOTIONS = ["zoom_in", "zoom_out", "pan_left", "pan_right"] as const;
export const DISPLAY_FONTS = ["inter", "unbounded", "playfair"] as const;
export const ACCENT_FONTS = ["playfair-italic", "inter", "unbounded", "mono"] as const;
export const TEXTURES = ["none", "grain", "grid", "glow"] as const;
/** where the text block of a scene sits: consecutive scenes vary it so the frames do not repeat one template */
export const ANCHORS = ["top", "center", "bottom"] as const;
/** how a scene arrives: a hard cut (default), a whip pan, a zoom-through, a short fade */
export const TRANSITIONS = ["cut", "whip", "zoom", "fade"] as const;
/** persistent chrome over every scene: none (default) or a small header with the brand and a progress line */
export const CHROMES = ["none", "header"] as const;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const IdentitySchema = z.object({
  palette: z.object({ bg: Hex, bg2: Hex, text: Hex, accent: Hex, accent2: Hex, muted: Hex }),
  display_font: z.enum(DISPLAY_FONTS),
  accent_font: z.enum(ACCENT_FONTS),
  kicker_font: z.enum(["mono", "display"]),
  texture: z.enum(TEXTURES),
  image_style: z.string(),
  brand: z.string().max(24),
  /** background music mood (src/audio/music.ts) */
  music: z.enum(MOODS).default("upbeat"),
  chrome: z.enum(CHROMES).default("none"),
});
export type Identity = z.infer<typeof IdentitySchema>;

export const SceneSchema = z.object({
  beat: z.number().int(),
  layout: z.enum(LAYOUTS),
  headline: z.string().min(1),
  accents: z.array(z.object({ text: z.string(), style: z.enum(ACCENT_STYLES) })).default([]),
  kicker: z.string().default(""),
  sub: z.string().default(""),
  number: z.object({ value: z.string(), unit: z.string().default("") }).nullable().default(null),
  items: z.array(z.string()).default([]),
  /** query: English keywords for the photo search; prompt: a description for the AI fallback */
  image: z.object({ query: z.string().default(""), prompt: z.string(), motion: z.enum(MOTIONS).default("zoom_in") }).nullable().default(null),
  entrance: z.enum(ENTRANCES).default("rise"),
  anchor: z.enum(ANCHORS).default("center"),
  transition: z.enum(TRANSITIONS).default("cut"),
});
export type Scene = z.infer<typeof SceneSchema>;

export const DesignSchema = z.object({ identity: IdentitySchema, scenes: z.array(SceneSchema) });
export type Design = z.infer<typeof DesignSchema>;

/** What the model returns (strict, everything present; nulls for unused fields). */
const DesignOut = z.object({
  identity: z.object({
    palette: z.object({ bg: z.string(), bg2: z.string(), text: z.string(), accent: z.string(), accent2: z.string(), muted: z.string() }),
    display_font: z.enum(DISPLAY_FONTS),
    accent_font: z.enum(ACCENT_FONTS),
    kicker_font: z.enum(["mono", "display"]),
    texture: z.enum(TEXTURES),
    image_style: z.string(),
    brand: z.string(),
    music: z.enum(MOODS),
    chrome: z.enum(CHROMES).default("none"),
  }),
  scenes: z.array(
    z.object({
      beat: z.number(),
      layout: z.enum(LAYOUTS),
      headline: z.string(),
      accents: z.array(z.object({ text: z.string(), style: z.enum(ACCENT_STYLES) })),
      kicker: z.string().nullable(),
      sub: z.string().nullable(),
      number: z.object({ value: z.string(), unit: z.string() }).nullable(),
      items: z.array(z.string()).nullable(),
      image: z.object({ query: z.string().default(""), prompt: z.string(), motion: z.enum(MOTIONS) }).nullable(),
      entrance: z.enum(ENTRANCES),
      anchor: z.enum(ANCHORS).default("center"),
      transition: z.enum(TRANSITIONS).default("cut"),
    }),
  ),
});

// ---- colour helpers ----
const hex = (s: string, fallback: string) => (/^#[0-9a-fA-F]{6}$/.test(s.trim()) ? s.trim().toUpperCase() : /^#[0-9a-fA-F]{3}$/.test(s.trim()) ? `#${s.trim().slice(1).split("").map((c) => c + c).join("")}`.toUpperCase() : fallback);
function luminance(h: string): number {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const DEFAULT_IDENTITY: Identity = {
  palette: { bg: "#111318", bg2: "#22262F", text: "#FFFFFF", accent: "#FFD600", accent2: "#FF8A00", muted: "#9AA0AA" },
  display_font: "inter",
  accent_font: "playfair-italic",
  kicker_font: "mono",
  texture: "grain",
  image_style: "cinematic photograph, low-key light, shallow depth of field",
  brand: "VEDIT",
  music: "upbeat",
  chrome: "none",
};

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/**
 * Makes a model answer renderable: one scene per beat in order, accents that really occur in the
 * headline, layouts downgraded when they lack what they need (number, items, image), readable
 * text colour, no two identical layouts in a row.
 */
export function normalizeDesign(raw: unknown, script: Script): { design: Design; notes: string[] } {
  const notes: string[] = [];
  const out = DesignOut.parse(raw);
  const p = out.identity.palette;
  const palette = {
    bg: hex(p.bg, DEFAULT_IDENTITY.palette.bg),
    bg2: hex(p.bg2, DEFAULT_IDENTITY.palette.bg2),
    text: hex(p.text, DEFAULT_IDENTITY.palette.text),
    accent: hex(p.accent, DEFAULT_IDENTITY.palette.accent),
    accent2: hex(p.accent2, DEFAULT_IDENTITY.palette.accent2),
    muted: hex(p.muted, DEFAULT_IDENTITY.palette.muted),
  };
  if (contrast(palette.text, palette.bg) < 4.5) {
    const fixed = luminance(palette.bg) > 0.4 ? "#111111" : "#FFFFFF";
    notes.push(`цвет текста ${palette.text} плохо читается на ${palette.bg} — заменён на ${fixed}`);
    palette.text = fixed;
  }
  const identity: Identity = {
    palette,
    display_font: out.identity.display_font,
    accent_font: out.identity.accent_font,
    kicker_font: out.identity.kicker_font,
    texture: out.identity.texture,
    image_style: cut(out.identity.image_style, 300) || DEFAULT_IDENTITY.image_style,
    brand: cut(out.identity.brand, 14).toUpperCase() || DEFAULT_IDENTITY.brand,
    music: out.identity.music,
    chrome: out.identity.chrome,
  };

  const byBeat = new Map(out.scenes.map((s) => [Math.round(s.beat), s]));
  const scenes: Scene[] = script.beats.map((b, i) => {
    const s = byBeat.get(i) ?? out.scenes[i];
    if (!s) {
      notes.push(`бит ${i}: арт-директор пропустил — простой заголовок`);
      return SceneSchema.parse({ beat: i, layout: "headline", headline: b.text, accents: b.emphasis ? [{ text: b.emphasis, style: "color" }] : [] });
    }
    const headline = cut(s.headline || b.text, 90);
    const accents = s.accents.filter((a) => a.text.trim() && headline.toLowerCase().includes(a.text.trim().toLowerCase())).slice(0, 2);
    if (accents.length < s.accents.length) notes.push(`бит ${i}: акцент не найден в заголовке — убран`);
    let layout: Layout = s.layout;
    const items = (s.items ?? []).map((t) => cut(t, 64)).filter(Boolean);
    const image = s.image && (s.image.prompt.trim() || s.image.query.trim()) ? { query: photoQuery(s.image.query || s.image.prompt), prompt: cut(s.image.prompt || s.image.query, 400), motion: s.image.motion } : null;
    if ((layout === "hero_number" || layout === "tunnel_number") && !s.number?.value.trim()) layout = "headline";
    // the orbit title is a giant word or two: a long sentence reads better as a plain headline
    if (layout === "orbit_title" && headline.length > 64) layout = "headline";
    if (layout === "depth_cards" && items.length < 3) layout = items.length === 2 ? "list" : "headline";
    if (layout === "media_number" && !s.number?.value.trim()) layout = image ? "media_full" : "headline";
    if (layout === "media_number" && !image) layout = "hero_number";
    if (layout.startsWith("media_") && !image) layout = "headline";
    if (layout === "list" && items.length < 2) layout = "headline";
    if (layout === "chat" && items.length < 2) layout = "headline";
    if (layout === "timeline" && items.length < 3) layout = items.length >= 2 ? "list" : "headline";
    if (layout === "compare" && items.length < 4) layout = "headline";
    if (layout !== s.layout) notes.push(`бит ${i}: ${s.layout} без данных → ${layout}`);
    return {
      beat: i,
      layout,
      headline,
      accents: accents.map((a) => ({ text: a.text.trim(), style: a.style })),
      kicker: cut(s.kicker ?? "", 34),
      sub: cut(s.sub ?? "", 70),
      number: (layout === "hero_number" || layout === "tunnel_number" || layout === "media_number") && s.number ? { value: cut(s.number.value, 10), unit: cut(s.number.unit ?? "", 14) } : null,
      items: layout === "timeline" ? items.slice(0, 5).map((t) => cut(t, 16)) : layout === "list" ? items.slice(0, 4).map((t) => cut(t, 34)) : layout === "compare" ? items.slice(0, 4).map((t) => cut(t, 20)) : layout === "depth_cards" ? items.slice(0, 4).map((t) => cut(t, 30)) : items.slice(0, 4),
      image: layout.startsWith("media_") ? image : null,
      entrance: s.entrance,
      anchor: s.anchor,
      transition: s.transition,
    };
  });
  // no two identical layouts in a row: the second becomes a headline (or a quote after a headline)
  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].layout === scenes[i - 1].layout) {
      const to: Layout = scenes[i].layout === "headline" ? "quote" : "headline";
      notes.push(`бит ${i}: ${scenes[i].layout} второй раз подряд → ${to}`);
      scenes[i] = { ...scenes[i], layout: to, image: null, number: null, items: [] };
    }
  }
  varyComposition(scenes, notes);
  return { design: DesignSchema.parse({ identity, scenes }), notes };
}

const STYLE_WORDS = /\b(cinematic|photo(graph)?|photorealistic|realistic|shot|35mm|film|look|style|lighting|light|shallow|depth|field|bokeh|vertical|horizontal|composition|frame|close-?up|wide|angle|moody|warm|cold|dramatic|high|low|key|quality|detailed|4k|8k|hd|render|of|the|a|an|and|with|in|on|at|for|from)\b/gi;

/** English keywords for the photo search: concrete nouns from the director's query (or prompt), no style words. */
export function photoQuery(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").replace(STYLE_WORDS, " ").split(/\s+/).filter((w) => w.length > 1).slice(0, 5).join(" ");
}

/**
 * Anti-template pass: kickers only where they carry information (a number, a date, a source; at most a third
 * of the scenes, never "ЦЕНЫ · 2026"-style category labels), consecutive 2D scenes anchored differently,
 * hard cuts by default with an occasional whip/zoom (at most half of the cuts), at most one fade.
 */
export function varyComposition(scenes: Scene[], notes: string[] = []): Scene[] {
  const n = scenes.length;
  let kept = 0;
  const maxKickers = Math.max(1, Math.ceil(n / 3));
  scenes.forEach((s, i) => {
    if (!s.kicker || s.layout === "orbit_title") return;
    const generic = / · |\|/.test(s.kicker) && !/\d/.test(s.kicker);
    if (generic || kept >= maxKickers) {
      scenes[i] = { ...s, kicker: "" };
      notes.push(`бит ${i}: подпись «${s.kicker}» убрана (шаблонно)`);
      return;
    }
    kept++;
  });
  // anchors: a 2D scene never sits where the previous one did
  const order = ["bottom", "top", "center"] as const;
  for (let i = 1; i < n; i++) {
    const prev = scenes[i - 1];
    const cur = scenes[i];
    if ((LAYOUTS_3D as readonly string[]).includes(cur.layout)) continue;
    if (cur.anchor === prev.anchor) {
      const next = order.find((a) => a !== prev.anchor && a !== scenes[i + 1]?.anchor) ?? "bottom";
      scenes[i] = { ...cur, anchor: next };
    }
  }
  // transitions
  if (n) scenes[0] = { ...scenes[0], transition: "cut" };
  let fades = 0;
  let moves = 0;
  const maxMoves = Math.floor(n / 2);
  for (let i = 1; i < n; i++) {
    const t = scenes[i].transition;
    if (t === "fade" && fades++ >= 1) scenes[i] = { ...scenes[i], transition: "cut" };
    else if ((t === "whip" || t === "zoom") && (moves++ >= maxMoves || scenes[i - 1].transition === t)) scenes[i] = { ...scenes[i], transition: "cut" };
  }
  if (n >= 4 && scenes.every((s) => s.transition === "cut")) {
    const m = Math.floor(n / 2);
    scenes[m] = { ...scenes[m], transition: (MEDIA_LAYOUTS as readonly string[]).includes(scenes[m].layout) ? "zoom" : "whip" };
  }
  return scenes;
}

export interface DesignResult {
  design: Design;
  notes: string[];
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: string;
  estimate: boolean;
}

const FRAME_WORDS: Record<Aspect, string> = { "9:16": "vertical 9:16 (1080×1920, Reels/Shorts/TikTok)", "16:9": "landscape 16:9 (1920×1080, YouTube)", "1:1": "square 1:1 (1080×1080)" };

export async function directDesign(topic: string, script: Script, llm: StructuredFn, opts: { model?: string; aspect?: Aspect } = {}): Promise<DesignResult> {
  const beats = script.beats.map((b, i) => `${i} (${b.seconds}s): ${b.text}${b.emphasis ? `  [emphasis: ${b.emphasis}]` : ""}${b.voiceover ? `  — narrator: ${b.voiceover}` : ""}`).join("\n");
  const prompt = fill(loadPrompt("make.design.user"), { topic, language: LANGUAGE_NAMES[script.language] ?? script.language, frame: FRAME_WORDS[opts.aspect ?? "9:16"], title: script.title, beats, count: script.beats.length });
  const res = await llm({ system: loadPrompt("make.design.system"), prompt, schema: zodToApiSchema(DesignOut), model: opts.model, effort: "medium", maxTokens: 8000 });
  const { design, notes } = normalizeDesign(res.data, script);
  return { design, notes, usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}

/** A design without a model: alternating typographic layouts, for --no-design and failures. */
export function fallbackDesign(script: Script): Design {
  return DesignSchema.parse({
    identity: DEFAULT_IDENTITY,
    scenes: script.beats.map((b, i) => ({ beat: i, layout: i % 2 ? "quote" : "headline", headline: b.text, accents: b.emphasis ? [{ text: b.emphasis, style: "marker" }] : [], entrance: i % 2 ? "mask" : "rise", anchor: (["bottom", "center", "top"] as const)[i % 3], transition: i && i % 3 === 0 ? "whip" : "cut" })),
  });
}
