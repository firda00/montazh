import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ModelAnswerSchema, RESPONSE_SCHEMA, mapAnswer, type ModelAnswer } from "./gemini.ts";
import { fill, loadPrompt } from "../../lib/prompts.ts";
import type { AnalysisChunk, AnalysisContext, VisionProvider, VisionResult } from "./types.ts";

/**
 * Vision through the Antigravity CLI (`agy`): Google login, no API key, billed to the
 * subscription — the same arrangement as the planner through the Claude Code login.
 *
 * The CLI cannot take images on stdin, so the agent is asked to open the shot frames the
 * understand step already extracted (frames/shot_NNN.jpg) with its own file viewer and to
 * answer with JSON enforced by --json-schema. One call per chunk.
 */

/** The cheapest video-capable entry of `agy models` at the time of writing. Override with VEDIT_VISION_MODEL. */
export const DEFAULT_AGY_MODEL = "gemini-3.8-flash-low";

export interface AgyRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}
export type AgyRunner = (args: string[], stdin: string, cwd: string) => Promise<AgyRunResult>;

export interface AgyOptions {
  bin?: string;
  model?: string;
  timeoutMs?: number;
  /** injectable for tests */
  run?: AgyRunner;
  /** directory for the temporary schema file (default: os tmpdir) */
  tmpDir?: string;
}

/** Looks for the CLI binary on PATH (Windows: agy.exe / agy.cmd). */
export async function findAgy(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.VEDIT_AGY_BIN?.trim()) return env.VEDIT_AGY_BIN.trim();
  const names = process.platform === "win32" ? ["agy.exe", "agy.cmd", "agy"] : ["agy"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try {
        await fs.access(p);
        return p;
      } catch {}
    }
  }
  return null;
}

/** Gemini's responseSchema → plain JSON Schema (no propertyOrdering; nullable → type union). */
export function toJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toJsonSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "propertyOrdering" || k === "nullable") continue;
    out[k] = toJsonSchema(v);
  }
  if ((node as { nullable?: boolean }).nullable && typeof out.type === "string") out.type = [out.type, "null"];
  return out;
}

export const AGY_JSON_SCHEMA = toJsonSchema(RESPONSE_SCHEMA) as Record<string, unknown>;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function buildAgyPrompt(chunk: AnalysisChunk, ctx: AnalysisContext, frames: { index: number; rel: string }[]): string {
  const len = chunk.end - chunk.start;
  const rel = (t: number) => r2(Math.min(len, Math.max(0, t - chunk.start)));
  const shots = chunk.shots
    .map((s) => {
      const f = frames.find((x) => x.index === s.index);
      return `  shot ${s.index}: ${rel(s.start)}-${rel(s.end)}s${f ? `, frame: ${f.rel}` : ", (no frame)"}`;
    })
    .join("\n");
  const phrases = chunk.phrases.map((p) => `  ${rel(p.start)}-${rel(p.end)}s: ${p.text}`).join("\n");
  return fill(loadPrompt("vision.agy.user"), { len: r2(len), start: r2(chunk.start), width: ctx.media.width, height: ctx.media.height, language: ctx.language, shots: shots || "  (none)", transcript: phrases || "  (no speech)" });
}

/** The CLI's final line in stream-json mode. */
interface AgyResult {
  status?: string;
  response?: string;
  error?: string;
  usage?: { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number };
  duration_seconds?: number;
  structured_output?: unknown;
}

export function parseAgyStream(stdout: string): AgyResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]) as { event?: string; result?: AgyResult; status?: string; response?: string };
      if (ev.event === "result" && ev.result) return ev.result;
      if (ev.status && typeof ev.response === "string") return ev; // plain --output-format json
    } catch {}
  }
  throw new AgyError(`agy: no result line in the output:\n${stdout.slice(-800)}`);
}

/** Pulls the JSON object out of a response that may be wrapped in prose or fences. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {}
  const fenced = [...t.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1].trim());
  for (const f of fenced.reverse()) {
    try {
      return JSON.parse(f);
    } catch {}
  }
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {}
  }
  throw new AgyError(`agy: the answer is not JSON:\n${t.slice(0, 400)}`);
}

export class AgyError extends Error {}

export const defaultAgyRunner =
  (bin: string, timeoutMs: number): AgyRunner =>
  (args, stdin, cwd) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new AgyError(`agy: no answer within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => (clearTimeout(timer), reject(new AgyError(`agy failed to start: ${err.message}`))));
      child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
      child.stdin.end(stdin);
    });

export class AgyVisionProvider implements VisionProvider {
  readonly name = "antigravity-cli";
  readonly model: string;
  private readonly run: AgyRunner;
  private readonly tmpDir: string;

  constructor(opts: AgyOptions = {}) {
    this.model = opts.model ?? DEFAULT_AGY_MODEL;
    this.tmpDir = opts.tmpDir ?? os.tmpdir();
    this.run = opts.run ?? defaultAgyRunner(opts.bin ?? "agy", opts.timeoutMs ?? 900_000);
  }

  async analyze(chunk: AnalysisChunk, ctx: AnalysisContext): Promise<VisionResult> {
    const withFrames = chunk.shots.filter((s) => s.frame);
    if (!withFrames.length) throw new AgyError("agy: no shot frames to look at (extractShotFrames did not run)");
    // the agent works relative to the frames directory, so paths in the prompt stay short and inside its workspace
    const cwd = path.dirname(withFrames[0].frame!);
    const frames = withFrames.map((s) => ({ index: s.index, rel: path.relative(cwd, s.frame!).split(path.sep).join("/") }));
    const schemaFile = path.join(this.tmpDir, `vedit-agy-schema-${process.pid}-${Date.now()}-${chunk.index}.json`);
    await fs.writeFile(schemaFile, JSON.stringify(AGY_JSON_SCHEMA));
    const t0 = Date.now();
    try {
      const prompt = buildAgyPrompt(chunk, ctx, frames);
      const stdin = JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n";
      const args = ["--model", this.model, "--input-format", "stream-json", "--output-format", "stream-json", "--json-schema", schemaFile, "--disable-slash-commands", "--print", ""];
      const r = await this.run(args, stdin, cwd);
      const result = parseAgyStream(r.stdout || r.stderr);
      if (result.status !== "SUCCESS") throw new AgyError(`agy: ${result.status ?? `exit ${r.code}`}: ${result.error ?? r.stderr.slice(-400)}`);
      let parsed: ModelAnswer;
      try {
        // the CLI validates against --json-schema itself and echoes the object as structured_output
        const raw = result.structured_output && typeof result.structured_output === "object" ? result.structured_output : extractJson(result.response ?? "");
        parsed = ModelAnswerSchema.parse(raw);
      } catch (err) {
        throw new AgyError(`agy: answer does not match the schema: ${err instanceof Error ? err.message : err}`);
      }
      const u = result.usage ?? {};
      return {
        ...mapAnswer(parsed, chunk),
        cost: {
          model: this.model,
          usd: 0, // subscription: the CLI reports tokens but no price
          units: {
            chunk_seconds: r2(chunk.end - chunk.start),
            frames: frames.length,
            input_tokens: u.input_tokens ?? 0,
            output_tokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0),
            wall_seconds: r2(result.duration_seconds ?? (Date.now() - t0) / 1000),
            subscription: 1,
          },
        },
      };
    } finally {
      await fs.rm(schemaFile, { force: true }).catch(() => {});
    }
  }
}
