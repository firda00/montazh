import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ffmpeg, ffprobe, runProcess } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import type { Transcript } from "../schemas/index.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { loudnessTimeline } from "../understand/loudness.ts";
import { priceUsage, type GeminiUsage } from "../understand/vision/gemini.ts";
import { canonicalUrl, contentKey, StyleCache, tgAlias } from "./cache.ts";
import { DEFAULT_DNA, parseDNA, STYLE_DNA_RESPONSE_SCHEMA, type StyleDNA } from "./dna.ts";
import { audioStats, bandDiffs, cutStats, detectJumpCuts, grayFrames, mergeCuts, pictureStats, sceneCuts, speechStats } from "./metrics.ts";
import { StyleProfileSchema, type Measured, type StyleProfile } from "./profile.ts";

/**
 * Reference reel → Style DNA (stage 22).
 *   1. cache: Telegram file_unique_id / canonical link alias → content key (sha256 of size + first/last 512 KB) → hit = $0
 *   2. link: yt-dlp download (optional binary, VEDIT_YTDLP); Instagram often needs a login → RefLinkError
 *   3. local measurements (src/style/metrics.ts): cuts, shot lengths, speech rate, pauses, loudness, picture stats
 *   4. Gemini: the reel (≤ 90 s, ≤ 960 px, with sound) through the Files API, prompts/style.dna.*, responseSchema =
 *      StyleDNA, temperature 0.1; the uploaded file is deleted in `finally`
 *   5. merge: what we measured (cut durations, wpm, pauses) overrides the model; the model decides the visuals
 * The reference itself is never used in an output: downloaded/temporary files are deleted after the analysis,
 * only the DNA is kept.
 */

/** newest flash first; unavailable ones are skipped (VEDIT_STYLE_MODEL: a comma list) */
export const DEFAULT_STYLE_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.7-flash", "gemini-3.5-flash", "gemini-flash-latest", "gemini-3-flash-preview", "gemini-2.5-flash"];
/** frames per second Gemini samples from the reel (captions animate per word: 4 fps sees the pop) */
export const STYLE_FPS = 4;
/** seconds of the reference that are analysed */
export const STYLE_MAX_SECONDS = 90;

/** $ per 1M tokens (input incl. video, output incl. thinking), paid tier — same table as src/make/trends-gemini.ts; the free tier costs $0 */
const STYLE_PRICES: Record<string, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
};

export function stylePrice(model: string, u: GeminiUsage): { usd: number; priced: boolean } {
  const p = STYLE_PRICES[model];
  if (!p) return priceUsage(model, u);
  return { usd: ((u.promptTokenCount ?? 0) * p.in + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * p.out) / 1e6, priced: true };
}

/** media resolution of the frames Gemini sees (VEDIT_STYLE_RESOLUTION=low|medium|high, default high) */
export function styleResolution(env: NodeJS.ProcessEnv = process.env): "low" | "medium" | "high" {
  const v = env.VEDIT_STYLE_RESOLUTION?.trim().toLowerCase();
  return v === "low" || v === "medium" ? v : "high";
}

export class RefLinkError extends Error {
  constructor(
    message: string,
    public code: "no_ytdlp" | "download_failed" | "not_a_link",
  ) {
    super(message);
    this.name = "RefLinkError";
  }
}

export interface ExtractInput {
  file?: string;
  url?: string;
  /** Telegram file_unique_id of the uploaded reference (cache alias before downloading) */
  fileUniqueId?: string;
  name?: string;
}

export interface GeminiCall {
  data: unknown;
  model: string;
  usage: GeminiUsage;
  requests: number;
}

export interface ExtractOptions {
  cache?: StyleCache;
  /** re-analyse even when cached */
  force?: boolean;
  apiKey?: string;
  models?: string[];
  fetchFn?: typeof fetch;
  tmpDir?: string;
  onLog?: (line: string) => void;
  /** delete `input.file` after the analysis (bot uploads: only the DNA is kept) */
  deleteInput?: boolean;
  /** no Gemini call: measurements + defaults (tests, no key) */
  noGemini?: boolean;
  // ── test hooks ──
  transcribe?: (wav: string, duration: number, outDir: string) => Promise<Transcript>;
  measure?: (file: string, transcript: Transcript | null, wav: string | null) => Promise<Measured>;
  gemini?: (clip: string, system: string, user: string) => Promise<GeminiCall>;
  download?: (url: string, dir: string) => Promise<string>;
}

export interface ExtractResult {
  profile: StyleProfile;
  cached: boolean;
  /** the cache file holding the profile */
  file: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** yt-dlp (Unlicense) → one mp4 in `dir`. Only for analysis: the file is deleted after the DNA is extracted. */
export async function downloadWithYtDlp(url: string, dir: string, bin = process.env.VEDIT_YTDLP || "yt-dlp"): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  let out: { stdout: string };
  try {
    out = await runProcess(bin, ["--no-playlist", "--no-progress", "--no-warnings", "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4", "--max-filesize", "300M", "-o", path.join(dir, "reference.%(ext)s"), "--print", "after_move:filepath", url]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to start/i.test(msg)) throw new RefLinkError(`yt-dlp не найден (${bin}): ссылки не скачиваются — пришлите сам ролик файлом`, "no_ytdlp");
    throw new RefLinkError(`не удалось скачать ролик по ссылке (${msg.split("\n").slice(-2).join(" ").slice(0, 200)}) — пришлите сам ролик файлом`, "download_failed");
  }
  const file = out.stdout.trim().split("\n").filter(Boolean).pop();
  if (!file) throw new RefLinkError("yt-dlp ничего не скачал — пришлите сам ролик файлом", "download_failed");
  return file;
}

/** whisper.cpp on a 16 kHz WAV (the same transcriber as `understand`) */
async function defaultTranscribe(wav: string, duration: number, outDir: string): Promise<Transcript> {
  const { transcribe } = await import("../understand/whisper.ts");
  return (await transcribe(wav, duration, outDir, {})).transcript;
}

/** Everything we can measure locally. */
export async function measureReference(file: string, transcript: Transcript | null, wav: string | null, maxSeconds = STYLE_MAX_SECONDS): Promise<Measured> {
  const probe = await ffprobe(file);
  const duration = Math.min(maxSeconds, Number(probe.format.duration) || 0);
  const [hard, gray] = await Promise.all([sceneCuts(file, 0.18, maxSeconds), grayFrames(file, { maxSeconds })]);
  const jump = detectJumpCuts(bandDiffs(gray.frames, gray.w, gray.h), { fps: gray.fps });
  const cuts = mergeCuts([hard, jump], duration);
  const speech = transcript ? speechStats(transcript, duration) : null;
  const audio = transcript && wav ? audioStats(await loudnessTimeline(wav), transcript) : null;
  const picture = await pictureStats(file, maxSeconds).catch(() => null);
  return { duration: r2(duration), cuts, ...cutStats(cuts, duration), speech, audio, picture };
}

/** The measurements as text for the model (prompts/style.dna.user.md). */
export function metricsText(m: Measured): string {
  const lines = [
    `- cuts detected: ${m.total_cuts} (hard cuts + jump cuts inside a shot) at ${m.cuts.slice(0, 40).map((t) => t.toFixed(2)).join(", ")}${m.cuts.length > 40 ? " …" : ""} s`,
    `- average shot length: ${m.asl} s; first 3 s: ${m.hook_cuts} cut(s), average ${m.hook_asl} s; after 3 s: average ${m.body_asl} s`,
  ];
  if (m.speech) {
    const s = m.speech;
    lines.push(`- speech: ${s.words} words (${s.language}), ${s.wpm} words/min, ${Math.round(s.speech_ratio * 100)} % of the reel has words`);
    lines.push(`- pauses between words: median ${s.pause_median_ms} ms, 90th percentile ${s.pause_p90_ms} ms, pauses > 300 ms: ${s.long_pauses_per_min}/min (a jump-cut edit removes them)`);
    lines.push(`- hesitation sounds heard (э, ммм, uh, um): ${s.fillers}`);
  } else lines.push("- speech: none recognised");
  if (m.audio) lines.push(`- loudness: words ${m.audio.speech_lufs ?? "?"} LUFS, gaps between words ${m.audio.gap_lufs ?? "too few gaps to measure"} LUFS${m.audio.gap_lufs !== null ? ` → ${m.audio.music_likely ? "something keeps playing in the gaps (music bed likely)" : "gaps are quiet"}` : ""}`);
  if (m.picture) lines.push(`- picture (8-bit, signalstats): mean luma ${m.picture.yavg}, luma spread p10–p90 ${m.picture.yrange}, mean saturation ${m.picture.satavg}`);
  return lines.join("\n");
}

const PACE_BY_ASL = (asl: number): StyleDNA["planner_rules"]["pacing_profile"] => (asl < 1.3 ? "aggressive" : asl < 2.4 ? "fast" : asl < 5 ? "moderate" : "calm");

/**
 * Measured numbers win where we measured them (shot lengths and the pace they imply, speech rate, the pause
 * threshold, fillers left in); the model decides typography, colours, animation, framing, music, effects, look.
 */
export function mergeMeasured(dna: StyleDNA, m: Measured, fromModel: boolean): { dna: StyleDNA; provenance: Record<string, "measured" | "gemini" | "default" | "merged"> } {
  const out: StyleDNA = structuredClone(dna);
  const prov: Record<string, "measured" | "gemini" | "default" | "merged"> = {};
  const base = fromModel ? "gemini" : "default";
  for (const k of ["style_summary", "planner_rules", "hyperframes_theme.captions", "hyperframes_theme.camera_motion", "hyperframes_theme.overlays", "audio_and_color"]) prov[k] = base;
  const P = out.planner_rules;
  if (m.duration >= 4) {
    P.hook_cut_duration_sec = Math.min(4, Math.max(0.3, m.hook_asl));
    P.body_avg_cut_duration_sec = Math.min(15, Math.max(0.5, m.body_asl));
    P.pacing_profile = PACE_BY_ASL(m.body_asl);
    prov["planner_rules.hook_cut_duration_sec"] = "measured";
    prov["planner_rules.body_avg_cut_duration_sec"] = "measured";
    prov["planner_rules.pacing_profile"] = "measured";
  }
  if (m.speech && m.speech.words >= 12) {
    P.speech_wpm_estimate = Math.min(260, Math.max(60, m.speech.wpm));
    prov["planner_rules.speech_wpm_estimate"] = "measured";
    // the gaps the editor left: a jump-cut reel keeps them under ~250 ms, natural speech has 400–700 ms breaths
    P.silence_cut_threshold_ms = Math.min(600, Math.max(150, Math.round((m.speech.pause_p90_ms * 1.15) / 10) * 10));
    prov["planner_rules.silence_cut_threshold_ms"] = "measured";
    if (m.speech.fillers >= 2) {
      P.remove_fillers_and_retakes = false;
      prov["planner_rules.remove_fillers_and_retakes"] = "measured";
    } else if (m.speech.fillers === 0 && m.speech.long_pauses_per_min <= 4) {
      P.remove_fillers_and_retakes = true;
      prov["planner_rules.remove_fillers_and_retakes"] = "measured";
    }
  }
  if (m.audio && m.audio.gap_lufs !== null && fromModel && m.audio.music_likely !== out.audio_and_color.has_background_music) {
    // the ear of the model beats our rough gap loudness, but the disagreement is worth a note in the provenance
    prov["audio_and_color.has_background_music"] = "merged";
  }
  if (!fromModel && m.audio?.music_likely) {
    out.audio_and_color.has_background_music = true;
    prov["audio_and_color.has_background_music"] = "measured";
  }
  return { dna: out, provenance: prov };
}

/** A reduced copy for the model: ≤ 90 s, ≤ 960 px on the long side, 15 fps, mono AAC (captions stay legible). */
async function modelClip(file: string, out: string): Promise<void> {
  const v = (await ffprobe(file)).streams.find((s) => s.codec_type === "video");
  const portrait = (v?.height ?? 0) >= (v?.width ?? 0);
  const scale = portrait ? "scale=-2:'min(960,ih)'" : "scale='min(960,iw)':-2";
  const hasAudio = (await ffprobe(file)).streams.some((s) => s.codec_type === "audio");
  await ffmpeg(["-t", String(STYLE_MAX_SECONDS), "-i", file, "-vf", `${scale},fps=15`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", ...(hasAudio ? ["-c:a", "aac", "-b:a", "96k", "-ac", "1"] : ["-an"]), "-movflags", "+faststart", out]);
}

/** Gemini through the shared client: upload → generate (StyleDNA schema, temperature 0.1) → delete in finally. */
async function geminiStyle(clip: string, system: string, user: string, o: ExtractOptions): Promise<GeminiCall> {
  const apiKey = o.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("нет GEMINI_API_KEY");
  const models = o.models ?? (process.env.VEDIT_STYLE_MODEL ? process.env.VEDIT_STYLE_MODEL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_STYLE_MODELS);
  const client = new GeminiClient({ apiKey, fetchFn: o.fetchFn, onLog: o.onLog, rounds: 1, roundWaitMs: 30_000 });
  const uploaded = await client.upload(clip, "video/mp4", "vedit-style-reference.mp4");
  try {
    const fps = Number(process.env.VEDIT_STYLE_FPS) > 0 ? Number(process.env.VEDIT_STYLE_FPS) : STYLE_FPS;
    const g = await client.generate(models, {
      system,
      parts: [{ file_data: { mime_type: uploaded.mimeType, file_uri: uploaded.uri }, video_metadata: { fps } }, { text: user }],
      schema: STYLE_DNA_RESPONSE_SCHEMA,
      temperature: 0.1,
      // captions are small coloured text: low resolution (~70 tokens/frame) misreads their colours and thin overlays
      mediaResolution: styleResolution(),
    });
    return { data: g.data, model: g.model, usage: g.usage, requests: client.requests };
  } finally {
    await client.remove(uploaded.name);
  }
}

export async function extractStyle(input: ExtractInput, opts: ExtractOptions = {}): Promise<ExtractResult> {
  const cache = opts.cache ?? new StyleCache();
  const log = opts.onLog ?? (() => {});
  const aliases: string[] = [];
  const canon = input.url ? canonicalUrl(input.url) : null;
  if (input.url && !canon) throw new RefLinkError("это не ссылка на ролик — пришлите сам ролик файлом или ссылку https://…", "not_a_link");
  if (canon) aliases.push(`url:${canon}`);
  if (input.fileUniqueId) aliases.push(tgAlias(input.fileUniqueId));
  const t0 = Date.now();
  const tmp = await fs.mkdtemp(path.join(opts.tmpDir ?? os.tmpdir(), "vedit-style-"));
  let file = input.file;
  let downloaded = false;
  try {
    if (!opts.force) {
      for (const a of aliases) {
        const hit = await cache.byAlias(a);
        if (hit) {
          log(`стиль: из кэша (${a})`);
          return { profile: hit, cached: true, file: cache.file(hit.key) };
        }
      }
    }
    if (!file && input.url) {
      log(`стиль: скачиваю ${input.url}`);
      file = await (opts.download ?? downloadWithYtDlp)(input.url, path.join(tmp, "dl"));
      downloaded = true;
    }
    if (!file) throw new Error("extractStyle: нужен файл или ссылка");
    const key = await contentKey(file);
    if (!opts.force) {
      const hit = await cache.get(key);
      if (hit) {
        if (aliases.length) await cache.alias(key, aliases);
        log("стиль: из кэша (тот же файл)");
        return { profile: hit, cached: true, file: cache.file(key) };
      }
    }

    const timings: Record<string, number> = {};
    const warnings: string[] = [];
    const probe = await ffprobe(file);
    const v = probe.streams.find((s) => s.codec_type === "video");
    if (!v) throw new Error("в файле примера нет видео");
    const duration = Math.min(STYLE_MAX_SECONDS, Number(probe.format.duration) || 0);
    if (Number(probe.format.duration) > STYLE_MAX_SECONDS) warnings.push(`пример длиннее ${STYLE_MAX_SECONDS} с — анализируются первые ${STYLE_MAX_SECONDS} с`);

    // speech (whisper on 16 kHz mono) → words for the rate / pauses / fillers
    let transcript: Transcript | null = null;
    let wav: string | null = null;
    const hasAudio = probe.streams.some((s) => s.codec_type === "audio");
    if (hasAudio) {
      const t = Date.now();
      wav = path.join(tmp, "audio.wav");
      await ffmpeg(["-t", String(STYLE_MAX_SECONDS), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
      try {
        log("стиль: распознаю речь примера…");
        transcript = await (opts.transcribe ?? defaultTranscribe)(wav, duration, tmp);
      } catch (err) {
        warnings.push(`речь примера не распознана: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
      timings.asr = r2((Date.now() - t) / 1000);
    }
    let t = Date.now();
    log("стиль: меряю склейки, паузы, звук, картинку…");
    const measured = await (opts.measure ?? ((f, tr, w) => measureReference(f, tr, w)))(file, transcript, wav);
    timings.measure = r2((Date.now() - t) / 1000);

    // Gemini: the visuals
    let raw: unknown = DEFAULT_DNA;
    let gemini: StyleProfile["gemini"] = null;
    const haveKey = !!(opts.apiKey ?? process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY) || !!opts.gemini;
    if (!opts.noGemini && haveKey) {
      t = Date.now();
      log("стиль: Gemini смотрит пример…");
      const clip = path.join(tmp, "model.mp4");
      await modelClip(file, clip);
      const user = fill(loadPrompt("style.dna.user"), { duration: r2(duration), width: v.width ?? 0, height: v.height ?? 0, metrics: metricsText(measured) });
      try {
        const g = await (opts.gemini ?? ((c, s, u) => geminiStyle(c, s, u, opts)))(clip, loadPrompt("style.dna.system"), user);
        raw = g.data;
        const price = stylePrice(g.model, g.usage);
        gemini = { model: g.model, requests: g.requests, input_tokens: g.usage.promptTokenCount ?? 0, output_tokens: (g.usage.candidatesTokenCount ?? 0) + (g.usage.thoughtsTokenCount ?? 0), usd: price.usd, priced: price.priced, seconds: r2((Date.now() - t) / 1000) };
      } catch (err) {
        warnings.push(`Gemini не ответил (${err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : err}) — визуальные параметры по умолчанию, ритм по замерам`);
      }
      timings.gemini = r2((Date.now() - t) / 1000);
    } else if (!opts.noGemini) warnings.push("нет GEMINI_API_KEY — визуальные параметры по умолчанию, ритм по замерам");

    const parsed = parseDNA(raw);
    const merged = mergeMeasured(parsed.dna, measured, gemini !== null);
    const profile: StyleProfile = StyleProfileSchema.parse({
      version: 1,
      key,
      source: input.url ? { kind: "url", name: input.name ?? canon ?? input.url, url: input.url } : { kind: input.fileUniqueId ? "telegram" : "file", name: input.name ?? path.basename(file), ...(input.fileUniqueId ? { file_unique_id: input.fileUniqueId } : {}) },
      created_at: new Date().toISOString(),
      dna: merged.dna,
      measured,
      provenance: merged.provenance,
      gemini,
      fixed: gemini ? parsed.fixed : [],
      warnings,
      timings: { ...timings, total: r2((Date.now() - t0) / 1000) },
    });
    const cached = await cache.put(profile, aliases);
    return { profile, cached: false, file: cached };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    // the reference is only analysed: a downloaded or uploaded copy does not outlive the analysis
    if (file && (downloaded || opts.deleteInput)) await fs.rm(file, { force: true }).catch(() => {});
  }
}
