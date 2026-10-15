import path from "node:path";
import { ffmpeg, ffprobe, parseRate } from "../lib/ffmpeg.ts";
import { exists, jobDir, writeJson } from "../lib/workspace.ts";
import { MediaSchema, type Media } from "../schemas/index.ts";

export const TARGET_FPS = 30;
const MAX_LONG_SIDE = 1920;
/** x264 quality of normalized.mp4: an intermediate, re-encoded again at render; 18 cost +40% size for no visible gain */
export const X264_CRF = 20;

/** Even dimensions that fit inside MAX_LONG_SIDE, preserving aspect. */
function normalizedSize(w: number, h: number) {
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
}

/**
 * Video filter of the normalized copy for a source shown at displayW×displayH. The scaler runs
 * only when the size changes (too large, or odd dimensions); lanczos on an unchanged size only costs time.
 */
export function normalizeFilter(displayW: number, displayH: number): { width: number; height: number; vf: string } {
  const { width, height } = normalizedSize(displayW, displayH);
  const scale = width === displayW && height === displayH ? "" : `scale=${width}:${height}:flags=lanczos,`;
  return { width, height, vf: `${scale}fps=${TARGET_FPS},format=yuv420p,setsar=1` };
}

/**
 * INGEST: probe the source, write a constant-frame-rate H.264/AAC copy that every later
 * step can rely on (always has an audio track, keyframe every second), and extract
 * 16 kHz mono WAV for transcription.
 */
export async function ingest(jobId: string, sourcePath: string): Promise<Media> {
  if (!(await exists(sourcePath))) throw new Error(`source video not found: ${sourcePath}`);
  const dir = jobDir(jobId);
  const probe = await ffprobe(sourcePath);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  if (!v || !v.width || !v.height) throw new Error("source has no video stream");

  const duration = Number(probe.format.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("could not determine source duration");

  const rotation = Math.abs(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(v.tags?.rotate ?? 0));
  // ffmpeg auto-rotates on decode, so a 90/270° source comes out with swapped dimensions
  const rotated = rotation === 90 || rotation === 270;
  const displayW = rotated ? v.height : v.width;
  const displayH = rotated ? v.width : v.height;
  const { width, height, vf } = normalizeFilter(displayW, displayH);

  const normalized = path.join(dir, "normalized.mp4");
  const args = ["-i", sourcePath];
  if (!a) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-map", "0:v:0",
    "-map", a ? "0:a:0" : "1:a:0",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", String(X264_CRF),
    "-g", String(TARGET_FPS), "-keyint_min", String(TARGET_FPS),
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
    "-t", String(duration),
    "-movflags", "+faststart",
    normalized,
  );
  await ffmpeg(args);

  let audioPath: string | null = null;
  if (a) {
    audioPath = path.join(dir, "audio.wav");
    await ffmpeg(["-i", normalized, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audioPath]);
  }

  const out = await ffprobe(normalized);
  const outDuration = Number(out.format.duration) || duration;

  return writeJson(path.join(dir, "media.json"), MediaSchema, {
    source_path: path.resolve(sourcePath),
    normalized_path: normalized,
    audio_path: audioPath,
    duration: outDuration,
    fps: TARGET_FPS,
    width,
    height,
    has_audio: Boolean(a),
    source: {
      fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate),
      width: v.width,
      height: v.height,
      video_codec: v.codec_name ?? null,
      audio_codec: a?.codec_name ?? null,
      rotation,
    },
  });
}

/**
 * Light ingest for the highlights mode: no 30 fps re-encode of the whole file (an hour of footage would
 * take longer than the edit), the original is used directly (normalized_path = source) — every clip is
 * re-encoded by the cut anyway, and slow motion needs the original frame rate. Only for sources ffmpeg
 * seeks reliably: H.264/HEVC video without rotation, with audio. Falls back to the full ingest otherwise.
 */
export async function ingestLight(jobId: string, sourcePath: string): Promise<Media> {
  if (!(await exists(sourcePath))) throw new Error(`source video not found: ${sourcePath}`);
  const probe = await ffprobe(sourcePath);
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  const rotation = Math.abs(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? Number(v?.tags?.rotate ?? 0));
  const duration = Number(probe.format.duration);
  const ok = v && v.width && v.height && a && rotation === 0 && /^(h264|hevc)$/.test(v.codec_name ?? "") && Number.isFinite(duration) && Math.max(v.width, v.height) <= 3840;
  if (!ok) return ingest(jobId, sourcePath);
  const src = path.resolve(sourcePath);
  return writeJson(path.join(jobDir(jobId), "media.json"), MediaSchema, {
    source_path: src,
    normalized_path: src,
    audio_path: null,
    duration,
    fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || TARGET_FPS,
    width: v.width!,
    height: v.height!,
    has_audio: true,
    source: { fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate), width: v.width!, height: v.height!, video_codec: v.codec_name ?? null, audio_codec: a.codec_name ?? null, rotation },
  });
}
