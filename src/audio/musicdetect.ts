import { ffmpegBuffer } from "../lib/ffmpeg.ts";
import { beatGridFromEnvelope } from "./beats.ts";

/**
 * Is there a music bed under the voice? (stage 23) Local, no dependencies. It has to work on jump-cut talking heads
 * with no pauses to listen into, so the main evidence is what the QUIETEST moments of the track sound like:
 *  - floor tonality: the 15 % quietest 256 ms frames (micro-pauses, consonants, the tail of a word) are where a bed
 *    is least masked by the voice. Their log spectrum (60–2000 Hz) is compared with its own 9-bin running median:
 *    notes and chords stand out as peaks, room tone / mic noise / breath is smooth. Measured on our reels: speech
 *    only 1.02–1.13, with a bed 1.20–1.69 (even a bed ducked to −19 dB under the voice).
 *  - quiet gaps between words (when there are ≥ 0.8 s of them and the words are known): a gap ≥ 35 dB below the
 *    words cannot hold a bed. Loud gaps are NOT taken as music: on the podcast reels the other speaker, room noise
 *    and loose word timings fill them (−8…−12 dB with no music at all).
 *  - also reported, not voted (they did not separate our reels): sub-bass level against the speech band, the beat
 *    periodicity of the low band, the level of the quiet frames.
 * `classifyMusic` turns the evidence into music / no_music / uncertain with a score (> 0 leans music).
 */

export interface MusicFeatures {
  seconds: number;
  /** mean spectral peakiness of the quietest 15 % of frames (dB above the running median; ~1.0 = smooth noise) */
  floor_tonality: number;
  /** the same over all active frames (voice included) */
  all_tonality: number;
  /** level of the quiet frames against the loud ones (p15 − p90 frame energy), dB */
  floor_db: number;
  /** median sub-bass (35–90 Hz) / speech band (300–3400 Hz) energy over the voiced frames, dB */
  low_ratio_db: number;
  /** periodicity of the low-band onsets, 0..1 */
  beat_strength: number;
  beat_bpm: number;
  /** level of the gaps between words relative to the words, dB (null: too few gaps or no words) */
  gap_db: number | null;
  gap_seconds: number;
}

export type MusicVerdict = "music" | "no_music" | "uncertain";
export interface MusicDecision {
  verdict: MusicVerdict;
  /** > 0 leans music, < 0 leans no music; |score| ≥ 1 is a confident call */
  score: number;
  reasons: string[];
}

export const MUSIC_DETECT_VERSION = "musicdetect/1";
const SR = 16000;
const N = 4096;
const HOP = 1024;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < half; k++) {
        const p = i + k + half;
        const ar = re[p] * cr - im[p] * ci;
        const ai = re[p] * ci + im[p] * cr;
        re[p] = re[i + k] - ar;
        im[p] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

const db = (x: number) => 10 * Math.log10(x + 1e-12);
const pctl = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** mean positive deviation of a log spectrum from its 9-bin running median */
function peakiness(s: Float64Array): number {
  let sum = 0;
  const w = new Float64Array(9);
  for (let k = 4; k < s.length - 4; k++) {
    for (let j = 0; j < 9; j++) w[j] = s[k - 4 + j];
    w.sort();
    sum += Math.max(0, s[k] - w[4]);
  }
  return s.length > 8 ? sum / (s.length - 8) : 0;
}

/** Features of mono samples at 16 kHz; `words` (seconds) lets the gaps between words be measured too. */
export function musicFeatures(samples: Float32Array, words: { start: number; end: number }[] = [], sr = SR): MusicFeatures {
  const bin = sr / N;
  const b = (hz: number) => Math.round(hz / bin);
  const [p0, p1, l0, l1, s0, s1] = [b(60), b(2000), b(35), b(90), b(300), b(3400)];
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const tot: number[] = [];
  const low: number[] = [];
  const sp: number[] = [];
  const peaks: number[] = [];
  const spec = new Float64Array(p1 - p0);
  for (let off = 0; off + N <= samples.length; off += HOP) {
    for (let i = 0; i < N; i++) {
      re[i] = samples[off + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    let e = 0;
    let el = 0;
    let es = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      if (k >= p0 && k < p1) {
        spec[k - p0] = db(p);
        e += p;
      }
      if (k >= l0 && k <= l1) el += p;
      if (k >= s0 && k <= s1) es += p;
    }
    tot.push(db(e));
    low.push(el);
    sp.push(es);
    peaks.push(peakiness(spec));
  }
  const frames = tot.length;
  const hopS = HOP / sr;
  const ref = pctl(tot, 0.9);
  const active = tot.map((_, i) => i).filter((i) => tot[i] > ref - 50);
  const thr = pctl(active.map((i) => tot[i]), 0.15);
  const floor = active.filter((i) => tot[i] <= thr);
  const voiced = active.filter((i) => tot[i] > ref - 15);

  // low-band onsets → periodicity (reported)
  const env: number[] = [0];
  for (let f = 1; f < frames; f++) env.push(Math.max(0, db(low[f]) - db(low[f - 1])));
  const grid = frames > 48 ? beatGridFromEnvelope(env, frames * hopS, hopS, { minBpm: 70, maxBpm: 180 }) : null;

  // gaps between words (≥ 0.25 s long, frames ≥ 0.1 s from any word)
  let gapE = 0;
  let gapN = 0;
  let wordE = 0;
  let wordN = 0;
  if (words.length) {
    const ws = [...words].sort((x, y) => x.start - y.start);
    for (let f = 0; f < frames; f++) {
      const t = (f * HOP + N / 2) / sr;
      const e = 10 ** (tot[f] / 10);
      if (ws.some((x) => t >= x.start && t <= x.end)) {
        wordE += e;
        wordN++;
        continue;
      }
      if (ws.some((x) => t >= x.start - 0.1 && t <= x.end + 0.1)) continue;
      const prev = ws.filter((x) => x.end <= t).pop();
      const next = ws.find((x) => x.start >= t);
      if ((next?.start ?? Infinity) - (prev?.end ?? -Infinity) >= 0.25) {
        gapE += e;
        gapN++;
      }
    }
  }
  const gapSeconds = gapN * hopS;
  return {
    seconds: r3(samples.length / sr),
    floor_tonality: r3(mean(floor.map((i) => peaks[i]))),
    all_tonality: r3(mean(active.map((i) => peaks[i]))),
    floor_db: r3(thr - ref),
    low_ratio_db: r3(pctl(voiced.map((i) => db(low[i]) - db(sp[i])), 0.5)),
    beat_strength: r3(grid?.strength ?? 0),
    beat_bpm: grid?.bpm ?? 0,
    gap_db: gapSeconds >= 0.8 && wordN > 0 ? r3(db(gapE / gapN) - db(wordE / wordN)) : null,
    gap_seconds: r3(gapSeconds),
  };
}

/** Thresholds of the floor tonality (see the header): ≤ NONE speech only, ≥ WEAK some bed, ≥ STRONG a bed. */
export const TONALITY = { none: 1.14, weak: 1.17, strong: 1.22 } as const;

/** The evidence → verdict. |score| ≥ 1 is a confident call; in between it is "uncertain" (a lean, not a call). */
export function classifyMusic(f: MusicFeatures): MusicDecision {
  const reasons: string[] = [];
  let score = 0;
  const vote = (w: number, why: string) => {
    score += w;
    reasons.push(`${w > 0 ? "+" : ""}${w} ${why}`);
  };
  const t = f.floor_tonality;
  if (t >= TONALITY.strong) vote(1.2, `notes in the quiet moments (tonality ${t})`);
  else if (t >= TONALITY.weak) vote(0.6, `some tonal content in the quiet moments (tonality ${t})`);
  else if (t <= TONALITY.none) vote(-1.0, `quiet moments are plain noise (tonality ${t})`);
  if (f.gap_db !== null && f.gap_db < -35) vote(-1.2, `gaps between words are silent (${f.gap_db} dB)`);
  const verdict: MusicVerdict = score >= 1 ? "music" : score <= -1 ? "no_music" : "uncertain";
  return { verdict, score: Math.round(score * 100) / 100, reasons };
}

/** Decodes the first `maxSeconds` of a file as mono 16 kHz floats. */
export async function decodeMono(file: string, maxSeconds = 90): Promise<Float32Array> {
  const raw = await ffmpegBuffer(["-t", String(maxSeconds), "-i", file, "-vn", "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"]);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.floor(raw.length / 4) * 4));
}

export async function detectMusic(file: string, words: { start: number; end: number }[] = [], maxSeconds = 90): Promise<{ features: MusicFeatures; decision: MusicDecision }> {
  const features = musicFeatures(await decodeMono(file, maxSeconds), words);
  return { features, decision: classifyMusic(features) };
}
