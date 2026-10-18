import { spawn } from "node:child_process";
import { jobSignal } from "../lib/abort.ts";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { piperVoiceFor, requireVoice, type VoiceDef } from "./catalog.ts";
import { GEMINI_KEY_HELP, geminiApiKey, geminiTts, GeminiTtsError, narratorStyle, type GeminiTtsOptions } from "./gemini.ts";
import { bcp47, CLOUD_KEY_HELP, cloudApiKey, cloudTts, type CloudTtsOptions } from "./cloudtts.ts";

/** What to tell the user when no Google TTS key exists (either source works). */
export const TTS_KEYS_HELP = `Подойдёт любой из двух ключей (если есть оба — берётся Cloud).

Вариант 1 — Google Cloud:
${CLOUD_KEY_HELP}

Вариант 2 — Google AI Studio:
${GEMINI_KEY_HELP}`;

export type CloudKind = "cloud-gemini" | "cloud-chirp3" | "gemini-api";

/** Which Google backend speaks a gemini/chirp3 voice: the Cloud key first, then the Gemini API key; null = none. */
export function cloudBackend(voice: VoiceDef, o: Pick<SynthOptions, "gemini" | "cloud"> = {}): { kind: CloudKind; warning?: string } | null {
  const cloud = o.cloud?.key !== undefined ? o.cloud.key : cloudApiKey();
  const gemini = o.gemini?.key !== undefined ? o.gemini.key : geminiApiKey();
  if (cloud) return { kind: voice.engine === "chirp3" ? "cloud-chirp3" : "cloud-gemini" };
  if (gemini) {
    return voice.engine === "chirp3"
      ? { kind: "gemini-api", warning: `голос ${voice.id} — Chirp 3 HD из Cloud TTS; ключа GOOGLE_CLOUD_API_KEY нет, говорю тем же голосом ${voice.gemini?.voiceName} через Gemini API` }
      : { kind: "gemini-api" };
  }
  return null;
}
import { normalizeForTts, splitSentences, stripMarkup } from "./normalize.ts";
import { pronounce, type PronounceOptions } from "./pronounce.ts";
import { splitTake } from "./take.ts";
import { alignTake } from "./align.ts";

/**
 * Local Piper TTS (rhasspy/piper 2023.11.14-2, MIT; CPU, ~0.1× real time on an i7).
 * The standalone binary and the voices are downloaded on first use into tools/voice/ (gitignored):
 *   tools/voice/bin/piper/piper(.exe) + espeak-ng-data   ~22 MB
 *   tools/voice/models/<voice>.onnx(.json)              ~60 MB per voice
 * Windows gotcha (as with whisper.cpp): piper/espeak-ng cannot open files under a non-ASCII path
 * («C:\Users\…\монтаж»): the process runs with cwd = the piper folder and gets *relative* paths for the
 * model and espeak-ng-data, and the audio comes back through stdout (--output_raw), never through a path.
 *
 * synthesize() speaks sentence by sentence (one piper call each, a few in parallel), joins the pieces with
 * fixed pauses and returns exact per-sentence / per-line timings (sample counts), which `make` uses to
 * stretch scenes to the voice and to time captions.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VOICE_HOME = process.env.VEDIT_VOICE_DIR || path.join(ROOT, "tools", "voice");
export const PIPER_DIR = path.join(VOICE_HOME, "bin", "piper");
export const MODELS_DIR = path.join(VOICE_HOME, "models");
export const PIPER_RELEASE = "2023.11.14-2";
const PIPER_ASSET: Partial<Record<string, string>> = {
  "win32-x64": "piper_windows_amd64.zip",
  "linux-x64": "piper_linux_x86_64.tar.gz",
  "linux-arm64": "piper_linux_aarch64.tar.gz",
  "darwin-x64": "piper_macos_x64.tar.gz",
  "darwin-arm64": "piper_macos_aarch64.tar.gz",
};
const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

export const piperExe = (dir = PIPER_DIR) => path.join(dir, process.platform === "win32" ? "piper.exe" : "piper");

export interface PcmClip {
  /** mono signed 16-bit samples */
  pcm: Int16Array;
  rate: number;
}

/** One sentence → audio. The real one runs Piper; tests pass a stub. */
export type SentenceSynth = (text: string, voice: VoiceDef, o: { lengthScale: number; noiseScale?: number; noiseW?: number }) => Promise<PcmClip>;

export interface SynthOptions {
  /** > 1 slower, < 1 faster (Piper length_scale); default 1.0 */
  lengthScale?: number;
  /** generator noise (Piper default 0.667): a little more sounds less robotic */
  noiseScale?: number;
  /** phoneme width noise (Piper default 0.8): more = less even rhythm */
  noiseW?: number;
  /** small deterministic per-sentence variation of tempo and rhythm (questions a touch slower), so a long
   *  narration does not sound like one flat take */
  vary?: boolean;
  /** pause between sentences of a line, ms (default 180) */
  sentencePauseMs?: number;
  /** pause between lines, ms (default 380) */
  linePauseMs?: number;
  /** silence at the very end, ms (default 150) */
  tailMs?: number;
  /** text normalisation (numbers → words…); default on */
  normalize?: boolean;
  /** language of the text (ru, uz, en…; default: the voice's language) — Gemini voices speak whatever they are given */
  language?: string;
  /**
   * pronunciation layer (pronounce.ts: brand names as a Russian narrator says them, numbers with case agreement,
   * stress marks where the engine honours them); default on for every engine. false: the old behaviour
   * (Piper — normalizeForTts, Gemini/Cloud — markup stripped only). An object tunes it (extra terms, latin mode).
   */
  pronounce?: false | PronounceOptions;
  /**
   * Gemini/Cloud Gemini-TTS: "single" (default) speaks all lines in one request and cuts the take at the paragraph
   * pauses (falls back to "line" when the cut is implausible); "line": one request per line. VEDIT_TTS_TAKE=line.
   */
  take?: "single" | "line";
  synth?: SentenceSynth;
  /** parallel piper processes (default 3; Gemini requests: 1, VEDIT_GEMINI_TTS_CONCURRENCY up to 2) */
  concurrency?: number;
  onEvent?: (line: string) => void;
  /** Gemini engine: a delivery style for the whole narration (default NARRATOR_STYLE) and test hooks (fetch, key, cacheDir) */
  gemini?: GeminiTtsOptions;
  /** Cloud Text-to-Speech (Gemini-TTS / Chirp 3: HD): key, pace, test hooks; the style comes from gemini.style */
  cloud?: CloudTtsOptions;
}

export interface SentenceTiming {
  line: number;
  /** what was written */
  text: string;
  /** what was spoken (after normalisation) */
  spoken: string;
  start: number;
  end: number;
}
export interface LineTiming {
  i: number;
  text: string;
  start: number;
  end: number;
}
export interface SynthResult {
  file: string;
  voice: string;
  duration: number;
  sampleRate: number;
  lines: LineTiming[];
  sentences: SentenceTiming[];
  /** each line's own audio (no pauses around it), for placing lines on a timeline */
  clips: PcmClip[];
  /** engine that actually spoke: piper, gemini (Gemini API) or cloud (Cloud TTS); a cloud voice without a key falls back to Piper */
  engine: "piper" | "gemini" | "cloud";
  /** gemini/cloud: the model that answered (gemini-2.5-flash-tts, chirp3-hd…) */
  model?: string;
  /** e.g. "no Gemini key — Piper dmitri instead" */
  warnings: string[];
}

let defaultSynth: SentenceSynth | null = null;
/** Test hook: replace the Piper call for every synthesize() without an explicit `synth`. */
export function setSentenceSynth(fn: SentenceSynth | null) {
  defaultSynth = fn;
}

// ---- downloads ----

async function download(url: string, dest: string, label: string, onEvent?: (l: string) => void, expectBytes?: number) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`${label}: HTTP ${res.status} ${res.statusText} (${url})`);
  const total = Number(res.headers.get("content-length")) || expectBytes || 0;
  let got = 0;
  let lastPct = -10;
  const counter = Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>);
  counter.on("data", (chunk: Buffer) => {
    got += chunk.length;
    const pct = total ? Math.floor((got / total) * 100) : 0;
    if (total && pct >= lastPct + 10) {
      lastPct = pct - (pct % 10);
      onEvent?.(`  ${label}: ${lastPct}% (${(got / 1e6).toFixed(0)}/${(total / 1e6).toFixed(0)} МБ)`);
    }
  });
  const tmp = `${dest}.part`;
  await pipeline(counter, createWriteStream(tmp));
  if (expectBytes && got !== expectBytes) {
    await fs.rm(tmp, { force: true });
    throw new Error(`${label}: скачано ${got} байт, ожидалось ${expectBytes}`);
  }
  await fs.rename(tmp, dest);
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"], signal: jobSignal() });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")}: код ${code}\n${err.slice(-500)}`))));
  });
}

/** The Piper binary, downloaded and unpacked on first use. */
export async function ensurePiper(o: { dir?: string; onEvent?: (l: string) => void } = {}): Promise<string> {
  const dir = o.dir ?? PIPER_DIR;
  const exe = piperExe(dir);
  try {
    await fs.access(exe);
    return exe;
  } catch {}
  const asset = PIPER_ASSET[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error(`Piper не собран для ${process.platform}-${process.arch}`);
  o.onEvent?.(`▸ ставлю Piper ${PIPER_RELEASE} (${asset}, ~22 МБ) → ${path.dirname(dir)}`);
  const parent = path.dirname(dir);
  const archive = path.join(parent, asset);
  await download(`https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/${asset}`, archive, "piper", o.onEvent);
  // bsdtar (Windows 10+) and GNU tar unpack both .zip and .tar.gz; run in the folder with a relative name (non-ASCII paths)
  await run("tar", ["-xf", asset], parent);
  await fs.rm(archive, { force: true });
  await fs.access(exe);
  return exe;
}

/** A Piper voice's .onnx + .onnx.json, downloaded on first use. Returns the .onnx path. */
export async function ensureVoiceModel(v: VoiceDef, o: { dir?: string; onEvent?: (l: string) => void } = {}): Promise<string> {
  if (!v.piper) throw new Error(`голос ${v.id} — не Piper (движок ${v.engine})`);
  const dir = o.dir ?? MODELS_DIR;
  const onnx = path.join(dir, `${v.piper.key}.onnx`);
  const json = `${onnx}.json`;
  const ok = async (f: string) => fs.stat(f).then((s) => s.size > 0).catch(() => false);
  if (!(await ok(json))) await download(`${HF_BASE}/${v.piper.path}/${v.piper.key}.onnx.json?download=true`, json, `${v.piper.key}.onnx.json`);
  if (!(await ok(onnx))) {
    o.onEvent?.(`▸ скачиваю голос ${v.id} (${v.piper.key}, ${(v.piper.bytes / 1e6).toFixed(0)} МБ, ${v.license})`);
    await download(`${HF_BASE}/${v.piper.path}/${v.piper.key}.onnx?download=true`, onnx, v.piper.key, o.onEvent, v.piper.bytes);
  }
  return onnx;
}

/** Sample rate of a downloaded voice (from its .onnx.json). */
export async function voiceSampleRate(onnx: string): Promise<number> {
  const cfg = JSON.parse(await fs.readFile(`${onnx}.json`, "utf8")) as { audio?: { sample_rate?: number } };
  return cfg.audio?.sample_rate ?? 22050;
}

/** The real sentence synthesiser: one piper process, text on stdin, raw PCM on stdout. */
export function piperSynth(o: { piperDir?: string; modelsDir?: string; onEvent?: (l: string) => void } = {}): SentenceSynth {
  const prepared = new Map<string, Promise<{ exe: string; onnx: string; rate: number }>>();
  const prepare = (v: VoiceDef) => {
    let p = prepared.get(v.id);
    if (!p) {
      p = (async () => {
        const exe = await ensurePiper({ dir: o.piperDir, onEvent: o.onEvent });
        const onnx = await ensureVoiceModel(v, { dir: o.modelsDir, onEvent: o.onEvent });
        return { exe, onnx, rate: await voiceSampleRate(onnx) };
      })();
      p.catch(() => prepared.delete(v.id));
      prepared.set(v.id, p);
    }
    return p;
  };
  return async (text, v, opt) => {
    const { exe, onnx, rate } = await prepare(v);
    const cwd = path.dirname(exe);
    const rel = (f: string) => {
      const r = path.relative(cwd, f);
      return path.isAbsolute(r) ? f : r;
    };
    const args = ["--model", rel(onnx), "--espeak_data", "espeak-ng-data", "--output_raw", "--quiet", "--length_scale", String(opt.lengthScale), "--sentence_silence", "0"];
    if (opt.noiseScale !== undefined) args.push("--noise_scale", String(opt.noiseScale));
    if (opt.noiseW !== undefined) args.push("--noise_w", String(opt.noiseW));
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(exe, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, signal: jobSignal() });
      const out: Buffer[] = [];
      let err = "";
      p.stdout.on("data", (d: Buffer) => out.push(d));
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`piper: код ${code}: ${err.trim().split("\n").slice(-3).join(" | ")}`))));
      p.stdin.end(`${text.replace(/\s+/g, " ").trim()}\n`, "utf8");
    });
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
    return { pcm: Int16Array.from(samples), rate };
  };
}

// ---- PCM helpers ----

/** Cuts leading/trailing near-silence, keeping `padMs` around the speech. */
export function trimSilence(c: PcmClip, threshold = 250, padMs = 40): PcmClip {
  const { pcm, rate } = c;
  let a = 0;
  let b = pcm.length;
  while (a < b && Math.abs(pcm[a]) < threshold) a++;
  while (b > a && Math.abs(pcm[b - 1]) < threshold) b--;
  if (a >= b) return { pcm: new Int16Array(0), rate };
  const pad = Math.round((rate * padMs) / 1000);
  return { pcm: pcm.slice(Math.max(0, a - pad), Math.min(pcm.length, b + pad)), rate };
}

/** Joins clips with silences of the given lengths (gaps[i] goes before clips[i]). */
export function concatPcm(clips: Int16Array[], gaps: number[]): Int16Array {
  const total = clips.reduce((n, c, i) => n + c.length + (gaps[i] ?? 0), 0);
  const out = new Int16Array(total);
  let at = 0;
  clips.forEach((c, i) => {
    at += gaps[i] ?? 0;
    out.set(c, at);
    at += c.length;
  });
  return out;
}

/** Mono 16-bit PCM → WAV bytes. */
export function wavBytes(pcm: Int16Array, rate: number): Buffer {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

export async function writeWav(file: string, pcm: Int16Array, rate: number) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, wavBytes(pcm, rate));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** tempo offsets cycled over sentences (vary): ±3 %, never two equal in a row */
const TEMPO_JITTER = [0, -0.03, 0.02, -0.015, 0.03, -0.02];

/** Piper parameters for sentence k: the base tempo, varied a little per sentence when asked. */
export function sentenceParams(text: string, k: number, lengthScale: number, o: Pick<SynthOptions, "noiseScale" | "noiseW" | "vary"> = {}): { lengthScale: number; noiseScale?: number; noiseW?: number } {
  if (!o.vary) return { lengthScale, noiseScale: o.noiseScale, noiseW: o.noiseW };
  const question = /\?\s*$/.test(text) ? 0.04 : 0;
  const ls = r3(lengthScale * (1 + TEMPO_JITTER[k % TEMPO_JITTER.length] + question));
  const nw = o.noiseW !== undefined ? r3(o.noiseW + ((k % 3) - 1) * 0.05) : undefined;
  return { lengthScale: ls, noiseScale: o.noiseScale, noiseW: nw };
}

/**
 * Text (one string, or lines — a line per beat/paragraph) → one WAV + timings.
 * Empty lines are kept as zero-length entries so line indexes match the input.
 */
export async function synthesize(text: string | string[], voiceId: string, outWav: string, o: SynthOptions = {}): Promise<SynthResult> {
  let voice = requireVoice(voiceId);
  const warnings: string[] = [];
  const lines = (Array.isArray(text) ? text : [text]).map((l) => l.replace(/\s+/g, " ").trim());
  if (voice.engine === "gemini" || voice.engine === "chirp3") {
    const backend = cloudBackend(voice, o);
    let failure = "";
    if (backend) {
      if (backend.warning) o.onEvent?.(`⚠ ${backend.warning}`);
      try {
        const r = await synthesizeCloud(lines, voice, outWav, o, backend.kind);
        return backend.warning ? { ...r, warnings: [backend.warning, ...r.warnings] } : r;
      } catch (err) {
        // a rejected key, exhausted quotas on every model, no network: the video still gets a (Piper) voice
        if (!(err instanceof GeminiTtsError)) throw err;
        failure = err.message;
      }
    }
    const fb = piperVoiceFor(voice);
    if (!fb) throw new Error(failure || TTS_KEYS_HELP);
    const name = voice.engine === "chirp3" ? "Chirp 3 HD" : "Gemini";
    const w = failure
      ? `голос ${voice.id} (${name}) не получился (${failure.split("\n")[0]}) — озвучиваю Piper ${fb.id}.`
      : `голос ${voice.id} (${name}) недоступен без ключа Google — озвучиваю Piper ${fb.id}.\n${TTS_KEYS_HELP}`;
    warnings.push(w);
    o.onEvent?.(`⚠ ${w}`);
    voice = fb;
  }
  if (voice.engine !== "piper") throw new Error(`голос ${voice.id} звучит только в Colab (движок ${voice.engine}); здесь доступны Piper- и Gemini-голоса — vedit voices`);
  const synth = o.synth ?? defaultSynth ?? piperSynth({ onEvent: o.onEvent });
  const lengthScale = o.lengthScale ?? 1.0;
  const jobs: { line: number; text: string; spoken: string }[] = [];
  lines.forEach((line, i) => {
    for (const sent of splitSentences(line)) {
      const spoken = o.normalize === false ? sent : o.pronounce === false ? normalizeForTts(sent, voice.language) : pronounce(sent, o.language ?? voice.language, { latin: "translit", ...o.pronounce });
      if (/[\p{L}\p{N}]/u.test(spoken)) jobs.push({ line: i, text: sent, spoken });
    }
  });
  if (!jobs.length) throw new Error("нечего озвучивать: текст пустой");
  const pieces = await mapLimit(jobs, o.concurrency ?? 3, async (j, k) => trimSilence(await synth(j.spoken, voice, sentenceParams(j.text, k, lengthScale, o))));
  const rate = pieces[0].rate;
  if (pieces.some((p) => p.rate !== rate)) throw new Error("piper вернул разную частоту для кусков одного голоса");
  const ms = (x: number) => Math.round((rate * x) / 1000);
  const sentGap = ms(o.sentencePauseMs ?? 180);
  const lineGap = ms(o.linePauseMs ?? 380);

  const sentences: SentenceTiming[] = [];
  const lineTimings: LineTiming[] = lines.map((t, i) => ({ i, text: t, start: 0, end: 0 }));
  const clips: PcmClip[] = [];
  const all: Int16Array[] = [];
  const gaps: number[] = [];
  let at = 0;
  let prevLine = -1;
  for (const [k, j] of jobs.entries()) {
    const gap = k === 0 ? 0 : j.line !== prevLine ? lineGap : sentGap;
    at += gap;
    const len = pieces[k].pcm.length;
    sentences.push({ line: j.line, text: j.text, spoken: j.spoken, start: r3(at / rate), end: r3((at + len) / rate) });
    if (j.line !== prevLine) lineTimings[j.line].start = r3(at / rate);
    lineTimings[j.line].end = r3((at + len) / rate);
    all.push(pieces[k].pcm);
    gaps.push(gap);
    at += len;
    prevLine = j.line;
  }
  // per-line clips (sentences joined with the sentence pause, no line pauses)
  for (let i = 0; i < lines.length; i++) {
    const idx = jobs.map((j, k) => (j.line === i ? k : -1)).filter((k) => k >= 0);
    clips.push({ pcm: concatPcm(idx.map((k) => pieces[k].pcm), idx.map((_, n) => (n ? sentGap : 0))), rate });
  }
  const tail = ms(o.tailMs ?? 150);
  const pcm = concatPcm([...all, new Int16Array(tail)], [...gaps, 0]);
  await writeWav(outWav, pcm, rate);
  const duration = r3(pcm.length / rate);
  o.onEvent?.(`  голос ${voice.id}: ${jobs.length} предложений, ${duration.toFixed(1)} с`);
  return { file: outWav, voice: voice.id, duration, sampleRate: rate, lines: lineTimings, sentences, clips, engine: "piper", warnings };
}

/** Sentence times inside one line of audio, proportional to the spoken length of each sentence. */
export function splitLineTimes(spoken: string[], start: number, end: number): { start: number; end: number }[] {
  const w = spoken.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length + 4);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return w.map((x) => {
    const d = ((end - start) * x) / total;
    const r = { start: r3(t), end: r3(t + d) };
    t += d;
    return r;
  });
}

/** added to the style of a one-take narration: the paragraph pauses are where the take is cut into beats */
export const TAKE_STYLE = "each paragraph is one beat of a short video: leave a clear half-second pause between paragraphs, keep the same energy throughout";

/** pronunciation defaults for the Google voices (see the stage 25 measurements in README) */
export const CLOUD_PRONOUNCE: PronounceOptions = { latin: "translit", expandAcronyms: false, stress: process.env.VEDIT_TTS_STRESS === "1" };

/**
 * Gemini / Chirp voice (Gemini API or Cloud TTS). Stage 25: the whole narration is ONE request (a paragraph per line,
 * cut back into lines at the paragraph pauses by take.ts — one intonation, and 1 of the 10 daily free-tier requests of
 * gemini-3.8-flash-tts instead of 7); when the cut is implausible, or for Chirp, one request per line (a line is one
 * take, so its sentences keep one intonation). The same style everywhere, lines joined with the line pause.
 * Sentence times inside a line are proportional to their spoken length.
 */
async function synthesizeCloud(lines: string[], voice: VoiceDef, outWav: string, o: SynthOptions, kind: CloudKind): Promise<SynthResult> {
  const name = voice.gemini?.voiceName;
  if (!name) throw new Error(`голос ${voice.id}: нет имени голоса Gemini`);
  const languageCode = bcp47(voice.language);
  const style = o.gemini?.style ?? narratorStyle();
  const sentenceJobs = lines.map((line) =>
    splitSentences(line)
      // the pronunciation layer: brands the Russian way, numbers spelled with agreement (Gemini read «Anthropic» as
      // «Энсропик», «Nvidia» as «Нвидиа» and «3.5 Sonnet» as «три с половиной» before it, stage 25)
      .map((sent) => ({ text: sent, spoken: o.pronounce === false ? (o.normalize === true ? normalizeForTts(sent, voice.language) : stripMarkup(sent)) : pronounce(sent, o.language ?? voice.language, { ...CLOUD_PRONOUNCE, ...o.pronounce }) }))
      .filter((j) => /[\p{L}\p{N}]/u.test(j.spoken)),
  );
  if (!sentenceJobs.some((j) => j.length)) throw new Error("нечего озвучивать: текст пустой");
  const conc = Math.max(1, Math.min(2, o.concurrency ?? (Number(process.env.VEDIT_GEMINI_TTS_CONCURRENCY) || 1)));
  const models = new Set<string>();
  let cached = 0;
  let requests = 0;
  const onEvent = o.cloud?.onEvent ?? o.gemini?.onEvent ?? o.onEvent;
  const speak = async (text: string, st: string) => {
    requests++;
    const r =
      kind === "gemini-api"
        ? await geminiTts(text, name, { ...o.gemini, style: st, onEvent })
        : await cloudTts(text, { kind: kind === "cloud-chirp3" ? "chirp3" : "gemini", voiceName: name, languageCode }, { ...o.cloud, prompt: o.cloud?.prompt ?? st, onEvent });
    models.add(r.model);
    if (r.cached) cached++;
    return r;
  };
  const spokenLines = sentenceJobs.map((jobs) => jobs.map((j) => j.spoken).join(" "));
  const withSpeech = spokenLines.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
  let pieces: (PcmClip | null)[] | null = null;
  // one take for the whole narration (one request, one intonation), cut back into lines at the paragraph pauses;
  // Chirp 3 HD has no style prompt and is billed per character anyway — it keeps one request per line
  const take = o.take ?? (process.env.VEDIT_TTS_TAKE === "line" ? "line" : "single");
  if (take === "single" && kind !== "cloud-chirp3" && withSpeech.length >= 2) {
    const r = await speak(withSpeech.map((i) => spokenLines[i]).join("\n\n"), `${style}; ${TAKE_STYLE}`);
    // where the paragraphs end: by the words whisper hears (align.ts), else by the pauses (take.ts)
    const aligned = await alignTake(r.pcm, r.rate, withSpeech.map((i) => spokenLines[i]), { language: o.language ?? voice.language }).catch(() => null);
    const spans = aligned ?? splitTake(r.pcm, r.rate, withSpeech.map((i) => sentenceJobs[i].map((j) => j.spoken.replace(/[^\p{L}\p{N}]/gu, "").length + 4)));
    if (spans) onEvent?.(`  дубль разрезан на биты ${aligned ? "по словам (whisper)" : "по паузам"}`);
    if (spans) {
      const out: (PcmClip | null)[] = lines.map(() => null);
      withSpeech.forEach((li, k) => {
        out[li] = trimSilence({ pcm: r.pcm.slice(Math.round(spans[k].start * r.rate), Math.round(spans[k].end * r.rate)), rate: r.rate }, 300, 60);
      });
      pieces = out;
    } else onEvent?.(`  озвучка одним дублем не разрезалась на биты по паузам — читаю по битам`);
  }
  pieces ??= await mapLimit(sentenceJobs, conc, async (jobs) => {
    if (!jobs.length) return null;
    const r = await speak(jobs.map((j) => j.spoken).join(" "), style);
    return trimSilence({ pcm: r.pcm, rate: r.rate }, 300, 60);
  });
  const rate = pieces.find((p) => p)?.rate ?? 24000;
  if (pieces.some((p) => p && p.rate !== rate)) throw new Error("TTS вернул разную частоту для кусков одного голоса");
  const lineGap = Math.round((rate * (o.linePauseMs ?? 380)) / 1000);
  const sentences: SentenceTiming[] = [];
  const lineTimings: LineTiming[] = lines.map((t, i) => ({ i, text: t, start: 0, end: 0 }));
  const clips: PcmClip[] = [];
  const all: Int16Array[] = [];
  const gaps: number[] = [];
  let at = 0;
  let first = true;
  pieces.forEach((p, i) => {
    clips.push(p ?? { pcm: new Int16Array(0), rate });
    if (!p || !p.pcm.length) return;
    const gap = first ? 0 : lineGap;
    first = false;
    at += gap;
    const t0 = at / rate;
    const t1 = (at + p.pcm.length) / rate;
    lineTimings[i].start = r3(t0);
    lineTimings[i].end = r3(t1);
    const times = splitLineTimes(sentenceJobs[i].map((j) => j.spoken), t0, t1);
    sentenceJobs[i].forEach((j, k) => sentences.push({ line: i, text: j.text, spoken: j.spoken, ...times[k] }));
    all.push(p.pcm);
    gaps.push(gap);
    at += p.pcm.length;
  });
  const tail = Math.round((rate * (o.tailMs ?? 150)) / 1000);
  const pcm = concatPcm([...all, new Int16Array(tail)], [...gaps, 0]);
  await writeWav(outWav, pcm, rate);
  const duration = r3(pcm.length / rate);
  const model = [...models].join(", ");
  const engine = kind === "gemini-api" ? "gemini" : "cloud";
  o.onEvent?.(`  голос ${voice.id} (${engine === "gemini" ? "Gemini API" : "Cloud TTS"} ${model}): ${requests} ${requests === 1 ? "запрос (весь текст одним дублем)" : "запросов"}${cached ? ` (${cached} из кэша)` : ""}, ${duration.toFixed(1)} с`);
  return { file: outWav, voice: voice.id, duration, sampleRate: rate, lines: lineTimings, sentences, clips, engine, model, warnings: [] };
}

/** A short sample of a voice as OGG/Opus (Telegram sendVoice). */
export async function voiceSample(voiceId: string, outOgg: string, o: SynthOptions & { text?: string } = {}): Promise<string> {
  const v = requireVoice(voiceId);
  const text = o.text ?? (v.language === "ru" ? "Привет! Это мой голос. Так будет звучать озвучка вашего ролика." : "Hi! This is my voice. Your video's voiceover will sound like this.");
  const tmp = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "vedit-voice-")), "sample.wav");
  try {
    await synthesize(text, v.id, tmp, o);
    await fs.mkdir(path.dirname(outOgg), { recursive: true });
    await ffmpeg(["-i", tmp, "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", "-application", "voip", outOgg]);
    return outOgg;
  } finally {
    await fs.rm(path.dirname(tmp), { recursive: true, force: true }).catch(() => {});
  }
}

/** Is Piper (binary) installed, and which voices are downloaded? For `vedit voices` / modules. */
export async function piperStatus(): Promise<{ binary: boolean; models: string[] }> {
  const binary = await fs.access(piperExe()).then(() => true, () => false);
  const models = (await fs.readdir(MODELS_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".onnx")).map((f) => f.replace(/\.onnx$/, ""));
  return { binary, models };
}
