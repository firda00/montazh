import { ffmpeg, ffmpegBuffer, ffprobe, parseRate } from "../lib/ffmpeg.ts";
import type { Transcript } from "../schemas/index.ts";
import type { LoudnessPoint } from "../understand/loudness.ts";
import { isHesitation } from "./jumpcut.ts";
import type { Measured } from "./profile.ts";

/**
 * Local measurements of a reference reel (stage 22) — no new dependencies, only ffmpeg and our whisper:
 *  - hard cuts: ffmpeg's scene detector (`select='gt(scene,0.18)',showinfo`);
 *  - jump cuts inside one shot (same framing, the speaker just "jumps"): the scene score misses them, so tiny gray
 *    frames are diffed in three horizontal bands and a cut is a spike above the local baseline in ≥ 2 bands at once
 *    (a caption page changing lights up one band only);
 *  - speech rate and pauses from word timestamps, music under the voice from the loudness of the gaps between words,
 *    picture statistics from signalstats (hints for the colour grade).
 * PySceneDetect would give the same hard cuts but needs Python + OpenCV on the ARM server; see README (stage 22).
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** `showinfo` lines after a scene select → the cut times (pts_time) */
export function parseSceneCuts(log: string): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/Parsed_showinfo[^\n]*?\bpts_time:\s*([\d.]+)/g)) out.push(Number(m[1]));
  return out.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
}

export async function sceneCuts(file: string, threshold = 0.18, maxSeconds = 120): Promise<number[]> {
  const { stderr } = await ffmpeg(["-t", String(maxSeconds), "-i", file, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',showinfo`, "-f", "null", "-"], { loglevel: "info" });
  return parseSceneCuts(stderr);
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
};

/** Mean absolute difference between consecutive frames per horizontal band (0..1); diffs[i] compares frame i with i−1. */
export function bandDiffs(frames: Uint8Array[], w: number, h: number, bands = 3): number[][] {
  const out: number[][] = Array.from({ length: bands }, () => [0]);
  const rows = Math.floor(h / bands);
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    for (let k = 0; k < bands; k++) {
      let sum = 0;
      const y0 = k * rows;
      const y1 = k === bands - 1 ? h : y0 + rows;
      for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) sum += Math.abs(a[y * w + x] - b[y * w + x]);
      out[k].push(sum / ((y1 - y0) * w * 255));
    }
  }
  return out;
}

export interface JumpCutDetectOptions {
  fps: number;
  /** a band spikes when its diff is ≥ this many times its local median … */
  ratio?: number;
  /** … and at least this large (0..1) */
  floor?: number;
  /** spikes in this many bands at once make a cut */
  minBands?: number;
  /** mean diff over all bands that is a cut on its own */
  hard?: number;
  /** the spike must be this many times its neighbouring frames (impulse, not motion) */
  sharpness?: number;
  /** two cuts at least this far apart, s */
  minGap?: number;
}

/** Cut times from per-band frame diffs: local peaks above the band's own baseline in ≥ minBands bands. */
export function detectJumpCuts(diffs: number[][], o: JumpCutDetectOptions): number[] {
  const ratio = o.ratio ?? 3;
  const floor = o.floor ?? 0.0035;
  const minBands = o.minBands ?? 2;
  const hard = o.hard ?? 0.12;
  const sharp = o.sharpness ?? 2;
  const minGap = Math.max(1, Math.round((o.minGap ?? 0.2) * o.fps));
  const n = diffs[0]?.length ?? 0;
  const W = 8;
  const cand: { i: number; score: number }[] = [];
  for (let i = 1; i < n; i++) {
    let spikes = 0;
    let mean = 0;
    for (const d of diffs) {
      mean += d[i] / diffs.length;
      const around: number[] = [];
      for (let j = Math.max(1, i - W); j <= Math.min(n - 1, i + W); j++) if (Math.abs(j - i) > 1) around.push(d[j]);
      const base = Math.max(median(around), 0.001);
      // a cut is an impulse: one frame differs, the frames around it do not (a head turn rises over several frames)
      const isPeak = d[i] >= sharp * Math.max(d[i - 1] ?? 0, d[i + 1] ?? 0);
      if (isPeak && d[i] >= floor && d[i] >= ratio * base) spikes++;
    }
    if (spikes >= minBands || mean >= hard) cand.push({ i, score: mean });
  }
  // keep the strongest of candidates closer than minGap
  const kept: { i: number; score: number }[] = [];
  for (const c of cand) {
    const prev = kept[kept.length - 1];
    if (prev && c.i - prev.i < minGap) {
      if (c.score > prev.score) kept[kept.length - 1] = c;
    } else kept.push(c);
  }
  return kept.map((c) => r3(c.i / o.fps));
}

/** Tiny gray frames at a fixed rate (≈9 KB each): enough to see a speaker jump between two takes. */
export async function grayFrames(file: string, o: { fps?: number; maxSeconds?: number } = {}): Promise<{ frames: Uint8Array[]; w: number; h: number; fps: number }> {
  const fps = o.fps ?? 30;
  const probe = await ffprobe(file);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const portrait = (v?.height ?? 1920) >= (v?.width ?? 1080);
  const w = portrait ? 72 : 128;
  const h = portrait ? 128 : 72;
  const buf = await ffmpegBuffer(["-t", String(o.maxSeconds ?? 120), "-i", file, "-an", "-vf", `fps=${fps},scale=${w}:${h}:flags=area,format=gray`, "-f", "rawvideo", "-"]);
  const size = w * h;
  const frames: Uint8Array[] = [];
  for (let off = 0; off + size <= buf.length; off += size) frames.push(new Uint8Array(buf.buffer, buf.byteOffset + off, size));
  return { frames, w, h, fps };
}

/** Merges cut lists (hard cuts + jump cuts): one cut per `tol` seconds, never in the first/last 0.1 s. */
export function mergeCuts(lists: number[][], duration: number, tol = 0.15): number[] {
  const all = lists.flat().filter((t) => t > 0.1 && t < duration - 0.1).sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of all) if (!out.length || t - out[out.length - 1] > tol) out.push(r3(t));
  return out;
}

/** shot statistics from cut times: average shot length overall, in the hook (first 3 s) and after it */
export function cutStats(cuts: number[], duration: number, hookSeconds = 3) {
  const hookEnd = Math.min(hookSeconds, duration);
  const hookCuts = cuts.filter((t) => t < hookEnd).length;
  const bodyCuts = cuts.length - hookCuts;
  return {
    total_cuts: cuts.length,
    asl: r2(duration / (cuts.length + 1)),
    hook_cuts: hookCuts,
    hook_asl: r2(hookEnd / (hookCuts + 1)),
    body_asl: duration > hookEnd ? r2((duration - hookEnd) / (bodyCuts + 1)) : r2(duration / (cuts.length + 1)),
  };
}

/** Speech rate, pause distribution and fillers from word timestamps. */
export function speechStats(t: Transcript, duration: number): Measured["speech"] {
  const words = t.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  if (words.length < 5) return null;
  const gaps: number[] = [];
  for (let i = 1; i < words.length; i++) gaps.push(Math.max(0, words[i].start - words[i - 1].end) * 1000);
  const span = Math.max(1, words[words.length - 1].end - words[0].start);
  const covered = words.reduce((s, w) => s + Math.max(0, w.end - w.start), 0);
  return {
    words: words.length,
    language: t.language,
    wpm: Math.round((words.length / span) * 60),
    pause_median_ms: Math.round(median(gaps)),
    pause_p90_ms: Math.round(pct(gaps, 90)),
    long_pauses_per_min: r2((gaps.filter((g) => g > 300).length / span) * 60),
    speech_ratio: r2(Math.min(1, covered / Math.max(1, duration))),
    fillers: words.filter((w) => isHesitation(w.w)).length,
  };
}

/**
 * Music under the voice, roughly: the momentary loudness of the gaps between words (≥ 0.25 s, 0.1 s away from
 * any word) against the loudness of the words. Silence between words sits below −45 LUFS; a bed keeps the gaps
 * within ~20 dB of the speech. null when there are fewer than ~0.8 s of gaps (a jump-cut edit has almost none).
 */
export function audioStats(points: LoudnessPoint[], t: Transcript): Measured["audio"] {
  const words = t.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  if (!points.length) return null;
  const inWord = (x: number, pad: number) => words.some((w) => x >= w.start - pad && x <= w.end + pad);
  const speech = points.filter((p) => inWord(p.t, 0) && p.lufs > -60).map((p) => p.lufs);
  const gaps = points.filter((p) => !inWord(p.t, 0.1)).map((p) => p.lufs);
  const toDb = (xs: number[]) => (xs.length ? 10 * Math.log10(xs.reduce((s, l) => s + 10 ** (l / 10), 0) / xs.length) : null);
  const speechLufs = toDb(speech);
  const gapLufs = gaps.length >= 8 ? toDb(gaps) : null;
  const music = speechLufs !== null && gapLufs !== null ? gapLufs > -42 && speechLufs - gapLufs < 20 : false;
  return { speech_lufs: speechLufs === null ? null : r2(speechLufs), gap_lufs: gapLufs === null ? null : r2(gapLufs), music_likely: music };
}

/** `signalstats` + `metadata=print` output → mean YAVG, mean (YHIGH − YLOW), mean SATAVG */
export function parseSignalstats(log: string): { yavg: number; yrange: number; satavg: number } | null {
  const grab = (key: string) => [...log.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
  const y = grab("YAVG");
  const lo = grab("YLOW");
  const hi = grab("YHIGH");
  const sat = grab("SATAVG");
  if (!y.length) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
  const range = hi.map((h, i) => h - (lo[i] ?? 0));
  return { yavg: r2(mean(y)), yrange: r2(mean(range)), satavg: r2(mean(sat)) };
}

export async function pictureStats(file: string, maxSeconds = 120): Promise<Measured["picture"]> {
  const probe = await ffprobe(file);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const { stdout } = await ffmpeg(["-t", String(maxSeconds), "-i", file, "-an", "-vf", "fps=2,scale=270:-2,signalstats,metadata=mode=print:file=-", "-f", "null", "-"]);
  const s = parseSignalstats(stdout);
  return s ? { ...s, width: v?.width ?? 0, height: v?.height ?? 0 } : null;
}

/** frame rate of the reference (for reports) */
export async function videoFps(file: string): Promise<number> {
  const v = (await ffprobe(file)).streams.find((s) => s.codec_type === "video");
  return parseRate(v?.avg_frame_rate ?? v?.r_frame_rate);
}
