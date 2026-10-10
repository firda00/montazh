import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../src/lib/ffmpeg.ts";
import { finalizeOutput, measureLoudness } from "../src/render/finalize.ts";

test("finalizeOutput normalises loudness to -14 LUFS, keeps the video stream and writes a preview", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-fin-"));
  const src = path.join(dir, "quiet.mp4");
  // 3 s clip with a quiet (-30 dB) tone so there is something to normalise
  await ffmpeg([
    "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3",
    "-af", "volume=-30dB", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src,
  ]);
  const before = await measureLoudness(src);
  assert.ok(before.input_i < -25, `source is quiet (${before.input_i} LUFS)`);
  const r = await finalizeOutput(src, path.join(dir, "output_x.mp4"), { previewAt: 1 });
  assert.ok(Math.abs(r.loudness_after - -14) < 1.5, `normalised to ${r.loudness_after} LUFS`);
  assert.equal(r.video_codec, "h264");
  assert.equal(r.audio_codec, "aac");
  assert.ok(Math.abs(r.duration - 3) < 0.2);
  assert.ok((await fs.stat(r.preview)).size > 1000, "preview jpeg written");
  await fs.rm(dir, { recursive: true, force: true });
});
