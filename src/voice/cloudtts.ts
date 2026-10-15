import path from "node:path";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";
import { audioToPcm, GeminiTtsError, readCache, retryDelaySeconds, ttsCacheKey, writeCache, type PcmAudio } from "./gemini.ts";

/**
 * Google Cloud Text-to-Speech (docs checked 2026-10-15: docs.cloud.google.com/text-to-speech/docs/gemini-tts,
 * …/chirp3-hd, cloud.google.com/text-to-speech/pricing). Key: GOOGLE_CLOUD_API_KEY (a Cloud Console API key restricted
 * to "Cloud Text-to-Speech API"), sent in the x-goog-api-key header (never in the URL).
 *
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize
 *   Gemini-TTS: { input: { text, prompt }, voice: { languageCode: "ru-RU", name: "Charon", modelName },
 *                 audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000 } }
 *     models: VEDIT_CLOUD_TTS_MODEL → gemini-2.5-flash-tts → gemini-2.5-pro-tts → gemini-3.1-flash-tts-preview
 *     (the 3.8 TTS models are not served by Cloud TTS); ru-RU is GA; text ≤ 4000 bytes, prompt ≤ 4000 bytes.
 *     Price: tokens (2.5 Flash TTS $0.50 / 1M text in, $10 / 1M audio out, 25 audio tokens per second), no free quota.
 *   Chirp 3: HD: { input: { text }, voice: { languageCode: "ru-RU", name: "ru-RU-Chirp3-HD-Orus" },
 *                 audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, speakingRate } }
 *     no style prompt (pace only); free 1M characters a month, then $30 / 1M characters.
 *   → { audioContent: base64 } (LINEAR16 comes with a WAV header; raw PCM is handled too).
 */

export const CLOUD_TTS_URL = "https://texttospeech.googleapis.com/v1/text:synthesize";
export const CLOUD_GEMINI_MODELS = ["gemini-2.5-flash-tts", "gemini-2.5-pro-tts", "gemini-3.1-flash-tts-preview"] as const;
export const CLOUD_TTS_CACHE = path.join(WORKSPACE_ROOT, "_cache", "tts", "cloud");

export const CLOUD_KEY_HELP = [
  "Нет ключа Google Cloud (GOOGLE_CLOUD_API_KEY) для Cloud Text-to-Speech.",
  "Как получить ключ:",
  "  1. Откройте https://console.cloud.google.com, выберите или создайте проект (нужен включённый биллинг; Chirp 3: HD — 1 млн символов в месяц бесплатно).",
  "  2. APIs & Services → Library → найдите «Cloud Text-to-Speech API» → Enable.",
  "  3. APIs & Services → Credentials → Create credentials → API key; в «API restrictions» оставьте только Cloud Text-to-Speech API.",
  "  4. Добавьте строку GOOGLE_CLOUD_API_KEY=ваш_ключ в файл .env в папке vedit и перезапустите команду (или бота).",
].join("\n");

export function cloudApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const k = (env.GOOGLE_CLOUD_API_KEY || "").trim();
  return k || undefined;
}

export function cloudGeminiModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = (env.VEDIT_CLOUD_TTS_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...own, ...CLOUD_GEMINI_MODELS])];
}

export type CloudVoice = { kind: "gemini"; voiceName: string; languageCode: string } | { kind: "chirp3"; voiceName: string; languageCode: string };

/** ru → ru-RU, en → en-US, uz → uz-UZ */
export function bcp47(language: string): string {
  const l = language.trim();
  if (/^[a-z]{2}-[A-Z]{2}$/.test(l)) return l;
  const code = l.slice(0, 2).toLowerCase();
  return ({ ru: "ru-RU", en: "en-US", uz: "uz-UZ", kk: "kk-KZ", tr: "tr-TR", de: "de-DE", es: "es-ES", fr: "fr-FR" } as Record<string, string>)[code] ?? `${code}-${code.toUpperCase()}`;
}

/** Full Chirp 3: HD voice name: ru-RU-Chirp3-HD-Orus */
export const chirpName = (languageCode: string, voiceName: string) => `${languageCode}-Chirp3-HD-${voiceName}`;

export function cloudRequest(v: CloudVoice, text: string, o: { model?: string; prompt?: string; speakingRate?: number } = {}): unknown {
  if (v.kind === "chirp3") {
    return {
      input: { text },
      voice: { languageCode: v.languageCode, name: chirpName(v.languageCode, v.voiceName) },
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000, ...(o.speakingRate && Math.abs(o.speakingRate - 1) > 0.01 ? { speakingRate: o.speakingRate } : {}) },
    };
  }
  return {
    input: { text, ...(o.prompt ? { prompt: o.prompt } : {}) },
    voice: { languageCode: v.languageCode, name: v.voiceName, modelName: o.model },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 24000 },
  };
}

export interface CloudTtsOptions {
  key?: string;
  models?: string[];
  /** Gemini-TTS style prompt (ignored by Chirp 3: HD) */
  prompt?: string;
  /** Chirp 3: HD pace, 0.25–2 */
  speakingRate?: number;
  fetch?: typeof fetch;
  cacheDir?: string | null;
  maxRetries?: number;
  maxWait?: number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (l: string) => void;
}

export interface CloudTtsResult extends PcmAudio {
  /** gemini-2.5-flash-tts / chirp3-hd */
  model: string;
  cached: boolean;
}

const deadModels = new Set<string>();
export function resetCloudState() {
  deadModels.clear();
}

/** One text → speech through Cloud Text-to-Speech. */
export async function cloudTts(text: string, v: CloudVoice, o: CloudTtsOptions = {}): Promise<CloudTtsResult> {
  const key = o.key ?? cloudApiKey();
  if (!key) throw new GeminiTtsError(CLOUD_KEY_HELP, 401, true);
  const models = v.kind === "chirp3" ? ["chirp3-hd"] : (o.models ?? cloudGeminiModels());
  const cacheDir = o.cacheDir === undefined ? CLOUD_TTS_CACHE : o.cacheDir;
  const doFetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = o.maxRetries ?? 4;
  const maxWait = o.maxWait ?? 40;
  const style = v.kind === "chirp3" ? `rate=${o.speakingRate ?? 1}` : (o.prompt ?? "");
  const voiceKey = `${v.kind}:${v.languageCode}:${v.voiceName}`;
  for (const model of models) {
    const hit = await readCache(cacheDir, ttsCacheKey(text, voiceKey, style, model));
    if (hit) return { ...hit, model, cached: true };
  }
  const problems: string[] = [];
  for (const model of models) {
    if (deadModels.has(model) && model !== models.at(-1)) continue;
    const body = JSON.stringify(cloudRequest(v, text, { model, prompt: o.prompt, speakingRate: o.speakingRate }));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await doFetch(CLOUD_TTS_URL, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body });
      } catch (err) {
        if (attempt >= maxRetries) {
          problems.push(`${model}: сеть: ${err instanceof Error ? err.message : err}`);
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
      const err = (json as { error?: { message?: string; status?: string } })?.error;
      const msg = (err?.message ?? raw.slice(0, 200)).replace(/\s+/g, " ");
      if (res.ok) {
        const b64 = (json as { audioContent?: string })?.audioContent;
        if (!b64) {
          problems.push(`${model}: в ответе нет audioContent`);
          break;
        }
        const audio = audioToPcm(Buffer.from(b64, "base64"), "audio/L16;rate=24000");
        if (!audio.pcm.length) {
          problems.push(`${model}: пустой звук`);
          break;
        }
        await writeCache(cacheDir, ttsCacheKey(text, voiceKey, style, model), audio);
        return { ...audio, model, cached: false };
      }
      if (res.status === 401 || (res.status === 403 && !/billing/i.test(msg)) || (res.status === 400 && /api key|API_KEY/i.test(msg))) {
        throw new GeminiTtsError(`Cloud Text-to-Speech отклонил ключ (${res.status}): ${msg}\n${CLOUD_KEY_HELP}`, res.status, true);
      }
      if (res.status === 403) throw new GeminiTtsError(`Cloud Text-to-Speech: ${msg} — включите биллинг в проекте Google Cloud`, 403, true);
      if (res.status === 404 || (res.status === 400 && v.kind === "gemini" && /model/i.test(msg))) {
        deadModels.add(model);
        problems.push(`${model}: ${res.status} ${msg}`);
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= maxRetries) {
          problems.push(`${model}: ${res.status} после ${attempt + 1} попыток`);
          break;
        }
        const wait = Math.min(maxWait, retryDelaySeconds(json, res.headers.get("retry-after")) ?? 2 ** (attempt + 1));
        o.onEvent?.(`  Cloud TTS ${model}: ${res.status}, жду ${wait.toFixed(0)} с (попытка ${attempt + 2}/${maxRetries + 1})`);
        await sleep(wait * 1000);
        continue;
      }
      problems.push(`${model}: ${res.status} ${msg}`);
      break;
    }
  }
  throw new GeminiTtsError(`Cloud Text-to-Speech не ответил: ${problems.join("; ")}`, 503);
}
