import fs from "node:fs/promises";
import { sfxFile, type SfxCue, type SfxKind } from "../../audio/sfx.ts";
import { SFX_GAIN } from "../../audio/mix.ts";
import { ffmpeg } from "../../lib/ffmpeg.ts";
import { spawn } from "node:child_process";

/**
 * Stage 31: the promo's sound design. Reference #17 has a sound on almost every visual event; the promo plans ≈ 1–3
 * cues a second (keys while typing, a crisp click per cursor press, a pop per card, a chime per notification, ticks
 * as a counter rolls, a whoosh per transition that follows the move, a riser into a reveal, a low hit on the logo) —
 * far over the shared mixer's 48 inputs, so the cues are summed here into one stereo WAV that goes under the music.
 *
 * Rules (applied to every promo):
 *  - no two identical hits: each cue gets a deterministic variation — playback rate ±4 % (keys and ticks ±7 %), gain
 *    ±1.2 dB, a small pan for UI sounds — seeded by its time and kind, so a re-render sounds the same;
 *  - motion-led sounds carry their direction and speed: `pan` (−1 left … 1 right) follows the move, `rate` < 1 is a
 *    big slow push (zoom into a UI, a card dragged), > 1 a quick soft pass (blur cut, word swap);
 *  - same-kind cues closer than 50 ms collapse (a typing burst stays a typing burst, not a buzz);
 *  - the bed is levelled against the music: BED_UNDER_MUSIC_LU below the music bed (≈ −24 LUFS against −17), and
 *    BED_UNDER_VOICE_LU lower with a narrator; peaks are soft-clipped below −1 dBFS.
 */

const RATE = 48000;
/** how far the effects bed sits under the music bed (LU) without / with a narrator */
export const BED_UNDER_MUSIC_LU = 7;
export const BED_UNDER_VOICE_LU = 10;

/** A cue of the promo: an SFX cue plus where it sits in the stereo field and how fast it plays. */
export interface BedCue extends SfxCue {
  /** −1 (left) … 1 (right) */
  pan?: number;
  /** playback rate: < 1 slower and lower, > 1 quicker and higher */
  rate?: number;
}

/** PCM of a 16-bit WAV as interleaved stereo floats (mono is duplicated). */
export function readWav(buf: Buffer): Float32Array {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV");
  let off = 12;
  let channels = 2;
  let bits = 16;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      bits = buf.readUInt16LE(off + 22);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`WAV ${bits}-bit is not supported`);
      const n = Math.floor(Math.min(size, buf.length - off - 8) / 2);
      const frames = Math.floor(n / channels);
      const out = new Float32Array(frames * 2);
      for (let i = 0; i < frames; i++) {
        const l = buf.readInt16LE(off + 8 + i * channels * 2) / 32768;
        const r = channels > 1 ? buf.readInt16LE(off + 8 + (i * channels + 1) * 2) / 32768 : l;
        out[i * 2] = l;
        out[i * 2 + 1] = r;
      }
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV without data");
}

export function writeWav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** Same-kind cues closer than `gap` collapse into one; cues past the end are dropped. */
export function dedupeCues<T extends SfxCue>(cues: T[], duration: number, gap = 0.05): T[] {
  const out: T[] = [];
  for (const c of [...cues].sort((a, b) => a.t - b.t)) {
    if (c.t < 0 || c.t > duration - 0.03) continue;
    if (out.some((x) => x.kind === c.kind && Math.abs(x.t - c.t) < gap)) continue;
    out.push(c);
  }
  return out;
}

/** A deterministic number in [−1, 1) from a cue (its kind, time and order): the variation seed. */
export function cueJitter(c: SfxCue, k: number, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (const ch of `${c.kind}:${Math.round(c.t * 1000)}:${k}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return ((h >>> 0) % 2000) / 1000 - 1;
}

/** The variation a cue gets: rate, gain (dB) and pan, its own values first (they carry the motion). */
export function cueVariation(c: BedCue, k: number): { rate: number; gainDb: number; pan: number } {
  const fine = c.kind === "key" || c.kind === "tick" ? 0.07 : c.kind === "riser" || c.kind === "impact" ? 0.02 : 0.04;
  const rate = (c.rate ?? 1) * (1 + fine * cueJitter(c, k, 1));
  const gainDb = (c.gain ?? 0) + 1.2 * cueJitter(c, k, 2);
  const ui = c.kind === "key" || c.kind === "click" || c.kind === "pop" || c.kind === "tick";
  const pan = Math.max(-1, Math.min(1, c.pan ?? (ui ? 0.15 * cueJitter(c, k, 3) : 0)));
  return { rate, gainDb, pan };
}

/** Integrated loudness (LUFS) of a file, by ffmpeg's ebur128; null when it cannot be measured (silence). */
export async function measureLufs(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"], { windowsHide: true });
    let err = "";
    p.stderr.on("data", (d) => (err += String(d)));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const m = /Summary:[\s\S]*?I:\s+(-?[\d.]+) LUFS/.exec(err);
      const v = m ? Number(m[1]) : NaN;
      resolve(Number.isFinite(v) && v > -70 ? v : null);
    });
  });
}

/**
 * Sums the cues into one stereo track with per-cue variation, pan and rate, levels it to `targetLufs` (when given and
 * measurable) and soft-clips it. Returns the number of cues placed.
 */
export async function renderSfxBed(cues: BedCue[], duration: number, out: string, o: { trimDb?: number; targetLufs?: number; load?: (k: SfxKind) => Promise<Float32Array>; measure?: (file: string) => Promise<number | null> } = {}): Promise<number> {
  const list = dedupeCues(cues, duration);
  const mix = new Float32Array(Math.ceil(duration * RATE) * 2);
  const cache = new Map<SfxKind, Float32Array>();
  const load = o.load ?? (async (k: SfxKind) => readWav(await fs.readFile(await sfxFile(k))));
  for (const [k, c] of list.entries()) {
    if (!cache.has(c.kind)) cache.set(c.kind, await load(c.kind));
    const pcm = cache.get(c.kind)!;
    const v = cueVariation(c, k);
    const g = 10 ** ((SFX_GAIN[c.kind] + v.gainDb + (o.trimDb ?? 0)) / 20);
    // constant-power pan
    const a = ((v.pan + 1) * Math.PI) / 4;
    const gl = g * Math.cos(a) * Math.SQRT2;
    const gr = g * Math.sin(a) * Math.SQRT2;
    const frames = pcm.length / 2;
    const at = Math.round(c.t * RATE);
    const outFrames = Math.floor(frames / v.rate);
    for (let i = 0; i < outFrames && at + i < mix.length / 2; i++) {
      // linear-interpolated playback at the cue's rate
      const pos = i * v.rate;
      const j = Math.floor(pos);
      const fr = pos - j;
      const j2 = Math.min(frames - 1, j + 1);
      const l = pcm[j * 2] * (1 - fr) + pcm[j2 * 2] * fr;
      const r = pcm[j * 2 + 1] * (1 - fr) + pcm[j2 * 2 + 1] * fr;
      mix[(at + i) * 2] += l * gl;
      mix[(at + i) * 2 + 1] += r * gr;
    }
  }
  const finish = (gain: number) => {
    const outPcm = new Float32Array(mix.length);
    for (let i = 0; i < mix.length; i++) outPcm[i] = Math.tanh(mix[i] * gain * 1.1) / 1.1;
    return outPcm;
  };
  await fs.writeFile(out, writeWav(finish(1)));
  if (o.targetLufs !== undefined && list.length) {
    // level the bed against the music: measure, then one gain (capped so the loudest hit stays under −1 dBFS)
    const lufs = await (o.measure ?? measureLufs)(out);
    if (lufs !== null) {
      let peak = 0;
      for (let i = 0; i < mix.length; i++) peak = Math.max(peak, Math.abs(mix[i]));
      const want = 10 ** ((o.targetLufs - lufs) / 20);
      const cap = peak > 0 ? 0.89 / peak : want;
      await fs.writeFile(out, writeWav(finish(Math.min(want, Math.max(cap, 1)))));
    }
  }
  return list.length;
}

/** Re-encodes a rendered promo with its effects bed as the audio track (the music and the voice are mixed after). */
export async function muxBed(video: string, bed: string, out: string) {
  await ffmpeg(["-i", video, "-i", bed, "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", out]);
}
