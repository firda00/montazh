import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ffmpegBuffer } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { exists, jobDir, readJson, WORKSPACE_ROOT, writeJson } from "../lib/workspace.ts";
import { addCost } from "../lib/cost.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { DEFAULT_EVENT_MODELS, extractEventClip, hoopAt, mmss, parseTimestamp, sha, type EventsFile, type SportEvent } from "../understand/events.ts";
import type { Media } from "../schemas/index.ts";

/**
 * WHO THREW EACH SHOT (per-person reels). Two sources, reconciled:
 *   1. a "players" pass per chunk (Gemini, same 480p upload as the events): the people on court with a
 *      visible description, the roster carried from chunk to chunk so ids stay the same, and for every
 *      shot id the shooter and where they stood at the release;
 *   2. a local appearance signature: around the release (rim moment − 1 s) the moving person at the
 *      model's position is cut out against the median of nearby frames, and the colour of their torso
 *      (median RGB of the upper body) is measured.
 * A shot whose torso colour is far from its person's usual colour and close to another person present
 * at that time is moved to that person. The crops also make the "who is who" contact sheet.
 */

export const PersonSchema = z.object({
  id: z.string(),
  look: z.string(),
  /** source seconds when first seen / when they started playing (null = from the start) */
  first_seen: z.number().nullable(),
  joined_at: z.number().nullable(),
  /** median torso colour over their shots (RGB 0–255) */
  color: z.array(z.number()).nullable(),
  shots: z.number().int(),
  makes: z.number().int(),
});
export type Person = z.infer<typeof PersonSchema>;

export const ShotOwnerSchema = z.object({
  event: z.string(),
  t: z.number(),
  person: z.string(),
  /** what the model said, before the colour check */
  model_person: z.string(),
  x: z.number(),
  y: z.number(),
  sure: z.number(),
  /** torso colour and the cut-out box (source px) at the release frame */
  color: z.array(z.number()).nullable(),
  box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }).nullable(),
  release_t: z.number(),
  moved: z.boolean().default(false),
  /** which pass decided: the chunk players pass, the per-make pass, or the colour check */
  by: z.enum(["players", "makes", "color"]).default("players"),
  reason: z.string().optional(),
});
export type ShotOwner = z.infer<typeof ShotOwnerSchema>;

export const PlayersFileSchema = z.object({
  version: z.literal(1),
  persons: z.array(PersonSchema),
  shots: z.array(ShotOwnerSchema),
  usage: z.object({ requests: z.number(), input_tokens: z.number(), output_tokens: z.number(), cached_chunks: z.number() }),
  warnings: z.array(z.string()),
});
export type PlayersFile = z.infer<typeof PlayersFileSchema>;

export const PLAYERS_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: { id: { type: "string" }, look: { type: "string" }, first_seen: { type: "string", nullable: true }, joined: { type: "boolean" } },
        required: ["id", "look", "joined"],
        propertyOrdering: ["id", "look", "first_seen", "joined"],
      },
    },
    shots: {
      type: "array",
      items: {
        type: "object",
        properties: { shot: { type: "string" }, person: { type: "string" }, x: { type: "number" }, y: { type: "number" }, sure: { type: "number" } },
        required: ["shot", "person", "x", "y", "sure"],
        propertyOrdering: ["shot", "person", "x", "y", "sure"],
      },
    },
  },
  required: ["people", "shots"],
  propertyOrdering: ["people", "shots"],
};

const AnswerSchema = z.object({
  people: z.array(z.object({ id: z.string(), look: z.string().default(""), first_seen: z.string().nullable().optional(), joined: z.boolean().default(false) })),
  shots: z.array(z.object({ shot: z.string(), person: z.string(), x: z.number(), y: z.number(), sure: z.number().default(0.5) })),
});
export type PlayersAnswer = z.infer<typeof AnswerSchema>;

const isShot = (e: SportEvent) => e.type === "shot_make" || e.type === "shot_miss" || e.type === "dunk_layup";
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0.5));
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** rim moment of a shot (local refinement when it ran) */
export const shotTime = (e: SportEvent) => e.refined?.motion_t ?? e.key;

/** Normalises a model person id ("p3", "Person 3", "P03") to "P3"; anything else is kept trimmed. */
export function normId(id: string): string {
  const m = /(\d+)/.exec(id);
  return m ? `P${Number(m[1])}` : id.trim();
}

/**
 * Merges one chunk's answer into the roster and the shot list. Unknown shot ids are ignored; a person
 * id the roster does not know yet becomes a new person (first seen in this chunk).
 */
export function mergeChunk(roster: Map<string, { look: string; first_seen: number | null; joined_at: number | null }>, ans: PlayersAnswer, chunk: { start: number; end: number }, shotIds: Map<string, SportEvent>): { owners: Omit<ShotOwner, "color" | "box">[] } {
  for (const p of ans.people) {
    const id = normId(p.id);
    const fs0 = p.first_seen ? parseTimestamp(p.first_seen) : NaN;
    const at = Number.isFinite(fs0) ? r3(chunk.start + Math.max(0, fs0)) : null;
    const have = roster.get(id);
    if (!have) roster.set(id, { look: p.look.trim(), first_seen: at ?? r3(chunk.start), joined_at: p.joined ? (at ?? r3(chunk.start)) : null });
    else {
      if (!have.look && p.look) have.look = p.look.trim();
      // "joined" for someone already on the roster from an earlier clip is the model losing track, not an arrival
    }
  }
  const owners: Omit<ShotOwner, "color" | "box">[] = [];
  for (const s of ans.shots) {
    const ev = shotIds.get(s.shot.trim().toUpperCase());
    if (!ev) continue;
    const person = normId(s.person);
    if (!roster.has(person)) roster.set(person, { look: "", first_seen: r3(shotTime(ev)), joined_at: null });
    const t = shotTime(ev);
    owners.push({ event: ev.id, t: r3(t), person, model_person: person, x: clamp01(s.x), y: clamp01(s.y), sure: clamp01(s.sure), release_t: r3(Math.max(0, t - 1)), moved: false, by: "players" });
  }
  return { owners };
}

/** Roster as prompt lines. */
export function rosterText(roster: Map<string, { look: string }>): string {
  return roster.size ? [...roster.entries()].map(([id, p]) => `  ${id}: ${p.look || "(без описания)"}`).join("\n") : "  (nobody yet — this is the first clip)";
}

// ---------------------------------------------------------------- local appearance

export interface Signature {
  color: number[];
  box: { x: number; y: number; w: number; h: number };
}

/**
 * The moving person around (cx, cy) at time t: a 200×340 px window, median of 7 frames over
 * [t − 2.5, t + 1] as background, foreground at t, the largest blob → its upper body (20–55 % of
 * its height) → median RGB. null when nobody moves there (the shooter stood still for 3 s).
 */
export async function signatureAt(source: string, t: number, cx: number, cy: number, frameW: number, frameH: number): Promise<Signature | null> {
  const w = 200;
  const h = 340;
  const x0 = Math.round(Math.min(frameW - w, Math.max(0, cx * frameW - w / 2)) / 2) * 2;
  const y0 = Math.round(Math.min(frameH - h, Math.max(0, cy * frameH - h / 2)) / 2) * 2;
  const t0 = Math.max(0, t - 2.5);
  const raw = await ffmpegBuffer(["-ss", t0.toFixed(3), "-t", "3.6", "-i", source, "-an", "-vf", `crop=${w}:${h}:${x0}:${y0},fps=2`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = w * h * 3;
  const frames: Buffer[] = [];
  for (let p = 0; p + size <= raw.length; p += size) frames.push(raw.subarray(p, p + size));
  if (frames.length < 4) return null;
  const at = Math.min(frames.length - 1, Math.round((t - t0) * 2));
  const f = frames[at];
  const bg = Buffer.alloc(size);
  const vals: number[] = [];
  for (let p = 0; p < size; p++) {
    vals.length = 0;
    for (const fr of frames) vals.push(fr[p]);
    vals.sort((a, b) => a - b);
    bg[p] = vals[vals.length >> 1];
  }
  const mask = new Uint8Array(w * h);
  for (let q = 0, p = 0; q < w * h; q++, p += 3) mask[q] = Math.abs(f[p] - bg[p]) + Math.abs(f[p + 1] - bg[p + 1]) + Math.abs(f[p + 2] - bg[p + 2]) > 60 ? 1 : 0;
  // largest 4-connected blob
  const stack = new Int32Array(w * h);
  let best: { n: number; x0: number; x1: number; y0: number; y1: number; label: number } | null = null;
  const label = new Int32Array(w * h);
  let next = 1;
  for (let q0 = 0; q0 < w * h; q0++) {
    if (!mask[q0] || label[q0]) continue;
    let top = 0;
    stack[top++] = q0;
    label[q0] = next;
    let n = 0;
    let bx0 = w;
    let bx1 = 0;
    let by0 = h;
    let by1 = 0;
    while (top) {
      const q = stack[--top];
      const x = q % w;
      const y = (q - x) / w;
      n++;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
      if (y < by0) by0 = y;
      if (y > by1) by1 = y;
      for (const nq of [x > 0 ? q - 1 : -1, x < w - 1 ? q + 1 : -1, y > 0 ? q - w : -1, y < h - 1 ? q + w : -1]) {
        if (nq >= 0 && mask[nq] && !label[nq]) (label[nq] = next), (stack[top++] = nq);
      }
    }
    if (!best || n > best.n) best = { n, x0: bx0, x1: bx1, y0: by0, y1: by1, label: next };
    next++;
  }
  const b0 = best as { n: number; x0: number; x1: number; y0: number; y1: number; label: number } | null;
  if (!b0 || b0.n < 900 || b0.y1 - b0.y0 < 60) return null;
  best = b0;
  const ty0 = Math.round(best.y0 + 0.2 * (best.y1 - best.y0));
  const ty1 = Math.round(best.y0 + 0.55 * (best.y1 - best.y0));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  for (let y = ty0; y <= ty1; y++) {
    for (let x: number = best.x0; x <= best.x1; x++) {
      const q = y * w + x;
      if (label[q] !== best.label) continue;
      rs.push(f[q * 3]);
      gs.push(f[q * 3 + 1]);
      bs.push(f[q * 3 + 2]);
    }
  }
  if (rs.length < 80) return null;
  const med = (a: number[]) => a.sort((x, y) => x - y)[a.length >> 1];
  return { color: [med(rs), med(gs), med(bs)], box: { x: x0 + best.x0, y: y0 + best.y0, w: best.x1 - best.x0 + 1, h: best.y1 - best.y0 + 1 } };
}

/** colour distance (RGB, or top+bottom RGB pairs normalised to one RGB scale) */
const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - (b[i] ?? 0))) / Math.sqrt(Math.max(1, a.length / 3));
const median3 = (cs: number[][]) => cs[0].map((_, k) => cs.map((c) => c[k]).sort((a, b) => a - b)[cs.length >> 1]);

/**
 * Colour check: per person the median torso colour (from ≥ 3 shots the model was sure about); a shot is
 * moved to another person present within ±6 min when its colour is ≥ 1.8× closer to theirs and within 45
 * RGB units of it while ≥ 60 units from its own person's.
 */
export function reconcile(shots: ShotOwner[]): { shots: ShotOwner[]; colors: Map<string, number[]> } {
  const colors = new Map<string, number[]>();
  const byPerson = new Map<string, ShotOwner[]>();
  for (const s of shots) byPerson.set(s.person, [...(byPerson.get(s.person) ?? []), s]);
  for (const [p, ss] of byPerson) {
    const sure = ss.filter((s) => s.color && s.sure >= 0.6).map((s) => s.color!);
    const any = ss.filter((s) => s.color).map((s) => s.color!);
    const use = sure.length >= 3 ? sure : any;
    if (use.length >= 3) colors.set(p, median3(use));
  }
  const out = shots.map((s) => {
    if (!s.color || !colors.has(s.person) || s.by === "makes") return s;
    const own = dist(s.color, colors.get(s.person)!);
    if (own < 60) return s;
    const present = new Set(shots.filter((o) => Math.abs(o.t - s.t) < 360).map((o) => o.person));
    let bestP: string | null = null;
    let bestD = Infinity;
    for (const [p, c] of colors) {
      if (p === s.person || !present.has(p)) continue;
      const d = dist(s.color, c);
      if (d < bestD) (bestD = d), (bestP = p);
    }
    if (bestP && bestD <= 45 && own >= 1.8 * bestD) return { ...s, person: bestP, moved: true, by: "color" as const };
    return s;
  });
  return { shots: out, colors };
}

export interface AttributeOptions {
  apiKey?: string;
  models?: string[];
  fetchFn?: typeof fetch;
  client?: GeminiClient;
  onLog?: (line: string) => void;
  /** skip the local colour pass (tests) */
  local?: boolean;
  /** re-ask every make on a cut-out reel (experimental, off: less reliable than the chunk pass) */
  makesPass?: boolean;
  /** let the colour check move shots between people (off by default) */
  colorMoves?: boolean;
}

/**
 * Players pass over the chunks of events.json (sequential: the roster of earlier chunks goes into the
 * prompt), then the local colour signatures and the reconciliation. Writes <job>/players.json.
 */
export async function attributePlayers(jobId: string, ev: EventsFile, media: Media, o: AttributeOptions = {}): Promise<PlayersFile> {
  const log = o.onLog ?? (() => {});
  const cacheDir = path.join(WORKSPACE_ROOT, "_cache", "events");
  await fs.mkdir(cacheDir, { recursive: true });
  const models = o.models ?? (process.env.VEDIT_EVENTS_MODEL ? process.env.VEDIT_EVENTS_MODEL.split(",").map((s) => s.trim()) : DEFAULT_EVENT_MODELS);
  const apiKey = o.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  let client = o.client;
  const getClient = () => {
    if (client) return client;
    if (!apiKey) throw new Error("нет GEMINI_API_KEY — разметка игроков недоступна");
    client = new GeminiClient({ apiKey, fetchFn: o.fetchFn, onLog: log });
    return client;
  };
  const stat = await fs.stat(ev.source);
  const srcId = `${ev.source}|${stat.size}|${Math.round(stat.mtimeMs)}`;
  const promptVersion = sha(loadPrompt("events.gemini.system"), loadPrompt("events.players.user"), JSON.stringify(PLAYERS_RESPONSE_SCHEMA));
  const roster = new Map<string, { look: string; first_seen: number | null; joined_at: number | null }>();
  const owners: Omit<ShotOwner, "color" | "box">[] = [];
  const warnings: string[] = [];
  let inTok = 0;
  let outTok = 0;
  let cachedChunks = 0;
  const before = client?.requests ?? 0;
  const shots = ev.events.filter(isShot).sort((a, b) => shotTime(a) - shotTime(b));
  for (const chunk of ev.chunks) {
    const inChunk = shots.filter((s) => shotTime(s) >= chunk.start && shotTime(s) < chunk.end);
    if (!inChunk.length) continue;
    const ids = new Map(inChunk.map((s, i) => [`S${i + 1}`, s]));
    const shotLines = [...ids.entries()].map(([id, s]) => `  ${id} ${mmssTenths(shotTime(s) - chunk.start)}`).join("\n");
    const known = rosterText(roster);
    const len = chunk.end - chunk.start;
    const user = fill(loadPrompt("events.players.user"), { len: Math.round(len), start: Math.round(chunk.start), sport: ev.sport, known, shots: shotLines });
    const hash = sha(srcId, chunk.start, chunk.end, promptVersion, user);
    const cacheFile = path.join(cacheDir, `players_${chunk.index}.${hash}.json`);
    let raw: { model: string; usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }; answer: unknown };
    if (await exists(cacheFile)) {
      raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
      cachedChunks++;
      log(`игроки: чанк ${chunk.index + 1}/${ev.chunks.length} из кэша`);
    } else {
      const c = getClient();
      log(`игроки: чанк ${chunk.index + 1}/${ev.chunks.length} (${inChunk.length} бросков) → Gemini`);
      const clip = path.join(os.tmpdir(), `vedit-players-${process.pid}-${chunk.index}.mp4`);
      let up: Awaited<ReturnType<GeminiClient["upload"]>> | undefined;
      try {
        await extractEventClip(ev.source, chunk.start, chunk.end, clip, { height: 480 });
        up = await c.upload(clip, "video/mp4", `vedit-players-${chunk.index}.mp4`);
        const g = await c.generate(models, { system: loadPrompt("events.gemini.system"), parts: [{ file_data: { mime_type: up.mimeType, file_uri: up.uri }, video_metadata: { fps: 2 } }, { text: user }], schema: PLAYERS_RESPONSE_SCHEMA, mediaResolution: "low" });
        raw = { model: g.model, usage: g.usage, answer: g.data };
        await fs.writeFile(cacheFile, JSON.stringify(raw, null, 1));
        inTok += g.usage.promptTokenCount ?? 0;
        outTok += (g.usage.candidatesTokenCount ?? 0) + (g.usage.thoughtsTokenCount ?? 0);
      } catch (err) {
        warnings.push(`игроки, чанк ${chunk.index}: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
        continue;
      } finally {
        if (up) await getClient().remove(up.name);
        await fs.rm(clip, { force: true }).catch(() => {});
      }
    }
    const parsed = AnswerSchema.safeParse(raw.answer);
    if (!parsed.success) {
      warnings.push(`игроки, чанк ${chunk.index}: ответ не по схеме`);
      continue;
    }
    const m = mergeChunk(roster, parsed.data, chunk, ids);
    owners.push(...m.owners);
    if (m.owners.length < inChunk.length) warnings.push(`игроки, чанк ${chunk.index}: без автора ${inChunk.length - m.owners.length} бросков`);
  }
  if (inTok) await addCost(jobId, { step: "understand", provider: "gemini-events", model: "players", units: { requests: (client?.requests ?? 0) - before, input_tokens: inTok, output_tokens: outTok }, usd: 0 });

  // local colour signatures at the release
  let withSig: ShotOwner[] = owners.map((s) => ({ ...s, color: null, box: null }));
  if (o.local !== false) {
    log(`ищу бросавшего по полёту мяча у ${owners.length} бросков…`);
    withSig = [];
    const byId = new Map(ev.events.map((e) => [e.id, e]));
    let found = 0;
    for (const s of owners) {
      const e = byId.get(s.event)!;
      const hoop = hoopAt(ev.hoops, s.t);
      let sh: Shooter | null = null;
      try {
        sh = hoop?.rim ? await findShooter(ev.source, s.t, hoop.rim, media.width, media.height) : null;
      } catch {
        sh = null;
      }
      void e;
      if (sh) found++;
      // the ball's own track beats the model's guess of where the shooter stood
      withSig.push({ ...s, color: sh?.color ?? null, box: sh?.box ?? null, release_t: sh?.release_t ?? s.release_t, ...(sh ? { x: r3((sh.box.x + sh.box.w / 2) / media.width), y: r3((sh.box.y + sh.box.h / 2) / media.height) } : {}) });
    }
    log(`бросавший найден по мячу: ${found} из ${owners.length}`);
  }
  // every make once more, cut out at full resolution: this answer decides who scored
  const rosterNow: Person[] = [...roster.entries()].map(([id, p]) => ({ id, look: p.look, first_seen: p.first_seen, joined_at: p.joined_at, color: null, shots: 0, makes: 0 }));
  const makeEvents = ev.events.filter((e) => isShot(e) && (e.refined ? e.refined.local_verdict === "make" : e.outcome === "make") && withSig.some((s) => s.event === e.id));
  try {
    // off by default: on the test game this pass labelled 47 of 56 makes "black T-shirt, white soles" with sure = 1 and was
    // wrong on most makes that can be checked by eye, while the chunk pass was right on 11 of 13 (see README)
    const mk = o.makesPass ? await attributeMakes(ev.source, makeEvents, rosterNow, { ...o, sport: ev.sport }) : null;
    if (mk) {
      const byEvent = new Map(mk.owners.map((m) => [m.event, m]));
      withSig = withSig.map((s) => {
        const m = byEvent.get(s.event);
        return m && m.sure >= 0.4 ? { ...s, person: m.person, sure: m.sure, by: "makes" as const, reason: m.reason } : s;
      });
      inTok += mk.cached ? 0 : mk.input_tokens;
      outTok += mk.cached ? 0 : mk.output_tokens;
      log(`попадания по одному (${mk.model}): ${mk.owners.length} из ${makeEvents.length}, не совпало с общим проходом: ${mk.owners.filter((m) => withSig.find((s) => s.event === m.event)?.model_person !== m.person).length}`);
    }
  } catch (err) {
    warnings.push(`попадания по одному: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
  }
  // the colour check only reports by default: torso colours at this distance (dark T-shirts, shade) moved as many shots
  // wrongly as rightly on the test game; corrections go through players.fix.json after looking at the sheet
  const checked = reconcile(withSig);
  const rec = o.colorMoves ? checked : { shots: withSig, colors: checked.colors };
  const moved = rec.shots.filter((s) => s.moved).length;
  if (moved) log(`по цвету одежды переназначено бросков: ${moved}`);
  const makeIds = new Set(ev.events.filter((e) => isShot(e) && (e.refined ? e.refined.local_verdict === "make" : e.outcome === "make")).map((e) => e.id));
  const persons: Person[] = [...roster.entries()].map(([id, p]) => ({
    id,
    look: p.look,
    first_seen: p.first_seen,
    joined_at: p.joined_at,
    color: rec.colors.get(id) ?? null,
    shots: rec.shots.filter((s) => s.person === id).length,
    makes: rec.shots.filter((s) => s.person === id && makeIds.has(s.event)).length,
  }));
  const file: PlayersFile = { version: 1, persons, shots: rec.shots, usage: { requests: (client?.requests ?? 0) - before, input_tokens: inTok, output_tokens: outTok, cached_chunks: cachedChunks }, warnings };
  return writeJson(path.join(jobDir(jobId), "players.json"), PlayersFileSchema, file);
}

function mmssTenths(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`;
}

export async function loadPlayers(jobId: string): Promise<PlayersFile | null> {
  const f = path.join(jobDir(jobId), "players.json");
  return (await exists(f)) ? readJson(f, PlayersFileSchema) : null;
}

void mmss;

// ---------------------------------------------------------------- the shooter, found by following the ball back

interface Comp {
  n: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  cx: number;
  cy: number;
  label: number;
}

/** Connected components of a mask (4-neighbour); labels written into `label`. */
function components(mask: Uint8Array, w: number, h: number, label: Int32Array): Comp[] {
  label.fill(0);
  const stack = new Int32Array(w * h);
  const out: Comp[] = [];
  let next = 1;
  for (let q0 = 0; q0 < w * h; q0++) {
    if (!mask[q0] || label[q0]) continue;
    let top = 0;
    stack[top++] = q0;
    label[q0] = next;
    const c: Comp = { n: 0, x0: w, x1: 0, y0: h, y1: 0, cx: 0, cy: 0, label: next };
    while (top) {
      const q = stack[--top];
      const x = q % w;
      const y = (q - x) / w;
      c.n++;
      c.cx += x;
      c.cy += y;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      if (x > 0 && mask[q - 1] && !label[q - 1]) (label[q - 1] = next), (stack[top++] = q - 1);
      if (x < w - 1 && mask[q + 1] && !label[q + 1]) (label[q + 1] = next), (stack[top++] = q + 1);
      if (y > 0 && mask[q - w] && !label[q - w]) (label[q - w] = next), (stack[top++] = q - w);
      if (y < h - 1 && mask[q + w] && !label[q + w]) (label[q + w] = next), (stack[top++] = q + w);
    }
    c.cx /= c.n;
    c.cy /= c.n;
    out.push(c);
    next++;
  }
  return out;
}

export interface Shooter {
  release_t: number;
  /** ball at the release, fractions of the frame */
  ball: { x: number; y: number };
  /** the shooter's box in source px and their clothing colour: top (15–45 % of their height) and bottom (55–85 %) */
  box: { x: number; y: number; w: number; h: number };
  color: number[];
}

/**
 * Follows the ball BACK from the rim (rim moment K) through the flight to the hands that threw it, on the
 * whole frame at half size and 30 fps: moving ball-sized blobs, nearest to the backward prediction; the
 * track ends where the ball touches a person-sized moving blob — that person is the shooter. Returns
 * null when the ball cannot be followed (it flies out of the frame, or nobody moves near the release).
 */
export async function findShooter(source: string, K: number, rim: { x: number; y: number }, frameW: number, frameH: number): Promise<Shooter | null> {
  const s = 2;
  const w = Math.round(frameW / s / 2) * 2;
  const h = Math.round(frameH / s / 2) * 2;
  const fps = 30;
  const t0 = Math.max(0, K - 2.4);
  const raw = await ffmpegBuffer(["-ss", t0.toFixed(3), "-t", (K - t0 + 0.05).toFixed(3), "-i", source, "-an", "-vf", `scale=${w}:${h},fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = w * h * 3;
  const frames: Buffer[] = [];
  for (let p = 0; p + size <= raw.length; p += size) frames.push(raw.subarray(p, p + size));
  if (frames.length < 20) return null;
  // background: per-pixel median of every 4th frame
  const pick = frames.filter((_, i) => i % 4 === 0);
  const bg = Buffer.alloc(size);
  const vals = new Uint8Array(pick.length);
  for (let p = 0; p < size; p++) {
    for (let k = 0; k < pick.length; k++) vals[k] = pick[k][p];
    vals.sort();
    bg[p] = vals[vals.length >> 1];
  }
  const mask = new Uint8Array(w * h);
  const label = new Int32Array(w * h);
  const analyse = (i: number) => {
    const f = frames[i];
    for (let q = 0, p = 0; q < w * h; q++, p += 3) mask[q] = Math.abs(f[p] - bg[p]) + Math.abs(f[p + 1] - bg[p + 1]) + Math.abs(f[p + 2] - bg[p + 2]) > 55 ? 1 : 0;
    const comps = components(mask, w, h, label);
    const balls = comps.filter((c) => {
      const bw = c.x1 - c.x0 + 1;
      const bh = c.y1 - c.y0 + 1;
      return c.n >= 12 && c.n <= 900 && bw <= 40 && bh <= 40 && c.n / (bw * bh) >= 0.35 && bw / bh <= 2.2 && bh / bw <= 2.2;
    });
    const people = comps.filter((c) => c.n >= 1200 && c.y1 - c.y0 >= 50);
    return { balls, people };
  };
  const rx = rim.x * w;
  const ry = rim.y * h;
  // anything that contains the rim (the net, the pole, a player under the hoop at the rim) is not the shooter
  const notHoop = (pp: Comp) => !(rx >= pp.x0 - 4 && rx <= pp.x1 + 4 && ry >= pp.y0 - 4 && ry <= pp.y1 + 4);
  let touched: Comp | null = null;
  let touchFrame = -1;
  // 1. pick the ball up just above the ring in the last 0.4 s before the rim moment
  let start = -1;
  let last = { x: rx, y: ry, i: frames.length - 1 };
  for (let i = frames.length - 1; i >= Math.max(0, frames.length - 1 - Math.round(0.4 * fps)) && start < 0; i--) {
    const c = analyse(i).balls.filter((b) => b.cy < ry - 2 && b.cy > ry - 120 && Math.abs(b.cx - rx) < 60).sort((a, b) => Math.hypot(a.cx - rx, a.cy - ry) - Math.hypot(b.cx - rx, b.cy - ry))[0];
    if (c) (start = i), (last = { x: c.cx, y: c.cy, i });
  }
  if (start < 0) {
    if (process.env.VEDIT_DEBUG_SHOOTER) console.error("no ball above the ring");
    return null;
  }
  // 2. follow it back in time to the hands
  let prev: { x: number; y: number; i: number } | null = null;
  let points = 1;
  let gap = 0;
  for (let i = start - 1; i >= 0; i--) {
    const { balls, people } = analyse(i);
    const k = last.i - i;
    // velocity per frame going back in time
    const vx = prev ? (last.x - prev.x) / (prev.i - last.i) : 0;
    const vy = prev ? (last.y - prev.y) / (prev.i - last.i) : -4;
    const px = last.x + vx * k;
    const py = last.y + vy * k;
    const radius = (prev ? 12 : 26) + 7 * k;
    const cand = balls.map((b) => ({ b, d: Math.hypot(b.cx - px, b.cy - py) })).filter((c) => c.d <= radius).sort((a, b) => a.d - b.d)[0];
    const near = people.filter(notHoop).find((pp) => px >= pp.x0 - 10 && px <= pp.x1 + 10 && py >= pp.y0 - 10 && py <= pp.y1 + 10);
    if (!cand && near && points >= 4) {
      touched = near;
      touchFrame = i;
      break;
    }
    if (cand) {
      prev = { ...last };
      last = { x: cand.b.cx, y: cand.b.cy, i };
      points++;
      gap = 0;
    } else if (++gap > 5) {
      if (process.env.VEDIT_DEBUG_SHOOTER) console.error(`lost at frame ${last.i} (${last.x.toFixed(0)},${last.y.toFixed(0)}) after ${points} points; balls in frame: ${balls.map((b) => `${b.cx.toFixed(0)},${b.cy.toFixed(0)}:${b.n}`).join(" ")}`);
      if (points < 6) return null;
      const ps = analyse(Math.max(0, last.i - 1)).people.filter(notHoop);
      const best = ps.map((pp) => ({ pp, d: Math.hypot(Math.max(pp.x0 - last.x, 0, last.x - pp.x1), Math.max(pp.y0 - last.y, 0, last.y - pp.y1)) })).sort((a, b) => a.d - b.d)[0];
      if (best && best.d <= 40) (touched = best.pp), (touchFrame = Math.max(0, last.i - 1));
      break;
    }
  }
  const pos = { x: last.x, y: last.y };
  if (!touched || touchFrame < 0) return null;
  // clothing colour of the shooter in that frame
  const f = frames[touchFrame];
  const { people } = analyse(touchFrame); // refresh labels for this frame
  const me = people.find((pp) => Math.abs(pp.cx - touched!.cx) < 6 && Math.abs(pp.cy - touched!.cy) < 6) ?? touched;
  const band = (a: number, b: number) => {
    const ys = [Math.round(me.y0 + a * (me.y1 - me.y0)), Math.round(me.y0 + b * (me.y1 - me.y0))];
    const rs: number[] = [];
    const gs: number[] = [];
    const bs: number[] = [];
    for (let y = ys[0]; y <= ys[1]; y++)
      for (let x = me.x0; x <= me.x1; x++) {
        const q = y * w + x;
        if (label[q] !== me.label) continue;
        rs.push(f[q * 3]);
        gs.push(f[q * 3 + 1]);
        bs.push(f[q * 3 + 2]);
      }
    const med = (v: number[]) => (v.length ? v.sort((p, q) => p - q)[v.length >> 1] : 0);
    return [med(rs), med(gs), med(bs)];
  };
  return {
    release_t: Math.round((t0 + touchFrame / fps) * 100) / 100,
    ball: { x: Math.round((pos.x / w) * 1000) / 1000, y: Math.round((pos.y / h) * 1000) / 1000 },
    box: { x: me.x0 * s, y: me.y0 * s, w: (me.x1 - me.x0 + 1) * s, h: (me.y1 - me.y0 + 1) * s },
    color: [...band(0.15, 0.45), ...band(0.55, 0.85)],
  };
}

// ---------------------------------------------------------------- the makes, one by one, at full resolution

export const MAKES_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    makes: {
      type: "array",
      items: {
        type: "object",
        properties: { make: { type: "string" }, person: { type: "string" }, sure: { type: "number" }, reason: { type: "string" } },
        required: ["make", "person", "sure", "reason"],
        propertyOrdering: ["make", "person", "sure", "reason"],
      },
    },
  },
  required: ["makes"],
};

const MakesAnswerSchema = z.object({ makes: z.array(z.object({ make: z.string(), person: z.string(), sure: z.number().default(0.5), reason: z.string().default("") })) });

export interface MakeOwner {
  event: string;
  person: string;
  sure: number;
  reason: string;
}

/**
 * The players pass looks at a whole 8-minute chunk at 2 frames/s and low resolution: good enough for the
 * roster and the rough split, not for who threw a given ball. Here every MADE shot is cut out (3 s before
 * the rim moment to 1.5 s after), labelled M1, M2… in the corner, the cut-outs are joined into one video
 * at 540×960 / 10 fps with sound and sent in ONE request at the default resolution and 4 frames/s
 * (~5k tokens a make). Cached by the list of makes and the roster.
 */
export async function attributeMakes(source: string, makes: SportEvent[], roster: Person[], o: AttributeOptions & { sport?: string } = {}): Promise<{ owners: MakeOwner[]; model: string; input_tokens: number; output_tokens: number; cached: boolean } | null> {
  if (!makes.length) return null;
  const log = o.onLog ?? (() => {});
  const cacheDir = path.join(WORKSPACE_ROOT, "_cache", "events");
  const models = o.models ?? (process.env.VEDIT_EVENTS_MODEL ? process.env.VEDIT_EVENTS_MODEL.split(",").map((s) => s.trim()) : DEFAULT_EVENT_MODELS);
  const sorted = [...makes].sort((a, b) => shotTime(a) - shotTime(b));
  const rosterLines = roster.map((p) => `  ${p.id}: ${p.look || "(без описания)"}${p.joined_at !== null ? ` (пришёл около ${mmss(p.joined_at)})` : ""}`).join("\n");
  const list = sorted.map((e, i) => `  M${i + 1} — ${mmss(shotTime(e))} в полном видео`).join("\n");
  const user = fill(loadPrompt("events.makes.user"), { count: sorted.length, sport: o.sport ?? "basketball", roster: rosterLines, list });
  const stat = await fs.stat(source);
  const hash = sha(`${source}|${stat.size}|${Math.round(stat.mtimeMs)}`, user, JSON.stringify(MAKES_RESPONSE_SCHEMA), sorted.map((e) => shotTime(e).toFixed(2)).join(","));
  const cacheFile = path.join(cacheDir, `makes.${hash}.json`);
  let raw: { model: string; usage: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }; answer: unknown };
  let cached = false;
  if (await exists(cacheFile)) {
    raw = JSON.parse(await fs.readFile(cacheFile, "utf8"));
    cached = true;
    log("попадания по одному: из кэша");
  } else {
    const apiKey = o.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
    if (!apiKey && !o.client) throw new Error("нет GEMINI_API_KEY");
    const client = o.client ?? new GeminiClient({ apiKey: apiKey!, fetchFn: o.fetchFn, onLog: log });
    const tmp = path.join(os.tmpdir(), `vedit-makes-${process.pid}-${Date.now()}`);
    await fs.mkdir(tmp, { recursive: true });
    const font = "fontfile='C\\:/Windows/Fonts/arial.ttf'";
    let up: Awaited<ReturnType<GeminiClient["upload"]>> | undefined;
    try {
      log(`попадания по одному: режу ${sorted.length} фрагментов…`);
      const parts: string[] = [];
      for (const [i, e] of sorted.entries()) {
        const K = shotTime(e);
        const part = path.join(tmp, `m${i + 1}.mp4`);
        await ffmpegBuffer(["-ss", Math.max(0, K - 3).toFixed(2), "-t", "4.5", "-i", source, "-vf", `scale=540:960,fps=10,drawtext=${font}:text='M${i + 1}':x=14:y=14:fontsize=56:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=8`, "-ac", "1", "-ar", "16000", "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-c:a", "aac", "-b:a", "32k", "-y", part]);
        parts.push(part);
      }
      const listFile = path.join(tmp, "list.txt");
      await fs.writeFile(listFile, parts.map((p) => `file '${p.replace(/\\/g, "/")}'`).join("\n"));
      const joined = path.join(tmp, "makes.mp4");
      await ffmpegBuffer(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", "-y", joined]);
      up = await client.upload(joined, "video/mp4", "vedit-makes.mp4");
      log(`попадания по одному: ${sorted.length} фрагментов → Gemini`);
      const g = await client.generate(models, { system: loadPrompt("events.gemini.system"), parts: [{ file_data: { mime_type: up.mimeType, file_uri: up.uri }, video_metadata: { fps: 4 } }, { text: user }], schema: MAKES_RESPONSE_SCHEMA });
      raw = { model: g.model, usage: g.usage, answer: g.data };
      await fs.writeFile(cacheFile, JSON.stringify(raw, null, 1));
    } finally {
      if (up) await client.remove(up.name);
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }
  const a = MakesAnswerSchema.safeParse(raw.answer);
  if (!a.success) return null;
  const known = new Set(roster.map((p) => p.id));
  const owners: MakeOwner[] = [];
  for (const m of a.data.makes) {
    const i = Number(/(\d+)/.exec(m.make)?.[1] ?? NaN) - 1;
    const e = sorted[i];
    const person = normId(m.person);
    if (!e || !known.has(person)) continue;
    owners.push({ event: e.id, person, sure: clamp01(m.sure), reason: m.reason.trim() });
  }
  return { owners, model: raw.model, input_tokens: raw.usage.promptTokenCount ?? 0, output_tokens: (raw.usage.candidatesTokenCount ?? 0) + (raw.usage.thoughtsTokenCount ?? 0), cached };
}

// ---------------------------------------------------------------- corrections after looking at the sheets

/**
 * <job>/players.fix.json — corrections made after checking the "who is who" sheets by eye:
 *   { "shots": { "s1796": "P2" }, "merge": { "P6": "P2" }, "looks": { "P3": "чёрная футболка с белым принтом" } }
 * Applied on top of players.json every time the reels are planned (the automatic passes stay as they were).
 */
export const PlayersFixSchema = z.object({
  shots: z.record(z.string(), z.string()).default({}),
  merge: z.record(z.string(), z.string()).default({}),
  looks: z.record(z.string(), z.string()).default({}),
  note: z.string().optional(),
});
export type PlayersFix = z.infer<typeof PlayersFixSchema>;

export function applyFixes(p: PlayersFile, fix: PlayersFix, makeIds: Set<string>): PlayersFile {
  const target = (id: string) => {
    let t = id;
    for (let k = 0; k < 5 && fix.merge[t]; k++) t = fix.merge[t];
    return t;
  };
  const shots = p.shots.map((s) => {
    const fixed = fix.shots[s.event];
    const person = target(fixed ?? s.person);
    return person === s.person ? s : { ...s, person, moved: true };
  });
  const persons = p.persons
    .filter((x) => !fix.merge[x.id])
    .map((x) => ({ ...x, look: fix.looks[x.id] ?? x.look, shots: shots.filter((s) => s.person === x.id).length, makes: shots.filter((s) => s.person === x.id && makeIds.has(s.event)).length }));
  return { ...p, persons, shots };
}

export async function loadFixes(jobId: string): Promise<PlayersFix | null> {
  const f = path.join(jobDir(jobId), "players.fix.json");
  return (await exists(f)) ? readJson(f, PlayersFixSchema) : null;
}
