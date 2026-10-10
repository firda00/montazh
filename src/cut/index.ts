import path from "node:path";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { jobDir, writeJson } from "../lib/workspace.ts";
import { TARGET_FPS } from "../ingest/index.ts";
import type { Aspect, Clip, Edl, Media, Output } from "../schemas/index.ts";
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

/** Center crop to the target aspect ratio, then scale to the delivery size. */
export function cropScaleFilter(aspect: Aspect): string {
  const { w, h } = OUTPUT_SIZE[aspect];
  const r = w / h;
  const cw = `trunc(min(iw\\,ih*${r})/2)*2`;
  const ch = `trunc(min(ih\\,iw/${r})/2)*2`;
  return `crop=${cw}:${ch},scale=${w}:${h}:flags=lanczos,setsar=1`;
}

/** Clamp clips to the media and report anything we had to change. */
export function sanitizeClips(clips: Clip[], media: Media) {
  const warnings: string[] = [];
  const kept: Clip[] = [];
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
    if (c.crop === "auto_face") warnings.push(`clip ${i}: auto_face not implemented yet, using center crop`);
    kept.push({ ...c, src_end: end });
  });
  return { clips: kept, warnings };
}

export function expectedDuration(clips: Clip[]) {
  return clips.reduce((sum, c) => sum + (c.src_end - c.src_start) / c.speed, 0);
}

/** Builds the ffmpeg argument list for one output. Each clip is a separately-seeked input. */
export function buildCutArgs(output: Output, clips: Clip[], media: Media, outPath: string): string[] {
  const args: string[] = [];
  for (const c of clips) {
    args.push("-ss", c.src_start.toFixed(3), "-to", c.src_end.toFixed(3), "-i", media.normalized_path);
  }
  const vf = cropScaleFilter(output.aspect);
  const chains: string[] = [];
  const concatInputs: string[] = [];
  clips.forEach((c, i) => {
    const setpts = c.speed === 1 ? "PTS-STARTPTS" : `(PTS-STARTPTS)/${c.speed}`;
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
export async function cut(jobId: string, edl: Edl, media: Media, only?: string[]): Promise<CutReport & { partial: boolean }> {
  const dir = jobDir(jobId);
  const report: CutReport = { outputs: [] };
  const targets = only ? edl.outputs.filter((o) => only.includes(o.id)) : edl.outputs;

  for (const output of targets) {
    const { clips, warnings } = sanitizeClips(output.clips, media);
    const expected = expectedDuration(clips);
    if (output.target_duration && Math.abs(expected - output.target_duration) > 1) {
      warnings.push(`duration ${expected.toFixed(1)}s differs from target ${output.target_duration}s`);
    }
    if (clips.length === 0) {
      report.outputs.push({ id: output.id, status: "failed", expected_duration: 0, warnings, error: "no usable clips" });
      continue;
    }
    const outPath = path.join(dir, `rough_${output.id}.mp4`);
    try {
      await ffmpeg(buildCutArgs(output, clips, media, outPath));
      const probe = await ffprobe(outPath);
      report.outputs.push({
        id: output.id,
        status: "ok",
        path: outPath,
        duration: Number(probe.format.duration),
        expected_duration: expected,
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

  await writeJson(path.join(dir, "cut.json"), CutReportSchema, report);
  const failed = report.outputs.filter((o) => o.status === "failed").length;
  if (failed === report.outputs.length) {
    throw new Error(`all outputs failed:\n${report.outputs.map((o) => `  ${o.id}: ${o.error}`).join("\n")}`);
  }
  return { ...report, partial: failed > 0 };
}
