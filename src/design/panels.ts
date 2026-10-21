import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import type { OutPhrase } from "./timeline.ts";
import { bannedMetaphor, GRAPHIC_KINDS, GraphicSchema, parseNumber, saidInSpeech, type Graphic } from "./panel-graphics.ts";

/**
 * Split-screen montage (aleko.so-style news reels): the speaker in the bottom half, the top half
 * illustrating what is said, and a three-line hook title on the seam. directPanels() asks Claude what each
 * segment shows, in this order of preference (stage 17, "no AI slop"):
 *   photo   — a real photo from Openverse (src/make/photos.ts; CC0 / PDM / CC BY, attribution kept): the people,
 *             places, products and things actually named in the speech;
 *   graphic — code-rendered motion graphics (src/design/panel-graphics.ts): counters, charts from numbers
 *             in the speech, quote cards, timelines, comparisons, chat/search/post UI cards;
 *   ai      — a generated image (Antigravity), last resort, documentary/photographic prompts only.
 * Every panel carries a graphic as the fallback; symbolic AI metaphors (gavels, scales, floating apples,
 * brains, light bulbs, chess, puzzles…) are refused in code and the panel falls back to photo/graphic.
 */

export const CARD_KINDS = ["quote", "tags", "code", "stat"] as const;
export const CORNERS = ["tl", "tr", "bl", "br"] as const;
export const PANEL_SOURCES = ["photo", "graphic", "ai"] as const;
export type PanelSource = (typeof PANEL_SOURCES)[number];

export const CardSchema = z.object({ kind: z.enum(CARD_KINDS), corner: z.enum(CORNERS), title: z.string().default(""), lines: z.array(z.string()).default([]) });
export const PanelSchema = z.object({
  start: z.number(),
  end: z.number(),
  /** older panels.json files have only image_prompt: they count as "ai" and go through the metaphor filter */
  source: z.enum(PANEL_SOURCES).default("ai"),
  /** English keywords for the photo search (names of people/places/products are fine) */
  photo_query: z.string().default(""),
  /** last-resort AI prompt (documentary, photographic) */
  image_prompt: z.string().default(""),
  /** always present after normalisation: shown when the panel is a graphic or its photo/image is missing */
  graphic: GraphicSchema.nullable().default(null),
  cards: z.array(CardSchema).default([]),
  /**
   * stage 33 (abror_split): an insert pane drawn instead of the photo/graphic — article (key line under a marker), site
   * scroll, product UI, logo, number, text card, photo (src/design/abror.ts Pane); the graphic stays as the fallback
   */
  pane: z.record(z.string(), z.unknown()).optional(),
  /** stage 33: "full" = this panel takes the whole frame (a striking insert; the speaker is hidden meanwhile) */
  layout: z.enum(["split", "full"]).optional(),
});
export const HookLineSchema = z.object({ text: z.string(), style: z.enum(["display", "accent", "serif"]) });
export const PanelsSchema = z.object({ hook_title: z.array(HookLineSchema), panels: z.array(PanelSchema), image_style: z.string().default(""), notes: z.array(z.string()).default([]) });
export type Card = z.infer<typeof CardSchema>;
export type Panel = z.infer<typeof PanelSchema>;
export type HookLine = z.infer<typeof HookLineSchema>;
export type Panels = z.infer<typeof PanelsSchema>;

const Out = z.object({
  hook_title: z.array(z.object({ text: z.string(), style: z.enum(["display", "accent", "serif"]) })),
  panels: z.array(
    z.object({
      start: z.number(),
      end: z.number(),
      source: z.enum(PANEL_SOURCES),
      photo_query: z.string(),
      graphic: z.object({ kind: z.enum(GRAPHIC_KINDS), title: z.string(), items: z.array(z.object({ label: z.string(), value: z.string() })), note: z.string() }),
      image_prompt: z.string(),
      cards: z.array(z.object({ kind: z.enum(CARD_KINDS), corner: z.enum(CORNERS), title: z.string(), lines: z.array(z.string()) })),
    }),
  ),
  image_style: z.string(),
});
/** what older directors / tests return: image_prompt only */
const LooseOut = z.object({
  hook_title: Out.shape.hook_title,
  panels: z.array(z.looseObject({ start: z.number(), end: z.number(), source: z.enum(PANEL_SOURCES).optional(), photo_query: z.string().optional(), graphic: z.unknown().optional(), image_prompt: z.string().optional(), cards: Out.shape.panels.element.shape.cards })),
  image_style: z.string().default(""),
});

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** speech said during [start, end) */
const speechIn = (phrases: Pick<OutPhrase, "start" | "end" | "text">[], start: number, end: number) =>
  phrases.filter((p) => p.end > start && p.start < end).map((p) => p.text).join(" ");

/**
 * A graphic that only states what was said: numeric kinds keep only numbers that appear in the speech; a
 * graphic that loses its data becomes a quote card (from a quote card or the segment's speech).
 */
export function sanitizeGraphic(raw: unknown, speech: string, cards: Card[], segmentSpeech = speech): { graphic: Graphic; note?: string } {
  const parsed = GraphicSchema.safeParse(raw);
  const quoteFallback = (why?: string): { graphic: Graphic; note?: string } => {
    const q = cards.find((c) => c.kind === "quote")?.lines[0] ?? firstSentence(segmentSpeech);
    const tags = cards.find((c) => c.kind === "tags")?.lines ?? [];
    if (!q && tags.length) return { graphic: { kind: "list", title: "", items: tags.map((t) => ({ label: t, value: "" })), note: "" }, note: why };
    return { graphic: { kind: "quote", title: "", items: [], note: cut(q || "…", 140) }, note: why };
  };
  if (!parsed.success) return quoteFallback();
  const g = parsed.data;
  const items = g.items.map((x) => ({ label: cut(x.label, 60), value: cut(x.value, 110) })).filter((x) => x.label || x.value);
  const numeric = (kinds: string[]) => kinds.includes(g.kind);
  if (numeric(["counter", "bars", "line"])) {
    const said = items.filter((x) => parseNumber(x.value) && saidInSpeech(x.value, speech));
    const need = g.kind === "counter" ? 1 : g.kind === "bars" ? 2 : 3;
    if (said.length < need) return quoteFallback(`график «${g.kind}» убран: чисел нет в речи (${items.map((x) => x.value).join(", ")})`);
    return { graphic: { ...g, items: g.kind === "counter" ? said.slice(0, 1) : said } };
  }
  if (g.kind === "quote" && !(g.note.trim() || items[0]?.value)) return quoteFallback();
  if (["timeline", "compare", "chat", "search", "list"].includes(g.kind) && !items.length) return quoteFallback();
  if (g.kind === "post" && !g.note.trim()) return quoteFallback();
  return { graphic: { ...g, items } };
}

function firstSentence(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  const m = /^(.{20,140}?[.!?…])(\s|$)/.exec(t);
  return m ? m[1] : cut(t, 120);
}

/**
 * The anti-slop gate for one panel: banned metaphors in the AI prompt → photo (when there is a clean query)
 * or graphic; a banned / empty photo query → graphic; graphic panels drop corner cards (they would cover it).
 */
export function sanitizePanel(p: Panel, speech: string, segmentSpeech = speech): { panel: Panel; notes: string[] } {
  const notes: string[] = [];
  let source = p.source;
  const g = p.graphic ? { graphic: p.graphic } : sanitizeGraphic(null, speech, p.cards, segmentSpeech);
  if (source === "ai") {
    const bad = bannedMetaphor(p.image_prompt) ?? (p.image_prompt.trim() ? null : "empty");
    if (bad) {
      source = p.photo_query.trim() && !bannedMetaphor(p.photo_query) ? "photo" : "graphic";
      notes.push(`панель ${p.start.toFixed(1)} с: ИИ-картинка отклонена (${bad}) → ${source === "photo" ? "фото" : "графика"}`);
    }
  }
  if (source === "photo") {
    const bad = bannedMetaphor(p.photo_query) ?? (p.photo_query.trim() ? null : "empty");
    if (bad) {
      source = "graphic";
      notes.push(`панель ${p.start.toFixed(1)} с: фото-запрос «${p.photo_query}» отклонён (${bad}) → графика`);
    }
  }
  return { panel: { ...p, source, graphic: g.graphic, cards: source === "graphic" ? [] : p.cards }, notes };
}

/** Panels that tile [0, duration] in order, cards on distinct corners, text cut to card size, slop filtered. */
export function normalizePanels(raw: unknown, duration: number, phrases: Pick<OutPhrase, "start" | "end" | "text">[] = []): Panels {
  const o = LooseOut.parse(raw);
  const speech = phrases.map((p) => p.text).join(" ");
  const sorted = [...o.panels]
    .filter((p) => (p.image_prompt ?? "").trim() || (p.photo_query ?? "").trim() || p.graphic)
    .sort((a, b) => a.start - b.start)
    .slice(0, 5);
  const panels: Panel[] = [];
  const notes: string[] = [];
  sorted.forEach((p, i) => {
    const start = i === 0 ? 0 : panels[i - 1].end;
    const end = i === sorted.length - 1 ? duration : Math.min(duration, Math.max(start + 1.5, p.end));
    if (end - start < 1) return;
    const used = new Set<string>();
    const cards: Card[] = [];
    for (const c of p.cards.slice(0, 3)) {
      const corner = used.has(c.corner) ? CORNERS.find((k) => !used.has(k))! : c.corner;
      used.add(corner);
      const lines = c.lines.map((l) => cut(l, c.kind === "code" ? 34 : c.kind === "quote" ? 90 : 26)).filter(Boolean).slice(0, c.kind === "code" ? 6 : 4);
      if (!lines.length && c.kind !== "stat") continue;
      cards.push({ kind: c.kind, corner, title: cut(c.title, c.kind === "stat" ? 12 : 30), lines });
    }
    const seg = speechIn(phrases, start, end) || speech;
    const g = sanitizeGraphic(p.graphic ?? null, speech || seg, cards, seg);
    if (g.note) notes.push(g.note);
    const base: Panel = {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      source: p.source ?? "ai",
      photo_query: cut(p.photo_query ?? "", 80),
      image_prompt: cut(p.image_prompt ?? "", 400),
      graphic: g.graphic,
      cards,
    };
    const s = sanitizePanel(base, speech || seg, seg);
    notes.push(...s.notes);
    panels.push(s.panel);
  });
  if (!panels.length) panels.push({ start: 0, end: duration, source: "graphic", photo_query: "", image_prompt: "", graphic: sanitizeGraphic(null, speech, []).graphic, cards: [] });
  panels[panels.length - 1].end = duration;
  const hook = o.hook_title.map((l) => ({ text: cut(l.text, 18), style: l.style })).filter((l) => l.text).slice(0, 3);
  return { hook_title: hook, panels, image_style: cut(o.image_style, 300), notes };
}

/** Saved panels (maybe from before stage 17) through the same anti-slop gate. */
export function resanitizePanels(p: Panels, phrases: Pick<OutPhrase, "start" | "end" | "text">[] = []): Panels {
  const speech = phrases.map((x) => x.text).join(" ");
  const notes: string[] = [];
  const panels = p.panels.map((x) => {
    const s = sanitizePanel(x, speech, speechIn(phrases, x.start, x.end) || speech);
    notes.push(...s.notes);
    return s.panel;
  });
  return { ...p, panels, notes: [...new Set([...p.notes, ...notes])] };
}

export async function directPanels(phrases: OutPhrase[], duration: number, o: { llm: StructuredFn; language: string; instruction: string; model?: string }): Promise<{ panels: Panels; usd: number; usage: { input_tokens: number; output_tokens: number }; model: string; provider: string; estimate: boolean }> {
  const lines = phrases.map((p) => `${p.start.toFixed(1)}-${p.end.toFixed(1)}s: ${p.text}`).join("\n");
  const prompt = fill(loadPrompt("split.panels.user"), { language: o.language, duration: duration.toFixed(1), instruction: o.instruction || "(not given)", phrases: lines || "(no speech)" });
  const res = await o.llm({ system: loadPrompt("split.panels.system"), prompt, schema: zodToApiSchema(Out), model: o.model, effort: "medium", maxTokens: 5000 });
  return { panels: normalizePanels(res.data, duration, phrases), usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}

/** Without a model: one graphic panel (a quote from the speech, or the title), the EDL title split into a hook. */
export function fallbackPanels(duration: number, title: string, phrases: Pick<OutPhrase, "start" | "end" | "text">[] = []): Panels {
  const words = title.split(/\s+/).filter(Boolean);
  const third = Math.max(1, Math.ceil(words.length / 3));
  const styles: HookLine["style"][] = ["display", "accent", "serif"];
  const hook = [0, 1, 2].map((k) => ({ text: words.slice(k * third, (k + 1) * third).join(" "), style: styles[k] })).filter((l) => l.text);
  const speech = phrases.map((p) => p.text).join(" ");
  const graphic: Graphic = { kind: "quote", title: "", items: [], note: cut(firstSentence(speech) || title || "…", 140) };
  return { hook_title: hook, panels: [{ start: 0, end: duration, source: "graphic", photo_query: "", image_prompt: "", graphic, cards: [] }], image_style: "", notes: [] };
}
