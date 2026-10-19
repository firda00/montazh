import fs from "node:fs/promises";
import path from "node:path";
import type { SfxCue } from "../audio/sfx.ts";
import { FRAMES } from "../lib/aspect.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { DEFAULT_GEMINI_MODEL, priceUsage } from "../understand/vision/gemini.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { brandMark } from "../make/brandmarks.ts";
import { commonsCreditLine } from "../make/commons.ts";
import type { BeatSpeech } from "../make/scenes.ts";
import type { Script } from "../make/script.ts";
import { mergeEntities, resolveVisuals, type VisualPlan } from "../make/visual-resolve.ts";
import { entityFromLlm, hashOf, KNOWN_ENTITIES, readCache, VISUALS_CACHE, writeCache, type EntityDef, type NumberMention, type VisualOption } from "../make/visuals.ts";
import type { DesignSpec } from "../schemas/index.ts";
import { boxesBetween, type FaceBox, type FaceTrack } from "./faces.ts";
import { DEFAULT_FUNCTION_WORDS } from "./layout.ts";
import { cutoutStill, judgeStillCutout } from "./matte.ts";
import { captureSite, domainOf, officialSite } from "./site-capture.ts";
import type { OutPhrase } from "./timeline.ts";

/**
 * Stage 27 (P1-1 + P1-5 + P1-6): B-roll inserts in a talking-head montage, after reels #14 (Маргулан: full-frame
 * cutaways on the named thing, a cut-out photo of the person talked about on the chest) and #15 (Таневский: the company's
 * mobile site scrolling on its name, a logo card with fact chips stacking on each number, the last one inverted).
 *
 *   1. what is said — the word-level transcript of the CUT (output seconds): dictionary entities and numbers
 *      (src/make/visuals.ts), plus ONE cheap Gemini flash-lite call for names the dictionary does not know, concrete
 *      photographable things («летающий автомобиль»), and a ≤ 4-word chip text per number;
 *   2. what can be shown — the stage-26 resolver (verified Commons photos, Simple Icons marks, code-drawn UI), the
 *      company's website (site-capture.ts), a person's photo cut out by the MediaPipe sidecar (matte.ts);
 *   3. when — scheduleInserts(), deterministic: an insert starts 0.1 s before its word; a thing/action/product → a
 *      full-frame cutaway 3–4 s; a person → a PiP 2–3 s on the chest (never over the face); a company → its site
 *      4–6 s; numbers → a chips layer; inserts concentrate in the first 40 % of the reel, take 25–35 % of the
 *      runtime, and leave ≥ 1.5 s of the head between two full-frame inserts;
 *   4. how — src/design/hyperframes/inserts-layer.ts draws them under the captions (captions stay on top, in place).
 */

export type InsertKind = "cutaway" | "pip" | "site" | "chips";
export const FULL_FRAME: ReadonlySet<InsertKind> = new Set(["cutaway", "site"]);

/** fractions of the frame */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Chip {
  text: string;
  /** output time the chip pops in (its number's word) */
  at: number;
  /** the punchline: black pill, white text */
  invert: boolean;
}

export interface InsertItem {
  id: string;
  kind: InsertKind;
  start: number;
  end: number;
  /** the word that triggers it (onset, output s) and its text */
  t: number;
  word: string;
  entity?: string;
  /** for logs and the contact sheet: «Tesla — сайт tesla.com» */
  label: string;
  /** cutaway: the pane (stage-26 option: photo / logo / ui / number) */
  pane?: VisualOption;
  /** pip: the cut-out PNG or the photo; site: the tall screenshot */
  image?: string;
  /** pip: image has an alpha channel (cut out) */
  cutout?: boolean;
  /** pip image height / width */
  aspect?: number;
  box?: Box;
  site?: { domain: string; width: number; height: number };
  chips?: { logo?: { name: string; path?: string; hex?: string }; items: Chip[]; scale: number };
  /** on-frame credit of a photo */
  credit?: string;
  /** the licensed photo it shows (credits) */
  source?: string;
}

export interface InsertsTrack {
  items: InsertItem[];
  cues: SfxCue[];
  /** description lines (photo licences, trademarks, website captures) */
  credits: string[];
  stats: InsertStats;
}

export interface InsertStats {
  duration: number;
  candidates: number;
  scheduled: number;
  /** share of the runtime under inserts (chips count half: the head stays visible) */
  coverage: number;
  /** share of the insert time inside the first 40 % of the reel */
  first40: number;
  by_kind: Record<string, number>;
  gemini: { calls: number; usd: number; cached: boolean; model: string };
  vision: { requests: number; usd: number; candidates: number; passed: number };
  captures: { tried: number; ok: number; cached: number };
  cutouts: { tried: number; ok: number };
  skipped: string[];
}

// ---------------------------------------------------------------- scheduling (pure)

export type Density = DesignSpec["inserts"]["density"];
export const DENSITY_SHARE: Record<Density, number> = { low: 0.18, normal: 0.3, high: 0.35 };
/** never more than this share of the runtime under inserts */
export const MAX_SHARE = 0.35;

export const DURATIONS: Record<InsertKind, { min: number; max: number }> = {
  cutaway: { min: 3, max: 4 },
  pip: { min: 2, max: 3 },
  site: { min: 4, max: 6 },
  chips: { min: 2.5, max: 13 },
};

export interface InsertCandidate {
  /** entity id, «#<number group>» or a thing id: one insert per key within REPEAT_GAP */
  key: string;
  kind: InsertKind;
  /** onset of the trigger word (output s) */
  t: number;
  word: string;
  /** end of the phrase the word is in (the insert lasts about to the end of the thought) */
  phraseEnd: number;
  priority: number;
  /** chips: the time of the last chip (the layer holds a little after it) */
  lastAt?: number;
}

export interface ScheduledInsert {
  key: string;
  kind: InsertKind;
  start: number;
  end: number;
  t: number;
  word: string;
}

export interface ScheduleOptions {
  duration: number;
  density?: Density;
  /** no insert before this (the hook: the voice first, the first insert at 1.2–2.3 s) */
  minStart?: number;
  /** head between two full-frame inserts */
  gapFull?: number;
  /** head between any two inserts */
  gapAny?: number;
  /** after the first 40 %: head before and after an insert */
  gapLater?: number;
  /** the trigger leads the word by this much */
  lead?: number;
  /** an insert pushed later than its word by more than this (by minStart) is dropped: it must land on the word */
  maxDelay?: number;
  fps?: number;
}

export const REPEAT_GAP = 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** How long an insert of this kind triggered at `start` lasts, given the end of its phrase (and the chips' last item). */
export function insertDuration(c: Pick<InsertCandidate, "kind" | "phraseEnd" | "lastAt">, start: number): number {
  const d = DURATIONS[c.kind];
  if (c.kind === "chips") return Math.min(d.max, Math.max(d.min, (c.lastAt ?? start) + 3 - start));
  const tail = c.kind === "site" ? c.phraseEnd + 0.6 - start : c.phraseEnd + 0.25 - start;
  return Math.min(d.max, Math.max(d.min, tail));
}

/** Budget weight: the chips layer leaves the head on screen, so it counts half. */
export const weightOf = (kind: InsertKind) => (kind === "chips" ? 0.5 : 1);

/**
 * The insert schedule (pure, deterministic). Phase A walks the first 40 % of the reel in time order (of candidates
 * said within 1.2 s of each other the higher priority wins); phase B fills the rest by priority with ≥ `gapLater` s of
 * head around each insert and never more insert time than phase A took (concentration in the story part). Constraints:
 * start = word − lead (≥ minStart), no overlaps, ≥ gapFull of head between two full-frame inserts and ≥ gapAny between
 * any two, the same key not again within REPEAT_GAP s, nothing in the last 0.4 s, the budget (density share, ≤ 35 %).
 */
export function scheduleInserts(cands: InsertCandidate[], o: ScheduleOptions): ScheduledInsert[] {
  const D = o.duration;
  const lead = o.lead ?? 0.1;
  const fps = o.fps ?? 30;
  const grid = (x: number) => r3(Math.round(x * fps) / fps);
  const minStart = o.minStart ?? 1.0;
  const gapFull = o.gapFull ?? 1.5;
  const gapAny = o.gapAny ?? 0.3;
  const gapLater = o.gapLater ?? 4;
  const budget = D * Math.min(MAX_SHARE, DENSITY_SHARE[o.density ?? "normal"]);
  const split = 0.4 * D;
  const out: ScheduledInsert[] = [];
  let used = 0;
  let usedA = 0;

  const fits = (s: ScheduledInsert, later: boolean): boolean => {
    if (s.start < minStart - 1e-6 || s.end > D - 0.4 + 1e-6 || s.end - s.start < DURATIONS[s.kind].min - 1e-6) return false;
    for (const x of out) {
      const full = FULL_FRAME.has(s.kind) && FULL_FRAME.has(x.kind);
      const gap = later ? Math.max(gapLater, full ? gapFull : gapAny) : full ? gapFull : gapAny;
      if (s.start < x.end + gap - 1e-6 && x.start < s.end + gap - 1e-6) return false;
      if (x.key === s.key && Math.abs(x.t - s.t) < REPEAT_GAP) return false;
    }
    return true;
  };
  const maxDelay = o.maxDelay ?? 1.2;
  const make = (c: InsertCandidate, room: number): ScheduledInsert | null => {
    // a name said during the hook title may wait for it a little longer (the viewer has just heard it)
    if (minStart - (c.t - lead) > (c.t - lead < minStart ? Math.max(maxDelay, 2) : maxDelay) + 1e-6) return null;
    const start = grid(Math.max(minStart, c.t - lead));
    let dur = insertDuration(c, start);
    dur = Math.min(dur, D - 0.4 - start, room / weightOf(c.kind));
    if (dur < DURATIONS[c.kind].min - 1e-6) return null;
    return { key: c.key, kind: c.kind, start, end: grid(start + dur), t: c.t, word: c.word };
  };

  // phase A: the story part, in time order; a cluster of candidates said close together → its best one
  const early = cands.filter((c) => c.t - lead < split).sort((a, b) => a.t - b.t || b.priority - a.priority);
  for (let i = 0; i < early.length; i++) {
    const c = early[i];
    const rival = early.find((x) => x !== c && Math.abs(x.t - c.t) <= 1.2 && (x.priority > c.priority || (x.priority === c.priority && x.t < c.t)));
    if (rival && make(rival, budget - used) && fits(make(rival, budget - used)!, false)) continue;
    const s = make(c, budget - used);
    if (!s || !fits(s, false)) continue;
    out.push(s);
    out.sort((a, b) => a.start - b.start);
    used += (s.end - s.start) * weightOf(s.kind);
    usedA += (s.end - s.start) * weightOf(s.kind);
  }
  // phase B: the rest by priority, sparser, never more than the story part got
  const capB = usedA > 0 ? Math.min(budget - used, usedA) : budget * 0.5;
  let usedB = 0;
  const late = cands.filter((c) => c.t - lead >= split).sort((a, b) => b.priority - a.priority || a.t - b.t);
  for (const c of late) {
    const s = make(c, Math.min(budget - used, capB - usedB));
    if (!s || !fits(s, true)) continue;
    out.push(s);
    out.sort((a, b) => a.start - b.start);
    const w = (s.end - s.start) * weightOf(s.kind);
    used += w;
    usedB += w;
  }
  return out;
}

/** Coverage and first-40 % share of a schedule. */
export function scheduleStats(s: Pick<ScheduledInsert, "kind" | "start" | "end">[], duration: number): { coverage: number; first40: number } {
  const total = s.reduce((n, x) => n + (x.end - x.start) * weightOf(x.kind), 0);
  const early = s.reduce((n, x) => n + Math.max(0, Math.min(x.end, 0.4 * duration) - x.start) * weightOf(x.kind), 0);
  return { coverage: duration > 0 ? r3(total / duration) : 0, first40: total > 0 ? r3(early / total) : 0 };
}

/**
 * Numbers → chip groups: numbers said within `gap` (7) s of the previous one join its group (≤ 4 chips); a group of two or
 * more ends on its punchline — the last chip inverted (reel #15: «Продали за $500к»).
 */
export function chipGroups(nums: { t: number; text: string }[], o: { gap?: number; max?: number } = {}): Chip[][] {
  const gap = o.gap ?? 7;
  const max = o.max ?? 4;
  const groups: Chip[][] = [];
  for (const n of [...nums].sort((a, b) => a.t - b.t)) {
    const g = groups[groups.length - 1];
    if (g && n.t - g[g.length - 1].at <= gap && g.length < max && n.t - g[0].at <= DURATIONS.chips.max - 3) g.push({ text: n.text, at: n.t, invert: false });
    else groups.push([{ text: n.text, at: n.t, invert: false }]);
  }
  for (const g of groups) if (g.length >= 2) g[g.length - 1].invert = true;
  return groups;
}

// ---------------------------------------------------------------- placement (pure)

/** Union of the face boxes over a span (fractions), or null. */
export function faceUnion(faces: FaceTrack | undefined, t0: number, t1: number): FaceBox | null {
  const boxes = faces && faces.source !== "none" ? boxesBetween(faces, t0, t1) : [];
  if (!boxes.length) return null;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

/** Where a talking head usually is when nothing better is known (upper middle). */
export const TYPICAL_FACE: FaceBox = [0.3, 0.24, 0.7, 0.5];

/**
 * The PiP on the chest (reel #14): ≈ 30 % of the width, centred under the face, between the chin (+2 %) and the top of the
 * captions; shrinks to 18 % before giving up; then beside the face (the wider side); null when it would cover the face.
 * `aspect` = height / width of the picture; W/H the frame.
 */
export function pipBox(face: FaceBox | null, captionTop: number, aspect: number, W: number, H: number, o: { width?: number; minWidth?: number; safeTop?: number } = {}): Box | null {
  const f = face ?? TYPICAL_FACE;
  const ratio = (aspect * W) / H; // box height (fraction of H) per unit of width (fraction of W)
  const top = f[3] + 0.02;
  const bottom = captionTop - 0.012;
  const cx = Math.min(0.75, Math.max(0.25, (f[0] + f[2]) / 2));
  for (let w = o.width ?? 0.3; w >= (o.minWidth ?? 0.18) - 1e-9; w -= 0.02) {
    const h = w * ratio;
    if (bottom - top >= h) return { x: r3(cx - w / 2), y: r3(bottom - h), w: r3(w), h: r3(h) };
  }
  // beside the face: the wider side, vertically centred on the face's lower half
  const left = f[0] - 0.04;
  const right = 1 - f[2] - 0.04;
  const side = Math.max(left, right);
  const w = Math.min(0.3, side - 0.02);
  if (w >= (o.minWidth ?? 0.18)) {
    const h = w * ratio;
    const y = Math.max(o.safeTop ?? 0.1, Math.min(bottom - h, (f[1] + f[3]) / 2 - h / 2 + 0.05));
    if (y + h <= bottom + 1e-9) return { x: r3(left >= right ? f[0] - 0.02 - w : f[2] + 0.02), y: r3(y), w: r3(w), h: r3(h) };
  }
  return null;
}

/**
 * The chips column (logo card + pills): the largest free band — above the face, on the chest above the captions, or the
 * wider side next to the face. Returns the box and a scale (1 = logo 0.075 H + pills 0.05 H each) or null.
 */
export function chipsBox(face: FaceBox | null, captionTop: number, n: number, o: { safeTop?: number; logo?: boolean } = {}): { box: Box; scale: number } | null {
  const f = face ?? TYPICAL_FACE;
  const need = (o.logo === false ? 0 : 0.085) + n * 0.058;
  const safeTop = o.safeTop ?? 0.09;
  const bands: Box[] = [
    { x: 0.08, y: safeTop, w: 0.84, h: f[1] - 0.025 - safeTop },
    { x: 0.08, y: f[3] + 0.02, w: 0.84, h: captionTop - 0.015 - (f[3] + 0.02) },
    { x: 0.05, y: safeTop, w: f[0] - 0.08, h: captionTop - 0.015 - safeTop },
    { x: f[2] + 0.03, y: safeTop, w: 0.95 - (f[2] + 0.03), h: captionTop - 0.015 - safeTop },
  ].filter((b) => b.w >= 0.26 && b.h > 0.08);
  let best: { box: Box; scale: number } | null = null;
  for (const b of bands) {
    const scale = Math.min(1, b.h / need, b.w / 0.6);
    if (scale < 0.55) continue;
    if (!best || scale > best.scale + 0.05 || (Math.abs(scale - best.scale) <= 0.05 && b.w > best.box.w)) best = { box: { x: r3(b.x), y: r3(b.y), w: r3(b.w), h: r3(b.h) }, scale: r3(scale) };
  }
  return best;
}

/** Sound of the inserts: a whoosh on a full-frame insert, a pop on a PiP and on every chip. */
export function insertCues(items: Pick<InsertItem, "kind" | "start" | "chips">[]): SfxCue[] {
  const cues: SfxCue[] = [];
  for (const it of items) {
    if (it.kind === "cutaway") cues.push({ t: r3(Math.max(0, it.start - 0.12)), kind: "whoosh", gain: -11 });
    else if (it.kind === "site") cues.push({ t: r3(Math.max(0, it.start - 0.12)), kind: "swipe", gain: -9 });
    else if (it.kind === "pip") cues.push({ t: r3(it.start), kind: "pop", gain: -10 });
    else for (const c of it.chips?.items ?? []) cues.push({ t: r3(c.at), kind: "pop", gain: c.invert ? -7 : -10 });
  }
  return cues.sort((a, b) => a.t - b.t);
}

// ---------------------------------------------------------------- the cheap LLM pass

const LLM_SCHEMA = {
  type: "OBJECT",
  properties: {
    entities: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: { name: { type: "STRING" }, kind: { type: "STRING", enum: ["company", "product", "person", "place", "exchange", "org"] }, forms: { type: "ARRAY", items: { type: "STRING" } }, commons_query: { type: "STRING" }, subject: { type: "STRING" } },
        required: ["name", "kind", "forms", "commons_query", "subject"],
      },
    },
    things: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { phrase: { type: "INTEGER" }, words: { type: "STRING" }, query: { type: "STRING" }, subject: { type: "STRING" } }, required: ["phrase", "words", "query", "subject"] },
    },
    chips: { type: "ARRAY", items: { type: "OBJECT", properties: { number: { type: "INTEGER" }, text: { type: "STRING" } }, required: ["number", "text"] } },
  },
  required: ["entities", "things", "chips"],
};

const LLM_SYSTEM = [
  "You prepare B-roll inserts for a short vertical video of a person talking to the camera. You get the spoken phrases (numbered) and the numbers found in them.",
  "entities: named companies, products, people (not the speaker), places, organisations that the phrases mention. name: the usual written name (Latin for brands: Tesla, SpaceX; people in the video's language). forms: every exact spelling of it in the phrases, inflected forms included, copied verbatim. commons_query: an English Wikimedia Commons search for a real photograph OF it (the product itself, the building, the person's full name). subject: what a photo must clearly show (English).",
  "things: at most 5 concrete, photographable objects or actions the speaker names that are not entities (\"летающий автомобиль\" → a flying car, \"запуск ракеты\" → a rocket launch, \"тюлень\" → a seal). words: the exact words of that phrase (verbatim, 1–4 words). query: 2–4 English nouns for a photo search. Skip abstractions, feelings, the speaker, metaphors and hypotheticals («как если бы…»), weapons, violence, war casualties and anything gory.",
  "chips: for every number given, a fact chip of at most 4 words in the language of the phrases that says what the number is, the number compact with its unit and currency as said (\"2021 подняли $27M\", \"штраф $20 млн\", \"40 млн долларов\"). Never invent facts, years or units that are not in the phrase.",
  "Return JSON only.",
].join(" ");

export interface LlmInserts {
  entities: { name: string; kind: string; forms: string[]; commons_query: string; subject: string }[];
  things: { phrase: number; words: string; query: string; subject: string }[];
  chips: { number: number; text: string }[];
}

export async function insertsLlm(phrases: { text: string }[], numbers: { phrase: number; text: string }[], hints: string[], language: string, o: { key?: string; client?: GeminiClient; onLog?: (l: string) => void } = {}): Promise<{ data: LlmInserts; model: string; usd: number; cached: boolean } | null> {
  const lines = phrases.map((p, i) => `${i}: ${p.text}`).join("\n");
  const nums = numbers.map((n, i) => `${i}: «${n.text}» (phrase ${n.phrase})`).join("\n");
  const user = `LANGUAGE: ${language}\nPHRASES:\n${lines}\nNUMBERS:\n${nums || "(none)"}${hints.length ? `\nTHE EDITOR MARKED AS WORTH SHOWING: ${hints.join(", ")}` : ""}`;
  const key = hashOf(["inserts-llm/1", user]);
  const cacheDir = path.join(VISUALS_CACHE, "inserts");
  const hit = await readCache<{ data: LlmInserts; model: string }>(cacheDir, key);
  if (hit) return { ...hit, usd: 0, cached: true };
  const apiKey = o.key ?? geminiApiKey();
  if (!apiKey && !o.client) return null;
  const client = o.client ?? new GeminiClient({ apiKey: apiKey!, rounds: 1, roundWaitMs: 15_000, maxRetries: 2, backoffMs: 4000, onLog: o.onLog });
  const models = (process.env.VEDIT_VISUAL_LLM_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const r = await client.generate(models.length ? models : [DEFAULT_GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-3.5-flash"], { system: LLM_SYSTEM, parts: [{ text: user }], schema: LLM_SCHEMA, temperature: 0, rounds: 1 });
  const d = r.data as Partial<LlmInserts>;
  const data: LlmInserts = { entities: d.entities ?? [], things: (d.things ?? []).slice(0, 5), chips: d.chips ?? [] };
  await writeCache(cacheDir, key, { data, model: r.model });
  return { data, model: r.model, usd: priceUsage(r.model, r.usage).usd, cached: false };
}

/** A concrete thing the LLM found → a matchable «entity» with a Commons search (no brand mark: kind place). */
const NUMBERISH = /\d|миллион|миллиард|триллион|тысяч|доллар|рубл|процент|million|billion|thousand|dollar|percent/i;

/** things never shown as B-roll in someone's talk (a metaphor about a gun is not a cue for a gun photo) */
export const UNSHOWABLE = /\b(guns?|pistols?|rifles?|weapons?|knife|knives|blood|corpses?|dead body|bombs?|explosions?|war|soldiers?|hostages?|terror\w*|kill\w*|murder\w*|suicide|drugs?|nude|naked)\b/i;

export function thingEntity(x: { words: string; query: string; subject: string }): EntityDef | null {
  if (UNSHOWABLE.test(`${x.query} ${x.subject}`)) return null;
  // the trigger is the noun, not a leading preposition («на телефоне» → «телефоне»)
  const fw = new Set(Object.values(DEFAULT_FUNCTION_WORDS).flat());
  const toks = x.words.replace(/\s+/g, " ").trim().split(" ");
  while (toks.length > 1 && fw.has(toks[0].toLowerCase())) toks.shift();
  const words = toks.join(" ");
  if (!words || words.length > 60 || !x.query.trim()) return null;
  const def = entityFromLlm({ name: words, kind: "place", forms: [words], commons_query: x.query.trim(), subject: x.subject || x.query });
  if (!def) return null;
  const title = x.query.toLowerCase().split(/\s+/).filter((w) => w.length >= 4);
  return { ...def, id: def.id.replace(/^x-/, "t-"), titleWords: title.length ? title : [x.query.toLowerCase()] };
}

/** Planner hints that a mention matches (case-insensitive substring either way). */
export function hinted(hints: string[], ...texts: string[]): boolean {
  const ts = texts.map((t) => t.toLowerCase()).filter(Boolean);
  return hints.some((h) => {
    const k = h.trim().toLowerCase();
    return !!k && ts.some((t) => t.includes(k) || k.includes(t));
  });
}

const numText = (n: NumberMention) => `${n.shown}${n.unit && n.unit !== "%" ? ` ${n.unit}` : n.unit}`;

// ---------------------------------------------------------------- the orchestrator

export interface BuildInsertsInput {
  jobId: string;
  phrases: OutPhrase[];
  duration: number;
  language: string;
  design: DesignSpec;
  faces?: FaceTrack;
  hints?: string[];
  /** end of the hook title at the start (the first insert comes after it, ≤ 1.8 s; the title is then cut there) */
  hookEnd?: number;
  /** where crops, cut-outs and the report go (design/<output>-inserts) */
  dir: string;
  W: number;
  H: number;
  fps: number;
}

export interface BuildInsertsOptions {
  offline?: boolean;
  key?: string;
  client?: GeminiClient;
  fetchFn?: typeof fetch;
  /** site capture (default design.inserts.site_capture) */
  capture?: typeof captureSite;
  onLog?: (l: string) => void;
}

/** What each candidate can show, before scheduling. */
interface Resolved {
  cand: InsertCandidate;
  entity?: string;
  label: string;
  pane?: VisualOption;
  pip?: { image: string; cutout: boolean; aspect: number; credit?: string; photo: string };
  site?: { image: string; domain: string; width: number; height: number };
  chips?: { logo?: { name: string; path?: string; hex?: string }; items: Chip[] };
}

const KIND_OF: Record<string, "person" | "company" | "product" | "place"> = { person: "person", company: "company", org: "company", exchange: "company", product: "product", place: "place" };

export async function buildInserts(inp: BuildInsertsInput, o: BuildInsertsOptions = {}): Promise<InsertsTrack> {
  const say = (l: string) => o.onLog?.(l);
  const I = inp.design.inserts;
  const hints = inp.hints ?? [];
  const phrases = inp.phrases.filter((p) => p.words.length);
  const skipped: string[] = [];
  const stats: InsertStats = {
    duration: inp.duration,
    candidates: 0,
    scheduled: 0,
    coverage: 0,
    first40: 0,
    by_kind: {},
    gemini: { calls: 0, usd: 0, cached: false, model: "" },
    vision: { requests: 0, usd: 0, candidates: 0, passed: 0 },
    captures: { tried: 0, ok: 0, cached: 0 },
    cutouts: { tried: 0, ok: 0 },
    skipped,
  };
  if (!phrases.length) return { items: [], cues: [], credits: [], stats };

  // 1. a pseudo-script: one «beat» per phrase of the cut, the speech words in output seconds
  const script = { title: "montage", language: inp.language, hashtags: [], beats: phrases.map((p) => ({ text: p.text.slice(0, 140) || "…", emphasis: "", icon: "sparkles", seconds: Math.max(2, p.end - p.start), voiceover: p.text })) } as unknown as Script;
  const speech: BeatSpeech[] = phrases.map((p) => ({ start: p.start, end: p.end, words: p.words.map((w) => ({ text: w.w, start: w.start, end: w.end })) }));

  // 2. the cheap LLM pass (entities the dictionary lacks, things, chip texts) — numbers first, locally
  const { findNumbers } = await import("../make/visuals.ts");
  const dollars = /\$|доллар|dollar|usd/i.test(phrases.map((p) => p.text).join(" "));
  const localNums = speech.flatMap((s, i) => findNumbers(s.words, { dollars }).map((n) => ({ ...n, phrase: i })));
  let llm: Awaited<ReturnType<typeof insertsLlm>> = null;
  if (!o.offline && process.env.VEDIT_VISUAL_LLM?.trim().toLowerCase() !== "off") {
    try {
      llm = await insertsLlm(phrases, localNums.map((n) => ({ phrase: n.phrase, text: n.text })), hints, inp.language, { key: o.key, client: o.client, onLog: (l) => say(`  ${l}`) });
      if (llm) {
        stats.gemini = { calls: llm.cached ? 0 : 1, usd: llm.usd, cached: llm.cached, model: llm.model };
        say(`  вставки: Gemini ${llm.model}${llm.cached ? " (кэш)" : ` $${llm.usd.toFixed(4)}`} — сущности ${llm.data.entities.map((e) => e.name).join(", ") || "—"}; предметы ${llm.data.things.map((t) => t.words).join(", ") || "—"}`);
      }
    } catch (err) {
      say(`  ⚠ вставки: разбор Gemini не удался: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
    }
  }
  const entities = mergeEntities(llm ? [{ beat: 0, entities: llm.data.entities, series: [], intent: "" }] : null, KNOWN_ENTITIES);
  // numbers are chips, not «things» («40 миллионов долларов» is not a photo of cash)
  const things = (llm?.data.things ?? []).filter((x) => !NUMBERISH.test(x.words)).map(thingEntity).filter((x): x is EntityDef => !!x && !entities.some((e) => e.id === x.id));
  const allDefs = [...entities, ...things];
  const byId = new Map(allDefs.map((e) => [e.id, e]));

  // 3. what can be shown: verified photos, marks, UI (stage 26 resolver on the pseudo-script)
  const photosDir = path.join(inp.dir, "photos");
  await fs.mkdir(photosDir, { recursive: true });
  let plan: VisualPlan;
  try {
    plan = await resolveVisuals(script, speech, { frame: FRAMES["9:16"], outDir: photosDir, entities: allDefs, offline: o.offline, key: o.key, client: o.client, fetchFn: o.fetchFn, candidates: 2, photosPerEntity: 1, onEvent: (l) => say(`  ${l.trim()}`) });
  } catch (err) {
    say(`  ⚠ вставки: поиск картинок не удался: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return { items: [], cues: [], credits: [], stats };
  }
  stats.vision = { requests: plan.checks.requests, usd: plan.checks.usd, candidates: plan.checks.candidates, passed: plan.checks.passed };

  // 4. candidates per mention
  const resolved: Resolved[] = [];
  const firstMention = new Map<string, number>();
  const capture = o.capture ?? captureSite;
  const siteOf = new Map<string, Resolved["site"] | null>();
  const pipOf = new Map<string, Resolved["pip"] | null>();
  const cutDir = path.join(inp.dir, "cutout");
  for (const b of plan.beats) {
    const ph = phrases[b.beat];
    for (const m of b.mentions) {
      const def = byId.get(m.entity);
      if (!def) continue;
      const nth = firstMention.get(m.entity) ?? 0;
      firstMention.set(m.entity, nth + 1);
      if (nth >= 2) continue; // an entity gets at most two tries
      const isThing = def.id.startsWith("t-");
      const kind = isThing ? "thing" : KIND_OF[def.kind] ?? "place";
      const opts = b.options.filter((x) => x.entity === m.entity && x.numberIndex === undefined);
      const photo = opts.filter((x) => x.kind === "photo").sort((a, z) => (z.score ?? 0) - (a.score ?? 0))[0];
      const logo = opts.find((x) => x.kind === "logo");
      const ui = opts.find((x) => x.kind === "ui");
      const word = (ph.words[m.word]?.w ?? m.text).replace(/^[«"“(]+|[»"”),.:;!?…]+$/g, "");
      const pri = (base: number) => base + (hinted(hints, m.text, def.name) ? 2 : 0) + (m.t < 0.4 * inp.duration ? 0.5 : 0);
      const label = (what: string) => `${def.name} — ${what}`;
      const base = { key: m.entity, t: m.t, word, phraseEnd: ph.end };
      // a person: the cut-out photo on the chest (or a rounded card); without a photo nothing (people are never drawn)
      if (kind === "person") {
        if (!photo?.file) {
          skipped.push(`${def.name}: нет проверенного фото`);
          continue;
        }
        if (I.pip) {
          if (!pipOf.has(m.entity)) {
            stats.cutouts.tried++;
            let pip: Resolved["pip"] | null = { image: photo.file, cutout: false, aspect: 1.25, credit: photo.credit ? shortCredit(photo.credit) : undefined, photo: photo.file };
            const cut = o.offline ? null : await cutoutStill(photo.file, cutDir, { onLog: (l) => say(`  ${l}`) }).catch(() => null);
            if (cut) {
              const v = judgeStillCutout(cut.stats);
              if (v.ok && cut.stats.size) {
                pip = { ...pip, image: cut.png, cutout: true, aspect: cut.stats.size[1] / cut.stats.size[0] };
                stats.cutouts.ok++;
              } else say(`  вырезка ${def.name}: ${v.reasons.join("; ")} — карточка с фото`);
            }
            pipOf.set(m.entity, pip);
          }
          const pip = pipOf.get(m.entity);
          // a spot on the chest must exist around the time it would show (else the full-frame photo takes over)
          if (pip && !pipBox(faceUnion(inp.faces, m.t, m.t + 2.6), inp.design.captions.anchor_y - 0.035, pip.aspect, inp.W, inp.H)) skipped.push(`${def.name}: на груди нет места для фото — полный кадр`);
          else if (pip) resolved.push({ cand: { ...base, kind: "pip", priority: pri(5) }, entity: m.entity, label: label(pip.cutout ? "фото без фона на груди" : "фото в карточке"), pip });
        }
        resolved.push({ cand: { ...base, key: `${m.entity}~cut`, kind: "cutaway", priority: pri(2.5) }, entity: m.entity, label: label("фото на весь кадр"), pane: photo });
        continue;
      }
      // a company: its website (first mention), else a photo / its product UI / its mark
      if (kind === "company" && I.site_capture && nth === 0 && !o.offline) {
        if (!siteOf.has(m.entity) && stats.captures.tried < 2) {
          let site: Resolved["site"] | null = null;
          try {
            const url = await officialSite({ id: def.id, name: def.name }, { fetchFn: o.fetchFn });
            if (url) {
              stats.captures.tried++;
              const c = await capture(url.url, { onLog: (l) => say(`  ${l}`) });
              if (c.cached) stats.captures.cached++;
              stats.captures.ok++;
              site = { image: c.file, domain: c.domain || domainOf(url.url), width: c.width, height: c.height };
            } else skipped.push(`${def.name}: официальный сайт не найден`);
          } catch (err) {
            say(`  ⚠ сайт ${def.name}: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
          }
          siteOf.set(m.entity, site);
        }
        const site = siteOf.get(m.entity);
        if (site) resolved.push({ cand: { ...base, kind: "site", priority: pri(5) }, entity: m.entity, label: label(`сайт ${site.domain}`), site });
      }
      const pane = photo?.file ? photo : kind === "product" ? (ui ?? logo) : (logo ?? ui);
      if (pane && (kind !== "place" && kind !== "thing" ? true : pane.kind === "photo")) {
        const score = pane.kind === "photo" ? 3.5 + (pane.score ?? 6) / 10 : pane.kind === "ui" ? 3 : 2.2;
        resolved.push({ cand: { ...base, key: `${m.entity}~cut`, kind: "cutaway", priority: pri(score) }, entity: m.entity, label: label(pane.kind === "photo" ? "фото" : pane.kind === "ui" ? "интерфейс" : "знак"), pane });
      } else if (!pane) skipped.push(`${def.name}: нечего показать (нет фото/знака)`);
    }
  }

  // 5. numbers → chips (logo of the company named last before the group)
  if (I.chips) {
    const nums = plan.beats.flatMap((b) => b.numbers.map((n) => ({ n, beat: b.beat })));
    const chipText = (i: number, n: NumberMention) => {
      const t = llm?.data.chips.find((c) => c.number === i)?.text?.replace(/\s+/g, " ").trim();
      return t && t.length <= 32 && /\d/.test(t) ? t : numText(n);
    };
    const flat = nums.map(({ n }, i) => ({ t: n.t, text: chipText(i, n) }));
    const companyMentions = plan.beats.flatMap((b) => b.mentions.filter((m) => KIND_OF[byId.get(m.entity)?.kind ?? ""] === "company" && !m.entity.startsWith("t-")));
    let gi = 0;
    for (const g of chipGroups(flat)) {
      const owner = [...companyMentions].reverse().find((m) => m.t <= g[0].at + 0.5);
      let logo: { name: string; path?: string; hex?: string } | undefined;
      if (owner) {
        const def = byId.get(owner.entity)!;
        const mk = def.icon && !o.offline ? await brandMark(def.icon, { fetchFn: o.fetchFn }).catch(() => null) : null;
        logo = { name: def.name, ...(mk ? { path: mk.path, hex: mk.hex } : {}) };
      }
      const ph = phrases.find((p) => p.start <= g[0].at + 1e-6 && p.end >= g[0].at - 1e-6) ?? phrases[0];
      if (!chipsBox(faceUnion(inp.faces, g[0].at, g[g.length - 1].at + 3), inp.design.captions.anchor_y - 0.035, g.length, { logo: !!logo })) {
        skipped.push(`чипы ${g.map((c) => c.text).join(" · ")}: нет свободного места вне лица`);
        continue;
      }
      const word = ph.words.find((w) => Math.abs(w.start - g[0].at) < 1e-3)?.w ?? g[0].text;
      resolved.push({ cand: { key: `#${gi++}`, kind: "chips", t: g[0].at, word, phraseEnd: ph.end, lastAt: g[g.length - 1].at, priority: 4 + (g.length > 1 ? 1 : 0) }, label: `чипы: ${g.map((c) => c.text).join(" · ")}`, chips: { ...(logo ? { logo } : {}), items: g } });
    }
  }
  stats.candidates = resolved.length;

  // 6. the schedule, then placement (PiP / chips need a free spot off the face, else they are dropped)
  const sched = scheduleInserts(resolved.map((r) => r.cand), { duration: inp.duration, density: I.density, fps: inp.fps, minStart: Math.max(1, Math.min(inp.hookEnd ?? 0, 1.8)) });
  const captionTop = inp.design.captions.anchor_y - 0.035;
  const items: InsertItem[] = [];
  for (const s of sched) {
    const r = resolved.find((x) => x.cand.key === s.key && x.cand.kind === s.kind && Math.abs(x.cand.t - s.t) < 1e-6)!;
    const face = faceUnion(inp.faces, s.start, s.end);
    const base = { id: `i${items.length}`, kind: s.kind, start: s.start, end: s.end, t: s.t, word: s.word, label: r.label, ...(r.entity ? { entity: r.entity } : {}) };
    if (s.kind === "pip" && r.pip) {
      const box = pipBox(face, captionTop, r.pip.aspect, inp.W, inp.H);
      if (!box) {
        skipped.push(`${r.label}: нет места на груди — пропущено`);
        continue;
      }
      items.push({ ...base, image: r.pip.image, cutout: r.pip.cutout, aspect: r.pip.aspect, box, source: r.pip.photo, ...(r.pip.credit ? { credit: r.pip.credit } : {}) });
    } else if (s.kind === "chips" && r.chips) {
      const cb = chipsBox(face, captionTop, r.chips.items.length, { logo: !!r.chips.logo });
      if (!cb) {
        skipped.push(`${r.label}: нет места для чипов — пропущено`);
        continue;
      }
      items.push({ ...base, box: cb.box, chips: { ...r.chips, scale: cb.scale } });
    } else if (s.kind === "site" && r.site) {
      items.push({ ...base, image: r.site.image, box: { x: 0.1, y: 0.1, w: 0.8, h: 0.66 }, site: { domain: r.site.domain, width: r.site.width, height: r.site.height } });
    } else if (s.kind === "cutaway" && r.pane) {
      items.push({ ...base, pane: r.pane, ...(r.pane.file ? { source: r.pane.file } : {}), ...(r.pane.credit ? { credit: shortCredit(r.pane.credit) } : {}) });
    }
  }
  const st = scheduleStats(items, inp.duration);
  stats.scheduled = items.length;
  stats.coverage = st.coverage;
  stats.first40 = st.first40;
  for (const it of items) stats.by_kind[it.kind] = (stats.by_kind[it.kind] ?? 0) + 1;
  // trademark lines only for marks actually drawn (a logo pane, the logo card of the chips)
  const marksShown = [...items.filter((i) => i.pane?.kind === "logo").map((i) => i.pane!.name ?? ""), ...items.filter((i) => i.chips?.logo?.path).map((i) => i.chips!.logo!.name)].filter(Boolean);
  const credits = [
    ...plan.credits.filter((c) => items.some((i) => i.source === c.file)).map((c) => commonsCreditLine({ title: c.title, artist: c.creator, license_short: c.license === "pdm" ? "Public domain" : c.license === "cc0" ? "CC0" : `CC ${c.license.toUpperCase()} ${c.license_version}`.trim(), descriptionUrl: c.url })),
    ...plan.brandCredits.filter((l) => marksShown.some((name) => l.startsWith(`Знак ${name}:`))),
    ...items.filter((i) => i.site).map((i) => `Скрин сайта ${i.site!.domain}: главная страница компании, о которой идёт речь (редакционное номинативное использование)`),
  ];
  return { items, cues: I.sfx ? insertCues(items) : [], credits: [...new Set(credits)], stats };
}

/** «фото: Gage Skidmore · CC BY-SA 2.0 · wikimedia commons» */
function shortCredit(c: { creator: string; license: string; license_version: string; source: string }): string {
  const lic = c.license === "cc0" ? "CC0" : c.license === "pdm" ? "Public Domain" : `CC ${c.license.toUpperCase()} ${c.license_version}`.trim();
  return [`фото: ${c.creator || "автор не указан"}`.slice(0, 40), lic, c.source].filter(Boolean).join(" · ");
}
