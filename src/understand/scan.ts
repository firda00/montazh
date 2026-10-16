import { spawn } from "node:child_process";
import { jobSignal } from "../lib/abort.ts";
import { hoopAt, type HoopSample, type SportEvent } from "./events.ts";
import { ballBlobs, classifyShot, medianBackground, netCore, roiForHoop, refineShot, type RimGeom, type RoiBox } from "./refine.ts";

/**
 * Local shot scan over the whole video (no model): the box around the rim is decoded at 30 fps in one
 * ffmpeg stream per camera position (hoop sample), cut into 8 s windows (1 s overlap), and every ball
 * that comes down onto the hoop is classified like refine.ts does. Candidate makes are confirmed at
 * full frame rate by refineShot (ball track + net swing). Finds the makes the model did not log —
 * at 2 frames/s and 480p it lists only some of the attempts.
 */

export interface ScanOptions {
  frameW: number;
  frameH: number;
  fps?: number;
  window?: number;
  from?: number;
  to?: number;
  onLog?: (line: string) => void;
}

export interface ScanCandidate {
  t: number;
  verdict: "make" | "miss";
}

/** Streams rgb24 frames of a crop of [start, end) at fps, calling onWindow with overlapping windows. */
async function streamWindows(source: string, start: number, end: number, roi: RoiBox, fps: number, win: number, overlap: number, onWindow: (frames: Buffer[], t0: number) => void): Promise<void> {
  const size = roi.w * roi.h * 3;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", source, "-an", "-vf", `crop=${roi.w}:${roi.h}:${roi.x}:${roi.y},fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"];
  const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true, signal: jobSignal() });
  let pending: Buffer = Buffer.alloc(0);
  let frames: Buffer[] = [];
  let first = 0; // index (in frames since start) of frames[0]
  const flush = (final: boolean) => {
    while (frames.length >= win) {
      onWindow(frames.slice(0, win), start + first / fps);
      frames = frames.slice(win - overlap);
      first += win - overlap;
    }
    if (final && frames.length > overlap + fps) onWindow(frames, start + first / fps);
  };
  await new Promise<void>((resolve, reject) => {
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.stdout.on("data", (d: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, d]) : d;
      while (pending.length >= size) {
        frames.push(Buffer.from(pending.subarray(0, size)));
        pending = pending.subarray(size);
      }
      flush(false);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.slice(-300)}`))));
  });
  flush(true);
}

/** Candidates in one window: every approach start classified on its own; makes and misses with their rim time. */
export function scanWindow(frames: Buffer[], roi: RoiBox, rim: RimGeom, fps: number, t0: number): ScanCandidate[] {
  const bg = medianBackground(frames, Math.max(1, Math.floor(frames.length / 16)));
  const blobs = ballBlobs(frames, roi.w, roi.h, bg, rim.rw);
  const core = netCore(frames, roi.w, bg, rim);
  const approach = (b: { x: number; y: number }) => Math.abs(b.x - rim.cx) <= 1.3 * rim.rw && b.y >= rim.ry - 2.6 * rim.rw && b.y <= rim.ry - 0.15 * rim.rw;
  const out: ScanCandidate[] = [];
  let lastRim = -1e9;
  blobs.forEach((bs, i) => {
    if (!bs.some(approach) || (i > 0 && blobs[i - 1].some(approach))) return;
    if (i < lastRim + Math.round(0.8 * fps)) return;
    // only the approach starting at i (others are farther from `near`)
    const v = classifyShot(blobs, rim, fps, [], i, core);
    if (v.verdict === "unknown" || v.rimFrame === null) return;
    lastRim = v.rimFrame;
    out.push({ t: Math.round((t0 + v.rimFrame / fps) * 1000) / 1000, verdict: v.verdict });
  });
  return out;
}

/** Scan the whole source; returns rim-moment times of candidate makes and misses (deduplicated). */
export async function scanShots(source: string, hoops: HoopSample[], duration: number, o: ScanOptions): Promise<ScanCandidate[]> {
  const fps = o.fps ?? 30;
  const win = Math.round((o.window ?? 8) * fps);
  const overlap = fps;
  const from = o.from ?? 0;
  const to = o.to ?? duration;
  const ok = hoops.filter((h) => h.found && h.rim).sort((a, b) => a.t - b.t);
  if (!ok.length) return [];
  // camera positions: one segment per hoop sample (from its time to the next sample's)
  const segs = ok.map((h, i) => ({ h, start: i === 0 ? from : Math.max(from, h.t), end: i === ok.length - 1 ? to : Math.min(to, ok[i + 1].t) })).filter((s) => s.end - s.start > 1);
  const all: ScanCandidate[] = [];
  for (const s of segs) {
    const g = roiForHoop(s.h, o.frameW, o.frameH);
    if (!g) continue;
    await streamWindows(source, s.start, s.end, g.roi, fps, win, overlap, (frames, t0) => {
      for (const c of scanWindow(frames, g.roi, g.rim, fps, t0)) if (!all.some((x) => Math.abs(x.t - c.t) < 1.2)) all.push(c);
    });
    o.onLog?.(`скан ${Math.round(s.start)}–${Math.round(s.end)} с: найдено ${all.length} подходов мяча к кольцу`);
  }
  return all.sort((a, b) => a.t - b.t);
}

/**
 * Makes from the scan that the model did not log become events (confirmed at full frame rate by
 * refineShot; the description says they were found by the frames). Shots already in the list
 * (within 2 s of a model's shot event) are left to the per-event refinement.
 */
export async function addScannedMakes(events: SportEvent[], candidates: ScanCandidate[], source: string, hoops: HoopSample[], o: ScanOptions): Promise<{ events: SportEvent[]; added: number }> {
  const isShot = (e: SportEvent) => e.type === "shot_make" || e.type === "shot_miss" || e.type === "dunk_layup";
  const out = [...events];
  let added = 0;
  for (const c of candidates.filter((x) => x.verdict === "make")) {
    if (events.some((e) => isShot(e) && Math.abs((e.refined?.motion_t ?? e.key) - c.t) < 2)) continue;
    const hoop = hoopAt(hoops, c.t);
    if (!hoop) continue;
    const base: SportEvent = { id: `s${Math.round(c.t * 10)}`, type: "shot_make", outcome: "make", start: Math.max(0, c.t - 2.5), end: c.t + 1.5, key: c.t, confidence: 0.5, quality: 0.5, distance: "unknown", description: "Попадание (найдено по кадрам у кольца)", target: hoop.rim, speech: false, chunk: -1 };
    const r = await refineShot(source, base, hoop, { frameW: o.frameW, frameH: o.frameH, fps: 60, before: 1.2, after: 1.6 });
    if (r.refined?.local_verdict !== "make") continue;
    out.push(r);
    added++;
  }
  return { events: out.sort((a, b) => a.start - b.start), added };
}
