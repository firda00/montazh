import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ffmpeg } from "../../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../../lib/prompts.ts";
import type { Highlights, Scenes } from "../../schemas/index.ts";
import type { AnalysisChunk, AnalysisContext, VisionProvider, VisionResult } from "./types.ts";

/** The "slim" default: cheapest Gemini that understands video. Override with VEDIT_VISION_MODEL. */
export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-lite";

/** USD per million tokens (text/image/video input; output incl. thinking). Source: ai.google.dev/gemini-api/docs/pricing, cached 2026-10. Unknown models are logged unpriced (usd 0). */
export const GEMINI_PRICES: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.0-flash": { in: 0.1, out: 0.4 },
};

export type MediaResolution = "low" | "medium" | "high" | "default";

export interface GeminiOptions {
  apiKey: string;
  model?: string;
  /** injectable for tests */
  fetchFn?: typeof fetch;
  /** clips up to this size go inline (base64); larger ones through the Files API. Gemini's inline request limit is 20 MB. */
  inlineMaxBytes?: number;
  /** frames per second and height of the clip sent to the model (Gemini samples 1 fps itself) */
  clipFps?: number;
  clipHeight?: number;
  /** token budget per frame; "default" leaves the API default */
  mediaResolution?: MediaResolution;
  /** directory for temporary clips (default: os tmpdir) */
  tmpDir?: string;
  apiBase?: string;
  timeoutMs?: number;
  /** poll interval while an uploaded file is PROCESSING */
  pollMs?: number;
}

export const SHOT_TYPES = ["close-up", "medium", "wide", "b-roll", "product", "screen", "unknown"];

/** Gemini responseSchema (OpenAPI subset). Times are relative to the clip; shots are referenced by index. */
export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          shot: { type: "integer", description: "shot index from the prompt" },
          description: { type: "string", description: "1-2 sentences: what is visible, what happens" },
          objects: { type: "array", items: { type: "string" } },
          people_count: { type: "integer" },
          emotion: { type: "string", description: "dominant mood of the people in frame, or 'none'" },
          shot_type: { type: "string", enum: SHOT_TYPES },
          quality_score: { type: "number", description: "0-1: sharpness, exposure, stability, composition" },
          focus_x: { type: "number", description: "0-1 horizontal position of the main face/subject (0 = left edge)", nullable: true },
          focus_y: { type: "number", description: "0-1 vertical position of the main face/subject (0 = top)", nullable: true },
        },
        required: ["shot", "description", "objects", "people_count", "emotion", "shot_type", "quality_score"],
        propertyOrdering: ["shot", "description", "objects", "people_count", "emotion", "shot_type", "quality_score", "focus_x", "focus_y"],
      },
    },
    highlights: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "number", description: "seconds from the clip start" },
          end: { type: "number" },
          reason: { type: "string" },
          score: { type: "number", description: "0-1 how good this moment is for a short vertical clip" },
        },
        required: ["start", "end", "reason", "score"],
        propertyOrdering: ["start", "end", "reason", "score"],
      },
    },
  },
  required: ["scenes", "highlights"],
  propertyOrdering: ["scenes", "highlights"],
};

export const ModelAnswerSchema = z.object({
  scenes: z.array(
    z.object({
      shot: z.number(),
      description: z.string(),
      objects: z.array(z.string()).default([]),
      people_count: z.number().default(0),
      emotion: z.string().default("unknown"),
      shot_type: z.string().default("unknown"),
      quality_score: z.number().default(0.5),
      focus_x: z.number().nullable().optional(),
      focus_y: z.number().nullable().optional(),
    }),
  ),
  highlights: z.array(z.object({ start: z.number(), end: z.number(), reason: z.string(), score: z.number() })).default([]),
});
export type ModelAnswer = z.infer<typeof ModelAnswerSchema>;

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildPrompt(chunk: AnalysisChunk, ctx: AnalysisContext): string {
  const len = chunk.end - chunk.start;
  const rel = (t: number) => r2(Math.min(len, Math.max(0, t - chunk.start)));
  const shots = chunk.shots.map((s) => `  ${s.index}: ${rel(s.start)}-${rel(s.end)}s`).join("\n");
  const phrases = chunk.phrases.map((p) => `  ${rel(p.start)}-${rel(p.end)}s: ${p.text}`).join("\n");
  return fill(loadPrompt("vision.gemini.user"), { len: r2(len), start: r2(chunk.start), width: ctx.media.width, height: ctx.media.height, language: ctx.language, shots: shots || "  (none)", transcript: phrases || "  (no speech)" });
}

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  totalTokenCount?: number;
}

export function priceUsage(model: string, u: GeminiUsage): { usd: number; priced: boolean } {
  const p = GEMINI_PRICES[model];
  if (!p) return { usd: 0, priced: false };
  const out = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
  return { usd: ((u.promptTokenCount ?? 0) * p.in + out * p.out) / 1e6, priced: true };
}

export class GeminiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

type MediaPart = { inline_data: { mime_type: string; data: string } } | { file_data: { mime_type: string; file_uri: string }; name: string };

/**
 * Real video understanding: the chunk is re-encoded as a small silent clip (speech is already
 * in the transcript), sent to Gemini with the shot list, and the structured answer is mapped
 * back onto absolute times. Shots the model skips get an honest "(not described)" entry, never a guess.
 */
export class GeminiVisionProvider implements VisionProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly fetchFn: typeof fetch;
  private readonly o: Required<Omit<GeminiOptions, "fetchFn" | "apiKey" | "model">>;
  private readonly apiKey: string;

  constructor(opts: GeminiOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.o = {
      inlineMaxBytes: opts.inlineMaxBytes ?? 15 * 1024 * 1024,
      clipFps: opts.clipFps ?? 2,
      clipHeight: opts.clipHeight ?? 360,
      mediaResolution: opts.mediaResolution ?? "default",
      tmpDir: opts.tmpDir ?? os.tmpdir(),
      apiBase: opts.apiBase ?? "https://generativelanguage.googleapis.com",
      timeoutMs: opts.timeoutMs ?? 300_000,
      pollMs: opts.pollMs ?? 2000,
    };
  }

  async analyze(chunk: AnalysisChunk, ctx: AnalysisContext): Promise<VisionResult> {
    const clip = await this.extractClip(chunk, ctx);
    try {
      const bytes = await fs.readFile(clip);
      const part: MediaPart = bytes.length <= this.o.inlineMaxBytes ? { inline_data: { mime_type: "video/mp4", data: bytes.toString("base64") } } : await this.uploadFile(bytes, `chunk-${chunk.index}.mp4`);
      try {
        return await this.generate(part, chunk, ctx);
      } finally {
        if ("name" in part) await this.deleteFile(part.name).catch(() => {});
      }
    } finally {
      await fs.rm(clip, { force: true }).catch(() => {});
    }
  }

  /** Silent, low-res, few-fps H.264 clip of the chunk: Gemini samples 1 fps anyway and the speech is in the transcript. */
  private async extractClip(chunk: AnalysisChunk, ctx: AnalysisContext): Promise<string> {
    const file = path.join(this.o.tmpDir, `vedit-gemini-${process.pid}-${Date.now()}-${chunk.index}.mp4`);
    await ffmpeg([
      "-ss", chunk.start.toFixed(3), "-to", chunk.end.toFixed(3), "-i", ctx.media.normalized_path,
      "-an", "-vf", `fps=${this.o.clipFps},scale=-2:${this.o.clipHeight}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      file,
    ]);
    return file;
  }

  private headers(extra: Record<string, string> = {}) {
    return { "x-goog-api-key": this.apiKey, ...extra };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.o.timeoutMs) });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 600);
      throw new GeminiError(`Gemini ${res.status} ${res.statusText}: ${text}`, res.status);
    }
    return res;
  }

  private async uploadFile(bytes: Buffer, displayName: string): Promise<MediaPart> {
    const start = await this.request(`${this.o.apiBase}/upload/v1beta/files`, {
      method: "POST",
      headers: this.headers({
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(bytes.length),
        "X-Goog-Upload-Header-Content-Type": "video/mp4",
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ file: { display_name: displayName } }),
    });
    const uploadUrl = start.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new GeminiError("Files API: no upload URL in the start response");
    const fin = await this.request(uploadUrl, {
      method: "POST",
      headers: this.headers({ "X-Goog-Upload-Command": "upload, finalize", "X-Goog-Upload-Offset": "0", "Content-Length": String(bytes.length) }),
      body: new Uint8Array(bytes),
    });
    let file = ((await fin.json()) as { file: { name: string; uri: string; state?: string; mimeType?: string } }).file;
    const deadline = Date.now() + this.o.timeoutMs;
    while (file.state === "PROCESSING") {
      if (Date.now() > deadline) throw new GeminiError("Files API: file stayed PROCESSING past the timeout");
      await new Promise((r) => setTimeout(r, this.o.pollMs));
      file = (await (await this.request(`${this.o.apiBase}/v1beta/${file.name}`, { headers: this.headers() })).json()) as typeof file;
    }
    if (file.state === "FAILED") throw new GeminiError("Files API: processing failed");
    return { file_data: { mime_type: file.mimeType ?? "video/mp4", file_uri: file.uri }, name: file.name };
  }

  private async deleteFile(name: string) {
    await this.request(`${this.o.apiBase}/v1beta/${name}`, { method: "DELETE", headers: this.headers() });
  }

  private async generate(part: MediaPart, chunk: AnalysisChunk, ctx: AnalysisContext): Promise<VisionResult> {
    const mediaPart = "name" in part ? { file_data: part.file_data } : part;
    const generationConfig: Record<string, unknown> = { responseMimeType: "application/json", responseSchema: RESPONSE_SCHEMA, temperature: 0.2 };
    if (this.o.mediaResolution !== "default") generationConfig.mediaResolution = `MEDIA_RESOLUTION_${this.o.mediaResolution.toUpperCase()}`;
    const body = {
      systemInstruction: { parts: [{ text: loadPrompt("vision.gemini.system") }] },
      contents: [{ role: "user", parts: [mediaPart, { text: buildPrompt(chunk, ctx) }] }],
      generationConfig,
    };
    const res = await this.request(`${this.o.apiBase}/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      usageMetadata?: GeminiUsage;
      promptFeedback?: { blockReason?: string };
    };
    if (json.promptFeedback?.blockReason) throw new GeminiError(`Gemini blocked the request: ${json.promptFeedback.blockReason}`);
    const cand = json.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    if (!text) throw new GeminiError(`Gemini returned no text (finishReason ${cand?.finishReason ?? "?"})`);
    let parsed: ModelAnswer;
    try {
      parsed = ModelAnswerSchema.parse(JSON.parse(text));
    } catch (err) {
      throw new GeminiError(`Gemini answer is not the expected JSON: ${err instanceof Error ? err.message : err}`);
    }
    const usage = json.usageMetadata ?? {};
    const price = priceUsage(this.model, usage);
    return {
      ...mapAnswer(parsed, chunk),
      cost: {
        model: this.model,
        usd: price.usd,
        units: {
          chunk_seconds: r2(chunk.end - chunk.start),
          input_tokens: usage.promptTokenCount ?? 0,
          output_tokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          ...(price.priced ? {} : { unpriced: 1 }),
        },
      },
    };
  }
}

/** Model answer (clip-relative, by shot index) → absolute scenes/highlights, exactly one scene per shot. */
export function mapAnswer(a: ModelAnswer, chunk: AnalysisChunk): { scenes: Scenes; highlights: Highlights } {
  const byShot = new Map(a.scenes.map((s) => [Math.round(s.shot), s]));
  const scenes: Scenes = chunk.shots.map((s) => {
    const start = Math.max(s.start, chunk.start);
    const end = Math.min(s.end, chunk.end);
    const m = byShot.get(s.index);
    if (!m) return { start, end, description: "(not described by the model)", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 };
    const fx = m.focus_x;
    const fy = m.focus_y;
    const focus = typeof fx === "number" && typeof fy === "number" && Number.isFinite(fx) && Number.isFinite(fy) ? { x: clamp01(fx), y: clamp01(fy) } : undefined;
    return {
      start,
      end,
      description: m.description.trim() || "(empty description)",
      objects: m.objects.map((o) => o.trim()).filter(Boolean).slice(0, 12),
      people_count: Math.max(0, Math.round(m.people_count)),
      emotion: m.emotion.trim() || "unknown",
      shot_type: SHOT_TYPES.includes(m.shot_type) ? m.shot_type : "unknown",
      quality_score: clamp01(m.quality_score),
      ...(focus ? { focus } : {}),
    };
  });
  const len = chunk.end - chunk.start;
  const highlights: Highlights = a.highlights
    .map((h) => ({ start: chunk.start + Math.min(len, Math.max(0, h.start)), end: chunk.start + Math.min(len, Math.max(0, h.end)), reason: h.reason.trim(), score: clamp01(h.score) }))
    .filter((h) => h.end - h.start >= 0.5)
    .map((h) => ({ ...h, start: r2(h.start), end: r2(h.end) }));
  return { scenes, highlights };
}
