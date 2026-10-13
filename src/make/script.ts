import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { ICONS_DIR } from "./icons.ts";

/** A beat is one screen: a sentence, an icon, how long it stays. */
export const BeatSchema = z.object({
  text: z.string().min(1).max(140),
  emphasis: z.string().default(""),
  icon: z.string().default("sparkles"),
  seconds: z.number().min(2).max(10).default(4),
});
export const ScriptSchema = z.object({
  title: z.string().min(1).max(60),
  language: z.string().default("ru"),
  beats: z.array(BeatSchema).min(3).max(9),
  hashtags: z.array(z.string()).default([]),
});
export type Script = z.infer<typeof ScriptSchema>;
export type Beat = z.infer<typeof BeatSchema>;

/** What the model must return (hook = beats[0], call to action = last beat). */
const ScriptOutSchema = z.object({
  title: z.string(),
  language: z.string(),
  beats: z.array(z.object({ text: z.string(), emphasis: z.string(), icon: z.string(), seconds: z.number() })),
  hashtags: z.array(z.string()),
});

export const LANGUAGE_NAMES: Record<string, string> = { ru: "Russian", uz: "Uzbek (Latin script)", en: "English", kk: "Kazakh", tr: "Turkish" };

export interface ScriptOptions {
  language?: string;
  seconds?: number;
  audience?: string;
  /** TREND NOTES block (from trends.ts), already formatted */
  trendsText?: string;
  model?: string;
}

/** Beats for a target length: ~5 s per beat, 4..8. */
export function beatsFor(seconds: number): number {
  return Math.max(4, Math.min(8, Math.round(seconds / 5)));
}

/** Reading-speed floor: a beat stays at least long enough to read (≈2.6 words/s plus settle time). */
export function beatSeconds(text: string, asked: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const floor = Math.round((words / 2.6 + 1.0) * 10) / 10;
  return Math.min(10, Math.max(2.5, Math.max(asked, floor)));
}

/** Lucide icon name → exists? (lowercase, hyphens); fallback "sparkles". */
export async function resolveIcon(name: string, dir = ICONS_DIR): Promise<string> {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  try {
    await fs.access(path.join(dir, `${n}.svg`));
    return n;
  } catch {
    return "sparkles";
  }
}

/** Normalises a model answer: durations by reading speed, icons that exist, emphasis that is really in the text. */
export async function normalizeScript(raw: unknown, opts: ScriptOptions = {}): Promise<Script> {
  const out = ScriptOutSchema.parse(raw);
  const beats: Beat[] = [];
  for (const b of out.beats) {
    const text = b.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const emphasis = text.toLowerCase().includes(b.emphasis.trim().toLowerCase()) && b.emphasis.trim() ? b.emphasis.trim() : "";
    beats.push({ text, emphasis, icon: await resolveIcon(b.icon), seconds: beatSeconds(text, b.seconds) });
  }
  return ScriptSchema.parse({
    title: out.title.replace(/\s+/g, " ").trim().slice(0, 60),
    language: out.language || opts.language || "ru",
    beats,
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).slice(0, 6),
  });
}

export interface ScriptResult {
  script: Script;
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: string;
  estimate: boolean;
}

export async function writeScript(topic: string, llm: StructuredFn, opts: ScriptOptions = {}): Promise<ScriptResult> {
  const language = opts.language ?? "ru";
  const seconds = opts.seconds ?? 35;
  const prompt = fill(loadPrompt("make.script.user"), {
    topic,
    language: LANGUAGE_NAMES[language] ?? language,
    seconds,
    beats: beatsFor(seconds),
    audience: opts.audience ?? "people scrolling Reels/Shorts on their phone",
    trends: opts.trendsText ? `\n${opts.trendsText}\n` : "",
  });
  const res = await llm({ system: loadPrompt("make.script.system"), prompt, schema: zodToApiSchema(ScriptOutSchema), model: opts.model, effort: "medium", maxTokens: 4000 });
  const script = await normalizeScript(res.data, { language });
  return { script, usd: res.usd, usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, model: res.model, provider: res.provider, estimate: res.estimate };
}

export function scriptDuration(s: Script): number {
  return Math.round(s.beats.reduce((n, b) => n + b.seconds, 0) * 100) / 100;
}
