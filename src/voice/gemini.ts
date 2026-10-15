import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * Google Gemini API text-to-speech (docs checked 2026-10-15: ai.google.dev/gemini-api/docs/speech-generation).
 *
 * Two request shapes are supported, tried in this order per model (the one that answers is remembered;
 * VEDIT_GEMINI_TTS_API=generateContent flips the order):
 *   - interactions (current):  POST /v1beta/interactions
 *       { model, input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
 *         response_format: { type: "audio" }, generation_config: { speech_config: [{ voice }] } }
 *       → steps[type=model_output].content[type=audio].data (base64 WAV, 24 kHz mono s16le)
 *   - generateContent (legacy, still served for the 2.5 models):  POST /v1beta/models/<model>:generateContent
 *       { contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ["AUDIO"],
 *         speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } } }
 *       → candidates[0].content.parts[].inlineData.data (3.8: a full RIFF WAV, mimeType audio/wav; 2.5: raw audio/L16)
 *       The 3.8 model speaks a "Say as …:" prefix out loud, so the style is only prefixed for 2.5 models.
 * Models (pricing page 2026-10: all four have a free tier; free-tier data may be used by Google, paid tier not):
 *   gemini-3.8-flash-tts → gemini-3.1-flash-tts-preview → gemini-2.5-flash-preview-tts → gemini-3.8-flash-lite-tts
 *   VEDIT_GEMINI_TTS_MODEL (one id or a comma list) goes first. 404 → next model, 429 → backoff then next model.
 * Russian is in the supported-language table of the 3.8 models; the language is detected from the text.
 * Results are cached by hash(text + voice + style + model) in workspace/_cache/tts/gemini/.
 */

export const GEMINI_TTS_MODELS = ["gemini-3.8-flash-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts", "gemini-3.8-flash-lite-tts"] as const;
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_TTS_RATE = 24000;
export const GEMINI_TTS_CACHE = path.join(WORKSPACE_ROOT, "_cache", "tts", "gemini");

/** One style for the whole narration, so every beat sounds like the same take. */
export const NARRATOR_STYLE =
  "a lively, confident documentary narrator: clear diction, natural brisk pace, warm and engaged, light emphasis on numbers and names, never theatrical";

export const GEMINI_KEY_HELP = [
  "Нет ключа Gemini API (GEMINI_API_KEY), поэтому голос Gemini недоступен.",
  "Как получить ключ (бесплатно, 2 минуты):",
  "  1. Откройте https://aistudio.google.com и войдите аккаунтом Google.",
  "  2. Нажмите «Get API key» → «Create API key».",
  "  3. Добавьте строку GEMINI_API_KEY=ваш_ключ в файл .env в папке vedit и перезапустите команду (или бота).",
  "Бесплатный уровень подходит для проб; для продакшена лучше платный (на бесплатном Google может использовать данные).",
].join("\n");

export type GeminiApi = "interactions" | "generateContent";

export function geminiApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim();
  return k || undefined;
}

/** Models to try, in order: VEDIT_GEMINI_TTS_MODEL (comma list) first, then the defaults. */
export function geminiTtsModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = (env.VEDIT_GEMINI_TTS_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...own, ...GEMINI_TTS_MODELS])];
}

export class GeminiTtsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** true: retrying cannot help (bad key, no access) */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "GeminiTtsError";
  }
}

export interface PcmAudio {
  pcm: Int16Array;
  rate: number;
}

/** Audio bytes from the API → mono s16 PCM: a RIFF/WAV container is parsed, anything else is raw L16 (rate from the mime). */
export function audioToPcm(bytes: Buffer, mime = ""): PcmAudio {
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") {
    let rate = GEMINI_TTS_RATE;
    let channels = 1;
    let bits = 16;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const id = bytes.toString("ascii", at, at + 4);
      let size = bytes.readUInt32LE(at + 4);
      const body = at + 8;
      if (id === "fmt ") {
        channels = bytes.readUInt16LE(body + 2);
        rate = bytes.readUInt32LE(body + 4);
        bits = bytes.readUInt16LE(body + 14);
      } else if (id === "data") {
        // streaming writers put 0 / 0xFFFFFFFF as the size: take the rest of the buffer
        if (!size || size === 0xffffffff || body + size > bytes.length) size = bytes.length - body;
        if (bits !== 16) throw new Error(`Gemini TTS: WAV ${bits} бит, ожидалось 16`);
        return { pcm: monoS16(bytes.subarray(body, body + size), channels), rate };
      }
      at = body + size + (size % 2);
    }
    throw new Error("Gemini TTS: в WAV нет блока data");
  }
  const m = /rate=(\d+)/i.exec(mime);
  return { pcm: monoS16(bytes, 1), rate: m ? Number(m[1]) : GEMINI_TTS_RATE };
}

function monoS16(buf: Buffer, channels: number): Int16Array {
  const n = Math.floor(buf.length / 2);
  const all = new Int16Array(n);
  for (let i = 0; i < n; i++) all[i] = buf.readInt16LE(i * 2);
  if (channels <= 1) return all;
  const out = new Int16Array(Math.floor(n / channels));
  for (let i = 0; i < out.length; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += all[i * channels + c];
    out[i] = Math.round(s / channels);
  }
  return out;
}

export function requestFor(api: GeminiApi, model: string, text: string, voiceName: string, style: string): { url: string; body: unknown } {
  if (api === "interactions") {
    return {
      url: `${GEMINI_API_BASE}/interactions`,
      body: {
        model,
        input: [{ type: "user_input", content: [{ type: "text", text, ...(style ? { annotations: [{ type: "speech_metadata", style }] } : {}) }] }],
        response_format: { type: "audio" },
        generation_config: { speech_config: [{ voice: voiceName }] },
      },
    };
  }
  return {
    url: `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:generateContent`,
    body: {
      // only the 2.5 models treat a "Say …:" prefix as an instruction; gemini-3.8-flash-tts reads it aloud
      // (checked live 2026-10-15), so newer models get the bare text here — their style goes through interactions
      contents: [{ parts: [{ text: style && /^gemini-2\.5/.test(model) ? `Say in the voice of ${style}:\n${text}` : text }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
    },
  };
}

interface AudioPart {
  data: string;
  mime: string;
}

/** The base64 audio of a response of either shape (the last audio part wins, as in the docs' jq). */
export function audioFromResponse(json: unknown): AudioPart | null {
  const j = json as {
    steps?: { type?: string; content?: { type?: string; data?: string; mime_type?: string; mimeType?: string }[] }[];
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string }; inline_data?: { data?: string; mime_type?: string } }[] } }[];
    output_audio?: { data?: string; mime_type?: string };
  };
  let found: AudioPart | null = null;
  for (const st of j.steps ?? []) {
    if (st.type && st.type !== "model_output") continue;
    for (const c of st.content ?? []) if (c.type === "audio" && c.data) found = { data: c.data, mime: c.mime_type ?? c.mimeType ?? "audio/wav" };
  }
  if (found) return found;
  if (j.output_audio?.data) return { data: j.output_audio.data, mime: j.output_audio.mime_type ?? "audio/wav" };
  for (const p of j.candidates?.[0]?.content?.parts ?? []) {
    const d = p.inlineData ?? (p.inline_data ? { data: p.inline_data.data, mimeType: p.inline_data.mime_type } : undefined);
    if (d?.data) found = { data: d.data, mime: d.mimeType ?? "audio/L16;rate=24000" };
  }
  return found;
}

/** Seconds to wait from a 429: RetryInfo.retryDelay ("12s"), the Retry-After header, or null. */
export function retryDelaySeconds(body: unknown, header?: string | null): number | null {
  const details = (body as { error?: { details?: { retryDelay?: string }[] } })?.error?.details ?? [];
  for (const d of details) {
    const m = /^([\d.]+)s$/.exec(d.retryDelay ?? "");
    if (m) return Number(m[1]);
  }
  const h = Number(header);
  return header && Number.isFinite(h) ? h : null;
}

const isDailyQuota = (msg: string) => /per[ _]?day|PerDay|daily/i.test(msg);

export interface GeminiTtsOptions {
  key?: string;
  models?: string[];
  style?: string;
  fetch?: typeof fetch;
  /** null: no cache */
  cacheDir?: string | null;
  /** 429/5xx retries per model (default 4) */
  maxRetries?: number;
  /** longest single wait, s (default 40) */
  maxWait?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (l: string) => void;
}

export interface GeminiTtsResult extends PcmAudio {
  model: string;
  api: GeminiApi;
  cached: boolean;
}

/** which API shape answered for a model, and models that do not exist / ran out of daily quota (per process) */
const apiFor = new Map<string, GeminiApi>();
const deadModels = new Set<string>();
/** tests: forget what was learnt about models */
export function resetGeminiState() {
  apiFor.clear();
  deadModels.clear();
}

export const ttsCacheKey = (text: string, voice: string, style: string, model: string) => createHash("sha256").update(JSON.stringify([text, voice, style, model])).digest("hex").slice(0, 24);

export async function readCache(dir: string | null, key: string): Promise<PcmAudio | null> {
  if (!dir) return null;
  const buf = await fs.readFile(path.join(dir, `${key}.wav`)).catch(() => null);
  return buf ? audioToPcm(buf) : null;
}

export async function writeCache(dir: string | null, key: string, a: PcmAudio) {
  if (!dir) return;
  const { wavBytes } = await import("./piper.ts");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${key}.wav`), wavBytes(a.pcm, a.rate));
}

/** One text → speech with a prebuilt Gemini voice. Throws GeminiTtsError when every model failed. */
export async function geminiTts(text: string, voiceName: string, o: GeminiTtsOptions = {}): Promise<GeminiTtsResult> {
  const key = o.key ?? geminiApiKey();
  if (!key) throw new GeminiTtsError(GEMINI_KEY_HELP, 401, true);
  const models = o.models ?? geminiTtsModels();
  const style = o.style ?? NARRATOR_STYLE;
  const cacheDir = o.cacheDir === undefined ? GEMINI_TTS_CACHE : o.cacheDir;
  const doFetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 4;
  const maxWait = o.maxWait ?? 40;

  for (const model of models) {
    const hit = await readCache(cacheDir, ttsCacheKey(text, voiceName, style, model));
    if (hit) return { ...hit, model, api: apiFor.get(model) ?? "interactions", cached: true };
  }
  const problems: string[] = [];
  for (const model of models) {
    if (deadModels.has(model) && model !== models.at(-1)) continue;
    let notFound = 0;
    // interactions first: its speech_metadata.style steers the delivery without being spoken (live check 2026-10-15);
    // generateContent is the fallback (answers for every TTS model, but 3.x models read a style prefix aloud)
    const apis: GeminiApi[] = apiFor.has(model) ? [apiFor.get(model)!] : process.env.VEDIT_GEMINI_TTS_API === "generateContent" ? ["generateContent", "interactions"] : ["interactions", "generateContent"];
    let nextModel = false;
    for (const api of apis) {
      if (nextModel) break;
      const req = requestFor(api, model, text, voiceName, style);
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await doFetch(req.url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(req.body) });
        } catch (err) {
          if (attempt >= maxRetries) {
            problems.push(`${model}: сеть: ${err instanceof Error ? err.message : err}`);
            nextModel = true;
            break;
          }
          await sleep(Math.min(maxWait, 2 ** attempt) * 1000);
          continue;
        }
        const raw = await res.text();
        let json: unknown = null;
        try {
          json = raw ? JSON.parse(raw) : null;
        } catch {}
        const msg = ((json as { error?: { message?: string } })?.error?.message ?? raw.slice(0, 200)).replace(/\s+/g, " ");
        if (res.ok) {
          const part = audioFromResponse(json);
          if (!part) {
            problems.push(`${model} (${api}): в ответе нет звука`);
            break; // try the other request shape, then the next model
          }
          const audio = audioToPcm(Buffer.from(part.data, "base64"), part.mime);
          if (!audio.pcm.length) {
            problems.push(`${model} (${api}): пустой звук`);
            break;
          }
          apiFor.set(model, api);
          await writeCache(cacheDir, ttsCacheKey(text, voiceName, style, model), audio);
          return { ...audio, model, api, cached: false };
        }
        if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key|API_KEY/i.test(msg))) {
          throw new GeminiTtsError(`Gemini API отклонил ключ (${res.status}): ${msg}\n${GEMINI_KEY_HELP}`, res.status, true);
        }
        if (res.status === 404 || res.status === 400) {
          // unknown model, or this model does not take this request shape: other shape, then next model
          problems.push(`${model} (${api}): ${res.status} ${msg}`);
          if (res.status === 404 && ++notFound === apis.length) deadModels.add(model);
          break;
        }
        if (res.status === 429 || res.status >= 500) {
          if (res.status === 429 && isDailyQuota(msg)) {
            deadModels.add(model);
            problems.push(`${model}: дневная квота исчерпана`);
            nextModel = true;
            break;
          }
          if (attempt >= maxRetries) {
            problems.push(`${model}: ${res.status} после ${attempt + 1} попыток`);
            nextModel = true;
            break;
          }
          const wait = Math.min(maxWait, retryDelaySeconds(json, res.headers.get("retry-after")) ?? 2 ** (attempt + 1));
          o.onEvent?.(`  Gemini TTS ${model}: ${res.status}, жду ${wait.toFixed(0)} с (попытка ${attempt + 2}/${maxRetries + 1})`);
          await sleep(wait * 1000);
          continue;
        }
        problems.push(`${model} (${api}): ${res.status} ${msg}`);
        nextModel = true;
        break;
      }
    }
  }
  throw new GeminiTtsError(`Gemini TTS не ответил ни одной моделью: ${problems.join("; ")}`, 503);
}
