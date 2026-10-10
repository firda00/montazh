// Demo helper: renders a contact sheet with the first and last frame of every clip in
// each output, so cut accuracy can be checked against the burned-in source timecode.
import path from "node:path";
import fs from "node:fs/promises";
import { ffmpeg } from "../src/lib/ffmpeg.ts";
import { jobDir, readJson } from "../src/lib/workspace.ts";
import { EdlSchema, MediaSchema } from "../src/schemas/index.ts";
import { sanitizeClips } from "../src/cut/index.ts";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: tsx tests/contact-sheet.ts <job_id>");
const dir = jobDir(jobId);
const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
const media = await readJson(path.join(dir, "media.json"), MediaSchema);
const frame = 1 / media.fps; // "end" frames are sampled 0.1s early: ffmpeg cannot seek onto the final frame

for (const out of edl.outputs) {
  const rough = path.join(dir, `rough_${out.id}.mp4`);
  const { clips } = sanitizeClips(out.clips, media);
  const times: number[] = [];
  let t = 0;
  for (const c of clips) {
    const len = (c.src_end - c.src_start) / c.speed;
    times.push(t, t + len - Math.max(frame, 0.1));
    t += len;
  }
  const tmp = path.join(dir, `_sheet_${out.id}`);
  await fs.mkdir(tmp, { recursive: true });
  const frames: string[] = [];
  for (const [i, at] of times.entries()) {
    const f = path.join(tmp, `${i}.png`);
    await ffmpeg(["-ss", at.toFixed(3), "-i", rough, "-frames:v", "1", "-vf", "scale=-2:360,pad=iw+8:ih:0:0:white", f]);
    frames.push(f);
  }
  const sheet = path.join(dir, `sheet_${out.id}.png`);
  const inputs = frames.flatMap((f) => ["-i", f]);
  const stack = frames.length > 1 ? `${frames.map((_, i) => `[${i}]`).join("")}hstack=${frames.length}` : "null";
  await ffmpeg([...inputs, "-filter_complex", stack, "-frames:v", "1", sheet]);
  await fs.rm(tmp, { recursive: true });
  console.log(sheet);
}
