import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { exists, jobDir, readJson, WORKSPACE_ROOT, writeJson } from "../lib/workspace.ts";
import { addCost } from "../lib/cost.ts";
import { GeminiClient } from "./gemini-client.ts";
import { priceUsage, type GeminiUsage } from "./vision/gemini.ts";

/**
 * EVENTS: what happens in sports / action footage, for the highlights mode (no speech-driven plan).
 * The source is split into chunks (~8 min), each re-encoded small (480p, mono 16 kHz audio — the rim,
 * the net and people asking to play are audible), uploaded through the Gemini Files API and logged by a
 * Gemini model as structured JSON: shots (make/miss), moves, celebrations, people approaching, with
 * MM:SS times relative to the chunk, a key moment, confidence and the hoop position. Chunk answers are
 * cached by a hash of (source, range, model list, prompt, encode settings) in workspace/_cache/events/.
 * A full-resolution still every few minutes gives a precise rim box (refine.ts snaps shot timings to it).
 */

export const EVENT_TYPES = ["shot_make", "shot_miss", "dunk_layup", "nice_pass", "dribble_move", "celebration", "people_approach", "funny", "other"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Preferred models, newest flash first; unavailable ones are skipped (VEDIT_EVENTS_MODEL overrides with a comma list). */
export const DEFAULT_EVENT_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest"];

export const SportEventSchema = z.object({
  id: z.string(),
  type: z.enum(EVENT_TYPES),
  outcome: z.enum(["make", "miss", "none"]).default("none"),
  /** source seconds */
  start: z.number(),
  end: z.number(),
  /** decisive moment (ball at the rim), source seconds; refined locally when possible */
  key: z.number(),
  confidence: z.number().min(0).max(1),
  quality: z.number().min(0).max(1).default(0.5),
  distance: z.enum(["close", "mid", "long", "unknown"]).default("unknown"),
  description: z.string(),
  /** where the target (hoop) is at the key moment, fractions of the frame */
  target: z.object({ x: z.number(), y: z.number() }).nullable().default(null),
  speech: z.boolean().default(false),
  chunk: z.number().int(),
  /** set by refine.ts */
  refined: z
    .object({
      key: z.number(),
      method: z.string(),
      motion_t: z.number().nullable(),
      audio_t: z.number().nullable(),
      motion_peak: z.number().nullable(),
      /** local evidence that the ball went through: motion under the rim (net) after the rim moment */
      net_motion: z.number().nullable(),
      /** what the local ball track says (make / miss / unknown = ball not followed to the rim) */
      local_verdict: z.enum(["make", "miss", "unknown"]).default("unknown"),
      /** ball inside the net, source seconds */
      through_t: z.number().nullable().default(null),
      /** the ball sat on the ring before it dropped: in or off the front is hard to tell from the frames — the edit prefers clean makes */
      rolled: z.boolean().default(false),
      /** what the model said before the frames were checked */
      model_outcome: z.enum(["make", "miss", "none"]).optional(),
    })
    .optional(),
});
export type SportEvent = z.infer<typeof SportEventSchema>;

export const HoopSampleSchema = z.object({ t: z.number(), found: z.boolean(), box: z.object({ x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }).nullable(), rim: z.object({ x: z.number(), y: z.number() }).nullable() });
export type HoopSample = z.infer<typeof HoopSampleSchema>;

export const EventsFileSchema = z.object({
  version: z.literal(1),
  source: z.string(),
  duration: z.number(),
  sport: z.string(),
  models: z.array(z.string()),
  /** which passes ran over the chunks ("main", "social") */
  passes: z.array(z.string()).default(["main"]),
  chunks: z.array(z.object({ index: z.number().int(), start: z.number(), end: z.number(), hash: z.string(), model: z.string(), events: z.number().int(), cached: z.boolean(), input_tokens: z.number(), output_tokens: z.number() })),
  hoops: z.array(HoopSampleSchema),
  events: z.array(SportEventSchema),
  usage: z.object({ requests: z.number().int(), input_tokens: z.number(), output_tokens: z.number(), usd: z.number(), priced: z.boolean() }),
  warnings: z.array(z.string()),
  wall_seconds: z.number(),
  /** local refinement (refine.ts) and full-video shot scan (scan.ts): redone when the version changes */
  local: z.object({ version: z.number(), refined: z.number(), scan_candidates: z.number(), scan_added: z.number(), wall_seconds: z.number() }).optional(),
});
export type EventsFile = z.infer<typeof EventsFileSchema>;

/** Gemini responseSchema (OpenAPI subset) for one chunk. */
export const EVENTS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    hoop_x: { type: "number", nullable: true },
    hoop_y: { type: "number", nullable: true },
    events: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start: { type: "string", description: "MM:SS from the clip start" },
          end: { type: "string" },
          key: { type: "string", description: "MM:SS(.s) of the decisive moment" },
          type: { type: "string", enum: [...EVENT_TYPES] },
          outcome: { type: "string", enum: ["make", "miss", "none"] },
          confidence: { type: "number" },
          quality: { type: "number" },
          distance: { type: "string", enum: ["close", "mid", "long", "unknown"] },
          ball_x: { type: "number", nullable: true },
          ball_y: { type: "number", nullable: true },
          speech: { type: "boolean" },
          description: { type: "string" },
        },
        required: ["start", "end", "key", "type", "outcome", "confidence", "quality", "distance", "speech", "description"],
        propertyOrdering: ["start", "end", "key", "type", "outcome", "confidence", "quality", "distance", "ball_x", "ball_y", "speech", "description"],
      },
    },
  },
  required: ["events"],
  propertyOrdering: ["hoop_x", "hoop_y", "events"],
};

export const HOOP_RESPONSE_SCHEMA = {
  type: "object",
  properties: { found: { type: "boolean" }, x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" }, rim_x: { type: "number" }, rim_y: { type: "number" } },
  required: ["found"],
  propertyOrdering: ["found", "x0", "y0", "x1", "y1", "rim_x", "rim_y"],
};

const ChunkAnswerSchema = z.object({
  hoop_x: z.number().nullable().optional(),
  hoop_y: z.number().nullable().optional(),
  events: z.array(
    z.object({
      start: z.union([z.string(), z.number()]),
      end: z.union([z.string(), z.number()]),
      key: z.union([z.string(), z.number()]).optional(),
      type: z.string(),
      outcome: z.string().optional(),
      confidence: z.number().optional(),
      quality: z.number().optional(),
      distance: z.string().optional(),
      ball_x: z.number().nullable().optional(),
      ball_y: z.number().nullable().optional(),
      speech: z.boolean().optional(),
      description: z.string().default(""),
    }),
  ),
});
export type ChunkAnswer = z.infer<typeof ChunkAnswerSchema>;

const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
const r2 = (n: number) => Math.round(n * 100) / 100;

/** "03:41.5" | "1:02:03" | "221.5" | 221.5 → seconds; NaN when unparseable. */
export function parseTimestamp(v: string | number): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return NaN;
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0);
}

export function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(0).padStart(2, "0")}`;
}

export interface EventChunk {
  index: number;
  start: number;
  end: number;
}

/** Equal chunks of about `target` seconds (the last one is never a stub shorter than a third of a chunk). */
export function planEventChunks(duration: number, target = 480): EventChunk[] {
  const n = Math.max(1, Math.round(duration / target));
  const len = duration / n;
  return Array.from({ length: n }, (_, i) => ({ index: i, start: r2(i * len), end: r2(i === n - 1 ? duration : (i + 1) * len) }));
}

/**
 * Model answer for one chunk → events on the source timeline. Times are clamped to the chunk, a
 * missing/invalid key falls back to 70 % of the event, a make "type" and a make "outcome" are made
 * consistent (shot_miss with outcome make → shot_make), unknown types become "other".
 */
export function mapChunkEvents(a: ChunkAnswer, chunk: EventChunk): { events: SportEvent[]; dropped: number } {
  const len = chunk.end - chunk.start;
  const out: SportEvent[] = [];
  let dropped = 0;
  for (const [i, e] of a.events.entries()) {
    let s = parseTimestamp(e.start);
    let en = parseTimestamp(e.end);
    if (!Number.isFinite(s) || !Number.isFinite(en)) {
      dropped++;
      continue;
    }
    if (en < s) [s, en] = [en, s];
    s = Math.max(0, Math.min(len, s));
    en = Math.max(0, Math.min(len, en));
    if (en - s < 0.5) en = Math.min(len, s + 2);
    if (en - s < 0.5) {
      dropped++;
      continue;
    }
    let key = e.key !== undefined ? parseTimestamp(e.key) : NaN;
    if (!Number.isFinite(key) || key < s - 1 || key > en + 1) key = s + 0.7 * (en - s);
    key = Math.max(s, Math.min(en, key));
    let type: EventType = (EVENT_TYPES as readonly string[]).includes(e.type) ? (e.type as EventType) : "other";
    let outcome: SportEvent["outcome"] = e.outcome === "make" || e.outcome === "miss" ? e.outcome : "none";
    if (type === "shot_make") outcome = "make";
    if (type === "shot_miss" && outcome === "make") type = "shot_make";
    if (type === "shot_miss") outcome = "miss";
    const bx = e.ball_x;
    const by = e.ball_y;
    out.push({
      id: `c${chunk.index}e${i}`,
      type,
      outcome,
      start: r2(chunk.start + s),
      end: r2(chunk.start + en),
      key: r2(chunk.start + key),
      confidence: clamp01(e.confidence ?? 0.5),
      quality: clamp01(e.quality ?? 0.5),
      distance: (["close", "mid", "long", "unknown"] as const).find((d) => d === e.distance) ?? "unknown",
      description: e.description.trim() || "(без описания)",
      target: typeof bx === "number" && typeof by === "number" && Number.isFinite(bx) && Number.isFinite(by) ? { x: clamp01(bx), y: clamp01(by) } : null,
      speech: e.speech ?? false,
      chunk: chunk.index,
    });
  }
  return { events: out.sort((x, y) => x.start - y.start), dropped };
}

/** Removes near-duplicates (same type, key moments within 2 s — e.g. at a chunk seam), keeping the more confident one. */
export function dedupeEvents(events: SportEvent[]): SportEvent[] {
  const sorted = [...events].sort((a, b) => a.key - b.key);
  const out: SportEvent[] = [];
  for (const e of sorted) {
    const isShot = (x: SportEvent) => x.type === "shot_make" || x.type === "shot_miss" || x.type === "dunk_layup";
    const dup = out.findIndex((o) => Math.abs(o.key - e.key) < 2 && (o.type === e.type || (isShot(o) && isShot(e))));
    if (dup < 0) out.push(e);
    else if (e.confidence > out[dup].confidence) out[dup] = e;
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface DetectEventsOptions {
  apiKey?: string;
  models?: string[];
  /** chunk length, s */
  chunkSeconds?: number;
  /** frames per second the model samples */
  fps?: number;
  mediaResolution?: "low" | "medium" | "high";
  /** height of the upload clip */
  clipHeight?: number;
  sport?: string;
  /** seconds between full-resolution stills for the rim box */
  hoopEvery?: number;
  fetchFn?: typeof fetch;
  client?: GeminiClient;
  tmpDir?: string;
  onLog?: (line: string) => void;
  /** second, people-focused pass per chunk (0.5 frames/s, the sound matters): newcomers, conversations, reactions (default on) */
  social?: boolean;
  /** only analyse [from, to) of the source (testing on a slice) */
  from?: number;
  to?: number;
}

function sha(...parts: (string | number)[]) {
  const h = createHash("sha256");
  for (const p of parts) h.update(String(p)).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** Small upload clip of [start, end): 480p H.264 at a few fps + mono 16 kHz AAC (the model hears the rim and people). */
export async function extractEventClip(source: string, start: number, end: number, out: string, o: { height?: number; fps?: number } = {}) {
  await ffmpeg([
    "-ss", start.toFixed(3), "-to", end.toFixed(3), "-i", source,
    "-vf", `fps=${o.fps ?? 10},scale=-2:${o.height ?? 480}:flags=bicubic`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p",
    "-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "32k",
    "-movflags", "+faststart", out,
  ]);
}

/**
 * Detect events over the whole source (sequential chunks; cached). Writes <job>/events.json and returns it.
 * Cost: one upload + one generate per chunk, one generate per hoop still.
 */
export async function detectEvents(jobId: string, source: string, duration: number, opts: DetectEventsOptions = {}): Promise<EventsFile> {
  const t0 = Date.now();
  const dir = jobDir(jobId);
  // shared across jobs: the same source analysed again (a new job, the bot) costs nothing
  const cacheDir = path.join(WORKSPACE_ROOT, "_cache", "events");
  await fs.mkdir(cacheDir, { recursive: true });
  const log = opts.onLog ?? (() => {});
  const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  const models = opts.models ?? (process.env.VEDIT_EVENTS_MODEL ? process.env.VEDIT_EVENTS_MODEL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_EVENT_MODELS);
  const sport = opts.sport ?? "basketball";
  const fps = opts.fps ?? 2;
  const res = opts.mediaResolution ?? "low";
  const height = opts.clipHeight ?? 480;
  const tmp = opts.tmpDir ?? os.tmpdir();
  const stat = await fs.stat(source);
  const srcId = `${path.resolve(source)}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(duration, opts.to ?? duration);
  const chunks = planEventChunks(to - from, opts.chunkSeconds ?? 480).map((c) => ({ ...c, start: r2(c.start + from), end: r2(c.end + from) }));
  const promptVersion = sha(loadPrompt("events.gemini.system"), loadPrompt("events.gemini.user"), JSON.stringify(EVENTS_RESPONSE_SCHEMA));
  let client: GeminiClient | undefined = opts.client;
  const getClient = () => {
    if (client) return client;
    if (!apiKey) throw new Error("нет GEMINI_API_KEY — детекция событий (режим highlights) недоступна");
    client = new GeminiClient({ apiKey, fetchFn: opts.fetchFn, onLog: log });
    return client;
  };

  const warnings: string[] = [];
  const records: EventsFile["chunks"] = [];
  const all: SportEvent[] = [];
  let inTok = 0;
  let outTok = 0;
  let usd = 0;
  let priced = true;
  const reqBefore = client?.requests ?? 0;
  const tally = (model: string, u: GeminiUsage) => {
    inTok += u.promptTokenCount ?? 0;
    outTok += (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    const p = priceUsage(model, u);
    usd += p.usd;
    if (!p.priced) priced = false;
  };

  const passes = [
    { name: "main", prompt: "events.gemini.user", fps, version: promptVersion },
    ...(opts.social === false ? [] : [{ name: "social", prompt: "events.social.user", fps: 0.5, version: sha(loadPrompt("events.gemini.system"), loadPrompt("events.social.user"), JSON.stringify(EVENTS_RESPONSE_SCHEMA)) }]),
  ];
  const socialEvents: SportEvent[] = [];
  for (const chunk of chunks) {
    // one upload per chunk, shared by the passes that are not cached yet
    let clip: string | null = null;
    let uploaded: Awaited<ReturnType<GeminiClient["upload"]>> | undefined;
    const answers: Record<string, { raw: { model: string; usage: GeminiUsage; answer: unknown }; cached: boolean; hash: string }> = {};
    try {
      for (const pass of passes) {
        // the answer does not depend on which model of the list produced it (it is recorded inside), so the list is not part of the key
        const hash = pass.name === "main" ? sha(srcId, chunk.start, chunk.end, pass.version, pass.fps, res, height, sport) : sha(srcId, chunk.start, chunk.end, pass.version, pass.fps, res, height, sport, "social");
        const cacheFile = path.join(cacheDir, `${pass.name === "main" ? "chunk" : "social"}_${chunk.index}.${hash}.json`);
        if (await exists(cacheFile)) {
          answers[pass.name] = { raw: JSON.parse(await fs.readFile(cacheFile, "utf8")), cached: true, hash };
          log(`события${pass.name === "main" ? "" : " (люди)"}: чанк ${chunk.index + 1}/${chunks.length} из кэша`);
          continue;
        }
        const c = getClient();
        log(`события${pass.name === "main" ? "" : " (люди)"}: чанк ${chunk.index + 1}/${chunks.length} (${mmss(chunk.start)}–${mmss(chunk.end)}) → Gemini`);
        if (!uploaded) {
          clip = path.join(tmp, `vedit-events-${process.pid}-${chunk.index}.mp4`);
          await extractEventClip(source, chunk.start, chunk.end, clip, { height });
          uploaded = await c.upload(clip, "video/mp4", `vedit-events-${chunk.index}.mp4`);
        }
        const len = chunk.end - chunk.start;
        const user = fill(loadPrompt(pass.prompt), { len: Math.round(len), start: Math.round(chunk.start), sport, mmss_end: mmss(len) });
        try {
          const g = await c.generate(models, {
            system: loadPrompt("events.gemini.system"),
            parts: [{ file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri }, video_metadata: { fps: pass.fps } }, { text: user }],
            schema: EVENTS_RESPONSE_SCHEMA,
            mediaResolution: res,
            // the people pass is optional: no waiting rounds when every model is busy
            rounds: pass.name === "main" ? undefined : 0,
          });
          const raw = { model: g.model, usage: g.usage, answer: g.data };
          await fs.writeFile(cacheFile, JSON.stringify(raw, null, 1));
          answers[pass.name] = { raw, cached: false, hash };
        } catch (err) {
          // the people pass is a bonus: without it the edit just has fewer story beats
          if (pass.name === "main") throw err;
          warnings.push(`чанк ${chunk.index} (люди): ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
        }
      }
    } finally {
      if (uploaded) await getClient().remove(uploaded.name);
      if (clip) await fs.rm(clip, { force: true }).catch(() => {});
    }
    const soc = answers.social;
    if (soc) {
      const p = ChunkAnswerSchema.safeParse(soc.raw.answer);
      if (p.success) socialEvents.push(...mapChunkEvents(p.data, chunk).events.filter((e) => !e.type.startsWith("shot") && e.type !== "dunk_layup").map((e) => ({ ...e, id: `${e.id}p` })));
      if (!soc.cached) tally(soc.raw.model, soc.raw.usage);
    }
    const { raw, cached, hash } = answers.main;
    const parsed = ChunkAnswerSchema.safeParse(raw.answer);
    if (!parsed.success) {
      warnings.push(`чанк ${chunk.index}: ответ модели не по схеме — пропущен`);
      records.push({ index: chunk.index, start: chunk.start, end: chunk.end, hash, model: raw.model, events: 0, cached, input_tokens: raw.usage.promptTokenCount ?? 0, output_tokens: raw.usage.candidatesTokenCount ?? 0 });
      continue;
    }
    const m = mapChunkEvents(parsed.data, chunk);
    if (m.dropped) warnings.push(`чанк ${chunk.index}: ${m.dropped} событий без понятного времени отброшено`);
    // the chunk-level hoop guess fills events without a target
    const hx = parsed.data.hoop_x;
    const hy = parsed.data.hoop_y;
    for (const e of m.events) if (!e.target && typeof hx === "number" && typeof hy === "number") e.target = { x: clamp01(hx), y: clamp01(hy) };
    all.push(...m.events);
    if (!cached) tally(raw.model, raw.usage);
    records.push({ index: chunk.index, start: chunk.start, end: chunk.end, hash, model: raw.model, events: m.events.length, cached, input_tokens: raw.usage.promptTokenCount ?? 0, output_tokens: (raw.usage.candidatesTokenCount ?? 0) + (raw.usage.thoughtsTokenCount ?? 0) });
  }

  // rim box from full-resolution stills (the upload clip is too small to place a 30 px rim precisely)
  const hoops: HoopSample[] = [];
  // a still every 8 min: the free tier allows ~20 requests a day per model, the chunks need most of them
  const every = opts.hoopEvery ?? 480;
  for (let t = from + Math.min(5, (to - from) / 2); t < to; t += every) {
    const hash = sha(srcId, t.toFixed(2), loadPrompt("events.hoop.user"), sport);
    const cacheFile = path.join(cacheDir, `hoop_${Math.round(t)}.${hash}.json`);
    let raw: { model: string; usage: GeminiUsage; answer: unknown };
    if (await exists(cacheFile)) raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    else {
      const still = path.join(tmp, `vedit-hoop-${process.pid}-${Math.round(t)}.jpg`);
      try {
        await ffmpeg(["-ss", t.toFixed(3), "-i", source, "-frames:v", "1", "-q:v", "2", still]);
        const bytes = await fs.readFile(still);
        const g = await getClient().generate(models, {
          system: "You locate objects in images precisely and answer only with the requested JSON.",
          parts: [{ inline_data: { mime_type: "image/jpeg", data: bytes.toString("base64") } }, { text: fill(loadPrompt("events.hoop.user"), { sport }) }],
          schema: HOOP_RESPONSE_SCHEMA,
          mediaResolution: "high",
          temperature: 0,
        });
        raw = { model: g.model, usage: g.usage, answer: g.data };
        await fs.writeFile(cacheFile, JSON.stringify(raw, null, 1));
        tally(g.model, g.usage);
      } catch (err) {
        warnings.push(`кольцо на ${mmss(t)}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
        continue;
      } finally {
        await fs.rm(still, { force: true }).catch(() => {});
      }
    }
    hoops.push(hoopFromAnswer(t, raw.answer));
  }

  const events = dedupeEvents([...all, ...socialEvents]).map((e, i) => ({ ...e, id: `e${i + 1}` }));
  const file: EventsFile = {
    version: 1,
    source: path.resolve(source),
    duration,
    sport,
    models,
    passes: passes.map((p) => p.name),
    chunks: records,
    hoops,
    events,
    usage: { requests: (client?.requests ?? 0) - reqBefore, input_tokens: inTok, output_tokens: outTok, usd, priced },
    warnings,
    wall_seconds: (Date.now() - t0) / 1000,
  };
  if (inTok > 0) await addCost(jobId, { step: "understand", provider: "gemini-events", model: records.find((r) => !r.cached)?.model ?? models[0], units: { requests: file.usage.requests, input_tokens: inTok, output_tokens: outTok, chunks: records.filter((r) => !r.cached).length, ...(priced ? {} : { unpriced: 1 }) }, usd });
  return writeJson(path.join(dir, "events.json"), EventsFileSchema, file);
}

/** Model answer for a still → hoop sample (box sanity-checked: inside the frame, not degenerate, rim inside the box or derived from it). */
export function hoopFromAnswer(t: number, answer: unknown): HoopSample {
  const a = z.object({ found: z.boolean(), x0: z.number().optional(), y0: z.number().optional(), x1: z.number().optional(), y1: z.number().optional(), rim_x: z.number().optional(), rim_y: z.number().optional() }).safeParse(answer);
  if (!a.success || !a.data.found) return { t: r2(t), found: false, box: null, rim: null };
  const d = a.data;
  // some models answer in 0-1000 (Gemini's native box scale)
  const norm = (v: number | undefined) => (v === undefined ? undefined : v > 1.5 ? v / 1000 : v);
  const [x0, y0, x1, y1] = [norm(d.x0), norm(d.y0), norm(d.x1), norm(d.y1)];
  let box: HoopSample["box"] = null;
  if ([x0, y0, x1, y1].every((v) => typeof v === "number")) {
    const b = { x0: clamp01(Math.min(x0!, x1!)), y0: clamp01(Math.min(y0!, y1!)), x1: clamp01(Math.max(x0!, x1!)), y1: clamp01(Math.max(y0!, y1!)) };
    if (b.x1 - b.x0 > 0.005 && b.y1 - b.y0 > 0.003 && b.x1 - b.x0 < 0.5 && b.y1 - b.y0 < 0.5) box = b;
  }
  const rx = norm(d.rim_x);
  const ry = norm(d.rim_y);
  const rim = typeof rx === "number" && typeof ry === "number" ? { x: clamp01(rx), y: clamp01(ry) } : box ? { x: (box.x0 + box.x1) / 2, y: box.y0 + (box.y1 - box.y0) * 0.2 } : null;
  return { t: r2(t), found: !!(box || rim), box, rim };
}

/** The hoop sample to use at time t: the latest one before t (camera moves are rare), else the first after. */
export function hoopAt(hoops: HoopSample[], t: number): HoopSample | null {
  const ok = hoops.filter((h) => h.found && h.rim);
  if (!ok.length) return null;
  const before = ok.filter((h) => h.t <= t + 1);
  return before.length ? before[before.length - 1] : ok[0];
}

export async function loadEvents(jobId: string): Promise<EventsFile | null> {
  const f = path.join(jobDir(jobId), "events.json");
  return (await exists(f)) ? readJson(f, EventsFileSchema) : null;
}
