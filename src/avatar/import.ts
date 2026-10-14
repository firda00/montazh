import fs from "node:fs/promises";
import path from "node:path";
import { addCost } from "../lib/cost.ts";
import { ffprobe } from "../lib/ffmpeg.ts";
import type { StructuredFn } from "../lib/llm.ts";
import { exists, jobDir, loadJob, readJson, runStep, writeJson } from "../lib/workspace.ts";
import { readZip } from "../lib/zip.ts";
import type { BackendChoice } from "../plan/backend/index.ts";
import type { Edl, Transcript } from "../schemas/index.ts";
import type { AsrChoice } from "../understand/asr.ts";
import type { VisionChoice } from "../understand/vision/index.ts";
import { AvatarMetaSchema, AvatarStateSchema, type AvatarMeta } from "./schema.ts";

/**
 * avatar_result.zip from Colab → the job's source video, then the normal montage on it
 * (ingest → understand → plan → cut → render, split_news by default: avatar in the bottom half,
 * generated visuals above, captions, music).
 *
 * Speech recognition still runs on the avatar's audio (one code path, word timings measured on the
 * real audio — the captions' word highlight needs them; TTS speech is clean, so whisper is accurate
 * on it). The known script only cross-checks the transcript (`script_match` in avatar.json).
 */

/** The default montage instruction: the whole monologue, in order, at about its own length. */
export function defaultAvatarPrompt(seconds: number): string {
  const target = Math.max(5, Math.round(seconds * 0.95));
  return `1 рилс 9:16 примерно ${target} секунд из всего монолога по порядку: сохрани все смысловые фразы, убери только паузы и оговорки; субтитры на языке речи; заголовок-хук в первые секунды.`;
}

export class AvatarImportError extends Error {
  constructor(
    message: string,
    public readonly code: "bundle" | "voice_only" | "video",
  ) {
    super(message);
    this.name = "AvatarImportError";
  }
}

export interface AvatarImportResult {
  jobId: string;
  video: string;
  meta: AvatarMeta;
  duration: number;
  width: number;
  height: number;
  warnings: string[];
}

/** Files of a result zip or folder; tolerates one top-level folder inside the zip. */
async function resultFiles(source: string): Promise<Map<string, Buffer>> {
  const st = await fs.stat(source).catch(() => null);
  if (!st) throw new AvatarImportError(`не найден ${source}`, "bundle");
  let files: Map<string, Buffer>;
  if (st.isDirectory()) {
    files = new Map();
    for (const n of await fs.readdir(source)) {
      const f = path.join(source, n);
      if ((await fs.stat(f)).isFile()) files.set(n, await fs.readFile(f));
    }
  } else {
    try {
      files = await readZip(source);
    } catch (err) {
      throw new AvatarImportError(`${path.basename(source)}: ${err instanceof Error ? err.message : err}`, "bundle");
    }
  }
  const metaKey = [...files.keys()].find((k) => k === "meta.json" || /^[^/]+\/meta\.json$/.test(k));
  if (!metaKey) throw new AvatarImportError(`в ${path.basename(source)} нет meta.json — это не avatar_result.zip из ноутбука Colab`, "bundle");
  const prefix = metaKey.slice(0, -"meta.json".length);
  return new Map([...files].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v]));
}

const tolerance = (d: number) => Math.max(0.5, d * 0.03);

/** Validates avatar_result.zip and places avatar.mp4 as the job's source. Nothing is run yet. */
export async function importAvatarResult(jobId: string, source: string): Promise<AvatarImportResult> {
  await loadJob(jobId);
  const dir = jobDir(jobId);
  const files = await resultFiles(path.resolve(source));
  let meta: AvatarMeta;
  try {
    meta = AvatarMetaSchema.parse(JSON.parse(files.get("meta.json")!.toString("utf8")));
  } catch (err) {
    throw new AvatarImportError(`meta.json не читается: ${err instanceof Error ? err.message.split("\n")[0] : err}`, "bundle");
  }
  const warnings: string[] = [];
  if (meta.job && meta.job !== jobId) warnings.push(`архив сделан для задачи ${meta.job}, импортирую в ${jobId}`);

  const out = path.join(dir, "avatar", "result");
  await fs.rm(out, { recursive: true, force: true });
  await fs.mkdir(out, { recursive: true });
  for (const [name, data] of files) if (!name.includes("/")) await fs.writeFile(path.join(out, name), data);

  if (!files.has("avatar.mp4")) {
    const msg = meta.mode === "voice_only" ? `это результат «только голос»: речь сохранена в ${path.join(out, "speech.wav")}; для монтажа нужен avatar.mp4 (режим avatar в ноутбуке)` : "в архиве нет avatar.mp4";
    throw new AvatarImportError(msg, meta.mode === "voice_only" ? "voice_only" : "bundle");
  }
  const video = path.join(dir, "avatar.mp4");
  await fs.copyFile(path.join(out, "avatar.mp4"), video);

  let probe;
  try {
    probe = await ffprobe(video);
  } catch (err) {
    throw new AvatarImportError(`avatar.mp4 не читается ffprobe: ${err instanceof Error ? err.message.split("\n")[0] : err}`, "video");
  }
  const v = probe.streams.find((s) => s.codec_type === "video");
  const a = probe.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new AvatarImportError("в avatar.mp4 нет видеодорожки", "video");
  if (!a) throw new AvatarImportError("в avatar.mp4 нет звука — аватар без речи не смонтировать", "video");
  const duration = Number(probe.format.duration ?? 0);
  if (!(duration > 0.5)) throw new AvatarImportError(`avatar.mp4 пустой (${duration.toFixed(2)} с)`, "video");
  if (Math.abs(duration - meta.duration) > tolerance(meta.duration)) {
    throw new AvatarImportError(`длина avatar.mp4 ${duration.toFixed(2)} с не совпадает с речью ${meta.duration.toFixed(2)} с из meta.json — архив повреждён или собран не до конца`, "video");
  }
  if (files.has("speech.wav")) {
    const sd = Number((await ffprobe(path.join(out, "speech.wav"))).format.duration ?? 0);
    if (Math.abs(sd - duration) > tolerance(sd)) throw new AvatarImportError(`speech.wav ${sd.toFixed(2)} с и avatar.mp4 ${duration.toFixed(2)} с разной длины`, "video");
  }
  const width = v.width ?? 0;
  const height = v.height ?? 0;
  if (Math.min(width, height) < 256) throw new AvatarImportError(`avatar.mp4 слишком маленький: ${width}×${height}`, "video");

  const wall = (meta.tts?.wall_seconds ?? 0) + (meta.animate?.wall_seconds ?? 0);
  await addCost(jobId, { step: "ingest", provider: "colab", model: `${meta.tts?.engine ?? "?"}+${meta.animate?.engine ?? "?"}`, units: { seconds: Math.round(duration * 10) / 10, wall_seconds: Math.round(wall), gpu: meta.animate?.device && meta.animate.device !== "cpu" ? 1 : 0 }, usd: 0 });
  const stateFile = path.join(dir, "avatar.json");
  if (await exists(stateFile)) {
    const st = await readJson(stateFile, AvatarStateSchema);
    await writeJson(stateFile, AvatarStateSchema, { ...st, imported_at: new Date().toISOString(), result: path.resolve(source), video, meta });
  }
  return { jobId, video, meta, duration, width, height, warnings };
}

/** Share of the script's words (≥ 4 letters) that whisper heard — a cheap check that the avatar says the script. */
export function scriptMatch(lines: string[], transcript: Transcript): { words: number; matched: number; ratio: number } {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/ё/g, "е")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4);
  const want = lines.flatMap(norm);
  const heard = new Set(transcript.segments.flatMap((s) => norm(s.text)));
  const matched = want.filter((w) => heard.has(w)).length;
  return { words: want.length, matched, ratio: want.length ? Math.round((matched / want.length) * 100) / 100 : 1 };
}

export interface AvatarMontageOptions {
  prompt?: string;
  /** design preset (default split_news) */
  design?: string;
  backend?: BackendChoice;
  vision?: VisionChoice;
  asr?: AsrChoice;
  /** music under the speech: auto | mood | file | none (default: the preset's, split_news = on) */
  music?: string;
  render?: boolean;
  /** split_news: generate panel images (default true) */
  panelImages?: boolean;
  quality?: "draft" | "looks" | "delivery";
  workers?: number;
  /** structured LLM for captions translation / panels (tests) */
  llm?: StructuredFn;
  onEvent?: (line: string) => void;
  progress?: (text: string) => Promise<void> | void;
  /** called between steps; throws to stop (bot /cancel) */
  checkpoint?: () => void;
}

export interface AvatarMontageResult {
  jobId: string;
  outputs: { id: string; file: string; duration?: number; aspect?: string }[];
  failed: { id: string; error: string }[];
  reasoning?: string;
  notes: string[];
  edl?: Edl;
}

/** ingest → understand → plan → cut → render on the imported avatar.mp4 of the job. */
export async function runAvatarMontage(jobId: string, o: AvatarMontageOptions = {}): Promise<AvatarMontageResult> {
  const { ingest } = await import("../ingest/index.ts");
  const { understand } = await import("../understand/index.ts");
  const { plan } = await import("../plan/index.ts");
  const { cut } = await import("../cut/index.ts");
  const dir = jobDir(jobId);
  const video = path.join(dir, "avatar.mp4");
  if (!(await exists(video))) throw new AvatarImportError(`в задаче ${jobId} нет avatar.mp4 — сначала vedit avatar import`, "video");
  const say = o.onEvent ?? (() => {});
  const progress = async (t: string) => {
    say(t);
    await o.progress?.(t);
  };
  const stateFile = path.join(dir, "avatar.json");
  const state = (await exists(stateFile)) ? await readJson(stateFile, AvatarStateSchema) : null;
  const design = o.design ?? "split_news";
  const notes: string[] = [];

  await progress("▸ подготовка видео аватара…");
  const media = await runStep(jobId, "ingest", () => ingest(jobId, video));
  o.checkpoint?.();

  await progress(`▸ анализ речи… (${media.duration.toFixed(0)} с)`);
  const language = state?.language ?? (state?.meta?.language || undefined);
  const u = await runStep(jobId, "understand", () => understand(jobId, media, { language, vision: o.vision, asr: o.asr, diarize: false, onLog: (l) => say(`    ${l}`) }));
  if (!u.transcript.segments.length) {
    throw new AvatarImportError(`речь в avatar.mp4 не распознана — монтировать не по чему${u.warnings.length ? ` (${u.warnings[0].split("\n")[0].slice(0, 200)})` : ""}; повторите: vedit avatar import ${jobId} <архив>`, "video");
  }
  if (state?.lines.length) {
    const m = scriptMatch(state.lines, u.transcript);
    say(`  сверка со сценарием: ${m.matched}/${m.words} слов (${Math.round(m.ratio * 100)}%)`);
    if (m.ratio < 0.6) notes.push(`распознано только ${Math.round(m.ratio * 100)}% слов сценария — проверьте речь аватара (синтез мог пропустить или исказить фразы)`);
  }
  o.checkpoint?.();

  const instruction = o.prompt?.trim() || defaultAvatarPrompt(media.duration);
  await progress("▸ план…");
  const p = await runStep(jobId, "plan", () => plan(jobId, { instruction, preset: design, backend: o.backend, onEvent: (l) => say(`  ${l.trim()}`) }));
  const edl = p.edl!;
  notes.push(...p.report.warnings.slice(0, 3));
  o.checkpoint?.();

  await progress("▸ нарезка…");
  const cutReport = await runStep(jobId, "cut", () => cut(jobId, edl, media, { transcript: u.transcript, snap: true, scenes: u.scenes }));
  const failed = cutReport.outputs.filter((x) => x.status !== "ok").map((x) => ({ id: x.id, error: x.error ?? "ошибка нарезки" }));
  const okIds = cutReport.outputs.filter((x) => x.status === "ok").map((x) => x.id);
  o.checkpoint?.();
  if (o.render === false || !okIds.length) return { jobId, outputs: [], failed, reasoning: edl.reasoning, notes, edl };

  const { HyperFramesRenderer } = await import("../render/hyperframes.ts");
  const { renderOutputs } = await import("../render/index.ts");
  const renderer = new HyperFramesRenderer({ workers: o.workers });
  await renderer.prepare();
  let i = 0;
  const r = await runStep(jobId, "render", () =>
    renderOutputs(jobId, {
      renderer,
      quality: o.quality ?? "looks",
      only: okIds,
      edl,
      preset: design,
      music: o.music,
      panelImages: o.panelImages,
      llm: o.llm,
      onEvent: (line) => {
        say(`  ${line}`);
        const m = /^▸ design (\S+)/.exec(line);
        if (m) void o.progress?.(`▸ рендер ${m[1]} (${++i}/${okIds.length})…`);
      },
    }),
  );
  const outputs: AvatarMontageResult["outputs"] = [];
  for (const x of r.outputs) {
    if (x.status === "ok" && x.output) outputs.push({ id: x.id, file: x.output, duration: x.duration, aspect: edl.outputs.find((e) => e.id === x.id)?.aspect });
    else failed.push({ id: x.id, error: x.error ?? x.status });
    for (const w of x.warnings.slice(0, 2)) notes.push(`${x.id}: ${w}`);
  }
  return { jobId, outputs, failed, reasoning: edl.reasoning, notes, edl };
}
