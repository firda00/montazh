// Stage 28: the AI critic. After a job is delivered, Gemini watches a 480p copy of every output (Files API, the upload
// is deleted right after) and grades it 1–5 on the criteria of docs/reference-reels-analysis.md: hook, visual relevance,
// dynamics, captions, audio, text accuracy, overall — plus three concrete fixes. Frugal by design: one request per
// output, a cheap model first (gemini-3.5-flash-lite → 3.6-flash), no extra rounds when the models are busy, results
// cached by the output's content hash (workspace/_cache/review/<hash>.json), quota errors are a quiet skip.
// runSelfReview never throws: the bot calls it in the background and only stores what comes back.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ffmpeg, ffprobe, isVideoStream, parseRate } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { exists, WORKSPACE_ROOT } from "../lib/workspace.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { GeminiError, priceUsage, type GeminiUsage } from "../understand/vision/gemini.ts";

export const REVIEW_CRITERIA = ["hook", "visual_relevance", "dynamics", "captions", "audio", "text_accuracy"] as const;
export type ReviewCriterion = (typeof REVIEW_CRITERIA)[number];
export type ReviewKey = ReviewCriterion | "overall";

/** cheapest first; a model without quota / not found is skipped (VEDIT_REVIEW_MODEL: a comma list) */
export const DEFAULT_REVIEW_MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-flash-lite-latest"];
/** bump when the prompt or the schema changes: old cache entries are ignored */
export const REVIEW_VERSION = 1;
/** seconds of the output the critic watches */
export const REVIEW_MAX_SECONDS = 180;
/** short side of the copy sent to Gemini */
export const REVIEW_SHORT_SIDE = 480;

/** $ per 1M tokens, paid tier (the free tier costs $0); unknown models fall back to the vision price table */
const REVIEW_PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.5-flash-lite": { in: 0.3, out: 2.5 },
  "gemini-flash-lite-latest": { in: 0.3, out: 2.5 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
};

export function reviewPrice(model: string, u: GeminiUsage): number {
  const p = REVIEW_PRICES[model];
  if (!p) return priceUsage(model, u).usd;
  return ((u.promptTokenCount ?? 0) * p.in + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * p.out) / 1e6;
}

const clampScore = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(5, Math.max(1, Math.round(v))) : 3;
};
const ScoreSchema = z.object({ score: z.unknown().transform(clampScore), reason: z.string().default("") });
export const ReviewSchema = z.object({
  scores: z.object({
    hook: ScoreSchema,
    visual_relevance: ScoreSchema,
    dynamics: ScoreSchema,
    captions: ScoreSchema,
    audio: ScoreSchema,
    text_accuracy: ScoreSchema,
    overall: ScoreSchema,
  }),
  fixes: z
    .array(z.string())
    .default([])
    .transform((xs) => xs.map((s) => s.trim()).filter(Boolean).slice(0, 3)),
  summary: z.string().default(""),
  confidence: z
    .unknown()
    .transform((n) => (Number.isFinite(Number(n)) ? Math.min(1, Math.max(0, Number(n))) : 0.5))
    .default(0.5),
});
export type Review = z.infer<typeof ReviewSchema>;

const scoreSchema = { type: "OBJECT", properties: { score: { type: "INTEGER" }, reason: { type: "STRING" } }, required: ["score", "reason"] };
export const REVIEW_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    scores: {
      type: "OBJECT",
      properties: Object.fromEntries([...REVIEW_CRITERIA, "overall"].map((k) => [k, scoreSchema])),
      required: [...REVIEW_CRITERIA, "overall"],
    },
    fixes: { type: "ARRAY", items: { type: "STRING" } },
    summary: { type: "STRING" },
    confidence: { type: "NUMBER" },
  },
  required: ["scores", "fixes", "summary", "confidence"],
};

/** a Gemini answer → the review (scores clamped to 1–5, three fixes at most); throws on a wrong shape */
export function parseReview(data: unknown): Review {
  const r = ReviewSchema.safeParse(data);
  if (!r.success) throw new Error(`ответ критика не по схеме: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

export interface SelfReviewContext {
  /** montage | highlights | reference | make | avatar | revise */
  kind?: string;
  /** what the user asked for (instruction / topic) */
  task?: string;
  /** caption preset / style */
  style?: string;
  duration?: number;
  aspect?: string;
}

export type SelfReviewResult =
  | { status: "ok"; review: Review; model: string; usage: GeminiUsage; cost_usd: number; hash: string; cached: boolean; seconds: number }
  | { status: "skipped" | "failed"; reason: string; hash?: string; cost_usd: 0 };

export type SelfReviewFn = (file: string, ctx: SelfReviewContext) => Promise<SelfReviewResult>;

export interface SelfReviewOptions {
  apiKey?: string;
  models?: string[];
  fetchFn?: typeof fetch;
  /** makes the reduced copy (default ffmpeg 480p); tests inject a copy */
  prepare?: (file: string, out: string) => Promise<void>;
  /** default workspace/_cache/review; null = no cache */
  cacheDir?: string | null;
  env?: NodeJS.ProcessEnv;
  onLog?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  tmpDir?: string;
}

/** VEDIT_SELF_REVIEW=on|off (default on) */
export function selfReviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.VEDIT_SELF_REVIEW?.trim() ?? "");
}

export function reviewModels(env: NodeJS.ProcessEnv = process.env): string[] {
  const own = (env.VEDIT_REVIEW_MODEL ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return own.length ? own : DEFAULT_REVIEW_MODELS;
}

/** content hash of a file (sha256, 24 hex) — the cache key: the same output is never reviewed twice */
export function fileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (b) => h.update(b))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex").slice(0, 24)));
  });
}

/** ≤ 180 s, short side 480 px, ≤ 24 fps, mono AAC 64k — captions stay legible, the upload is a few MB */
export async function reviewCopy(file: string, out: string): Promise<void> {
  const probe = await ffprobe(file);
  const v = probe.streams.find(isVideoStream);
  if (!v) throw new Error("в файле нет видео");
  const portrait = (v.height ?? 0) >= (v.width ?? 0);
  const scale = portrait ? `scale=${REVIEW_SHORT_SIDE}:-2` : `scale=-2:${REVIEW_SHORT_SIDE}`;
  const fps = Math.min(24, parseRate(v.avg_frame_rate ?? v.r_frame_rate) || 24);
  const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
  await ffmpeg(["-t", String(REVIEW_MAX_SECONDS), "-i", file, "-vf", `${scale},fps=${fps}`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-threads", "2", ...(hasAudio ? ["-c:a", "aac", "-b:a", "64k", "-ac", "1"] : ["-an"]), "-movflags", "+faststart", out]);
}

const QUOTA = /quota|RESOURCE_EXHAUSTED|rate.?limit|limit:\s*0|PerDay|billing|free[ _-]?tier/i;

/** quota / rate-limit errors are a skip (tomorrow it works again), anything else a failure */
export function classifyReviewError(err: unknown): "skipped" | "failed" {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof GeminiError && err.status === 429) return "skipped";
  return QUOTA.test(msg) ? "skipped" : "failed";
}

interface CacheEntry {
  version: number;
  review: Review;
  model: string;
  usage: GeminiUsage;
  cost_usd: number;
  created_at: string;
}

async function readCache(dir: string, hash: string): Promise<CacheEntry | undefined> {
  try {
    const e = JSON.parse(await fs.readFile(path.join(dir, `${hash}.json`), "utf8")) as CacheEntry;
    if (e.version !== REVIEW_VERSION) return undefined;
    return { ...e, review: parseReview(e.review) };
  } catch {
    return undefined;
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export async function runSelfReview(file: string, ctx: SelfReviewContext = {}, o: SelfReviewOptions = {}): Promise<SelfReviewResult> {
  const env = o.env ?? process.env;
  const log = o.onLog ?? (() => {});
  if (!selfReviewEnabled(env)) return { status: "skipped", reason: "VEDIT_SELF_REVIEW=off", cost_usd: 0 };
  const apiKey = o.apiKey ?? env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY;
  if (!apiKey) return { status: "skipped", reason: "нет GEMINI_API_KEY", cost_usd: 0 };
  let hash: string | undefined;
  const t0 = Date.now();
  let tmp: string | undefined;
  try {
    if (!(await exists(file))) return { status: "failed", reason: `нет файла ${file}`, cost_usd: 0 };
    hash = await fileHash(file);
    const cacheDir = o.cacheDir === null ? null : (o.cacheDir ?? path.join(WORKSPACE_ROOT, "_cache", "review"));
    if (cacheDir) {
      const hit = await readCache(cacheDir, hash);
      if (hit) {
        log(`самопроверка: из кэша (${hash})`);
        return { status: "ok", review: hit.review, model: hit.model, usage: hit.usage, cost_usd: 0, hash, cached: true, seconds: 0 };
      }
    }
    tmp = await fs.mkdtemp(path.join(o.tmpDir ?? os.tmpdir(), "vedit-review-"));
    const copy = path.join(tmp, "review.mp4");
    await (o.prepare ?? reviewCopy)(file, copy);
    const client = new GeminiClient({ apiKey, fetchFn: o.fetchFn, onLog: log, maxRetries: 2, backoffMs: 5000, rounds: 0, roundWaitMs: 0, sleep: o.sleep, timeoutMs: 180_000 });
    const uploaded = await client.upload(copy, "video/mp4", "vedit-self-review.mp4");
    let g;
    try {
      const fps = Number(env.VEDIT_REVIEW_FPS) > 0 ? Number(env.VEDIT_REVIEW_FPS) : 1;
      const res = env.VEDIT_REVIEW_RESOLUTION?.trim().toLowerCase();
      const user = fill(loadPrompt("review.user"), {
        kind: ctx.kind ?? "—",
        task: (ctx.task ?? "—").replace(/\s+/g, " ").slice(0, 600),
        style: ctx.style ?? "—",
        duration: ctx.duration ? r2(ctx.duration) : "?",
        aspect: ctx.aspect ?? "?",
      });
      g = await client.generate(o.models ?? reviewModels(env), {
        system: loadPrompt("review.system"),
        parts: [{ file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri }, video_metadata: { fps } }, { text: user }],
        schema: REVIEW_RESPONSE_SCHEMA,
        temperature: 0.2,
        rounds: 0,
        ...(res === "low" || res === "medium" || res === "high" ? { mediaResolution: res } : {}),
      });
    } finally {
      await client.remove(uploaded.name);
    }
    const review = parseReview(g.data);
    const cost = Math.round(reviewPrice(g.model, g.usage) * 1e6) / 1e6;
    if (cacheDir) {
      await fs.mkdir(cacheDir, { recursive: true });
      const entry: CacheEntry = { version: REVIEW_VERSION, review, model: g.model, usage: g.usage, cost_usd: cost, created_at: new Date().toISOString() };
      await fs.writeFile(path.join(cacheDir, `${hash}.json`), JSON.stringify(entry, null, 2));
    }
    const seconds = r2((Date.now() - t0) / 1000);
    log(`самопроверка: ${g.model}, общая ${review.scores.overall.score}/5, ${g.usage.promptTokenCount ?? 0}+${(g.usage.candidatesTokenCount ?? 0) + (g.usage.thoughtsTokenCount ?? 0)} ток., $${cost.toFixed(4)}, ${seconds} с`);
    return { status: "ok", review, model: g.model, usage: g.usage, cost_usd: cost, hash, cached: false, seconds };
  } catch (err) {
    const status = classifyReviewError(err);
    const reason = (err instanceof Error ? err.message : String(err)).split("\n")[0].slice(0, 300);
    log(`самопроверка ${status === "skipped" ? "пропущена" : "не удалась"}: ${reason}`);
    return { status, reason, hash, cost_usd: 0 };
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── the critic vs the user ─────────────────────────────────────────────────────

/** which user reason codes (the 1–3★ chips) each criterion explains */
export const CRITERION_REASONS: Record<ReviewCriterion, string[]> = {
  hook: ["dyn"],
  visual_relevance: ["vis"],
  dynamics: ["dyn", "cut"],
  captions: ["subs"],
  audio: ["audio", "voice"],
  text_accuracy: ["text", "subs"],
};
/** the issue the bot names in «Похоже, проблема в …» */
export const CRITERION_ISSUE: Record<ReviewCriterion, string> = { hook: "hook", visual_relevance: "vis", dynamics: "dyn", captions: "subs", audio: "audio", text_accuracy: "text" };

/**
 * The likely cause of a low rating, only when the critic is confident: a criterion graded ≤ 2 that matches a reason
 * the user picked, or (no match) the single clearly worst criterion graded ≤ 2. Otherwise nothing — the bot stays quiet.
 * Returns an issue code (subs | vis | dyn | audio | voice | text | hook).
 */
export function likelyIssue(review: Review, userReasons: string[] = [], minConfidence = 0.6): string | undefined {
  if (review.confidence < minConfidence) return undefined;
  const scored = REVIEW_CRITERIA.map((c) => ({ c, s: review.scores[c].score })).sort((a, b) => a.s - b.s);
  const bad = scored.filter((x) => x.s <= 2);
  if (!bad.length) return undefined;
  for (const x of bad) {
    const hit = CRITERION_REASONS[x.c].find((r) => userReasons.includes(r));
    if (hit) return hit === "cut" ? "dyn" : hit;
  }
  // the user picked reasons and the critic disagrees on all of them: say nothing
  if (userReasons.some((r) => r !== "other")) return undefined;
  if (scored.length > 1 && scored[1].s === scored[0].s) return undefined;
  return CRITERION_ISSUE[scored[0].c];
}

/** mean of the six criteria (the overall grade is reported separately) */
export const meanScore = (r: Review) => r2(REVIEW_CRITERIA.reduce((s, c) => s + r.scores[c].score, 0) / REVIEW_CRITERIA.length);
