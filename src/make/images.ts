import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { AgyError, defaultAgyRunner, findAgy, parseAgyStream, type AgyRunner } from "../understand/vision/agy.ts";
import { frameFor, type Frame } from "../lib/aspect.ts";

/**
 * Scene images. Backends: agy when installed (dev laptop, $0 on the subscription), else the Gemini image
 * model over the API with GEMINI_API_KEY (server mode: src/make/images-gemini.ts, paid per image, no free tier).
 *
 * agy: without an API key: one Antigravity CLI call asks its image tool for every image
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
  /** which backend made them (for the cost log) */
  provider: "antigravity-cli" | "gemini-image" | "test" | "none";
  /** API cost ($0 for agy) */
  usd: number;
}

/** Which image generator this machine has: agy (never in server mode), else Gemini with a key, else none. */
export async function imageBackend(env: NodeJS.ProcessEnv = process.env): Promise<"agy" | "gemini-image" | null> {
  if (await findAgy(env)) return "agy";
  if ((env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim()) return "gemini-image";
  return null;
}

export interface ImageOptions {
  style: string;
  /** output frame (default 9:16, 1080×1920) */
  frame?: Frame;
  model?: string;
  bin?: string;
  run?: AgyRunner;
  timeoutMs?: number;
  /** test hook: produce images without agy */
  generate?: (requests: ImageRequest[], dir: string) => Promise<void>;
  /** Gemini image API options (no agy): key, models, fetch for tests */
  gemini?: import("./images-gemini.ts").GeminiImageOptions;
}

const fileName = (beat: number) => `scene_${beat}.png`;

export async function generateImages(requests: ImageRequest[], outDir: string, o: ImageOptions): Promise<ImageResult> {
  const t0 = Date.now();
  await fs.mkdir(outDir, { recursive: true });
  const files = new Map<number, string>();
  if (!requests.length) return { files, missing: [], wall_seconds: 0, usage: { input_tokens: 0, output_tokens: 0 }, model: "none", provider: "none", usd: 0 };
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-img-"));
  let usage = { input_tokens: 0, output_tokens: 0 };
  let model = o.model ?? "gemini-3.8-flash-low";
  let provider: ImageResult["provider"] = o.generate ? "test" : "antigravity-cli";
  let usd = 0;
  const f = o.frame ?? frameFor("9:16");
  const frameWords = f.w > f.h ? "horizontal 16:9" : f.w === f.h ? "square 1:1" : "vertical 9:16";
  try {
    const bin = o.generate ? null : (o.bin ?? (await findAgy()));
    if (o.generate) await o.generate(requests, work);
    else if (!bin && !o.run) {
      // no agy (server mode): the Gemini image model over the API
      if (!o.gemini?.key && !(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim()) throw new AgyError("images: нет Antigravity CLI (agy) и нет GEMINI_API_KEY");
      const { generateImagesGemini } = await import("./images-gemini.ts");
      const aspect = f.w > f.h ? "16:9" : f.w === f.h ? "1:1" : "9:16";
      const g = await generateImagesGemini(requests, work, { ...o.gemini, style: o.style, aspect, frameWords });
      provider = "gemini-image";
      model = g.model;
      usd = g.usd;
      usage = g.usage;
    } else {
      const run = o.run ?? defaultAgyRunner(bin!, o.timeoutMs ?? 900_000);
      const list = requests.map((r) => `${fileName(r.beat)}: ${r.prompt.replace(/\s+/g, " ").trim()}`).join("\n");
      const prompt = fill(loadPrompt("make.images.user"), { style: o.style, list, frame: frameWords });
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
        await ffmpeg(["-i", src, "-vf", `scale=${f.w}:${f.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${f.w}:${f.h}`, "-q:v", "3", dest]);
        files.set(q.beat, dest);
      } catch {
        missing.push(q.beat);
      }
    }
    return { files, missing, wall_seconds: Math.round((Date.now() - t0) / 100) / 10, usage, model, provider, usd };
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
