import path from "node:path";
import fs from "node:fs/promises";
import { ffmpeg } from "../lib/ffmpeg.ts";

export interface Shot {
  index: number;
  start: number;
  end: number;
  /** scene-change score of the cut that opened this shot (0 for the first shot) */
  cut_score: number;
  frame?: string;
}

/** Parses ffmpeg `select=gt(scene,x),metadata=print` log output into cut times. */
export function parseSceneLog(log: string): { t: number; score: number }[] {
  const cuts: { t: number; score: number }[] = [];
  const re = /pts_time:([\d.]+)[\s\S]*?lavfi\.scene_score=([\d.]+)/g;
  for (const m of log.matchAll(re)) cuts.push({ t: Number(m[1]), score: Number(m[2]) });
  return cuts;
}

/** Turns cut times into shots; flashes shorter than minShot are merged into the previous shot. */
export function shotsFromCuts(cuts: { t: number; score: number }[], duration: number, minShot = 0.4): Shot[] {
  const shots: Shot[] = [{ index: 0, start: 0, end: duration, cut_score: 0 }];
  for (const c of cuts.sort((a, b) => a.t - b.t)) {
    if (c.t <= 0 || c.t >= duration) continue;
    const prev = shots[shots.length - 1];
    if (c.t - prev.start < minShot) continue;
    prev.end = c.t;
    shots.push({ index: shots.length, start: c.t, end: duration, cut_score: c.score });
  }
  // a tail shorter than minShot belongs to the previous shot
  if (shots.length > 1 && duration - shots[shots.length - 1].start < minShot) {
    shots.pop();
    shots[shots.length - 1].end = duration;
  }
  return shots;
}

// 0.2 rather than ffmpeg's customary 0.3: on the fixtures a real hard cut between two
// similar-brightness scenes scored 0.27 while the strongest non-cut frame scored 0.07.
// Each shot keeps its cut_score so downstream can treat weak cuts with suspicion.
export const DEFAULT_SCENE_THRESHOLD = 0.2;

export async function detectShots(video: string, duration: number, threshold = DEFAULT_SCENE_THRESHOLD): Promise<Shot[]> {
  const { stderr } = await ffmpeg(
    ["-i", video, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',metadata=print`, "-f", "null", "-"],
    { loglevel: "info" },
  );
  return shotsFromCuts(parseSceneLog(stderr), duration);
}

/** Saves one representative JPEG per shot (mid-point) into <dir>/frames. */
export async function extractShotFrames(video: string, shots: Shot[], dir: string, width = 640): Promise<void> {
  const framesDir = path.join(dir, "frames");
  await fs.mkdir(framesDir, { recursive: true });
  for (const s of shots) {
    const t = (s.start + s.end) / 2;
    const file = path.join(framesDir, `shot_${String(s.index).padStart(3, "0")}.jpg`);
    await ffmpeg(["-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", file]);
    s.frame = file;
  }
}

/** Extracts one frame at an arbitrary timestamp (used by the planner's preview_frame tool later). */
export async function extractFrame(video: string, t: number, file: string, width = 640) {
  await ffmpeg(["-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "3", file]);
  return file;
}
