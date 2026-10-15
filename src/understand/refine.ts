import { ffmpegBuffer } from "../lib/ffmpeg.ts";
import { hoopAt, type EventsFile, type HoopSample, type SportEvent } from "./events.ts";

/**
 * Local refinement of shot events (no model): Gemini sees the game at 2 fps on a small clip, so its
 * key times are ±1 s and it cannot see whether a 15 px ball dropped through a 45 px rim. Here the
 * source is read at full frame rate in a small box around the rim:
 *   - the ball is found as warm-coloured pixels that differ from the window's median background
 *     (the white net and the blue backboard are not warm, so net motion does not count as ball);
 *   - its track decides the shot: at the rim → through the net (inside the rim's x span, below the
 *     ring) = make; at the rim and then out sideways / up, or never inside the net = miss;
 *   - the net keeps swinging after a make: white-pixel change under the rim after the ball left;
 *   - an audio onset (rim / backboard clank, high-passed) near the rim moment sharpens the key time.
 * The key time is the first frame the ball is at the rim (≈ 1/60 s precision at 60 fps).
 */

export interface RoiBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rim geometry inside the ROI, px. */
export interface RimGeom {
  /** rim centre x */
  cx: number;
  /** y of the ring */
  ry: number;
  /** rim width */
  rw: number;
  /** bottom of the net */
  netBottom: number;
}

export interface BallPoint {
  i: number;
  x: number;
  y: number;
  n: number;
}

/** Hoop sample (normalized box) → ROI box in source pixels and the rim geometry inside it. */
export function roiForHoop(h: HoopSample, frameW: number, frameH: number): { roi: RoiBox; rim: RimGeom } | null {
  if (!h.box && !h.rim) return null;
  const box = h.box ?? { x0: h.rim!.x - 0.03, x1: h.rim!.x + 0.03, y0: h.rim!.y - 0.005, y1: h.rim!.y + 0.035 };
  const bx0 = box.x0 * frameW;
  const bx1 = box.x1 * frameW;
  const by0 = box.y0 * frameH;
  const by1 = box.y1 * frameH;
  const rw = Math.max(12, bx1 - bx0);
  const cx = h.rim ? h.rim.x * frameW : (bx0 + bx1) / 2;
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  const x = even(Math.max(0, cx - 2.6 * rw));
  const y = even(Math.max(0, by0 - 3 * rw));
  const w = even(Math.min(frameW - x, 5.2 * rw));
  const hh = even(Math.min(frameH - y, by1 - y + 2.2 * rw));
  return { roi: { x, y, w, h: hh }, rim: { cx: cx - x, ry: by0 + 0.12 * (by1 - by0) - y, rw, netBottom: by1 - y } };
}

/** Per-pixel median over frames (rgb24), sampled every `step` frames — the static background of the window. */
export function medianBackground(frames: Buffer[], step = 3): Buffer {
  const n = frames[0].length;
  const pick = frames.filter((_, i) => i % step === 0);
  const out = Buffer.alloc(n);
  const vals = new Uint8Array(pick.length);
  for (let p = 0; p < n; p++) {
    for (let k = 0; k < pick.length; k++) vals[k] = pick[k][p];
    vals.sort();
    out[p] = vals[vals.length >> 1];
  }
  return out;
}

export interface Blob {
  x: number;
  y: number;
  area: number;
  w: number;
  h: number;
}

/**
 * Ball-sized blobs per frame. Mask = differs from the background (Σ|Δrgb| > diff) and is brownish
 * (R − B > warm, R ≥ G − 8: the white net and the blue backboard drop out). Connected components
 * (4-neighbour) whose area, box and fill look like a ball of about half a rim width.
 */
export function ballBlobs(frames: Buffer[], w: number, h: number, bg: Buffer, rimW: number, o: { diff?: number; warm?: number } = {}): Blob[][] {
  const diff = o.diff ?? 45;
  const warm = o.warm ?? 8;
  const minA = 0.03 * rimW * rimW;
  const maxA = 0.5 * rimW * rimW;
  const maxSide = 0.9 * rimW;
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  return frames.map((f) => {
    for (let p = 0, q = 0; q < w * h; q++, p += 3) {
      const r = f[p];
      const g = f[p + 1];
      const b = f[p + 2];
      const d = Math.abs(r - bg[p]) + Math.abs(g - bg[p + 1]) + Math.abs(b - bg[p + 2]);
      mask[q] = d > diff && r - b > warm && r >= g - 8 ? 1 : 0;
    }
    const out: Blob[] = [];
    for (let q0 = 0; q0 < w * h; q0++) {
      if (mask[q0] !== 1) continue;
      let top = 0;
      stack[top++] = q0;
      mask[q0] = 2;
      let n = 0;
      let sx = 0;
      let sy = 0;
      let x0 = w;
      let x1 = 0;
      let y0 = h;
      let y1 = 0;
      while (top) {
        const q = stack[--top];
        const x = q % w;
        const y = (q - x) / w;
        n++;
        sx += x;
        sy += y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        if (x > 0 && mask[q - 1] === 1) (mask[q - 1] = 2), (stack[top++] = q - 1);
        if (x < w - 1 && mask[q + 1] === 1) (mask[q + 1] = 2), (stack[top++] = q + 1);
        if (y > 0 && mask[q - w] === 1) (mask[q - w] = 2), (stack[top++] = q - w);
        if (y < h - 1 && mask[q + w] === 1) (mask[q + w] = 2), (stack[top++] = q + w);
      }
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      if (n < minA || n > maxA || bw > maxSide || bh > maxSide) continue;
      if (n / (bw * bh) < 0.3 || bw / bh > 2.5 || bh / bw > 2.5) continue;
      out.push({ x: sx / n, y: sy / n, area: n, w: bw, h: bh });
    }
    return out;
  });
}

/** Change of non-warm (net) pixels in the net zone per frame — the net swinging. */
export function netMotion(frames: Buffer[], w: number, bg: Buffer, rim: RimGeom, o: { diff?: number; warm?: number } = {}): number[] {
  const diff = o.diff ?? 60;
  const warm = o.warm ?? 28;
  const x0 = Math.max(0, Math.round(rim.cx - 0.45 * rim.rw));
  const x1 = Math.round(rim.cx + 0.45 * rim.rw);
  const y0 = Math.max(0, Math.round(rim.ry + 0.1 * rim.rw));
  const y1 = Math.round(rim.netBottom);
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return frames.map((f) => {
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 3;
        const d = Math.abs(f[p] - bg[p]) + Math.abs(f[p + 1] - bg[p + 1]) + Math.abs(f[p + 2] - bg[p + 2]);
        if (d > diff && f[p] - f[p + 2] <= warm) n++;
      }
    }
    return n / area;
  });
}

export interface ShotVerdict {
  verdict: "make" | "miss" | "unknown";
  /** frame index the ball first reaches the height of the ring */
  rimFrame: number | null;
  /** frame index the ball is inside the net, under the ring */
  throughFrame: number | null;
  /** 0..1 how sure the local evidence is */
  score: number;
  netMotion: number | null;
  /** the followed ball positions (frame, x, y) — for reports and debugging */
  track: BallPoint[];
}

/** Warm foreground pixels inside the net core (under the ring, centre ±0.3 rim widths) per frame: the ball in the net, even when the strings break it into pieces. */
export interface CoreSample {
  n: number;
  /** mean y of those pixels (ROI px), NaN when none */
  y: number;
}

export function netCore(frames: Buffer[], w: number, bg: Buffer, rim: RimGeom, o: { diff?: number; warm?: number } = {}): CoreSample[] {
  const diff = o.diff ?? 40;
  const warm = o.warm ?? 6;
  const x0 = Math.max(0, Math.round(rim.cx - 0.3 * rim.rw));
  const x1 = Math.round(rim.cx + 0.3 * rim.rw);
  const y0 = Math.max(0, Math.round(rim.ry + 0.2 * rim.rw));
  const y1 = Math.round(rim.netBottom + 0.1 * rim.rw);
  return frames.map((f) => {
    let n = 0;
    let sy = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const p = (y * w + x) * 3;
        const d = Math.abs(f[p] - bg[p]) + Math.abs(f[p + 1] - bg[p + 1]) + Math.abs(f[p + 2] - bg[p + 2]);
        if (d > diff && f[p] - f[p + 2] > warm && f[p] >= f[p + 1] - 8) (n++, (sy += y));
      }
    }
    return { n, y: n ? sy / n : NaN };
  });
}

/**
 * Blobs (+ the net core) → make / miss. The ball is picked up while it comes down onto the hoop
 * (above the ring, within 1.3 rim widths of its centre) and followed frame to frame (nearest blob
 * near the constant-velocity prediction; short gaps allowed). The rim moment is when the track
 * reaches the ring — or, when the ball is lost just above it (it disappears into the strings), the
 * extrapolated arrival. Make, either:
 *   - the track drops into the net core (within ±0.35 rim widths, under the ring) while falling, or
 *   - ball-coloured pixels fill the net core within 0.5 s after the rim moment, the core was empty
 *     just before (not a head or a hand under the hoop), and they move down;
 * and the ball has not gone back above the ring or off to the side at ring height first.
 */
export function classifyShot(blobs: Blob[][], rim: RimGeom, fps: number, net: number[] = [], near?: number, core: CoreSample[] = []): ShotVerdict {
  const { cx, ry, rw, netBottom } = rim;
  const approach = (b: Blob) => Math.abs(b.x - cx) <= 1.3 * rw && b.y >= ry - 2.6 * rw && b.y <= ry - 0.15 * rw;
  const inNet = (p: { x: number; y: number }) => Math.abs(p.x - cx) <= 0.35 * rw && p.y >= ry + 0.25 * rw && p.y <= netBottom + 0.4 * rw;
  const per = (v: number) => (v * 60) / fps; // per-frame quantities tuned at 60 fps
  const maxGap = Math.round(0.1 * fps);
  const starts: number[] = [];
  blobs.forEach((bs, i) => {
    if (bs.some(approach) && !(i > 0 && blobs[i - 1].some(approach))) starts.push(i);
  });
  const target = near ?? 0;
  starts.sort((a, b) => Math.abs(a - target) - Math.abs(b - target));
  const coreThr = 0.1 * rw * rw;
  let best: ShotVerdict = { verdict: "unknown", rimFrame: null, throughFrame: null, score: 0, netMotion: null, track: [] };
  for (const s of starts.slice(0, 4)) {
    const first = blobs[s].filter(approach).sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx))[0];
    const track: BallPoint[] = [{ i: s, x: first.x, y: first.y, n: first.area }];
    let gap = 0;
    for (let i = s + 1; i < blobs.length && i <= s + Math.round(1.0 * fps); i++) {
      const last = track[track.length - 1];
      const prev = track.length > 1 ? track[track.length - 2] : null;
      const k = i - last.i;
      const vx = prev ? (last.x - prev.x) / (last.i - prev.i) : 0;
      const vy = prev ? (last.y - prev.y) / (last.i - prev.i) : per(0.05 * rw);
      const px = last.x + vx * k;
      const py = last.y + vy * k;
      const radius = 0.3 * rw + per(0.12 * rw) * k;
      const cand = blobs[i].map((b) => ({ b, d: Math.hypot(b.x - px, b.y - py) })).filter((c) => c.d <= radius).sort((a, b) => a.d - b.d)[0];
      if (cand) {
        track.push({ i, x: cand.b.x, y: cand.b.y, n: cand.b.area });
        gap = 0;
      } else if (++gap > maxGap) break;
    }
    // rim moment: the track reaches the ring, or is lost just above it while coming down at it
    let rimFrame: number | null = null;
    let rimIdx = track.findIndex((p) => p.y >= ry - 0.3 * rw);
    if (rimIdx >= 0) rimFrame = track[rimIdx].i;
    else {
      const last = track[track.length - 1];
      const prev = track.length > 2 ? track[track.length - 3] : null;
      if (prev && last.y > ry - 1.6 * rw && Math.abs(last.x - cx) < 0.8 * rw) {
        const vy = (last.y - prev.y) / (last.i - prev.i);
        if (vy > 0) rimFrame = last.i + Math.max(1, Math.round((ry - 0.3 * rw - last.y) / vy));
      }
      rimIdx = track.length;
    }
    if (rimFrame === null) continue;
    let throughFrame: number | null = null;
    let bounced = false;
    for (const p of track.slice(rimIdx)) {
      if (p.i > rimFrame + Math.round(0.7 * fps)) break;
      const falling = p.i <= rimFrame + 1 || (p.y - Math.min(ry - 0.3 * rw, track[Math.max(0, rimIdx - 1)]?.y ?? ry)) / Math.max(1, p.i - rimFrame) >= per(0.015 * rw);
      if (inNet(p) && falling) {
        throughFrame = p.i;
        break;
      }
      if (p.y < ry - 0.6 * rw || (Math.abs(p.x - cx) > 0.9 * rw && p.y < ry + 0.25 * rw)) {
        bounced = true;
        break;
      }
    }
    // the net core: occupied after the rim moment, empty just before, filling top-down
    let coreHit = false;
    if (throughFrame === null && !bounced && core.length) {
      const before = core.slice(Math.max(0, rimFrame - Math.round(0.25 * fps)), Math.max(0, rimFrame - Math.round(0.05 * fps)));
      const empty = before.length > 0 && before.every((c) => c.n < coreThr / 2);
      const after = core.slice(rimFrame, Math.min(core.length, rimFrame + Math.round(0.5 * fps)));
      const hits = after.map((c, k) => ({ ...c, i: rimFrame! + k })).filter((c) => c.n >= coreThr);
      const down = hits.length >= 2 && hits[hits.length - 1].y >= hits[0].y;
      // and the ball must not be seen off to the side at ring height in the meantime
      const side = track.some((p) => p.i > rimFrame! && p.i <= (hits[0]?.i ?? rimFrame!) && Math.abs(p.x - cx) > 0.9 * rw && p.y < ry + 0.25 * rw);
      if (empty && hits.length >= Math.max(2, Math.round(0.05 * fps)) && down && !side) {
        coreHit = true;
        throughFrame = hits[0].i;
      }
    }
    let nm: number | null = null;
    if (net.length) {
      const from = (throughFrame ?? rimFrame) + Math.round(0.2 * fps);
      const xs = net.slice(from, Math.min(net.length, from + Math.round(0.5 * fps)));
      nm = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }
    const below = throughFrame !== null && track.some((p) => p.i > throughFrame! && p.y > netBottom);
    let v: ShotVerdict;
    if (throughFrame !== null && !bounced) {
      const score = (coreHit ? 0.6 : 0.7) + (below ? 0.15 : 0) + (nm !== null ? Math.min(0.15, nm) : 0);
      v = { verdict: "make", rimFrame, throughFrame, score: Math.round(Math.min(1, score) * 100) / 100, netMotion: nm, track };
    } else v = { verdict: "miss", rimFrame, throughFrame: null, score: bounced ? 0.8 : 0.6, netMotion: nm, track };
    best = v;
    break;
  }
  return best;
}

/** Net swing below this (fraction of net pixels changed after the ball passed) = the ball did not go through. Calibrated on the court footage: makes 0.20–0.38, a ball dropping in front 0.15. */
export const MIN_NET_SWING = 0.17;
/** After the ball sat on the ring: lower half of the net only (roll-ins 0.22–0.26, balls dropping off the front 0.09–0.13). */
export const MIN_LOWER_NET_SWING = 0.18;

/** The ball rested / rolled on the ring for ≥ 0.15 s (near ring height, hardly moving vertically) before it dropped. */
export function rolledOnRim(track: BallPoint[], rim: RimGeom, fps: number): boolean {
  let run = 0;
  let best = 0;
  for (let k = 1; k < track.length; k++) {
    const p = track[k];
    const q = track[k - 1];
    const near = p.y >= rim.ry - 1.0 * rim.rw && p.y <= rim.ry + 0.1 * rim.rw && Math.abs(p.x - rim.cx) <= 0.8 * rim.rw;
    const slow = Math.abs(p.y - q.y) / Math.max(1, p.i - q.i) < (0.025 * rim.rw * 60) / fps;
    run = near && slow ? run + (p.i - q.i) : 0;
    best = Math.max(best, run);
  }
  return best >= 0.15 * fps;
}

/** Onset strength of a mono signal: positive change of log energy per hop (hop seconds). */
export function onsetEnvelope(samples: Float32Array, sr: number, hop = 0.01): number[] {
  const n = Math.max(1, Math.round(sr * hop));
  const frames = Math.floor(samples.length / n);
  const loge: number[] = [];
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = f * n; k < (f + 1) * n; k++) e += samples[k] * samples[k];
    loge.push(Math.log10(e / n + 1e-10));
  }
  return loge.map((v, i) => (i === 0 ? 0 : Math.max(0, v - loge[i - 1])));
}

/** Strongest onset within ±radius s of t (t relative to the envelope start); null when nothing stands out (< minRise in log10 energy). */
export function strongestOnset(env: number[], hop: number, t: number, radius: number, minRise = 0.8): number | null {
  const a = Math.max(0, Math.floor((t - radius) / hop));
  const b = Math.min(env.length - 1, Math.ceil((t + radius) / hop));
  let best = -1;
  let bi = -1;
  for (let i = a; i <= b; i++) if (env[i] > best) (best = env[i]), (bi = i);
  return best >= minRise ? bi * hop : null;
}

export interface RefineOptions {
  frameW: number;
  frameH: number;
  /** ROI frame rate (the source's, ideally) */
  fps?: number;
  /** seconds read before / after the model's key time */
  before?: number;
  after?: number;
  onLog?: (line: string) => void;
}

/** Refines one shot event in place-free style: returns the event with `refined` (and outcome/type when the local verdict is clear). */
export async function refineShot(source: string, e: SportEvent, hoop: HoopSample, o: RefineOptions): Promise<SportEvent> {
  const g = roiForHoop(hoop, o.frameW, o.frameH);
  if (!g) return e;
  const fps = o.fps ?? 60;
  const t0 = Math.max(0, e.key - (o.before ?? 1.6));
  const dur = (o.before ?? 1.6) + (o.after ?? 1.6);
  const { roi, rim } = g;
  const raw = await ffmpegBuffer(["-ss", t0.toFixed(3), "-t", dur.toFixed(3), "-i", source, "-an", "-vf", `crop=${roi.w}:${roi.h}:${roi.x}:${roi.y},fps=${fps}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const size = roi.w * roi.h * 3;
  const frames: Buffer[] = [];
  for (let p = 0; p + size <= raw.length; p += size) frames.push(raw.subarray(p, p + size));
  if (frames.length < 10) return e;
  const bg = medianBackground(frames);
  const blobs = ballBlobs(frames, roi.w, roi.h, bg, rim.rw);
  let v = classifyShot(blobs, rim, fps, [], Math.round((e.key - t0) * fps), netCore(frames, roi.w, bg, rim));
  // the camera looks up at the hoop: a ball dropping just in front of it crosses the net in the picture too —
  // only a ball that went through swings the net
  const thr = v.throughFrame ?? (v.rimFrame ?? 0) + Math.round(0.1 * fps);
  const swing = v.rimFrame !== null ? netSwing(frames, roi.w, rim, v.rimFrame, thr, fps) : null;
  // a ball that sat on the ring and then dropped: in, or off the front? the lower net decides (a hit ring shakes the top of the net either way)
  const hung = rolledOnRim(v.track, rim, fps);
  const lower = hung && v.rimFrame !== null ? netSwing(frames, roi.w, rim, v.rimFrame, thr, fps, { from: 0.5 }) : null;
  const through = hung ? lower !== null && lower >= MIN_LOWER_NET_SWING : swing === null || swing >= MIN_NET_SWING;
  if (v.verdict === "make" && !through) v = { ...v, verdict: "miss", throughFrame: null, score: 0.6 };
  if (v.verdict === "make" && swing !== null) v = { ...v, score: Math.round(Math.min(1, v.score + Math.min(0.15, swing - MIN_NET_SWING)) * 100) / 100 };
  v = { ...v, netMotion: swing };
  const motionT = v.rimFrame !== null ? t0 + v.rimFrame / fps : null;
  // audio: high-passed (rim and backboard clank, not the crowd), onset near the rim moment
  let audioT: number | null = null;
  try {
    const sr = 16000;
    const pcm = await ffmpegBuffer(["-ss", t0.toFixed(3), "-t", dur.toFixed(3), "-i", source, "-vn", "-ac", "1", "-ar", String(sr), "-af", "highpass=f=1200", "-f", "f32le", "-"]);
    const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4));
    const env = onsetEnvelope(samples, sr, 0.01);
    const at = strongestOnset(env, 0.01, motionT !== null ? motionT - t0 : e.key - t0, motionT !== null ? 0.25 : 0.8);
    audioT = at !== null ? t0 + at : null;
  } catch {
    audioT = null;
  }
  const key = motionT ?? audioT ?? e.key;
  const method = motionT !== null ? (audioT !== null ? "ball+audio" : "ball") : audioT !== null ? "audio" : "model";
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const refined = { key: r3(key), method, local_verdict: v.verdict, rolled: hung, model_outcome: e.chunk >= 0 ? e.outcome : undefined, through_t: v.throughFrame !== null ? r3(t0 + v.throughFrame / fps) : null, motion_t: motionT !== null ? r3(motionT) : null, audio_t: audioT !== null ? r3(audioT) : null, motion_peak: v.verdict === "unknown" ? null : v.score, net_motion: v.netMotion !== null ? Math.round(v.netMotion * 1000) / 1000 : null };
  let { type, outcome, confidence } = e;
  if (v.verdict === "make" && v.score >= 0.55) {
    if (type === "shot_miss") type = "shot_make";
    outcome = "make";
    confidence = Math.max(confidence * 0.5, v.score);
  } else if (v.verdict === "miss" && outcome === "make") {
    // the ball was followed to the rim and did not go through: the low-res model was wrong
    if (type === "shot_make") type = "shot_miss";
    outcome = "miss";
  }
  // the model's sentence may say the opposite of what the frames showed: say so instead of keeping a wrong "промах"/"попадает"
  const flipped = e.outcome !== "none" && outcome !== e.outcome;
  const description = flipped ? `${outcome === "make" ? "Попадание" : "Промах"} по кадрам у кольца (модель: ${e.description.replace(/\.$/, "")})` : e.description;
  return { ...e, type, outcome, description, confidence: Math.round(confidence * 100) / 100, key: r3(key), refined };
}

/** Refines every shot event of an events file (sequential; each reads ~3 s of a small ROI). */
export async function refineEvents(ev: EventsFile, source: string, o: RefineOptions): Promise<EventsFile> {
  const out: SportEvent[] = [];
  let n = 0;
  for (const e of ev.events) {
    const shot = e.type === "shot_make" || e.type === "shot_miss" || e.type === "dunk_layup";
    const hoop = shot ? hoopAt(ev.hoops, e.key) : null;
    if (!shot || !hoop) {
      out.push(e);
      continue;
    }
    try {
      out.push(await refineShot(source, e, hoop, o));
      n++;
    } catch (err) {
      o.onLog?.(`уточнение ${e.id}: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      out.push(e);
    }
  }
  o.onLog?.(`уточнено бросков: ${n}`);
  return { ...ev, events: out };
}

/**
 * How much the net moved after the ball went through it: the fraction of net pixels (inside the
 * ring's width, from the ring to the net bottom) that differ from the net before the shot (mean of
 * 0.4–0.1 s before the rim moment), measured 0.12–0.5 s after the through moment, ball pixels
 * excluded. A swish swings the net; a ball dropping in front of the hoop leaves it still.
 */
export function netSwing(frames: Buffer[], w: number, rim: RimGeom, rimFrame: number, throughFrame: number, fps: number, o: { diff?: number; warm?: number; from?: number } = {}): number | null {
  const diff = o.diff ?? 45;
  const warm = o.warm ?? 6;
  const r0 = Math.max(0, rimFrame - Math.round(0.4 * fps));
  const r1 = Math.max(r0 + 1, rimFrame - Math.round(0.1 * fps));
  const a0 = throughFrame + Math.round(0.12 * fps);
  const a1 = Math.min(frames.length, throughFrame + Math.round(0.5 * fps));
  if (a1 - a0 < 3 || r1 > frames.length) return null;
  const x0 = Math.max(0, Math.round(rim.cx - 0.45 * rim.rw));
  const x1 = Math.round(rim.cx + 0.45 * rim.rw);
  const y0 = Math.max(0, Math.round(rim.ry + (o.from ?? 0) * (rim.netBottom - rim.ry)));
  const y1 = Math.round(rim.netBottom);
  const nx = x1 - x0;
  const ref = new Float32Array(nx * (y1 - y0) * 3);
  for (let i = r0; i < r1; i++) {
    const f = frames[i];
    for (let y = y0, q = 0; y < y1; y++) for (let x = x0; x < x1; x++, q += 3) for (let c = 0; c < 3; c++) ref[q + c] += f[(y * w + x) * 3 + c] / (r1 - r0);
  }
  let sum = 0;
  for (let i = a0; i < a1; i++) {
    const f = frames[i];
    let n = 0;
    for (let y = y0, q = 0; y < y1; y++) {
      for (let x = x0; x < x1; x++, q += 3) {
        const p = (y * w + x) * 3;
        if (f[p] - f[p + 2] > warm + 14) continue; // the ball itself
        const d = Math.abs(f[p] - ref[q]) + Math.abs(f[p + 1] - ref[q + 1]) + Math.abs(f[p + 2] - ref[q + 2]);
        if (d > diff) n++;
      }
    }
    sum += n / (nx * (y1 - y0));
  }
  return Math.round((sum / (a1 - a0)) * 1000) / 1000;
}
