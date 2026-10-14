import fs from "node:fs/promises";
import path from "node:path";
import type { Script } from "../make/script.ts";
import { getVoice, languageCode, piperVoiceFor, requireVoice, VOICES, type VoiceDef } from "./catalog.ts";
import { concatPcm, synthesize, writeWav, type PcmClip, type SentenceSynth, type SynthResult } from "./piper.ts";

/**
 * Voiceover for `make`: every beat's spoken line (beat.voiceover, else its on-screen text) is synthesised
 * with Piper, each beat is stretched to its speech (+ a short lead-in and tail), and the speech is laid on
 * the video timeline as one WAV that mixSoundtrack puts on top of the (ducked) music and effects.
 */

const FPS = 30;
/** speech starts this long after the scene cut (the headline is already moving) */
export const VOICE_LEAD = 0.25;
/** and the scene holds this long after the last word */
export const VOICE_TAIL = 0.45;
export const BEAT_MAX = 15;

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

export interface VoiceoverResult {
  voice: VoiceDef;
  script: Script;
  /** the voice on the video timeline (WAV, starts at 0, as long as the video) */
  track: string;
  duration: number;
  /** per beat: when the speech plays on the timeline */
  beats: { beat: number; start: number; end: number; text: string }[];
  captions: CaptionCue[];
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

/** A catalogue voice usable locally for `make`: Piper as is; a Chatterbox preset falls back to its Piper source or the language default. */
export function resolveMakeVoice(id: string, language: string): { voice: VoiceDef; warning?: string } {
  const v = requireVoice(id);
  const code = languageCode(language);
  if (v.engine === "piper") return { voice: v, warning: v.language !== code ? `голос ${v.id} говорит на «${v.language}», а ролик на «${language}» — будет акцент` : undefined };
  const p = piperVoiceFor(v) ?? VOICES.find((x) => x.engine === "piper" && x.language === code) ?? getVoice("denis")!;
  return { voice: p, warning: `голос ${v.id} работает только в аватаре (Colab); для ролика взят локальный ${p.id}` };
}

export interface VoiceoverOptions {
  lengthScale?: number;
  synth?: SentenceSynth;
  onEvent?: (l: string) => void;
}

/** Synthesises the narration of a script, stretches its beats and writes the timeline voice track into `dir`. */
export async function makeVoiceover(script: Script, voiceId: string, dir: string, o: VoiceoverOptions = {}): Promise<VoiceoverResult> {
  const warnings: string[] = [];
  const { voice, warning } = resolveMakeVoice(voiceId, script.language);
  if (warning) warnings.push(warning);
  await fs.mkdir(dir, { recursive: true });
  const lines = narrationLines(script);
  const synth: SynthResult = await synthesize(lines, voice.id, path.join(dir, "narration.wav"), { lengthScale: o.lengthScale, synth: o.synth, onEvent: o.onEvent });
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
  await fs.writeFile(path.join(dir, "voice.json"), JSON.stringify({ voice: voice.id, license: voice.license, engine: voice.engine, duration: r3(duration), beats, sentences: synth.sentences, captions, warnings }, null, 1));
  return { voice, script: fitted, track, duration: r3(duration), beats, captions, warnings };
}
