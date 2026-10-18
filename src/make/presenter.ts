import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import type { Frame } from "../lib/aspect.ts";

/**
 * A talking presenter in the corner of a `make` video (stage 25).
 *
 *   1. `vedit make <тема> --presenter [фото]` — the narration track on the video's timeline (make/voice/voice.wav, pauses
 *      between beats included) goes into a normal avatar bundle (`vedit avatar export --speech`): Colab only animates the
 *      face (JoyVASA + LivePortrait), so the lips match the narration frame for frame.
 *   2. `vedit make <тема> --from <job> --presenter-video avatar_result.zip` (or a ready avatar.mp4) — the same script and
 *      voice (TTS cache), the presenter is cut into a circle with an alpha channel (VP9 WebM, yuva420p — the format
 *      HyperFrames decodes itself, as the split cutout's pop strip) and laid in the bottom corner over every scene;
 *      text that sat at the bottom moves up so it is not covered.
 */

export interface PresenterBox {
  /** px, square */
  size: number;
  right: number;
  bottom: number;
}

/** Where the presenter sits: bottom right, above the phone UI (9:16) or in the player margin (16:9). */
export function presenterBox(f: Frame): PresenterBox {
  const short = Math.min(f.w, f.h);
  const size = Math.round(short * (f.w > f.h ? 0.3 : 0.42));
  return { size, right: Math.round(f.safe.x * 0.8), bottom: Math.round(f.h - f.safe.bottom + short * 0.02) };
}

/** avatar.mp4 out of avatar_result.zip (or the file itself). */
export async function presenterSource(source: string, workDir: string): Promise<string> {
  if (/\.zip$/i.test(source)) {
    const { resultFiles } = await import("../avatar/import.ts");
    const files = await resultFiles(path.resolve(source));
    const v = files.get("avatar.mp4");
    if (!v) throw new Error(`в ${path.basename(source)} нет avatar.mp4`);
    await fs.mkdir(workDir, { recursive: true });
    const out = path.join(workDir, "avatar.mp4");
    await fs.writeFile(out, v);
    return out;
  }
  return path.resolve(source);
}

/**
 * The presenter clip: a centred square (a little above the middle, where a portrait's face is), scaled to `size`,
 * a circular alpha mask with a soft 2 px edge, padded/trimmed to `duration`, 30 fps, VP9 WebM with alpha, no sound.
 * Returns how far the source length was from the video's (a lip-sync drift warning above 0.3 s).
 */
export async function presenterClip(src: string, duration: number, out: string, size: number): Promise<{ drift: number }> {
  const probe = await ffprobe(src);
  const srcDur = Number(probe.format.duration) || 0;
  await fs.mkdir(path.dirname(out), { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-pres-"));
  try {
    const mask = path.join(tmp, "mask.png");
    const r = size / 2;
    // white disc on black, antialiased over the last 2 px
    await ffmpeg(["-f", "lavfi", "-i", `color=c=black:s=${size}x${size}:d=1,format=gray,geq=lum='255*clip((${r - 1}-hypot(X-${r - 0.5},Y-${r - 0.5}))/2+0.5,0,1)'`, "-frames:v", "1", mask]);
    const pad = Math.max(0, duration - srcDur);
    const vf = [
      `crop='min(iw,ih)':'min(iw,ih)':'(iw-min(iw,ih))/2':'max(0,(ih-min(iw,ih))/2-ih*0.06)'`,
      `scale=${size}:${size}:flags=lanczos`,
      "fps=30",
      ...(pad > 0.02 ? [`tpad=stop_mode=clone:stop_duration=${pad.toFixed(3)}`] : []),
      "format=yuva420p",
    ].join(",");
    await ffmpeg([
      "-i", src, "-loop", "1", "-i", mask,
      "-filter_complex", `[0:v]${vf}[v];[1:v]format=gray,scale=${size}:${size}[m];[v][m]alphamerge,format=yuva420p[out]`,
      "-map", "[out]", "-t", duration.toFixed(3), "-an",
      "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "1500k", "-deadline", "realtime", "-cpu-used", "6", "-row-mt", "1",
      out,
    ]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return { drift: Math.round(Math.abs(srcDur - duration) * 1000) / 1000 };
}
