import { ffmpegBuffer } from "../lib/ffmpeg.ts";

/**
 * Beat grid of a music track, no dependencies: an onset envelope (positive change of log energy,
 * 10 ms hops) of the low-passed and full-band signal, tempo by autocorrelation over 70–190 BPM (a comb above 140 is halved: eighth notes) with a
 * mild preference for 90–140, phase by the comb that collects the most onset energy. Good enough to
 * place cuts on beats of pop / hip-hop / electronic tracks; free-tempo music gives a weak `strength`.
 */

export interface BeatGrid {
  bpm: number;
  /** seconds of the first beat (relative to the analysed start) */
  phase: number;
  period: number;
  beats: number[];
  /** 0..1: how periodic the onsets are (autocorrelation peak / zero-lag energy) */
  strength: number;
}

const HOP = 0.01;

export function onsetStrength(samples: Float32Array, sr: number, hop = HOP): number[] {
  const n = Math.max(1, Math.round(sr * hop));
  const frames = Math.floor(samples.length / n);
  const loge = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = f * n; k < (f + 1) * n; k++) e += samples[k] * samples[k];
    loge[f] = Math.log10(e / n + 1e-9);
  }
  const out: number[] = new Array(frames).fill(0);
  for (let f = 1; f < frames; f++) out[f] = Math.max(0, loge[f] - loge[f - 1]);
  // remove the local mean so sustained loud parts do not dominate
  const w = 25;
  const smooth = out.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - w); k <= Math.min(frames - 1, i + w); k++) (s += out[k]), c++;
    return s / c;
  });
  return out.map((v, i) => Math.max(0, v - smooth[i]));
}

/** Tempo + phase from an onset envelope (hop seconds per value). */
export function beatGridFromEnvelope(env: number[], duration: number, hop = HOP, o: { minBpm?: number; maxBpm?: number } = {}): BeatGrid {
  const minLag = Math.round(60 / (o.maxBpm ?? 190) / hop);
  const maxLag = Math.round(60 / (o.minBpm ?? 70) / hop);
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, env.length);
  const x = env.map((v) => v - mean);
  let zero = 0;
  for (const v of x) zero += v * v;
  let bestLag = minLag;
  let best = -Infinity;
  let bestRaw = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    s /= x.length - lag;
    const bpm = 60 / (lag * hop);
    // log-Gaussian preference around 115 BPM (σ ≈ 0.6 octave)
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 115) / 0.6) ** 2);
    const score = s * (0.6 + 0.4 * prior);
    if (score > best) (best = score), (bestLag = lag), (bestRaw = s);
  }
  // refine the period to sub-hop precision with a parabola through the neighbours
  const ac = (lag: number) => {
    let s = 0;
    for (let i = lag; i < x.length; i++) s += x[i] * x[i - lag];
    return s / (x.length - lag);
  };
  const a = ac(bestLag - 1);
  const b = ac(bestLag);
  const c = ac(bestLag + 1);
  const denom = a - 2 * b + c;
  const lagF = denom < 0 ? bestLag + (0.5 * (a - c)) / denom : bestLag;
  // a comb above 140 BPM has usually locked onto the eighth notes of a 70–95 BPM groove: one beat = two of its periods
  const period = 60 / (lagF * hop) > 140 && !o.maxBpm ? 2 * lagF * hop : lagF * hop;
  // phase: the offset whose comb collects the most onset energy
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let p = 0; p < Math.round(period / hop); p++) {
    let s = 0;
    for (let t = p * hop; t < duration; t += period) {
      const i = Math.round(t / hop);
      s += (env[i] ?? 0) + 0.5 * ((env[i - 1] ?? 0) + (env[i + 1] ?? 0));
    }
    if (s > bestSum) (bestSum = s), (bestPhase = p * hop);
  }
  const beats: number[] = [];
  for (let t = bestPhase; t < duration; t += period) beats.push(Math.round(t * 1000) / 1000);
  return { bpm: Math.round((60 / period) * 10) / 10, phase: Math.round(bestPhase * 1000) / 1000, period: Math.round(period * 10000) / 10000, beats, strength: zero > 0 ? Math.max(0, Math.min(1, (bestRaw * x.length) / zero)) : 0 };
}

/** Beat grid of [offset, offset + seconds) of an audio file (decoded mono 11025 Hz, ~1 MB per 25 s). */
export async function detectBeats(file: string, o: { offset?: number; seconds?: number } = {}): Promise<BeatGrid> {
  const sr = 11025;
  const seconds = o.seconds ?? 90;
  const raw = await ffmpegBuffer(["-ss", (o.offset ?? 0).toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"]);
  const s = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 4));
  // low band (kick) + full band
  const low = new Float32Array(s.length);
  let y = 0;
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  for (let i = 0; i < s.length; i++) low[i] = y += alpha * (s[i] - y);
  const e1 = onsetStrength(low, sr);
  const e2 = onsetStrength(s, sr);
  const env = e1.map((v, i) => v + 0.6 * (e2[i] ?? 0));
  return beatGridFromEnvelope(env, s.length / sr);
}

/** The beat nearest to t within ±maxShift, or null. */
export function nearestBeat(beats: number[], t: number, maxShift: number): number | null {
  let best: number | null = null;
  for (const b of beats) if (Math.abs(b - t) <= maxShift && (best === null || Math.abs(b - t) < Math.abs(best - t))) best = b;
  return best;
}

/** Bar phase of a beat grid: which of 4 consecutive beats collects the most low-band onset energy every 4 beats. */
export function barPhase(env: number[], beats: number[], hop = HOP): number {
  let best = 0;
  let bestSum = -Infinity;
  for (let k = 0; k < Math.min(4, beats.length); k++) {
    let s = 0;
    for (let j = k; j < beats.length; j += 4) {
      const i = Math.round(beats[j] / hop);
      s += Math.max(env[i] ?? 0, env[i - 1] ?? 0, env[i + 1] ?? 0);
    }
    if (s > bestSum) {
      bestSum = s;
      best = k;
    }
  }
  return best;
}

/**
 * Where a music bed should start (stage 23): past a quiet intro (~15 % into a track that is ≥ 20 s longer than the
 * reel, at most 30 s) and on a downbeat — the first beat of a bar (the beat whose every-4th neighbours carry the
 * strongest kick) — so the bed does not come in mid-bar. A track without a clear beat starts at the intro offset.
 */
export async function bedStart(file: string, trackSeconds: number, reelSeconds: number): Promise<{ offset: number; bpm: number | null; strength: number }> {
  const offset0 = trackSeconds > reelSeconds + 20 ? Math.min(30, trackSeconds * 0.15) : 0;
  const sr = 11025;
  const seconds = Math.min(24, Math.max(8, trackSeconds - offset0));
  const raw = await ffmpegBuffer(["-ss", offset0.toFixed(3), "-t", seconds.toFixed(3), "-i", file, "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"]);
  const s = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + Math.floor(raw.length / 4) * 4));
  const low = new Float32Array(s.length);
  let y = 0;
  const alpha = 1 - Math.exp((-2 * Math.PI * 150) / sr);
  for (let i = 0; i < s.length; i++) low[i] = y += alpha * (s[i] - y);
  const e1 = onsetStrength(low, sr);
  const e2 = onsetStrength(s, sr);
  const grid = beatGridFromEnvelope(e1.map((v, i) => v + 0.6 * (e2[i] ?? 0)), s.length / sr);
  if (grid.strength < 0.08 || grid.beats.length < 4) return { offset: Math.round(offset0 * 1000) / 1000, bpm: null, strength: grid.strength };
  const k = barPhase(e1, grid.beats);
  const offset = offset0 + grid.beats[k];
  return { offset: Math.round(offset * 1000) / 1000, bpm: grid.bpm, strength: grid.strength };
}
