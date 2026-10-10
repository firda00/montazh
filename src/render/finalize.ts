import path from "node:path";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";

export interface LoudnessMeasure {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

/** Pass 1 of EBU R128 normalisation: measure the integrated loudness of the file's audio. */
export async function measureLoudness(file: string, target = -14): Promise<LoudnessMeasure> {
  const { stderr } = await ffmpeg(["-i", file, "-vn", "-af", `loudnorm=I=${target}:TP=-1.5:LRA=11:print_format=json`, "-f", "null", "-"], { loglevel: "info" });
  const start = stderr.lastIndexOf("{");
  const end = stderr.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("loudnorm did not report measurements (no audio stream?)");
  const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  const num = (k: string) => Number(j[k]);
  return { input_i: num("input_i"), input_tp: num("input_tp"), input_lra: num("input_lra"), input_thresh: num("input_thresh"), target_offset: num("target_offset") };
}

export interface FinalizeResult {
  output: string;
  preview: string;
  duration: number;
  loudness_before: number;
  loudness_after: number;
  video_codec: string | null;
  audio_codec: string | null;
  width: number;
  height: number;
}

/**
 * Final delivery: the overlay render's video stream (copied, no re-encode) + the rough cut's audio
 * normalised to the target loudness (two-pass loudnorm, linear), trimmed to the rough cut's length
 * so the overlay's whole-frame rounding never leaves a frozen tail. Also writes a preview JPEG.
 */
export async function finalizeOutput(overlay: string, rough: string, output: string, opts: { targetLufs?: number; previewAt?: number } = {}): Promise<FinalizeResult> {
  const target = opts.targetLufs ?? -14;
  const roughProbe = await ffprobe(rough);
  const roughDuration = Number(roughProbe.format.duration);
  const before = await measureLoudness(rough, target);
  const filter = `loudnorm=I=${target}:TP=-1.5:LRA=11:measured_I=${before.input_i}:measured_TP=${before.input_tp}:measured_LRA=${before.input_lra}:measured_thresh=${before.input_thresh}:offset=${before.target_offset}:linear=true:print_format=summary`;
  await ffmpeg([
    "-i", overlay, "-i", rough,
    "-map", "0:v:0", "-map", "1:a:0",
    "-c:v", "copy",
    "-af", filter, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", roughDuration.toFixed(3),
    "-movflags", "+faststart",
    output,
  ]);
  const after = await measureLoudness(output, target);
  const probe = await ffprobe(output);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const duration = Number(probe.format.duration);
  const preview = output.replace(/\.mp4$/i, "") + "_preview.jpg";
  const at = Math.min(opts.previewAt ?? 1.0, Math.max(0, duration - 0.1));
  await ffmpeg(["-ss", at.toFixed(3), "-i", output, "-frames:v", "1", "-q:v", "2", preview]);
  return {
    output,
    preview,
    duration,
    loudness_before: before.input_i,
    loudness_after: after.input_i,
    video_codec: v?.codec_name ?? null,
    audio_codec: a?.codec_name ?? null,
    width: v?.width ?? 0,
    height: v?.height ?? 0,
  };
}

export function outputPath(dir: string, outputId: string) {
  return path.join(dir, `output_${outputId}.mp4`);
}
