/**
 * Small Gemini API REST helper for one-shot calls (trends with Google Search grounding, image generation):
 * POST with the key in x-goog-api-key, retries on short 429 / 5xx, and an error classification the callers
 * use to move to the next model or to give up gracefully:
 *   auth        — bad key / no access (retrying cannot help)
 *   quota       — daily quota, or the model / tool is not on the free tier (limit 0, billing required)
 *   unsupported — the model does not exist or does not take this request shape (400 / 404)
 *   transient   — 429 / 5xx that did not clear after the retries, network errors, timeouts
 */

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiFailure = "auth" | "quota" | "unsupported" | "transient";

export class GeminiCallError extends Error {
  constructor(
    message: string,
    readonly kind: GeminiFailure,
    readonly status: number,
  ) {
    super(message);
    this.name = "GeminiCallError";
  }
}

export interface GeminiPostOptions {
  key: string;
  fetch?: typeof fetch;
  /** retries of a short 429 / 5xx (default 2) */
  maxRetries?: number;
  /** longest single wait, s (default 30) */
  maxWait?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  onEvent?: (line: string) => void;
}

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorMessage(json: unknown, text: string): string {
  const e = (json as { error?: { message?: string; status?: string } })?.error;
  return (e?.message ? `${e.status ? `${e.status}: ` : ""}${e.message}` : text).replace(/\s+/g, " ").slice(0, 400);
}

function retryDelay(json: unknown, header: string | null): number | null {
  for (const d of (json as { error?: { details?: { retryDelay?: string }[] } })?.error?.details ?? []) {
    const m = /^([\d.]+)s$/.exec(d.retryDelay ?? "");
    if (m) return Number(m[1]);
  }
  const h = Number(header);
  return header && Number.isFinite(h) ? h : null;
}

/** Quota that waiting a few seconds will not fix: per-day limits, free tier without access (limit: 0), billing. */
export function isHardQuota(msg: string): boolean {
  return /per[ _]?day|PerDay|daily|limit:\s*0\b|free[ _-]?tier|billing|not available|FAILED_PRECONDITION|prepay|credits? (are )?depleted/i.test(msg);
}

/** POST JSON, return the parsed answer; throws GeminiCallError. */
export async function geminiPost(url: string, body: unknown, o: GeminiPostOptions): Promise<unknown> {
  const doFetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? sleepMs;
  const maxRetries = o.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const signals = [AbortSignal.timeout(o.timeoutMs ?? 180_000), ...(o.signal ? [o.signal] : [])];
      res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": o.key }, body: JSON.stringify(body), signal: AbortSignal.any(signals) });
    } catch (err) {
      if (o.signal?.aborted) throw err;
      if (attempt < maxRetries) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new GeminiCallError(`сеть: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (res.ok) return json;
    const msg = errorMessage(json, text);
    if (res.status === 401 || (res.status === 403 && !isHardQuota(msg)) || (res.status === 400 && /api key|API_KEY_INVALID/i.test(msg))) throw new GeminiCallError(`ключ отклонён (${res.status}): ${msg}`, "auth", res.status);
    if (isHardQuota(msg) && (res.status === 429 || res.status === 400 || res.status === 403)) throw new GeminiCallError(`нет квоты (${res.status}): ${msg}`, "quota", res.status);
    if (res.status === 400 || res.status === 404) throw new GeminiCallError(`${res.status}: ${msg}`, "unsupported", res.status);
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const wait = Math.min(o.maxWait ?? 30, retryDelay(json, res.headers.get("retry-after")) ?? 2 ** (attempt + 1));
      o.onEvent?.(`Gemini ${res.status}, жду ${wait.toFixed(0)} с`);
      await sleep(wait * 1000);
      continue;
    }
    throw new GeminiCallError(`${res.status}: ${msg}`, res.status === 429 ? "quota" : "transient", res.status);
  }
}

/** usage of either response shape → input / output tokens */
export function usageOf(json: unknown): { input_tokens: number; output_tokens: number } {
  const j = json as { usage?: Record<string, number>; usageMetadata?: Record<string, number> };
  const u = j?.usage;
  if (u) return { input_tokens: u.total_input_tokens ?? u.input_tokens ?? 0, output_tokens: (u.total_output_tokens ?? u.output_tokens ?? 0) + (u.total_thought_tokens ?? u.thought_tokens ?? 0) };
  const m = j?.usageMetadata;
  if (m) return { input_tokens: m.promptTokenCount ?? 0, output_tokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0) };
  return { input_tokens: 0, output_tokens: 0 };
}

/** a comma list from env, or the defaults */
export function modelList(raw: string | undefined, defaults: readonly string[]): string[] {
  const own = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...own, ...defaults])];
}
