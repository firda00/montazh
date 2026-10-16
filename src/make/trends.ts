import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { AgyError, defaultAgyRunner, extractJson, parseAgyStream, type AgyRunner } from "../understand/vision/agy.ts";
import { findAgy } from "../understand/vision/agy.ts";
import { LANGUAGE_NAMES } from "./script.ts";

/**
 * Trend research. Two backends:
 *   agy            — without an API key: the Antigravity CLI agent searches the web and reads pages (its own
 *                    tools) and answers with JSON. ~60–120 s. Used whenever agy is installed (dev laptop).
 *   gemini-search  — with GEMINI_API_KEY only (server mode, no agy): Gemini + Google Search grounding,
 *                    src/make/trends-gemini.ts. Same TrendsSchema; fact sources from the grounding citations.
 */

export const TrendsSchema = z.object({
  facts: z.array(z.object({ text: z.string(), source: z.string().default("") })).default([]),
  angles: z.array(z.string()).default([]),
  hooks: z.array(z.string()).default([]),
  avoid: z.array(z.string()).default([]),
});
export type Trends = z.infer<typeof TrendsSchema>;

const JSON_SCHEMA = {
  type: "object",
  properties: {
    facts: { type: "array", items: { type: "object", properties: { text: { type: "string" }, source: { type: "string" } }, required: ["text", "source"] } },
    angles: { type: "array", items: { type: "string" } },
    hooks: { type: "array", items: { type: "string" } },
    avoid: { type: "array", items: { type: "string" } },
  },
  required: ["facts", "angles", "hooks", "avoid"],
};

export interface TrendsOptions {
  language?: string;
  /** Gemini grounding options (server mode / no agy): key, models, fetch for tests */
  gemini?: import("./trends-gemini.ts").GeminiTrendsOptions;
  model?: string;
  bin?: string;
  run?: AgyRunner;
  tmpDir?: string;
  timeoutMs?: number;
}

export interface TrendsResult {
  trends: Trends;
  wall_seconds: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  /** which backend answered (default agy) */
  provider?: "agy" | "gemini-search";
  /** API cost; agy runs on the subscription ($0) */
  usd?: number;
}

/** Which trends backend this machine has: agy (never in server mode), else Gemini with a key, else none. */
export async function trendsBackend(env: NodeJS.ProcessEnv = process.env): Promise<"agy" | "gemini-search" | null> {
  if (await findAgy(env)) return "agy";
  if ((env.GEMINI_API_KEY || env.GOOGLE_API_KEY || "").trim()) return "gemini-search";
  return null;
}

export async function researchTrends(topic: string, opts: TrendsOptions = {}): Promise<TrendsResult> {
  const bin = opts.bin ?? (await findAgy());
  if (!bin && !opts.run) {
    if (opts.gemini?.key || (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim()) {
      const { researchTrendsGemini } = await import("./trends-gemini.ts");
      return researchTrendsGemini(topic, { language: opts.language, ...opts.gemini });
    }
    throw new AgyError("trends: нет Antigravity CLI (agy) и нет GEMINI_API_KEY — исследование трендов недоступно, запустите с --no-trends");
  }
  const model = opts.model ?? "gemini-3.8-flash-medium";
  const run = opts.run ?? defaultAgyRunner(bin!, opts.timeoutMs ?? 600_000);
  const language = LANGUAGE_NAMES[opts.language ?? "ru"] ?? opts.language ?? "Russian";
  const tmp = opts.tmpDir ?? os.tmpdir();
  const cwd = await fs.mkdtemp(path.join(tmp, "vedit-trends-"));
  const schemaFile = path.join(cwd, "schema.json");
  await fs.writeFile(schemaFile, JSON.stringify(JSON_SCHEMA));
  const t0 = Date.now();
  try {
    const prompt = fill(loadPrompt("make.trends.user"), { topic, language });
    const stdin = JSON.stringify({ event: "user", message: { role: "user", content: [{ type: "text", text: prompt }] } }) + "\n";
    const args = ["--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--json-schema", schemaFile, "--disable-slash-commands", "--print", ""];
    const r = await run(args, stdin, cwd);
    const result = parseAgyStream(r.stdout || r.stderr);
    if (result.status !== "SUCCESS") throw new AgyError(`trends: ${result.status ?? `exit ${r.code}`}: ${result.error ?? r.stderr.slice(-300)}`);
    const raw = result.structured_output && typeof result.structured_output === "object" ? result.structured_output : extractJson(result.response ?? "");
    const trends = TrendsSchema.parse(raw);
    const u = result.usage ?? {};
    return { trends, wall_seconds: Math.round(((result.duration_seconds ?? (Date.now() - t0) / 1000) + Number.EPSILON) * 10) / 10, usage: { input_tokens: u.input_tokens ?? 0, output_tokens: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0) }, model, provider: "agy", usd: 0 };
  } finally {
    await fs.rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}

/** The TREND NOTES block the script writer gets. */
export function trendsText(t: Trends): string {
  const lines = ["TREND NOTES (this week; take facts only from here):"];
  for (const f of t.facts.slice(0, 10)) lines.push(`- fact: ${f.text}${f.source ? ` [${f.source}]` : ""}`);
  for (const a of t.angles.slice(0, 6)) lines.push(`- angle: ${a}`);
  for (const h of t.hooks.slice(0, 5)) lines.push(`- hook: ${h}`);
  for (const a of t.avoid.slice(0, 5)) lines.push(`- avoid: ${a}`);
  return lines.join("\n");
}
