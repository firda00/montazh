// Stage 30: «Русская версия» — translation + voice-over (dubbing) of a video, a podcast or the reels of a job.
//
//   speech (the job's transcript, or whisper on the file) → phrases with their times
//   → translation phrase by phrase with a character budget each (translate.ts, Claude or Gemini, cached)
//   → TTS in batches of N phrases per request (Gemini: one take cut back into phrases — 1 request per ~12 phrases
//     instead of 12; Piper as the fallback), each phrase fitted into its time (fit.ts: re-sync at every phrase start,
//     overlap into the following silence, speed-up ≤ 1.25×, one shorter re-translation for what still does not fit)
//   → the dub track on the video timeline (track.ts) → mix: the original ducked −18 dB under the dub (voice-over)
//     or kept low throughout (replace), video copied, captions in the target language as a soft subtitle track + .srt.
// Out of scope by design: cloning the original speaker's voice (no voice cloning of third parties).
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createJob, exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { addCost } from "../lib/cost.ts";
import type { StructuredFn } from "../lib/llm.ts";
import type { Transcript } from "../schemas/index.ts";
import { duckFilter } from "../audio/mix.ts";
import { charBudget, DUB_MAX_SPEED, dubRanges, dubSrt, fitStats, phraseLimits, placeOne, type DubPhrase, type FitStats, type Placement } from "./fit.ts";
import { atempoStretch, resample, saveClip, writeDubTrack, type Pcm, type StretchFn } from "./track.ts";
import { shortenForDub, translateForDub } from "./translate.ts";

export * from "./fit.ts";

export type DubMode = "voiceover" | "replace";
export const DUB_LANGS = ["ru", "uz", "en"] as const;
export const isDubLang = (s: unknown): s is (typeof DUB_LANGS)[number] => typeof s === "string" && (DUB_LANGS as readonly string[]).includes(s);
/** the label every dubbed output carries (description, metadata, report) */
export const UNOFFICIAL_LABEL: Record<string, string> = { ru: "Неофициальный перевод", uz: "Norasmiy tarjima", en: "Unofficial translation" };
export const unofficialLabel = (lang: string) => UNOFFICIAL_LABEL[lang] ?? UNOFFICIAL_LABEL.en;
/** the dub track's sample rate (Gemini speaks 24 kHz; Piper clips are resampled) */
export const DUB_RATE = 24000;
/** how far the original sits under the dub (voice-over), dB */
export const DUB_DUCK_DB = -18;
/** replace mode: the original stays this low everywhere (ambience), and drops further under the dub */
export const REPLACE_BED_DB = -20;
export const REPLACE_UNDER_DUB_DB = -12;
const ISO3: Record<string, string> = { ru: "rus", uz: "uzb", en: "eng", kk: "kaz", tr: "tur" };

/** the delivery of a Gemini voice-over: clear, neutral, brisk (not the reels narrator of `make`) */
export function dubStyle(lang: string): string {
  const base = "a professional voice-over translator reading a translation over the original speech: clear, neutral and natural, brisk even pace, no theatrics, consistent level";
  return lang === "ru" ? `${base}, in Russian` : base;
}

export interface TtsBatch {
  /** one clip per line (empty lines → empty clips) */
  clips: Pcm[];
  engine: string;
  model?: string;
  requests: number;
  cached: number;
  warnings: string[];
  /** characters sent (Chirp is billed per character) */
  chars: number;
}
export type TtsBatchFn = (lines: string[], o: { voice: string; language: string; dir: string; onEvent?: (l: string) => void }) => Promise<TtsBatch>;

/** The real TTS: synthesize() with the whole batch in one take (Gemini / Cloud), or Piper sentence by sentence. */
export const synthTtsBatch: TtsBatchFn = async (lines, o) => {
  const { synthesize } = await import("../voice/piper.ts");
  const wav = path.join(o.dir, `tts_${randomBytes(4).toString("hex")}.wav`);
  let requests = 0;
  let cached = 0;
  const onEvent = (l: string) => {
    const m = /(\d+) запрос/.exec(l);
    if (m) requests += Number(m[1]);
    const c = /\((\d+) из кэша\)/.exec(l);
    if (c) cached += Number(c[1]);
    o.onEvent?.(l);
  };
  if (!lines.some((l) => /[\p{L}\p{N}]/u.test(l))) return { clips: lines.map(() => ({ pcm: new Int16Array(0), rate: DUB_RATE })), engine: "none", requests: 0, cached: 0, warnings: [], chars: 0 };
  try {
    const r = await synthesize(lines, o.voice, wav, { take: "single", language: o.language, gemini: { style: dubStyle(o.language) }, linePauseMs: 0, onEvent });
    return { clips: r.clips, engine: r.engine, model: r.model, requests: r.engine === "piper" ? 0 : Math.max(1, requests), cached, warnings: r.warnings, chars: lines.join("").length };
  } finally {
    await fs.rm(wav, { force: true }).catch(() => {});
  }
};

/** speech → transcript (whisper.cpp or faster-whisper, as `understand` picks); tests inject a stub */
export type AsrFn = (video: string, dir: string, duration: number, o: { onEvent?: (l: string) => void; language?: string }) => Promise<Transcript>;

export const defaultAsr: AsrFn = async (video, dir, duration, o) => {
  const wav = path.join(dir, "audio.wav");
  if (!(await exists(wav))) await ffmpeg(["-i", video, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
  const { selectAsr } = await import("../understand/index.ts");
  const { transcribe } = await import("../understand/whisper.ts");
  const { transcribeFaster } = await import("../understand/asr.ts");
  const { detectLanguage, tidyTranscript } = await import("../understand/asrfix.ts");
  const asr = await selectAsr("auto", process.env, {}, duration);
  o.onEvent?.(`  речь: ${asr.engine} (${asr.reason})`);
  const r = asr.engine === "faster-whisper" ? await transcribeFaster(wav, duration, dir, { python: asr.python!, language: o.language, onLog: (l) => o.onEvent?.(`    ${l}`) }) : await transcribe(wav, duration, dir, { language: o.language });
  let t: Transcript = r.transcript;
  t = { ...t, segments: t.segments.map((s) => ({ ...s, lang: detectLanguage(s.text, s.lang ?? t.language) })) };
  return tidyTranscript(t);
};

/** mux: (video, dub track, srt, out) → the dubbed video; tests inject a stub (no ffmpeg) */
export type MuxFn = (a: MixArgs) => Promise<void>;

export interface MixArgs {
  video: string;
  track: string;
  srt?: string;
  out: string;
  mode: DubMode;
  ranges: { start: number; end: number }[];
  lang: string;
  duration: number;
  /** the filter graph goes to this file (a 2-hour podcast has hundreds of duck ranges: too long for a command line) */
  filterFile: string;
  hasAudio: boolean;
  /** ffmpeg ≥ 7 reads a filter script with `-/filter_complex <file>`, older ones with `-filter_complex_script` */
  ffmpegMajor?: number;
}

/** The ffmpeg command of the mix (pure: the caller writes `filter` to `filterFile`). */
export function buildDubMix(a: MixArgs): { args: string[]; filter: string } {
  const chains: string[] = [];
  const dub = `[1:a]aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=-16:TP=-2:LRA=9[dub]`;
  chains.push(dub);
  if (a.hasAudio) {
    const duck = a.mode === "replace" ? `,volume=${REPLACE_BED_DB}dB${duckFilter(a.ranges, REPLACE_UNDER_DUB_DB, 0.25)}` : duckFilter(a.ranges, DUB_DUCK_DB, 0.25);
    chains.push(`[0:a:0]aresample=48000,aformat=channel_layouts=stereo${duck}[orig]`);
    chains.push(`[orig][dub]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[aout]`);
  } else chains.push(`[dub]alimiter=limit=0.95[aout]`);
  const filter = chains.join(";\n");
  const iso = ISO3[a.lang] ?? a.lang;
  const label = unofficialLabel(a.lang);
  const script = (a.ffmpegMajor ?? 7) >= 7 ? ["-/filter_complex", a.filterFile] : ["-filter_complex_script", a.filterFile];
  const args = [
    "-i", a.video,
    "-i", a.track,
    ...(a.srt ? ["-i", a.srt] : []),
    ...script,
    "-map", "0:v:0", "-map", "[aout]",
    ...(a.srt ? ["-map", "2:s:0", "-c:s", "mov_text", "-metadata:s:s:0", `language=${iso}`, "-metadata:s:s:0", `title=${label}`] : []),
    "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000",
    "-metadata:s:a:0", `language=${iso}`,
    "-metadata", `comment=${label} (vedit)`,
    "-t", a.duration.toFixed(3),
    "-movflags", "+faststart",
    a.out,
  ];
  return { args, filter };
}

let ffmpegMajor: Promise<number> | undefined;
async function detectFfmpegMajor(): Promise<number> {
  ffmpegMajor ??= (async () => {
    try {
      const { runProcess } = await import("../lib/ffmpeg.ts");
      const r = await runProcess(process.env.FFMPEG_PATH || "ffmpeg", ["-hide_banner", "-version"]);
      const m = /ffmpeg version n?(\d+)/i.exec(r.stdout);
      return m ? Number(m[1]) : 7;
    } catch {
      return 7;
    }
  })();
  return ffmpegMajor;
}

export const ffmpegMux: MuxFn = async (a) => {
  const { args, filter } = buildDubMix({ ...a, ffmpegMajor: await detectFfmpegMajor() });
  await fs.writeFile(a.filterFile, filter);
  await ffmpeg(args);
};

export const DubReportSchema = z.object({
  version: z.literal(1),
  lang: z.string(),
  label: z.string(),
  video: z.string(),
  out: z.string(),
  srt: z.string().nullable(),
  mode: z.enum(["voiceover", "replace"]),
  voice: z.string(),
  engine: z.string(),
  models: z.array(z.string()),
  duration: z.number(),
  phrases: z.number().int(),
  translated: z.number().int(),
  speech_seconds: z.number(),
  fit: z.object({ phrases: z.number(), sped_up: z.number(), trimmed: z.number(), trimmed_seconds: z.number(), overlapping: z.number(), max_speed: z.number(), mean_speed: z.number() }),
  shortened: z.number().int(),
  tts: z.object({ requests: z.number().int(), cached: z.number().int(), batches: z.number().int(), chars: z.number().int() }),
  cost: z.object({ translate_usd: z.number(), tts_usd: z.number(), total_usd: z.number(), per_minute_usd: z.number(), note: z.string() }),
  warnings: z.array(z.string()),
  created_at: z.string(),
});
export type DubReport = z.infer<typeof DubReportSchema>;

export interface DubOptions {
  /** target language (ru | uz | en…) */
  lang: string;
  /** catalogue voice id or "auto" (Gemini Charon with a Google key, else the language's Piper voice) */
  voice?: string;
  mode?: DubMode;
  maxSpeed?: number;
  /** phrases per TTS request (default VEDIT_DUB_BATCH or 12) */
  batch?: number;
  /** one shorter re-translation for phrases that still do not fit (default on; at most VEDIT_DUB_SHORTEN_MAX = 12) */
  shorten?: boolean;
  /** soft subtitles in the target language + .srt (default on) */
  captions?: boolean;
  llm?: StructuredFn;
  tts?: TtsBatchFn;
  stretch?: StretchFn;
  asr?: AsrFn;
  mux?: MuxFn;
  /** duration of the video (default ffprobe) — tests */
  probe?: (file: string) => Promise<{ duration: number; hasAudio: boolean }>;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
}

export interface DubResult {
  jobId: string;
  out: string;
  srt: string | null;
  report: DubReport;
}

const checkAbort = (s?: AbortSignal) => {
  if (s?.aborted) throw Object.assign(new Error("отменено"), { name: "CancelledError" });
};

async function probeVideo(file: string): Promise<{ duration: number; hasAudio: boolean }> {
  const p = await ffprobe(file);
  const d = Number(p.format.duration ?? NaN);
  if (!(d > 0)) throw new Error(`не удалось прочитать длительность ${path.basename(file)}`);
  return { duration: d, hasAudio: p.streams.some((s) => s.codec_type === "audio") };
}

/** Transcript segments → dub phrases (sorted, empty ones dropped). */
export function phrasesFromTranscript(t: Transcript): DubPhrase[] {
  return t.segments
    .map((s, i) => ({ i, start: s.start, end: Math.max(s.end, s.start + 0.2), text: s.text.trim(), lang: s.lang ?? t.language }))
    .filter((p) => p.text && /[\p{L}\p{N}]/u.test(p.text))
    .sort((a, b) => a.start - b.start);
}

/** The voice that will actually speak `lang`: a Gemini/Chirp voice with a Google key, else the language's Piper voice. */
export async function resolveDubVoice(id: string | undefined, lang: string): Promise<{ voice: string; warning?: string }> {
  const { resolveMakeVoice } = await import("../voice/voiceover.ts");
  const { DEFAULT_PIPER_VOICE, isCloud, getVoice } = await import("../voice/catalog.ts");
  const { geminiApiKey } = await import("../voice/gemini.ts");
  const { cloudApiKey } = await import("../voice/cloudtts.ts");
  const key = !!(geminiApiKey() || cloudApiKey());
  const want = id && id !== "off" ? id : "auto";
  const v = getVoice(want);
  // a Gemini voice without a key: the Piper voice of the TARGET language (the voice's own fallback may speak another one)
  if (v && isCloud(v) && !key) {
    const p = DEFAULT_PIPER_VOICE[lang];
    if (p) return { voice: p, warning: `нет ключа Google — озвучка голосом Piper ${p} вместо ${v.id}` };
  }
  const r = resolveMakeVoice(want, lang, key);
  return { voice: r.voice.id, warning: r.warning };
}

/** Paid-tier TTS price of `speechSeconds` of speech (free tiers make it $0 in practice). */
async function ttsPrice(engine: string, model: string | undefined, speechSeconds: number, chars: number): Promise<number> {
  if (engine === "piper" || engine === "none") return 0;
  const { ttsUsd } = await import("../voice/voiceover.ts");
  return ttsUsd(engine, model, speechSeconds, chars);
}

/**
 * Dubs one video. `phrases` (output-time phrases of a reel) skip speech recognition; without them the job's
 * transcript is used when `tag` is "full" and it exists, else whisper runs on the file.
 */
export async function dubVideo(video: string, o: DubOptions & { jobId?: string; out?: string; phrases?: DubPhrase[]; tag?: string }): Promise<DubResult> {
  const say = o.onEvent ?? (() => {});
  const lang = o.lang;
  const tag = o.tag ?? "full";
  const jobId = o.jobId ?? (await createJob(video, { prompt: `dub ${lang}`, preset: "dub" })).id;
  if (!o.jobId) say(`job ${jobId}`);
  const dir = jobDir(jobId);
  const work = path.join(dir, `dub_${tag}_${lang}`);
  await fs.mkdir(work, { recursive: true });
  const warnings: string[] = [];
  const { duration, hasAudio } = await (o.probe ?? probeVideo)(video);
  checkAbort(o.signal);

  // 1. phrases
  let phrases = o.phrases;
  if (!phrases) {
    const tfile = path.join(dir, "transcript.json");
    let t: Transcript | undefined;
    if (tag === "full" && (await exists(tfile))) {
      const { TranscriptSchema } = await import("../schemas/index.ts");
      t = await readJson(tfile, TranscriptSchema);
    }
    if (!t) {
      say(`▸ анализ речи… (${Math.round(duration / 60)} мин видео)`);
      t = await (o.asr ?? defaultAsr)(video, dir, duration, { onEvent: say });
      const { TranscriptSchema } = await import("../schemas/index.ts");
      // the job's own transcript only for the full video (a reel's speech is not the job's)
      if (tag === "full" && !(await exists(tfile))) await writeJson(tfile, TranscriptSchema, t);
    }
    phrases = phrasesFromTranscript(t);
  }
  phrases = [...phrases].sort((a, b) => a.start - b.start);
  if (!phrases.length) throw new Error("в видео не нашлось речи — нечего озвучивать");
  checkAbort(o.signal);

  // 2. translation with a budget per phrase
  const limits = phraseLimits(phrases, duration);
  const items = phrases.map((p, k) => ({ i: p.i, text: p.text, lang: p.lang ?? "auto", max_chars: charBudget(p, limits[k], lang) }));
  const llm = o.llm ?? (await import("../lib/llm.ts")).selectStructuredLlm(process.env, "translate");
  const tr = await translateForDub(dir, items, lang, llm, { jobId, onEvent: say, signal: o.signal });
  const texts = tr.texts;
  let translateUsd = tr.usd;
  checkAbort(o.signal);

  // 3. TTS in batches, each phrase fitted and stored as it comes
  const resolved = await resolveDubVoice(o.voice, lang);
  if (resolved.warning) warnings.push(resolved.warning);
  const voice = resolved.voice;
  const tts = o.tts ?? synthTtsBatch;
  const stretch = o.stretch ?? atempoStretch;
  const batch = Math.max(1, o.batch ?? (Number(process.env.VEDIT_DUB_BATCH) || 12));
  const clipsDir = path.join(work, `clips_${voice}`);
  const placements = new Map<number, Placement>();
  const models = new Set<string>();
  let engine = "none";
  let requests = 0;
  let cachedReq = 0;
  let chars = 0;
  let batches = 0;
  const byI = new Map(phrases.map((p, k) => [p.i, { p, limit: limits[k] }]));
  const fitOpts = { maxSpeed: o.maxSpeed ?? DUB_MAX_SPEED };

  /** synthesises `ids` in batches, fits and stores each phrase */
  const speak = async (ids: number[], label: (b: number, n: number) => string) => {
    const nb = Math.ceil(ids.length / batch);
    for (let b = 0; b < nb; b++) {
      checkAbort(o.signal);
      const part = ids.slice(b * batch, (b + 1) * batch);
      say(label(b + 1, nb));
      const r = await tts(part.map((i) => texts.get(i) ?? ""), { voice, language: lang, dir: work, onEvent: (l) => say(`  ${l.trim()}`) });
      batches++;
      requests += r.requests;
      cachedReq += r.cached;
      chars += r.chars;
      if (r.engine !== "none") engine = r.engine;
      if (r.model) for (const m of r.model.split(/,\s*/)) models.add(m);
      for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
      for (const [k, i] of part.entries()) {
        const { p, limit } = byI.get(i)!;
        const raw = r.clips[k] ? resample(r.clips[k], DUB_RATE) : { pcm: new Int16Array(0), rate: DUB_RATE };
        const pl = placeOne(p, raw.pcm.length / DUB_RATE, limit, fitOpts);
        const clip = pl.speed > 1 ? resample(await stretch(raw, pl.speed), DUB_RATE) : raw;
        await saveClip(clipsDir, i, clip);
        // the stretched clip's real length (atempo rounds) decides the trim
        placements.set(i, { ...pl, out: Math.min(pl.out, clip.pcm.length / DUB_RATE) });
      }
    }
  };
  // a re-run (another mode, a crash) reuses the clips already made for this voice
  const missing: number[] = [];
  const meta = path.join(clipsDir, "placements.json");
  const PlacementsSchema = z.record(z.string(), z.object({ i: z.number(), start: z.number(), speed: z.number(), clip: z.number(), out: z.number(), trimmed: z.number(), overlap: z.number(), limit: z.number(), text: z.string() }));
  const saved = (await exists(meta)) ? await readJson(meta, PlacementsSchema).catch(() => ({}) as z.infer<typeof PlacementsSchema>) : {};
  for (const p of phrases) {
    const s = saved[String(p.i)];
    if (s && s.text === (texts.get(p.i) ?? "") && (await exists(path.join(clipsDir, `${p.i}.s16`)))) placements.set(p.i, { i: s.i, start: s.start, speed: s.speed, clip: s.clip, out: s.out, trimmed: s.trimmed, overlap: s.overlap, limit: s.limit });
    else missing.push(p.i);
  }
  if (missing.length < phrases.length) say(`  озвучка: ${phrases.length - missing.length} фраз уже готовы (повторный запуск)`);
  await speak(missing, (b, n) => `▸ озвучка ${b}/${n}…`);

  // 4. one shorter re-translation for what still does not fit
  let shortened = 0;
  if (o.shorten !== false) {
    const max = Number(process.env.VEDIT_DUB_SHORTEN_MAX) || 12;
    const worst = [...placements.values()].filter((x) => x.trimmed > 0.25).sort((a, b) => b.trimmed - a.trimmed).slice(0, max);
    if (worst.length) {
      say(`▸ перевод: сокращаю ${worst.length} фраз(ы), которые не помещаются…`);
      try {
        const sh = await shortenForDub(
          dir,
          worst.map((x) => {
            const { p, limit } = byI.get(x.i)!;
            return { i: x.i, text: texts.get(x.i) ?? "", max_chars: Math.max(8, Math.round(charBudget(p, limit, lang) * 0.8)), key: `${p.lang ?? "auto"}|${p.text}` };
          }),
          lang,
          llm,
          { jobId },
        );
        translateUsd += sh.usd;
        for (const [i, t] of sh.texts) texts.set(i, t);
        shortened = sh.texts.size;
        if (sh.texts.size) await speak([...sh.texts.keys()], () => "▸ озвучка: переозвучиваю сокращённые фразы…");
      } catch (err) {
        warnings.push(`сокращение не получилось: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
  }
  await writeJson(meta, PlacementsSchema, Object.fromEntries([...placements.values()].map((x) => [String(x.i), { ...x, text: texts.get(x.i) ?? "" }])));
  checkAbort(o.signal);

  // 5. dub track, captions, mix
  const all = phrases.map((p) => placements.get(p.i)!).filter(Boolean);
  const fit: FitStats = fitStats(all);
  say("▸ сведение: оригинал тише, перевод сверху…");
  const track = path.join(work, "dub.wav");
  const { speechSeconds } = await writeDubTrack(track, all, clipsDir, DUB_RATE, duration);
  let srt: string | null = null;
  if (o.captions !== false) {
    srt = path.join(work, `dub_${lang}.srt`);
    await fs.writeFile(srt, dubSrt(all, texts));
  }
  const out = o.out ?? path.join(dir, tag === "full" ? `dub_${lang}.mp4` : `output_${tag}_${lang}.mp4`);
  await (o.mux ?? ffmpegMux)({ video, track, srt: srt ?? undefined, out, mode: o.mode ?? "voiceover", ranges: dubRanges(all), lang, duration, filterFile: path.join(work, "mix.filter"), hasAudio });

  // 6. report and cost
  const ttsUsd = await ttsPrice(engine, [...models][0], speechSeconds, chars);
  if (ttsUsd > 0 || engine !== "none") await addCost(jobId, { step: "design", provider: `${engine === "gemini" ? "gemini tts" : engine === "cloud" ? "cloud tts" : engine} (dub)`, model: [...models].join(", ") || voice, units: { speech_seconds: speechSeconds, requests, cached: cachedReq, phrases: phrases.length }, usd: ttsUsd });
  const total = Math.round((translateUsd + ttsUsd) * 1e4) / 1e4;
  const report = await writeJson(path.join(dir, `dub_${tag}_${lang}.json`), DubReportSchema, {
    version: 1,
    lang,
    label: unofficialLabel(lang),
    video: path.resolve(video),
    out,
    srt,
    mode: o.mode ?? "voiceover",
    voice,
    engine,
    models: [...models],
    duration: Math.round(duration * 1000) / 1000,
    phrases: phrases.length,
    translated: [...texts.values()].filter(Boolean).length,
    speech_seconds: speechSeconds,
    fit,
    shortened,
    tts: { requests, cached: cachedReq, batches, chars },
    cost: {
      translate_usd: Math.round(translateUsd * 1e4) / 1e4,
      tts_usd: ttsUsd,
      total_usd: total,
      per_minute_usd: Math.round((total / Math.max(1 / 60, duration / 60)) * 1e4) / 1e4,
      note: engine === "gemini" ? "Gemini TTS: цена платного уровня; на бесплатном — $0 (дневная квота запросов)" : engine === "piper" ? "Piper локально — $0" : "",
    },
    warnings,
    created_at: new Date().toISOString(),
  });
  say(`  озвучка ${lang}: ${phrases.length} фраз, ускорено ${fit.sped_up}, обрезано ${fit.trimmed}, ${engine}${models.size ? ` ${[...models].join(", ")}` : ""}, запросов TTS ${requests}; ≈$${total.toFixed(4)} (≈$${report.cost.per_minute_usd.toFixed(4)}/мин)`);
  return { jobId, out, srt, report };
}

/** Rendered reels of a job → their phrases on the OUTPUT timeline (the same mapping the captions use). */
export async function outputPhrases(jobId: string, outputId: string): Promise<DubPhrase[]> {
  const dir = jobDir(jobId);
  const { EdlSchema, MediaSchema, TranscriptSchema } = await import("../schemas/index.ts");
  const { buildDesignTimeline } = await import("../design/timeline.ts");
  const { CutReportSchema } = await import("../cut/index.ts");
  const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
  const output = edl.outputs.find((x) => x.id === outputId);
  if (!output) throw new Error(`в плане нет выхода ${outputId}`);
  const transcript = await readJson(path.join(dir, "transcript.json"), TranscriptSchema);
  const media = await readJson(path.join(dir, "media.json"), MediaSchema);
  const cutFile = path.join(dir, "cut.json");
  const rec = (await exists(cutFile)) ? (await readJson(cutFile, CutReportSchema)).outputs.find((x) => x.id === outputId) : undefined;
  const tl = buildDesignTimeline(output, transcript, media, rec?.status === "ok" ? rec.clips : undefined);
  return tl.phrases.map((p, k) => ({ i: k, start: p.start, end: p.end, text: p.text, lang: p.lang }));
}

/**
 * Dubs the rendered outputs of a job (output_<id>.mp4) → output_<id>_<lang>.mp4 each. Phrases come from the plan
 * (no second speech recognition); a reel without a plan (avatar, make) is transcribed.
 */
export async function dubJobOutputs(jobId: string, o: DubOptions & { outputs?: { id: string; file: string }[] }): Promise<DubResult[]> {
  const dir = jobDir(jobId);
  let outs = o.outputs;
  if (!outs) {
    const names = (await fs.readdir(dir)).filter((f) => /^output_.+\.mp4$/.test(f) && !/_(ru|uz|en)\.mp4$/.test(f));
    outs = names.map((f) => ({ id: f.slice("output_".length, -".mp4".length), file: path.join(dir, f) }));
  }
  if (!outs.length) throw new Error(`в задаче ${jobId} нет готовых роликов`);
  const results: DubResult[] = [];
  for (const [k, out] of outs.entries()) {
    checkAbort(o.signal);
    o.onEvent?.(`▸ озвучка ролика ${out.id} (${k + 1}/${outs.length})…`);
    let phrases: DubPhrase[] | undefined;
    try {
      phrases = await outputPhrases(jobId, out.id);
    } catch {
      phrases = undefined;
    }
    results.push(await dubVideo(out.file, { ...o, jobId, phrases: phrases?.length ? phrases : undefined, tag: out.id, out: path.join(dir, `output_${out.id}_${o.lang}.mp4`) }));
  }
  return results;
}

/** One line for a delivered message: what the dub cost and how it fitted. */
export function dubSummary(r: DubReport): string {
  const f = r.fit;
  return `${r.label} · ${r.lang} · ${r.phrases} фраз · ускорено ${f.sped_up}${f.trimmed ? `, обрезано ${f.trimmed}` : ""} · ≈$${r.cost.total_usd.toFixed(3)} ($${r.cost.per_minute_usd.toFixed(4)}/мин)`;
}


