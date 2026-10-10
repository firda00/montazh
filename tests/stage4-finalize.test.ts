import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe } from "../src/lib/ffmpeg.ts";
import { finalizeOutput, measureLoudness } from "../src/render/finalize.ts";

test("finalizeOutput muxes the overlay video with the rough cut's audio at -14 LUFS, trimmed to the rough length", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-fin-"));
  const rough = path.join(dir, "rough.mp4");
  const overlay = path.join(dir, "overlay.mp4");
  // rough: 3.0 s with a quiet (-30 dB) tone; overlay: video only, a bit longer (whole-frame rounding)
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-af", "volume=-30dB", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", rough,
  ]);
  await ffmpeg(["-f", "lavfi", "-i", "smptebars=size=320x180:rate=30:duration=3.2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", overlay]);
  const before = await measureLoudness(rough);
  assert.ok(before.input_i < -25, `rough is quiet (${before.input_i} LUFS)`);
  const r = await finalizeOutput(overlay, rough, path.join(dir, "output_x.mp4"), { previewAt: 1 });
  assert.ok(Math.abs(r.loudness_after - -14) < 1.5, `normalised to ${r.loudness_after} LUFS`);
  assert.equal(r.video_codec, "h264");
  assert.equal(r.audio_codec, "aac");
  assert.ok(Math.abs(r.duration - 3) < 0.15, `trimmed to the rough length (${r.duration}s)`);
  const probe = await ffprobe(r.output);
  assert.equal(probe.streams.filter((s) => s.codec_type === "audio").length, 1, "exactly one audio stream");
  assert.ok((await fs.stat(r.preview)).size > 1000, "preview jpeg written");
  await fs.rm(dir, { recursive: true, force: true });
});
