import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { AgyError, defaultAgyRunner, findAgy, parseAgyStream, type AgyRunner } from "../understand/vision/agy.ts";

/**
 * Scene images without an API key: one Antigravity CLI call asks its image tool for every image
 * the design needs (~60–120 s for 2–4 images), each saved as scene_<beat>.png in a scratch dir.
 * The images are then normalised to 1080×1920 JPEG (cover crop) for the composition. A missing
 * image is not fatal: the scene falls back to a typographic layout.
 */

export interface ImageRequest {
  beat: number;
  prompt: string;
}

export interface ImageResult {
  /** beat → absolute path of the 1080×1920 JPEG */
  files: Map<number, string>;
  missing: number[];
  wall_seconds: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface ImageOptions {
  style: string;
  model?: string;
  bin?: string;
  run?: AgyRunner;
  timeoutMs?: number;
  /** test hook: produce images without agy */
  generate?: (requests: ImageRequest[], dir: string) => Promise<void>;
}

const fileName = (beat: number) => `scene_${beat}.png`;

export async function generateImages(requests: ImageRequest[], outDir: string, o: ImageOptions): Promise<ImageResult> {
  const t0 = Date.now();
  await fs.mkdir(outDir, { recursive: true });
  const files = new Map<number, string>();
  if (!requests.length) return { files, missing: [], wall_seconds: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "none" };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-img-"));
  let usage = { input_tokens: 0, output_tokens: 0 };
  const model = o.model ?? "gemini-3.8-flash-low";
  try {
    if (o.generate) await o.generate(requests, work);
    else {
      const bin = o.bin ?? (await findAgy());
      if (!bin && !o.run) throw new AgyError("images: Antigravity CLI (agy) не найден");
      const run = o.run ?? defaultAgyRunner(bin!, o.timeoutMs ?? 900_000);
      const list = requests.map((r) => `${fileName(r.beat)}: ${r.prompt.replace(/\s+/g, " ").trim()}`).join("\n");
      const prompt = fill(loadPrompt("make.images.user"), { style: o.style, list });
      const stdin = JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n";
      const r = await run(["--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--print", ""], stdin, work);
      const result = parseAgyStream(r.stdout || r.stderr);
      if (result.status !== "SUCCESS") throw new AgyError(`images: ${result.status ?? `exit ${r.code}`}: ${result.error ?? r.stderr.slice(-300)}`);
      const u = result.usage ?? {};
      usage = { input_tokens: u.input_tokens ?? 0, output_tokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) };
      // the image subagent can finish a moment after the main answer: wait briefly for stragglers
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const present = await Promise.all(requests.map((q) => fs.access(path.join(work, fileName(q.beat))).then(() => true, () => false)));
        if (present.every(Boolean)) break;
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    const missing: number[] = [];
    for (const q of requests) {
      const src = await findImage(work, q.beat);
      if (!src) {
        missing.push(q.beat);
        continue;
      }
      const dest = path.join(outDir, `scene_${q.beat}.jpg`);
      try {
        await ffmpeg(["-i", src, "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920", "-q:v", "3", dest]);
        files.set(q.beat, dest);
      } catch {
        missing.push(q.beat);
      }
    }
    return { files, missing, wall_seconds: Math.round((Date.now() - t0) / 100) / 10, usage, model };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** The agent may save .png, .jpg or .webp, or keep the name with a different case. */
async function findImage(dir: string, beat: number): Promise<string | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const hit = names.find((n) => new RegExp(`^scene_${beat}\\.(png|jpe?g|webp)$`, "i").test(n));
  return hit ? path.join(dir, hit) : null;
}
