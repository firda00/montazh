import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";
import type { Transcript } from "../schemas/index.ts";
import { normalizeUz } from "../design/abror.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { GeminiClient } from "./gemini-client.ts";
import { priceUsage } from "./vision/gemini.ts";

/**
 * Better words from whisper without touching its timings (stage 25):
 *   - whisperPrompt / termsFrom: a vocabulary prompt for whisper.cpp (--prompt) from the user's instruction and the
 *     names already heard in earlier chunks;
 *   - fixTranscript: one cheap structured LLM pass (Gemini flash-lite) that fixes obvious mishearings of names, brands,
 *     English terms and numbers. It returns substitutions {phrase, wrong words, right words}; we apply them word by
 *     word, so every word keeps its start/end: same count → 1:1, fewer → the tail merges into the last word (its span
 *     is the union, still contiguous), more → the extra words ride on the last token. Never a new boundary.
 *   - tidyTranscript: caption hygiene (capital letter at a phrase start, doubled punctuation);
 *   - detectLanguage: per-phrase ru / uz / en for mixed speech (whisper only knows a language per chunk).
 * VEDIT_ASR_FIX=auto (default: on when GEMINI_API_KEY is set) | off. Results are cached in workspace/_cache/asrfix/.
 */

export const ASRFIX_CACHE = path.join(WORKSPACE_ROOT, "_cache", "asrfix");
export const DEFAULT_FIX_MODELS = ["gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.8-flash"];

type Segment = Transcript["segments"][number];

const LATIN_TERM = /(?<![\p{L}\p{N}])[A-Za-z][A-Za-z0-9&.'’+-]*[A-Za-z0-9+]|(?<![\p{L}\p{N}])[A-Z](?![\p{L}])/gu;
const STOP_CAPS = new Set(["Это", "Но", "И", "А", "Я", "Мы", "Вы", "Он", "Она", "Они", "Так", "Да", "Нет", "Ну", "Вот", "Если", "Когда", "Что", "Как", "В", "На", "С", "По", "Для", "The", "A", "I", "It", "And", "But", "So", "We", "You"]);

/** Names and terms in a text: Latin words and capitalised words that do not start a sentence. */
export function termsFrom(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(LATIN_TERM)) if (m[0].length >= 2 && !STOP_CAPS.has(m[0])) out.push(m[0].replace(/[.,]+$/, ""));
  const words = text.split(/\s+/);
  words.forEach((w, k) => {
    const clean = w.replace(/^[«"(]+|[»")!?.,:;]+$/g, "");
    if (k > 0 && !/[.!?…]$/.test(words[k - 1]) && /^[А-ЯЁ][а-яё]{2,}/.test(clean) && !STOP_CAPS.has(clean)) out.push(clean);
  });
  return out;
}

/** The most frequent terms of a list, at most `max`. */
export function topTerms(terms: string[], max = 15): string[] {
  const n = new Map<string, number>();
  for (const t of terms) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([t]) => t);
}

/**
 * whisper.cpp's initial prompt from a hint (the user's instruction, a glossary): a short line of the terms to expect,
 * ≤ ~200 characters (whisper keeps ~224 prompt tokens; a long prompt makes it parrot the prompt in silence).
 */
export function whisperPrompt(hint: string, extra: string[] = []): string {
  const terms = topTerms([...termsFrom(hint), ...extra], 15);
  if (!terms.length) return "";
  let s = "";
  for (const t of terms) {
    const next = s ? `${s}, ${t}` : t;
    if (next.length > 190) break;
    s = next;
  }
  return `${s}.`;
}

// ---- language per phrase ----
const UZ_LATIN = /[ʻʼ‘’'](?=[a-z])|\b(va|bu|uchun|bilan|emas|ham|lekin|yoki|kerak|bo['ʻ‘’]?l|qil|men|siz|biz|nima|qanday|juda|yaxshi|endi)\b|o['ʻ‘’]|g['ʻ‘’]/i;
const UZ_CYR = /[ўқғҳЎҚҒҲ]/;
const EN_WORDS = /\b(the|and|is|are|you|we|this|that|with|for|it's|what|have|not|of|to|in)\b/i;

/** ru / uz / en of one phrase, or `fallback` when the text does not say clearly. */
export function detectLanguage(text: string, fallback: string): string {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cyr = (text.match(/[А-Яа-яЁёЎўҚқҒғҲҳ]/g) ?? []).length;
  if (cyr > latin * 2) return UZ_CYR.test(text) ? "uz" : fallback === "uz" ? "uz" : "ru";
  if (latin > cyr * 2 && latin >= 6) {
    if (UZ_LATIN.test(text)) return "uz";
    if (EN_WORDS.test(text)) return "en";
    return fallback === "ru" ? "en" : fallback;
  }
  return fallback;
}

// ---- caption hygiene ----
/** A capital letter at the start of every phrase, no doubled punctuation, no stray spaces; words keep their times. */
export function tidyTranscript(t: Transcript): Transcript {
  const segments = t.segments.map((s) => {
    const uz = (s.lang ?? t.language) === "uz";
    const words = s.words.map((w, k) => {
      let x = w.w.replace(/\s+/g, " ").trim().replace(/([,.!?;:])\1+/g, "$1").replace(/^[-–—]+(?=\p{L})/u, "");
      if (uz) x = normalizeUz(x);
      if (k === 0) x = x.replace(/^([«"(]?)(\p{Ll})/u, (_m, q: string, c: string) => q + c.toUpperCase());
      return { ...w, w: x || w.w };
    });
    return { ...s, words, text: words.map((w) => w.w).join(" ") };
  });
  return { ...t, segments };
}

// ---- the correction pass ----
export interface WordFix {
  phrase: number;
  from: string;
  to: string;
}

const norm = (w: string) => w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Applies substitutions to a transcript: `wrong` must match consecutive words of the phrase (ignoring case and
 * punctuation). Timings never change: see the module comment. Returns the new transcript and what was applied.
 */
export function applyFixes(t: Transcript, fixes: { p: number; wrong: string; right: string }[]): { transcript: Transcript; applied: WordFix[] } {
  const segs: Segment[] = t.segments.map((s) => ({ ...s, words: s.words.map((w) => ({ ...w })) }));
  const applied: WordFix[] = [];
  for (const f of fixes) {
    const seg = segs[f.p];
    if (!seg) continue;
    const wrong = f.wrong.split(/\s+/).map(norm).filter(Boolean);
    const right = f.right.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
    if (!wrong.length || !right.length || wrong.length > 5 || right.length > 6) continue;
    if (wrong.join(" ") === right.map(norm).join(" ") && f.wrong === f.right) continue;
    const ws = seg.words;
    let at = -1;
    for (let i = 0; i + wrong.length <= ws.length && at < 0; i++) if (wrong.every((x, k) => norm(ws[i + k].w) === x)) at = i;
    if (at < 0) continue;
    const span = ws.slice(at, at + wrong.length);
    // keep the punctuation that followed the last original word ("Грог," → "Grok,")
    const tail = /[,.!?;:…»")]+$/.exec(span.at(-1)!.w)?.[0] ?? "";
    const head = /^[«"(]+/.exec(span[0].w)?.[0] ?? "";
    const rightClean = right.map((w) => w.replace(/^[«"(]+|[,.!?;:…»")]+$/g, ""));
    const out = span.map((w) => ({ ...w }));
    if (rightClean.length >= out.length) {
      // 1:1 — a middle word keeps the punctuation it had («Грок, Грок, Грок?» → «Grok, Grok, Grok?»)
      const punct = (x: string) => /[,.!?;:…»")]+$/.exec(x)?.[0] ?? "";
      out.forEach((w, k) => {
        const own = k < out.length - 1 ? punct(right[k]) || punct(w.w) : "";
        w.w = (k < out.length - 1 ? rightClean[k] : rightClean.slice(k).join(" ")) + own;
      });
    } else {
      // fewer words: 1:1 for the first ones, the last right word takes the rest of the span
      const merged: typeof out = [];
      rightClean.forEach((r, k) => {
        if (k < rightClean.length - 1) merged.push({ ...out[k], w: r });
        else merged.push({ ...out[k], w: r, end: out.at(-1)!.end });
      });
      out.splice(0, out.length, ...merged);
    }
    out[0].w = head + out[0].w;
    out[out.length - 1].w += tail;
    const before = span.map((w) => w.w).join(" ");
    ws.splice(at, span.length, ...out);
    seg.text = ws.map((w) => w.w).join(" ");
    applied.push({ phrase: f.p, from: before, to: out.map((w) => w.w).join(" ") });
  }
  return { transcript: { ...t, segments: segs }, applied };
}

export interface FixOptions {
  hint?: string;
  key?: string;
  models?: string[];
  client?: GeminiClient;
  cacheDir?: string | null;
  /** phrases per request (long transcripts go in batches) */
  batch?: number;
  onLog?: (l: string) => void;
}

export interface FixResult {
  transcript: Transcript;
  changes: WordFix[];
  model: string;
  usd: number;
  requests: number;
  cached: boolean;
}

const SCHEMA = {
  type: "OBJECT",
  properties: { fixes: { type: "ARRAY", items: { type: "OBJECT", properties: { p: { type: "INTEGER" }, wrong: { type: "STRING" }, right: { type: "STRING" } }, required: ["p", "wrong", "right"] } } },
  required: ["fixes"],
};

const SYSTEM = [
  "You proofread an automatic speech-recognition transcript (whisper) of a video, to be shown as captions.",
  "Fix ONLY obvious mishearings: proper names of people, companies, brands and products, English terms and abbreviations, and numbers that were clearly misheard — when the context or the hint makes the right word certain.",
  "Never rephrase, never fix grammar, style, word order or the speaker's own mistakes, never add or drop content, never translate. When unsure, leave it.",
  "Write a name the way it is usually written in a text of this language (Russian texts keep Latin brand names: Tesla, SpaceX, OpenAI, ChatGPT; people's names in Cyrillic: Илон Маск).",
  "Return {\"fixes\": [{\"p\": phrase number, \"wrong\": the exact consecutive words as they appear in that phrase, \"right\": the corrected words}]}; an empty list when nothing is wrong.",
].join(" ");

/** One structured pass over the transcript (in batches); cached by content + hint + model list. */
export async function fixTranscript(t: Transcript, o: FixOptions = {}): Promise<FixResult> {
  const models = o.models ?? (process.env.VEDIT_ASR_FIX_MODEL ? process.env.VEDIT_ASR_FIX_MODEL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_FIX_MODELS);
  const cacheDir = o.cacheDir === undefined ? ASRFIX_CACHE : o.cacheDir;
  const key = createHash("sha256").update(JSON.stringify([t.segments.map((s) => s.text), o.hint ?? "", models])).digest("hex").slice(0, 24);
  const cacheFile = cacheDir ? path.join(cacheDir, `${key}.json`) : null;
  let fixes: { p: number; wrong: string; right: string }[] | null = null;
  let model = "";
  let usd = 0;
  let requests = 0;
  let cached = false;
  if (cacheFile) {
    try {
      const c = JSON.parse(await fs.readFile(cacheFile, "utf8")) as { fixes: typeof fixes; model: string };
      fixes = c.fixes;
      model = c.model;
      cached = true;
    } catch {}
  }
  if (!fixes) {
    const apiKey = o.key ?? geminiApiKey();
    if (!apiKey && !o.client) throw new Error("нет GEMINI_API_KEY для правки распознанной речи");
    const client = o.client ?? new GeminiClient({ apiKey: apiKey!, onLog: o.onLog, rounds: 1, roundWaitMs: 15_000 });
    const size = o.batch ?? 150;
    fixes = [];
    for (let b = 0; b < t.segments.length; b += size) {
      const part = t.segments.slice(b, b + size);
      const lines = part.map((s, k) => `p${b + k}${s.lang ? ` [${s.lang}]` : ""}: ${s.text}`).join("\n");
      const user = `${o.hint ? `HINT (what the video is about, names and terms that occur): ${o.hint}\n\n` : ""}TRANSCRIPT (language ${t.language}):\n${lines}`;
      const r = await client.generate(models, { system: SYSTEM, parts: [{ text: user }], schema: SCHEMA, temperature: 0, rounds: 1 });
      model = r.model;
      requests += r.requests;
      usd += priceUsage(r.model, r.usage).usd;
      for (const f of (r.data as { fixes?: { p: number; wrong: string; right: string }[] }).fixes ?? []) fixes.push({ p: Math.round(f.p), wrong: String(f.wrong ?? ""), right: String(f.right ?? "") });
    }
    if (cacheFile) {
      await fs.mkdir(cacheDir!, { recursive: true });
      await fs.writeFile(cacheFile, JSON.stringify({ fixes, model }, null, 1));
    }
  }
  const { transcript, applied } = applyFixes(t, fixes);
  return { transcript, changes: applied, model, usd, requests, cached };
}

/** VEDIT_ASR_FIX: "off" disables the correction pass; "auto"/unset runs it when a Gemini key exists. */
export function asrFixEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.VEDIT_ASR_FIX ?? "auto").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false") return false;
  return !!geminiApiKey(env);
}
