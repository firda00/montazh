import path from "node:path";
import { ffmpeg, ffprobe, parseRate } from "../lib/ffmpeg.ts";
import { exists, jobDir, writeJson } from "../lib/workspace.ts";
import { MediaSchema, type Media } from "../schemas/index.ts";

export const TARGET_FPS = 30;
const MAX_LONG_SIDE = 1920;

/** Even dimensions that fit inside MAX_LONG_SIDE, preserving aspect. */
function normalizedSize(w: number, h: number) {
  const scale = Math.min(1, MAX_LONG_SIDE / Math.max(w, h));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(w), height: even(h) };
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
  const { width, height } = normalizedSize(displayW, displayH);

  const normalized = path.join(dir, "normalized.mp4");
  const args = ["-i", sourcePath];
  if (!a) args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  args.push(
    "-map", "0:v:0",
    "-map", a ? "0:a:0" : "1:a:0",
    "-vf", `scale=${width}:${height}:flags=lanczos,fps=${TARGET_FPS},format=yuv420p,setsar=1`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
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
