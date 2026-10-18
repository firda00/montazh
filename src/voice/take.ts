/**
 * One-take narration: every beat of a make narration is spoken in ONE TTS request (paragraphs), then the audio is cut
 * back into beats at the pauses between paragraphs. One request instead of one per beat matters on the Gemini free
 * tier (gemini-3.8-flash-tts: 10 requests a day, checked 2026-10-18) and keeps one intonation over the whole video.
 *
 * splitTake finds the cut points: pauses (≥ 120 ms of frames ≥ 35 dB below the loud part) are candidates, and a small
 * dynamic programme picks one pause per paragraph boundary — long pauses near where the boundary is expected (by the
 * spoken length of each paragraph) win. Implausible results (a part < 45 % or > 220 % of its expected length) → null,
 * and the caller falls back to one request per beat.
 */

export interface Span {
  start: number;
  end: number;
}

const FRAME_MS = 10;

/** Pauses in mono s16 PCM: runs of quiet 10 ms frames at least `minMs` long (seconds). */
export function findPauses(pcm: Int16Array, rate: number, o: { minMs?: number; belowDb?: number } = {}): Span[] {
  const n = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const frames = Math.floor(pcm.length / n);
  const rms = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    for (let k = f * n; k < (f + 1) * n; k++) e += pcm[k] * pcm[k];
    rms[f] = Math.sqrt(e / n);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const thr = Math.max(60, loud * 10 ** (-(o.belowDb ?? 35) / 20));
  const minFrames = Math.ceil((o.minMs ?? 120) / FRAME_MS);
  const out: Span[] = [];
  let run = -1;
  for (let f = 0; f <= frames; f++) {
    const quiet = f < frames && rms[f] < thr;
    if (quiet && run < 0) run = f;
    if (!quiet && run >= 0) {
      if (f - run >= minFrames && run > 0 && f < frames) out.push({ start: (run * n) / rate, end: (f * n) / rate });
      run = -1;
    }
  }
  return out;
}

/**
 * Where to cut a take into paragraphs. `paragraphs[k]` lists the expected spoken length (any unit) of each sentence of
 * paragraph k. Every sentence end gets a pause (S−1 of them are chosen in order, so the many sentence anchors keep the
 * positional estimate tight); the paragraph cuts are the pauses after each paragraph's last sentence, and those are
 * expected to be the longer ones. Returns the paragraph spans (0 … end of the take) or null when no plausible split exists.
 */
export function splitTake(pcm: Int16Array, rate: number, paragraphs: number[] | number[][], o: { minMs?: number } = {}): Span[] | null {
  const paras = paragraphs.map((p) => (Array.isArray(p) ? p : [p]));
  const N = paras.length;
  const total = pcm.length / rate;
  if (N <= 1) return [{ start: 0, end: total }];
  const sent = paras.flat();
  const S = sent.length;
  // sentence k ends a paragraph?
  const paraEnd: boolean[] = [];
  paras.forEach((p) => p.forEach((_, i) => paraEnd.push(i === p.length - 1)));
  const pauses = findPauses(pcm, rate, { minMs: o.minMs });
  if (pauses.length < S - 1) {
    // too few pauses for every sentence: paragraphs only
    if (S === N) return null;
    return splitTake(pcm, rate, paras.map((p) => [p.reduce((a, b) => a + b, 0)]), o);
  }
  const sum = sent.reduce((a, b) => a + b, 0) || 1;
  const expected: number[] = [];
  let acc = 0;
  for (let k = 0; k < S - 1; k++) {
    acc += sent[k];
    expected.push((total * acc) / sum);
  }
  const avg = total / S;
  const M = pauses.length;
  const score = (k: number, j: number) => {
    const p = pauses[j];
    const mid = (p.start + p.end) / 2;
    return (p.end - p.start) * (paraEnd[k] ? 1.6 : 1) - 0.6 * (Math.abs(mid - expected[k]) / avg);
  };
  // best[k][j]: best total with sentence boundary k placed at pause j
  const best: number[][] = Array.from({ length: S - 1 }, () => new Array(M).fill(-Infinity));
  const from: number[][] = Array.from({ length: S - 1 }, () => new Array(M).fill(-1));
  for (let j = 0; j < M; j++) best[0][j] = score(0, j);
  for (let k = 1; k < S - 1; k++) {
    // running max over i < j
    let bi = -1;
    let bv = -Infinity;
    for (let j = 0; j < M; j++) {
      if (j - 1 >= 0 && best[k - 1][j - 1] > bv) (bv = best[k - 1][j - 1]), (bi = j - 1);
      if (bi >= 0) {
        best[k][j] = bv + score(k, j);
        from[k][j] = bi;
      }
    }
  }
  let j = -1;
  let bv = -Infinity;
  for (let x = 0; x < M; x++) if (best[S - 2][x] > bv) (bv = best[S - 2][x]), (j = x);
  if (j < 0 || !Number.isFinite(bv)) return null;
  const picks: number[] = [];
  for (let k = S - 2; k >= 0; k--) {
    picks.unshift(j);
    j = from[k][j];
  }
  const cuts = picks.map((p) => (pauses[p].start + pauses[p].end) / 2).filter((_, k) => paraEnd[k]);
  const spans: Span[] = [];
  let at = 0;
  for (const c of [...cuts, total]) {
    spans.push({ start: at, end: c });
    at = c;
  }
  // plausibility: every paragraph near its expected share
  for (let k = 0; k < N; k++) {
    const want = (total * paras[k].reduce((a, b) => a + b, 0)) / sum;
    const got = spans[k].end - spans[k].start;
    if (got < want * 0.45 || got > want * 2.2) return null;
  }
  return spans;
}
