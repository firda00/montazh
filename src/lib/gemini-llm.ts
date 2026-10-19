import type { PlanUsage } from "../schemas/index.ts";
import { GEMINI_BASE, GeminiCallError, geminiPost, modelList } from "./gemini-rest.ts";

/**
 * Gemini as a text LLM (stage 29): the shared pieces of the Gemini planner backend (src/plan/backend/gemini.ts)
 * and the Gemini StructuredFn (src/lib/llm.ts) — JSON Schema → Gemini responseSchema conversion, token pricing,
 * the model list with fallback on 429 / 503 / 404, and thinking-level mapping.
 */

/** default text model: strong, cheap, free tier available (docs checked 2026-10-19) */
export const DEFAULT_GEMINI_LLM_MODEL = "gemini-3.8-flash";
/** tried in order after the configured model when it is overloaded, out of quota or missing */
export const GEMINI_LLM_FALLBACKS = ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"] as const;

/** Planner models: VEDIT_GEMINI_PLANNER_MODEL (comma list) first, then the fallbacks. */
export function plannerModels(env: NodeJS.ProcessEnv = process.env, explicit?: string): string[] {
  return modelList([explicit?.startsWith("gemini") ? explicit : "", env.VEDIT_GEMINI_PLANNER_MODEL ?? ""].filter(Boolean).join(","), GEMINI_LLM_FALLBACKS);
}

/** Other text steps (script, art director, translation, shortlist…): VEDIT_GEMINI_LLM_MODEL, then the fallbacks. */
export function textModels(env: NodeJS.ProcessEnv = process.env, explicit?: string): string[] {
  return modelList([explicit?.startsWith("gemini") ? explicit : "", env.VEDIT_GEMINI_LLM_MODEL ?? ""].filter(Boolean).join(","), GEMINI_LLM_FALLBACKS);
}

// ---------------------------------------------------------------- pricing

export interface GeminiTextPrice {
  /** $ / 1M input tokens (uncached) */
  in: number;
  /** $ / 1M output tokens, thinking included */
  out: number;
  /** $ / 1M cached input tokens (implicit / explicit context cache) */
  cacheRead: number;
}

/**
 * Paid tier, USD per 1M tokens. Source: ai.google.dev/gemini-api/docs/pricing, checked 2026-10-19.
 * 3.8-flash and 3.6-flash double on 2027-01-01 (`next`). gemini-3.5-flash / 3.7-flash are not on the page →
 * unpriced (logged with usd 0, priced false), never guessed. The free tier costs $0 but the key's tier is not
 * visible from the API, so the paid price is logged.
 */
export const GEMINI_TEXT_PRICES: Record<string, { price: GeminiTextPrice; next?: { from: string; price: GeminiTextPrice } }> = {
  "gemini-3.8-flash": { price: { in: 0.75, out: 3.75, cacheRead: 0.075 }, next: { from: "2027-01-01", price: { in: 1.5, out: 7.5, cacheRead: 0.15 } } },
  "gemini-3.6-flash": { price: { in: 0.75, out: 3.75, cacheRead: 0.075 }, next: { from: "2027-01-01", price: { in: 1.5, out: 7.5, cacheRead: 0.15 } } },
  "gemini-3.5-flash-lite": { price: { in: 0.3, out: 2.5, cacheRead: 0.03 } },
  "gemini-3.1-pro-preview": { price: { in: 2, out: 12, cacheRead: 0.2 } }, // prompts ≤ 200k tokens
  "gemini-2.5-flash": { price: { in: 0.3, out: 2.5, cacheRead: 0.03 } },
};

export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  toolUsePromptTokenCount?: number;
  totalTokenCount?: number;
}

export function priceFor(model: string, at: Date = new Date()): GeminiTextPrice | null {
  const e = GEMINI_TEXT_PRICES[model.replace(/^models\//, "")];
  if (!e) return null;
  return e.next && at.getTime() >= Date.parse(`${e.next.from}T00:00:00Z`) ? e.next.price : e.price;
}

/** usageMetadata → the planner's PlanUsage shape (input = uncached prompt; output includes thinking, as for Claude) */
export function geminiUsage(u: GeminiUsageMetadata | undefined): PlanUsage {
  const prompt = (u?.promptTokenCount ?? 0) + (u?.toolUsePromptTokenCount ?? 0);
  const cached = Math.min(prompt, u?.cachedContentTokenCount ?? 0);
  const thinking = u?.thoughtsTokenCount ?? 0;
  return { input_tokens: prompt - cached, output_tokens: (u?.candidatesTokenCount ?? 0) + thinking, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, thinking_tokens: thinking };
}

/** The model that actually answered (modelVersion: e.g. gemini-3.7-flash is served by gemini-3.8-flash), else the requested one. */
export function servedModel(json: { modelVersion?: string } | null | undefined, requested: string): string {
  const v = json?.modelVersion?.replace(/^models\//, "").trim();
  return v || requested;
}

/** Prices one request; unknown models are { usd: 0, priced: false }. */
export function geminiTextUsd(model: string, u: GeminiUsageMetadata | undefined, at: Date = new Date()): { usd: number; priced: boolean; usage: PlanUsage } {
  const usage = geminiUsage(u);
  const p = priceFor(model, at);
  if (!p) return { usd: 0, priced: false, usage };
  return { usd: (usage.input_tokens * p.in + usage.cache_read_input_tokens * p.cacheRead + usage.output_tokens * p.out) / 1e6, priced: true, usage };
}

// ---------------------------------------------------------------- schema conversion

type Json = Record<string, unknown>;

const isObj = (x: unknown): x is Json => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * JSON Schema (zod → zodToApiSchema, with $defs/$ref, anyOf, const, type arrays) → Gemini responseSchema /
 * function `parameters` (OpenAPI 3.0 subset). What Gemini does not take is simplified, never left in:
 *   $ref        → inlined from $defs (a recursive ref becomes a JSON-string field described as such)
 *   anyOf+null  → the other branch with nullable: true
 *   anyOf objs  → one object: properties merged, required = the intersection
 *   anyOf enums → one string enum (union)
 *   other anyOf → the first branch
 *   const       → a one-value string enum (non-string const: just the type)
 *   type arrays → the first non-null type (+ nullable)
 *   number enums, additionalProperties, $schema, title, default, pattern, examples… → dropped
 *   an object without properties (a free-form record) → kept as OBJECT only with properties; else a string
 * The answer is still validated by the caller's zod schema, so a looser schema here never lets bad data through.
 */
export function toGeminiSchema(schema: unknown): Json {
  const root = isObj(schema) ? schema : {};
  const defs: Json = { ...(isObj(root.definitions) ? root.definitions : {}), ...(isObj(root.$defs) ? root.$defs : {}) };

  const conv = (s: unknown, seen: string[]): Json => {
    if (!isObj(s)) return { type: "string" };
    const desc = typeof s.description === "string" ? s.description : undefined;
    const withDesc = (r: Json): Json => (desc ? { ...r, description: desc } : r);

    if (typeof s.$ref === "string") {
      const name = s.$ref.split("/").pop() ?? "";
      if (seen.includes(name) || seen.length > 24 || !(name in defs)) return { type: "string", description: `${desc ? `${desc} — ` : ""}JSON value encoded as a string` };
      return withDesc(conv(defs[name], [...seen, name]));
    }

    const variants = (Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null) as unknown[] | null;
    if (variants) {
      const nonNull = variants.filter((v) => !(isObj(v) && v.type === "null"));
      const nullable = nonNull.length < variants.length;
      const conv2 = nonNull.map((v) => conv(v, seen));
      let r: Json;
      if (conv2.length === 0) r = { type: "string" };
      else if (conv2.length === 1) r = conv2[0];
      else if (conv2.every((v) => v.type === "string" && Array.isArray(v.enum))) r = { type: "string", enum: [...new Set(conv2.flatMap((v) => v.enum as string[]))] };
      else if (conv2.every((v) => v.type === "object" && isObj(v.properties))) r = mergeObjects(conv2, "intersection");
      else if (conv2.every((v) => v.type === "string")) r = { type: "string" };
      else r = conv2[0];
      if (nullable) r = { ...r, nullable: true };
      return withDesc(r);
    }

    if (Array.isArray(s.allOf)) {
      const parts = (s.allOf as unknown[]).map((v) => conv(v, seen));
      return withDesc(parts.every((v) => v.type === "object") ? mergeObjects(parts, "union") : (parts[0] ?? { type: "string" }));
    }

    let type = s.type;
    let nullable = s.nullable === true;
    if (Array.isArray(type)) {
      nullable = nullable || type.includes("null");
      type = type.find((t) => t !== "null") ?? "string";
    }
    if (s.const !== undefined) {
      if (typeof s.const === "string") return withDesc({ type: "string", enum: [s.const], ...(nullable ? { nullable } : {}) });
      type = typeof s.const === "number" ? (Number.isInteger(s.const) ? "integer" : "number") : typeof s.const === "boolean" ? "boolean" : "string";
    }
    if (Array.isArray(s.enum)) {
      const strings = s.enum.filter((v): v is string => typeof v === "string");
      if (strings.length === s.enum.length && strings.length) return withDesc({ type: "string", enum: strings, ...(nullable ? { nullable } : {}) });
      if (!type) type = typeof s.enum[0] === "number" ? "number" : typeof s.enum[0] === "boolean" ? "boolean" : "string";
    }
    if (!type) type = isObj(s.properties) ? "object" : s.items ? "array" : "string";

    const out: Json = { type };
    if (nullable) out.nullable = true;
    if (type === "object") {
      const props = isObj(s.properties) ? s.properties : {};
      const keys = Object.keys(props);
      if (!keys.length) return { type: "string", ...(nullable ? { nullable } : {}), description: `${desc ? `${desc} — ` : ""}JSON object encoded as a string` };
      out.properties = Object.fromEntries(keys.map((k) => [k, conv(props[k], seen)]));
      const req = Array.isArray(s.required) ? (s.required as string[]).filter((k) => keys.includes(k)) : [];
      if (req.length) out.required = req;
      out.propertyOrdering = keys;
    } else if (type === "array") {
      out.items = conv(s.items ?? { type: "string" }, seen);
      if (typeof s.minItems === "number") out.minItems = s.minItems;
      if (typeof s.maxItems === "number") out.maxItems = s.maxItems;
    } else if (type === "number" || type === "integer") {
      if (typeof s.minimum === "number") out.minimum = s.minimum;
      if (typeof s.maximum === "number") out.maximum = s.maximum;
    } else if (type === "string") {
      if (s.format === "date-time") out.format = "date-time";
    }
    return withDesc(out);
  };

  return conv(root, []);
}

function mergeObjects(objs: Json[], required: "intersection" | "union"): Json {
  const props: Json = {};
  for (const o of objs) for (const [k, v] of Object.entries((o.properties as Json) ?? {})) if (!(k in props)) props[k] = v;
  const reqs = objs.map((o) => new Set((o.required as string[] | undefined) ?? []));
  const keys = Object.keys(props);
  const req = keys.filter((k) => (required === "union" ? reqs.some((r) => r.has(k)) : reqs.every((r) => r.has(k))));
  return { type: "object", properties: props, ...(req.length ? { required: req } : {}), propertyOrdering: keys };
}

// ---------------------------------------------------------------- requests

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export function thinkingLevel(effort: string | undefined): ThinkingLevel {
  if (effort === "low") return "low";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return "medium";
}

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown>; parts?: unknown[] };
  inlineData?: { mimeType: string; data: string };
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[]; role?: string }; finishReason?: string; finishMessage?: string }[];
  usageMetadata?: GeminiUsageMetadata;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
}

export interface GenerateOptions {
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
  /** models that failed this run (no quota / missing): skipped from now on */
  dead?: Set<string>;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  /** longest wait for a 429 / 503 before the same model is tried again, s (default 30; the planner waits out a per-minute limit) */
  maxWait?: number;
  timeoutMs?: number;
  /** per-model body rewrite (the planner swaps thought signatures when the conversation moves to another model) */
  transform?: (model: string, body: Json) => Json;
}

/** a 4xx/5xx that another model may not have: missing model, model-specific "not supported", quota, overload */
export function movesToNextModel(err: GeminiCallError): boolean {
  if (err.kind === "auth") return false;
  if (err.kind === "quota" || err.kind === "transient") return true;
  // a request-shape problem (schema, mime type with tools, bad payload) is the same on every model
  if (err.status === 400 && /schema|payload|unknown name|mime type|function calling|invalid argument/i.test(err.message)) return false;
  return err.status === 404 || /not found|not supported|unsupported|is not available|no longer available/i.test(err.message);
}

/**
 * generateContent over a model list: the first model that answers wins. Quota / overload / missing model →
 * the next one; a key problem or a bad request is thrown. A 400 about the thinking config is retried once on
 * the same model without it (older models).
 */
export async function generateWithFallback(models: string[], body: Json, o: GenerateOptions): Promise<{ json: GeminiResponse; model: string }> {
  let last: unknown = null;
  const dead = o.dead ?? new Set<string>();
  const list = models.filter((m) => !dead.has(m));
  if (!list.length) throw new GeminiCallError(`нет доступной модели Gemini (${models.join(", ")} недоступны в этом запуске)`, "quota", 429);
  for (const model of list) {
    let req = o.transform ? o.transform(model, body) : body;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const json = (await geminiPost(`${GEMINI_BASE}/models/${model}:generateContent`, req, { key: o.key, fetch: o.fetch, signal: o.signal, onEvent: o.onEvent, sleep: o.sleep, maxRetries: o.maxRetries ?? 2, maxWait: o.maxWait, timeoutMs: o.timeoutMs ?? 300_000 })) as GeminiResponse;
        return { json, model };
      } catch (err) {
        if (!(err instanceof GeminiCallError)) throw err;
        last = err;
        const gen = req.generationConfig as Json | undefined;
        if (attempt === 0 && err.status === 400 && /thinking/i.test(err.message) && gen?.thinkingConfig) {
          const { thinkingConfig: _drop, ...rest } = gen;
          req = { ...req, generationConfig: rest };
          continue;
        }
        if (!movesToNextModel(err)) throw err;
        if (err.hard || err.status === 404) dead.add(model);
        o.onEvent?.(`Gemini ${model}: ${err.message.slice(0, 160)} → следующая модель`);
        break;
      }
    }
  }
  throw last instanceof Error ? last : new GeminiCallError("нет доступной модели Gemini", "transient", 0);
}

/** finishReason values that mean "the model will not answer this" */
export const BLOCKED_FINISH = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

export function answerText(parts: GeminiPart[] | undefined): string {
  return (parts ?? []).filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
}

/** Undo the "JSON … encoded as a string" simplification of toGeminiSchema on an answer. */
export function reviveEncoded(data: unknown, gschema: Json): unknown {
  if (typeof data === "string" && gschema.type === "string" && typeof gschema.description === "string" && gschema.description.endsWith("encoded as a string")) {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  if (Array.isArray(data) && isObj(gschema.items)) return data.map((v) => reviveEncoded(v, gschema.items as Json));
  if (isObj(data) && isObj(gschema.properties)) {
    const props = gschema.properties as Record<string, Json>;
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, props[k] ? reviveEncoded(v, props[k]) : v]));
  }
  return data;
}
