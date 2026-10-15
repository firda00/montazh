import fs from "node:fs/promises";
import { GeminiError, type GeminiUsage } from "./vision/gemini.ts";

/**
 * A small Gemini API client for long jobs (events detection): Files API upload → wait ACTIVE →
 * generateContent with a JSON schema → delete. Requests are sequential; 429/5xx are retried with
 * the server's retryDelay (or exponential backoff), and a model that does not exist / has no quota
 * falls through to the next one in the list.
 */

export interface GeminiClientOptions {
  apiKey: string;
  fetchFn?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** retries per request on 429/5xx */
  maxRetries?: number;
  /** base backoff (ms) when the server gives no retryDelay */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onLog?: (line: string) => void;
  rounds?: number;
  roundWaitMs?: number;
}

export interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

export interface GenerateResult {
  data: unknown;
  text: string;
  model: string;
  usage: GeminiUsage;
  requests: number;
}

/** retryDelay ("37s") from a Google RPC error body, in ms */
export function retryDelayMs(body: string): number | null {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

/** A model the caller should skip (not found / not supported / quota of zero), as opposed to a transient error. */
export function isModelUnavailable(status: number | undefined, body: string): boolean {
  if (status === 404) return true;
  if (status === 400 && /not found|not supported|unsupported|is not available/i.test(body)) return true;
  // free tier without access to this model: "limit: 0"
  if (status === 429 && /limit:\s*0\b/.test(body)) return true;
  // the free tier's daily request quota per model (20/day for the newest flash): gone until tomorrow
  if (status === 429 && (/PerDay/i.test(body) || (retryDelayMs(body) ?? 0) > 600_000)) return true;
  return false;
}

export class GeminiClient {
  private readonly key: string;
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly timeoutMs: number;
  private readonly pollMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (line: string) => void;
  /** HTTP requests sent (all kinds), for the cost report */
  requests = 0;
  /** models that hung or had no quota in this run: later calls go straight to the next one */
  readonly dead = new Set<string>();
  /** extra rounds over the model list when all of them are overloaded, and the wait before each */
  rounds: number;
  roundWaitMs: number;

  constructor(o: GeminiClientOptions) {
    this.key = o.apiKey;
    this.f = o.fetchFn ?? fetch;
    this.base = o.apiBase ?? "https://generativelanguage.googleapis.com";
    this.timeoutMs = o.timeoutMs ?? 300_000;
    this.pollMs = o.pollMs ?? 3000;
    this.maxRetries = o.maxRetries ?? 4;
    this.backoffMs = o.backoffMs ?? 10_000;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = o.onLog ?? (() => {});
    this.rounds = o.rounds ?? 3;
    this.roundWaitMs = o.roundWaitMs ?? 90_000;
  }

  private headers(extra: Record<string, string> = {}) {
    return { "x-goog-api-key": this.key, ...extra };
  }

  /** One HTTP call with retries on 429 / 500 / 503 / network errors. Throws GeminiError(status) otherwise. */
  async request(url: string, init: RequestInit, what = "request", o: { networkRetries?: number; timeoutMs?: number } = {}): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        this.requests++;
        res = await this.f(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs ?? this.timeoutMs) });
      } catch (err) {
        if (attempt >= (o.networkRetries ?? this.maxRetries)) throw new GeminiError(`Gemini ${what}: ${err instanceof Error ? err.message : err}`);
        const wait = this.backoffMs * 2 ** attempt;
        this.log(`gemini ${what}: network error, retry in ${(wait / 1000).toFixed(0)}s`);
        await this.sleep(wait);
        continue;
      }
      if (res.ok) return res;
      const body = await res.text().catch(() => "");
      const transient = res.status === 429 || res.status === 500 || res.status === 503 || res.status === 504;
      // an overloaded model (5xx) gets two more tries, then the caller moves to the next model; 429 waits longer
      const limit = res.status === 429 ? this.maxRetries : Math.min(2, this.maxRetries);
      if (!transient || attempt >= limit || isModelUnavailable(res.status, body)) {
        throw new GeminiError(`Gemini ${what} ${res.status} ${res.statusText}: ${body.slice(0, 4000)}`, res.status);
      }
      const wait = Math.min(180_000, Math.max(retryDelayMs(body) ?? 0, this.backoffMs * 2 ** attempt));
      this.log(`gemini ${what}: ${res.status}, retry in ${(wait / 1000).toFixed(0)}s`);
      await this.sleep(wait);
    }
  }

  async upload(file: string, mimeType: string, displayName: string): Promise<UploadedFile> {
    const bytes = await fs.readFile(file);
    const start = await this.request(
      `${this.base}/upload/v1beta/files`,
      {
        method: "POST",
        headers: this.headers({
          "X-Goog-Upload-Protocol": "resumable",
          "X-Goog-Upload-Command": "start",
          "X-Goog-Upload-Header-Content-Length": String(bytes.length),
          "X-Goog-Upload-Header-Content-Type": mimeType,
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ file: { display_name: displayName } }),
      },
      "upload start",
    );
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new GeminiError("Files API: no upload URL in the start response");
    const fin = await this.request(
      uploadUrl,
      { method: "POST", headers: this.headers({ "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(bytes.length) }), body: new Uint8Array(bytes) },
      "upload",
    );
    let f = ((await fin.json()) as { file: { name: string; uri: string; state?: string; mimeType?: string } }).file;
    const deadline = Date.now() + this.timeoutMs;
    while (f.state === "PROCESSING") {
      if (Date.now() > deadline) throw new GeminiError("Files API: file stayed PROCESSING past the timeout");
      await this.sleep(this.pollMs);
      f = (await (await this.request(`${this.base}/v1beta/${f.name}`, { headers: this.headers() }, "file state")).json()) as typeof f;
    }
    if (f.state === "FAILED") throw new GeminiError("Files API: processing failed");
    return { name: f.name, uri: f.uri, mimeType: f.mimeType ?? mimeType };
  }

  async remove(name: string): Promise<void> {
    await this.request(`${this.base}/v1beta/${name}`, { method: "DELETE", headers: this.headers() }, "delete").catch(() => {});
  }

  /**
   * generateContent with a JSON response schema. `models` are tried in order: a model that does not
   * exist or has no quota is skipped; any other error is thrown.
   */
  async generate(models: string[], body: { system: string; parts: unknown[]; schema: unknown; mediaResolution?: "low" | "medium" | "high"; temperature?: number; rounds?: number }): Promise<GenerateResult> {
    const generationConfig: Record<string, unknown> = { responseMimeType: "application/json", responseSchema: body.schema, temperature: body.temperature ?? 0.2 };
    if (body.mediaResolution) generationConfig.mediaResolution = `MEDIA_RESOLUTION_${body.mediaResolution.toUpperCase()}`;
    const payload = JSON.stringify({ systemInstruction: { parts: [{ text: body.system }] }, contents: [{ role: "user", parts: body.parts }], generationConfig });
    let lastErr: unknown;
    const before = this.requests;
    // overload (5xx / timeouts) is transient: after a round where every model failed that way, wait and go round again
    for (let round = 0; round <= (body.rounds ?? this.rounds); round++) {
      if (round > 0) {
        const wait = this.roundWaitMs * round;
        this.log(`gemini: all models busy, next round in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
      }
      let transientOnly = true;
      for (const model of models) {
        if (this.dead.has(model)) continue;
        let res: Response;
        try {
          res = await this.request(`${this.base}/v1beta/models/${model}:generateContent`, { method: "POST", headers: this.headers({ "Content-Type": "application/json" }), body: payload }, `generate ${model}`, { networkRetries: 0 });
        } catch (err) {
          lastErr = err;
          const e = err as GeminiError;
          if (isModelUnavailable(e.status, e.message)) {
            // no such model / no quota: skip it for the rest of the run
            this.log(`gemini: ${model} unavailable (${e.status}), skipped from now on`);
            this.dead.add(model);
            continue;
          }
          if (e.status === 429 || e.status === 503 || e.status === 500 || e.status === 504 || e.status === undefined) {
            this.log(`gemini: ${model} busy (${e.status ?? "no answer"}), trying the next model`);
            continue;
          }
          transientOnly = false;
          throw err;
        }
        return await this.parse(res, model, before);
      }
      if (!transientOnly || models.every((m) => this.dead.has(m))) break;
    }
    throw lastErr instanceof Error ? lastErr : new GeminiError("no Gemini model available");
  }

  private async parse(res: Response, model: string, before: number): Promise<GenerateResult> {
      const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[]; usageMetadata?: GeminiUsage; promptFeedback?: { blockReason?: string }; modelVersion?: string };
      if (json.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
      const cand = json.candidates?.[0];
      const text = cand?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
      if (!text) throw new GeminiError(`Gemini returned no text (finishReason ${cand?.finishReason ?? "?"})`);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw new GeminiError(`Gemini answer is not JSON: ${err instanceof Error ? err.message : err}`);
      }
      return { data, text, model, usage: json.usageMetadata ?? {}, requests: this.requests - before };
  }
}
