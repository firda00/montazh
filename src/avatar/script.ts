import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { LANGUAGE_NAMES } from "../make/script.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";

/**
 * What the avatar says. Either the user's own text (split into lines here) or a topic, for which
 * Claude writes a spoken monologue (prompts/avatar.script.*) — the same structured-call path as the
 * `make` scriptwriter, with rules for speech instead of on-screen text.
 */

const MonologueOutSchema = z.object({
  title: z.string(),
  language: z.string(),
  lines: z.array(z.string()),
  hashtags: z.array(z.string()),
});

export interface Monologue {
  title: string;
  language: string;
  lines: string[];
  hashtags: string[];
}

/** Speaking rate used for estimates: Chatterbox Russian ≈ 14 characters (≈ 2.5 words) per second. */
export const CHARS_PER_SECOND = 14;

export function estimateSeconds(lines: string[], linePauseMs = 450): number {
  const chars = lines.reduce((n, l) => n + l.length, 0);
  return Math.round((chars / CHARS_PER_SECOND + (Math.max(0, lines.length - 1) * linePauseMs) / 1000 + 0.3) * 10) / 10;
}

const clean = (s: string) =>
  s
    .replace(/[*_`#>\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * User text → lines: blank-line / newline paragraphs are kept; one long paragraph is split into
 * sentences grouped up to ~maxChars, so the montage has places to cut.
 */
export function linesFromText(text: string, maxChars = 180): string[] {
  const paras = text
    .replace(/\r\n/g, "\n")
    .split(/\n+/)
    .map(clean)
    .filter(Boolean);
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    const sentences = p.split(/(?<=[.!?…])\s+/).filter(Boolean);
    let cur = "";
    for (const s of sentences) {
      if (cur && cur.length + 1 + s.length > maxChars) {
        out.push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * "/avatar …" with free text: a topic (short, one clause) or the script itself.
 * Explicit prefixes win: "тема: …" / "topic: …" and "текст: …" / "text: …".
 */
export function classifyAvatarInput(raw: string): { kind: "topic" | "text"; value: string } {
  const s = raw.trim();
  const pre = /^(тема|topic|текст|text)\s*:\s*/i.exec(s);
  if (pre) return { kind: /^(тема|topic)$/i.test(pre[1]) ? "topic" : "text", value: s.slice(pre[0].length).trim() };
  const words = s.split(/\s+/).filter(Boolean).length;
  const sentences = s.split(/(?<=[.!?…])\s+/).filter(Boolean).length;
  if (s.includes("\n") || sentences >= 2 || words > 18 || s.length > 140) return { kind: "text", value: s };
  return { kind: "topic", value: s };
}

export function normalizeMonologue(raw: unknown, language: string): Monologue {
  const out = MonologueOutSchema.parse(raw);
  const lines = out.lines.flatMap((l) => linesFromText(l, 240)).filter((l) => l.length > 1);
  if (!lines.length) throw new Error("сценарист вернул пустой монолог");
  return {
    title: clean(out.title).slice(0, 60) || lines[0].slice(0, 40),
    language: out.language?.trim().toLowerCase().slice(0, 5) || language,
    lines: lines.slice(0, 40),
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).slice(0, 6),
  };
}

export interface MonologueResult {
  monologue: Monologue;
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: string;
  estimate: boolean;
}

export async function writeMonologue(topic: string, llm: StructuredFn, o: { language?: string; seconds?: number; audience?: string; model?: string } = {}): Promise<MonologueResult> {
  const language = o.language ?? "ru";
  const seconds = o.seconds ?? 40;
  const words = Math.round(seconds * 2.5);
  const prompt = fill(loadPrompt("avatar.script.user"), {
    topic,
    language: LANGUAGE_NAMES[language] ?? language,
    seconds,
    words,
    lines: Math.max(4, Math.min(12, Math.round(seconds / 5))),
    audience: o.audience ?? "people scrolling Reels/Shorts on their phone",
  });
  const res = await llm({ system: loadPrompt("avatar.script.system"), prompt, schema: zodToApiSchema(MonologueOutSchema), model: o.model, effort: "medium", maxTokens: 4000 });
  const monologue = normalizeMonologue(res.data, language);
  // the model is told the language; keep the requested code so the TTS gets a code it knows
  monologue.language = language;
  return { monologue, usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}
