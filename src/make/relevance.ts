import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { DEFAULT_GEMINI_MODEL, priceUsage } from "../understand/vision/gemini.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { readCache, VISUALS_CACHE, writeCache } from "./visuals.ts";

/**
 * Does this photo show what the narrator is talking about? (stage 26) Every photo candidate — Commons photos of an
 * entity and Openverse photos for a generic beat — is shown to Gemini (flash-lite by default: text/vision is cheap) as a
 * 384-px thumbnail, several candidates in ONE request, each with its own question («Does image 3 clearly show the Nasdaq
 * exchange (MarketSite, its tower or Nasdaq signage)?»). The answer per image: shows yes/no, a 0–10 score, what it sees,
 * and where the subject is (for the crop and punch-ins). Verdicts are cached by image hash + question, so re-renders
 * cost nothing. Without a key the check is skipped (photos pass on the title/licence rules alone, logged as unchecked).
 */

export const RELEVANCE_THRESHOLD = 6;
export const RELEVANCE_BATCH = 8;

export interface RelevanceCandidate {
  /** caller's id */
  id: string;
  file: string;
  /** English: what must be visible */
  subject: string;
  /** the file title / caption (context for the model, never trusted alone) */
  title?: string;
}

export interface RelevanceVerdict {
  id: string;
  shows: boolean;
  score: number;
  sees: string;
  focus: { x: number; y: number };
  cached: boolean;
  /** false when no check ran (no key / the call failed) */
  checked: boolean;
}

/** Accept a photo: the model says it clearly shows the subject with a score at the threshold or above. Unchecked → accepted only when allowed. */
export function relevanceDecision(v: Pick<RelevanceVerdict, "shows" | "score" | "checked">, o: { threshold?: number; acceptUnchecked?: boolean } = {}): boolean {
  if (!v.checked) return o.acceptUnchecked ?? true;
  return v.shows && v.score >= (o.threshold ?? RELEVANCE_THRESHOLD);
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    results: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          image: { type: "INTEGER" },
          shows: { type: "BOOLEAN" },
          score: { type: "INTEGER" },
          sees: { type: "STRING" },
          focus_x: { type: "NUMBER" },
          focus_y: { type: "NUMBER" },
        },
        required: ["image", "shows", "score", "sees", "focus_x", "focus_y"],
      },
    },
  },
  required: ["results"],
};

const SYSTEM = [
  "You check stock photos for a news video. For every numbered image you get a question: does the image CLEARLY show the given subject?",
  "Clearly = the subject itself is visible and recognisable: its name or logo on a building, a screen or a sign, the product itself, the named place, or — for a person — a real photograph with the face visible.",
  "A generic scene that merely could be related (any office, any server room, any stock-exchange building that is not the named one, people at a random meeting) is NOT enough: answer shows=false and a low score.",
  "You cannot recognise people by their faces: for a person, judge only whether it is a real, sharp photograph of one main person with the face visible; the file title says who it is.",
  "score: 0 = unrelated, 5 = related but not clearly the subject, 8 = clearly the subject, 10 = a perfect, iconic picture of it. Penalise text-heavy screenshots, collages, blurry or tiny subjects and watermarks.",
  "sees: one short English phrase of what is actually in the image. focus_x, focus_y: the centre of the subject (0..1 from the left / top).",
].join(" ");

export interface RelevanceOptions {
  key?: string;
  models?: string[];
  client?: GeminiClient;
  cacheDir?: string | null;
  batch?: number;
  onLog?: (l: string) => void;
}

export interface RelevanceResult {
  verdicts: Map<string, RelevanceVerdict>;
  usd: number;
  requests: number;
  model: string;
  images: number;
}

async function thumb(file: string, dir: string): Promise<Buffer> {
  const out = path.join(dir, `${createHash("sha1").update(file).digest("hex").slice(0, 12)}.jpg`);
  await ffmpeg(["-i", file, "-vf", "scale='min(384,iw)':-2:flags=bicubic", "-frames:v", "1", "-q:v", "5", out]);
  return fs.readFile(out);
}

/** Batched vision check of photo candidates (cached per image + question). */
export async function checkRelevance(cands: RelevanceCandidate[], o: RelevanceOptions = {}): Promise<RelevanceResult> {
  const verdicts = new Map<string, RelevanceVerdict>();
  const cacheDir = o.cacheDir === undefined ? path.join(VISUALS_CACHE, "relevance") : o.cacheDir;
  const models = o.models ?? (process.env.VEDIT_RELEVANCE_MODEL ? process.env.VEDIT_RELEVANCE_MODEL.split(",").map((s) => s.trim()).filter(Boolean) : [DEFAULT_GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-3.5-flash"]);
  let usd = 0;
  let requests = 0;
  let model = "";
  let images = 0;
  const todo: { c: RelevanceCandidate; key: string }[] = [];
  for (const c of cands) {
    const bytes = await fs.readFile(c.file).catch(() => null);
    if (!bytes) continue;
    const key = createHash("sha256").update(bytes).update(`\n${c.subject}\n${c.title ?? ""}`).digest("hex").slice(0, 24);
    const hit = cacheDir ? await readCache<Omit<RelevanceVerdict, "id" | "cached">>(cacheDir, key) : null;
    if (hit) verdicts.set(c.id, { ...hit, id: c.id, cached: true });
    else todo.push({ c, key });
  }
  if (!todo.length) return { verdicts, usd, requests, model, images };
  const apiKey = o.key ?? geminiApiKey();
  if (!apiKey && !o.client) {
    for (const t of todo) verdicts.set(t.c.id, { id: t.c.id, shows: true, score: 0, sees: "", focus: { x: 0.5, y: 0.45 }, cached: false, checked: false });
    o.onLog?.("проверка картинок пропущена: нет GEMINI_API_KEY");
    return { verdicts, usd, requests, model, images };
  }
  const client = o.client ?? new GeminiClient({ apiKey: apiKey!, onLog: o.onLog, rounds: 1, roundWaitMs: 15_000, maxRetries: 2, backoffMs: 4000 });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-rel-"));
  try {
    const size = o.batch ?? RELEVANCE_BATCH;
    for (let b = 0; b < todo.length; b += size) {
      const part = todo.slice(b, b + size);
      const parts: unknown[] = [];
      const questions: string[] = [];
      for (const [k, t] of part.entries()) {
        const jpg = await thumb(t.c.file, tmp);
        parts.push({ text: `Image ${k + 1}:` }, { inlineData: { mimeType: "image/jpeg", data: jpg.toString("base64") } });
        questions.push(`Image ${k + 1}: does it clearly show ${t.c.subject}?${t.c.title ? ` (file title: «${t.c.title.slice(0, 120)}»)` : ""}`);
      }
      parts.push({ text: `QUESTIONS\n${questions.join("\n")}\n\nAnswer for every image.` });
      try {
        const r = await client.generate(models, { system: SYSTEM, parts, schema: SCHEMA, temperature: 0, mediaResolution: "low", rounds: 1 });
        model = r.model;
        requests += r.requests;
        images += part.length;
        usd += priceUsage(r.model, r.usage).usd;
        const res = (r.data as { results?: { image: number; shows: boolean; score: number; sees: string; focus_x: number; focus_y: number }[] }).results ?? [];
        for (const [k, t] of part.entries()) {
          const a = res.find((x) => Math.round(x.image) === k + 1);
          if (!a) {
            verdicts.set(t.c.id, { id: t.c.id, shows: false, score: 0, sees: "(no answer)", focus: { x: 0.5, y: 0.45 }, cached: false, checked: true });
            continue;
          }
          const v = { shows: !!a.shows, score: Math.max(0, Math.min(10, Math.round(a.score))), sees: String(a.sees ?? "").slice(0, 140), focus: { x: clamp01(a.focus_x), y: clamp01(a.focus_y) }, checked: true };
          verdicts.set(t.c.id, { ...v, id: t.c.id, cached: false });
          if (cacheDir) await writeCache(cacheDir, t.key, v);
        }
      } catch (err) {
        o.onLog?.(`проверка картинок не удалась: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
        for (const t of part) verdicts.set(t.c.id, { id: t.c.id, shows: true, score: 0, sees: "", focus: { x: 0.5, y: 0.45 }, cached: false, checked: false });
      }
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  return { verdicts, usd, requests, model, images };
}

const clamp01 = (x: unknown) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n > 1 && n <= 100 ? n / 100 : n)) : 0.5;
};
