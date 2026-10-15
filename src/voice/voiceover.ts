import fs from "node:fs/promises";
import path from "node:path";
import type { Script } from "../make/script.ts";
import { AUTO_VOICE, autoVoice, getVoice, languageCode, piperVoiceFor, requireVoice, VOICES, type VoiceDef } from "./catalog.ts";
import { geminiApiKey, NARRATOR_STYLE, type GeminiTtsOptions } from "./gemini.ts";
import { cloudApiKey, type CloudTtsOptions } from "./cloudtts.ts";
import { concatPcm, synthesize, writeWav, type PcmClip, type SentenceSynth, type SynthResult } from "./piper.ts";
import { normalizeForTts } from "./normalize.ts";

/**
 * Voiceover for `make`: every beat's spoken line (beat.voiceover, else its on-screen text) is synthesised
 * with Piper, each beat is stretched to its speech (+ a short lead-in and tail), and the speech is laid on
 * the video timeline as one WAV that mixSoundtrack puts on top of the (ducked) music and effects.
 */

const FPS = 30;
/** speech starts this long after the scene cut (the headline is already moving) */
export const VOICE_LEAD = 0.25;
/** and the scene holds this long after the last word (short: the next beat cuts in on the voice) */
export const VOICE_TAIL = 0.35;
/** narration defaults for make: a touch faster than Piper's 1.0, livelier noise, varied per sentence */
export const NARRATION = { lengthScale: 0.92, noiseScale: 0.72, noiseW: 0.9, sentencePauseMs: 140 } as const;
export const BEAT_MAX = 15;

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

/** One spoken word on the video timeline (times estimated inside its sentence, see speechWords). */
export interface SpokenWord {
  beat: number;
  text: string;
  start: number;
  end: number;
}

export interface VoiceoverResult {
  /** the voice that actually spoke (a Gemini voice without a key → its Piper fallback) */
  voice: VoiceDef;
  engine: "piper" | "gemini" | "cloud";
  /** gemini/cloud: the model that answered */
  model?: string;
  script: Script;
  /** the voice on the video timeline (WAV, starts at 0, as long as the video) */
  track: string;
  duration: number;
  /** per beat: when the speech plays on the timeline */
  beats: { beat: number; start: number; end: number; text: string }[];
  captions: CaptionCue[];
  /** word-level times (proportional to the spoken length of each word inside its sentence) */
  words: SpokenWord[];
  warnings: string[];
}

/** What the narrator says on each beat. */
export const narrationLines = (script: Script) => script.beats.map((b) => (b.voiceover?.trim() || b.text).trim());

const ceilFrame = (s: number) => Math.ceil(s * FPS - 1e-6) / FPS;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Beat durations from speech lengths: lead + speech + tail on the frame grid, at least `min`, at most BEAT_MAX. */
export function fitBeatsToSpeech(script: Script, speech: number[], o: { lead?: number; tail?: number; min?: number } = {}): Script {
  const lead = o.lead ?? VOICE_LEAD;
  const tail = o.tail ?? VOICE_TAIL;
  const min = o.min ?? 2;
  return {
    ...script,
    beats: script.beats.map((b, i) => {
      const s = speech[i] ?? 0;
      if (!(s > 0)) return b;
      return { ...b, seconds: Math.min(BEAT_MAX, Math.max(min, ceilFrame(lead + s + tail))) };
    }),
  };
}

/** Beat start times exactly as the composers place them (frame-rounded running sum). */
export function beatStarts(script: Script): { start: number; duration: number }[] {
  let frame = 0;
  return script.beats.map((b) => {
    const frames = Math.max(1, Math.round(b.seconds * FPS));
    const t = { start: frame / FPS, duration: frames / FPS };
    frame += frames;
    return t;
  });
}

/** Places each beat's speech at its scene start + lead (never overlapping the previous beat's speech). */
export function layVoiceTrack(clips: PcmClip[], starts: { start: number }[], duration: number, lead = VOICE_LEAD): { pcm: Int16Array; rate: number; at: number[] } {
  const rate = clips.find((c) => c.pcm.length)?.rate ?? 22050;
  const total = Math.ceil(duration * rate);
  const parts: Int16Array[] = [];
  const gaps: number[] = [];
  const at: number[] = [];
  let pos = 0;
  clips.forEach((c, i) => {
    const want = Math.round((starts[i].start + lead) * rate);
    const from = Math.max(want, pos + (i ? Math.round(rate * 0.1) : 0));
    at.push(from / rate);
    gaps.push(from - pos);
    parts.push(c.pcm);
    pos = from + c.pcm.length;
  });
  const pcm = concatPcm(parts, gaps);
  const out = new Int16Array(Math.max(total, 1));
  out.set(pcm.subarray(0, out.length));
  return { pcm: out, rate, at };
}

/** Sentences → short caption cues (≤ maxWords), timed proportionally to characters inside each sentence. */
export function captionCues(sentences: { line: number; text: string; start: number; end: number }[], lineStarts: number[], lineOffsets: number[], maxWords = 6): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const s of sentences) {
    const shift = lineOffsets[s.line] - lineStarts[s.line];
    const t0 = s.start + shift;
    const t1 = s.end + shift;
    const words = s.text.split(/\s+/).filter(Boolean);
    const groups: string[][] = [];
    for (let i = 0; i < words.length; i += maxWords) groups.push(words.slice(i, i + maxWords));
    // a lonely last word joins the previous group
    if (groups.length > 1 && groups.at(-1)!.length === 1) groups[groups.length - 2].push(...groups.pop()!);
    const chars = groups.map((g) => g.join(" ").length);
    const total = chars.reduce((a, b) => a + b, 0) || 1;
    let t = t0;
    groups.forEach((g, k) => {
      const d = ((t1 - t0) * chars[k]) / total;
      cues.push({ start: r3(t), end: r3(t + d), text: g.join(" ") });
      t += d;
    });
  }
  return cues;
}

/**
 * Word times from sentence times: inside a sentence each written word gets a share proportional to how long it
 * is when spoken ("2026" → "две тысячи двадцать шесть" is long), plus a small constant per word. Good enough
 * to make on-screen words appear with the voice.
 */
export function speechWords(sentences: { line: number; text: string; start: number; end: number }[], lineStarts: number[], lineOffsets: number[], language = "ru"): SpokenWord[] {
  const out: SpokenWord[] = [];
  for (const s of sentences) {
    const shift = lineOffsets[s.line] - lineStarts[s.line];
    const t0 = s.start + shift;
    const t1 = s.end + shift;
    const words = s.text.split(/\s+/).filter(Boolean);
    const weight = words.map((w) => {
      let spoken = w;
      try {
        spoken = normalizeForTts(w, language);
      } catch {}
      return spoken.replace(/[^\p{L}\p{N}]/gu, "").length + 1.5;
    });
    const total = weight.reduce((a, b) => a + b, 0) || 1;
    let t = t0;
    words.forEach((w, k) => {
      const d = ((t1 - t0) * weight[k]) / total;
      out.push({ beat: s.line, text: w, start: r3(t), end: r3(t + d) });
      t += d;
    });
  }
  return out;
}

/** Paid-tier price of a narration (free tiers make it $0 in practice): Gemini API 3.8 Flash TTS ≈ 32 audio tokens/s × $9/1M;
 *  Cloud Gemini-TTS 2.5 Flash 25 tokens/s × $10/1M; Chirp 3: HD $30 / 1M characters (first 1M a month free). */
export function ttsUsd(engine: string, model: string | undefined, speechSeconds: number, chars: number): number {
  const usd = engine === "gemini" ? speechSeconds * 32 * 9e-6 : model === "chirp3-hd" ? chars * 30e-6 : speechSeconds * 25 * (/pro/.test(model ?? "") ? 20e-6 : 10e-6);
  return Math.round(usd * 1e4) / 1e4;
}

/** Gemini style for the narration: the narrator style plus a pace hint from --voice-speed (Piper length_scale semantics). */
export function geminiStyle(lengthScale?: number): string {
  const base = process.env.VEDIT_GEMINI_TTS_STYLE || NARRATOR_STYLE;
  if (lengthScale === undefined || Math.abs(lengthScale - 1) < 0.05) return base;
  return `${base}; ${lengthScale < 1 ? "noticeably faster pace than usual" : "slower, unhurried pace"}`;
}

/** A catalogue voice usable locally for `make`: Piper as is; a Chatterbox preset falls back to its Piper source or the language default. */
export function resolveMakeVoice(id: string, language: string, hasGoogleKey = !!(geminiApiKey() || cloudApiKey())): { voice: VoiceDef; warning?: string } {
  if (AUTO_VOICE.test(id.trim())) return { voice: autoVoice(language, hasGoogleKey) };
  const v = requireVoice(id);
  const code = languageCode(language);
  // Gemini voices speak the language of the text (Russian, English, Uzbek… detected automatically)
  if (v.engine === "gemini" || v.engine === "chirp3") return { voice: v };
  if (v.engine === "piper") return { voice: v, warning: v.language !== code ? `голос ${v.id} говорит на «${v.language}», а ролик на «${language}» — будет акцент` : undefined };
  const p = piperVoiceFor(v) ?? VOICES.find((x) => x.engine === "piper" && x.language === code) ?? getVoice("denis")!;
  return { voice: p, warning: `голос ${v.id} работает только в аватаре (Colab); для ролика взят локальный ${p.id}` };
}

export interface VoiceoverOptions {
  /** Piper length_scale (default NARRATION.lengthScale = 0.92) */
  lengthScale?: number;
  /** false: Piper's flat defaults (no noise tweaks, no per-sentence variation) */
  lively?: boolean;
  synth?: SentenceSynth;
  /** Gemini engine: style / test hooks */
  gemini?: GeminiTtsOptions;
  /** Cloud TTS engine: key / test hooks */
  cloud?: CloudTtsOptions;
  onEvent?: (l: string) => void;
}

/** Synthesises the narration of a script, stretches its beats and writes the timeline voice track into `dir`. */
export async function makeVoiceover(script: Script, voiceId: string, dir: string, o: VoiceoverOptions = {}): Promise<VoiceoverResult> {
  const warnings: string[] = [];
  const { voice, warning } = resolveMakeVoice(voiceId, script.language);
  if (warning) warnings.push(warning);
  await fs.mkdir(dir, { recursive: true });
  const lines = narrationLines(script);
  const lively = o.lively !== false;
  const synth: SynthResult = await synthesize(lines, voice.id, path.join(dir, "narration.wav"), {
    lengthScale: o.lengthScale ?? NARRATION.lengthScale,
    ...(lively ? { noiseScale: NARRATION.noiseScale, noiseW: NARRATION.noiseW, vary: true, sentencePauseMs: NARRATION.sentencePauseMs } : {}),
    synth: o.synth,
    gemini: { ...o.gemini, style: o.gemini?.style ?? geminiStyle(o.lengthScale) },
    // Chirp 3 HD has no style prompt, only pace: a touch brisker than 1.0 for narration (or 1 / --voice-speed)
    cloud: { ...o.cloud, speakingRate: o.cloud?.speakingRate ?? (o.lengthScale ? Math.round((1 / o.lengthScale) * 100) / 100 : 1.05) },
    onEvent: o.onEvent,
  });
  warnings.push(...synth.warnings);
  const spoke = getVoice(synth.voice) ?? voice;
  const speech = synth.clips.map((c) => c.pcm.length / c.rate);
  const fitted = fitBeatsToSpeech(script, speech);
  const long = speech.map((s, i) => (VOICE_LEAD + s + VOICE_TAIL > BEAT_MAX ? i : -1)).filter((i) => i >= 0);
  if (long.length) warnings.push(`речь битов ${long.map((i) => i + 1).join(", ")} длиннее ${BEAT_MAX} с — сократите voiceover`);
  const starts = beatStarts(fitted);
  const duration = starts.length ? starts.at(-1)!.start + starts.at(-1)!.duration : 0;
  const laid = layVoiceTrack(synth.clips, starts, duration);
  const track = path.join(dir, "voice.wav");
  await writeWav(track, laid.pcm, laid.rate);
  const beats = synth.clips.map((c, i) => ({ beat: i, start: r3(laid.at[i]), end: r3(laid.at[i] + c.pcm.length / c.rate), text: lines[i] }));
  const captions = captionCues(synth.sentences, synth.lines.map((l) => l.start), laid.at);
  const words = speechWords(synth.sentences, synth.lines.map((l) => l.start), laid.at, spoke.language);
  await fs.writeFile(path.join(dir, "voice.json"), JSON.stringify({ voice: spoke.id, license: spoke.license, engine: synth.engine, model: synth.model, duration: r3(duration), beats, sentences: synth.sentences, captions, words, warnings }, null, 1));
  return { voice: spoke, engine: synth.engine, model: synth.model, script: fitted, track, duration: r3(duration), beats, captions, words, warnings };
}
