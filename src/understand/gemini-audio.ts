import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { GeminiClient, type GenerateResult } from "./gemini-client.ts";
import { priceUsage } from "./vision/gemini.ts";

/**
 * Gemini audio understanding (inline audio, ≤ ~10 min): a second opinion on speech.
 *   transcribeAudio  — strict JSON segments (text, start/end s, language) for comparing with whisper.cpp;
 *   judgePronunciation — how a Russian listener hears a TTS take: a phonetic Cyrillic transcript and a list of
 *                        words said with an English accent, wrong stress, wrong case ending or garbled.
 * Models: VEDIT_AUDIO_MODEL (comma list) first, then the flash models; 429/5xx handled by GeminiClient.
 */

export const DEFAULT_AUDIO_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3.5-flash-lite", "gemini-flash-lite-latest"];

export function audioModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = (env.VEDIT_AUDIO_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...new Set([...own, ...DEFAULT_AUDIO_MODELS])];
}

export interface AudioCallOptions {
  key?: string;
  models?: string[];
  client?: GeminiClient;
  onLog?: (l: string) => void;
}

/** Audio file → small inline part (Opus 32 kbit/s mono 16 kHz). */
export async function inlineAudio(file: string): Promise<{ inline_data: { mime_type: string; data: string } }> {
  const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vedit-aud-")), "a.ogg");
  try {
    await ffmpeg(["-i", file, "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "32k", tmp]);
    return { inline_data: { mime_type: "audio/ogg", data: (await fs.readFile(tmp)).toString("base64") } };
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
  }
}

async function call(file: string, system: string, user: string, schema: unknown, o: AudioCallOptions): Promise<GenerateResult & { usd: number }> {
  const key = o.key ?? geminiApiKey();
  if (!key && !o.client) throw new Error("нет GEMINI_API_KEY");
  const client = o.client ?? new GeminiClient({ apiKey: key!, onLog: o.onLog, rounds: 1, roundWaitMs: 20_000 });
  const r = await client.generate(o.models ?? audioModels(), { system, parts: [await inlineAudio(file), { text: user }], schema, temperature: 0.1, rounds: 1 });
  return { ...r, usd: priceUsage(r.model, r.usage).usd };
}

export interface AudioSegment {
  start: number;
  end: number;
  text: string;
  language: string;
}

/** Gemini transcript of a speech file: segments with times (seconds) and per-segment language. */
export async function transcribeAudio(file: string, o: AudioCallOptions & { hint?: string } = {}): Promise<{ segments: AudioSegment[]; model: string; usd: number }> {
  const schema = {
    type: "OBJECT",
    properties: {
      segments: {
        type: "ARRAY",
        items: { type: "OBJECT", properties: { start: { type: "NUMBER" }, end: { type: "NUMBER" }, text: { type: "STRING" }, language: { type: "STRING" } }, required: ["start", "end", "text", "language"] },
      },
    },
    required: ["segments"],
  };
  const system = "You are a meticulous speech transcriber. Transcribe exactly what is said, verbatim, in the language spoken (Russian in Cyrillic, Uzbek in Latin script, English in Latin). Keep proper nouns, brand names and English terms in their usual written form (OpenAI, Claude, iPhone). Write numbers as digits. Never translate, never summarise, never invent words in silence or music.";
  const user = `Transcribe the speech as segments of one sentence or phrase each, with start and end time in seconds from the start of the file and the ISO 639-1 language of each segment.${o.hint ? `\nContext (names and terms that may occur): ${o.hint}` : ""}`;
  const r = await call(file, system, user, schema, o);
  const segs = ((r.data as { segments?: AudioSegment[] }).segments ?? []).filter((s) => s.text?.trim());
  return { segments: segs, model: r.model, usd: r.usd };
}

export interface PronunciationIssue {
  word: string;
  heard_as: string;
  kind: "accent" | "stress" | "case" | "garbled" | "skipped" | "other";
  severity: number;
}

/** How a native Russian listener hears a TTS take of `intended`. */
export async function judgePronunciation(file: string, intended: string, o: AudioCallOptions = {}): Promise<{ heard: string; issues: PronunciationIssue[]; naturalness: number; model: string; usd: number }> {
  const schema = {
    type: "OBJECT",
    properties: {
      heard: { type: "STRING" },
      naturalness: { type: "NUMBER" },
      issues: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { word: { type: "STRING" }, heard_as: { type: "STRING" }, kind: { type: "STRING", enum: ["accent", "stress", "case", "garbled", "skipped", "other"] }, severity: { type: "INTEGER" } },
          required: ["word", "heard_as", "kind", "severity"],
        },
      },
    },
    required: ["heard", "issues", "naturalness"],
  };
  const system =
    "You are a strict Russian phonetics editor checking a voice-over for a Russian social-media video. You listen like a native Russian viewer. " +
    "Foreign brand names must sound the way a Russian narrator says them (OpenAI → «Оупен Эй-Ай», Anthropic → «Антропик», Nvidia → «Энвидиа», Google → «Гугл»); " +
    "an English-accented or spelled-out-wrong pronunciation is an 'accent' issue. Report wrong word stress ('stress', write heard_as with the stressed vowel in CAPITALS), " +
    "wrong grammatical case or number agreement in spoken numbers ('case'), mumbled or distorted words ('garbled'), words from the text that were not spoken ('skipped'). Do not report punctuation or tiny pauses.";
  const user = `Intended text:\n${intended}\n\n1) "heard": write down exactly what was spoken, in Cyrillic, spelling every foreign name and number the way it actually sounded (e.g. «Энтропик» if it sounded like that, «две тысячи двадцать четыре» if the ending was missing).\n2) "issues": every problem as described (severity 1 minor … 3 bad).\n3) "naturalness": 1–10, how natural and engaging the delivery is for a Russian reels narrator.`;
  const r = await call(file, system, user, schema, o);
  const d = r.data as { heard?: string; issues?: PronunciationIssue[]; naturalness?: number };
  return { heard: d.heard ?? "", issues: d.issues ?? [], naturalness: d.naturalness ?? 0, model: r.model, usd: r.usd };
}
