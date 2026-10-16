import type { Clip, Transcript } from "../schemas/index.ts";
import type { SfxPlan, ZoomPlan } from "./map.ts";

/**
 * Aggressive cleanup for the reference style (stage 22), deterministic, on word timestamps:
 *  - a pause between two kept words longer than `silenceMs` splits the clip (jump cut); each piece keeps a small
 *    handle (`handleMs`, never reaching into a neighbouring word), so words are never clipped;
 *  - pure hesitations (э, ммм, uh, um…) are always dropped; ambiguous fillers (ну, короче, типа, like…) only
 *    when they stand alone between pauses or open a clip (a "ну" inside a fluent sentence stays);
 *  - retakes are left to the planner (planner_rules block).
 * Edges always sit outside words: start ≥ end of the previous word, end ≤ start of the next one.
 */

type Word = Transcript["segments"][number]["words"][number];

/** hesitation sounds: always removed (ru / uz / en) */
export const HESITATIONS = new Set(["э", "ээ", "эээ", "эм", "эмм", "ммм", "мм", "м", "хм", "хмм", "а-а", "ааа", "е", "ее", "uh", "uhh", "um", "umm", "uhm", "er", "erm", "hmm", "hm", "mm", "mmm", "ah", "eh", "ee", "eee", "mmm"]);
/** filler words: removed only when standalone (between pauses / opening a clip) */
export const FILLERS = new Set(["ну", "короче", "типа", "вот", "значит", "собственно", "like", "basically", "actually", "literally", "xullas", "haligi", "anaqa", "ya'ni", "yani", "ya’ni", "endi"]);
/** two-word fillers (both words go) */
export const FILLER_PAIRS = new Set(["как бы", "так сказать", "в общем", "в принципе", "you know", "i mean", "kind of", "sort of"]);

export interface JumpCutOptions {
  silenceMs: number;
  removeFillers: boolean;
  /** silence kept around each piece, ms */
  handleMs?: number;
  /** pieces closer than this are merged (no micro cuts), s */
  mergeBelow?: number;
  /** a pause at least this long around an ambiguous filler makes it "standalone", s */
  standaloneGap?: number;
  /** pieces longer than this are split at a word gap (fast references), s */
  maxPiece?: number;
}

export const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'’-]+/gu, "").replace(/^-+|-+$/g, "");

export function isHesitation(w: string): boolean {
  const n = norm(w);
  // "э-э", "м-м-м": hyphenated hesitations are the same sound
  return HESITATIONS.has(n) || /^(э+|м+|а+|hm+|um+|uh+|e+|m+)$/u.test(n.replace(/[-’']/g, "")) && n.replace(/[-’']/g, "").length >= (n.startsWith("а") ? 2 : 1);
}

/** indexes (into `words`) of fillers to drop */
export function fillerIndexes(words: Word[], o: { standaloneGap?: number } = {}): Set<number> {
  const gap = o.standaloneGap ?? 0.12;
  const out = new Set<number>();
  const gapBefore = (i: number) => (i === 0 ? Infinity : words[i].start - words[i - 1].end);
  const gapAfter = (i: number) => (i === words.length - 1 ? Infinity : words[i + 1].start - words[i].end);
  for (let i = 0; i < words.length; i++) {
    const n = norm(words[i].w);
    if (!n) continue;
    if (isHesitation(words[i].w)) {
      out.add(i);
      continue;
    }
    if (i + 1 < words.length && FILLER_PAIRS.has(`${n} ${norm(words[i + 1].w)}`)) {
      // "как бы" as a hedge sits between pauses; "как бы ты сделал" is a question
      if ((gapBefore(i) >= gap || i === 0) && gapAfter(i + 1) >= gap) out.add(i).add(i + 1);
      continue;
    }
    if (FILLERS.has(n) && (gapBefore(i) >= gap || i === 0) && gapAfter(i) >= gap) out.add(i);
  }
  return out;
}

export interface Piece {
  start: number;
  end: number;
}

/**
 * One planned clip → the pieces that remain after the cleanup (source seconds). A clip without words
 * (b-roll, silence the planner chose on purpose) stays as it is.
 */
export function jumpCutClip(clip: Pick<Clip, "src_start" | "src_end">, all: Word[], o: JumpCutOptions): { pieces: Piece[]; removedFillers: string[]; removedSilence: number } {
  const handle = (o.handleMs ?? 40) / 1000;
  const silence = o.silenceMs / 1000;
  const mergeBelow = o.mergeBelow ?? 0.08;
  const words = all.filter((w) => (w.start + w.end) / 2 >= clip.src_start && (w.start + w.end) / 2 <= clip.src_end);
  if (!words.length) return { pieces: [{ start: clip.src_start, end: clip.src_end }], removedFillers: [], removedSilence: 0 };
  const drop = o.removeFillers ? fillerIndexes(words) : new Set<number>();
  const removedFillers = [...drop].sort((a, b) => a - b).map((i) => words[i].w);
  // neighbours of any word (kept or not) bound the handles: a piece never reaches into another word
  const prevEnd = (i: number) => (i === 0 ? clip.src_start : words[i - 1].end);
  const nextStart = (i: number) => (i === words.length - 1 ? clip.src_end : words[i + 1].start);

  // group kept words into runs: a dropped filler or a long pause ends a run
  const runs: { a: number; b: number }[] = [];
  let cur: { a: number; b: number } | null = null;
  for (let i = 0; i < words.length; i++) {
    if (drop.has(i)) {
      if (cur) runs.push(cur), (cur = null);
      continue;
    }
    if (cur && words[i].start - words[cur.b].end > silence) runs.push(cur), (cur = null);
    if (!cur) cur = { a: i, b: i };
    else cur.b = i;
  }
  if (cur) runs.push(cur);
  if (!runs.length) return { pieces: [], removedFillers, removedSilence: clip.src_end - clip.src_start };

  const pieces: Piece[] = runs.map((r, k) => {
    const first = words[r.a];
    const last = words[r.b];
    // the clip's own edges stay when the silence there is short (the planner chose them)
    const leadIn = first.start - prevEnd(r.a);
    const tail = nextStart(r.b) - last.end;
    const start = k === 0 && r.a === 0 && leadIn <= silence ? clip.src_start : Math.max(prevEnd(r.a), first.start - Math.min(handle, leadIn / 2));
    const end = k === runs.length - 1 && r.b === words.length - 1 && tail <= silence ? clip.src_end : Math.min(nextStart(r.b), last.end + Math.min(handle, tail / 2));
    return { start: Math.max(clip.src_start, start), end: Math.min(clip.src_end, end) };
  });
  // a cut that removes almost nothing is a glitch, not a jump cut
  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && p.start - prev.end < mergeBelow) prev.end = p.end;
    else merged.push({ ...p });
  }
  const kept = merged.reduce((s, p) => s + (p.end - p.start), 0);
  // a fast reference cuts every ~1.5 s even inside a sentence (the framing alternates): long pieces are split
  // at the word gap nearest their middle — nothing is removed there, the cut only changes the framing
  const split = o.maxPiece ? merged.flatMap((p) => splitLong(p, words, o.maxPiece!)) : merged;
  return { pieces: split.filter((p) => p.end - p.start > 0.04), removedFillers, removedSilence: Math.max(0, clip.src_end - clip.src_start - kept) };
}

/** Splits a piece longer than `max` seconds at word gaps (each side ≥ 0.6 s), recursively. */
export function splitLong(p: Piece, words: Word[], max: number, minSide = 0.6): Piece[] {
  if (p.end - p.start <= max) return [p];
  const mid = (p.start + p.end) / 2;
  let best: number | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1];
    const b = words[i];
    if (a.end <= p.start || b.start >= p.end) continue;
    const t = (a.end + b.start) / 2;
    if (t - p.start < minSide || p.end - t < minSide) continue;
    if (best === null || Math.abs(t - mid) < Math.abs(best - mid)) best = t;
  }
  if (best === null) return [p];
  const cut = round3(best);
  return [...splitLong({ start: p.start, end: cut }, words, max, minSide), ...splitLong({ start: cut, end: p.end }, words, max, minSide)];
}

export interface CleanedClip extends Clip {
  /** index of the planned clip this piece comes from */
  from: number;
  /** the planner asked for a punch-in on this clip (rare_emphasis / every_2_3_sentences) */
  punch?: boolean;
}

/** Every planned clip → its pieces (speed, crop and the planner's punch-in mark are inherited). */
export function jumpCutClips(clips: (Clip & { punch?: boolean })[], transcript: Transcript, o: JumpCutOptions): { clips: CleanedClip[]; fillers: string[]; removedSeconds: number } {
  const words = transcript.segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  const out: CleanedClip[] = [];
  const fillers: string[] = [];
  let removed = 0;
  clips.forEach((c, i) => {
    const r = jumpCutClip(c, words, o);
    fillers.push(...r.removedFillers);
    removed += r.removedSilence / c.speed;
    r.pieces.forEach((p, k) => out.push({ ...c, src_start: round3(p.start), src_end: round3(p.end), from: i, ...(c.punch && k === 0 ? { punch: true } : { punch: undefined }) }));
  });
  return { clips: out, fillers, removedSeconds: removed };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** which pieces punch in (indexes), by the zoom frequency of the reference */
export function zoomTargets(clips: CleanedClip[], z: ZoomPlan, phraseOf: (t: number) => number): Set<number> {
  const out = new Set<number>();
  if (z.mode === "none" || !clips.length) return out;
  if (z.onHook) out.add(0);
  switch (z.frequency) {
    case "every_cut_aggressive":
      // alternate the framing on every cut: wide, tight, wide, tight… (a jump cut in the same framing reads as a glitch)
      clips.forEach((_, i) => i % 2 === (z.onHook ? 0 : 1) && out.add(i));
      break;
    case "every_2_3_sentences": {
      // every 2nd / 3rd new phrase, plus what the planner marked
      let seen = -1;
      let count = 0;
      clips.forEach((c, i) => {
        const p = phraseOf(c.src_start + 0.05);
        if (p !== seen) {
          seen = p;
          count++;
          if (count % 5 === 2 || count % 5 === 0) out.add(i);
        }
        if (c.punch) out.add(i);
      });
      break;
    }
    case "rare_emphasis": {
      clips.forEach((c, i) => c.punch && out.add(i));
      if (out.size === (z.onHook ? 1 : 0)) {
        // the planner marked nothing: punch in on the longest piece of the middle third
        const third = Math.floor(clips.length / 3);
        let best = -1;
        for (let i = third; i < Math.max(third + 1, 2 * third); i++) if (clips[i] && (best < 0 || clips[i].src_end - clips[i].src_start > clips[best].src_end - clips[best].src_start)) best = i;
        if (best >= 0) out.add(best);
      }
      break;
    }
    case "none":
      break;
  }
  return out;
}

/** zoom field of one punched-in piece (toward the upper middle, where the face usually is) */
export function zoomField(z: ZoomPlan, pieceSeconds: number): Clip["zoom"] {
  const at = { x: 0.5, y: 0.4 };
  if (z.mode === "instant") return { ...at, from: z.scale, to: z.scale, ease: 0, at: 0 };
  if (z.mode === "ease") return { ...at, from: 1, to: z.scale, ease: z.ease || 0.25, at: 0 };
  return { ...at, from: 1, to: z.scale, ease: Math.max(0.5, pieceSeconds), at: 0 };
}

/** zooms on the chosen pieces + sfx cues on the output timeline (whoosh on punch-ins, every Nth cut, impact on the hook) */
export function applyMotion(clips: CleanedClip[], z: ZoomPlan, sfx: SfxPlan, phraseOf: (t: number) => number): { clips: Clip[]; sfx: { t: number; kind: string; gain?: number }[]; zooms: number } {
  const targets = zoomTargets(clips, z, phraseOf);
  const cues: { t: number; kind: string; gain?: number }[] = [];
  let t = 0;
  const out: Clip[] = clips.map((c, i) => {
    const len = (c.src_end - c.src_start) / c.speed;
    const { from: _from, punch: _punch, ...clip } = c;
    const zoomed = targets.has(i);
    if (sfx.enabled && i > 0 && (zoomed || (sfx.everyCuts > 0 && i % sfx.everyCuts === 0))) cues.push({ t: round3(Math.max(0, t - 0.12)), kind: sfx.kind, gain: sfx.gain });
    t += len;
    return zoomed ? { ...clip, zoom: zoomField(z, len) } : clip;
  });
  if (sfx.enabled && sfx.hookImpact) cues.unshift({ t: 0, kind: "impact", gain: -4 });
  return { clips: out, sfx: cues, zooms: targets.size };
}
