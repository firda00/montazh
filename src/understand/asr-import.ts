import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpeg, runProcess } from "../lib/ffmpeg.ts";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { SpeakersSchema, TranscriptSchema, type Speakers, type Transcript } from "../schemas/index.ts";
import { FasterJson, SpeakersJson, summarizeSpeakers, transcriptFromFaster } from "./asr.ts";

/**
 * Speech recognition on a remote GPU (Google Colab T4 and the like) without moving the pipeline there:
 *   1. `vedit asr-export <job>`  → <job>/asr_upload.ogg (Opus 48 kbit/s mono, ~20 MB per hour) to upload
 *   2. run tools/asr/colab_vedit_asr.ipynb there: same sidecar, `pipeline` command → asr_bundle.zip
 *   3. `vedit asr-import <job> asr_bundle.zip` → transcript.json + speakers.json in the job
 *   4. `vedit understand <job> --asr import` → scenes, vision, highlights on top of the imported speech
 */

export const AsrImportMarkerSchema = z.object({
  engine: z.string(),
  model: z.string(),
  device: z.string(),
  compute_type: z.string(),
  language: z.string(),
  wall_seconds: z.number(),
  speakers_wall_seconds: z.number().optional(),
  source: z.string(),
  imported_at: z.string(),
});
export type AsrImportMarker = z.infer<typeof AsrImportMarkerSchema>;

const PhrasesJson = z.array(z.object({ start: z.number(), end: z.number() }));

/** Opus mono 48 kbit/s of the job's 16 kHz WAV: small enough to upload through a browser. */
export async function exportAsrAudio(jobId: string): Promise<{ file: string; bytes: number }> {
  const dir = jobDir(jobId);
  const wav = path.join(dir, "audio.wav");
  if (!(await exists(wav))) throw new Error(`в задаче ${jobId} нет audio.wav — сначала vedit ingest`);
  const file = path.join(dir, "asr_upload.ogg");
  await ffmpeg(["-i", wav, "-ac", "1", "-c:a", "libopus", "-b:a", "48k", "-application", "voip", file]);
  return { file, bytes: (await fs.stat(file)).size };
}

/** A zip (via the system tar, which reads zip on Windows 10+ and macOS/Linux) or a directory → the directory holding the files. */
async function unpack(source: string, into: string): Promise<string> {
  const st = await fs.stat(source);
  if (st.isDirectory()) return source;
  await fs.mkdir(into, { recursive: true });
  await runProcess("tar", ["-xf", source, "-C", into]);
  // the bundle may carry one top-level folder
  const entries = await fs.readdir(into);
  if (entries.length === 1 && (await fs.stat(path.join(into, entries[0]))).isDirectory() && !(await exists(path.join(into, "faster.json")))) return path.join(into, entries[0]);
  return into;
}

export interface ImportResult {
  transcript: Transcript;
  speakers: Speakers | null;
  marker: AsrImportMarker;
  warnings: string[];
}

/**
 * Reads faster.json (+ phrases.json / speakers_raw.json when present) and writes transcript.json,
 * speakers.json and asr_import.json into the job. Speaker labels were computed on the raw whisper
 * segments; each sentence-split phrase takes the label of the raw segment that holds its midpoint.
 */
export async function importAsrBundle(jobId: string, source: string): Promise<ImportResult> {
  const dir = jobDir(jobId);
  const workDir = path.join(dir, "whisper");
  await fs.mkdir(workDir, { recursive: true });
  const from = await unpack(path.resolve(source), path.join(workDir, "import"));
  const fasterFile = path.join(from, "faster.json");
  if (!(await exists(fasterFile))) throw new Error(`в ${source} нет faster.json (вывод команды pipeline/transcribe сайдкара)`);
  const raw = FasterJson.parse(JSON.parse(await fs.readFile(fasterFile, "utf8")));
  const { transcript: t, dropped } = transcriptFromFaster(raw);
  const warnings = dropped.map((d) => `dropped likely hallucination "${d}"`);
  let transcript: Transcript = t;
  await fs.copyFile(fasterFile, path.join(workDir, "faster.json"));

  let speakers: Speakers | null = null;
  let speakersWall: number | undefined;
  const phrasesFile = path.join(from, "phrases.json");
  const speakersFile = path.join(from, "speakers_raw.json");
  if ((await exists(phrasesFile)) && (await exists(speakersFile))) {
    const phrases = PhrasesJson.parse(JSON.parse(await fs.readFile(phrasesFile, "utf8")));
    const rawSp = SpeakersJson.parse(JSON.parse(await fs.readFile(speakersFile, "utf8")));
    const label = new Map(rawSp.phrases.map((p) => [p.i, p.speaker]));
    const labelled = transcript.segments.map((s) => {
      const mid = (s.start + s.end) / 2;
      let i = phrases.findIndex((p) => mid >= p.start && mid <= p.end);
      if (i < 0) {
        // between raw segments (padding differences): the nearest one by start
        let best = Infinity;
        phrases.forEach((p, k) => {
          const d = Math.min(Math.abs(p.start - s.start), Math.abs(p.end - s.end));
          if (d < best) {
            best = d;
            i = k;
          }
        });
      }
      const sp = i >= 0 ? label.get(i) : undefined;
      return sp ? { ...s, speaker: sp } : s;
    });
    transcript = { ...transcript, segments: labelled };
    speakers = summarizeSpeakers(labelled, rawSp);
    speakersWall = rawSp.wall_seconds;
    await fs.copyFile(speakersFile, path.join(workDir, "speakers_raw.json"));
    await writeJson(path.join(dir, "speakers.json"), SpeakersSchema, speakers);
  } else {
    warnings.push("в бандле нет phrases.json/speakers_raw.json — говорящие не размечены");
  }
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, transcript);
  const marker: AsrImportMarker = {
    engine: "faster-whisper (import)",
    model: raw.model,
    device: raw.device,
    compute_type: raw.compute_type,
    language: raw.language,
    wall_seconds: raw.wall_seconds,
    ...(speakersWall !== undefined ? { speakers_wall_seconds: speakersWall } : {}),
    source: path.resolve(source),
    imported_at: new Date().toISOString(),
  };
  await writeJson(path.join(dir, "asr_import.json"), AsrImportMarkerSchema, marker);
  return { transcript, speakers, marker, warnings };
}

/** The imported speech of a job, for `understand --asr import`. */
export async function loadImportedAsr(jobId: string): Promise<{ transcript: Transcript; speakers: Speakers | null; marker: AsrImportMarker }> {
  const dir = jobDir(jobId);
  const markerFile = path.join(dir, "asr_import.json");
  if (!(await exists(markerFile))) throw new Error(`--asr import: в задаче ${jobId} нет asr_import.json — сначала vedit asr-import <job> <bundle>`);
  const marker = await readJson(markerFile, AsrImportMarkerSchema);
  const transcript = await readJson(path.join(dir, "transcript.json"), TranscriptSchema);
  const spFile = path.join(dir, "speakers.json");
  const speakers = (await exists(spFile)) ? await readJson(spFile, SpeakersSchema) : null;
  return { transcript, speakers, marker };
}
