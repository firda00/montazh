import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import type { Highlights, Transcript } from "../schemas/index.ts";
import { estimateTokens, round2 } from "./context.ts";

/**
 * Long-video mode, stage 1. An hour of speech is ~900 phrases: too much for one planning pack.
 * The model first reads a one-line-per-phrase index and names up to N candidate windows for the
 * instruction; stage 2 then plans from the full data of those windows only. Without a model
 * (or when it fails) the windows come from the top highlights.
 */

export interface Window {
  id: string;
  start: number;
  end: number;
  why: string;
  /** which stage produced it */
  source: "model" | "highlights";
}

export const WindowSchema = z.object({ id: z.string(), start: z.number(), end: z.number(), why: z.string(), source: z.enum(["model", "highlights"]) });

/** Above this many phrases (or this many estimated pack tokens) planning goes through a shortlist. */
export const LONG_PHRASES = 250;
export const LONG_TOKENS = 60_000;
export const DEFAULT_MAX_WINDOWS = 24;
/** phrases of context kept on each side of a chosen window */
const CONTEXT_PHRASES = 1;

export function isLong(transcript: Transcript, packTokens: number): boolean {
  return transcript.segments.length > LONG_PHRASES || packTokens > LONG_TOKENS;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** One line per phrase: id, time, speaker, truncated text. ~25 tokens per phrase. */
export function phraseIndex(transcript: Transcript): string {
  return transcript.segments.map((p, i) => `p${i} ${mmss(p.start)}-${mmss(p.end)}${p.speaker ? ` ${p.speaker}` : ""}${p.lang ? ` ${p.lang}` : ""}: ${cut(p.text.replace(/\s+/g, " "), 90)}`).join("\n");
}

const PickSchema = {
  type: "object",
  properties: {
    windows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string", description: "first phrase id (pN) of the window" },
          to: { type: "string", description: "last phrase id (pN) of the window, inclusive" },
          why: { type: "string", description: "one short sentence: why this moment fits the instruction" },
        },
        required: ["from", "to", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["windows"],
  additionalProperties: false,
};
const PickOut = z.object({ windows: z.array(z.object({ from: z.string(), to: z.string(), why: z.string() })) });

export interface ShortlistArgs {
  transcript: Transcript;
  highlights: Highlights;
  instruction: string;
  llm?: StructuredFn;
  maxWindows?: number;
  /** longest window in seconds; longer picks are split */
  maxWindowSeconds?: number;
  onEvent?: (line: string) => void;
}

export interface ShortlistResult {
  windows: Window[];
  usd: number;
  usage?: { input_tokens: number; output_tokens: number };
  model?: string;
  provider?: string;
  estimate?: boolean;
  note: string;
}

/** Windows from the highlight ranking: the deterministic fallback. */
export function windowsFromHighlights(transcript: Transcript, highlights: Highlights, max: number): Window[] {
  const picked = [...highlights].sort((a, b) => b.score - a.score).slice(0, max);
  return mergeWindows(picked.map((h, i) => ({ id: `w${i}`, start: h.start, end: h.end, why: h.reason, source: "highlights" as const })), transcript);
}

/**
 * Expands windows to whole phrases plus context, merges picks whose cores overlap or touch,
 * orders by time and renumbers. Only the cores decide merging, so split-up long picks stay
 * separate even though their context phrases overlap.
 */
export function mergeWindows(raw: Omit<Window, "id">[] | Window[], transcript: Transcript): Window[] {
  const segs = transcript.segments;
  type Core = { core: [number, number]; start: number; end: number; why: string; source: Window["source"] };
  const expanded: Core[] = raw.map((w) => {
    const idx = segs.map((p, i) => (p.start < w.end && p.end > w.start ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return { core: [w.start, w.end], start: w.start, end: w.end, why: w.why, source: w.source };
    const from = Math.max(0, idx[0] - CONTEXT_PHRASES);
    const to = Math.min(segs.length - 1, idx[idx.length - 1] + CONTEXT_PHRASES);
    return { core: [w.start, w.end], start: Math.min(w.start, segs[from].start), end: Math.max(w.end, segs[to].end), why: w.why, source: w.source };
  });
  expanded.sort((a, b) => a.core[0] - b.core[0]);
  const merged: Core[] = [];
  for (const w of expanded) {
    const last = merged[merged.length - 1];
    if (last && w.core[0] <= last.core[1] + 0.5) {
      last.core[1] = Math.max(last.core[1], w.core[1]);
      last.end = Math.max(last.end, w.end);
      if (!last.why.includes(w.why)) last.why = `${last.why}; ${w.why}`;
      if (w.source === "model") last.source = "model";
    } else merged.push({ ...w, core: [...w.core] });
  }
  return merged.map((w, i) => ({ id: `w${i}`, start: round2(w.start), end: round2(w.end), why: cut(w.why, 200), source: w.source }));
}

export async function shortlist(a: ShortlistArgs): Promise<ShortlistResult> {
  const max = a.maxWindows ?? DEFAULT_MAX_WINDOWS;
  const maxSec = a.maxWindowSeconds ?? 120;
  const fallback = (note: string): ShortlistResult => ({ windows: windowsFromHighlights(a.transcript, a.highlights, max), usd: 0, note });
  if (!a.llm) return fallback("shortlist: top highlights (no model)");
  const index = phraseIndex(a.transcript);
  const speakers = [...new Set(a.transcript.segments.map((p) => p.speaker).filter(Boolean))];
  const prompt = [
    `INSTRUCTION: ${a.instruction}`,
    `The video has ${a.transcript.segments.length} phrases (${mmss(a.transcript.segments.at(-1)?.end ?? 0)} of speech).${speakers.length ? ` Speakers: ${speakers.join(", ")} (S1 talks the most).` : ""}`,
    `Pick up to ${max} candidate windows for the instruction: moments a short-form editor would cut from — a strong claim, a story with a payoff, a concrete tip, emotion, a product shown. A window is a run of consecutive phrases (from pN to pM inclusive), at most ${maxSec} seconds; choose complete thoughts, spread across the whole video unless the instruction says otherwise. Do not pick everything: what you skip will not be seen by the editor.`,
    "PHRASES:",
    index,
  ].join("\n");
  a.onEvent?.(`  shortlist: ${a.transcript.segments.length} фраз → ≤${max} окон (${estimateTokens(prompt)} токенов)`);
  try {
    const res = await a.llm({ system: "You pre-select material for a short-form video editor. Answer with JSON only.", prompt, schema: PickSchema, effort: "low", maxTokens: 4000 });
    const out = PickOut.parse(res.data);
    const segs = a.transcript.segments;
    const raw: Omit<Window, "id">[] = [];
    for (const w of out.windows) {
      const from = Number(/^p(\d+)$/.exec(w.from.trim())?.[1]);
      const to = Number(/^p(\d+)$/.exec(w.to.trim())?.[1]);
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to >= segs.length || to < from) continue;
      // split over-long picks at phrase boundaries
      let s = from;
      while (s <= to) {
        let e = s;
        while (e + 1 <= to && segs[e + 1].end - segs[s].start <= maxSec) e++;
        raw.push({ start: segs[s].start, end: segs[e].end, why: w.why, source: "model" });
        s = e + 1;
      }
    }
    if (!raw.length) return fallback("shortlist: model returned no usable windows, using top highlights");
    const windows = mergeWindows(raw, a.transcript).slice(0, max);
    return { windows, usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate, note: `shortlist: ${windows.length} окон от модели (${res.model})` };
  } catch (err) {
    return fallback(`shortlist: model call failed (${err instanceof Error ? err.message : err}), using top highlights`);
  }
}
