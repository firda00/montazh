import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ffmpeg, runProcess } from "../lib/ffmpeg.ts";
import { exists } from "../lib/workspace.ts";
import type { Transcript } from "../schemas/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VENDOR = path.join(ROOT, "vendor", "whisper");

export const WHISPER_BIN =
  process.env.WHISPER_BIN || path.join(VENDOR, "bin", "Release", process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
export const WHISPER_MODEL = process.env.WHISPER_MODEL || path.join(VENDOR, "ggml-large-v3-turbo-q5_0.bin");

// ---- raw whisper.cpp JSON (-ojf) ----
export interface WhisperToken {
  text: string;
  offsets: { from: number; to: number }; // ms, heuristic token timestamps
  p: number;
  t_dtw: number; // centiseconds, -1 when DTW was not computed
}
export interface WhisperSegment {
  offsets: { from: number; to: number };
  text: string;
  tokens: WhisperToken[];
}
export interface WhisperJson {
  result: { language: string };
  transcription: WhisperSegment[];
}

/** "dtw": cross-attention alignment (needs -dtw preset); "tokens": whisper.cpp's heuristic token timestamps. */
export type TimestampMethod = "dtw" | "tokens";

type Segment = Transcript["segments"][number];
type Word = Segment["words"][number];

const SPECIAL = /^\[_.*\]$/; // [_BEG_], [_TT_123] ...
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const PHRASE_END = /[.!?…]["»”)]*$/u;

function roundMs(ms: number) {
  return Math.round(ms) / 1000;
}

/**
 * Groups whisper tokens into words. A token that starts with a space and has a letter/digit
 * opens a new word. `silences` (absolute seconds) keep words from starting inside or
 * stretching across a pause — DTW boundaries drift there, as punctuation tokens tend to
 * absorb the silence that follows a sentence.
 */
export function wordsFromSegment(seg: WhisperSegment, method: TimestampMethod, offsetMs = 0, silences: Span[] = []): Word[] {
  const toks = seg.tokens.filter((t) => !SPECIAL.test(t.text));
  const groups: WhisperToken[][] = [];
  for (const t of toks) {
    const opens = t.text.startsWith(" ") && HAS_WORD_CHAR.test(t.text);
    if (opens || groups.length === 0) groups.push([t]);
    else groups[groups.length - 1].push(t);
  }
  const useDtw = method === "dtw" && toks.length > 0 && toks.every((t) => t.t_dtw >= 0);
  const sil = silences.map((s) => ({ start: s.start * 1000 - offsetMs, end: s.end * 1000 - offsetMs }));

  const words: Word[] = [];
  let prevEnd = seg.offsets.from;
  for (const g of groups) {
    const text = g.map((t) => t.text).join("").trim();
    if (!HAS_WORD_CHAR.test(text)) continue;
    let start: number;
    let end: number;
    if (useDtw) {
      // t_dtw marks where a token ends, so a word spans from the previous boundary to its last spoken token
      const lastSpoken = [...g].reverse().find((t) => HAS_WORD_CHAR.test(t.text)) ?? g[g.length - 1];
      start = prevEnd;
      end = lastSpoken.t_dtw * 10;
    } else {
      start = g[0].offsets.from;
      end = g[g.length - 1].offsets.to;
    }
    start = Math.max(start, prevEnd);
    // a word cannot begin inside a pause, nor span across one: it sits on the side
    // of the pause that holds more of its span
    for (const s of sil) {
      if (start >= s.start && start < s.end) start = s.end;
    }
    for (const s of sil) {
      if (s.start > start && s.end < end) {
        if (end - s.end > s.start - start) start = s.end;
        else end = s.start;
      } else if (s.start > start && s.start < end) {
        end = s.start;
      }
    }
    end = Math.max(end, start + 10);
    words.push({ w: text, start: roundMs(start + offsetMs), end: roundMs(end + offsetMs) });
    prevEnd = end;
  }
  return words;
}

/** Splits a run of words into phrases at sentence-ending punctuation. */
export function splitPhrases(words: Word[], lang?: string): Segment[] {
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length === 0) return;
    out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.w).join(" "), words: cur, ...(lang ? { lang } : {}) });
    cur = [];
  };
  for (const w of words) {
    cur.push(w);
    if (PHRASE_END.test(w.w)) flush();
  }
  flush();
  return out;
}

// Phrases whisper is known to invent in silence (subtitle credits, channel sign-offs).
const HALLUCINATIONS = [/редактор субтитров/i, /субтитры (сделал|создавал|подготовил)/i, /корректор а\./i, /продолжение следует/i, /dimatorzok/i, /^subtitles by/i, /amara\.org/i];

export function isHallucination(text: string) {
  return HALLUCINATIONS.some((re) => re.test(text));
}

export function parseWhisperJson(raw: WhisperJson, method: TimestampMethod, offsetSeconds = 0, silences: Span[] = []): Transcript {
  const segments: Segment[] = [];
  for (const seg of raw.transcription) {
    if (isHallucination(seg.text)) continue;
    segments.push(...splitPhrases(wordsFromSegment(seg, method, offsetSeconds * 1000, silences), raw.result.language));
  }
  return { language: raw.result.language, segments };
}

/** whisper.cpp DTW presets are per model; infer from the ggml file name. */
export function dtwPresetFor(modelPath: string): string | null {
  const name = path.basename(modelPath).toLowerCase();
  const table: [RegExp, string][] = [
    [/large-v3-turbo/, "large.v3.turbo"],
    [/large-v3/, "large.v3"],
    [/large-v2/, "large.v2"],
    [/large-v1/, "large.v1"],
    [/medium\.en/, "medium.en"],
    [/medium/, "medium"],
    [/small\.en/, "small.en"],
    [/small/, "small"],
    [/base\.en/, "base.en"],
    [/base/, "base"],
    [/tiny\.en/, "tiny.en"],
    [/tiny/, "tiny"],
  ];
  return table.find(([re]) => re.test(name))?.[1] ?? null;
}

// ---- silence-based chunking ----
// whisper.cpp's own VAD remaps segment times but leaves token times in VAD-compressed
// time, which breaks word-level timestamps. So silence detection and chunking happen
// here, and every chunk is transcribed with an exactly known offset.

export interface Span {
  start: number;
  end: number;
}

export function parseSilenceLog(log: string, duration: number): Span[] {
  const spans: Span[] = [];
  let open: number | null = null;
  for (const m of log.matchAll(/silence_(start|end): (-?[\d.]+)/g)) {
    if (m[1] === "start") open = Number(m[2]);
    else if (open !== null) {
      spans.push({ start: Math.max(0, open), end: Number(m[2]) });
      open = null;
    }
  }
  if (open !== null) spans.push({ start: Math.max(0, open), end: duration });
  return spans;
}

export async function detectSilences(audio: string, duration: number, noiseDb = -35, minSilence = 0.25): Promise<Span[]> {
  const { stderr } = await ffmpeg(["-i", audio, "-af", `silencedetect=n=${noiseDb}dB:d=${minSilence}`, "-f", "null", "-"], { loglevel: "info" });
  return parseSilenceLog(stderr, duration);
}

export interface ChunkOptions {
  /** whisper encodes fixed 30 s windows, so a chunk should fill one window and not spill into a second */
  target?: number;
  /** silence kept around speech on each side */
  pad?: number;
}

/** Packs speech runs (gaps between silences) into chunks of ≤ target seconds, never cutting through speech. */
export function planSpeechChunks(silences: Span[], duration: number, opts: ChunkOptions = {}): Span[] {
  const target = opts.target ?? 28;
  const pad = opts.pad ?? 0.3;
  const runs: Span[] = [];
  let cursor = 0;
  for (const s of silences.sort((a, b) => a.start - b.start)) {
    if (s.start > cursor) runs.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < duration) runs.push({ start: cursor, end: duration });
  if (runs.length === 0) return [];

  const chunks: Span[] = [];
  let cur: Span | null = null;
  for (const r of runs) {
    if (cur && r.end - cur.start <= target) cur.end = r.end;
    else {
      if (cur) chunks.push(cur);
      cur = { start: r.start, end: r.end };
    }
  }
  if (cur) chunks.push(cur);

  // pad into the surrounding silence, meeting in the middle when neighbours are close
  return chunks.map((c, i) => {
    const prevEnd = i > 0 ? chunks[i - 1].end : 0;
    const nextStart = i < chunks.length - 1 ? chunks[i + 1].start : duration;
    return {
      start: Math.max(prevEnd, c.start - pad, i > 0 ? (prevEnd + c.start) / 2 : 0),
      end: Math.min(nextStart, c.end + pad, i < chunks.length - 1 ? (c.end + nextStart) / 2 : duration),
    };
  });
}

export interface TranscribeOptions {
  threads?: number;
  language?: string; // whisper code; default: auto-detect per chunk
  method?: TimestampMethod;
  chunk?: ChunkOptions;
}

export interface ChunkRecord extends Span {
  index: number;
  json: string;
  language: string;
  wall_seconds: number;
}

export interface TranscribeResult {
  transcript: Transcript;
  chunks: ChunkRecord[];
  model: string;
  method: TimestampMethod;
  wall_seconds: number;
  warnings: string[];
}

/**
 * Transcribes a 16 kHz mono WAV with whisper.cpp. Raw per-chunk output is kept in
 * <outDir>/whisper/chunk_<n>.json plus a chunks.json manifest.
 */
export async function transcribe(audioPath: string, duration: number, outDir: string, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  if (!(await exists(WHISPER_BIN))) {
    throw new Error(`whisper-cli not found at ${WHISPER_BIN}. Download a whisper.cpp release into vendor/whisper/bin or set WHISPER_BIN.`);
  }
  if (!(await exists(WHISPER_MODEL))) {
    throw new Error(`whisper model not found at ${WHISPER_MODEL}. See README (stage 2) or set WHISPER_MODEL.`);
  }
  const warnings: string[] = [];
  const wantDtw = (opts.method ?? "dtw") === "dtw";
  const preset = wantDtw ? dtwPresetFor(WHISPER_MODEL) : null;
  if (wantDtw && !preset) warnings.push(`no DTW preset for ${path.basename(WHISPER_MODEL)} — using heuristic token timestamps`);
  const method: TimestampMethod = preset ? "dtw" : "tokens";
  const threads = opts.threads ?? Math.max(4, Math.min(16, os.cpus().length));

  // short pauses only bound words; chunks are cut at pauses of ≥ 0.5 s
  const silences = await detectSilences(audioPath, duration);
  const spans = planSpeechChunks(silences.filter((s) => s.end - s.start >= 0.5), duration, opts.chunk);
  await fs.mkdir(path.join(outDir, "whisper"), { recursive: true });
  await fs.writeFile(path.join(outDir, "whisper", "silences.json"), JSON.stringify(silences));
  const workDir = path.join(outDir, "whisper");
  await fs.mkdir(workDir, { recursive: true });

  const t0 = Date.now();
  const chunks: ChunkRecord[] = [];
  const segments: Segment[] = [];
  for (const [index, span] of spans.entries()) {
    const wav = path.join(workDir, `chunk_${index}.wav`);
    const base = path.join(workDir, `chunk_${index}`);
    await ffmpeg(["-ss", span.start.toFixed(3), "-t", (span.end - span.start).toFixed(3), "-i", audioPath, "-c:a", "pcm_s16le", wav]);
    const tc = Date.now();
    try {
      await runWhisperCli(wav, base, { threads, language: opts.language ?? "auto", preset });
    } catch (err) {
      warnings.push(`chunk ${index} (${span.start.toFixed(1)}-${span.end.toFixed(1)}s) failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    } finally {
      await fs.rm(wav, { force: true });
    }
    const raw = JSON.parse(await fs.readFile(`${base}.json`, "utf8")) as WhisperJson;
    const part = parseWhisperJson(raw, method, span.start, silences);
    const dropped = raw.transcription.filter((s) => isHallucination(s.text));
    for (const d of dropped) warnings.push(`chunk ${index}: dropped likely hallucination "${d.text.trim()}"`);
    segments.push(...part.segments);
    chunks.push({ index, ...span, json: `${base}.json`, language: raw.result.language, wall_seconds: (Date.now() - tc) / 1000 });
  }
  await fs.writeFile(path.join(workDir, "chunks.json"), JSON.stringify({ method, chunks }, null, 2));

  // the file's language is the one that covers the most speech
  const byLang = new Map<string, number>();
  for (const s of segments) byLang.set(s.lang ?? "unknown", (byLang.get(s.lang ?? "unknown") ?? 0) + (s.end - s.start));
  const language = [...byLang.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";

  return {
    transcript: { language, segments: segments.sort((a, b) => a.start - b.start) },
    chunks,
    model: path.basename(WHISPER_MODEL),
    method,
    wall_seconds: (Date.now() - t0) / 1000,
    warnings,
  };
}

async function runWhisperCli(wav: string, outBase: string, o: { threads: number; language: string; preset: string | null }) {
  // whisper.cpp (Windows build) aborts with 0xC0000409 when a *model* path contains
  // non-ASCII characters; audio/output paths are fine. So the process runs inside the
  // model's directory and gets the model by file name.
  const cwd = path.dirname(WHISPER_MODEL);
  const args = [
    "-m", path.basename(WHISPER_MODEL),
    "-f", path.resolve(wav),
    "-l", o.language,
    "-t", String(o.threads),
    "-ojf", "-np",
    "-nfa", // DTW timestamps are unavailable with flash attention
    "-of", path.resolve(outBase),
  ];
  if (o.preset) args.push("-dtw", o.preset);
  await runProcess(WHISPER_BIN, args, { cwd });
}
