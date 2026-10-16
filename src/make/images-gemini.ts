import fs from "node:fs/promises";
import path from "node:path";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { GEMINI_BASE, GeminiCallError, geminiPost, modelList, usageOf, type GeminiPostOptions } from "../lib/gemini-rest.ts";

/**
 * Scene images with only an API key (server mode, no agy): the Gemini image model over the API
 * (docs checked 2026-10-16: ai.google.dev/gemini-api/docs/image-generation). One request per image:
 *   interactions:     POST /v1beta/interactions { model, input, response_format: { type: "image", aspect_ratio } }
 *                     → steps[type=model_output].content[type=image] { data (base64), mime_type } | output_image.data
 *   generateContent:  POST /v1beta/models/<m>:generateContent
 *                     { contents, generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio } } }
 *                     → candidates[0].content.parts[].inlineData { mimeType, data }
 * Models: VEDIT_IMAGE_MODEL (comma list) first, then gemini-3.1-flash-lite-image (cheapest) →
 * gemini-nano-banana-2.1. Pricing (2026-10): image models have NO free tier (~$0.034 per 1K image);
 * a free-tier key gets a quota / billing error → the caller keeps photos only and typography elsewhere.
 */

export const DEFAULT_IMAGE_MODELS = ["gemini-3.1-flash-lite-image", "gemini-nano-banana-2.1"] as const;
export const USD_PER_IMAGE = 0.034;

export interface GeminiImageOptions extends Partial<Omit<GeminiPostOptions, "key">> {
  key?: string;
  models?: string[];
  apiBase?: string;
}

export interface GeminiImageRequest {
  beat: number;
  prompt: string;
}

export interface GeminiImagesResult {
  /** beat → file written in the work dir (scene_<beat>.png/.jpg/.webp) */
  written: Map<number, string>;
  failed: { beat: number; why: string }[];
  model: string;
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
}

type Json = Record<string, unknown>;
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** The base64 image of a response of either shape (the last image part wins). */
export function imageFromResponse(json: unknown): { data: string; mime: string } | null {
  const j = (json ?? {}) as Json;
  let found: { data: string; mime: string } | null = null;
  for (const st of arr(j.steps)) {
    if (st.type && st.type !== "model_output") continue;
    for (const c of arr(st.content)) if (c.type === "image" && typeof c.data === "string") found = { data: c.data, mime: String(c.mime_type ?? c.mimeType ?? "image/png") };
  }
  if (found) return found;
  const oi = j.output_image as Json | undefined;
  if (oi && typeof oi.data === "string") return { data: oi.data, mime: String(oi.mime_type ?? oi.mimeType ?? "image/png") };
  for (const p of arr((arr(j.candidates)[0]?.content as Json | undefined)?.parts)) {
    const d = (p.inlineData ?? p.inline_data) as Json | undefined;
    if (d && typeof d.data === "string") found = { data: d.data, mime: String(d.mimeType ?? d.mime_type ?? "image/png") };
  }
  return found;
}

const ext = (mime: string) => (/jpe?g/i.test(mime) ? "jpg" : /webp/i.test(mime) ? "webp" : "png");

function requestFor(api: "interactions" | "generateContent", base: string, model: string, prompt: string, aspect: string): { url: string; body: unknown } {
  if (api === "interactions") return { url: `${base}/interactions`, body: { model, input: [{ type: "text", text: prompt }], response_format: { type: "image", aspect_ratio: aspect } } };
  return { url: `${base}/models/${encodeURIComponent(model)}:generateContent`, body: { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspect } } } };
}

/**
 * Generates every request into `dir` as scene_<beat>.<ext>. A model that runs out of quota (or has no free
 * tier) is dropped for the rest of the batch; when no model is left the remaining images are reported as
 * failed — never thrown — so the caller falls back to photos / typography. Throws only on a rejected key.
 */
export async function generateImagesGemini(requests: GeminiImageRequest[], dir: string, o: GeminiImageOptions & { style: string; aspect: "9:16" | "16:9" | "1:1"; frameWords: string }): Promise<GeminiImagesResult> {
  const key = o.key ?? (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  if (!key) throw new GeminiCallError("нет GEMINI_API_KEY", "auth", 401);
  const base = o.apiBase ?? GEMINI_BASE;
  const models = [...(o.models ?? modelList(process.env.VEDIT_IMAGE_MODEL, DEFAULT_IMAGE_MODELS))];
  const apiFor = new Map<string, "interactions" | "generateContent">();
  const written = new Map<number, string>();
  const failed: { beat: number; why: string }[] = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let usedModel = models[0] ?? "none";
  for (const r of requests) {
    const prompt = fill(loadPrompt("make.images.single"), { frame: o.frameWords, prompt: r.prompt.replace(/\s+/g, " ").trim(), style: o.style });
    const problems: string[] = [];
    let done = false;
    while (!done && models.length) {
      const model = models[0];
      const apis = apiFor.has(model) ? [apiFor.get(model)!] : (["interactions", "generateContent"] as const);
      let dropModel = false;
      for (const api of apis) {
        const req = requestFor(api, base, model, prompt, o.aspect);
        let json: unknown;
        try {
          json = await geminiPost(req.url, req.body, { ...o, key, timeoutMs: o.timeoutMs ?? 180_000 });
        } catch (err) {
          if (!(err instanceof GeminiCallError)) throw err;
          if (err.kind === "auth") throw err;
          problems.push(`${model} (${api}): ${err.message}`);
          if (err.kind === "unsupported") {
            dropModel = true; // try the other shape; if both fail the model is dropped
            continue;
          }
          if (err.kind === "quota") dropModel = true;
          else failed.push({ beat: r.beat, why: err.message }); // transient: this image only
          done = err.kind !== "quota";
          break;
        }
        const img = imageFromResponse(json);
        if (!img) {
          // a text-only answer (e.g. a safety refusal) fails this image, not the model
          problems.push(`${model}: ответ без картинки`);
          failed.push({ beat: r.beat, why: "ответ без картинки" });
          apiFor.set(model, api);
          dropModel = false;
          done = true;
          break;
        }
        const file = path.join(dir, `scene_${r.beat}.${ext(img.mime)}`);
        await fs.writeFile(file, Buffer.from(img.data, "base64"));
        written.set(r.beat, file);
        apiFor.set(model, api);
        const u = usageOf(json);
        usage.input_tokens += u.input_tokens;
        usage.output_tokens += u.output_tokens;
        usedModel = model;
        dropModel = false;
        done = true;
        break;
      }
      if (dropModel && !done) {
        models.shift();
        apiFor.delete(model);
      }
    }
    if (!done) failed.push({ beat: r.beat, why: problems.join("; ").slice(0, 300) || "нет доступной модели" });
  }
  return { written, failed, model: usedModel, usd: Math.round(written.size * USD_PER_IMAGE * 1000) / 1000, usage };
}
