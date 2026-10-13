import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { jobDir, writeJson } from "../lib/workspace.ts";
import { HighlightsSchema, ScenesSchema, TranscriptSchema, type Highlights, type Media, type Scenes, type Transcript } from "../schemas/index.ts";
import { loudnessTimeline, type LoudnessPoint } from "./loudness.ts";
import { detectShots, extractShotFrames, type Shot } from "./shots.ts";
import { selectVisionProvider, type AnalysisChunk, type VisionChoice } from "./vision/index.ts";
import { transcribe, type TimestampMethod } from "./whisper.ts";
import { findAsrPython, labelSpeakers, transcribeFaster, type AsrChoice } from "./asr.ts";

export const UnderstandReportSchema = z.object({
  transcriber: z
    .object({
      engine: z.string(),
      /** why this engine was chosen (GPU, long file, requested...) */
      reason: z.string().optional(),
      model: z.string(),
      method: z.string(),
      language: z.string(),
      languages: z.array(z.string()),
      speech_chunks: z.number().int(),
      wall_seconds: z.number(),
    })
    .nullable(),
  vision: z.object({ provider: z.string(), note: z.string() }),
  speakers: z.object({ engine: z.string(), count: z.number().int(), wall_seconds: z.number() }).nullable(),
  shots: z.number().int(),
  chunks: z.array(z.object({ index: z.number(), start: z.number(), end: z.number() })),
  phrases: z.number().int(),
  words: z.number().int(),
  warnings: z.array(z.string()),
  wall_seconds: z.number(),
});
export type UnderstandReport = z.infer<typeof UnderstandReportSchema>;

export interface UnderstandOptions {
  threads?: number;
  language?: string;
  method?: TimestampMethod;
  vision?: VisionChoice;
  chunkSeconds?: number;
  sceneThreshold?: number;
  /** transcription engine: auto = faster-whisper when its sidecar is installed, else whisper.cpp (env VEDIT_ASR) */
  asr?: AsrChoice;
  /** label phrases with speakers (needs the sidecar); default on when it is installed (env VEDIT_DIARIZE=0 disables) */
  diarize?: boolean;
  numSpeakers?: number;
  onLog?: (line: string) => void;
}

/** Above this length `auto` takes faster-whisper even on a CPU: whisper.cpp reloads its model for every ~28 s chunk. */
export const LONG_ASR_SECONDS = 20 * 60;

/**
 * Which transcriber runs. `faster` needs the sidecar. `auto` takes faster-whisper when the sidecar
 * is installed AND either an NVIDIA GPU is present (nvidia-smi on PATH) or the file is longer than
 * 20 minutes (`duration`, seconds): whisper.cpp loads the model once per ~28 s chunk (327 loads on a
 * 2 h file), while faster-whisper loads it once and has its own VAD. Short files on a CPU stay on
 * whisper.cpp, which detects the language per chunk, as mixed ru/uz videos need.
 * `reason` says why the engine was chosen.
 */
export async function selectAsr(
  choice: AsrChoice = "auto",
  env: NodeJS.ProcessEnv = process.env,
  probe: { gpu?: () => Promise<boolean> } = {},
  duration?: number,
): Promise<{ engine: "faster-whisper" | "whisper.cpp"; python: string | null; reason: string }> {
  const want = choice === "auto" ? ((env.VEDIT_ASR?.trim() || "auto") as AsrChoice) : choice;
  if (!["auto", "cpp", "faster"].includes(want)) throw new Error(`VEDIT_ASR: ожидается auto | cpp | faster, получено "${want}"`);
  if (want === "cpp") return { engine: "whisper.cpp", python: null, reason: "requested" };
  const python = await findAsrPython(env);
  if (want === "faster") {
    if (!python) throw new Error("--asr faster: сайдкар не установлен (tools/asr/.venv) — см. README «Длинное видео»");
    return { engine: "faster-whisper", python, reason: "requested" };
  }
  if (!python) return { engine: "whisper.cpp", python: null, reason: "sidecar not installed" };
  if (await (probe.gpu ?? (() => hasNvidiaGpu(env)))()) return { engine: "faster-whisper", python, reason: "GPU" };
  if (duration !== undefined && duration > LONG_ASR_SECONDS) return { engine: "faster-whisper", python, reason: `long file (${Math.round(duration / 60)} min > ${LONG_ASR_SECONDS / 60} min on CPU: whisper.cpp would reload the model per chunk)` };
  return { engine: "whisper.cpp", python: null, reason: "CPU, short file" };
}

async function hasNvidiaGpu(env: NodeJS.ProcessEnv): Promise<boolean> {
  const names = process.platform === "win32" ? ["nvidia-smi.exe"] : ["nvidia-smi"];
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      try {
        await fs.access(path.join(dir, n));
        return true;
      } catch {}
    }
  }
  return false;
}

/** Groups shots into analysis chunks of ~target seconds, cutting only on shot boundaries. */
export function makeChunks(shots: Shot[], target = 180, max = 300): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  let start = shots[0]?.start ?? 0;
  for (const [i, s] of shots.entries()) {
    const last = i === shots.length - 1;
    // a single very long shot is split at `max` regardless of boundaries
    while (s.end - start > max) {
      chunks.push({ start, end: start + max });
      start += max;
    }
    if (last || s.end - start >= target) {
      if (s.end > start) chunks.push({ start, end: s.end });
      start = s.end;
    }
  }
  return chunks;
}

export async function understand(jobId: string, media: Media, opts: UnderstandOptions = {}) {
  const dir = jobDir(jobId);
  const warnings: string[] = [];
  const t0 = Date.now();

  // 1. speech → words with timestamps
  let transcript: Transcript = { language: "unknown", segments: [] };
  let transcriber: UnderstandReport["transcriber"] = null;
  const asr = await selectAsr(opts.asr, process.env, {}, media.duration);
  opts.onLog?.(`speech: ${asr.engine} (${asr.reason})`);
  let speakersReport: UnderstandReport["speakers"] = null;
  if (media.audio_path) {
    try {
      const r =
        asr.engine === "faster-whisper"
          ? await transcribeFaster(media.audio_path, media.duration, dir, { threads: opts.threads, language: opts.language, python: asr.python!, onLog: opts.onLog })
          : await transcribe(media.audio_path, media.duration, dir, { threads: opts.threads, language: opts.language, method: opts.method });
      transcript = r.transcript;
      transcriber = {
        engine: asr.engine,
        reason: asr.reason,
        model: r.model,
        method: r.method,
        language: transcript.language,
        languages: [...new Set(r.chunks.map((c) => c.language))],
        speech_chunks: r.chunks.length,
        wall_seconds: r.wall_seconds,
      };
      warnings.push(...r.warnings);
      await addCost(jobId, {
        step: "understand",
        provider: `${asr.engine} (local)`,
        model: r.model,
        units: { audio_seconds: media.duration, wall_seconds: r.wall_seconds },
        usd: 0,
      });
    } catch (err) {
      warnings.push(`transcription failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // who is talking: needs the sidecar; a failure only costs the speaker labels
    const diarize = opts.diarize ?? process.env.VEDIT_DIARIZE?.trim() !== "0";
    const python = asr.python ?? (await findAsrPython());
    if (diarize && python && transcript.segments.length >= 2) {
      try {
        const s = await labelSpeakers(media.audio_path, transcript, dir, { python, numSpeakers: opts.numSpeakers, onLog: opts.onLog });
        transcript = s.transcript;
        speakersReport = { engine: s.speakers.engine, count: s.speakers.speakers.length, wall_seconds: s.wall_seconds };
        await addCost(jobId, { step: "understand", provider: "speaker-labelling (local)", model: s.speakers.engine, units: { phrases: transcript.segments.length, wall_seconds: s.wall_seconds }, usd: 0 });
      } catch (err) {
        warnings.push(`speaker labelling failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (diarize && !python && opts.diarize) {
      warnings.push("speaker labelling skipped: sidecar not installed (tools/asr/.venv)");
    }
  } else {
    warnings.push("no audio track — transcript is empty");
  }
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, transcript);

  // 2. shot boundaries + one frame per shot
  const shots = await detectShots(media.normalized_path, media.duration, opts.sceneThreshold);
  await extractShotFrames(media.normalized_path, shots, dir);

  // 3. loudness curve (for highlight ranking)
  let loudness: LoudnessPoint[] = [];
  if (media.audio_path) {
    try {
      loudness = await loudnessTimeline(media.audio_path);
    } catch (err) {
      warnings.push(`loudness analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. vision model per chunk
  const { provider, note } = await selectVisionProvider(opts.vision);
  const chunks = makeChunks(shots, opts.chunkSeconds);
  const scenes: Scenes = [];
  const highlights: Highlights = [];
  for (const [index, c] of chunks.entries()) {
    const chunk: AnalysisChunk = {
      index,
      start: c.start,
      end: c.end,
      shots: shots.filter((s) => s.start < c.end && s.end > c.start),
      phrases: transcript.segments.filter((p) => p.start < c.end && p.end > c.start),
    };
    try {
      const r = await provider.analyze(chunk, { media, language: transcript.language, loudness });
      scenes.push(...r.scenes);
      highlights.push(...r.highlights);
      await addCost(jobId, { step: "understand", provider: provider.name, model: r.cost.model, units: r.cost.units, usd: r.cost.usd });
    } catch (err) {
      warnings.push(`chunk ${index} (${c.start}-${c.end}s) analysis failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  highlights.sort((a, b) => b.score - a.score);
  await writeJson(path.join(dir, "scenes.json"), ScenesSchema, scenes);
  await writeJson(path.join(dir, "highlights.json"), HighlightsSchema, highlights);

  const report = await writeJson(path.join(dir, "understand.json"), UnderstandReportSchema, {
    transcriber,
    vision: { provider: provider.name, note },
    speakers: speakersReport,
    shots: shots.length,
    chunks: chunks.map((c, index) => ({ index, ...c })),
    phrases: transcript.segments.length,
    words: transcript.segments.reduce((n, s) => n + s.words.length, 0),
    warnings,
    wall_seconds: (Date.now() - t0) / 1000,
  });
  const partial = warnings.some((w) => w.includes("failed"));
  return { ...report, transcript, scenes, highlights, partial };
}
