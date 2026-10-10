import { ffmpeg } from "../lib/ffmpeg.ts";

export interface LoudnessPoint {
  t: number;
  lufs: number;
}

/** Parses `ebur128=metadata=1,ametadata=print` output: momentary loudness every 100 ms. */
export function parseLoudnessLog(log: string): LoudnessPoint[] {
  const pts: LoudnessPoint[] = [];
  const re = /pts_time:([\d.]+)\s*\n\s*lavfi\.r128\.M=(-?[\d.]+|-inf)/g;
  for (const m of log.matchAll(re)) {
    const lufs = m[2] === "-inf" ? -70 : Number(m[2]);
    pts.push({ t: Number(m[1]), lufs: Math.max(-70, lufs) });
  }
  return pts;
}

export async function loudnessTimeline(audio: string): Promise<LoudnessPoint[]> {
  const { stdout } = await ffmpeg(
    ["-i", audio, "-af", "ebur128=peak=none:metadata=1,ametadata=mode=print:key=lavfi.r128.M:file=-", "-f", "null", "-"],
  );
  return parseLoudnessLog(stdout);
}

/** Mean momentary loudness inside [start, end], or null if no samples. */
export function meanLoudness(points: LoudnessPoint[], start: number, end: number): number | null {
  const inside = points.filter((p) => p.t >= start && p.t <= end);
  if (inside.length === 0) return null;
  return inside.reduce((s, p) => s + p.lufs, 0) / inside.length;
}
