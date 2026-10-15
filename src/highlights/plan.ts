import { z } from "zod";
import { TARGET_FPS } from "../ingest/index.ts";
import { OUTPUT_SIZE } from "../cut/index.ts";
import type { Aspect, Clip, Output } from "../schemas/index.ts";
import type { SfxCue } from "../audio/sfx.ts";
import { nearestBeat } from "../audio/beats.ts";
import { hoopAt, type HoopSample, type SportEvent } from "../understand/events.ts";

/**
 * HIGHLIGHTS PLAN (rules, pure): events → the moments worth showing → one EDL output with a speed
 * ramp and a punch-in on every featured make, a replay of the best ones, people talking as story
 * beats, cuts and impacts on the music's beats, effects and a hook title.
 *
 * A featured make is three clips cut from the 60 fps original:
 *   lead   [K − lead, K − 0.6)      1×   — the shooter, the release (court sound low)
 *   slow   [K − 0.6, T + 0.45)      0.5× — the ball flies in, punch-in 1.15→1.9× on the rim, flash at T
 *   tail   [T + 0.45, T + 1.05)     1×   — the reaction, zoom easing back
 * K = ball at the rim, T = ball inside the net (refine.ts). A replay repeats [K − 0.45, T + 0.4) at
 * 0.5× with a tighter crop. Misses (at most two) are shown at normal speed; people approaching /
 * asking to play keep their own audio and get captions.
 */

export type Role = "make" | "miss" | "social" | "moment";

/** zoom at the end of a make's run-up (the punch-in starts from here) */
export const LEAD_ZOOM = 1.15;
/** selection spreads makes over the session in windows of this length */
export const SPREAD_SECONDS = 480;

export interface HighlightPick {
  event: SportEvent;
  role: Role;
  score: number;
  replay: boolean;
  callout?: string;
  /** a short line under a people moment (what is said / happens), when the speech itself cannot be captioned */
  label?: string;
  /** consecutive makes in the source up to this one (1 = first) */
  streak: number;
}

export interface HighlightOptions {
  aspect?: Aspect;
  /** target / bounds of the output length, s */
  target?: number;
  min?: number;
  max?: number;
  maxMisses?: number;
  maxSocial?: number;
  replays?: number;
  /** max zoom on the rim */
  zoom?: number;
  slow?: number;
  title?: string;
}

const isShot = (e: SportEvent) => e.type === "shot_make" || e.type === "shot_miss" || e.type === "dunk_layup";
/** A make: the local ball track decides when it ran (the low-res model confuses makes and misses); the model only without it. */
export const isMake = (e: SportEvent) => isShot(e) && (e.refined ? e.refined.local_verdict === "make" : e.outcome === "make");
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** output length of a clip as the cut encodes it (whole frames, rounded up) */
export const outLen = (c: Pick<Clip, "src_start" | "src_end" | "speed">) => Math.ceil(((c.src_end - c.src_start) / c.speed) * TARGET_FPS - 1e-6) / TARGET_FPS;

/** rim moment and net moment of a make (local refinement when available) */
export function makeTimes(e: SportEvent): { K: number; T: number } {
  const K = e.refined?.motion_t ?? e.key;
  const T = e.refined?.through_t ?? K + 0.2;
  return { K, T: Math.max(T, K + 0.08) };
}

/** Streak index per make: consecutive made shots in source order (misses reset). */
export function streaks(events: SportEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  let run = 0;
  for (const e of [...events].filter(isShot).sort((a, b) => a.key - b.key)) {
    run = isMake(e) ? run + 1 : 0;
    if (isMake(e)) out.set(e.id, run);
  }
  return out;
}

const DIST: Record<SportEvent["distance"], number> = { long: 1, mid: 0.6, close: 0.35, unknown: 0.45 };

/** 0..1 how good a make looks: local certainty, distance, the model's quality, a clean swish. */
export function makeScore(e: SportEvent): number {
  const local = e.refined?.local_verdict === "make" ? (e.refined.motion_peak ?? 0.6) : e.confidence * 0.6;
  const { K, T } = makeTimes(e);
  const clean = e.refined?.through_t != null && T - K <= 0.15 ? 1 : 0;
  // a ball that sat on the ring before dropping is ambiguous on camera (in, or off the front) and less clean: last resort
  return r3((0.4 * local + 0.25 * DIST[e.distance] + 0.2 * e.quality + 0.15 * clean) * (e.refined?.rolled ? 0.5 : 1));
}

/** Estimated output seconds of a pick (before beat snapping). */
export function estimateSeconds(p: Pick<HighlightPick, "role" | "replay" | "event">, slow = 0.5): number {
  if (p.role === "make") {
    const { K, T } = makeTimes(p.event);
    const s = (T + 0.45 - (K - 0.6)) / slow;
    return 1.5 + s + 0.6 + (p.replay ? (T + 0.4 - (K - 0.45)) / slow : 0);
  }
  if (p.role === "social") return Math.min(7, p.event.end - p.event.start);
  return Math.min(3.2, p.event.end - p.event.start);
}

const overlaps = (a: SportEvent, b: SportEvent, pad = 1) => a.start - pad < b.end && b.start - pad < a.end;

/**
 * Picks the moments: makes by score (no overlaps), 1–2 social beats, misses only to fill (≤ maxMisses,
 * funny / low-scrutiny ones first); replays on the best makes; the strongest make opens, the rest are
 * chronological. Callouts: a streak of 3+ ("x3"), a clean long make ("ЧИСТЫЙ"); at most 3. Makes are spread over the session (SPREAD_SECONDS windows).
 */
export function selectHighlights(events: SportEvent[], o: HighlightOptions = {}): { picks: HighlightPick[]; seconds: number; notes: string[] } {
  const target = o.target ?? 50;
  const max = o.max ?? 60;
  const notes: string[] = [];
  const st = streaks(events);
  const chosen: HighlightPick[] = [];
  let seconds = 2.5; // the title rides on the opener; a little slack for beat snapping
  const fits = (p: HighlightPick, limit: number) => seconds + estimateSeconds(p, o.slow) <= limit && !chosen.some((c) => overlaps(c.event, p.event));
  const add = (p: HighlightPick) => {
    chosen.push(p);
    seconds += estimateSeconds(p, o.slow);
  };

  const social = events
    .filter((e) => e.type === "people_approach" && e.end - e.start >= 2.5)
    .sort((a, b) => Number(b.speech) - Number(a.speech) || b.confidence - a.confidence || b.quality - a.quality);
  for (const e of social.slice(0, o.maxSocial ?? 2)) {
    const p: HighlightPick = { event: e, role: "social", score: e.quality, replay: false, streak: 0 };
    if (fits(p, target * 0.45)) add(p);
  }
  // the whole session, not just its best stretch: each make already taken from the same ~8 min costs the next one 0.1
  const pool = events.filter(isMake).map((e) => ({ e, s: makeScore(e) }));
  const bin = (e: SportEvent) => Math.floor(e.key / SPREAD_SECONDS);
  while (seconds < target && pool.length) {
    const taken = (e: SportEvent) => chosen.filter((c) => c.role === "make" && bin(c.event) === bin(e)).length;
    pool.sort((a, b) => b.s - 0.1 * taken(b.e) - (a.s - 0.1 * taken(a.e)));
    const { e, s } = pool.shift()!;
    const p: HighlightPick = { event: e, role: "make", score: s, replay: false, streak: st.get(e.id) ?? 1 };
    if (fits(p, max)) add(p);
  }
  // replays on the best makes while there is room
  const byScore = chosen.filter((p) => p.role === "make").sort((a, b) => b.score - a.score);
  let replays = 0;
  for (const p of byScore) {
    if (replays >= (o.replays ?? 1)) break;
    const extra = estimateSeconds({ ...p, replay: true }, o.slow) - estimateSeconds(p, o.slow);
    if (seconds + extra <= max) {
      p.replay = true;
      seconds += extra;
      replays++;
    }
  }
  // fill with a couple of misses (funny first) when the makes run out
  if (seconds < (o.min ?? 45)) {
    const misses = events
      .filter((e) => (isShot(e) && e.outcome === "miss") || e.type === "funny" || e.type === "celebration")
      .sort((a, b) => Number(b.type === "funny") - Number(a.type === "funny") || b.quality - a.quality);
    let n = 0;
    for (const e of misses) {
      if (n >= (o.maxMisses ?? 2) || seconds >= (o.min ?? 45)) break;
      const p: HighlightPick = { event: e, role: isShot(e) ? "miss" : "moment", score: e.quality, replay: false, streak: 0 };
      if (fits(p, max)) (add(p), n++);
    }
  }
  if (seconds < (o.min ?? 45)) notes.push(`материала на ${seconds.toFixed(0)} с — меньше цели ${o.min ?? 45} с: удачных бросков мало`);

  // callouts, by priority: streaks, then clean long makes; at most 3
  const label = (p: HighlightPick): string | undefined => {
    const { K, T } = makeTimes(p.event);
    if (p.streak >= 3) return `x${p.streak}`;
    if (p.event.distance === "long" && T - K <= 0.12 && p.event.refined?.local_verdict === "make") return "ЧИСТЫЙ";
    return undefined;
  };
  const prio = (t: string) => (t.startsWith("x") ? 0 : 1);
  const labelled = chosen.filter((p) => p.role === "make").map((p) => ({ p, t: label(p) })).filter((x): x is { p: HighlightPick; t: string } => !!x.t);
  for (const { p, t } of labelled.sort((a, b) => prio(a.t) - prio(b.t) || b.p.score - a.p.score).slice(0, 3)) p.callout = t;

  // the strongest make opens, the rest in source order
  const best = chosen.filter((p) => p.role === "make").sort((a, b) => b.score - a.score)[0];
  const rest = chosen.filter((p) => p !== best).sort((a, b) => a.event.start - b.event.start);
  const picks = best ? [best, ...rest] : rest;
  return { picks, seconds: r3(seconds), notes };
}

// ---------------------------------------------------------------- EDL

export interface HighlightEdlOptions extends HighlightOptions {
  hoops: HoopSample[];
  /** source frame size (to place the zoom point inside the output crop) */
  frame: { width: number; height: number };
  /** beat times on the output timeline (music starts at 0) */
  beats?: number[];
  /** captions for the social clips (language of their speech) */
  captionsLanguage?: string;
  title?: string;
  /** music already chosen (beats come from it) */
  music?: { file: string; offset: number };
}

export interface HighlightEdl {
  output: Output;
  /** output ranges with people talking (music dips there) */
  speech: { start: number; end: number }[];
  /** per pick: where it landed on the output timeline */
  timeline: { id: string; role: Role; start: number; end: number; impact: number | null; beat_aligned: boolean; callout?: string; replay: boolean; description: string }[];
}

/** Zoom point as a fraction of the output crop, from a point in the source frame (centre crop to the output aspect). */
export function zoomPoint(p: { x: number; y: number }, frame: { width: number; height: number }, aspect: Aspect): { x: number; y: number } {
  const { w, h } = OUTPUT_SIZE[aspect];
  const cw = Math.min(frame.width, frame.height * (w / h));
  const ch = Math.min(frame.height, frame.width / (w / h));
  const x = (p.x * frame.width - (frame.width - cw) / 2) / cw;
  const y = (p.y * frame.height - (frame.height - ch) / 2) / ch;
  return { x: Math.min(1, Math.max(0, r3(x))), y: Math.min(1, Math.max(0, r3(y))) };
}

/**
 * Picks → EDL output. Walks the output timeline: for every make the lead is stretched/shortened by up
 * to ±0.3 s so the net moment (flash, swish) lands on a beat, and the tail by up to ±0.15 s so the cut
 * lands on a beat (never shorter than 0.35 s). Times account for whole-frame rounding of every clip.
 */
export function buildHighlightEdl(picks: HighlightPick[], o: HighlightEdlOptions): HighlightEdl {
  const aspect = o.aspect ?? "9:16";
  const slow = o.slow ?? 0.5;
  const maxZoom = o.zoom ?? 1.9;
  const beats = o.beats ?? [];
  const clips: Clip[] = [];
  const sfx: SfxCue[] = [];
  const titles: Output["titles"] = [];
  const speech: HighlightEdl["speech"] = [];
  const timeline: HighlightEdl["timeline"] = [];
  let cursor = 0;
  const push = (c: Clip) => {
    clips.push(c);
    const start = cursor;
    cursor = r3(cursor + outLen(c));
    return start;
  };
  const target = (e: SportEvent) => {
    const h = hoopAt(o.hoops, e.key);
    const p = h?.rim ?? e.target ?? { x: 0.5, y: 0.45 };
    return zoomPoint(p, o.frame, aspect);
  };

  picks.forEach((p, idx) => {
    const e = p.event;
    const pickStart = cursor;
    let impact: number | null = null;
    let aligned = false;
    if (p.role === "make") {
      const { K, T } = makeTimes(e);
      const z = target(e);
      const slowStart = K - 0.6;
      const slowEnd = T + 0.45;
      // lead: 1.5 s (2.2 s for the opener: the title sits on it), nudged so the impact hits a beat
      let lead = idx === 0 ? 2.2 : 1.5;
      const slowLenOut = Math.ceil(((slowEnd - slowStart) / slow) * TARGET_FPS - 1e-6) / TARGET_FPS;
      const impactIn = (T - slowStart) / slow;
      if (beats.length) {
        const leadOut = Math.ceil(lead * TARGET_FPS - 1e-6) / TARGET_FPS;
        const at = cursor + leadOut + impactIn;
        const b = nearestBeat(beats.filter((x) => x > cursor + 0.9 + impactIn), at, 0.3);
        if (b !== null) {
          lead = Math.min(2.6, Math.max(0.9, lead + (b - at)));
          aligned = true;
        }
      }
      const leadStart = Math.max(0, slowStart - lead);
      // a slow push toward the hoop over the run-up (1 → 1.15), so the punch-in continues a movement instead of jumping
      push({ src_start: r3(leadStart), src_end: r3(slowStart), speed: 1, crop: "center", volume: 0.6, hfr: true, zoom: { ...z, from: 1, to: LEAD_ZOOM, ease: r3(slowStart - leadStart), at: 0 } });
      const slowAt = cursor;
      push({ src_start: r3(slowStart), src_end: r3(slowEnd), speed: slow, crop: "center", volume: 0, hfr: true, zoom: { ...z, from: LEAD_ZOOM, to: maxZoom, ease: 0.45, at: 0 }, flash: [r3(impactIn)], shake: idx === 0 || p.replay ? [r3(impactIn)] : undefined });
      impact = r3(slowAt + impactIn);
      sfx.push({ t: r3(Math.max(0, slowAt - 0.12)), kind: "whoosh", gain: -3 }, { t: impact, kind: "swish", gain: 0 });
      if (idx === 0 || p.replay) sfx.push({ t: impact, kind: "impact", gain: -6 });
      void slowLenOut;
      // tail: reaction, zoom easing back; the cut lands on a beat when one is near
      let tail = 0.6;
      if (beats.length) {
        const end = cursor + Math.ceil(tail * TARGET_FPS - 1e-6) / TARGET_FPS;
        const b = nearestBeat(beats, end, 0.15);
        if (b !== null && b - cursor >= 0.35) tail = b - cursor;
      }
      push({ src_start: r3(slowEnd), src_end: r3(slowEnd + tail), speed: 1, crop: "center", volume: 0.6, hfr: true, zoom: { ...z, from: maxZoom, to: 1.15, ease: Math.min(0.4, tail), at: 0 } });
      if (p.replay) {
        const rs = K - 0.45;
        const re = T + 0.4;
        const rAt = cursor;
        const rImpact = (T - rs) / slow;
        push({ src_start: r3(rs), src_end: r3(re), speed: slow, crop: "center", volume: 0, hfr: true, zoom: { ...z, y: Math.min(1, z.y + 0.02), from: maxZoom + 0.25, to: maxZoom + 0.4, ease: 1.5, at: 0 }, flash: [r3(rImpact)] });
        sfx.push({ t: r3(rAt), kind: "whoosh", gain: -4 }, { t: r3(rAt + rImpact), kind: "swish", gain: -2 });
      }
      if (p.callout) titles.push({ at: r3(impact + 0.12), duration: 1.4, text: p.callout, style: "callout" });
    } else if (p.role === "social") {
      const end = Math.min(e.end, e.start + 7);
      const s = push({ src_start: r3(e.start), src_end: r3(end), speed: 1, crop: "center", volume: 1, hfr: true });
      speech.push({ start: s, end: cursor });
      if (p.label) titles.push({ at: r3(s + 0.3), duration: r3(Math.max(1, cursor - s - 0.6)), text: p.label, style: "lower" });
    } else {
      // a miss / a moment at normal speed, short, with its own sound a bit up
      const K = e.refined?.motion_t ?? e.key;
      const s0 = Math.max(e.start, K - 1.8);
      const s1 = Math.min(e.end + 0.5, K + 1.2);
      push({ src_start: r3(s0), src_end: r3(Math.max(s1, s0 + 1.5)), speed: 1, crop: "center", volume: 0.8, hfr: true });
    }
    timeline.push({ id: e.id, role: p.role, start: r3(pickStart), end: cursor, impact, beat_aligned: aligned, callout: p.callout, replay: p.replay, description: e.description });
  });

  const title = (o.title ?? "").trim();
  if (title) titles.unshift({ at: 0.15, duration: 2.4, text: title, style: "hero" });
  const output: Output = {
    id: "highlights",
    aspect,
    target_duration: o.target ?? 50,
    clips,
    captions: speech.length ? { enabled: true, language: o.captionsLanguage ?? "ru", style: "bold_pop" } : { enabled: false },
    titles,
    music: { enabled: true },
    transitions: "cut",
    sfx,
    audio: { ...(o.music ? { music: o.music.file, music_offset: o.music.offset } : { music_offset: 0 }), music_lufs: -15, orig_gain_db: -2, duck: speech },
  };
  return { output, speech, timeline };
}

// ---------------------------------------------------------------- the editor's call (Claude), optional

export const HighlightDirectionSchema = z.object({
  title: z.string().describe("hook title, 1–3 words, uppercase, in the language of the instruction; no emojis, no hashtags"),
  opener: z.string().describe("id of the make that opens the edit"),
  drop: z.array(z.string()).describe("ids of candidates to leave out (repetitive, weak)"),
  callouts: z.array(z.object({ id: z.string(), text: z.string().describe("≤ 12 chars, e.g. ЧИСТЫЙ, x3, С ЦЕНТРА") })).describe("at most 3"),
  labels: z.array(z.object({ id: z.string(), text: z.string().describe("≤ 40 chars, what the person says or does, in the language of the instruction, e.g. «Не играл с 2008-го — и сразу в игру»") })).describe("one per people moment (role social), factual, from its description"),
  reasoning: z.string().describe("1–3 sentences for the user, in the language of the instruction"),
});
export type HighlightDirection = z.infer<typeof HighlightDirectionSchema>;

/** Applies an editor's direction to the rule-based selection; unknown ids are ignored, the title is cleaned. */
export function applyDirection(picks: HighlightPick[], d: HighlightDirection): { picks: HighlightPick[]; title: string; notes: string[] } {
  const notes: string[] = [];
  const ids = new Set(picks.map((p) => p.event.id));
  const drop = new Set(d.drop.filter((id) => ids.has(id)));
  // never drop below 4 makes
  const makes = picks.filter((p) => p.role === "make");
  for (const id of [...drop]) if (makes.filter((p) => !drop.has(p.event.id)).length < 4 && makes.some((p) => p.event.id === id)) drop.delete(id);
  let kept = picks.filter((p) => !drop.has(p.event.id));
  if (drop.size) notes.push(`редактор убрал: ${[...drop].join(", ")}`);
  // "x3" stays lowercase (a multiplier), words are uppercase labels
  const cl = new Map(d.callouts.slice(0, 3).filter((c) => ids.has(c.id)).map((c) => [c.id, /^x\d+$/i.test(c.text.trim()) ? c.text.trim().toLowerCase() : c.text.trim().toUpperCase().slice(0, 14)]));
  const lb = new Map((d.labels ?? []).filter((l) => ids.has(l.id) && l.text.trim()).map((l) => [l.id, l.text.replace(/\p{Extended_Pictographic}/gu, "").trim().slice(0, 48)]));
  kept = kept.map((p) => ({ ...p, callout: cl.size ? cl.get(p.event.id) : p.callout, label: p.role === "social" ? (lb.get(p.event.id) ?? p.label) : p.label }));
  const opener = kept.find((p) => p.event.id === d.opener && p.role === "make");
  if (opener) kept = [opener, ...kept.filter((p) => p !== opener).sort((a, b) => a.event.start - b.event.start)];
  const title = d.title.replace(/#\S+/g, "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim().toUpperCase().slice(0, 28);
  return { picks: kept, title, notes };
}

/** Compact candidate list for the editor model. */
export function candidatesText(picks: HighlightPick[]): string {
  return picks
    .map((p) => {
      const e = p.event;
      const m = Math.floor(e.key / 60);
      const s = Math.round(e.key - m * 60);
      const local = e.refined ? ` local=${e.refined.local_verdict}` : "";
      return `${e.id} ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${p.role}${p.role === "make" ? ` score=${p.score} dist=${e.distance} streak=${p.streak}` : ""}${local}${p.callout ? ` callout=${p.callout}` : ""} — ${e.description}`;
    })
    .join("\n");
}

/**
 * Tops a selection up to the target with the best unused makes (after the editor dropped some, or when
 * the estimate was short): no overlaps, not the dropped ids; the opener stays first, the rest chronological.
 */
export function refill(picks: HighlightPick[], events: SportEvent[], o: { target: number; max: number; exclude?: Set<string>; slow?: number }): HighlightPick[] {
  let seconds = 2.5 + picks.reduce((s, p) => s + estimateSeconds(p, o.slow), 0);
  if (seconds >= o.target - 2) return picks;
  const st = streaks(events);
  const used = new Set(picks.map((p) => p.event.id));
  const extra: HighlightPick[] = [];
  for (const e of events.filter(isMake).sort((a, b) => makeScore(b) - makeScore(a))) {
    if (seconds >= o.target - 2) break;
    if (used.has(e.id) || o.exclude?.has(e.id)) continue;
    if ([...picks, ...extra].some((p) => overlaps(p.event, e))) continue;
    const p: HighlightPick = { event: e, role: "make", score: makeScore(e), replay: false, streak: st.get(e.id) ?? 1 };
    const s = estimateSeconds(p, o.slow);
    if (seconds + s > o.max) continue;
    extra.push(p);
    seconds += s;
  }
  if (!extra.length) return picks;
  const [first, ...rest] = picks;
  return [first, ...[...rest, ...extra].sort((a, b) => a.event.start - b.event.start)];
}
