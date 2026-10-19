// Stage 30, dubbing: where each spoken phrase of the translation goes on the video's timeline. Pure functions —
// no TTS, no ffmpeg — so the timing rules are tested on their own (tests/stage30-dub.test.ts).
//
// The rules (voice-over, like Russian TV):
//   • re-sync at every phrase: the dub of phrase i always STARTS at the original phrase's start — an earlier long
//     phrase never pushes the later ones (no drift over a 2-hour podcast);
//   • a dub may run past the original phrase end into the silence before the next phrase (up to `maxOverlap` s at
//     normal speed); longer than that it is sped up (pitch kept, atempo) up to `maxSpeed` (default 1.25×);
//   • it never runs into the next phrase: whatever still does not fit is cut `gap` s before the next phrase starts
//     (with a short fade) and counted as `trimmed` — such phrases get one shorter re-translation when allowed.

export interface DubPhrase {
  /** index in the source phrase list (stable id) */
  i: number;
  /** original speech, seconds on the video timeline */
  start: number;
  end: number;
  /** the original words */
  text: string;
  /** language of the original words */
  lang?: string;
}

export interface FitOptions {
  /** end of the video (s): the last phrase may run up to it */
  mediaDuration: number;
  /** fastest playback of a dubbed phrase (atempo keeps the pitch); default 1.25 */
  maxSpeed?: number;
  /** how far past the original phrase end a dub may run at normal speed before it is sped up (s); default 0.6 */
  maxOverlap?: number;
  /** silence kept before the next phrase starts (s); default 0.08 */
  gap?: number;
}

export interface Placement {
  i: number;
  /** = the original phrase start (re-sync) */
  start: number;
  /** playback speed of the synthesised clip (1 = as spoken) */
  speed: number;
  /** length of the synthesised clip at speed 1, s */
  clip: number;
  /** length on the timeline after speed-up and trimming, s */
  out: number;
  /** seconds of (sped-up) speech cut off because the next phrase starts */
  trimmed: number;
  /** seconds the dub runs past the original phrase end (into the following silence) */
  overlap: number;
  /** the latest end allowed: next phrase start − gap (or the video end) */
  limit: number;
}

export interface FitStats {
  phrases: number;
  sped_up: number;
  trimmed: number;
  trimmed_seconds: number;
  overlapping: number;
  max_speed: number;
  mean_speed: number;
}

export const DUB_MAX_SPEED = 1.25;
export const DUB_MAX_OVERLAP = 0.6;
export const DUB_GAP = 0.08;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** The time a phrase may occupy: from its start to the next phrase start − gap (the last one: to the end of the video). */
export function phraseLimits(phrases: DubPhrase[], mediaDuration: number, gap = DUB_GAP): number[] {
  return phrases.map((p, k) => {
    const next = phrases[k + 1];
    // the next phrase starts its dub on time, whatever this one needed; overlapping transcript phrases (a fast
    // interruption) still leave this one 0.3 s
    return next ? Math.max(next.start - gap, p.start + 0.3) : Math.max(mediaDuration, p.end);
  });
}

/** Places one synthesised clip (seconds at speed 1) for phrase k. */
export function placeOne(p: DubPhrase, clipSeconds: number, limit: number, o: Pick<FitOptions, "maxSpeed" | "maxOverlap"> = {}): Placement {
  const maxSpeed = o.maxSpeed ?? DUB_MAX_SPEED;
  const maxOverlap = o.maxOverlap ?? DUB_MAX_OVERLAP;
  const available = Math.max(0.05, limit - p.start);
  const slot = Math.max(0.05, p.end - p.start);
  // at normal speed the dub may borrow a little of the silence after the phrase
  const relaxed = Math.min(available, slot + maxOverlap);
  let speed = 1;
  if (clipSeconds > relaxed) speed = Math.min(maxSpeed, clipSeconds / relaxed);
  let out = clipSeconds / speed;
  if (out > available) {
    speed = Math.min(maxSpeed, Math.max(speed, clipSeconds / available));
    out = clipSeconds / speed;
  }
  // a speed-up of under 2 % is not worth the processing (and is inaudible)
  if (speed < 1.02 && clipSeconds <= available) {
    speed = 1;
    out = clipSeconds;
  }
  const trimmed = Math.max(0, out - available);
  out -= trimmed;
  return { i: p.i, start: r3(p.start), speed: Math.round(speed * 1000) / 1000, clip: r3(clipSeconds), out: r3(out), trimmed: r3(trimmed), overlap: r3(Math.max(0, p.start + out - p.end)), limit: r3(limit) };
}

/**
 * Places every phrase: `clips[k]` is the synthesised length (s) of phrases[k] (phrases sorted by start).
 * A phrase without speech (clip 0) gets out = 0.
 */
export function fitDub(phrases: DubPhrase[], clips: number[], o: FitOptions): { placements: Placement[]; stats: FitStats } {
  if (phrases.length !== clips.length) throw new Error(`fitDub: ${phrases.length} фраз, но ${clips.length} клипов`);
  for (let k = 1; k < phrases.length; k++) if (phrases[k].start < phrases[k - 1].start) throw new Error("fitDub: фразы должны идти по времени");
  const limits = phraseLimits(phrases, o.mediaDuration, o.gap);
  const placements = phrases.map((p, k) => placeOne(p, clips[k], limits[k], o));
  return { placements, stats: fitStats(placements) };
}

export function fitStats(placements: Placement[]): FitStats {
  const spoken = placements.filter((p) => p.clip > 0);
  return {
    phrases: placements.length,
    sped_up: spoken.filter((p) => p.speed > 1).length,
    trimmed: spoken.filter((p) => p.trimmed > 0.05).length,
    trimmed_seconds: r3(spoken.reduce((s, p) => s + p.trimmed, 0)),
    overlapping: spoken.filter((p) => p.overlap > 0.05).length,
    max_speed: spoken.reduce((m, p) => Math.max(m, p.speed), 1),
    mean_speed: spoken.length ? Math.round((spoken.reduce((s, p) => s + p.speed, 0) / spoken.length) * 1000) / 1000 : 1,
  };
}

/** How many characters a phrase's translation should stay under, from the time it may occupy (chars per second of the target). */
export const DUB_CPS: Record<string, number> = { ru: 14, uz: 13, en: 15, kk: 13, tr: 14 };

export function charBudget(p: DubPhrase, limit: number, target: string, o: Pick<FitOptions, "maxOverlap"> = {}): number {
  const cps = DUB_CPS[target] ?? 14;
  const seconds = Math.min(limit - p.start, p.end - p.start + (o.maxOverlap ?? DUB_MAX_OVERLAP));
  // at least a couple of words; the speed-up (≤ 1.25×) is the reserve, not the plan
  return Math.max(12, Math.round(seconds * cps));
}

/** Speech ranges of the dub (merged across pauses shorter than `bridge`): where the original is ducked. */
export function dubRanges(placements: Placement[], bridge = 1.0, maxRanges = 1500): { start: number; end: number }[] {
  let b = bridge;
  for (;;) {
    const out: { start: number; end: number }[] = [];
    for (const p of [...placements].filter((x) => x.out > 0).sort((a, c) => a.start - c.start)) {
      const last = out[out.length - 1];
      if (last && p.start - last.end < b) last.end = Math.max(last.end, p.start + p.out);
      else out.push({ start: p.start, end: p.start + p.out });
    }
    // a very long video: fewer, longer ranges keep the ffmpeg expression small
    if (out.length <= maxRanges) return out.map((r) => ({ start: r3(r.start), end: r3(r.end) }));
    b *= 2;
  }
}

/** Seconds → SRT time "00:01:02,345". */
export function srtTime(s: number): string {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Two caption lines of at most ~`width` characters (split at the space nearest the middle). */
export function wrapCaption(text: string, width = 42): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= width) return t;
  const mid = t.length / 2;
  let best = -1;
  for (let k = t.indexOf(" "); k >= 0; k = t.indexOf(" ", k + 1)) if (best < 0 || Math.abs(k - mid) < Math.abs(best - mid)) best = k;
  return best < 0 ? t : `${t.slice(0, best)}\n${t.slice(best + 1)}`;
}

/** SRT of the dub: one cue per phrase, shown while it is spoken (at least `minShow` s, never over the next cue). */
export function dubSrt(placements: Placement[], texts: Map<number, string>, minShow = 1.0): string {
  const cues = placements.filter((p) => p.out > 0 && texts.get(p.i)?.trim()).sort((a, b) => a.start - b.start);
  return cues
    .map((p, k) => {
      const next = cues[k + 1];
      const end = Math.min(Math.max(p.start + p.out, p.start + minShow), next ? next.start - 0.02 : Infinity);
      return `${k + 1}\n${srtTime(p.start)} --> ${srtTime(Math.max(end, p.start + 0.2))}\n${wrapCaption(texts.get(p.i)!)}\n`;
    })
    .join("\n");
}
