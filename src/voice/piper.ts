import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { requireVoice, type VoiceDef } from "./catalog.ts";
import { normalizeForTts, splitSentences } from "./normalize.ts";

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
export type SentenceSynth = (text: string, voice: VoiceDef, o: { lengthScale: number; noiseScale?: number }) => Promise<PcmClip>;

export interface SynthOptions {
  /** > 1 slower, < 1 faster (Piper length_scale); default 1.0 */
  lengthScale?: number;
  noiseScale?: number;
  /** pause between sentences of a line, ms (default 180) */
  sentencePauseMs?: number;
  /** pause between lines, ms (default 380) */
  linePauseMs?: number;
  /** silence at the very end, ms (default 150) */
  tailMs?: number;
  /** text normalisation (numbers → words…); default on */
  normalize?: boolean;
  synth?: SentenceSynth;
  /** parallel piper processes (default 3) */
  concurrency?: number;
  onEvent?: (line: string) => void;
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
    const p = spawn(cmd, args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
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
    const pcm = await new Promise<Buffer>((resolve, reject) => {
      const p = spawn(exe, args, { cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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

/**
 * Text (one string, or lines — a line per beat/paragraph) → one WAV + timings.
 * Empty lines are kept as zero-length entries so line indexes match the input.
 */
export async function synthesize(text: string | string[], voiceId: string, outWav: string, o: SynthOptions = {}): Promise<SynthResult> {
  const voice = requireVoice(voiceId);
  if (voice.engine !== "piper") throw new Error(`голос ${voice.id} звучит только в Colab (движок ${voice.engine}); локально доступны Piper-голоса — vedit voices`);
  const synth = o.synth ?? defaultSynth ?? piperSynth({ onEvent: o.onEvent });
  const lines = (Array.isArray(text) ? text : [text]).map((l) => l.replace(/\s+/g, " ").trim());
  const lengthScale = o.lengthScale ?? 1.0;
  const jobs: { line: number; text: string; spoken: string }[] = [];
  lines.forEach((line, i) => {
    for (const sent of splitSentences(line)) {
      const spoken = o.normalize === false ? sent : normalizeForTts(sent, voice.language);
      if (/[\p{L}\p{N}]/u.test(spoken)) jobs.push({ line: i, text: sent, spoken });
    }
  });
  if (!jobs.length) throw new Error("нечего озвучивать: текст пустой");
  const pieces = await mapLimit(jobs, o.concurrency ?? 3, async (j) => trimSilence(await synth(j.spoken, voice, { lengthScale, noiseScale: o.noiseScale })));
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
  return { file: outWav, voice: voice.id, duration, sampleRate: rate, lines: lineTimings, sentences, clips };
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
