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

/**
 * MAKE: a topic → a vertical video built from nothing (text, icons, motion; music optional).
 *   trends (Antigravity web research, optional) → script (Claude) → HyperFrames composition → render → music mux
 * Everything lands in workspace/<job>/: trends.json, script.json, make/project/, output_make.mp4, make.json.
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
  /** music file (mp3/ogg/wav) looped under the video, −14 LUFS; none = silent video */
  music?: string;
  quality?: RenderQuality;
  style?: Partial<MakeStyle>;
  model?: string;
  llm?: StructuredFn;
  trendsOptions?: TrendsOptions;
  renderer?: HyperFramesRenderer;
  /** a saved script.json to render as is (no trends, no model call) */
  scriptFile?: string;
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

  // 3. composition + lint
  say("▸ композиция…");
  const projectDir = path.join(dir, "make", "project");
  const composed = await runStep(job.id, "design", async () => {
    const c = await writeMakeProject(s.script, projectDir, { kicker: topicClean.length <= 48 ? topicClean : s.script.title, style: opts.style });
    warnings.push(...(await lintProject(projectDir)));
    return c;
  });

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

  // 5. music (optional) → output
  const output = path.join(dir, "output_make.mp4");
  if (opts.music) {
    if (!(await exists(opts.music))) throw new Error(`музыка не найдена: ${opts.music}`);
    await muxMusic(rendered, path.resolve(opts.music), output, composed.duration);
  } else {
    await fs.copyFile(rendered, output);
    warnings.push("без звука: добавьте --music <файл> (бесплатные треки: pixabay.com/music, лицензия Pixabay)");
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
    music: opts.music ? path.resolve(opts.music) : null,
    usd: s.usd,
    wall_seconds: (Date.now() - t0) / 1000,
    render_seconds: renderSeconds,
    warnings,
  });
  return { ...report, jobId: job.id, script: s.script, trendsData };
}
