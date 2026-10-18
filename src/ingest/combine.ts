import path from "node:path";
import { z } from "zod";
import { BT709_TAGS, ffmpeg, ffprobe, isVideoStream, toneMapChain } from "../lib/ffmpeg.ts";

/**
 * Several source videos → one source the single-video pipeline understands: each clip is scaled to
 * cover a common canvas (the orientation most sources share) and cropped to it — except vertical clips on a
 * horizontal canvas, which sit whole over a blurred copy of themselves — set to 30 fps with
 * 48 kHz stereo audio (silence for clips without sound) and concatenated. sources.json maps the
 * combined timeline back to the files so the planner can say "video 2" and avoid crossing seams.
 */

export const SourcesSchema = z.object({
  canvas: z.object({ width: z.number().int(), height: z.number().int() }),
  sources: z.array(z.object({ id: z.string(), name: z.string(), file: z.string(), start: z.number(), end: z.number(), cropped: z.boolean() })),
});
export type Sources = z.infer<typeof SourcesSchema>;

interface Probed {
  file: string;
  width: number;
  height: number;
  duration: number;
  audio: boolean;
  /** HDR → SDR chain ("" for SDR), ends with "," */
  toneMap: string;
}

async function probe(file: string): Promise<Probed> {
  const p = await ffprobe(file);
  const v = p.streams.find(isVideoStream);
  if (!v?.width || !v.height) throw new Error(`${path.basename(file)}: нет видеопотока`);
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
  return { file, width: rot ? v.height : v.width, height: rot ? v.width : v.height, duration: Number(p.format.duration) || 0, audio: p.streams.some((s) => s.codec_type === "audio"), toneMap: await toneMapChain(v) };
}

/** Canvas for a set of sources: portrait 1080×1920 when at least half are portrait, else 1920×1080. */
export function chooseCanvas(dims: { width: number; height: number }[]): { width: number; height: number } {
  const portrait = dims.filter((d) => d.height > d.width).length;
  return portrait * 2 >= dims.length ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

export async function combineSources(files: string[], out: string): Promise<Sources> {
  if (files.length < 2) throw new Error("combineSources: нужно минимум два видео");
  const probed = await Promise.all(files.map(probe));
  const canvas = chooseCanvas(probed);
  const inputs: string[] = [];
  const chains: string[] = [];
  const concatIn: string[] = [];
  let next = probed.length;
  probed.forEach((p, i) => inputs.push("-i", p.file));
  const sources: Sources["sources"] = [];
  let t = 0;
  probed.forEach((p, i) => {
    const differs = Math.abs(p.width / p.height - canvas.width / canvas.height) > 0.02;
    const portraitOnLandscape = differs && p.height > p.width && canvas.width > canvas.height;
    const cropped = differs && !portraitOnLandscape;
    if (portraitOnLandscape) {
      // a vertical clip on a horizontal canvas: whole clip in the middle over a blurred copy of itself, so the
      // later 9:16 centre/face crop gets the full vertical frame back instead of a double crop
      chains.push(
        `[${i}:V]${p.toneMap}split=2[bg${i}][fg${i}];` +
          `[bg${i}]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase,crop=${canvas.width}:${canvas.height},boxblur=30:4,eq=brightness=-0.1[bgb${i}];` +
          `[fg${i}]scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=decrease:flags=lanczos[fgs${i}];` +
          `[bgb${i}][fgs${i}]overlay=(W-w)/2:(H-h)/2,fps=30,format=yuv420p,setsar=1[v${i}]`,
      );
    } else {
      chains.push(`[${i}:V]${p.toneMap}scale=${canvas.width}:${canvas.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${canvas.width}:${canvas.height},fps=30,format=yuv420p,setsar=1[v${i}]`);
    }
    if (p.audio) chains.push(`[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]`);
    else {
      // a silent track of the clip's length keeps the concat aligned
      inputs.push("-f", "lavfi", "-t", p.duration.toFixed(3), "-i", "anullsrc=r=48000:cl=stereo");
      chains.push(`[${next}:a]anull[a${i}]`);
      next++;
    }
    concatIn.push(`[v${i}][a${i}]`);
    sources.push({ id: `v${i + 1}`, name: path.basename(p.file), file: path.resolve(p.file), start: Math.round(t * 1000) / 1000, end: Math.round((t + p.duration) * 1000) / 1000, cropped });
    t += p.duration;
  });
  chains.push(`${concatIn.join("")}concat=n=${probed.length}:v=1:a=1[v][a]`);
  await ffmpeg([...inputs, "-filter_complex", chains.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-g", "30", ...(probed.some((p) => p.toneMap) ? BT709_TAGS : []), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
  // real boundaries: the encoded clip lengths can differ from the container durations by a frame
  return { canvas, sources };
}
