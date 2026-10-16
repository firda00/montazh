import { boxesBetween, type FaceBox, type FaceTrack } from "./faces.ts";

/**
 * Where caption pages, titles and callouts sit vertically so they never cover a face (stage 23). Pure.
 *
 * For one block (a caption page, a title) over its time span:
 *  1. obstacles = every face box seen during the span whose x-range meets the block's (centred, its width), padded
 *     above (forehead/hair: max(padAbove, 0.3 × box height)) and below (chin: padBelow), plus extra obstacles
 *     (the split hook title, caption pages already placed under a title);
 *  2. the block must stay inside the safe area (Reels: the top 8 % and the bottom 16 % are covered by the app UI);
 *  3. the preferred slot (preset / Style DNA anchor, clamped into the safe area) when it is free; else the nearest
 *     free spot on the preferred slot's side of the face (below the chin for captions in the lower third, above the
 *     forehead for a top title), else on the other side, else the largest free band, else the least overlap.
 * Caption pages are placed as a sequence with hysteresis: a page keeps the previous page's position while that is
 * still free (no jumping every page); it returns to the preferred slot only at a cut (new clip) or after a pause,
 * and moves elsewhere only when the face takes its spot.
 */

export interface SafeArea {
  /** fractions of the frame height */
  top: number;
  bottom: number;
}

/** Reels / Shorts / TikTok UI: the top ~8 % (status, tabs) and the bottom ~16 % (description, buttons) are covered. */
export const REELS_SAFE: SafeArea = { top: 0.08, bottom: 0.84 };

/** Safe band for overlays: portrait frames use the Reels UI margins, landscape only the design safe margin. */
export function safeAreaFor(width: number, height: number, safeY: number): SafeArea {
  if (height > width) return { top: Math.max(REELS_SAFE.top, safeY), bottom: Math.min(REELS_SAFE.bottom, 1 - safeY) };
  return { top: safeY, bottom: 1 - safeY };
}

export interface Obstacle {
  lo: number;
  hi: number;
  /** horizontal extent (fractions of the width); absent = full width */
  x0?: number;
  x1?: number;
  /** time span; absent = always */
  start?: number;
  end?: number;
}

export interface BlockRequest {
  start: number;
  end: number;
  /** block height and width as fractions of the frame */
  height: number;
  width: number;
  preferred: number;
  /** output clip the block belongs to (a cut is a natural moment to move back) */
  clip?: number;
}

export type PlaceRule = "preferred" | "kept" | "below_face" | "above_face" | "free_band" | "least_overlap";

export interface Placement {
  /** centre of the block, fraction of the frame height */
  y: number;
  rule: PlaceRule;
  /** overlap with the padded faces (fraction of the height); 0 unless rule = least_overlap */
  overlap: number;
}

export interface PlaceOptions {
  safe: SafeArea;
  /** padding below a face box (chin), fraction of the height */
  padBelow?: number;
  /** minimum padding above a face box (forehead, hair), fraction of the height */
  padAbove?: number;
  /** horizontal padding around a face box, fraction of the width */
  padX?: number;
  /** extra clearance when moving to a new spot (small face moves do not push the block again) */
  margin?: number;
  /** obstacles that are not faces (the split hook, captions under a title) */
  extra?: Obstacle[];
  /** a pause at least this long lets the captions return to the preferred slot (s) */
  resetGap?: number;
  /** a spot held this long may move back toward the preferred slot even without a cut (s) */
  settle?: number;
  /** seconds of following pages a new spot must also suit, to avoid stepping every page */
  lookahead?: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export const DEFAULT_PAD_BELOW = 0.06;
export const DEFAULT_PAD_ABOVE = 0.06;

function faceObstacle(b: FaceBox, o: PlaceOptions): Obstacle {
  const h = b[3] - b[1];
  const padX = o.padX ?? 0.02;
  return { lo: b[1] - Math.max(o.padAbove ?? DEFAULT_PAD_ABOVE, 0.3 * h), hi: b[3] + (o.padBelow ?? DEFAULT_PAD_BELOW), x0: b[0] - padX, x1: b[2] + padX };
}

/** vertical intervals that block a block of this width during [start, end] (merged) */
export function obstaclesFor(req: Pick<BlockRequest, "start" | "end" | "width">, faces: FaceTrack | undefined, o: PlaceOptions): { lo: number; hi: number }[] {
  const bx0 = 0.5 - req.width / 2;
  const bx1 = 0.5 + req.width / 2;
  const all: Obstacle[] = [...boxesBetween(faces, req.start, req.end).map((b) => faceObstacle(b, o)), ...(o.extra ?? []).filter((e) => (e.start ?? -Infinity) < req.end && (e.end ?? Infinity) > req.start)];
  const ivs = all
    .filter((e) => (e.x1 ?? 1) > bx0 && (e.x0 ?? 0) < bx1)
    .map((e) => ({ lo: e.lo, hi: e.hi }))
    .sort((a, b) => a.lo - b.lo);
  const merged: { lo: number; hi: number }[] = [];
  for (const iv of ivs) {
    const last = merged[merged.length - 1];
    if (last && iv.lo <= last.hi) last.hi = Math.max(last.hi, iv.hi);
    else merged.push({ ...iv });
  }
  return merged;
}

function overlapAt(y: number, h: number, obs: { lo: number; hi: number }[]): number {
  let s = 0;
  for (const o of obs) s += Math.max(0, Math.min(y + h / 2, o.hi) - Math.max(y - h / 2, o.lo));
  return s;
}

export function isFree(y: number, h: number, obs: { lo: number; hi: number }[], safe: SafeArea): boolean {
  return y - h / 2 >= safe.top - 1e-6 && y + h / 2 <= safe.bottom + 1e-6 && overlapAt(y, h, obs) <= 1e-6;
}

/** the preferred anchor moved inside the safe area (a block taller than the safe band is centred in it) */
export function clampToSafe(y: number, h: number, safe: SafeArea): number {
  if (h >= safe.bottom - safe.top) return (safe.top + safe.bottom) / 2;
  return clamp(y, safe.top + h / 2, safe.bottom - h / 2);
}

/** One block on its own (titles, callouts, the first caption page). */
export function placeBlock(req: BlockRequest, faces: FaceTrack | undefined, o: PlaceOptions): Placement {
  const h = req.height;
  const safe = o.safe;
  const margin = o.margin ?? 0.015;
  const pref = clampToSafe(req.preferred, h, safe);
  const obs = obstaclesFor(req, faces, o);
  if (isFree(pref, h, obs, safe)) return { y: r3(pref), rule: "preferred", overlap: 0 };

  // free bands inside the safe area
  const bands: { lo: number; hi: number }[] = [];
  let cur = safe.top;
  for (const ob of obs) {
    if (ob.lo > cur) bands.push({ lo: cur, hi: Math.min(ob.lo, safe.bottom) });
    cur = Math.max(cur, ob.hi);
    if (cur >= safe.bottom) break;
  }
  if (cur < safe.bottom) bands.push({ lo: cur, hi: safe.bottom });
  const fits = bands.filter((b) => b.hi - b.lo >= h - 1e-9);
  // what the preferred spot collides with
  const hit = obs.filter((ob) => ob.hi > pref - h / 2 && ob.lo < pref + h / 2);
  const hitLo = hit.length ? Math.min(...hit.map((x) => x.lo)) : pref;
  const hitHi = hit.length ? Math.max(...hit.map((x) => x.hi)) : pref;
  const within = (b: { lo: number; hi: number }, y: number) => {
    const lo = b.lo + h / 2;
    const hi = b.hi - h / 2;
    // keep a margin from the face when the band allows it
    const mlo = Math.min(lo + margin, (lo + hi) / 2);
    const mhi = Math.max(hi - margin, (lo + hi) / 2);
    return clamp(y, mlo, mhi);
  };
  const below = fits.filter((b) => b.lo >= hitHi - 1e-9).sort((a, b) => a.lo - b.lo)[0];
  const above = fits.filter((b) => b.hi <= hitLo + 1e-9).sort((a, b) => b.hi - a.hi)[0];
  // the side of the face the preferred slot is on comes first (captions in the lower third → below the chin;
  // a title at the top → above the forehead), then the other side
  const order: ["below_face" | "above_face", { lo: number; hi: number } | undefined][] =
    pref >= (hitLo + hitHi) / 2 ? [["below_face", below], ["above_face", above]] : [["above_face", above], ["below_face", below]];
  for (const [rule, band] of order) if (band) return { y: r3(within(band, pref)), rule, overlap: 0 };
  const largest = [...fits].sort((a, b) => b.hi - b.lo - (a.hi - a.lo))[0];
  if (largest) return { y: r3(within(largest, pref)), rule: "free_band", overlap: 0 };
  // nothing is free: the least overlap, nearest the preferred slot on ties
  let best = pref;
  let bestOv = Infinity;
  const lo = Math.min(safe.top + h / 2, (safe.top + safe.bottom) / 2);
  const hi = Math.max(safe.bottom - h / 2, lo);
  for (let y = lo; y <= hi + 1e-9; y += 0.005) {
    const ov = overlapAt(y, h, obs);
    if (ov < bestOv - 1e-9 || (Math.abs(ov - bestOv) <= 1e-9 && Math.abs(y - pref) < Math.abs(best - pref))) {
      best = y;
      bestOv = ov;
    }
  }
  return { y: r3(best), rule: "least_overlap", overlap: r3(bestOv) };
}

/**
 * Caption pages in order, with hysteresis. `alternatives(i)` may offer a smaller block for page i (one line at a
 * smaller size): it is used only when the normal block finds no free spot.
 */
export function placeSequence(reqs: BlockRequest[], faces: FaceTrack | undefined, o: PlaceOptions, alternatives?: (i: number) => BlockRequest | null): (Placement & { alt: boolean })[] {
  const out: (Placement & { alt: boolean })[] = [];
  const resetGap = o.resetGap ?? 0.5;
  const lookahead = o.lookahead ?? 3;
  let prev: { y: number; end: number; clip?: number; since: number } | null = null;
  reqs.forEach((req, i) => {
    /**
     * A new spot is chosen for the pages of the next few seconds (same clip): the union of their faces, the tallest
     * of their blocks, across cuts — so the captions settle once instead of stepping down page after page as the head moves.
     * Falls back to this page alone when no spot is free for the whole window.
     */
    const lookaheadPlace = (q: BlockRequest): Placement => {
      let end = q.end;
      let height = q.height;
      let width = q.width;
      for (let j = i + 1; j < reqs.length && reqs[j].start < q.start + lookahead; j++) {
        end = Math.max(end, reqs[j].end);
        height = Math.max(height, reqs[j].height);
        width = Math.max(width, reqs[j].width);
      }
      const single = placeBlock(q, faces, o);
      if (end === q.end || single.rule === "preferred") return single;
      const wide = placeBlock({ ...q, end, height, width }, faces, o);
      return wide.rule !== "least_overlap" && wide.rule !== "preferred" && isFree(wide.y, q.height, obstaclesFor(q, faces, o), o.safe) ? wide : single;
    };
    let r = req;
    let alt = false;
    let p = decide(r);
    if (p.rule === "least_overlap" && alternatives) {
      const a = alternatives(i);
      if (a) {
        const pa = decide(a);
        if (pa.overlap < p.overlap) {
          p = pa;
          r = a;
          alt = true;
        }
      }
    }
    out.push({ ...p, alt });
    prev = { y: p.y, end: r.end, clip: r.clip, since: prev && Math.abs(prev.y - p.y) < 1e-6 ? prev.since : r.start };

    function decide(q: BlockRequest): Placement {
      const pref = clampToSafe(q.preferred, q.height, o.safe);
      const fresh = lookaheadPlace(q);
      if (!prev) return fresh;
      const obs = obstaclesFor(q, faces, o);
      const prevFree = isFree(prev.y, q.height, obs, o.safe);
      if (!prevFree) return fresh;
      if (Math.abs(prev.y - pref) < 1e-6) return { y: r3(pref), rule: "preferred", overlap: 0 };
      // off the preferred slot: go back at a cut or after a pause, when the slot is free again ...
      // a cut, a pause, or a spot held long enough (a gentle move after ≥ settle s does not read as jumping)
      const boundary = (q.clip !== undefined && prev.clip !== undefined && q.clip !== prev.clip) || q.start - prev.end >= resetGap || q.start - prev.since >= (o.settle ?? 3);
      if (boundary && fresh.rule === "preferred") return fresh;
      // ... or at least closer to it, when the obstacle that pushed the captions away (the split hook, a face) is gone
      if (boundary && fresh.rule !== "least_overlap" && Math.abs(fresh.y - pref) < Math.abs(prev.y - pref) - 0.05) return fresh;
      return { y: r3(prev.y), rule: "kept", overlap: 0 };
    }
  });
  return out;
}
