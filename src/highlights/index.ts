import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { addCost } from "../lib/cost.ts";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import type { StructuredFn } from "../lib/llm.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { EdlSchema, TranscriptSchema, type Edl, type Media, type Transcript } from "../schemas/index.ts";
import { detectEvents, EventsFileSchema, loadEvents, type DetectEventsOptions, type EventsFile } from "../understand/events.ts";
import { refineEvents } from "../understand/refine.ts";
import { addScannedMakes, scanShots } from "../understand/scan.ts";
import { isMood, pickMusic, type MusicTrack } from "../audio/music.ts";
import { detectBeats, type BeatGrid } from "../audio/beats.ts";
import { ffprobe } from "../lib/ffmpeg.ts";
import { transcribe, shiftSegments } from "../understand/whisper.ts";
import { applyDirection, refill, buildHighlightEdl, candidatesText, HighlightDirectionSchema, isMake, selectHighlights, type HighlightEdl, type HighlightPick } from "./plan.ts";
import { parseHighlightsBrief, sportOf } from "./intent.ts";

/**
 * HIGHLIGHTS flow for sports / action footage: events (Gemini, cached) → local refinement of every shot
 * (ball track at the rim, audio onset) → rule-based selection → optional editor call (Claude: title,
 * opener, callouts) → music + beat grid → EDL with speed ramps, punch-ins and effects → captions for the
 * people talking (whisper on those clips only). Writes edl.json, highlights.json, transcript.json.
 */

export const HighlightsReportSchema = z.object({
  instruction: z.string(),
  sport: z.string(),
  target: z.number(),
  aspect: z.string(),
  title: z.string(),
  events: z.object({ total: z.number(), shots: z.number(), makes: z.number(), makes_model: z.number(), makes_local: z.number(), social: z.number() }),
  gemini: z.object({ requests: z.number(), input_tokens: z.number(), output_tokens: z.number(), cached_chunks: z.number(), wall_seconds: z.number() }),
  music: z.object({ file: z.string(), title: z.string(), creator: z.string(), license: z.string(), attribution: z.string(), offset: z.number(), bpm: z.number().nullable(), beat_strength: z.number().nullable() }).nullable(),
  editor: z.object({ provider: z.string(), model: z.string(), usd: z.number(), reasoning: z.string() }).nullable(),
  timeline: z.array(z.object({ id: z.string(), role: z.string(), start: z.number(), end: z.number(), impact: z.number().nullable(), beat_aligned: z.boolean(), callout: z.string().optional(), replay: z.boolean(), description: z.string() })),
  duration: z.number(),
  notes: z.array(z.string()),
  wall_seconds: z.number(),
});
export type HighlightsReport = z.infer<typeof HighlightsReportSchema>;

export interface HighlightsOptions {
  instruction?: string;
  target?: number;
  aspect?: "9:16" | "1:1" | "16:9";
  title?: string;
  /** music: auto (sport mood) | a mood | a file | none */
  music?: string;
  /** editor model call; null = rules only */
  llm?: StructuredFn | null;
  events?: DetectEventsOptions;
  /** whisper the people talking (captions) */
  captions?: boolean;
  onLog?: (line: string) => void;
}

/** Events for the job: reuse events.json when it is for this source, otherwise detect (chunk cache makes a rerun free). */
export async function ensureEvents(jobId: string, media: Media, o: HighlightsOptions = {}): Promise<EventsFile> {
  const have = await loadEvents(jobId);
  const wantSocial = o.events?.social !== false;
  if (have && have.source === path.resolve(media.source_path) && have.chunks.length && (!wantSocial || (have.passes.includes("social") && !have.social_missing.length && !have.warnings.some((w) => w.includes("(люди)"))))) return have;
  return detectEvents(jobId, media.source_path, media.duration, { sport: sportOf(o.instruction), onLog: o.onLog, ...o.events });
}

/** Default title when no editor is available: the sport and the time of day are the only facts we have. */
export function defaultTitle(sport: string, instruction?: string): string {
  if (/вечер/i.test(instruction ?? "")) return "ВЕЧЕРНИЙ БАСКЕТ";
  if (/basketball/.test(sport)) return "СТРИТБОЛ";
  if (/football/.test(sport)) return "ФУТБОЛ ВО ДВОРЕ";
  return "ИГРА";
}

/** Music start: the beat nearest to ~15 % into the track (past a quiet intro), at most 30 s. */
export async function chooseMusic(jobId: string, want: string, seconds: number, seed = jobId): Promise<{ track: MusicTrack; offset: number; grid: BeatGrid | null } | null> {
  let track: MusicTrack | null;
  if (want === "none") return null;
  if (want !== "auto" && !isMood(want)) {
    if (!(await exists(want))) throw new Error(`музыка не найдена: ${want}`);
    track = { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" };
  } else {
    // cuts sit on the beat grid: the track must cover the whole edit (a loop seam would break it)
    const mood = want === "auto" ? "sport" : want;
    track = (await pickMusic(mood, seed, { minSeconds: Math.ceil(seconds), strictLength: true })) ?? (await pickMusic(mood, seed, { minSeconds: 60 }));
  }
  if (!track) return null;
  const dur = Number((await ffprobe(track.file)).format.duration) || 0;
  let offset = dur > seconds + 20 ? Math.min(30, dur * 0.15) : 0;
  let grid: BeatGrid | null = null;
  try {
    grid = await detectBeats(track.file, { offset, seconds: Math.min(seconds + 10, Math.max(20, dur - offset)) });
    if (grid.beats.length && offset > 0) {
      // start exactly on a beat: shift the offset, keep the grid relative to the new start
      offset += grid.beats[0];
      grid = { ...grid, phase: 0, beats: grid.beats.map((b) => Math.round((b - grid!.beats[0]) * 1000) / 1000) };
    }
  } catch {
    grid = null;
  }
  return { track, offset: Math.round(offset * 1000) / 1000, grid };
}

/** whisper on noisy far-field speech: a phrase repeated over and over, or almost no distinct words */
export function isJunkText(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length >= 6 && new Set(words).size / words.length < 0.45) return true;
  // the same chunk of 1–5 words three times in a row
  for (let n = 1; n <= 5; n++) {
    for (let i = 0; i + 3 * n <= words.length; i++) {
      const a = words.slice(i, i + n).join(" ");
      if (a === words.slice(i + n, i + 2 * n).join(" ") && a === words.slice(i + 2 * n, i + 3 * n).join(" ")) return true;
    }
  }
  return false;
}

const TURKIC_CONFUSIONS = ["tr", "az", "kk", "ky", "tk", "ug", "tt", "ba"];

/** Whisper on the clips where people talk → transcript.json in source time (captions only there). */
export async function transcribeSpeech(jobId: string, media: Media, ranges: { start: number; end: number }[], log: (l: string) => void): Promise<Transcript> {
  const dir = jobDir(jobId);
  const segments: Transcript["segments"] = [];
  let language = "ru";
  for (const [i, r] of ranges.entries()) {
    const wav = path.join(dir, `speech_${i}.wav`);
    await ffmpeg(["-ss", r.start.toFixed(3), "-to", r.end.toFixed(3), "-i", media.source_path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    try {
      let t = await transcribe(wav, r.end - r.start, path.join(dir, `speech_${i}`));
      // whisper hears Uzbek as Turkish / Azerbaijani on short noisy clips: ask again in Uzbek
      if (TURKIC_CONFUSIONS.includes(t.transcript.language)) t = await transcribe(wav, r.end - r.start, path.join(dir, `speech_${i}_uz`), { language: "uz" });
      // far-field chatter under a ball game: whisper loops or invents; such text is no caption
      const whole = t.transcript.segments.map((seg) => seg.text).join(" ");
      // and a lone short phrase ("I don't know.", "Спасибо.") on street noise is a classic whisper invention too
      const words = whole.split(/\s+/).filter(Boolean).length;
      const good = isJunkText(whole) || words < 4 ? [] : t.transcript.segments.filter((seg) => !isJunkText(seg.text));
      if (good.length < t.transcript.segments.length) log(`речь ${i + 1}: ${t.transcript.segments.length - good.length} фраз(ы) похожи на галлюцинацию — без субтитров`);
      segments.push(...shiftSegments(good, r.start));
      if (t.transcript.language !== "unknown") language = t.transcript.language;
      log(`речь ${i + 1}/${ranges.length}: ${t.transcript.segments.map((s) => s.text).join(" ").slice(0, 120) || "(ничего не разобрано)"}`);
    } catch (err) {
      log(`речь ${i + 1}: whisper не сработал — ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    } finally {
      await fs.rm(wav, { force: true }).catch(() => {});
    }
  }
  const transcript = { language, segments: segments.sort((a, b) => a.start - b.start) };
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, transcript);
  return transcript;
}

/** bump when refine.ts / scan.ts change: events.json is refined again (the Gemini part stays cached) */
export const LOCAL_VERSION = 5;

/**
 * Local pass over the model's events: every shot checked by the ball track at the rim (refine.ts),
 * then the whole video scanned for makes the model did not log (scan.ts). Model-only fields are kept.
 */
export async function localPass(jobId: string, ev: EventsFile, media: Media, log: (l: string) => void): Promise<EventsFile> {
  const t0 = Date.now();
  const fps = Math.round(media.source.fps) || 60;
  // start from the model's view (a previous local pass may have changed outcomes or added events)
  const base = { ...ev, events: ev.events.filter((e) => e.chunk >= 0).map((e) => ({ ...e, refined: undefined, ...(e.refined ? { key: e.refined.key } : {}) })) };
  const shots = base.events.filter((e) => e.type.startsWith("shot") || e.type === "dunk_layup").length;
  log(`уточняю ${shots} бросков по кадрам у кольца…`);
  let out = await refineEvents(base, media.source_path, { frameW: media.width, frameH: media.height, fps, onLog: log });
  log("сканирую всё видео у кольца (попадания, которых модель не заметила)…");
  const cands = await scanShots(media.source_path, out.hoops, media.duration, { frameW: media.width, frameH: media.height, onLog: log });
  const added = await addScannedMakes(out.events, cands, media.source_path, out.hoops, { frameW: media.width, frameH: media.height });
  out = { ...out, events: added.events, local: { version: LOCAL_VERSION, refined: shots, scan_candidates: cands.length, scan_added: added.added, wall_seconds: (Date.now() - t0) / 1000 } };
  log(`по кадрам: подходов мяча к кольцу ${cands.length}, добавлено попаданий ${added.added}, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  return writeJson(path.join(jobDir(jobId), "events.json"), EventsFileSchema, out);
}

export interface HighlightsResult {
  edl: Edl;
  report: HighlightsReport;
  plan: HighlightEdl;
}

/** No moment worth a highlight was found in the footage (events: how many the detector returned). */
export class NoHighlightsError extends Error {
  constructor(readonly events: number) {
    super(`в видео не нашлось игровых моментов для хайлайтов (событий: ${events})`);
    this.name = "NoHighlightsError";
  }
}

export async function planHighlights(jobId: string, media: Media, o: HighlightsOptions = {}): Promise<HighlightsResult> {
  const t0 = Date.now();
  const log = o.onLog ?? (() => {});
  const dir = jobDir(jobId);
  const instruction = o.instruction ?? "";
  const brief = parseHighlightsBrief(instruction);
  const target = o.target ?? brief.target ?? 50;
  const aspect = o.aspect ?? brief.aspect ?? "9:16";
  const sport = sportOf(instruction);
  const notes: string[] = [];

  // 1. events + local refinement (cached in events.json: refined fields survive a re-plan)
  let ev = await ensureEvents(jobId, media, o);
  const modelMakesOf = (x: EventsFile) => x.events.filter((e) => (e.type.startsWith("shot") || e.type === "dunk_layup") && (e.refined?.model_outcome ?? e.outcome) === "make" && e.chunk >= 0).length;
  if (ev.local?.version !== LOCAL_VERSION) {
    // an older local pass changed outcomes in place: start again from the model's answers (all cached)
    if (ev.local) ev = await detectEvents(jobId, media.source_path, media.duration, { sport: sportOf(o.instruction), onLog: log, ...o.events });
    ev = await localPass(jobId, ev, media, log);
  }
  const makes = ev.events.filter(isMake);
  log(`событий ${ev.events.length}: бросков ${ev.events.filter((e) => e.type.startsWith("shot") || e.type === "dunk_layup").length}, попаданий ${makes.length} (модель видела ${modelMakesOf(ev)}), людей подошло ${ev.events.filter((e) => e.type === "people_approach").length}`);

  // 2. selection by rules
  const sel = selectHighlights(ev.events, { target: target + 2, min: Math.max(15, target - 5), max: target + 10, aspect });
  // nothing game-like in the footage (e.g. someone talking to the camera): the caller falls back to a speech montage
  if (!sel.picks.length) throw new NoHighlightsError(ev.events.length);
  notes.push(...sel.notes);
  let picks: HighlightPick[] = sel.picks;
  let title = o.title ?? brief.title ?? "";
  let editor: HighlightsReport["editor"] = null;

  // 3. the editor's call (title, opener, drops, callouts)
  if (o.llm && picks.length) {
    try {
      const prompt = fill(loadPrompt("highlights.user"), { instruction: instruction || "(нет)", sport, seconds: Math.round(sel.seconds), candidates: candidatesText(picks) });
      const r = await o.llm({ system: loadPrompt("highlights.system"), prompt, schema: zodToApiSchema(HighlightDirectionSchema), effort: "low", maxTokens: 4000, maxBudgetUsd: 0.5 });
      const d = HighlightDirectionSchema.parse(r.data);
      const applied = applyDirection(picks, d);
      picks = refill(applied.picks, ev.events, { target, max: target + 10, exclude: new Set(d.drop) });
      notes.push(...applied.notes);
      if (!title) title = applied.title;
      editor = { provider: r.provider, model: r.model, usd: r.usd, reasoning: d.reasoning };
      await addCost(jobId, { step: "plan", provider: r.provider === "anthropic" ? "anthropic" : r.provider, model: r.model, units: { ...r.usage, calls: 1, estimate: r.estimate ? 1 : 0 }, usd: r.usd });
      log(`редактор (${r.model}): «${d.title}», открывает ${d.opener}; ${d.reasoning}`);
    } catch (err) {
      notes.push(`редактор не ответил, план по правилам: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  // the editor dropped every moment: the rules' choice instead of an empty reel
  if (!picks.length) {
    notes.push("редактор убрал все моменты — план по правилам");
    picks = sel.picks;
  }
  if (!title) title = defaultTitle(sport, instruction);

  // 4. music and its beats
  let music: Awaited<ReturnType<typeof chooseMusic>> = null;
  try {
    music = await chooseMusic(jobId, o.music ?? "auto", target + 15);
    if (music) log(`музыка: «${music.track.title}»${music.track.creator ? ` — ${music.track.creator}` : ""} (${music.track.license}), с ${music.offset.toFixed(1)} с, ${music.grid ? `${music.grid.bpm} BPM, ритмичность ${music.grid.strength.toFixed(2)}` : "бит не найден"}`);
    else if ((o.music ?? "auto") !== "none") notes.push("музыка не найдена (нет assets/music и нет доступа к Openverse)");
  } catch (err) {
    notes.push(`музыка: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
  const beats = music?.grid && music.grid.strength > 0.05 ? music.grid.beats : [];

  // 5. EDL
  const plan = buildHighlightEdl(picks, { aspect, target, hoops: ev.hoops, frame: { width: media.width, height: media.height }, beats, title, music: music ? { file: music.track.file, offset: music.offset } : undefined });
  // nothing survived the timeline (too short moments, a few seconds of talking): the caller falls back to a speech montage
  if (!plan.output.clips.length) throw new NoHighlightsError(ev.events.length);
  const duration = plan.timeline.length ? plan.timeline[plan.timeline.length - 1].end : 0;

  // 6. captions for the people talking (whisper on those source ranges only)
  if (plan.speech.length && o.captions !== false) {
    const ranges = plan.output.clips.filter((c) => c.volume === 1).map((c) => ({ start: c.src_start, end: c.src_end }));
    const tr = await transcribeSpeech(jobId, media, ranges, log);
    // a range with real captions does not need the editor's line under it (they would sit on top of each other)
    plan.speech.forEach((sp, i) => {
      const r = ranges[i];
      if (r && tr.segments.some((seg) => seg.start < r.end && seg.end > r.start)) plan.output.titles = plan.output.titles.filter((t) => !(t.style === "lower" && t.at >= sp.start && t.at < sp.end));
    });
    if (!tr.segments.length) plan.output.captions = { enabled: false };
    // captions in the language of the instruction (the design step translates the speech when it differs)
    else plan.output.captions = { enabled: true, language: /[а-яё]/i.test(instruction) ? "ru" : tr.language, style: "bold_pop" };
  } else await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, { language: "unknown", segments: [] });

  const edl = await writeJson(path.join(dir, "edl.json"), EdlSchema, { outputs: [plan.output], reasoning: editor?.reasoning ?? `Хайлайты: ${plan.timeline.filter((t) => t.role === "make").length} попаданий${plan.timeline.some((t) => t.role === "social") ? ", люди просят поиграть" : ""}, музыка по битам.` });
  const report: HighlightsReport = {
    instruction,
    sport,
    target,
    aspect,
    title,
    events: {
      total: ev.events.length,
      shots: ev.events.filter((e) => e.type.startsWith("shot") || e.type === "dunk_layup").length,
      makes: makes.length,
      makes_model: modelMakesOf(ev),
      makes_local: ev.events.filter((e) => e.refined?.local_verdict === "make").length,
      social: ev.events.filter((e) => e.type === "people_approach").length,
    },
    gemini: { requests: ev.usage.requests, input_tokens: ev.usage.input_tokens, output_tokens: ev.usage.output_tokens, cached_chunks: ev.chunks.filter((c) => c.cached).length, wall_seconds: ev.wall_seconds },
    music: music ? { file: music.track.file, title: music.track.title, creator: music.track.creator, license: music.track.license, attribution: music.track.attribution, offset: music.offset, bpm: music.grid?.bpm ?? null, beat_strength: music.grid?.strength ?? null } : null,
    editor,
    timeline: plan.timeline,
    duration: Math.round(duration * 100) / 100,
    notes,
    wall_seconds: (Date.now() - t0) / 1000,
  };
  await writeJson(path.join(dir, "highlights.json"), HighlightsReportSchema, report);
  return { edl, report, plan };
}

export async function loadHighlightsReport(jobId: string): Promise<HighlightsReport | null> {
  const f = path.join(jobDir(jobId), "highlights.json");
  return (await exists(f)) ? readJson(f, HighlightsReportSchema) : null;
}

/**
 * How much of the video is speech, from a few short whisper samples (4 × 15 s spread over the file) —
 * decides a "weak" highlights request ("лучшие моменты") without transcribing an hour of footage.
 */
export async function speechRatioProbe(source: string, duration: number, workDir: string, samples = 4, len = 15): Promise<number> {
  await fs.mkdir(workDir, { recursive: true });
  let speech = 0;
  let total = 0;
  for (let i = 0; i < samples; i++) {
    const at = Math.max(0, ((i + 0.5) / samples) * duration - len / 2);
    const l = Math.min(len, duration - at);
    if (l < 3) continue;
    const wav = path.join(workDir, `probe_${i}.wav`);
    await ffmpeg(["-ss", at.toFixed(2), "-t", l.toFixed(2), "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    try {
      const t = await transcribe(wav, l, path.join(workDir, `probe_${i}`));
      speech += t.transcript.segments.reduce((s, seg) => s + seg.words.reduce((a, w) => a + Math.max(0, w.end - w.start), 0), 0);
    } finally {
      await fs.rm(wav, { force: true }).catch(() => {});
    }
    total += l;
  }
  return total > 0 ? Math.round((speech / total) * 100) / 100 : 0;
}
