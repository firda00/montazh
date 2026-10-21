import fs from "node:fs/promises";
import path from "node:path";
import { addCost } from "../../lib/cost.ts";
import { ffmpeg, ffprobe } from "../../lib/ffmpeg.ts";
import { selectStructuredLlm, type StructuredFn } from "../../lib/llm.ts";
import { createJob, jobDir, WORKSPACE_ROOT } from "../../lib/workspace.ts";
import { DEFAULT_GSAP, HF_VERSION, ROOT, linkOrCopy } from "../../design/hyperframes/project.ts";
import { HyperFramesRenderer } from "../../render/hyperframes.ts";
import { loadPreset } from "../../plan/presets.ts";
import { PresetSchema } from "../../schemas/index.ts";
import { domainOf } from "../../design/site-capture.ts";
import { hookPlateLines, type Pane } from "../../design/abror.ts";
import { frameFor } from "../../lib/aspect.ts";
import { mixSoundtrack } from "../../audio/mix.ts";
import { pickMusic, isMood, type MusicTrack } from "../../audio/music.ts";
import { geminiApiKey, geminiTts } from "../../voice/gemini.ts";
import { wavBytes } from "../../voice/piper.ts";
import { shotSheet } from "../sheet.ts";
import { researchTrends, trendsBackend, type Trends } from "../trends.ts";
import { freshVentureNews, isCentralAsia, pickDemoTopics, type RankedItem } from "./venture.ts";
import { descriptionText, lineTimes, shotListText, teleprompterText, writeAbrorScript, AbrorScriptSchema, type AbrorScript, type AbrorSource, type ScriptIssue } from "./script.ts";
import { cleanArticleText, resolveLinePanes } from "./visuals.ts";
import { composeFaceless, type CaptionWord, type Segment } from "./compose.ts";

/**
 * `vedit make "<topic>" --preset abror_split|abror_full [--teleprompter] [--faceless]` (stage 33):
 *   fresh venture news (the venchur-radari feeds and ranking, src/make/abror/venture.ts) + web research (agy / Gemini
 *   Search) → the Uzbek script in Abror's template (validated, numbers checked against the sources) →
 *   teleprompter.txt + shots.txt + description.txt (he records a selfie; the montage path edits it in abror_split) or,
 *   with --faceless, a demo reel without a person: full-frame inserts + Uzbek karaoke captions + the hook plate +
 *   music (+ a Gemini TTS voice when VEDIT_ABROR_VOICE / --voice allows; "none" = text only).
 * Hard rules: no synthesis of his face or voice, no reuse of his footage, no AI images of real people.
 */

export interface AbrorMakeOptions {
  preset?: string;
  /** script + teleprompter + shot list only (no render) */
  teleprompter?: boolean;
  /** render the faceless demo */
  faceless?: boolean;
  seconds?: number;
  keyword?: string;
  promise?: string;
  /** Gemini prebuilt voice for the faceless demo («Puck», «Charon», gemini_puck…) or "none" */
  voice?: string;
  music?: string;
  /** use these sources instead of the news feeds */
  sources?: AbrorSource[];
  /** web research on top of the news item (default: when a backend is available) */
  research?: boolean;
  /** reuse the script of an earlier abror job (re-render) */
  fromJob?: string;
  /** copy the results to workspace/<outName>.mp4 / _script.txt / _sheet.jpg / _description.txt */
  outName?: string;
  llm?: StructuredFn;
  model?: string;
  workers?: number;
  onEvent?: (l: string) => void;
  fakeRender?: (projectDir: string, out: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface AbrorMakeResult {
  jobId: string;
  script: AbrorScript;
  issues: ScriptIssue[];
  teleprompter: string;
  shots: string;
  description: string;
  files: Record<string, string>;
  output: string | null;
  duration: number;
  voice: string | null;
  usd: number;
  warnings: string[];
}

const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 2));

/** Which news item a topic asks for: «auto» / an AI round / Central Asia, or the best word overlap with the topic. */
export function pickNewsItem(topic: string, ranked: RankedItem[]): RankedItem | null {
  const t = topic.toLowerCase();
  const demo = pickDemoTopics(ranked);
  if (/^(auto|avto|fresh|yangi|свеж)/i.test(t) || /\b(ai round|ai raund|ai startap)/i.test(t)) return demo.aiRound;
  if (/markaziy osiyo|central asia|o[ʻ'‘’]?zbekiston|uzbekistan|узбекистан|центральн/i.test(t) && !ranked.some((r) => overlap(t, r) >= 0.34)) return demo.centralAsia;
  let best: RankedItem | null = null;
  let score = 0.2;
  for (const r of ranked) {
    const s = overlap(t, r);
    if (s > score) {
      score = s;
      best = r;
    }
  }
  return best;
}
function overlap(topic: string, r: RankedItem): number {
  const a = tokens(topic);
  const b = tokens(`${r.title} ${r.summary.slice(0, 300)}`);
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return a.size ? n / a.size : 0;
}

export const newsToSource = (r: RankedItem): AbrorSource => ({ title: r.title, url: r.url, publisher: r.source, date: r.published ?? "", text: cleanArticleText(r.summary), ...(r.image ? { image: r.image } : {}) });

/** Research facts → extra sources (one per URL) + the FACTS block. */
export function factsAsSources(t: Trends): { sources: AbrorSource[]; text: string } {
  const byUrl = new Map<string, string[]>();
  for (const f of t.facts) {
    const u = f.source.trim();
    if (!/^https?:\/\//.test(u)) continue;
    byUrl.set(u, [...(byUrl.get(u) ?? []), f.text]);
  }
  const sources = [...byUrl].slice(0, 5).map(([url, facts]) => ({ title: facts[0].slice(0, 120), url, publisher: domainOf(url), date: "", text: facts.join(" ") }));
  const text = t.facts.slice(0, 10).map((f) => `- ${f.text}${f.source ? ` [${f.source}]` : ""}`).join("\n");
  return { sources, text };
}

/** «Puck» / «gemini_puck» / «charon» → the prebuilt Gemini voice name, or null for none. */
export function geminiVoiceName(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s || /^(none|off|no)$/i.test(s)) return null;
  const n = s.replace(/^gemini_/i, "");
  return n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
}

export const UZ_TTS_STYLE = "an energetic young Uzbek tech-news host from Tashkent speaking natural colloquial Uzbek (not Turkish, not Kazakh); fast, confident, friendly; brand names in English";

/** Word times inside a spoken line: proportional to the letters of each word (a small lead-in and tail). */
export function wordTimes(text: string, start: number, dur: number): CaptionWord[] {
  const w = text.split(/\s+/).filter(Boolean);
  const weight = w.map((x) => x.replace(/[^\p{L}\p{N}]/gu, "").length + 1.5);
  const total = weight.reduce((a, b) => a + b, 0) || 1;
  const a = start + Math.min(0.08, dur * 0.03);
  const span = Math.max(0.1, dur * 0.95 - (a - start));
  let t = a;
  return w.map((x, i) => {
    const d = (span * weight[i]) / total;
    const out = { text: x, start: Math.round(t * 1000) / 1000, end: Math.round((t + d) * 1000) / 1000 };
    t += d;
    return out;
  });
}

/** Line windows on the reel's timeline from the spoken lengths: short gaps inside a block, longer between blocks. */
export function layLines(script: Pick<AbrorScript, "lines">, seconds: number[], lead = 0.15): { start: number; end: number }[] {
  let t = lead;
  return script.lines.map((l, i) => {
    if (i > 0) t += script.lines[i - 1].part === l.part ? 0.18 : 0.32;
    const r = { start: Math.round(t * 1000) / 1000, end: Math.round((t + seconds[i]) * 1000) / 1000 };
    t += seconds[i];
    return r;
  });
}

/**
 * Pictures over time: the line's pane from its start; a long line whose visual carries a number gets a number card when
 * that number is said (his top panel changes every 1.9–3.2 s on the noun being said). A line without a pane keeps the
 * previous picture; the CTA line is a dark backdrop for the comment-word card.
 */
export function planSegments(script: AbrorScript, windows: { start: number; end: number }[], words: CaptionWord[][], panes: (Pane | null)[], duration: number): Segment[] {
  const segs: Segment[] = [];
  script.lines.forEach((l, i) => {
    const w = windows[i];
    const end = i + 1 < windows.length ? windows[i + 1].start : duration;
    if (l.part === "cta") {
      segs.push({ start: w.start, end, pane: null, label: "cta" });
      return;
    }
    const pane = panes[i];
    if (!pane) {
      if (segs.length) segs[segs.length - 1].end = end;
      else segs.push({ start: 0, end, pane: null, label: "—" });
      return;
    }
    const v = l.visual;
    const numWord = words[i].find((x) => /\d/.test(x.text));
    const split = v.value && pane.kind !== "number" && end - w.start >= 3.6 && numWord ? Math.min(end - 1.3, Math.max(w.start + 1.3, numWord.start - 0.08)) : null;
    const label = `${pane.kind}${v.subject ? ` ${v.subject}` : ""}`;
    if (split) {
      segs.push({ start: w.start, end: split, pane, label });
      segs.push({ start: split, end, pane: { kind: "number", value: v.value, label: v.label || "" }, label: `number ${v.value}` });
    } else segs.push({ start: w.start, end, pane, label });
  });
  if (segs.length) segs[0].start = 0;
  // no gaps, no overlaps
  for (let k = 1; k < segs.length; k++) segs[k].start = segs[k - 1].end;
  if (segs.length) segs[segs.length - 1].end = duration;
  return segs.filter((s) => s.end - s.start > 0.05);
}

export async function makeAbror(topic: string, o: AbrorMakeOptions = {}): Promise<AbrorMakeResult> {
  const say = (l: string) => o.onEvent?.(l);
  const warnings: string[] = [];
  const presetName = o.preset ?? (o.faceless ? "abror_full" : "abror_split");
  const preset = PresetSchema.parse((await loadPreset(presetName)).preset);
  const seconds = o.seconds ?? 60;
  const keyword = (o.keyword ?? process.env.VEDIT_ABROR_KEYWORD ?? "MAN").trim();
  const job = await createJob(`abror:${topic.slice(0, 80)}`, { prompt: topic, preset: presetName });
  const dir = jobDir(job.id);
  say(`job ${job.id} · пресет ${presetName}`);
  let usd = 0;

  // 1. sources: the chosen news item (+ the same story in other outlets) and web research
  let script: AbrorScript;
  let issues: ScriptIssue[] = [];
  if (o.fromJob) {
    script = AbrorScriptSchema.parse(JSON.parse(await fs.readFile(path.join(jobDir(o.fromJob), "abror_script.json"), "utf8")));
    say(`  сценарий из ${o.fromJob}`);
  } else {
    let sources: AbrorSource[] = o.sources ?? [];
    let topicFull = topic;
    if (!sources.length) {
      say("▸ свежие венчурные новости (ленты venchur-radari)…");
      const news = await freshVentureNews({ windowHours: 96, onLog: (l) => say(`  ${l}`) });
      const item = pickNewsItem(topic, news.ranked);
      if (item) {
        sources = [newsToSource(item), ...item.alsoIn.slice(0, 2).map((a) => news.ranked.find((r) => r.url === a.url)).filter((r): r is RankedItem => !!r).map(newsToSource)];
        topicFull = item.title;
        say(`  новость: «${item.title}» (${item.source}, ${item.published?.slice(0, 10) ?? "?"})${isCentralAsia(item) ? " · Центральная Азия" : ""}`);
      } else warnings.push(`в свежих новостях нет темы «${topic}» — сценарий только по веб-исследованию`);
    }
    let factsText = "";
    const via = o.research === false ? null : await trendsBackend();
    if (via) {
      say(`▸ проверка фактов в вебе (${via === "agy" ? "Antigravity" : "Gemini + Google Search"})…`);
      try {
        const r = await researchTrends(`${topicFull} — exact figures (amount, valuation, investors, dates), company background, founders`, { language: "en" });
        const f = factsAsSources(r.trends);
        sources = [...sources, ...f.sources];
        factsText = f.text;
        usd += r.usd ?? 0;
        say(`  фактов ${r.trends.facts.length}, источников ${f.sources.length} (${r.wall_seconds} с)`);
      } catch (err) {
        warnings.push(`веб-проверка не удалась: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
    if (!sources.length) throw new Error(`нет источников по теме «${topic}»: ни новости, ни веб-исследования — сценарий без фактов писать нельзя`);

    // 2. the script
    say("▸ сценарий (узбекский, шаблон Аброра)…");
    const llm = o.llm ?? selectStructuredLlm(process.env, "script");
    const w = await writeAbrorScript(topicFull, sources, llm, { seconds, keyword, promise: o.promise, factsText, model: o.model });
    script = w.script;
    issues = w.issues;
    usd += w.usd;
    await addCost(job.id, { step: "plan", provider: w.provider === "anthropic" ? "anthropic" : w.provider, model: w.model, units: { calls: w.calls }, usd: w.usd });
    say(`  «${script.title}», ${script.lines.length} строк, проверок не прошло: черновик ${w.firstIssues.length} → ${w.issues.length}${w.unverified.length ? `; числа без источника: ${w.unverified.map((u) => u.raw).join(", ")}` : ""}`);
    for (const x of w.issues) warnings.push(`сценарий: ${x.rule} — ${x.message}`);
  }
  await fs.writeFile(path.join(dir, "abror_script.json"), JSON.stringify(script, null, 1));
  const fullFrom = preset.design.split.full_from < 1 ? preset.design.split.full_from : 0.75;
  const teleprompter = teleprompterText(script, { fullFrom });
  const shots = shotListText(script, { fullFrom });
  const files: Record<string, string> = { script: path.join(dir, "abror_script.json"), teleprompter: path.join(dir, "teleprompter.txt"), shots: path.join(dir, "shots.txt") };
  await fs.writeFile(files.teleprompter, teleprompter + "\n");
  await fs.writeFile(files.shots, shots + "\n");
  for (const l of teleprompter.split("\n")) say(`  ${l}`);

  let output: string | null = null;
  let duration = lineTimes(script).at(-1)?.end ?? 0;
  let voiceName: string | null = null;
  const credits: string[] = [];
  if (o.faceless && !o.teleprompter) {
    const frame = frameFor("9:16");
    // the faceless reel is format B without the head: the abror_full look whatever preset named the script
    const design = (await loadPreset("abror_full")).preset.design;
    // 3. pictures
    say("▸ картинки (статья, сайт, знак, число — только настоящие материалы)…");
    const pr = await resolveLinePanes(script, { dir: path.join(dir, "abror", "media"), onLog: (l) => say(`  ${l}`) });
    credits.push(...pr.credits);
    warnings.push(...pr.notes);

    // 4. voice (Gemini TTS, line by line) or reading pace for a text-only demo
    voiceName = geminiVoiceName(o.voice ?? process.env.VEDIT_ABROR_VOICE ?? "Puck");
    if (voiceName && !geminiApiKey()) {
      warnings.push("нет GEMINI_API_KEY — демо без голоса (только текст и музыка)");
      voiceName = null;
    }
    const clips: (Int16Array | null)[] = [];
    let rate = 24000;
    const secs: number[] = [];
    if (voiceName) {
      say(`▸ голос: Gemini TTS «${voiceName}» по строкам…`);
      for (const l of script.lines) {
        const a = await geminiTts(l.text, voiceName, { style: UZ_TTS_STYLE, onEvent: (x) => say(x) });
        rate = a.rate;
        clips.push(a.pcm);
        secs.push(Math.round((a.pcm.length / a.rate) * 1000) / 1000);
      }
      say(`  ${secs.map((s) => s.toFixed(1)).join(" + ")} с речи`);
    } else for (const l of script.lines) secs.push(Math.max(1.6, l.text.split(/\s+/).length / 2.3 + 0.4));
    const windows = layLines(script, secs);
    duration = Math.round((windows.at(-1)!.end + 1.4) * 1000) / 1000;
    const lineWords = script.lines.map((l, i) => wordTimes(l.text, windows[i].start, windows[i].end - windows[i].start));
    let voiceWav: string | null = null;
    if (voiceName) {
      const total = new Int16Array(Math.ceil(duration * rate));
      clips.forEach((c, i) => c && total.set(c.subarray(0, Math.min(c.length, total.length - Math.round(windows[i].start * rate))), Math.round(windows[i].start * rate)));
      voiceWav = path.join(dir, "abror", "voice.wav");
      await fs.mkdir(path.dirname(voiceWav), { recursive: true });
      await fs.writeFile(voiceWav, wavBytes(total, rate));
    }

    // 5. composition
    const segments = planSegments(script, windows, lineWords, pr.panes, duration);
    const projectDir = path.join(dir, "abror", "project");
    await fs.mkdir(path.join(projectDir, "assets", "fonts"), { recursive: true });
    await linkOrCopy(path.join(ROOT, "assets", "fonts", "Montserrat-Variable.ttf"), path.join(projectDir, "assets", "fonts", "Montserrat-Variable.ttf"));
    await linkOrCopy(path.join(ROOT, "assets", "fonts", "OFL-Montserrat.txt"), path.join(projectDir, "assets", "fonts", "OFL-Montserrat.txt")).catch(() => {});
    await linkOrCopy(DEFAULT_GSAP, path.join(projectDir, "assets", "gsap.min.js"));
    const rel: Record<string, string> = {};
    for (const s of segments) {
      const p = s.pane;
      const f = p && "image" in p ? p.image : undefined;
      if (f && !rel[f]) {
        rel[f] = `assets/img/${path.basename(f)}`;
        await linkOrCopy(f, path.join(projectDir, rel[f]));
      }
    }
    const ctaLine = script.lines.findIndex((l) => l.part === "cta");
    const out = composeFaceless({
      W: frame.w,
      H: frame.h,
      fps: 30,
      duration,
      design,
      segments,
      words: lineWords.flat(),
      hookLines: hookPlateLines(script.hook_title.length === 2 ? script.hook_title.join(" / ") : script.hook_title.join(" "), design.hook_plate.max_words),
      cta: script.cta.keyword && ctaLine >= 0 ? { kind: "keyword", value: script.cta.keyword, label: "soʻzini yozib qoldiring", start: windows[ctaLine].start } : null,
      rel: (f) => rel[f] ?? f,
      fontFamily: "Montserrat",
      fontRel: "assets/fonts/Montserrat-Variable.ttf",
      gsapRel: "assets/gsap.min.js",
      badge: voiceName ? "AI ovoz · demo" : "demo",
      id: job.id,
    });
    await fs.writeFile(path.join(projectDir, "index.html"), out.html);
    await fs.writeFile(path.join(projectDir, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
    await fs.writeFile(path.join(projectDir, "package.json"), JSON.stringify({ name: `abror-${job.id}`, private: true, type: "module", scripts: { check: `npx --yes hyperframes@${HF_VERSION} check`, render: `npx --yes hyperframes@${HF_VERSION} render` } }, null, 2) + "\n");
    await fs.writeFile(path.join(projectDir, "meta.json"), JSON.stringify({ id: `abror-${job.id}`, name: `abror-${job.id}`, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
    await fs.writeFile(path.join(projectDir, "layout.json"), JSON.stringify({ frame: { width: frame.w, height: frame.h, fps: 30, duration }, segments, pages: out.pages.length }, null, 1));
    const { lintProject } = await import("../index.ts");
    warnings.push(...(await lintProject(projectDir)));
    say(`  кадров ${segments.length} (средний ${(duration / Math.max(1, segments.length)).toFixed(1)} с), страниц субтитров ${out.pages.length}, плашка 0–${out.plate.end.toFixed(1)} с`);

    // 6. render (one worker: the machine is shared) → sound
    say("▸ рендер…");
    const rendered = path.join(dir, "abror", "rendered.mp4");
    if (o.fakeRender) await o.fakeRender(projectDir, rendered);
    else {
      const r = new HyperFramesRenderer({ workers: o.workers ?? 1 });
      await r.prepare();
      await r.render(projectDir, rendered, { quality: "looks", onLine: (l) => say(`    ${l}`), signal: o.signal });
    }
    say("▸ звук…");
    let track: MusicTrack | null = null;
    const want = (o.music ?? "tech").trim();
    if (want !== "none") {
      try {
        track = isMood(want) ? await pickMusic(want, topic, { minSeconds: duration + 2 }) : { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" };
      } catch (err) {
        warnings.push(`музыка не найдена: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      }
    }
    output = path.join(dir, "output_abror.mp4");
    await mixSoundtrack({ video: rendered, out: output, duration, music: track?.file ?? null, speech: false, voice: voiceWav, sfx: out.cues });
    if (track?.attribution) credits.push(`Musiqa: ${track.attribution}`);
    else if (track) credits.push(`Musiqa: «${track.title}»${track.creator ? ` — ${track.creator}` : ""} (${track.license}, ${track.source})`);
    if (voiceName) credits.push(`Ovoz: sunʼiy (Google Gemini TTS, «${voiceName}») — Abror Bakhtiyarovichning ovozi emas`);
    files.output = output;
    // a frame per picture, the words said under it
    files.sheet = path.join(dir, "abror", "sheet.jpg");
    await shotSheet(rendered, segments.map((s) => ({ start: s.start, end: s.end, label: s.label })), lineWords.flat().map((w) => ({ text: w.text, start: w.start })), files.sheet, frame).catch((err) => {
      warnings.push(`лист кадров не собран: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
      delete files.sheet;
    });
    const probe = await ffprobe(output);
    duration = Number(probe.format.duration) || duration;
    await ffmpeg(["-ss", "1.5", "-i", output, "-frames:v", "1", "-q:v", "3", path.join(dir, "output_abror_preview.jpg")]).catch(() => {});
  }

  const description = descriptionText(script, credits);
  files.description = path.join(dir, "description.txt");
  await fs.writeFile(files.description, description + "\n");
  if (o.outName) {
    const base = path.join(WORKSPACE_ROOT, o.outName);
    await fs.writeFile(`${base}_script.txt`, `${teleprompter}\n\n${"=".repeat(60)}\n\n${shots}\n`);
    await fs.writeFile(`${base}_description.txt`, description + "\n");
    if (output) await fs.copyFile(output, `${base}.mp4`);
    if (files.sheet) await fs.copyFile(files.sheet, `${base}_sheet.jpg`).catch(() => {});
  }
  await fs.writeFile(path.join(dir, "abror.json"), JSON.stringify({ topic, preset: presetName, title: script.title, lines: script.lines.length, issues, output, duration, voice: voiceName, usd, warnings, files }, null, 1));
  return { jobId: job.id, script, issues, teleprompter, shots, description, files, output, duration, voice: voiceName, usd, warnings };
}
