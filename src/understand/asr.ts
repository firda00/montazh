import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { exists } from "../lib/workspace.ts";
import { SpeakersSchema, type Speakers, type Transcript } from "../schemas/index.ts";
import { isHallucination, splitPhrases, type TranscribeResult } from "./whisper.ts";

/**
 * Python sidecar (tools/asr/vedit_asr.py): faster-whisper transcription and speaker labelling.
 * The venv is optional — without it transcription stays on whisper.cpp and speakers are skipped.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ASR_SCRIPT = path.join(ROOT, "tools", "asr", "vedit_asr.py");
const VENV_PYTHON = path.join(ROOT, "tools", "asr", ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

export type AsrChoice = "auto" | "cpp" | "faster";

/** Python of the sidecar venv, or VEDIT_ASR_PYTHON; null when the sidecar is not installed. */
export async function findAsrPython(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const p = env.VEDIT_ASR_PYTHON?.trim() || VENV_PYTHON;
  return (await exists(p)) && (await exists(ASR_SCRIPT)) ? p : null;
}

export interface SidecarRun {
  code: number | null;
  stderr: string;
}
export type SidecarRunner = (python: string, args: string[], onLog?: (line: string) => void) => Promise<SidecarRun>;

export const runSidecar: SidecarRunner = (python, args, onLog) =>
  new Promise((resolve, reject) => {
    const child = spawn(python, ["-I", ASR_SCRIPT, ...args], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" } });
    let stderr = "";
    child.stderr.on("data", (d) => {
      const s = String(d);
      stderr += s;
      // library deprecation warnings are noise for the user; errors and our own progress lines go through
      if (onLog) for (const line of s.split(/\r?\n/)) if (line.trim() && !/warn(ing)?[:.(]|^\s+warnings\.warn|^[A-Za-z]:\\.*site-packages/i.test(line)) onLog(line.trimEnd());
    });
    child.stdout.on("data", () => {});
    child.on("error", (err) => reject(new Error(`${python} failed to start: ${err.message}`)));
    child.on("close", (code) => resolve({ code, stderr }));
  });

function sidecarError(what: string, r: SidecarRun) {
  const tail = r.stderr.trim().split("\n").slice(-6).join("\n");
  return new Error(`${what} failed (exit ${r.code}):\n${tail}`);
}

// ---- faster-whisper ----

const FasterJson = z.object({
  engine: z.literal("faster-whisper"),
  model: z.string(),
  device: z.string(),
  compute_type: z.string(),
  language: z.string(),
  language_probability: z.number(),
  duration: z.number(),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string(), words: z.array(z.object({ w: z.string(), start: z.number(), end: z.number(), p: z.number().optional() })), no_speech_prob: z.number().optional() })),
  wall_seconds: z.number(),
});

export interface FasterOptions {
  model?: string;
  language?: string;
  threads?: number;
  device?: "auto" | "cpu" | "cuda";
  compute?: string;
  python?: string;
  run?: SidecarRunner;
  onLog?: (line: string) => void;
}

/** Converts sidecar output to the transcript contract: hallucinations dropped, phrases split at sentence ends. */
export function transcriptFromFaster(raw: z.infer<typeof FasterJson>): { transcript: Transcript; dropped: string[] } {
  const dropped: string[] = [];
  const segments: Transcript["segments"] = [];
  for (const s of raw.segments) {
    if (!s.text.trim()) continue;
    if (isHallucination(s.text)) {
      dropped.push(s.text.trim());
      continue;
    }
    const words = s.words.length ? s.words.map((w) => ({ w: w.w, start: w.start, end: Math.max(w.end, w.start + 0.01) })) : [{ w: s.text.trim(), start: s.start, end: s.end }];
    segments.push(...splitPhrases(words, raw.language));
  }
  return { transcript: { language: raw.language, segments: segments.sort((a, b) => a.start - b.start) }, dropped };
}

/** Transcribes a 16 kHz mono WAV with faster-whisper; raw output kept in <outDir>/whisper/faster.json. */
export async function transcribeFaster(audioPath: string, duration: number, outDir: string, opts: FasterOptions = {}): Promise<TranscribeResult> {
  const python = opts.python ?? (await findAsrPython());
  if (!python) throw new Error("faster-whisper sidecar not installed: see README (tools/asr) or set VEDIT_ASR_PYTHON");
  const workDir = path.join(outDir, "whisper");
  await fs.mkdir(workDir, { recursive: true });
  const out = path.join(workDir, "faster.json");
  const model = opts.model ?? process.env.VEDIT_ASR_MODEL ?? "large-v3-turbo";
  const args = ["transcribe", "--audio", audioPath, "--out", out, "--model", model, "--device", opts.device ?? "auto", "--threads", String(opts.threads ?? Math.max(4, Math.min(16, os.cpus().length)))];
  if (opts.language && opts.language !== "auto") args.push("--language", opts.language);
  if (opts.compute) args.push("--compute", opts.compute);
  const t0 = Date.now();
  const r = await (opts.run ?? runSidecar)(python, args, opts.onLog);
  if (r.code !== 0) throw sidecarError("faster-whisper", r);
  const raw = FasterJson.parse(JSON.parse(await fs.readFile(out, "utf8")));
  const { transcript, dropped } = transcriptFromFaster(raw);
  const warnings = dropped.map((d) => `dropped likely hallucination "${d}"`);
  if (raw.language_probability < 0.6) warnings.push(`language detection is unsure (${raw.language}, p=${raw.language_probability}); pass --language for mixed-language videos or use the whisper.cpp engine, which detects per chunk`);
  return {
    transcript,
    chunks: [{ index: 0, start: 0, end: duration, json: out, language: raw.language, wall_seconds: raw.wall_seconds }],
    model: `${raw.model} (faster-whisper, ${raw.device}/${raw.compute_type})`,
    method: "faster-whisper",
    wall_seconds: (Date.now() - t0) / 1000,
    warnings,
  };
}

// ---- speakers ----

const SpeakersJson = z.object({
  engine: z.string(),
  num_speakers: z.number().int(),
  speakers: z.array(z.object({ id: z.string(), seconds: z.number(), phrases: z.number().int() })),
  phrases: z.array(z.object({ i: z.number().int(), speaker: z.string(), confidence: z.number().optional() })),
  wall_seconds: z.number(),
});

export interface SpeakerOptions {
  numSpeakers?: number;
  threshold?: number;
  python?: string;
  run?: SidecarRunner;
  onLog?: (line: string) => void;
}

/**
 * Labels every phrase with a speaker (S1 = talks the most). Returns the transcript with
 * `speaker` on each segment plus the speakers summary written to <outDir>/speakers.json.
 */
export async function labelSpeakers(audioPath: string, transcript: Transcript, outDir: string, opts: SpeakerOptions = {}): Promise<{ transcript: Transcript; speakers: Speakers; wall_seconds: number }> {
  const python = opts.python ?? (await findAsrPython());
  if (!python) throw new Error("speaker sidecar not installed: see README (tools/asr) or set VEDIT_ASR_PYTHON");
  const segs = [...transcript.segments].sort((a, b) => a.start - b.start);
  const workDir = path.join(outDir, "whisper");
  await fs.mkdir(workDir, { recursive: true });
  const phrasesFile = path.join(workDir, "phrases_for_speakers.json");
  const out = path.join(workDir, "speakers_raw.json");
  await fs.writeFile(phrasesFile, JSON.stringify(segs.map((s) => ({ start: s.start, end: s.end }))));
  const args = ["speakers", "--audio", audioPath, "--phrases", phrasesFile, "--out", out];
  if (opts.numSpeakers) args.push("--num-speakers", String(opts.numSpeakers));
  if (opts.threshold) args.push("--threshold", String(opts.threshold));
  const r = await (opts.run ?? runSidecar)(python, args, opts.onLog);
  if (r.code !== 0) throw sidecarError("speaker labelling", r);
  const raw = SpeakersJson.parse(JSON.parse(await fs.readFile(out, "utf8")));
  const byIndex = new Map(raw.phrases.map((p) => [p.i, p]));
  const labelled = segs.map((s, i) => {
    const p = byIndex.get(i);
    return p ? { ...s, speaker: p.speaker } : s;
  });
  const speakers: Speakers = {
    engine: raw.engine,
    speakers: raw.speakers.map((sp) => {
      const own = labelled.filter((s) => s.speaker === sp.id);
      const sample = own.slice().sort((a, b) => b.end - b.start - (a.end - a.start))[0];
      return { id: sp.id, seconds: sp.seconds, phrases: sp.phrases, first_at: own[0]?.start ?? 0, sample: sample ? sample.text.slice(0, 120) : "" };
    }),
  };
  await fs.writeFile(path.join(outDir, "speakers.json"), JSON.stringify(SpeakersSchema.parse(speakers), null, 2));
  return { transcript: { ...transcript, segments: labelled }, speakers, wall_seconds: raw.wall_seconds };
}

/** "S2" → S2; "12:34" / "754" → the speaker talking at that time; "most" → S1. */
export function resolveSpeaker(spec: string, transcript: Transcript, speakers: Speakers): string {
  const s = spec.trim();
  if (/^most$/i.test(s)) return speakers.speakers[0]?.id ?? "S1";
  if (/^S\d+$/i.test(s)) {
    const id = s.toUpperCase();
    if (!speakers.speakers.some((x) => x.id === id)) throw new Error(`speaker ${id} not found; known: ${speakers.speakers.map((x) => `${x.id} (${x.seconds}s)`).join(", ") || "none"}`);
    return id;
  }
  const m = /^(?:(\d+):)?(\d+)(?::(\d+))?(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`--speaker: expected S<n>, a time (mm:ss / h:mm:ss / seconds) or "most", got "${spec}"`);
  const t = m[3] !== undefined ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : m[1] !== undefined ? Number(m[1]) * 60 + Number(m[2]) : Number(m[2]) + (m[4] ? Number(`0.${m[4]}`) : 0);
  const at = transcript.segments.find((p) => t >= p.start && t <= p.end) ?? transcript.segments.slice().sort((a, b) => Math.abs(a.start - t) - Math.abs(b.start - t))[0];
  if (!at?.speaker) throw new Error(`no labelled speech near ${spec}`);
  return at.speaker;
}
