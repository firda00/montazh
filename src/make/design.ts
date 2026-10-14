import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { LANGUAGE_NAMES, type Script } from "./script.ts";
import { MOODS } from "../audio/music.ts";

/**
 * The art director: script → a visual identity for the whole video + one composed scene per beat.
 * The model chooses freely from a vocabulary of layouts, accents, entrances and image framings;
 * normalizeDesign() then makes the answer safe to render (verbatim accents, fields a layout needs,
 * colour sanity, fallbacks) without flattening the choices.
 */

export const LAYOUTS = ["hero_number", "headline", "media_full", "media_card", "media_split", "list", "chat", "timeline", "compare", "quote", "orbit_title", "depth_cards", "tunnel_number"] as const;
/** 3D motion-graphics layouts (CSS 3D on the one GSAP timeline, see scenes.ts) */
export const LAYOUTS_3D = ["orbit_title", "depth_cards", "tunnel_number"] as const satisfies readonly Layout[];
export type Layout = (typeof LAYOUTS)[number];
export const ACCENT_STYLES = ["marker", "color", "serif", "gradient", "outline"] as const;
export const ENTRANCES = ["rise", "mask", "pop", "type", "slide"] as const;
export const MOTIONS = ["zoom_in", "zoom_out", "pan_left", "pan_right"] as const;
export const DISPLAY_FONTS = ["inter", "unbounded", "playfair"] as const;
export const ACCENT_FONTS = ["playfair-italic", "inter", "unbounded", "mono"] as const;
export const TEXTURES = ["none", "grain", "grid", "glow"] as const;

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
  image: z.object({ prompt: z.string(), motion: z.enum(MOTIONS).default("zoom_in") }).nullable().default(null),
  entrance: z.enum(ENTRANCES).default("rise"),
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
      image: z.object({ prompt: z.string(), motion: z.enum(MOTIONS) }).nullable(),
      entrance: z.enum(ENTRANCES),
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
    const image = s.image && s.image.prompt.trim() ? { prompt: cut(s.image.prompt, 400), motion: s.image.motion } : null;
    if ((layout === "hero_number" || layout === "tunnel_number") && !s.number?.value.trim()) layout = "headline";
    // the orbit title is a giant word or two: a long sentence reads better as a plain headline
    if (layout === "orbit_title" && headline.length > 64) layout = "headline";
    if (layout === "depth_cards" && items.length < 3) layout = items.length === 2 ? "list" : "headline";
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
      number: (layout === "hero_number" || layout === "tunnel_number") && s.number ? { value: cut(s.number.value, 10), unit: cut(s.number.unit ?? "", 14) } : null,
      items: layout === "timeline" ? items.slice(0, 5).map((t) => cut(t, 16)) : layout === "list" ? items.slice(0, 4).map((t) => cut(t, 34)) : layout === "compare" ? items.slice(0, 4).map((t) => cut(t, 20)) : layout === "depth_cards" ? items.slice(0, 4).map((t) => cut(t, 30)) : items.slice(0, 4),
      image: layout.startsWith("media_") ? image : null,
      entrance: s.entrance,
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
  return { design: DesignSchema.parse({ identity, scenes }), notes };
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

export async function directDesign(topic: string, script: Script, llm: StructuredFn, opts: { model?: string } = {}): Promise<DesignResult> {
  const beats = script.beats.map((b, i) => `${i} (${b.seconds}s): ${b.text}${b.emphasis ? `  [emphasis: ${b.emphasis}]` : ""}`).join("\n");
  const prompt = fill(loadPrompt("make.design.user"), { topic, language: LANGUAGE_NAMES[script.language] ?? script.language, title: script.title, beats, count: script.beats.length });
  const res = await llm({ system: loadPrompt("make.design.system"), prompt, schema: zodToApiSchema(DesignOut), model: opts.model, effort: "medium", maxTokens: 8000 });
  const { design, notes } = normalizeDesign(res.data, script);
  return { design, notes, usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}

/** A design without a model: alternating typographic layouts, for --no-design and failures. */
export function fallbackDesign(script: Script): Design {
  return DesignSchema.parse({
    identity: DEFAULT_IDENTITY,
    scenes: script.beats.map((b, i) => ({ beat: i, layout: i % 2 ? "quote" : "headline", headline: b.text, accents: b.emphasis ? [{ text: b.emphasis, style: "marker" }] : [], entrance: i % 2 ? "mask" : "rise" })),
  });
}
