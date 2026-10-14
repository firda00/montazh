import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import type { OutPhrase } from "./timeline.ts";

/**
 * Split-screen montage (aleko.so-style news reels): the speaker in the bottom half, the top half
 * illustrating what is said — a generated image in a framed card with UI cards over its corners —
 * and a three-line hook title on the seam. directPanels() asks Claude for the panels; images come
 * from src/make/images.ts (Antigravity).
 */

export const CARD_KINDS = ["quote", "tags", "code", "stat"] as const;
export const CORNERS = ["tl", "tr", "bl", "br"] as const;

export const CardSchema = z.object({ kind: z.enum(CARD_KINDS), corner: z.enum(CORNERS), title: z.string().default(""), lines: z.array(z.string()).default([]) });
export const PanelSchema = z.object({ start: z.number(), end: z.number(), image_prompt: z.string(), cards: z.array(CardSchema).default([]) });
export const HookLineSchema = z.object({ text: z.string(), style: z.enum(["display", "accent", "serif"]) });
export const PanelsSchema = z.object({ hook_title: z.array(HookLineSchema), panels: z.array(PanelSchema), image_style: z.string().default("") });
export type Card = z.infer<typeof CardSchema>;
export type Panel = z.infer<typeof PanelSchema>;
export type HookLine = z.infer<typeof HookLineSchema>;
export type Panels = z.infer<typeof PanelsSchema>;

const Out = z.object({
  hook_title: z.array(z.object({ text: z.string(), style: z.enum(["display", "accent", "serif"]) })),
  panels: z.array(z.object({ start: z.number(), end: z.number(), image_prompt: z.string(), cards: z.array(z.object({ kind: z.enum(CARD_KINDS), corner: z.enum(CORNERS), title: z.string(), lines: z.array(z.string()) })) })),
  image_style: z.string(),
});

const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Panels that tile [0, duration] in order, cards on distinct corners, text cut to card size. */
export function normalizePanels(raw: unknown, duration: number): Panels {
  const o = Out.parse(raw);
  const sorted = [...o.panels].filter((p) => p.image_prompt.trim()).sort((a, b) => a.start - b.start).slice(0, 5);
  const panels: Panel[] = [];
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
    panels.push({ start: Math.round(start * 1000) / 1000, end: Math.round(end * 1000) / 1000, image_prompt: cut(p.image_prompt, 400), cards });
  });
  if (!panels.length) panels.push({ start: 0, end: duration, image_prompt: "abstract cinematic background, soft light, depth of field", cards: [] });
  panels[panels.length - 1].end = duration;
  const hook = o.hook_title.map((l) => ({ text: cut(l.text, 18), style: l.style })).filter((l) => l.text).slice(0, 3);
  return { hook_title: hook, panels, image_style: cut(o.image_style, 300) };
}

export async function directPanels(phrases: OutPhrase[], duration: number, o: { llm: StructuredFn; language: string; instruction: string; model?: string }): Promise<{ panels: Panels; usd: number; usage: { input_tokens: number; output_tokens: number }; model: string; provider: string; estimate: boolean }> {
  const lines = phrases.map((p) => `${p.start.toFixed(1)}-${p.end.toFixed(1)}s: ${p.text}`).join("\n");
  const prompt = fill(loadPrompt("split.panels.user"), { language: o.language, duration: duration.toFixed(1), instruction: o.instruction || "(not given)", phrases: lines || "(no speech)" });
  const res = await o.llm({ system: loadPrompt("split.panels.system"), prompt, schema: zodToApiSchema(Out), model: o.model, effort: "medium", maxTokens: 4000 });
  return { panels: normalizePanels(res.data, duration), usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}

/** Without a model: one panel, the EDL title split into a hook. */
export function fallbackPanels(duration: number, title: string): Panels {
  const words = title.split(/\s+/).filter(Boolean);
  const third = Math.max(1, Math.ceil(words.length / 3));
  const styles: HookLine["style"][] = ["display", "accent", "serif"];
  const hook = [0, 1, 2].map((k) => ({ text: words.slice(k * third, (k + 1) * third).join(" "), style: styles[k] })).filter((l) => l.text);
  return { hook_title: hook, panels: [{ start: 0, end: duration, image_prompt: "cinematic abstract technology background, purple neon light, depth of field", cards: [] }], image_style: "" };
}
