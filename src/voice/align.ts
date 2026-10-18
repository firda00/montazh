import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists } from "../lib/workspace.ts";
import { parseWhisperJson, runWhisperCli, dtwPresetFor, WHISPER_BIN, WHISPER_MODEL, type WhisperJson } from "../understand/whisper.ts";
import { wavBytes } from "./piper.ts";
import { canonicalWords, similarity } from "./pronounce.ts";
import { findPauses, type Span } from "./take.ts";

/**
 * Where the paragraphs of a one-take narration really end, from what was said (stage 25). Pauses alone are not enough:
 * gemini-3.8-flash-lite-tts ran two paragraphs together without any pause and paused at a colon instead, so the pause
 * split moved «Причина в выручке» into the previous beat. Here a small whisper model (ggml-base, ~3 s for 40 s of
 * speech; VEDIT_TAKE_ALIGN_MODEL) times the words, they are aligned to the text (canonical spoken forms on both sides),
 * and each paragraph boundary is cut between its last and the next paragraph's first word — snapped to a pause nearby.
 * VEDIT_TAKE_ALIGN=off skips it (the pause split stays).
 */

export interface TimedWord {
  w: string;
  start: number;
  end: number;
}
export type WordTimer = (wav: string, language: string) => Promise<TimedWord[]>;

const VENDOR_BASE = path.join(path.dirname(WHISPER_MODEL), "ggml-base.bin");

/** The model that times the words: VEDIT_TAKE_ALIGN_MODEL, else ggml-base next to the main model, else the main model. */
export async function alignModel(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const own = env.VEDIT_TAKE_ALIGN_MODEL?.trim();
  if (own) return own;
  return (await exists(VENDOR_BASE)) ? VENDOR_BASE : WHISPER_MODEL;
}

/** whisper.cpp word times of a (24 kHz) WAV. */
export const whisperWords: WordTimer = async (wav, language) => {
  const model = await alignModel();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-align-"));
  try {
    const w16 = path.join(dir, "in16k.wav");
    const { ffmpeg } = await import("../lib/ffmpeg.ts");
    await ffmpeg(["-i", wav, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", w16]);
    const base = path.join(dir, "out");
    const preset = dtwPresetFor(model);
    await runWhisperCli(w16, base, { threads: Math.max(2, Math.min(8, os.availableParallelism())), language, preset, model });
    const raw = JSON.parse(await fs.readFile(`${base}.json`, "utf8")) as WhisperJson;
    return parseWhisperJson(raw, preset ? "dtw" : "tokens").segments.flatMap((s) => s.words);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
};

/**
 * Paragraph cut times from word times: both sides as canonical spoken tokens (whisper writes «965», the text says
 * «девятьсот шестьдесят пять»), aligned by edit distance with fuzzy equality; a boundary needs a matched token among
 * the last three of its paragraph and the first three of the next. Null when any boundary is not found.
 */
export function cutsFromWords(paragraphs: string[], words: TimedWord[], language = "ru"): number[] | null {
  const ref: { t: string; p: number }[] = [];
  paragraphs.forEach((p, k) => canonicalWords(p, language).forEach((t) => ref.push({ t, p: k })));
  const hyp: { t: string; start: number; end: number }[] = [];
  for (const w of words) for (const t of canonicalWords(w.w, language)) hyp.push({ t, start: w.start, end: w.end });
  const n = ref.length;
  const m = hyp.length;
  if (!n || !m) return null;
  const eq = (a: string, b: string) => a === b || (Math.max(a.length, b.length) >= 4 && similarity(a, b) >= 0.7);
  const d: Uint16Array[] = Array.from({ length: n + 1 }, (_, i) => {
    const row = new Uint16Array(m + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (eq(ref[i - 1].t, hyp[j - 1].t) ? 0 : 1));
  // backtrace: ref token → matched hyp token
  const match = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (d[i][j] === d[i - 1][j - 1] + (eq(ref[i - 1].t, hyp[j - 1].t) ? 0 : 1)) {
      if (eq(ref[i - 1].t, hyp[j - 1].t)) match[i - 1] = j - 1;
      i--;
      j--;
    } else if (d[i][j] === d[i - 1][j] + 1) i--;
    else j--;
  }
  // a boundary: the last heard token of paragraph k and the first heard token of k+1 (within 6 tokens of the edge:
  // whisper writes «16-80» for «шестнадцать и восемь десятых», so a paragraph's tail may not match at all)
  const cuts: number[] = [];
  for (let k = 0; k < paragraphs.length - 1; k++) {
    const last = ref.map((r, x) => (r.p === k ? x : -1)).filter((x) => x >= 0);
    const next = ref.map((r, x) => (r.p === k + 1 ? x : -1)).filter((x) => x >= 0);
    const a = last.slice(-6).reverse().find((x) => match[x] >= 0);
    const b = next.slice(0, 6).find((x) => match[x] >= 0);
    if (a === undefined || b === undefined) return null; // both sides must be heard (a lone side can be a stray match)
    const e = a !== undefined ? hyp[match[a]].end : null;
    const s = b !== undefined ? hyp[match[b]].start : null;
    if (e !== null && s !== null && s < e - 0.05) return null;
    const aExact = a !== undefined && a === last.at(-1);
    const bExact = b !== undefined && b === next[0];
    // trust the exact edge: the next paragraph's first word starts it, or the last word ends this one
    if (bExact && s !== null) cuts.push(aExact && e !== null ? (e + s) / 2 : Math.max(e ?? 0, s - 0.04));
    else if (aExact && e !== null) cuts.push(s !== null ? Math.min(s, e + 0.04) : e + 0.04);
    else if (e !== null && s !== null) cuts.push((e + s) / 2);
    else return null;
  }
  // in order, at least 0.3 s apart
  for (let k = 1; k < cuts.length; k++) if (cuts[k] < cuts[k - 1] + 0.3) return null;
  return cuts;
}

/** Cut times → spans, every cut moved to the centre of a pause within `snap` seconds when there is one. */
export function spansFromCuts(cuts: number[], pcm: Int16Array, rate: number, snap = 0.3): Span[] {
  const total = pcm.length / rate;
  const pauses = findPauses(pcm, rate, { minMs: 60 });
  const spans: Span[] = [];
  let at = 0;
  for (const c of [...cuts, total]) {
    let x = c;
    if (c < total) {
      const near = pauses.filter((p) => Math.abs((p.start + p.end) / 2 - c) <= snap || (p.start <= c && p.end >= c)).sort((p, q) => Math.abs((p.start + p.end) / 2 - c) - Math.abs((q.start + q.end) / 2 - c))[0];
      if (near) x = (near.start + near.end) / 2;
    }
    x = Math.max(at + 0.05, Math.min(total, x));
    spans.push({ start: at, end: x });
    at = x;
  }
  return spans;
}

/** Content-based paragraph spans of a take, or null (no whisper, nothing recognised, a boundary not found). */
export async function alignTake(pcm: Int16Array, rate: number, paragraphs: string[], o: { language?: string; words?: WordTimer } = {}): Promise<Span[] | null> {
  if (paragraphs.length < 2) return null;
  if (process.env.VEDIT_TAKE_ALIGN?.trim().toLowerCase() === "off" && !o.words) return null;
  if (!o.words && !(await exists(WHISPER_BIN))) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-take-"));
  try {
    const wav = path.join(dir, "take.wav");
    await fs.writeFile(wav, wavBytes(pcm, rate));
    const words = await (o.words ?? whisperWords)(wav, o.language ?? "ru");
    const cuts = cutsFromWords(paragraphs, words, o.language ?? "ru");
    return cuts ? spansFromCuts(cuts, pcm, rate) : null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
