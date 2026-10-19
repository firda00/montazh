// Stage 30, dubbing: the audio side — clips stored per phrase on disk (a 2-hour podcast never holds all of its dub
// in RAM), speed-up with ffmpeg atempo (pitch kept), and the dub track written as one WAV on the video timeline,
// streamed phrase by phrase.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ffmpegBuffer } from "../lib/ffmpeg.ts";
import type { Placement } from "./fit.ts";

export interface Pcm {
  pcm: Int16Array;
  rate: number;
}

/** speeds a clip up by `speed` (1.0–2.0) keeping the pitch; tests inject a stub */
export type StretchFn = (clip: Pcm, speed: number) => Promise<Pcm>;

/** ffmpeg atempo (WSOLA): good for speech up to 2× */
export const atempoStretch: StretchFn = async (clip, speed) => {
  if (speed <= 1.001 || !clip.pcm.length) return clip;
  const tmp = path.join(os.tmpdir(), `vedit-dub-${process.pid}-${randomBytes(4).toString("hex")}.s16`);
  await fs.writeFile(tmp, Buffer.from(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength));
  try {
    const buf = await ffmpegBuffer(["-f", "s16le", "-ar", String(clip.rate), "-ac", "1", "-i", tmp, "-filter:a", `atempo=${Math.min(2, speed).toFixed(4)}`, "-f", "s16le", "-ar", String(clip.rate), "-ac", "1", "-"]);
    return { pcm: new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)).slice(), rate: clip.rate };
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
};

/** Linear resampling (clips of one dub may come from engines with different rates: Gemini 24 kHz, Piper 22.05 kHz). */
export function resample(clip: Pcm, rate: number): Pcm {
  if (clip.rate === rate || !clip.pcm.length) return { pcm: clip.pcm, rate };
  const n = Math.max(1, Math.round((clip.pcm.length * rate) / clip.rate));
  const out = new Int16Array(n);
  const k = clip.rate / rate;
  for (let j = 0; j < n; j++) {
    const x = j * k;
    const a = Math.floor(x);
    const b = Math.min(clip.pcm.length - 1, a + 1);
    const f = x - a;
    out[j] = Math.round(clip.pcm[Math.min(a, clip.pcm.length - 1)] * (1 - f) + clip.pcm[b] * f);
  }
  return { pcm: out, rate };
}

/** Cuts a clip to `seconds` with a short fade-out (a trimmed phrase must not end in a click). */
export function trimWithFade(clip: Pcm, seconds: number, fadeMs = 40): Pcm {
  const n = Math.max(0, Math.min(clip.pcm.length, Math.round(seconds * clip.rate)));
  if (n >= clip.pcm.length) return clip;
  const out = clip.pcm.slice(0, n);
  const f = Math.min(n, Math.round((fadeMs / 1000) * clip.rate));
  for (let j = 0; j < f; j++) out[n - f + j] = Math.round(out[n - f + j] * (1 - (j + 1) / f));
  return { pcm: out, rate: clip.rate };
}

/** clip files of a dub: <dir>/<phrase>.s16 (raw mono s16le at `rate`) */
export const clipFile = (dir: string, i: number) => path.join(dir, `${i}.s16`);

export async function saveClip(dir: string, i: number, clip: Pcm): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(clipFile(dir, i), Buffer.from(clip.pcm.buffer, clip.pcm.byteOffset, clip.pcm.byteLength));
}

export async function loadClip(dir: string, i: number, rate: number): Promise<Pcm | null> {
  const buf = await fs.readFile(clipFile(dir, i)).catch(() => null);
  if (!buf) return null;
  return { pcm: new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2)).slice(), rate };
}

function wavHeader(samples: number, rate: number): Buffer {
  const data = samples * 2;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data, 40);
  return h;
}

/**
 * Writes the dub track: silence, then each placed clip (already sped up; trimmed here to `out`) at its start sample,
 * for the whole `duration`. Clips are read from `clipsDir` one at a time. Returns the samples of speech written.
 */
export async function writeDubTrack(file: string, placements: Placement[], clipsDir: string, rate: number, duration: number): Promise<{ speechSeconds: number }> {
  const total = Math.max(1, Math.ceil(duration * rate));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const fh = await fs.open(file, "w");
  const silence = Buffer.alloc(rate * 2);
  let pos = 0;
  let speech = 0;
  const pad = async (until: number) => {
    while (pos < until) {
      const n = Math.min(until - pos, rate);
      await fh.write(silence, 0, n * 2);
      pos += n;
    }
  };
  try {
    await fh.write(wavHeader(total, rate));
    for (const p of [...placements].filter((x) => x.out > 0).sort((a, b) => a.start - b.start)) {
      const clip = await loadClip(clipsDir, p.i, rate);
      if (!clip) continue;
      const at = Math.round(p.start * rate);
      // placements never overlap by construction; a rounding sample is dropped from the head rather than shifting
      const skip = Math.max(0, pos - at);
      await pad(at);
      const cut = trimWithFade(clip, p.out);
      const body = cut.pcm.subarray(Math.min(skip, cut.pcm.length), Math.min(cut.pcm.length, total - pos + skip));
      if (body.length) {
        await fh.write(Buffer.from(body.buffer, body.byteOffset, body.byteLength));
        pos += body.length;
        speech += body.length;
      }
    }
    await pad(total);
  } finally {
    await fh.close();
  }
  return { speechSeconds: Math.round((speech / rate) * 1000) / 1000 };
}
