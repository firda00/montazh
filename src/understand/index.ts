import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { jobDir, loadJob, writeJson } from "../lib/workspace.ts";
import { HighlightsSchema, ScenesSchema, TranscriptSchema, type Highlights, type Media, type Scenes, type Transcript } from "../schemas/index.ts";
import { loadPreset } from "../plan/presets.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { transcribeAudio } from "./gemini-audio.ts";
import { loudnessTimeline, type LoudnessPoint } from "./loudness.ts";
import { detectShots, extractShotFrames, type Shot } from "./shots.ts";
import { selectVisionProvider, type AnalysisChunk, type VisionChoice } from "./vision/index.ts";
import { transcribe, type TimestampMethod } from "./whisper.ts";
import { findAsrPython, labelSpeakers, transcribeFaster, type AsrChoice } from "./asr.ts";
import { loadImportedAsr } from "./asr-import.ts";
import { asrFixEnabled, detectLanguage, fixTranscript, tidyTranscript } from "./asrfix.ts";

/** Proportional word timestamps inside [start, end] for segment-level transcribers (Gemini audio). */
function segmentWords(text: string, start: number, end: number): { w: string; start: number; end: number }[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const dur = Math.max(0.05, end - start);
  const weights = tokens.map((x) => x.replace(/[^\p{L}\p{N}]/gu, "").length + 1.5);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let t = start;
  return tokens.map((w, i) => {
    const d = (dur * weights[i]) / total;
    const out = { w, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000 };
    t += d;
    return out;
  });
}

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
  /** stage 25: the correction pass over the transcript (words replaced, timings kept) */
  asr_fix: z.object({ model: z.string(), changes: z.number().int(), usd: z.number(), cached: z.boolean(), examples: z.array(z.string()) }).nullable().default(null),
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
  /**
   * stage 25: what the video is about (the user's instruction, an avatar script): names and terms in it help the
   * correction pass (and whisper's prompt with VEDIT_WHISPER_PROMPT=on)
   */
  hint?: string;
  /** the post-correction pass of names/brands/terms (default: VEDIT_ASR_FIX, auto = on with a Gemini key) */
  asrFix?: boolean;
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
  if (want === "import") throw new Error("asr import is handled by understand() itself");
  if (!["auto", "cpp", "faster"].includes(want)) throw new Error(`VEDIT_ASR: ожидается auto | cpp | faster | import, получено "${want}"`);
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
  const jobMeta = await loadJob(jobId).catch(() => null);
  const presetAsr = jobMeta?.preset ? (await loadPreset(jobMeta.preset).catch(() => null))?.preset.asr : undefined;
  const language = opts.language ?? presetAsr?.language;

  // 1. speech → words with timestamps
  let transcript: Transcript = { language: "unknown", segments: [] };
  let transcriber: UnderstandReport["transcriber"] = null;
  let speakersReport: UnderstandReport["speakers"] = null;
  if (opts.asr === "import") {
    // speech recognised elsewhere (Colab GPU) and imported with `vedit asr-import`
    const imported = await loadImportedAsr(jobId);
    transcript = imported.transcript;
    transcriber = {
      engine: imported.marker.engine,
      reason: `imported from ${path.basename(imported.marker.source)} (${imported.marker.device}/${imported.marker.compute_type})`,
      model: imported.marker.model,
      method: "faster-whisper",
      language: transcript.language,
      languages: [transcript.language],
      speech_chunks: 1,
      wall_seconds: imported.marker.wall_seconds,
    };
    if (imported.speakers) speakersReport = { engine: imported.speakers.engine, count: imported.speakers.speakers.length, wall_seconds: imported.marker.speakers_wall_seconds ?? 0 };
    opts.onLog?.(`speech: imported (${imported.marker.model} on ${imported.marker.device}, ${imported.marker.wall_seconds}s remote)`);
    await addCost(jobId, { step: "understand", provider: "faster-whisper (remote GPU, imported)", model: imported.marker.model, units: { audio_seconds: media.duration, wall_seconds: imported.marker.wall_seconds }, usd: 0 });
  } else if (media.audio_path) {
    let doneByGemini = false;
    if (presetAsr?.engine === "gemini" && (!opts.asr || opts.asr === "auto") && geminiApiKey() && media.duration <= 600) {
      const tg = Date.now();
      opts.onLog?.(`speech: gemini-audio (preset ${jobMeta?.preset}, language ${language ?? "auto"})`);
      try {
        const g = await transcribeAudio(media.audio_path, { hint: opts.hint, onLog: opts.onLog });
        if (g.segments.length) {
          const lang = language ?? g.segments[0]?.language ?? "uz";
          transcript = {
            language: lang,
            segments: g.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, lang: language ?? s.language, words: segmentWords(s.text, s.start, s.end) })).filter((s) => s.words.length > 0),
          };
          const wall = Math.round(((Date.now() - tg) / 1000) * 100) / 100;
          transcriber = { engine: "gemini-audio", reason: `preset ${jobMeta?.preset}`, model: g.model, method: "proportional", language: transcript.language, languages: [...new Set(transcript.segments.map((s) => s.lang ?? transcript.language))], speech_chunks: 1, wall_seconds: wall };
          await addCost(jobId, { step: "understand", provider: "gemini (audio asr)", model: g.model, units: { audio_seconds: media.duration, wall_seconds: wall }, usd: g.usd });
          doneByGemini = true;
        }
      } catch (err) {
        warnings.push(`gemini-audio transcription failed, falling back to whisper: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    const asr = await selectAsr(opts.asr, process.env, {}, media.duration);
    if (!doneByGemini) {
      opts.onLog?.(`speech: ${asr.engine} (${asr.reason})`);
      try {
        const r =
          asr.engine === "faster-whisper"
            ? await transcribeFaster(media.audio_path, media.duration, dir, { threads: opts.threads, language, python: asr.python!, onLog: opts.onLog })
            : await transcribe(media.audio_path, media.duration, dir, { threads: opts.threads, language, method: opts.method, prompt: process.env.VEDIT_WHISPER_PROMPT?.trim().toLowerCase() === "on" || process.env.VEDIT_WHISPER_PROMPT?.trim().toLowerCase() === "carry" ? opts.hint : undefined });
        transcript = r.transcript;
        const looksMangledUz =
          !language &&
          geminiApiKey() &&
          media.duration <= 600 &&
          (["fa", "ar", "ur", "ps", "tr", "az", "tk", "kk", "ky", "ug"].includes(transcript.language) ||
            transcript.segments.some((s) => /[\u0600-\u06FF]/.test(s.text)));
        if (looksMangledUz) {
          const tg = Date.now();
          opts.onLog?.(`speech: whisper returned ${transcript.language} — re-transcribing with gemini-audio`);
          try {
            const g = await transcribeAudio(media.audio_path, { hint: opts.hint, onLog: opts.onLog });
            if (g.segments.length) {
              const lang = g.segments[0]?.language ?? "uz";
              transcript = {
                language: lang,
                segments: g.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, lang: s.language || lang, words: segmentWords(s.text, s.start, s.end) })).filter((s) => s.words.length > 0),
              };
              const wall = Math.round(((Date.now() - tg) / 1000) * 100) / 100;
              transcriber = { engine: "gemini-audio", reason: `fallback from ${r.transcript.language}`, model: g.model, method: "proportional", language: transcript.language, languages: [...new Set(transcript.segments.map((s) => s.lang ?? transcript.language))], speech_chunks: 1, wall_seconds: wall };
              await addCost(jobId, { step: "understand", provider: "gemini (audio asr)", model: g.model, units: { audio_seconds: media.duration, wall_seconds: wall }, usd: g.usd });
              doneByGemini = true;
            }
          } catch (err) {
            warnings.push(`gemini-audio fallback failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
          }
        }
        if (!doneByGemini) {
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
        }
      } catch (err) {
        warnings.push(`transcription failed: ${err instanceof Error ? err.message : String(err)}`);
      }
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
  // stage 25: words as the captions will show them — per-phrase language (mixed ru/uz/en), obvious mishearings of
  // names and terms fixed by one cheap pass (timings untouched), caption hygiene. The raw transcript is kept.
  let asrFix: UnderstandReport["asr_fix"] = null;
  if (transcript.segments.length) {
    await writeJson(path.join(dir, "transcript.raw.json"), TranscriptSchema, transcript);
    transcript = { ...transcript, segments: transcript.segments.map((s) => ({ ...s, lang: detectLanguage(s.text, s.lang ?? transcript.language) })) };
    if (opts.asrFix ?? asrFixEnabled()) {
      try {
        const f = await fixTranscript(transcript, { hint: opts.hint, onLog: opts.onLog });
        transcript = f.transcript;
        asrFix = { model: f.model, changes: f.changes.length, usd: Math.round(f.usd * 1e5) / 1e5, cached: f.cached, examples: f.changes.slice(0, 8).map((c) => `${c.from} → ${c.to}`) };
        opts.onLog?.(`speech fix (${f.model}${f.cached ? ", cache" : ""}): ${f.changes.length} words${f.changes.length ? ` — ${asrFix.examples.slice(0, 3).join("; ")}` : ""}`);
        if (!f.cached) await addCost(jobId, { step: "understand", provider: "gemini (asr fix)", model: f.model, units: { phrases: transcript.segments.length, requests: f.requests, changes: f.changes.length }, usd: f.usd });
      } catch (err) {
        warnings.push(`speech fix skipped: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err)}`);
      }
    }
    transcript = tidyTranscript(transcript);
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
    asr_fix: asrFix,
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
