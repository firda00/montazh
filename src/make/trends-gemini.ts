import { fill, loadPrompt } from "../lib/prompts.ts";
import { GEMINI_BASE, GeminiCallError, geminiPost, modelList, usageOf, type GeminiPostOptions } from "../lib/gemini-rest.ts";
import { extractJson } from "../understand/vision/agy.ts";
import { LANGUAGE_NAMES } from "./script.ts";
import { TrendsSchema, type Trends, type TrendsResult } from "./trends.ts";

/**
 * Trend research with only an API key (server mode): Gemini with the Google Search grounding tool
 * (docs checked 2026-10-16: ai.google.dev/gemini-api/docs/google-search).
 *
 * Two request shapes, tried in this order per model (like the TTS client):
 *   interactions:     POST /v1beta/interactions { model, input, tools: [{ type: "google_search" }] }
 *                     → steps[type=google_search_call].queries, steps[type=model_output].content[type=text]
 *                       .text + .annotations[type=url_citation] { url, title, start_index, end_index }
 *   generateContent:  POST /v1beta/models/<m>:generateContent { contents, tools: [{ google_search: {} }] }
 *                     → candidates[0].content.parts[].text, candidates[0].groundingMetadata
 *                       { webSearchQueries, groundingChunks[].web { uri, title }, groundingSupports[] }
 * Structured output is not combined with the search tool: the prompt asks for JSON and the answer is
 * parsed leniently (extractJson) and validated with TrendsSchema. Fact sources come from the grounding
 * citations, not from URLs the model typed itself.
 *
 * Models: VEDIT_TRENDS_MODEL (comma list) first, then gemini-3.8-flash → gemini-2.5-flash. Pricing
 * (2026-10): search grounding is NOT on the free tier for Gemini 3 models (paid: 5 000 searches/month free,
 * then $14 / 1000); a free-tier key gets a quota error → next model → TrendsUnavailable, and `make` goes on
 * without trends.
 */

export const DEFAULT_TRENDS_MODELS = ["gemini-3.8-flash", "gemini-2.5-flash"] as const;

/** $ per 1M tokens (input, output incl. thinking) and per search query, paid tier, for the cost log */
const PRICES: Record<string, { in: number; out: number; search: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75, search: 0.014 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75, search: 0.014 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5, search: 0.035 },
};

export class TrendsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendsUnavailable";
  }
}

export interface GeminiTrendsOptions extends Partial<Omit<GeminiPostOptions, "key">> {
  key?: string;
  language?: string;
  models?: string[];
  apiBase?: string;
}

export interface Citation {
  url: string;
  title: string;
  /** the answer text the citation supports (may be empty) */
  text: string;
}

export interface GroundedAnswer {
  text: string;
  citations: Citation[];
  queries: string[];
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Text, citations and search queries of an answer of either shape. */
export function parseGrounded(json: unknown): GroundedAnswer {
  const j = (json ?? {}) as Json;
  const texts: string[] = [];
  const citations: Citation[] = [];
  const queries: string[] = [];
  // interactions: steps[] (and a flat outputs[] in some versions)
  const blocks: Json[] = [];
  for (const st of arr(j.steps)) {
    if (st.type === "google_search_call") queries.push(...(Array.isArray(st.queries) ? (st.queries as unknown[]).map(str).filter(Boolean) : []));
    if (st.type === "model_output" || st.type === undefined) blocks.push(...arr(st.content));
  }
  blocks.push(...arr(j.outputs));
  for (const b of blocks) {
    if (b.type !== "text" || typeof b.text !== "string") continue;
    texts.push(b.text);
    for (const a of arr(b.annotations)) {
      if (a.type !== "url_citation" || !str(a.url)) continue;
      const s = Number(a.start_index ?? a.startIndex);
      const e = Number(a.end_index ?? a.endIndex);
      citations.push({ url: str(a.url), title: str(a.title), text: Number.isFinite(s) && Number.isFinite(e) ? (b.text as string).slice(s, e) : "" });
    }
  }
  // generateContent
  const cand = arr(j.candidates)[0];
  if (cand) {
    const parts = arr((cand.content as Json | undefined)?.parts);
    const answer = parts.map((p) => str(p.text)).join("");
    if (answer) texts.push(answer);
    const gm = (cand.groundingMetadata ?? cand.grounding_metadata ?? {}) as Json;
    queries.push(...(Array.isArray(gm.webSearchQueries) ? (gm.webSearchQueries as unknown[]).map(str).filter(Boolean) : []));
    const chunks = arr(gm.groundingChunks).map((c) => (c.web ?? {}) as Json);
    const supported = new Map<number, string[]>();
    for (const s of arr(gm.groundingSupports)) {
      const seg = str((s.segment as Json | undefined)?.text);
      for (const i of Array.isArray(s.groundingChunkIndices) ? (s.groundingChunkIndices as number[]) : []) supported.set(i, [...(supported.get(i) ?? []), seg]);
    }
    chunks.forEach((w, i) => {
      if (str(w.uri)) citations.push({ url: str(w.uri), title: str(w.title), text: (supported.get(i) ?? []).join(" ") });
    });
  }
  return { text: texts.join("\n"), citations, queries };
}

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const host = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Every fact gets a grounding URL: the citation the model named (same URL or same site as its title),
 * else the citation whose supported text shares the most words with the fact; no match → "" (the script
 * writer then treats it as unsourced). Without citations the model's own sources are kept.
 */
export function attachSources(t: Trends, citations: Citation[]): Trends {
  if (!citations.length) return t;
  const facts = t.facts.map((f) => {
    const own = f.source.trim();
    const byUrl = own && citations.find((c) => c.url === own);
    if (byUrl) return f;
    const h = host(own);
    const bySite = h && citations.find((c) => c.title.replace(/^www\./, "") === h || host(c.url) === h);
    if (bySite) return { ...f, source: bySite.url };
    const fw = words(f.text);
    let best: Citation | null = null;
    let score = 1;
    for (const c of citations) {
      const cw = words(c.text);
      let n = 0;
      for (const w of fw) if (cw.has(w)) n++;
      if (n > score) {
        score = n;
        best = c;
      }
    }
    return { ...f, source: best?.url ?? "" };
  });
  return { ...t, facts };
}

function requestFor(api: "interactions" | "generateContent", base: string, model: string, prompt: string): { url: string; body: unknown } {
  if (api === "interactions") return { url: `${base}/interactions`, body: { model, input: prompt, tools: [{ type: "google_search" }] } };
  return { url: `${base}/models/${encodeURIComponent(model)}:generateContent`, body: { contents: [{ role: "user", parts: [{ text: prompt }] }], tools: [{ google_search: {} }] } };
}

export async function researchTrendsGemini(topic: string, o: GeminiTrendsOptions = {}): Promise<TrendsResult & { usd: number; provider: "gemini-search"; queries: string[]; sources: string[] }> {
  const key = o.key ?? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!key) throw new TrendsUnavailable("trends: нет GEMINI_API_KEY — исследование трендов через Google Search недоступно");
  const language = LANGUAGE_NAMES[o.language ?? "ru"] ?? o.language ?? "Russian";
  const prompt = fill(loadPrompt("make.trends.grounded"), { topic, language });
  const models = o.models ?? modelList(process.env.VEDIT_TRENDS_MODEL, DEFAULT_TRENDS_MODELS);
  const base = o.apiBase ?? GEMINI_BASE;
  const t0 = Date.now();
  const problems: string[] = [];
  for (const model of models) {
    for (const api of ["interactions", "generateContent"] as const) {
      const req = requestFor(api, base, model, prompt);
      let json: unknown;
      try {
        json = await geminiPost(req.url, req.body, { ...o, key, timeoutMs: o.timeoutMs ?? 240_000 });
      } catch (err) {
        if (!(err instanceof GeminiCallError)) throw err;
        problems.push(`${model} (${api}): ${err.message}`);
        if (err.kind === "auth") throw new TrendsUnavailable(`trends: Gemini ${err.message}`);
        if (err.kind === "unsupported") continue; // other shape, then next model
        break; // quota / transient → next model
      }
      const g = parseGrounded(json);
      let raw: unknown;
      try {
        raw = extractJson(g.text);
      } catch {
        raw = null;
      }
      const parsed = TrendsSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push(`${model} (${api}): ответ не JSON трендов`);
        break;
      }
      const trends = attachSources(parsed.data, g.citations);
      const usage = usageOf(json);
      const p = PRICES[model] ?? PRICES["gemini-3.8-flash"];
      const usd = (usage.input_tokens * p.in + usage.output_tokens * p.out) / 1e6 + Math.max(1, g.queries.length) * p.search;
      return { trends, wall_seconds: Math.round((Date.now() - t0) / 100) / 10, usage, model, usd: Math.round(usd * 10000) / 10000, provider: "gemini-search", queries: g.queries, sources: [...new Set(g.citations.map((c) => c.url))] };
    }
  }
  throw new TrendsUnavailable(`trends: Gemini с Google Search не ответил (${problems.join("; ").slice(0, 600)})`);
}
