import path from "node:path";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { TARGET_FPS } from "../ingest/index.ts";
import { ClipSchema, ScenesSchema, type Aspect, type Clip, type Edl, type Media, type Output, type Scenes, type Transcript } from "../schemas/index.ts";
import { checkClipBoundaries, snapClipsToWords } from "../plan/validate.ts";
import { z } from "zod";

export const OUTPUT_SIZE: Record<Aspect, { w: number; h: number }> = {
  "9:16": { w: 1080, h: 1920 },
  "1:1": { w: 1080, h: 1080 },
  "16:9": { w: 1920, h: 1080 },
};

export const CutReportSchema = z.object({
  outputs: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["ok", "failed"]),
      path: z.string().optional(),
      duration: z.number().optional(),
      expected_duration: z.number(),
      /** the clips actually cut (after clamping and word snapping) — the design stage builds its timeline from these */
      clips: z.array(ClipSchema).optional(),
      warnings: z.array(z.string()),
      error: z.string().optional(),
    }),
  ),
});
export type CutReport = z.infer<typeof CutReportSchema>;

/** atempo only accepts 0.5..2 per instance, so chain several for larger factors. */
export function atempoChain(speed: number): string[] {
  const parts: string[] = [];
  let s = speed;
  while (s > 2) {
    parts.push("atempo=2");
    s /= 2;
  }
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${s.toFixed(6)}`);
  return parts;
}

/** A point of interest in the source frame, as fractions (0..1) of width and height. */
export type Focus = { x: number; y: number };

/** crop offset that centres the window on the focus point and stays inside the frame (even, for yuv420p) */
const offsetExpr = (full: "iw" | "ih", out: "ow" | "oh", f: number) => `trunc(clip(${full}*${f.toFixed(4)}-${out}/2\\,0\\,${full}-${out})/2)*2`;

/** Crop to the target aspect ratio — centred, or around a focus point (crop: auto_face) — then scale to the delivery size. */
export function cropScaleFilter(aspect: Aspect, focus?: Focus | null): string {
  const { w, h } = OUTPUT_SIZE[aspect];
  const r = w / h;
  const cw = `trunc(min(iw\\,ih*${r})/2)*2`;
  const ch = `trunc(min(ih\\,iw/${r})/2)*2`;
  const at = focus ? `:${offsetExpr("iw", "ow", focus.x)}:${offsetExpr("ih", "oh", focus.y)}` : "";
  return `crop=${cw}:${ch}${at},scale=${w}:${h}:flags=lanczos,setsar=1`;
}

/**
 * Where to keep the frame for one clip: the overlap-weighted mean of the focus points of the
 * scenes it spans (one static crop per clip — no reframing jitter inside a clip). null when the
 * vision step produced no focus for these shots (stub, or no clear subject).
 */
export function clipFocus(clip: Pick<Clip, "src_start" | "src_end">, scenes: Scenes): Focus | null {
  let wx = 0;
  let wy = 0;
  let wsum = 0;
  for (const s of scenes) {
    if (!s.focus) continue;
    const overlap = Math.min(s.end, clip.src_end) - Math.max(s.start, clip.src_start);
    if (overlap <= 0) continue;
    wx += s.focus.x * overlap;
    wy += s.focus.y * overlap;
    wsum += overlap;
  }
  return wsum > 0 ? { x: wx / wsum, y: wy / wsum } : null;
}

/** scenes.json of a job, when the understand step has run. */
export async function loadScenes(jobId: string): Promise<Scenes | undefined> {
  const file = path.join(jobDir(jobId), "scenes.json");
  return (await exists(file)) ? readJson(file, ScenesSchema) : undefined;
}

/** Clamp clips to the media and report anything we had to change. */
export function sanitizeClips(clips: Clip[], media: Media) {
  const warnings: string[] = [];
  const kept: Clip[] = [];
  const indices: number[] = []; // EDL index of each kept clip
  clips.forEach((c, i) => {
    if (c.src_start >= media.duration) {
      warnings.push(`clip ${i}: starts at ${c.src_start}s, after end of video (${media.duration.toFixed(2)}s) — skipped`);
      return;
    }
    let end = c.src_end;
    if (end > media.duration) {
      warnings.push(`clip ${i}: src_end ${end}s clamped to ${media.duration.toFixed(2)}s`);
      end = media.duration;
    }
    kept.push({ ...c, src_end: end });
    indices.push(i);
  });
  return { clips: kept, warnings, indices };
}

export function expectedDuration(clips: Clip[]) {
  return clips.reduce((sum, c) => sum + (c.src_end - c.src_start) / c.speed, 0);
}

/** Builds the ffmpeg argument list for one output. Each clip is a separately-seeked input. */
export function buildCutArgs(output: Output, clips: Clip[], media: Media, outPath: string, focuses: (Focus | null)[] = []): string[] {
  const args: string[] = [];
  for (const c of clips) {
    args.push("-ss", c.src_start.toFixed(3), "-to", c.src_end.toFixed(3), "-i", media.normalized_path);
  }
  const chains: string[] = [];
  const concatInputs: string[] = [];
  clips.forEach((c, i) => {
    const setpts = c.speed === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${c.speed}`;
    const vf = cropScaleFilter(output.aspect, c.crop === "auto_face" ? focuses[i] : null);
    chains.push(`[${i}:v]setpts=${setpts},${vf},fps=${TARGET_FPS},format=yuv420p[v${i}]`);
    const audio = ["asetpts=PTS-STARTPTS", ...atempoChain(c.speed), "aresample=48000"].join(",");
    chains.push(`[${i}:a]${audio}[a${i}]`);
    concatInputs.push(`[v${i}][a${i}]`);
  });
  chains.push(`${concatInputs.join("")}concat=n=${clips.length}:v=1:a=1[v][a]`);

  args.push(
    "-filter_complex", chains.join(";"),
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    // 1 s GOP and explicit colour tags: overlay renderers seek by keyframe and browsers assume bt709
    "-g", String(TARGET_FPS), "-keyint_min", String(TARGET_FPS), "-sc_threshold", "0",
    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    outPath,
  );
  return args;
}

/**
 * CUT: one rough_<id>.mp4 per EDL output. Outputs are independent — one failing
 * does not stop the others; the report says which succeeded.
 */
export interface CutOptions {
  only?: string[];
  /** when present, clip edges are checked against word boundaries (spec §5.3) */
  transcript?: Transcript;
  /** move offending edges to the nearest word boundary instead of only warning */
  snap?: boolean;
  /** scenes with focus points (Gemini) — needed for crop: auto_face; without them auto_face falls back to centre */
  scenes?: Scenes;
}

export async function cut(jobId: string, edl: Edl, media: Media, opts: CutOptions = {}): Promise<CutReport & { partial: boolean }> {
  const dir = jobDir(jobId);
  const report: CutReport = { outputs: [] };
  if (opts.only) {
    const unknown = opts.only.filter((id) => !edl.outputs.some((o) => o.id === id));
    if (unknown.length) throw new Error(`unknown output id(s): ${unknown.join(", ")} (plan has ${edl.outputs.map((o) => o.id).join(", ")})`);
  }
  const targets = opts.only ? edl.outputs.filter((o) => opts.only!.includes(o.id)) : edl.outputs;

  for (const output of targets) {
    let { clips, warnings, indices } = sanitizeClips(output.clips, media);
    // warnings number clips as in the EDL, even after sanitizeClips dropped one
    const edlIndex = (i: number) => indices[i] ?? i;
    if (opts.transcript) {
      if (opts.snap) {
        const snapped = snapClipsToWords(clips, opts.transcript);
        clips = snapped.clips;
        warnings.push(...snapped.notes.map((n) => n.replace(/^clip (\d+)/, (_m, k) => `clip ${edlIndex(Number(k))}`)));
      } else {
        for (const i of checkClipBoundaries(clips, opts.transcript)) {
          warnings.push(`clip ${edlIndex(i.clip)} ${i.edge} ${i.t.toFixed(2)}s cuts the word "${i.word.w}" (${i.word.start}-${i.word.end}s)`);
        }
      }
    }
    const expected = expectedDuration(clips);
    if (output.target_duration && Math.abs(expected - output.target_duration) > 1) {
      warnings.push(`duration ${expected.toFixed(1)}s differs from target ${output.target_duration}s`);
    }
    if (clips.length === 0) {
      report.outputs.push({ id: output.id, status: "failed", expected_duration: 0, warnings, error: "no usable clips" });
      continue;
    }
    // auto_face: one static crop per clip around the subject the vision step located
    const hasFocus = opts.scenes?.some((s) => s.focus) ?? false;
    const focuses = clips.map((c, i) => {
      if (c.crop !== "auto_face") return null;
      const f = opts.scenes ? clipFocus(c, opts.scenes) : null;
      if (!f) warnings.push(`clip ${edlIndex(i)}: auto_face — ${hasFocus ? "no subject located in these shots" : "no focus data (vision stub)"}, center crop`);
      return f;
    });
    const outPath = path.join(dir, `rough_${output.id}.mp4`);
    try {
      await ffmpeg(buildCutArgs(output, clips, media, outPath, focuses));
      const probe = await ffprobe(outPath);
      report.outputs.push({
        id: output.id,
        status: "ok",
        path: outPath,
        duration: Number(probe.format.duration),
        expected_duration: expected,
        clips,
        warnings,
      });
    } catch (err) {
      report.outputs.push({
        id: output.id,
        status: "failed",
        expected_duration: expected,
        warnings,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // cut.json keeps the records of outputs a --only run did not touch; the returned report covers this run only
  const reportFile = path.join(dir, "cut.json");
  let stored: CutReport = report;
  if (opts.only && (await exists(reportFile))) {
    const previous = await readJson(reportFile, CutReportSchema);
    const touched = new Set(report.outputs.map((o) => o.id));
    stored = { outputs: [...previous.outputs.filter((o) => !touched.has(o.id) && edl.outputs.some((e) => e.id === o.id)), ...report.outputs] };
  }
  await writeJson(reportFile, CutReportSchema, stored);
  const failed = report.outputs.filter((o) => o.status === "failed").length;
  if (targets.length > 0 && failed === targets.length) {
    throw new Error(`all outputs failed:\n${report.outputs.filter((o) => o.status === "failed").map((o) => `  ${o.id}: ${o.error}`).join("\n")}`);
  }
  return { ...report, partial: failed > 0 };
}
