import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { selectStructuredLlm, type StructuredFn } from "../lib/llm.ts";
import { createJob, exists, jobDir, readJson, runStep, writeJson } from "../lib/workspace.ts";
import { DEFAULT_GSAP, HF_BIN, HF_VERSION, ROOT, linkOrCopy } from "../design/hyperframes/project.ts";
import { runCli, type LintJson } from "../render/cli-runner.ts";
import { HyperFramesRenderer } from "../render/hyperframes.ts";
import type { RenderQuality } from "../design/renderer.ts";
import { loadFontMetrics } from "../design/layout.ts";
import { composeMake, type ComposeResult, type MakeStyle } from "./compose.ts";
import { loadIconSvg } from "./icons.ts";
import { ScriptSchema, scriptDuration, writeScript, type Script } from "./script.ts";
import { describeFindings } from "./slop.ts";
import { researchTrends, trendsBackend, trendsText, TrendsSchema, type Trends, type TrendsOptions } from "./trends.ts";
import { DesignSchema, directDesign, fallbackDesign, type Design } from "./design.ts";
import { generateImages, imageBackend, type ImageOptions } from "./images.ts";
import { creditRejected, findPhotos, photoCreditLine, type PhotoCredit, type PhotoOptions } from "./photos.ts";
import { composeScenes, FPS, type BeatSpeech, type ComposedScenes } from "./scenes.ts";
import { detectAspect, frameFor, stripAspectWords, type Aspect, type Frame } from "../lib/aspect.ts";
import { installFonts } from "./fonts.ts";
import { presenterBox, presenterClip, presenterSource, type PresenterBox } from "./presenter.ts";
import { fitText } from "./fit.ts";
import { mixSoundtrack } from "../audio/mix.ts";
import { isMood, pickMusic, type Mood, type MusicTrack } from "../audio/music.ts";
import { bedStart, detectBeats } from "../audio/beats.ts";
import type { SfxCue } from "../audio/sfx.ts";
import { NO_VOICE } from "../voice/catalog.ts";
import type { SentenceSynth } from "../voice/piper.ts";
import { layVoiceover, makeVoiceover, snapBeatsToMusic, speechSeconds, ttsUsd, type CaptionCue, type VoiceoverResult } from "../voice/voiceover.ts";

/**
 * MAKE: a topic → a vertical video built from nothing (text, generated images, motion; music optional).
 *   trends (Antigravity web research) → script (Claude) → art director (Claude: identity + a composed
 *   scene per beat) → images (Antigravity image tool) → scenes composition → text fit in Chrome → render
 *   → contact sheet → music mux.
 * Everything lands in workspace/<job>/: trends.json, script.json, design.json, make/images/, make/project/,
 * make/sheet.jpg, output_make.mp4, make.json.
 */

export const MakeReportSchema = z.object({
  topic: z.string(),
  language: z.string(),
  title: z.string(),
  duration: z.number(),
  beats: z.number().int(),
  output: z.string(),
  preview: z.string(),
  trends: z.enum(["agy", "gemini", "skipped", "failed"]),
  music: z.string().nullable(),
  music_attribution: z.string().default(""),
  sfx: z.number().int().default(0),
  /** voiceover voice id (make --voice), null = no narration */
  voice: z.string().nullable().default(null),
  voice_seconds: z.number().default(0),
  /** output frame */
  aspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"),
  width: z.number().int().default(1080),
  height: z.number().int().default(1920),
  /** where the scene pictures came from: "photo" (Openverse), "ai" (generated), "none" */
  images: z.string().default("none"),
  /** one credit line per photo used (CC BY needs attribution; CC0/PDM credited as a courtesy) */
  photo_credits: z.array(z.string()).default([]),
  /** banned phrases the cliché check found in the first draft of the script */
  cliches_fixed: z.number().int().default(0),
  /** stage 25: the presenter bundle made for Colab, and whether a presenter video is in this render */
  presenter_bundle: z.string().nullable().default(null),
  presenter_job: z.string().nullable().default(null),
  presenter_video: z.string().nullable().default(null),
  /** pacing problems (narration over budget, long or late hook) fixed by the rewrite */
  pacing_fixed: z.number().int().default(0),
  /** seconds of the hook beat (stage 25: 2–3 s) */
  hook_seconds: z.number().default(0),
  /** music bed: tempo and how many scene cuts landed on its beats */
  music_bpm: z.number().nullable().default(null),
  cuts_on_beat: z.number().int().default(0),
  usd: z.number(),
  wall_seconds: z.number(),
  render_seconds: z.number(),
  warnings: z.array(z.string()),
});
export type MakeReport = z.infer<typeof MakeReportSchema>;

export interface MakeOptions {
  language?: string;
  seconds?: number;
  audience?: string;
  /** web research before writing (needs the Antigravity CLI); default: when agy is installed */
  trends?: boolean;
  /** background music: a file, a mood (upbeat/chill/…), "auto" (the director's mood, default) or "none" */
  music?: string;
  /** sound effects on the motion (default on) */
  sfx?: boolean;
  /** voiceover: a voice id from the catalogue (vedit voices) or "none" (default: no narration) */
  voice?: string;
  /** burn short captions of the voiceover into the video (default off: the scenes already carry the text) */
  voiceCaptions?: boolean;
  /** Piper speed: > 1 slower, < 1 faster */
  voiceLengthScale?: number;
  /** test hook: replaces the Piper call */
  voiceSynth?: SentenceSynth;
  quality?: RenderQuality;
  style?: Partial<MakeStyle>;
  model?: string;
  llm?: StructuredFn;
  trendsOptions?: TrendsOptions;
  renderer?: HyperFramesRenderer;
  /** a saved script.json to render as is (no trends, no model call) */
  scriptFile?: string;
  /** reuse script.json, design.json and images of an earlier make job (re-render after code/style changes) */
  fromJob?: string;
  /** art director step (default on); off = the plain icon composition */
  director?: boolean;
  /**
   * pictures for media scenes: "photo" (default: real photos from Openverse, CC0/PDM/CC BY; a beat without a
   * usable photo falls back to a generated image when agy is installed), "ai" (generated by Antigravity),
   * "none" (typography only). true = "photo", false = "none".
   */
  images?: boolean | ImagesMode;
  imageOptions?: Partial<ImageOptions>;
  photoOptions?: Partial<PhotoOptions>;
  /** output frame: 9:16 (Reels/Shorts, default), 16:9 (YouTube), 1:1; default: detected from the topic */
  aspect?: Aspect;
  /** the user's whole instruction (format words, CTA requests); default: the topic */
  instruction?: string;
  /**
   * stage 25: a presenter bundle for Colab — the narration on the video's timeline + a portrait (a photo path, or true:
   * a generated one) → workspace/<avatar job>/avatar_job.zip; the video itself is made as usual
   */
  presenter?: boolean | string;
  /** stage 25: the animated presenter (avatar_result.zip or avatar.mp4) laid in the bottom corner (use with fromJob) */
  presenterVideo?: string;
  /** test hook: skip the real render and write this file as the output */
  fakeRender?: (projectDir: string, outFile: string) => Promise<void>;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
}

export type ImagesMode = "photo" | "ai" | "none";
export const imagesMode = (v: boolean | string | undefined): ImagesMode => (v === false || v === "none" ? "none" : v === "ai" ? "ai" : "photo");

export interface MakeResult extends MakeReport {
  jobId: string;
  script: Script;
  trendsData: Trends | null;
}

/** Writes the self-contained HyperFrames project for a script (index.html + assets + manifests). */
export async function writeMakeProject(script: Script, dir: string, o: { kicker?: string; style?: Partial<MakeStyle>; fontFile?: string; gsapFile?: string } = {}): Promise<ComposeResult & { entry: string }> {
  await fs.mkdir(path.join(dir, "assets", "fonts"), { recursive: true });
  const fontFile = o.fontFile ?? path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf");
  const fontRel = `assets/fonts/${path.basename(fontFile)}`;
  await linkOrCopy(fontFile, path.join(dir, fontRel));
  await linkOrCopy(o.gsapFile ?? DEFAULT_GSAP, path.join(dir, "assets", "gsap.min.js"));
  const icons: Record<string, string> = {};
  for (const name of new Set(script.beats.map((b) => b.icon))) icons[name] = await loadIconSvg(name);
  const metrics = await loadFontMetrics(fontFile, { family: o.style?.fontFamily ?? "Inter", weight: o.style?.fontWeight ?? 800 });
  const composed = composeMake(script, { icons, fontRel, gsapRel: "assets/gsap.min.js", kicker: o.kicker, style: o.style, metrics });
  const entry = path.join(dir, "index.html");
  await fs.writeFile(entry, composed.html);
  const name = `make-${script.title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}`;
  await fs.writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module", scripts: { check: `npx --yes hyperframes@${HF_VERSION} check`, render: `npx --yes hyperframes@${HF_VERSION} render` } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: name, name, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
  // the renderer reads frame duration/fps from layout.json
  await fs.writeFile(path.join(dir, "layout.json"), JSON.stringify({ frame: { width: composed.width, height: composed.height, fps: composed.fps, duration: composed.duration }, beats: composed.beats }, null, 1));
  await fs.writeFile(path.join(dir, "script.json"), JSON.stringify(script, null, 1));
  return { ...composed, entry };
}

/** Writes the art-directed HyperFrames project: images, fonts, composition fitted in Chrome, manifests. */
/** Per-beat narration (word times) for the composition, from a voiceover. */
export function speechByBeat(vo: Pick<VoiceoverResult, "beats" | "words">, beats: number): (BeatSpeech | null)[] {
  return Array.from({ length: beats }, (_, i) => {
    const b = vo.beats.find((x) => x.beat === i);
    const words = vo.words.filter((w) => w.beat === i).map((w) => ({ text: w.text, start: w.start, end: w.end }));
    return b && words.length ? { start: b.start, end: b.end, words } : null;
  });
}

export async function writeDirectorProject(script: Script, design: Design, images: Record<number, string>, dir: string, o: { gsapFile?: string; captions?: CaptionCue[]; frame?: Frame; speech?: (BeatSpeech | null)[]; presenter?: { file: string; box: PresenterBox } } = {}): Promise<ComposedScenes & { entry: string; overflow: string[] }> {
  const frame = o.frame ?? frameFor("9:16");
  await fs.mkdir(path.join(dir, "assets", "img"), { recursive: true });
  await linkOrCopy(o.gsapFile ?? DEFAULT_GSAP, path.join(dir, "assets", "gsap.min.js"));
  let presenter: { src: string; box: PresenterBox } | undefined;
  if (o.presenter) {
    await linkOrCopy(o.presenter.file, path.join(dir, "assets", "presenter.webm"));
    presenter = { src: "assets/presenter.webm", box: o.presenter.box };
  }
  const rel: Record<number, string> = {};
  for (const [beat, file] of Object.entries(images)) {
    const r = `assets/img/${path.basename(file)}`;
    await linkOrCopy(file, path.join(dir, r));
    rel[Number(beat)] = r;
  }
  const I = design.identity;
  const fontIds = [I.display_font, I.accent_font, I.kicker_font === "mono" ? "mono" : I.display_font, "mono", "inter"] as const;
  const fontFaces = await installFonts(dir, [...fontIds]);
  const entry = path.join(dir, "index.html");
  // pass 1: default sizes → measure in Chrome → pass 2 with the fitted sizes
  const base = { images: rel, fontFaces, gsapRel: "assets/gsap.min.js", captions: o.captions, frame, speech: o.speech, presenter };
  let composed = composeScenes(script, design, base);
  await fs.writeFile(entry, composed.html);
  const fit = await fitText(entry, { width: frame.w, height: frame.h });
  composed = composeScenes(script, design, { ...base, sizes: fit.sizes });
  await fs.writeFile(entry, composed.html);
  const name = `make-${script.title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}`;
  await fs.writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module", scripts: { check: `npx --yes hyperframes@${HF_VERSION} check`, render: `npx --yes hyperframes@${HF_VERSION} render` } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: name, name, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "layout.json"), JSON.stringify({ frame: { width: frame.w, height: frame.h, fps: FPS, duration: composed.duration, aspect: frame.aspect }, scenes: composed.timings, sizes: fit.sizes }, null, 1));
  await fs.writeFile(path.join(dir, "design.json"), JSON.stringify(design, null, 1));
  return { ...composed, entry, overflow: fit.overflow };
}

async function lintProject(dir: string): Promise<string[]> {
  const lint = await runCli(HF_BIN, ["lint", "--json"], dir);
  const start = lint.stdout.indexOf("{");
  if (start < 0) throw new Error(`hyperframes lint не вернул JSON (exit ${lint.code}): ${(lint.stderr || lint.stdout).slice(-300)}`);
  const parsed = JSON.parse(lint.stdout.slice(start)) as LintJson;
  await fs.writeFile(path.join(dir, "lint.json"), JSON.stringify(parsed, null, 1));
  const findings = parsed.findings ?? [];
  if (parsed.errorCount > 0) throw new Error(`композиция не прошла lint (${parsed.errorCount}): ${findings.filter((f) => (f.severity ?? "error") === "error").map((f) => f.message ?? f.rule ?? "?").join("; ").slice(0, 500)}`);
  // style advice from the linter (sub-compositions, nested svg) is one note, not one per beat
  const warnings = findings.filter((f) => f.severity === "warning");
  return warnings.length ? [`lint: ${warnings.length} предупреждений о структуре композиции (см. make/project/lint.json)`] : [];
}

/** Loops the music under the video, ducked to −14 LUFS with a 2 s fade-out, video stream copied. */
export async function muxMusic(video: string, music: string, out: string, duration: number) {
  const fade = Math.min(2, Math.max(0.5, duration / 4));
  await ffmpeg([
    "-i", video, "-stream_loop", "-1", "-i", music,
    "-filter_complex", `[1:a]atrim=0:${duration.toFixed(3)},afade=t=in:st=0:d=0.6,afade=t=out:st=${(duration - fade).toFixed(3)}:d=${fade.toFixed(3)},loudnorm=I=-14:TP=-1.5:LRA=11[a]`,
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out,
  ]);
}

export async function make(topic: string, opts: MakeOptions = {}): Promise<MakeResult> {
  const t0 = Date.now();
  const asked = topic.replace(/\s+/g, " ").trim();
  if (!asked) throw new Error("тема пустая");
  const instruction = opts.instruction ?? asked;
  // format words ("для ютуба", "16:9") choose the frame and are not part of the topic the writer sees
  const aspect: Aspect = opts.aspect ?? detectAspect(instruction) ?? "9:16";
  const frame = frameFor(aspect);
  const topicClean = stripAspectWords(asked) || asked;
  const language = opts.language ?? "ru";
  // stage 25: 35–45 s reels; 40 s unless asked (the 65 s videos were too long)
  const seconds = opts.seconds ?? 40;
  const warnings: string[] = [];
  const say = (l: string) => opts.onEvent?.(l);
  const job = await createJob(`make:${topicClean.slice(0, 80)}`, { prompt: asked });
  const dir = jobDir(job.id);
  say(`job ${job.id}`);
  say(`  кадр ${aspect} (${frame.w}×${frame.h})`);

  // 1. trends
  let trendsData: Trends | null = null;
  let trendsStatus: MakeReport["trends"] = "skipped";
  const reuseDir = opts.fromJob ? jobDir(opts.fromJob) : null;
  if (reuseDir && !opts.scriptFile) opts = { ...opts, scriptFile: path.join(reuseDir, "script.json") };
  const trendsVia = opts.trendsOptions?.run ? "agy" : opts.trendsOptions?.gemini?.key ? "gemini-search" : await trendsBackend();
  const wantTrends = !opts.scriptFile && (opts.trends ?? !!trendsVia);
  if (wantTrends) {
    say(`▸ тренды (поиск в вебе через ${trendsVia === "gemini-search" ? "Gemini + Google Search" : "Antigravity"})…`);
    try {
      const r = await runStep(job.id, "understand", () => researchTrends(topicClean, { language, ...opts.trendsOptions }));
      trendsData = r.trends;
      trendsStatus = r.provider === "gemini-search" ? "gemini" : "agy";
      await writeJson(path.join(dir, "trends.json"), TrendsSchema, r.trends);
      if (r.provider === "gemini-search") await addCost(job.id, { step: "understand", provider: "gemini-search", model: r.model, units: { ...r.usage, wall_seconds: r.wall_seconds }, usd: r.usd ?? 0 });
      else await addCost(job.id, { step: "understand", provider: "antigravity-cli", model: r.model, units: { ...r.usage, wall_seconds: r.wall_seconds, subscription: 1 }, usd: 0 });
      say(`  фактов ${r.trends.facts.length}, углов ${r.trends.angles.length}, хуков ${r.trends.hooks.length} (${r.wall_seconds}s)`);
    } catch (err) {
      trendsStatus = "failed";
      warnings.push(`тренды не собраны: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      say(`  ⚠ ${warnings.at(-1)}`);
    }
  } else if (reuseDir && (await exists(path.join(reuseDir, "trends.json")))) {
    await fs.copyFile(path.join(reuseDir, "trends.json"), path.join(dir, "trends.json")).catch(() => {});
  }

  // 2. script (or a saved one); the cliché check rewrites a sloppy first draft once
  say("▸ сценарий…");
  let s: { script: Script; usd: number; provider: string; model: string; usage: { input_tokens: number; output_tokens: number }; estimate: boolean };
  let clichesFixed = 0;
  let pacingFixed = 0;
  if (opts.scriptFile) {
    const script = await readJson(path.resolve(opts.scriptFile), ScriptSchema);
    s = { script, usd: 0, provider: "file", model: "saved", usage: { input_tokens: 0, output_tokens: 0 }, estimate: false };
    await runStep(job.id, "plan", async () => script);
  } else {
    const llm = opts.llm ?? selectStructuredLlm();
    const w = await runStep(job.id, "plan", () => writeScript(topicClean, llm, { language, seconds, audience: opts.audience, trendsText: trendsData ? trendsText(trendsData) : undefined, model: opts.model, instruction }));
    s = w;
    clichesFixed = w.cliches.length - w.remaining.length;
    pacingFixed = w.pacing.length - w.pacingLeft.length;
    if (w.cliches.length) say(`  клише в черновике: ${w.cliches.length} (${[...new Set(w.cliches.map((c) => c.rule))].join(", ")}) → переписано, осталось ${w.remaining.length}`);
    if (w.pacing.length) say(`  темп черновика: ${[...new Set(w.pacing.map((c) => c.rule))].join(", ")} → переписано, осталось ${w.pacingLeft.length}`);
    if (w.remaining.length) warnings.push(`в сценарии остались клише: ${describeFindings(w.remaining).split("\n").slice(0, 3).join("; ")}`);
    if (w.pacingLeft.length) warnings.push(`сценарий длиннее нормы: ${describeFindings(w.pacingLeft).split("\n").slice(0, 2).join("; ")}`);
    await addCost(job.id, { step: "plan", provider: s.provider === "anthropic" ? "anthropic" : s.provider, model: s.model, units: { ...s.usage, calls: w.cliches.length || w.pacing.length ? 2 : 1, estimate: s.estimate ? 1 : 0 }, usd: s.usd });
  }
  await writeJson(path.join(dir, "script.json"), ScriptSchema, s.script);
  say(`  «${s.script.title}», ${s.script.beats.length} битов, ${scriptDuration(s.script)}s${s.usd ? `, ≈$${s.usd.toFixed(3)}` : ""}`);
  for (const b of s.script.beats) say(`    · ${b.text}  [${b.icon}, ${b.seconds}s]`);

  // 2b. voiceover: synthesise every beat's spoken line, stretch the beats to the speech
  let vo: VoiceoverResult | null = null;
  const wantVoice = opts.voice?.trim();
  if (wantVoice && !NO_VOICE.test(wantVoice)) {
    say(`▸ озвучка (${wantVoice})…`);
    vo = await runStep(job.id, "design", () => makeVoiceover(s.script, wantVoice, path.join(dir, "make", "voice"), { lengthScale: opts.voiceLengthScale, synth: opts.voiceSynth, onEvent: (l) => say(`  ${l.trim()}`) }));
    warnings.push(...vo.warnings);
    s = { ...s, script: vo.script };
    await writeJson(path.join(dir, "script.json"), ScriptSchema, s.script);
    if (vo.engine !== "piper") {
      const speechS = vo.beats.reduce((n, b) => n + b.end - b.start, 0);
      const chars = vo.beats.reduce((n, b) => n + b.text.length, 0);
      await addCost(job.id, { step: "design", provider: vo.engine === "gemini" ? "gemini tts" : "cloud tts", model: vo.model ?? vo.engine, units: { voice_seconds: Math.round(speechS * 10) / 10, beats: vo.beats.length, chars }, usd: ttsUsd(vo.engine, vo.model, speechS, chars) });
    } else await addCost(job.id, { step: "design", provider: "piper (local)", model: vo.voice.piper?.key ?? vo.voice.id, units: { voice_seconds: vo.duration, beats: vo.beats.length }, usd: 0 });
    say(`  голос ${vo.voice.id} (${vo.engine === "gemini" ? `Gemini API ${vo.model}` : vo.engine === "cloud" ? `Cloud TTS ${vo.model}` : "Piper"}; ${vo.voice.license}): ${vo.beats.map((b) => (b.end - b.start).toFixed(1)).join(" + ")} с речи → ролик ${scriptDuration(s.script).toFixed(1)} с`);
  }

  // 3. art director → photos → composition (fit in Chrome) → lint
  const projectDir = path.join(dir, "make", "project");
  let usd = s.usd;
  let composed: { duration: number; cues?: SfxCue[] };
  let mood: Mood = "upbeat";
  // music is chosen before the composition (director path) so the cuts can land on its beats
  const want = (opts.music ?? "auto").trim();
  let track: MusicTrack | null = null;
  let musicPicked = false;
  let musicOffset = 0;
  let musicBpm: number | null = null;
  let cutsOnBeat = 0;
  let presenterVideo: string | null = null;
  let imagesUsed: string[] = [];
  let credits: PhotoCredit[] = [];
  if (opts.director === false) {
    say("▸ композиция (простая)…");
    if (aspect !== "9:16") warnings.push(`простая композиция (--no-director) бывает только 9:16 — кадр ${aspect} доступен с арт-директором`);
    composed = await runStep(job.id, "design", async () => {
      const c = await writeMakeProject(s.script, projectDir, { kicker: topicClean.length <= 48 ? topicClean : s.script.title, style: opts.style });
      if (vo && opts.voiceCaptions) warnings.push("субтитры озвучки есть только в композиции арт-директора (без --no-director)");
      warnings.push(...(await lintProject(projectDir)));
      return c;
    });
  } else {
    say("▸ арт-директор…");
    let design: Design | null = null;
    // a saved design is reused for the same frame; another frame gets its own composition (the script stays)
    const oldAspect = reuseDir ? await readJson(path.join(reuseDir, "make.json"), MakeReportSchema).then((r) => r.aspect, () => "9:16" as Aspect) : null;
    const savedDesign = reuseDir ? path.join(reuseDir, "design.json") : null;
    if (savedDesign && oldAspect === aspect && (await exists(savedDesign))) design = await readJson(savedDesign, DesignSchema);
    if (!design) {
      try {
        const llm = opts.llm ?? selectStructuredLlm();
        const d = await directDesign(topicClean, s.script, llm, { model: opts.model, aspect });
        design = d.design;
        usd += d.usd;
        await addCost(job.id, { step: "design", provider: d.provider === "anthropic" ? "anthropic" : d.provider, model: d.model, units: { ...d.usage, calls: 1, estimate: d.estimate ? 1 : 0 }, usd: d.usd });
        for (const n of d.notes) say(`  · ${n}`);
      } catch (err) {
        design = fallbackDesign(s.script);
        warnings.push(`арт-директор не ответил, простой дизайн: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    await writeJson(path.join(dir, "design.json"), DesignSchema, design);
    const I = design.identity;
    mood = energeticMood(I.music, `${topic} ${opts.audience ?? ""}`);
    if (mood !== I.music) say(`  музыка: «${I.music}» → «${mood}» (под голос нужен бодрый ровный трек, не нарастающий эпик)`);
    say(`  айдентика: ${I.palette.bg}/${I.palette.accent}, ${I.display_font} + ${I.accent_font}, ${I.texture}${I.chrome === "header" ? ", шапка" : ""}`);
    for (const sc of design.scenes) say(`    ${sc.beat}: ${sc.layout} [${sc.anchor}, ${sc.transition}]${sc.image ? ` +фото «${sc.image.query}»` : ""} — ${sc.headline}`);

    // pictures: real photos (default) → generated fallback → typography
    const mode = imagesMode(opts.images);
    const imgDir = path.join(dir, "make", "images");
    const images: Record<number, string> = {};
    const wanted = design.scenes.filter((sc) => sc.image).map((sc) => ({ beat: sc.beat, query: sc.image!.query || sc.image!.prompt, prompt: sc.image!.prompt }));
    // reuse the pictures of an earlier job of the same frame (re-render after code/style changes)
    const reuseImgDir = reuseDir && oldAspect === aspect ? path.join(reuseDir, "make", "images") : null;
    const oldCredits: PhotoCredit[] = reuseDir && oldAspect === aspect ? await fs.readFile(path.join(reuseDir, "credits.json"), "utf8").then((t) => JSON.parse(t) as PhotoCredit[], () => []) : [];
    let todo = wanted;
    if (reuseImgDir) {
      todo = [];
      for (const w of wanted) {
        const old = path.join(reuseImgDir, `scene_${w.beat}.jpg`);
        const oldCredit = oldCredits.find((x) => x.beat === w.beat);
        if (oldCredit && creditRejected(oldCredit)) {
          say(`  фото ${w.beat}: «${oldCredit.title}» больше не проходит отбор (не фото, публичное лицо или не по запросу) — ищу заново`);
          todo.push(w);
          continue;
        }
        if (await exists(old)) {
          await fs.mkdir(imgDir, { recursive: true });
          await fs.copyFile(old, path.join(imgDir, `scene_${w.beat}.jpg`));
          images[w.beat] = path.join(imgDir, `scene_${w.beat}.jpg`);
          const c = oldCredits.find((x) => x.beat === w.beat);
          if (c) credits.push({ ...c, file: images[w.beat] });
          imagesUsed.push(c ? "photo" : "ai");
        } else todo.push(w);
      }
    }
    if (todo.length && mode === "photo") {
      say(`▸ фото (${todo.length}, Openverse: CC0 / PD / CC BY)…`);
      const hint = photoHint(wanted.map((w) => w.query));
      const r = await findPhotos(todo.map((w) => ({ beat: w.beat, query: w.query })), imgDir, { frame, topicHint: hint, onEvent: say, ...opts.photoOptions });
      for (const [beat, file] of r.files) images[beat] = file;
      credits.push(...r.credits);
      if (r.files.size) imagesUsed.push("photo");
      say(`  найдено ${r.files.size}/${todo.length}${r.missing.length ? `, без фото: ${r.missing.join(", ")}` : ""}`);
      todo = todo.filter((w) => r.missing.includes(w.beat));
    }
    if (todo.length && mode !== "none") {
      const imagesVia = opts.imageOptions?.generate || opts.imageOptions?.run ? "agy" : opts.imageOptions?.gemini?.key ? "gemini-image" : await imageBackend();
      if (imagesVia) {
        say(`▸ картинки (${todo.length}, ${imagesVia === "gemini-image" ? "Gemini API" : "Antigravity"}${mode === "photo" ? ": фото не нашлось" : ""})…`);
        try {
          const r = await generateImages(todo.map((w) => ({ beat: w.beat, prompt: w.prompt })), imgDir, { style: I.image_style, frame, ...opts.imageOptions });
          for (const [beat, file] of r.files) images[beat] = file;
          if (r.files.size) imagesUsed.push("ai");
          if (r.missing.length) warnings.push(`картинки не получены для битов ${r.missing.join(", ")} — там типографика`);
          await addCost(job.id, { step: "design", provider: r.provider === "gemini-image" ? "gemini-image" : "antigravity-cli", model: r.model, units: { ...r.usage, images: r.files.size, wall_seconds: r.wall_seconds, ...(r.provider === "gemini-image" ? {} : { subscription: 1 }) }, usd: r.usd });
          usd += r.usd;
          say(`  ${r.files.size}/${todo.length} за ${r.wall_seconds}s${r.usd ? `, ≈$${r.usd.toFixed(3)}` : ""}`);
        } catch (err) {
          warnings.push(`картинки не сгенерированы: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
          say(`  ⚠ ${warnings.at(-1)}`);
        }
      } else warnings.push(`нет картинок для битов ${todo.map((w) => w.beat).join(", ")} — там типографика`);
    } else if (todo.length) warnings.push("картинки выключены — медиа-кадры стали типографикой");
    credits.sort((a, b) => a.beat - b.beat);
    await fs.writeFile(path.join(dir, "credits.json"), JSON.stringify(credits, null, 1));

    // music before the composition: an energetic bed, started on a downbeat, scene cuts moved onto its beats
    say("▸ музыка…");
    track = await chooseMusic(want, mood, topicClean, scriptDuration(s.script) + 2, warnings);
    musicPicked = true;
    if (track) {
      try {
        const probe = await ffprobe(track.file);
        const trackSeconds = Number(probe.format.duration) || 0;
        const bed = await bedStart(track.file, trackSeconds, scriptDuration(s.script));
        musicOffset = bed.offset;
        musicBpm = bed.bpm;
        if (vo && bed.bpm) {
          const grid = await detectBeats(track.file, { offset: bed.offset, seconds: scriptDuration(s.script) + 3 });
          if (grid.strength >= 0.08 && grid.beats.length >= 4) {
            const snap = snapBeatsToMusic(s.script, speechSeconds(vo), grid.beats);
            cutsOnBeat = snap.snapped;
            vo = await layVoiceover(vo, snap.script);
            s = { ...s, script: vo.script };
            await writeJson(path.join(dir, "script.json"), ScriptSchema, s.script);
          }
        }
        say(`  «${track.title}»${track.creator ? ` — ${track.creator}` : ""}${bed.bpm ? `, ${bed.bpm} BPM, старт ${bed.offset.toFixed(1)} с` : ""}${vo ? `, склеек на долю: ${cutsOnBeat}/${s.script.beats.length - 1}` : ""}`);
      } catch (err) {
        warnings.push(`сетка битов музыки не посчитана: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }

    // the animated presenter (after Colab): a circle with alpha in the bottom corner, as long as the video
    let presenter: { file: string; box: PresenterBox } | undefined;
    if (opts.presenterVideo) {
      try {
        const box = presenterBox(frame);
        const src = await presenterSource(opts.presenterVideo, path.join(dir, "make", "presenter"));
        const file = path.join(dir, "make", "presenter", "presenter.webm");
        const { drift } = await presenterClip(src, scriptDuration(s.script), file, box.size);
        if (drift > 0.3) warnings.push(`ведущий ${drift.toFixed(2)} с не совпадает с длиной ролика — губы могут разойтись с голосом (озвучка должна быть той же, что ушла в Colab)`);
        presenter = { file, box };
        presenterVideo = path.resolve(opts.presenterVideo);
        say(`  ведущий: ${path.basename(opts.presenterVideo)} → круг ${box.size} px в нижнем углу`);
      } catch (err) {
        warnings.push(`ведущий не добавлен: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }

    say("▸ композиция…");
    const speech = vo ? speechByBeat(vo, s.script.beats.length) : undefined;
    composed = await runStep(job.id, "design", async () => {
      const c = await writeDirectorProject(s.script, design!, images, projectDir, { captions: vo && opts.voiceCaptions ? vo.captions : undefined, frame, speech, presenter });
      if (c.overflow.length) warnings.push(`текст не влез даже на минимальном размере: ${c.overflow.join(", ")}`);
      warnings.push(...(await lintProject(projectDir)));
      return c;
    });
  }

  // 4. render
  say("▸ рендер…");
  const rendered = path.join(dir, "make", "rendered.mp4");
  const tr = Date.now();
  await runStep(job.id, "render", async () => {
    if (opts.fakeRender) return opts.fakeRender(projectDir, rendered);
    const renderer = opts.renderer ?? new HyperFramesRenderer();
    await renderer.prepare();
    await renderer.render(projectDir, rendered, { quality: opts.quality ?? "looks", onLine: (l) => say(`    ${l}`), signal: opts.signal });
  });
  const renderSeconds = (Date.now() - tr) / 1000;

  // 5. soundtrack: music (file / mood / director's mood) + sound effects on the motion
  say("▸ звук…");
  const output = path.join(dir, "output_make.mp4");
  if (!musicPicked) track = await chooseMusic(want, mood, topicClean, composed.duration, warnings);
  const cues = opts.sfx === false ? [] : [...(composed.cues ?? []), ...(vo ? accentCues(s.script) : [])];
  const mixed = await mixSoundtrack({ video: rendered, out: output, duration: composed.duration, music: track?.file ?? null, musicOffset: musicOffset || undefined, speech: false, voice: vo?.track ?? null, sfx: cues });
  const voiceNote = vo ? `; голос ${vo.voice.id} поверх (музыка и эффекты приглушаются под речью)` : "";
  if (track) say(`  музыка: «${track.title}»${track.creator ? ` — ${track.creator}` : ""} (${track.license}, ${track.source}); эффектов ${mixed.cues}${voiceNote}`);
  else say(`  эффектов ${mixed.cues}${voiceNote}`);
  // contact sheet: a frame late in every scene (after the words are in), for a quick look (and for the bot)
  await contactSheet(rendered, path.join(projectDir, "layout.json"), path.join(dir, "make"), frame).catch(() => {});
  const preview = path.join(dir, "output_make_preview.jpg");
  await ffmpeg(["-ss", String(Math.min(1.2, composed.duration / 2)), "-i", output, "-frames:v", "1", "-q:v", "3", preview]).catch(() => {});
  const probe = await ffprobe(output);
  const duration = Number(probe.format.duration) || composed.duration;

  // the presenter bundle: the narration exactly as it sits on this video's timeline → Colab animates a face to it
  let presenterBundle: { jobId: string; bundle: string } | null = null;
  if (opts.presenter && !opts.presenterVideo) {
    if (!vo) warnings.push("ведущий нужен голос: --presenter работает вместе с --voice");
    else {
      say("▸ ведущий: задание для Colab…");
      try {
        const { exportAvatarJob, colabSteps } = await import("../avatar/export.ts");
        const r = await exportAvatarJob({ speech: vo.track, photo: typeof opts.presenter === "string" ? opts.presenter : undefined, language, mode: "avatar", sourceLabel: `make-presenter:${job.id}`, onEvent: (l) => say(`  ${l.trim()}`) });
        presenterBundle = { jobId: r.jobId, bundle: r.bundle };
        warnings.push(...r.warnings);
        say(`  ${r.bundle} (${(r.bytes / 1e6).toFixed(1)} МБ)`);
        for (const l of colabSteps(r.jobId, path.basename(r.bundle))) say(`    ${l}`);
        say(`    затем: vedit make "${topicClean}" --from ${job.id} --presenter-video avatar_result.zip${aspect !== "9:16" ? ` --aspect ${aspect}` : ""}`);
      } catch (err) {
        warnings.push(`задание для ведущего не собрано: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
  }

  const report = await writeJson(path.join(dir, "make.json"), MakeReportSchema, {
    topic: topicClean,
    language,
    title: s.script.title,
    duration,
    beats: s.script.beats.length,
    output,
    preview,
    trends: trendsStatus,
    music: track ? track.file : null,
    music_attribution: track?.attribution ?? "",
    sfx: mixed.cues,
    voice: vo ? vo.voice.id : null,
    voice_seconds: vo ? Math.round(vo.beats.reduce((n, b) => n + b.end - b.start, 0) * 10) / 10 : 0,
    aspect,
    width: frame.w,
    height: frame.h,
    images: [...new Set(imagesUsed)].join("+") || "none",
    photo_credits: credits.map((c) => photoCreditLine(c)),
    cliches_fixed: clichesFixed,
    presenter_bundle: presenterBundle?.bundle ?? null,
    presenter_job: presenterBundle?.jobId ?? null,
    presenter_video: presenterVideo,
    pacing_fixed: pacingFixed,
    hook_seconds: s.script.beats[0]?.seconds ?? 0,
    music_bpm: musicBpm,
    cuts_on_beat: cutsOnBeat,
    usd,
    wall_seconds: (Date.now() - t0) / 1000,
    render_seconds: renderSeconds,
    warnings,
  });
  return { ...report, jobId: job.id, script: s.script, trendsData };
}

/**
 * The music bed: a file, a mood, or the director's mood ("auto"); null for "none" or when nothing is reachable.
 * Mood picks are checked for a clear, quick enough beat (a narrator over a beatless ambient loop sounded flat).
 */
async function chooseMusic(want: string, mood: Mood, topic: string, minSeconds: number, warnings: string[]): Promise<MusicTrack | null> {
  if (want === "none") return null;
  if (want !== "auto" && !isMood(want)) {
    if (!(await exists(want))) throw new Error(`музыка не найдена: ${want} (файл, настроение ${["upbeat", "chill", "dramatic", "inspiring", "tech", "funky", "emotional"].join("/")}, auto или none)`);
    return { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" };
  }
  const m = want === "auto" ? mood : (want as Mood);
  const energetic = m !== "chill" && m !== "emotional";
  const track = await pickMusic(m, topic, {
    minSeconds,
    check: energetic
      ? async (file) => {
          const probe = await ffprobe(file);
          const bed = await bedStart(file, Number(probe.format.duration) || 0, minSeconds);
          return !!bed.bpm && bed.bpm >= 85 && bed.bpm <= 180 && bed.strength >= 0.12;
        }
      : undefined,
  });
  if (!track) warnings.push("музыка не найдена (нет assets/music и нет доступа к Openverse) — ролик без музыки");
  return track;
}

/**
 * Sound accents of a voiced make (stage 25): a riser into the pattern interrupt at the second scene and a hit on it,
 * a riser into the last scene (the payoff) and a hit on it. The mixer thins cues that pile up.
 */
export function accentCues(script: Script): SfxCue[] {
  const starts: number[] = [];
  let frame = 0;
  for (const b of script.beats) {
    starts.push(frame / FPS);
    frame += Math.max(1, Math.round(b.seconds * FPS));
  }
  const cues: SfxCue[] = [];
  const hitAt = (t: number) => {
    if (t >= 1.3) cues.push({ t: Math.round((t - 1.2) * 1000) / 1000, kind: "riser", gain: -6 });
    cues.push({ t, kind: "impact", gain: -4 });
  };
  if (starts.length > 1) hitAt(starts[1]);
  if (starts.length > 3) hitAt(starts.at(-1)!);
  return cues;
}

/** The most common keyword of the photo queries ("coffee"): appended to fallback searches. */
function photoHint(queries: string[]): string {
  const n = new Map<string, number>();
  for (const q of queries) for (const w of new Set(q.toLowerCase().split(/\s+/).filter((x) => x.length > 3))) n.set(w, (n.get(w) ?? 0) + 1);
  const best = [...n.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return best && best[1] >= 2 ? best[0] : "";
}

/** Slow cinematic build-ups fight a narrator: "dramatic" becomes "upbeat" unless the topic asks for drama. */
export function energeticMood(mood: Mood, topic: string): Mood {
  if (mood !== "dramatic") return mood;
  return /драм|эпич|трагед|катастроф|триллер|тревож|страшн|ужас|dramatic|epic|tragic|thriller/i.test(topic) ? mood : "upbeat";
}

/** Text that credits the pictures and the music (CC BY needs it): for the description under the video. */
export function creditsText(r: Pick<MakeReport, "photo_credits" | "music_attribution">): string {
  const lines: string[] = [];
  if (r.photo_credits.length) lines.push(`Фото (Openverse): ${r.photo_credits.join("; ")}`);
  if (r.music_attribution) lines.push(r.music_attribution);
  return lines.join("\n");
}

/** A tile of one frame per scene (late in the scene, when its text is in), sized for the frame's orientation. */
export async function contactSheet(video: string, layoutFile: string, outDir: string, frame: Frame) {
  const lay = JSON.parse(await fs.readFile(layoutFile, "utf8")) as { scenes?: { start: number; duration: number }[] };
  if (!lay.scenes?.length) return null;
  const sheetDir = path.join(outDir, "sheet");
  await fs.rm(sheetDir, { recursive: true, force: true });
  await fs.mkdir(sheetDir, { recursive: true });
  const [tw, th] = frame.w > frame.h ? [480, 270] : frame.w === frame.h ? [360, 360] : [270, 480];
  for (const [k, sc] of lay.scenes.entries()) {
    await ffmpeg(["-ss", (sc.start + Math.min(sc.duration * 0.8, sc.duration - 0.3)).toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${tw}:${th}`, path.join(sheetDir, `f${String(k).padStart(2, "0")}.png`)]);
  }
  const cols = Math.min(frame.w > frame.h ? 3 : 4, lay.scenes.length);
  const out = path.join(outDir, "sheet.jpg");
  await ffmpeg(["-framerate", "1", "-i", path.join(sheetDir, "f%02d.png"), "-vf", `tile=${cols}x${Math.ceil(lay.scenes.length / cols)}:padding=6:color=black`, "-frames:v", "1", "-q:v", "3", out]);
  return out;
}
