import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { jobSignal } from "../lib/abort.ts";
import { exists } from "../lib/workspace.ts";

/**
 * Speaker cutout for the split layout: a Python sidecar (tools/matte/vedit_matte.py, MediaPipe selfie
 * segmenter + guided-filter edge + temporal smoothing) cuts the speaker out of the rough cut and writes
 *   - the plate: the bottom box (below the seam) with the speaker already composited over the designed
 *     background — an ordinary opaque H.264, as cheap for HyperFrames as the plain split video;
 *   - the pop strip: the `overlap` rows above the seam as a VP9 WebM with alpha (yuva420p) — the head
 *     breaking over the top panel. HyperFrames decodes VP9 alpha (libvpx-vp9 → PNG frames); keeping the
 *     alpha part small matters: a full-height alpha layer rendered ~3.5× slower and stalled Chrome's capture.
 * Cached by the rough cut's content, the parameters and the script.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MATTE_SCRIPT = path.join(ROOT, "tools", "matte", "vedit_matte.py");
export const MATTE_MODEL = path.join(ROOT, "tools", "matte", "models", "selfie_segmenter.tflite");
const VENV_PYTHON = path.join(ROOT, "tools", "matte", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export type CutoutMode = "off" | "on" | "auto";

/** Python of the matte venv, or VEDIT_MATTE_PYTHON; null when the sidecar is not installed. */
export async function findMattePython(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const p = env.VEDIT_MATTE_PYTHON?.trim() || VENV_PYTHON;
  return (await exists(p)) && (await exists(MATTE_SCRIPT)) ? p : null;
}

export const MatteStatsSchema = z
  .object({
    version: z.string(),
    segmenter: z.string(),
    output: z.object({ plate: z.string(), pop: z.string().nullable(), width: z.number(), height: z.number(), plate_height: z.number(), y0: z.number(), overlap: z.number() }).loose(),
    placement: z.object({ samples: z.number(), with_person: z.number(), head_top: z.number().nullable(), head_clipped: z.number() }).loose(),
    frames: z.number(),
    analysed_frames: z.number(),
    cuts: z.number(),
    coverage: z.object({ median: z.number(), p10: z.number(), p90: z.number() }),
    empty_frac: z.number(),
    fallback_frames: z.number(),
    stability: z.object({ median_iou: z.number(), unstable_frac: z.number() }),
    uncertain_ratio: z.number(),
    timings: z.object({ wall_seconds: z.number(), realtime_factor: z.number() }).loose(),
  })
  .loose();
export type MatteStats = z.infer<typeof MatteStatsSchema>;

/** Where the cutout layer sits: `overlap` px above the seam down to the frame bottom (sizes even for 4:2:0). */
export function cutoutGeometry(W: number, H: number, seamFrac: number, popOut: number) {
  const seam = Math.round(seamFrac * H);
  const overlap = 2 * Math.round((popOut * H) / 2);
  const height = H - seam + overlap;
  return { width: W + (W % 2), height: height + (height % 2), overlap, seam, top: seam - overlap };
}

/**
 * Is the matte good enough to replace the plain video ("auto")? A person most of the time, not the
 * whole frame, a stable silhouette (consecutive analysis masks overlap) and few undecided pixels.
 */
export function judgeMatte(s: MatteStats): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (s.frames <= 0) reasons.push("нет кадров");
  if (s.coverage.median < 0.08) reasons.push(`спикер занимает мало кадра (${pct(s.coverage.median)})`);
  if (s.coverage.median > 0.92) reasons.push(`маска почти на весь кадр (${pct(s.coverage.median)})`);
  if (s.empty_frac > 0.15) reasons.push(`без человека ${pct(s.empty_frac)} кадров`);
  if (s.stability.median_iou < 0.85 || s.stability.unstable_frac > 0.15) reasons.push(`маска дрожит (IoU ${s.stability.median_iou.toFixed(2)}, нестабильных ${pct(s.stability.unstable_frac)})`);
  if (s.uncertain_ratio > 0.35) reasons.push(`размытая граница (${pct(s.uncertain_ratio)} неуверенных пикселей)`);
  if (s.placement.samples > 0 && s.placement.with_person / s.placement.samples < 0.6) reasons.push(`человек найден в ${s.placement.with_person}/${s.placement.samples} проб`);
  return { ok: reasons.length === 0, reasons };
}

export interface MatteRun {
  code: number | null;
  stderr: string;
}
export type MatteRunner = (python: string, args: string[], onLog?: (line: string) => void) => Promise<MatteRun>;

export const runMatteSidecar: MatteRunner = (python, args, onLog) =>
  new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", MATTE_SCRIPT, ...args], { windowsHide: true, signal: jobSignal(), env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", TF_CPP_MIN_LOG_LEVEL: "2", GLOG_minloglevel: "2" } });
    let stderr = "";
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      // TFLite/absl chatter is noise; our own progress lines go through
      if (onLog) for (const line of s.split(/\r?\n/)) if (/^(matte|error)/.test(line.trim())) onLog(line.trim());
    });
    child.stdout.on("data", () => {});
    child.on("error", (err) => reject(new Error(`${python} failed to start: ${err.message}`)));
    child.on("close", (code) => resolve({ code, stderr }));
  });

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

export interface CutoutParams {
  width: number;
  height: number;
  overlap: number;
  headMargin?: number;
  analysisFps?: number;
  /** designed background of the bottom box (design.split.panel_bg / accent) */
  bg?: string;
  accent?: string;
}

export interface Cutout {
  /** H.264, `width`×`plateHeight`: the speaker over the designed background, the box below the seam */
  plate: string;
  /** VP9+alpha WebM, `width`×`overlap`: the strip above the seam (absent when overlap is 0) */
  pop?: string;
  width: number;
  plateHeight: number;
  overlap: number;
  stats: MatteStats;
  cached: boolean;
}

function fromStats(stats: MatteStats, cached: boolean): Cutout {
  const o = stats.output;
  return { plate: o.plate, ...(o.pop ? { pop: o.pop } : {}), width: o.width, plateHeight: o.plate_height, overlap: o.overlap, stats, cached };
}

/** Runs the sidecar (or reuses the cached result for the same rough cut, script and parameters). */
export async function makeCutout(rough: string, cacheDir: string, p: CutoutParams, opts: { python?: string; run?: MatteRunner; onLog?: (l: string) => void } = {}): Promise<Cutout> {
  const python = opts.python ?? (await findMattePython());
  if (!python) throw new Error("сайдкар вырезания фона не установлен (tools/matte/.venv) — см. README «Вырезание спикера»");
  const params = { width: p.width, crop_h: p.height, overlap: p.overlap, head_margin: p.headMargin ?? 24, analysis_fps: p.analysisFps ?? 15, bg: p.bg ?? "#0D0A1A", accent: p.accent ?? "#8B6CFF" };
  const script = await fs.readFile(MATTE_SCRIPT).catch(() => Buffer.from(""));
  const key = createHash("sha1").update(await fileHash(rough)).update(JSON.stringify(params)).update(script).digest("hex").slice(0, 16);
  const plate = path.join(cacheDir, `cutout_${key}.plate.mp4`);
  const pop = path.join(cacheDir, `cutout_${key}.pop.webm`);
  const statsFile = path.join(cacheDir, `cutout_${key}.json`);
  if ((await exists(plate)) && (await exists(statsFile))) {
    try {
      const stats = MatteStatsSchema.parse(JSON.parse(await fs.readFile(statsFile, "utf8")));
      if (!stats.output.pop || (await exists(stats.output.pop))) return fromStats(stats, true);
    } catch {
      /* stale cache: recompute */
    }
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const tmpPlate = plate.replace(/\.mp4$/, ".part.mp4");
  const tmpPop = pop.replace(/\.webm$/, ".part.webm");
  const args = ["matte", "--input", rough, "--out-plate", tmpPlate, "--out-pop", tmpPop, "--bg-color", params.bg, "--accent", params.accent, "--stats", statsFile, "--width", String(params.width), "--crop-h", String(params.crop_h), "--overlap", String(params.overlap), "--head-margin", String(params.head_margin), "--analysis-fps", String(params.analysis_fps), "--model", MATTE_MODEL];
  if (process.env.FFMPEG_PATH) args.push("--ffmpeg", process.env.FFMPEG_PATH);
  if (process.env.FFPROBE_PATH) args.push("--ffprobe", process.env.FFPROBE_PATH);
  const r = await (opts.run ?? runMatteSidecar)(python, args, opts.onLog);
  if (r.code !== 0 || !(await exists(tmpPlate))) {
    const err = r.stderr.split(/\r?\n/).filter((l) => /^error:|Error/.test(l.trim())).slice(-3).join(" | ") || r.stderr.trim().split("\n").slice(-3).join(" | ");
    await fs.rm(tmpPlate, { force: true });
    await fs.rm(tmpPop, { force: true });
    await fs.rm(statsFile, { force: true });
    throw new Error(`вырезание фона не удалось (exit ${r.code}): ${err.slice(0, 400)}`);
  }
  await fs.rename(tmpPlate, plate);
  const raw = JSON.parse(await fs.readFile(statsFile, "utf8"));
  const hasPop = await exists(tmpPop);
  if (hasPop) await fs.rename(tmpPop, pop);
  raw.output = { ...raw.output, plate, pop: hasPop ? pop : null };
  await fs.writeFile(statsFile, JSON.stringify(raw, null, 1));
  return fromStats(MatteStatsSchema.parse(raw), false);
}

/**
 * The cutout for one output by mode: "off" → none; "auto" → the matte when judgeMatte() passes, the
 * plain video otherwise (a warning, never a failure); "on" → the matte even when the check complains,
 * and a missing/failed sidecar is an error.
 */
export async function resolveCutout(
  mode: CutoutMode,
  rough: string,
  cacheDir: string,
  p: CutoutParams,
  opts: { python?: string | null; run?: MatteRunner; onLog?: (l: string) => void } = {},
): Promise<{ cutout?: Cutout; warnings: string[] }> {
  if (mode === "off") return { warnings: [] };
  const python = opts.python === undefined ? await findMattePython() : opts.python;
  if (!python) {
    if (mode === "on") throw new Error("--cutout on: сайдкар вырезания фона не установлен (tools/matte/.venv) — см. README «Вырезание спикера»");
    return { warnings: ["фон спикера не вырезан: сайдкар tools/matte не установлен — обычное видео"] };
  }
  let cut: Cutout;
  try {
    cut = await makeCutout(rough, cacheDir, p, { python, run: opts.run, onLog: opts.onLog });
  } catch (err) {
    if (mode === "on") throw err;
    return { warnings: [`фон спикера не вырезан: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} — обычное видео`] };
  }
  const verdict = judgeMatte(cut.stats);
  if (verdict.ok) return { cutout: cut, warnings: [] };
  if (mode === "on") return { cutout: cut, warnings: [`вырезание фона: маска ненадёжна (${verdict.reasons.join("; ")}), но включено --cutout on`] };
  return { warnings: [`фон спикера не вырезан: маска ненадёжна (${verdict.reasons.join("; ")}) — обычное видео`] };
}

// ---- stage 27: a still photo of a person cut out (the PiP of a montage insert) ----

export interface StillCutoutStats {
  ok: boolean;
  coverage?: number;
  blobs?: number;
  touches_bottom?: boolean;
  uncertain_ratio?: number;
  bbox?: [number, number, number, number];
  size?: [number, number];
  reason?: string;
}

/**
 * Is the cut-out photo usable as a PiP? One person (≤ 2 big blobs), not a speck and not the whole frame, a clean edge.
 * The person need not reach the bottom edge (a bust floating on the chest fades in softly).
 */
export function judgeStillCutout(s: StillCutoutStats): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!s.ok) reasons.push(s.reason ?? "нет человека");
  else {
    if ((s.coverage ?? 0) < 0.06) reasons.push(`человек мал (${Math.round((s.coverage ?? 0) * 100)}%)`);
    if ((s.coverage ?? 0) > 0.88) reasons.push("маска почти на весь кадр");
    if ((s.blobs ?? 0) > 2) reasons.push(`несколько фигур (${s.blobs})`);
    if ((s.uncertain_ratio ?? 0) > 0.4) reasons.push("размытая граница");
  }
  return { ok: reasons.length === 0, reasons };
}

/** Cuts the person out of a photo into an RGBA PNG (cached by the photo's content and the script). */
export async function cutoutStill(photo: string, cacheDir: string, opts: { python?: string | null; run?: MatteRunner; onLog?: (l: string) => void } = {}): Promise<{ png: string; stats: StillCutoutStats; cached: boolean } | null> {
  const python = opts.python === undefined ? await findMattePython() : opts.python;
  if (!python) return null;
  const script = await fs.readFile(MATTE_SCRIPT).catch(() => Buffer.from(""));
  const key = createHash("sha1").update(await fs.readFile(photo)).update(script).digest("hex").slice(0, 16);
  const png = path.join(cacheDir, `still_${key}.png`);
  const statsFile = path.join(cacheDir, `still_${key}.json`);
  if (await exists(statsFile)) {
    try {
      const stats = JSON.parse(await fs.readFile(statsFile, "utf8")) as StillCutoutStats;
      if (!stats.ok || (await exists(png))) return { png, stats, cached: true };
    } catch {}
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const r = await (opts.run ?? runMatteSidecar)(python, ["cutout", "--input", photo, "--out", png, "--stats", statsFile, "--model", MATTE_MODEL], opts.onLog);
  if (r.code !== 0 || !(await exists(statsFile))) {
    opts.onLog?.(`вырезание фото не удалось: ${r.stderr.trim().split("\n").slice(-1)[0]?.slice(0, 200) ?? ""}`);
    return null;
  }
  const stats = JSON.parse(await fs.readFile(statsFile, "utf8")) as StillCutoutStats;
  return { png, stats, cached: false };
}
