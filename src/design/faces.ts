import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { exists } from "../lib/workspace.ts";
import { OUTPUT_SIZE, clipFocus } from "../cut/index.ts";
import type { Aspect, Clip, Media, Scenes } from "../schemas/index.ts";
import { findMattePython, MATTE_SCRIPT, runMatteSidecar, type MatteRunner } from "./matte.ts";

/**
 * Face track of an output (stage 23), so captions and titles never cover a face.
 *
 *  - mediapipe: the matte sidecar's `faces` command (MediaPipe Tasks FaceDetector, BlazeFace short-range,
 *    Apache-2.0) runs on the ROUGH CUT — the real framing after crop and punch-ins — at ~8 fps, on the full frame
 *    plus square windows of the tall frame (BlazeFace letterboxes to 128×128). Cached by the rough cut's content,
 *    the parameters and the script, like the cutout.
 *  - scenes (fallback without the sidecar): the vision step's focus point per shot pushed through the same crop
 *    maths as the cut (auto_face crop or centre crop, last zoom) and a face size guessed from the shot type.
 *    Coarse, but no dependency.
 *  - none: no face information at all → captions stay on the preset's anchor (the old behaviour).
 *
 * Boxes are fractions (0..1) of the frame they were measured on; `toOutputFrame` maps rough-cut boxes into the
 * composition frame (split layout: the bottom box, with or without the cutout plate).
 */

export const FACES_VERSION = "faces/1";
export const FACE_FPS = 8;

/** [x0, y0, x1, y1] as fractions of the frame */
export type FaceBox = [number, number, number, number];
export interface FaceSample {
  t: number;
  boxes: FaceBox[];
}
export interface FaceTrack {
  source: "mediapipe" | "scenes" | "none";
  fps: number;
  samples: FaceSample[];
}

export const FaceSidecarSchema = z
  .object({
    version: z.string(),
    detector: z.string(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    duration: z.number(),
    samples: z.array(z.object({ t: z.number(), faces: z.array(z.array(z.number()).min(4)) })),
    with_face: z.number(),
    wall_seconds: z.number(),
  })
  .loose();
export type FaceSidecar = z.infer<typeof FaceSidecarSchema>;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function iou(a: FaceBox, b: FaceBox): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter;
  return u > 0 ? inter / u : 0;
}

/**
 * Cleans a raw detector track: a box seen in one sample only, with a low score and nothing near it in the samples
 * around, is a false positive; a face that drops out for ≤ maxGap seconds (motion blur, a hand) is carried over
 * from the nearest sample that has it. Deterministic, pure.
 */
export function smoothFaceTrack(raw: { t: number; faces: number[][] }[], o: { maxGap?: number; minScore?: number; fps?: number } = {}): FaceSample[] {
  const fps = o.fps ?? FACE_FPS;
  const maxGap = o.maxGap ?? 0.5;
  const minScore = o.minScore ?? 0.75;
  const near = Math.max(1, Math.round(0.25 * fps));
  // a much smaller, unsure "face" next to a sure one is an object (a mic badge, a figurine on a shelf): seen on the
  // podcast reels at score 0.5–0.75 and a third of the speaker's width, steadily, so the neighbour rule keeps it
  const boxes = raw.map((s) => {
    const all = s.faces.map((f) => ({ box: [f[0], f[1], f[2], f[3]] as FaceBox, score: f[4] ?? 1 }));
    const widest = Math.max(0, ...all.filter((b) => b.score >= 0.8).map((b) => b.box[2] - b.box[0]));
    return all.filter((b) => b.score >= 0.8 || b.box[2] - b.box[0] >= 0.55 * widest);
  });
  const kept: FaceBox[][] = boxes.map((list, i) =>
    list
      .filter((b) => {
        if (b.score >= minScore) return true;
        for (let j = Math.max(0, i - near); j <= Math.min(boxes.length - 1, i + near); j++) if (j !== i && boxes[j].some((o2) => iou(o2.box, b.box) > 0.2)) return true;
        return false;
      })
      .map((b) => b.box),
  );
  const span = Math.max(1, Math.round(maxGap * fps));
  const out: FaceSample[] = raw.map((s, i) => ({ t: s.t, boxes: kept[i].map((b) => b.map(r4) as FaceBox) }));
  for (let i = 0; i < out.length; i++) {
    if (kept[i].length) continue;
    // nearest neighbours with a face on both sides within the gap → carry both (union keeps us safe)
    let before = -1;
    let after = -1;
    for (let j = i - 1; j >= Math.max(0, i - span); j--) {
      if (kept[j].length) {
        before = j;
        break;
      }
    }
    for (let j = i + 1; j <= Math.min(out.length - 1, i + span); j++) {
      if (kept[j].length) {
        after = j;
        break;
      }
    }
    if (before >= 0 && after >= 0) out[i].boxes = [...kept[before], ...kept[after]].map((b) => b.map(r4) as FaceBox);
  }
  return out;
}

/** All boxes seen in [t0, t1] (the sample just before t0 too: the face is there when the page appears). */
export function boxesBetween(track: FaceTrack | undefined, t0: number, t1: number): FaceBox[] {
  if (!track || !track.samples.length) return [];
  const dt = 1 / Math.max(1, track.fps);
  const out: FaceBox[] = [];
  for (const s of track.samples) if (s.t >= t0 - dt - 1e-6 && s.t <= t1 + 1e-6) out.push(...s.boxes);
  return out;
}

// ---------------------------------------------------------------- frame mapping

/** How the rough cut is shown in the composition frame. */
export type FrameView =
  | { kind: "full" }
  /** split, plain video: object-fit cover into the bottom box, `offsetPct` = object-position y */
  | { kind: "split"; seam: number; offsetPct: number; frameW: number; frameH: number; roughW: number; roughH: number }
  /** split, cutout: the layer = rough scaled to `layerW` wide (`scaledH` tall), rows from y0, its top at seam − overlap */
  | { kind: "cutout"; seam: number; overlap: number; y0: number; layerW: number; scaledH: number; frameW: number; frameH: number };

/** Maps boxes measured on the rough cut into the composition frame; boxes that leave the visible box are clipped or dropped. */
export function toOutputFrame(track: FaceTrack, view: FrameView): FaceTrack {
  if (view.kind === "full") return track;
  let map: (y: number) => number;
  let mapX: (x: number) => number = (x) => x;
  let top: number;
  if (view.kind === "split") {
    const seamPx = Math.round(view.seam * view.frameH);
    const box = view.frameH - seamPx;
    // cover: scale so the rough fills the box width and height
    const s = Math.max(view.frameW / view.roughW, box / view.roughH);
    const shownH = view.roughH * s;
    const shownW = view.roughW * s;
    const offY = (view.offsetPct / 100) * Math.max(0, shownH - box);
    const offX = (shownW - view.frameW) / 2;
    map = (y) => (seamPx + y * shownH - offY) / view.frameH;
    mapX = (x) => (x * shownW - offX) / view.frameW;
    top = seamPx / view.frameH;
  } else {
    const seamPx = Math.round(view.seam * view.frameH);
    const k = view.frameW / view.layerW;
    map = (y) => (seamPx - view.overlap * k + (y * view.scaledH - view.y0) * k) / view.frameH;
    top = (seamPx - view.overlap * k) / view.frameH;
  }
  return {
    ...track,
    samples: track.samples.map((s) => ({
      t: s.t,
      boxes: s.boxes
        .map((b) => [clamp01(mapX(b[0])), Math.max(top, map(b[1])), clamp01(mapX(b[2])), Math.min(1, map(b[3]))].map(r4) as FaceBox)
        .filter((b) => b[3] - b[1] > 0.01 && b[2] - b[0] > 0.01),
    })),
  };
}

// ---------------------------------------------------------------- fallback: scenes focus + crop maths

/** face height as a fraction of the SOURCE frame height, by the vision step's shot type */
export function faceHeightFor(shotType: string): number {
  const s = shotType.toLowerCase();
  if (/extreme|ecu|close|крупн/.test(s)) return 0.34;
  if (/wide|общ|long|establish/.test(s)) return 0.1;
  if (/medium|средн|mid/.test(s)) return 0.2;
  return 0.22;
}

/**
 * Coarse face boxes per output clip from scenes.json: the focus point (where the face is) through the crop the cut
 * made (auto_face window or centre crop, then the final zoom), a box of the shot type's face size. Clips without a
 * located face get no box. Samples at FACE_FPS over each clip's output range.
 */
export function estimateFaceTrack(
  clips: (Pick<Clip, "src_start" | "src_end" | "crop" | "zoom"> & { out_start: number; out_end: number })[],
  scenes: Scenes,
  media: Pick<Media, "width" | "height">,
  aspect: Aspect,
): FaceTrack {
  const { w, h } = OUTPUT_SIZE[aspect];
  const r = w / h;
  const cw = Math.min(media.width, media.height * r);
  const ch = Math.min(media.height, media.width / r);
  const samples: FaceSample[] = [];
  let any = false;
  for (const c of clips) {
    const f = clipFocus(c, scenes);
    let box: FaceBox | null = null;
    if (f) {
      // the shot types the clip spans, by overlap
      let fh = 0;
      let wsum = 0;
      for (const s of scenes) {
        const ov = Math.min(s.end, c.src_end) - Math.max(s.start, c.src_start);
        if (ov > 0 && s.focus) {
          fh += faceHeightFor(s.shot_type) * ov;
          wsum += ov;
        }
      }
      fh = wsum > 0 ? fh / wsum : 0.22;
      // the crop window in source pixels (the cut: centred on the focus for auto_face, else centred)
      const fx = c.crop === "auto_face" ? f.x : 0.5;
      const fy = c.crop === "auto_face" ? f.y : 0.5;
      const x0 = Math.min(Math.max(media.width * fx - cw / 2, 0), media.width - cw);
      const y0 = Math.min(Math.max(media.height * fy - ch / 2, 0), media.height - ch);
      let cx = (f.x * media.width - x0) / cw;
      let cy = (f.y * media.height - y0) / ch;
      // face: roughly 0.75 as wide as tall (in source pixels)
      let bh = (fh * media.height) / ch;
      let bw = (0.75 * fh * media.height) / cw;
      const z = c.zoom ? Math.max(c.zoom.from, c.zoom.to) : 1;
      if (z > 1 && c.zoom) {
        cx = c.zoom.x + (cx - c.zoom.x) * z;
        cy = c.zoom.y + (cy - c.zoom.y) * z;
        bh *= z;
        bw *= z;
      }
      if (cx > -0.1 && cx < 1.1 && cy > -0.1 && cy < 1.1) {
        // the focus point sits around the eyes: more face below it than above
        box = [clamp01(cx - bw / 2), clamp01(cy - 0.45 * bh), clamp01(cx + bw / 2), clamp01(cy + 0.55 * bh)].map(r4) as FaceBox;
        any = true;
      }
    }
    for (let t = c.out_start; t < c.out_end - 1e-6; t += 1 / FACE_FPS) samples.push({ t: r4(t), boxes: box ? [box] : [] });
  }
  return { source: any ? "scenes" : "none", fps: FACE_FPS, samples };
}

// ---------------------------------------------------------------- sidecar

async function fileHash(file: string): Promise<string> {
  const h = createHash("sha1");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve())
      .on("error", reject);
  });
  return h.digest("hex");
}

export interface DetectOptions {
  python?: string | null;
  run?: MatteRunner;
  fps?: number;
  onLog?: (l: string) => void;
}

/** Runs the sidecar's `faces` command on a video (or reuses the cached result for the same file, script and fps). */
export async function detectFaces(video: string, cacheDir: string, o: DetectOptions = {}): Promise<{ raw: FaceSidecar; cached: boolean }> {
  const python = o.python === undefined ? await findMattePython() : o.python;
  if (!python) throw new Error("сайдкар tools/matte не установлен");
  const fps = o.fps ?? FACE_FPS;
  const script = await fs.readFile(MATTE_SCRIPT).catch(() => Buffer.from(""));
  const key = createHash("sha1").update(await fileHash(video)).update(JSON.stringify({ fps, v: FACES_VERSION })).update(script).digest("hex").slice(0, 16);
  const out = path.join(cacheDir, `faces_${key}.json`);
  if (await exists(out)) {
    try {
      return { raw: FaceSidecarSchema.parse(JSON.parse(await fs.readFile(out, "utf8"))), cached: true };
    } catch {
      /* stale: recompute */
    }
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = out.replace(/\.json$/, ".part.json");
  const args = ["faces", "--input", video, "--out", tmp, "--fps", String(fps)];
  if (process.env.FFMPEG_PATH) args.push("--ffmpeg", process.env.FFMPEG_PATH);
  if (process.env.FFPROBE_PATH) args.push("--ffprobe", process.env.FFPROBE_PATH);
  const r = await (o.run ?? runMatteSidecar)(python, args, o.onLog && ((l) => /^faces: \d+ samples/.test(l) && o.onLog!(l)));
  if (r.code !== 0 || !(await exists(tmp))) {
    const err = r.stderr.split(/\r?\n/).filter((l) => /^error:|Error/.test(l.trim())).slice(-2).join(" | ") || r.stderr.trim().split("\n").slice(-2).join(" | ");
    await fs.rm(tmp, { force: true });
    throw new Error(`детекция лиц не удалась (exit ${r.code}): ${err.slice(0, 300)}`);
  }
  await fs.rename(tmp, out);
  return { raw: FaceSidecarSchema.parse(JSON.parse(await fs.readFile(out, "utf8"))), cached: false };
}

export interface ResolveFacesInput {
  rough: string;
  cacheDir: string;
  /** the clips the cut used, with their output ranges (fallback) */
  clips: (Pick<Clip, "src_start" | "src_end" | "crop" | "zoom"> & { out_start: number; out_end: number })[];
  scenes?: Scenes;
  media: Pick<Media, "width" | "height">;
  aspect: Aspect;
}

/** The face track of a rough cut: the sidecar when installed, else the scenes estimate, else none (with a note why). */
export async function resolveFaceTrack(i: ResolveFacesInput, o: DetectOptions = {}): Promise<{ track: FaceTrack; warnings: string[]; seconds?: number; cached?: boolean }> {
  const warnings: string[] = [];
  const python = o.python === undefined ? await findMattePython() : o.python;
  if (python && (await exists(i.rough))) {
    try {
      const { raw, cached } = await detectFaces(i.rough, i.cacheDir, { ...o, python });
      return { track: { source: "mediapipe", fps: raw.fps, samples: smoothFaceTrack(raw.samples, { fps: raw.fps }) }, warnings, seconds: raw.wall_seconds, cached };
    } catch (err) {
      warnings.push(`лица по кадрам не найдены (${err instanceof Error ? err.message.split("\n")[0] : String(err)}) — положение субтитров по точкам фокуса сцен`);
    }
  }
  const track = i.scenes ? estimateFaceTrack(i.clips, i.scenes, i.media, i.aspect) : { source: "none" as const, fps: FACE_FPS, samples: [] };
  if (!python) warnings.push(track.source === "scenes" ? "сайдкар tools/matte не установлен — лица оценены по точкам фокуса сцен (грубо)" : "нет данных о лицах — субтитры на месте пресета");
  return { track, warnings };
}
