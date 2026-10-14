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
import { findAgy } from "../understand/vision/agy.ts";
import { loadFontMetrics } from "../design/layout.ts";
import { composeMake, type ComposeResult, type MakeStyle } from "./compose.ts";
import { loadIconSvg } from "./icons.ts";
import { ScriptSchema, scriptDuration, writeScript, type Script } from "./script.ts";
import { researchTrends, trendsText, TrendsSchema, type Trends, type TrendsOptions } from "./trends.ts";
import { DesignSchema, directDesign, fallbackDesign, type Design } from "./design.ts";
import { generateImages, type ImageOptions } from "./images.ts";
import { composeScenes, FPS, H, W, type ComposedScenes } from "./scenes.ts";
import { installFonts } from "./fonts.ts";
import { fitText } from "./fit.ts";
import { mixSoundtrack } from "../audio/mix.ts";
import { isMood, pickMusic, type Mood, type MusicTrack } from "../audio/music.ts";
import type { SfxCue } from "../audio/sfx.ts";
import { NO_VOICE } from "../voice/catalog.ts";
import type { SentenceSynth } from "../voice/piper.ts";
import { makeVoiceover, type CaptionCue, type VoiceoverResult } from "../voice/voiceover.ts";

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
  trends: z.enum(["agy", "skipped", "failed"]),
  music: z.string().nullable(),
  music_attribution: z.string().default(""),
  sfx: z.number().int().default(0),
  /** voiceover voice id (make --voice), null = no narration */
  voice: z.string().nullable().default(null),
  voice_seconds: z.number().default(0),
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
  /** generate images for media scenes (default: when agy is installed) */
  images?: boolean;
  imageOptions?: Partial<ImageOptions>;
  /** test hook: skip the real render and write this file as the output */
  fakeRender?: (projectDir: string, outFile: string) => Promise<void>;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
}

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
export async function writeDirectorProject(script: Script, design: Design, images: Record<number, string>, dir: string, o: { gsapFile?: string; captions?: CaptionCue[] } = {}): Promise<ComposedScenes & { entry: string; overflow: string[] }> {
  await fs.mkdir(path.join(dir, "assets", "img"), { recursive: true });
  await linkOrCopy(o.gsapFile ?? DEFAULT_GSAP, path.join(dir, "assets", "gsap.min.js"));
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
  let composed = composeScenes(script, design, { images: rel, fontFaces, gsapRel: "assets/gsap.min.js", captions: o.captions });
  await fs.writeFile(entry, composed.html);
  const fit = await fitText(entry);
  composed = composeScenes(script, design, { images: rel, fontFaces, gsapRel: "assets/gsap.min.js", sizes: fit.sizes, captions: o.captions });
  await fs.writeFile(entry, composed.html);
  const name = `make-${script.title.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}`;
  await fs.writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name, private: true, type: "module", scripts: { check: `npx --yes hyperframes@${HF_VERSION} check`, render: `npx --yes hyperframes@${HF_VERSION} render` } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: name, name, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "layout.json"), JSON.stringify({ frame: { width: W, height: H, fps: FPS, duration: composed.duration }, scenes: composed.timings, sizes: fit.sizes }, null, 1));
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
  const topicClean = topic.replace(/\s+/g, " ").trim();
  if (!topicClean) throw new Error("тема пустая");
  const language = opts.language ?? "ru";
  const warnings: string[] = [];
  const say = (l: string) => opts.onEvent?.(l);
  const job = await createJob(`make:${topicClean.slice(0, 80)}`, { prompt: topicClean });
  const dir = jobDir(job.id);
  say(`job ${job.id}`);

  // 1. trends
  let trendsData: Trends | null = null;
  let trendsStatus: MakeReport["trends"] = "skipped";
  const reuseDir = opts.fromJob ? jobDir(opts.fromJob) : null;
  if (reuseDir && !opts.scriptFile) opts = { ...opts, scriptFile: path.join(reuseDir, "script.json") };
  const wantTrends = !opts.scriptFile && (opts.trends ?? (!!opts.trendsOptions?.run || !!(await findAgy())));
  if (wantTrends) {
    say("▸ тренды (поиск в вебе через Antigravity)…");
    try {
      const r = await runStep(job.id, "understand", () => researchTrends(topicClean, { language, ...opts.trendsOptions }));
      trendsData = r.trends;
      trendsStatus = "agy";
      await writeJson(path.join(dir, "trends.json"), TrendsSchema, r.trends);
      await addCost(job.id, { step: "understand", provider: "antigravity-cli", model: r.model, units: { ...r.usage, wall_seconds: r.wall_seconds, subscription: 1 }, usd: 0 });
      say(`  фактов ${r.trends.facts.length}, углов ${r.trends.angles.length}, хуков ${r.trends.hooks.length} (${r.wall_seconds}s)`);
    } catch (err) {
      trendsStatus = "failed";
      warnings.push(`тренды не собраны: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      say(`  ⚠ ${warnings.at(-1)}`);
    }
  }

  // 2. script (or a saved one)
  say("▸ сценарий…");
  let s: { script: Script; usd: number; provider: string; model: string; usage: { input_tokens: number; output_tokens: number }; estimate: boolean };
  if (opts.scriptFile) {
    const script = await readJson(path.resolve(opts.scriptFile), ScriptSchema);
    s = { script, usd: 0, provider: "file", model: "saved", usage: { input_tokens: 0, output_tokens: 0 }, estimate: false };
    await runStep(job.id, "plan", async () => script);
  } else {
    const llm = opts.llm ?? selectStructuredLlm();
    s = await runStep(job.id, "plan", () => writeScript(topicClean, llm, { language, seconds: opts.seconds, audience: opts.audience, trendsText: trendsData ? trendsText(trendsData) : undefined, model: opts.model }));
    await addCost(job.id, { step: "plan", provider: s.provider === "anthropic" ? "anthropic" : s.provider, model: s.model, units: { ...s.usage, calls: 1, estimate: s.estimate ? 1 : 0 }, usd: s.usd });
  }
  await writeJson(path.join(dir, "script.json"), ScriptSchema, s.script);
  say(`  «${s.script.title}», ${s.script.beats.length} битов, ${scriptDuration(s.script)}s${s.usd ? `, ≈$${s.usd.toFixed(3)}` : ""}`);
  for (const b of s.script.beats) say(`    · ${b.text}  [${b.icon}, ${b.seconds}s]`);

  // 2b. voiceover: synthesise every beat's spoken line, stretch the beats to the speech
  let vo: VoiceoverResult | null = null;
  const wantVoice = opts.voice?.trim();
  if (wantVoice && !NO_VOICE.test(wantVoice)) {
    say(`▸ озвучка (${wantVoice}, Piper локально)…`);
    vo = await runStep(job.id, "design", () => makeVoiceover(s.script, wantVoice, path.join(dir, "make", "voice"), { lengthScale: opts.voiceLengthScale, synth: opts.voiceSynth, onEvent: (l) => say(`  ${l.trim()}`) }));
    warnings.push(...vo.warnings);
    s = { ...s, script: vo.script };
    await writeJson(path.join(dir, "script.json"), ScriptSchema, s.script);
    await addCost(job.id, { step: "design", provider: "piper (local)", model: vo.voice.piper?.key ?? vo.voice.id, units: { voice_seconds: vo.duration, beats: vo.beats.length }, usd: 0 });
    say(`  голос ${vo.voice.id} (${vo.voice.license}): ${vo.beats.map((b) => (b.end - b.start).toFixed(1)).join(" + ")} с речи → ролик ${scriptDuration(s.script).toFixed(1)} с`);
  }

  // 3. art director → images → composition (fit in Chrome) → lint
  const projectDir = path.join(dir, "make", "project");
  let usd = s.usd;
  let composed: { duration: number; cues?: SfxCue[] };
  let mood: Mood = "upbeat";
  if (opts.director === false) {
    say("▸ композиция (простая)…");
    composed = await runStep(job.id, "design", async () => {
      const c = await writeMakeProject(s.script, projectDir, { kicker: topicClean.length <= 48 ? topicClean : s.script.title, style: opts.style });
      if (vo && opts.voiceCaptions) warnings.push("субтитры озвучки есть только в композиции арт-директора (без --no-director)");
      warnings.push(...(await lintProject(projectDir)));
      return c;
    });
  } else {
    say("▸ арт-директор…");
    let design: Design;
    const savedDesign = reuseDir ? path.join(reuseDir, "design.json") : null;
    if (savedDesign && (await exists(savedDesign))) {
      design = await readJson(savedDesign, DesignSchema);
    } else {
      try {
        const llm = opts.llm ?? selectStructuredLlm();
        const d = await directDesign(topicClean, s.script, llm, { model: opts.model });
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
    mood = I.music;
    say(`  айдентика: ${I.palette.bg}/${I.palette.accent}, ${I.display_font} + ${I.accent_font}, ${I.texture}; «${I.image_style}»`);
    for (const sc of design.scenes) say(`    ${sc.beat}: ${sc.layout}${sc.image ? " +img" : ""} — ${sc.headline}`);

    // images
    const imgDir = path.join(dir, "make", "images");
    const images: Record<number, string> = {};
    const wanted = design.scenes.filter((sc) => sc.image).map((sc) => ({ beat: sc.beat, prompt: sc.image!.prompt }));
    const reuseImgDir = reuseDir ? path.join(reuseDir, "make", "images") : null;
    const toGenerate: typeof wanted = [];
    for (const w of wanted) {
      const old = reuseImgDir ? path.join(reuseImgDir, `scene_${w.beat}.jpg`) : null;
      if (old && (await exists(old))) {
        await fs.mkdir(imgDir, { recursive: true });
        await fs.copyFile(old, path.join(imgDir, `scene_${w.beat}.jpg`));
        images[w.beat] = path.join(imgDir, `scene_${w.beat}.jpg`);
      } else toGenerate.push(w);
    }
    const wantImages = opts.images ?? (!!opts.imageOptions?.generate || !!opts.imageOptions?.run || !!(await findAgy()));
    if (toGenerate.length && wantImages) {
      say(`▸ картинки (${toGenerate.length}, Antigravity)…`);
      try {
        const r = await generateImages(toGenerate, imgDir, { style: I.image_style, ...opts.imageOptions });
        for (const [beat, file] of r.files) images[beat] = file;
        if (r.missing.length) warnings.push(`картинки не получены для битов ${r.missing.join(", ")} — там типографика`);
        await addCost(job.id, { step: "design", provider: "antigravity-cli", model: r.model, units: { ...r.usage, images: r.files.size, wall_seconds: r.wall_seconds, subscription: 1 }, usd: 0 });
        say(`  ${r.files.size}/${toGenerate.length} за ${r.wall_seconds}s`);
      } catch (err) {
        warnings.push(`картинки не сгенерированы: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
        say(`  ⚠ ${warnings.at(-1)}`);
      }
    } else if (toGenerate.length) warnings.push("картинки выключены — медиа-кадры стали типографикой");

    say("▸ композиция…");
    composed = await runStep(job.id, "design", async () => {
      const c = await writeDirectorProject(s.script, design, images, projectDir, { captions: vo && opts.voiceCaptions ? vo.captions : undefined });
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
  const want = (opts.music ?? "auto").trim();
  let track: MusicTrack | null = null;
  if (want !== "none") {
    if (want !== "auto" && !isMood(want)) {
      if (!(await exists(want))) throw new Error(`музыка не найдена: ${want} (файл, настроение ${["upbeat", "chill", "dramatic", "inspiring", "tech", "funky", "emotional"].join("/")}, auto или none)`);
      track = { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" };
    } else {
      track = await pickMusic(want === "auto" ? mood : (want as Mood), topicClean, { minSeconds: composed.duration });
      if (!track) warnings.push("музыка не найдена (нет assets/music и нет доступа к Openverse) — ролик без музыки");
    }
  }
  const cues = opts.sfx === false ? [] : (composed.cues ?? []);
  const mixed = await mixSoundtrack({ video: rendered, out: output, duration: composed.duration, music: track?.file ?? null, speech: false, voice: vo?.track ?? null, sfx: cues });
  const voiceNote = vo ? `; голос ${vo.voice.id} поверх (музыка и эффекты приглушаются под речью)` : "";
  if (track) say(`  музыка: «${track.title}»${track.creator ? ` — ${track.creator}` : ""} (${track.license}, ${track.source}); эффектов ${mixed.cues}${voiceNote}`);
  else say(`  эффектов ${mixed.cues}${voiceNote}`);
  // contact sheet: the middle of every scene, for a quick look (and for the bot)
  const timingsFile = path.join(projectDir, "layout.json");
  try {
    const lay = JSON.parse(await fs.readFile(timingsFile, "utf8")) as { scenes?: { start: number; duration: number }[] };
    if (lay.scenes?.length) {
      const sheetDir = path.join(dir, "make", "sheet");
      await fs.mkdir(sheetDir, { recursive: true });
      for (const [k, sc] of lay.scenes.entries()) {
        await ffmpeg(["-ss", (sc.start + Math.min(sc.duration * 0.7, sc.duration - 0.3)).toFixed(3), "-i", rendered, "-frames:v", "1", "-vf", "scale=270:480", path.join(sheetDir, `f${String(k).padStart(2, "0")}.png`)]);
      }
      const cols = Math.min(4, lay.scenes.length);
      await ffmpeg(["-framerate", "1", "-i", path.join(sheetDir, "f%02d.png"), "-vf", `tile=${cols}x${Math.ceil(lay.scenes.length / cols)}:padding=6:color=black`, "-frames:v", "1", "-q:v", "3", path.join(dir, "make", "sheet.jpg")]);
    }
  } catch {
    /* the sheet is a convenience */
  }
  const preview = path.join(dir, "output_make_preview.jpg");
  await ffmpeg(["-ss", String(Math.min(1.2, composed.duration / 2)), "-i", output, "-frames:v", "1", "-q:v", "3", preview]).catch(() => {});
  const probe = await ffprobe(output);
  const duration = Number(probe.format.duration) || composed.duration;

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
    usd,
    wall_seconds: (Date.now() - t0) / 1000,
    render_seconds: renderSeconds,
    warnings,
  });
  return { ...report, jobId: job.id, script: s.script, trendsData };
}
