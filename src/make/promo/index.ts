import fs from "node:fs/promises";
import path from "node:path";
import { addCost } from "../../lib/cost.ts";
import { ffmpeg, ffprobe } from "../../lib/ffmpeg.ts";
import { selectStructuredLlm, type StructuredFn } from "../../lib/llm.ts";
import { createJob, exists, jobDir, readJson, runStep, writeJson, WORKSPACE_ROOT } from "../../lib/workspace.ts";
import { DEFAULT_GSAP, linkOrCopy } from "../../design/hyperframes/project.ts";
import { HyperFramesRenderer } from "../../render/hyperframes.ts";
import type { RenderQuality } from "../../design/renderer.ts";
import { detectAspect, frameFor, stripAspectWords, type Aspect, type Frame } from "../../lib/aspect.ts";
import { installFonts } from "../fonts.ts";
import { fitText } from "../fit.ts";
import { loadIconSvg } from "../icons.ts";
import { brandMark, brandCreditLine } from "../brandmarks.ts";
import { mixSoundtrack } from "../../audio/mix.ts";
import { MUSIC_LIBRARY, pickMusic, type MusicTrack } from "../../audio/music.ts";
import { bedStart, detectBeats } from "../../audio/beats.ts";
import { NO_VOICE } from "../../voice/catalog.ts";
import type { SentenceSynth } from "../../voice/piper.ts";
import { layVoiceover, makeVoiceover, ttsUsd, type VoiceoverResult } from "../../voice/voiceover.ts";
import { ScriptSchema, type Script } from "../script.ts";
import { describeFindings } from "../slop.ts";
import { composePromo, iconsNeeded, planPromo, snapScenesToBeats, timeScenes, type PromoScene } from "./compose.ts";
import { disclaimer, fallbackPromo, normalizePromo, PromoSchema, promoLines, type Promo } from "./schema.ts";
import { BED_UNDER_MUSIC_LU, BED_UNDER_VOICE_LU, muxBed, renderSfxBed } from "./sfxbed.ts";
import { VOICE_BED } from "../../audio/mix.ts";
import { siteBrief, type SiteBrief } from "./site.ts";
import { UI_ICONS } from "./ui.ts";
import { featuresFor, writeNarration, writePromo, type NarrationGroup } from "./write.ts";
import type { MakeReport, MakeResult } from "../index.ts";

/**
 * Stage 31: `vedit make "<product or topic>" --format promo [--url …] [--aspect 16:9|9:16]`.
 *   site brief (copy + brand colour, optional) → writer (Claude/Gemini, prompts/make.promo.*) → scene plan →
 *   music (a beat to cut on) → cuts snapped to the beat → composition (fit in Chrome, lint) → render → SFX bed
 *   (a sound per visual event) + music (+ narration with --voice) → contact sheet.
 * Lands in workspace/<job>/: promo.json, site.json, make/project/, make/sheet.jpg, output_make.mp4, make.json.
 */

export interface PromoOptions {
  language?: string;
  seconds?: number;
  aspect?: Aspect;
  /** the product's site: real copy + brand colour */
  url?: string;
  /** "auto" (library/Openverse, a clear beat), a file, or "none" */
  music?: string;
  sfx?: boolean;
  /** narration voice id; default none (the on-screen words carry the promo) */
  voice?: string;
  voiceSynth?: SentenceSynth;
  quality?: RenderQuality;
  workers?: number;
  model?: string;
  llm?: StructuredFn;
  /** a saved promo.json (no writer call) */
  promoFile?: string;
  /** reuse promo.json (and site.json) of an earlier promo job */
  fromJob?: string;
  /** skip the writer: the structural template with the product's name and description */
  noLlm?: boolean;
  /**
   * with fromJob: sound only — the earlier job's picture (make/rendered.mp4), scene timings and music are kept, the
   * effects bed is rebuilt with the current sound rules and the soundtrack mixed again (no render)
   */
  remix?: boolean;
  renderer?: HyperFramesRenderer;
  fakeRender?: (projectDir: string, outFile: string) => Promise<void>;
  /** test hook: brand marks without the network */
  brandFn?: (name: string) => Promise<{ path: string; hex: string; title?: string; license?: string; guidelines?: string } | null>;
  /** test hook: site brief without the network */
  siteFn?: (url: string) => Promise<SiteBrief>;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
}

/** Writes the HyperFrames project of a promo: fonts, icons, brand marks, composition fitted in Chrome. */
export async function writePromoProject(p: Promo, scenes: PromoScene[], dir: string, o: { frame: Frame; brands?: Record<string, { path: string; hex: string }>; gsapFile?: string; fit?: boolean }) {
  await fs.mkdir(path.join(dir, "assets"), { recursive: true });
  await linkOrCopy(o.gsapFile ?? DEFAULT_GSAP, path.join(dir, "assets", "gsap.min.js"));
  const fontFaces = await installFonts(dir, ["inter", "mono"]);
  const icons: Record<string, string> = {};
  for (const name of new Set([...UI_ICONS, ...iconsNeeded(p)])) {
    try {
      icons[name] = await loadIconSvg(name);
    } catch {
      /* not a Lucide icon: the components fall back to a dot */
    }
  }
  const base = { frame: o.frame, fontFaces, gsapRel: "assets/gsap.min.js", icons, brands: o.brands ?? {} };
  const entry = path.join(dir, "index.html");
  let composed = composePromo(p, scenes, base);
  await fs.writeFile(entry, composed.html);
  let overflow: string[] = [];
  if (o.fit !== false) {
    const fit = await fitText(entry, { width: o.frame.w, height: o.frame.h });
    overflow = fit.overflow;
    composed = composePromo(p, scenes, { ...base, sizes: fit.sizes });
    await fs.writeFile(entry, composed.html);
  }
  const name = `promo-${p.product.name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}`;
  await fs.writeFile(path.join(dir, "hyperframes.json"), JSON.stringify({ $schema: "https://hyperframes.heygen.com/schema/hyperframes.json", registry: "https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry", paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify({ id: name, name, createdAt: "1970-01-01T00:00:00.000Z" }, null, 2) + "\n");
  await fs.writeFile(path.join(dir, "layout.json"), JSON.stringify({ frame: { width: o.frame.w, height: o.frame.h, fps: 30, duration: composed.duration, aspect: o.frame.aspect }, scenes: composed.timings }, null, 1));
  await fs.writeFile(path.join(dir, "promo.json"), JSON.stringify(p, null, 1));
  return { ...composed, entry, overflow };
}

/** the promo's music bed before the final normalisation (LUFS): the beat carries the film, the effects sit under it */
export const PROMO_MUSIC_LUFS = -17;

const KNOWN_TOOLS = /^(gmail|instagram|linkedin|facebook|messenger|whatsapp|telegram|x|twitter|youtube|tiktok|slack|notion|stripe|paypal|hubspot|salesforce|pipedrive|google (sheets|drive|docs|slides|calendar|meet|gemini)|microsoft excel|excel|shopify|zoom|figma|trello|asana|airtable|zapier|calendly|mailchimp|discord|dropbox)$/i;

/** Brand names the composition may draw as marks: integrations, channels in tiles/lists/tables. */
export function brandCandidates(p: Promo): string[] {
  const out = new Set<string>([...p.integrations, ...p.hook.items, ...[...p.pains, ...p.features].flatMap((x) => (x.prop === "swap" || x.prop === "strike" ? x.labels.slice(0, 1) : []))]);
  for (const u of [...p.features.map((f) => f.ui), ...(p.proof ? [p.proof.ui] : [])]) {
    // only names of well-known tools: a sample label («Notes», «Name») must not pick up an unrelated brand mark
    for (const v of [...u.items.flatMap((it) => [it.label, it.value]), ...u.rows.flat()]) if (KNOWN_TOOLS.test(v.trim())) out.add(v.trim());
  }
  return [...out].slice(0, 24);
}

/**
 * A modern, minimal beat under the promo: the library first (tracks measured once: tempo and beat strength cached in
 * workspace/_cache/music/beats.json), else Openverse "tech". Prefers 90–128 BPM with a clear beat.
 */
export async function chooseBed(want: string, seed: string, minSeconds: number, say: (l: string) => void): Promise<{ track: MusicTrack; offset: number; bpm: number | null; strength: number } | null> {
  if (want === "none") return null;
  if (want !== "auto") {
    if (!(await exists(want))) throw new Error(`музыка не найдена: ${want}`);
    const d = Number((await ffprobe(want)).format.duration) || 0;
    const b = await bedStart(want, d, minSeconds);
    return { track: { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" }, ...b };
  }
  const cacheFile = path.join(WORKSPACE_ROOT, "_cache", "music", "beats.json");
  const cache: Record<string, { bpm: number | null; strength: number; offset: number; d: number }> = await fs.readFile(cacheFile, "utf8").then((t) => JSON.parse(t), () => ({}));
  const files = (await fs.readdir(MUSIC_LIBRARY).catch(() => [] as string[])).filter((f) => /\.(mp3|wav|ogg|m4a|flac)$/i.test(f)).sort();
  let best: { file: string; score: number; m: (typeof cache)[string] } | null = null;
  const h = [...seed].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  for (let i = 0; i < files.length; i++) {
    const f = files[(i + h) % files.length];
    const file = path.join(MUSIC_LIBRARY, f);
    const st = await fs.stat(file);
    const key = `${f}:${st.size}:${minSeconds > 60 ? 90 : 60}`;
    if (!cache[key]) {
      const d = Number((await ffprobe(file)).format.duration) || 0;
      if (d < Math.min(minSeconds, 45)) {
        cache[key] = { bpm: null, strength: 0, offset: 0, d };
      } else {
        const b = await bedStart(file, d, minSeconds);
        cache[key] = { ...b, d };
      }
    }
    const m = cache[key];
    if (!m.bpm) continue;
    const tempo = m.bpm >= 88 && m.bpm <= 130 ? 1 : m.bpm >= 75 && m.bpm <= 150 ? 0.6 : 0.2;
    const score = m.strength * tempo * (m.d >= minSeconds ? 1 : 0.7);
    if (!best || score > best.score) best = { file, score, m };
  }
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  await fs.writeFile(cacheFile, JSON.stringify(cache, null, 1));
  if (best && best.score >= 0.1) {
    say(`  музыка: ${path.basename(best.file)} (${best.m.bpm} BPM, сила доли ${best.m.strength.toFixed(2)})`);
    return { track: { file: best.file, title: path.parse(best.file).name, creator: "", license: "own", source: "library", url: "", attribution: "" }, offset: best.m.offset, bpm: best.m.bpm, strength: best.m.strength };
  }
  const t = await pickMusic("tech", seed, { minSeconds, offline: false, check: async (file) => (await bedStart(file, Number((await ffprobe(file)).format.duration) || 0, minSeconds)).strength >= 0.12 });
  if (!t) return null;
  const b = await bedStart(t.file, Number((await ffprobe(t.file)).format.duration) || 0, minSeconds);
  return { track: t, ...b };
}

/** The narration script of a promo: one beat per scene group (≤ 10), the group's lines or its `say`. */
/** What each narration group shows (on-screen lines and the UI's action) and how long it is, for the narration writer. */
export function narrationGroups(p: Promo, scenes: PromoScene[]): NarrationGroup[] {
  const groups = [...new Set(scenes.map((s) => s.group))].sort((a, b) => a - b);
  return groups.map((g) => {
    const sc = scenes.filter((s) => s.group === g);
    const screen = sc
      .map((s) => {
        if (s.kind === "hook") return `hook: «${[p.hook.a, p.hook.b].join(" ")}»`;
        if (s.kind === "logo") return `logo + «${p.reveal.intro} ${p.product.name}.»`;
        if (s.kind === "rotate") return `«${p.audience.lead}» ${p.audience.items.join(" / ")}`;
        if (s.kind === "cloud") return `tools: ${p.integrations.join(", ")}`;
        if (s.kind === "cta") return `button «${p.outro.cta}»`;
        if (s.kind === "ui" && s.ui) return `UI ${s.ui.kind}: ${[s.ui.title, s.ui.action, s.ui.result, s.ui.result_sub, ...s.ui.items.slice(0, 4).map((x) => [x.label, x.value].filter(Boolean).join(" "))].filter(Boolean).join("; ")}`;
        return s.text ? `«${[s.text.a, s.text.b].filter(Boolean).join(" ")}»` : s.kind;
      })
      .join(" → ");
    return { seconds: sc.reduce((n, s) => n + s.dur, 0), screen };
  });
}

export function narrationScript(p: Promo, scenes: PromoScene[]): Script {
  const groups = [...new Set(scenes.map((s) => s.group))].sort((a, b) => a - b);
  const sayOf = (g: number): string => {
    const written = p.narration[groups.indexOf(g)];
    if (written) return written;
    const sc = scenes.filter((s) => s.group === g);
    const said: string[] = [];
    for (const s of sc) {
      if (s.kind === "hook") said.push(p.hook.say || [p.hook.a, p.hook.b].join(" "));
      else if (s.kind === "logo") said.push(p.reveal.say || `${p.reveal.intro} ${p.product.name}.`);
      else if (s.kind === "rotate") said.push(p.audience.say || `${p.audience.lead} ${p.audience.items.join(", ")}.`);
      else if (s.kind === "cta") said.push(p.outro.say || p.outro.cta);
      else if ((s.kind === "text" || s.kind === "tagline") && s.text) {
        const src = [...p.pains, p.summary, ...p.features, ...(p.proof ? [p.proof] : [])].find((x) => x.a === s.text!.a && x.b === s.text!.b);
        said.push(src?.say || `${s.text.a} ${s.text.b}`.trim());
      }
    }
    return [...new Set(said)].join(" ").replace(/\s+/g, " ").trim().slice(0, 290);
  };
  return ScriptSchema.parse({
    title: p.title.slice(0, 60),
    language: p.language,
    hashtags: p.hashtags,
    beats: groups.map((g) => {
      const dur = scenes.filter((s) => s.group === g).reduce((n, s) => n + s.dur, 0);
      const text = sayOf(g).slice(0, 140) || p.product.name;
      return { text, emphasis: "", icon: "sparkles", seconds: Math.min(15, Math.max(2, Math.round(dur * 1000) / 1000)), voiceover: sayOf(g) };
    }),
  });
}

export async function makePromo(topic: string, opts: PromoOptions = {}): Promise<MakeResult> {
  const t0 = Date.now();
  const asked = topic.replace(/\s+/g, " ").trim();
  if (!asked) throw new Error("тема пустая");
  const aspect: Aspect = opts.aspect ?? detectAspect(asked) ?? "16:9";
  const frame = frameFor(aspect);
  const input = stripAspectWords(asked) || asked;
  const language = opts.language ?? (/[а-яё]/i.test(input) ? "ru" : "en");
  const seconds = opts.seconds ?? 60;
  const warnings: string[] = [];
  const say = (l: string) => opts.onEvent?.(l);
  const job = await createJob(`make:promo:${input.slice(0, 80)}`, { prompt: asked });
  const dir = jobDir(job.id);
  say(`job ${job.id}`);
  say(`  промо, кадр ${aspect} (${frame.w}×${frame.h}), язык ${language}`);
  let usd = 0;

  // 1. the site (copy + colour)
  let site: SiteBrief | null = null;
  const reuseDir = opts.fromJob ? jobDir(opts.fromJob) : null;
  if (opts.url && !opts.promoFile && !reuseDir) {
    say(`▸ сайт ${opts.url}…`);
    try {
      site = await (opts.siteFn ?? ((u: string) => siteBrief(u, { onLog: (l) => say(`  ${l}`) })))(opts.url);
      await fs.writeFile(path.join(dir, "site.json"), JSON.stringify(site, null, 1));
      say(`  «${site.name || site.title}», текста ${site.text.length} симв., цвет ${site.accent ?? "—"}${site.accentFrom ? ` (${site.accentFrom})` : ""}`);
    } catch (err) {
      warnings.push(`сайт не прочитан: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  // 2. the promo script
  say("▸ сценарий промо…");
  let promo: Promo;
  const promoFile = opts.promoFile ?? (reuseDir ? path.join(reuseDir, "promo.json") : undefined);
  if (promoFile) {
    promo = await readJson(path.resolve(promoFile), PromoSchema);
    await runStep(job.id, "plan", async () => promo);
  } else if (opts.noLlm) {
    const [name, ...rest] = input.split(/\s[—–-]\s|:\s/);
    promo = fallbackPromo(name.trim().slice(0, 40), rest.join(" — "), language);
    if (site?.accent) promo.product.accent = site.accent;
    await runStep(job.id, "plan", async () => promo);
  } else {
    try {
      const llm = opts.llm ?? selectStructuredLlm(process.env, "script", { onEvent: (l) => say(`  ${l}`) });
      const w = await runStep(job.id, "plan", () => writePromo(input, llm, { language, seconds, aspect, site, model: opts.model }));
      promo = w.promo;
      usd += w.usd;
      await addCost(job.id, { step: "plan", provider: w.provider === "anthropic" ? "anthropic" : w.provider, model: w.model, units: { ...w.usage, calls: w.cliches.length ? 2 : 1, estimate: w.estimate ? 1 : 0 }, usd: w.usd });
      if (w.cliches.length) say(`  клише в черновике: ${w.cliches.length} → переписано, осталось ${w.remaining.length}`);
      if (w.remaining.length) warnings.push(`в промо остались клише: ${describeFindings(w.remaining).split("\n").slice(0, 2).join("; ")}`);
      say(`  ≈$${w.usd.toFixed(3)} (${w.provider} ${w.model})`);
    } catch (err) {
      warnings.push(`сценарист не ответил, шаблон промо: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      say(`  ⚠ ${warnings.at(-1)}`);
      promo = fallbackPromo(input.split(/\s[—–-]\s/)[0].slice(0, 40), input, language);
    }
  }
  promo = normalizePromo(promo, { language: promo.language, url: site?.url ?? promo.product.url });
  await writeJson(path.join(dir, "promo.json"), PromoSchema, promo);
  if (reuseDir && (await exists(path.join(reuseDir, "site.json")))) await fs.copyFile(path.join(reuseDir, "site.json"), path.join(dir, "site.json")).catch(() => {});
  say(`  «${promo.title}» · ${promo.mode} · ${promo.product.name} (${promo.product.accent}) · фич ${promo.features.length} [${promo.features.map((f) => f.ui.kind).join(", ")}]${promo.proof ? ` · доказательство ${promo.proof.ui.kind}` : ""}`);
  for (const l of promoLines(promo)) say(`    · ${l}`);
  if (promo.features.length < featuresFor(seconds) - 1) warnings.push(`фич меньше, чем просили: ${promo.features.length}`);

  // 3. scenes, music, beat-snapped cuts, narration
  let scenes = planPromo(promo, { frame });
  const remix = !!(opts.remix && reuseDir);
  let remixLayout: { scenes: { duration: number }[]; frame?: { aspect?: string } } | null = null;
  if (opts.remix && !reuseDir) throw new Error("--remix работает только с --from <job>");
  if (remix) {
    remixLayout = JSON.parse(await fs.readFile(path.join(reuseDir!, "make", "project", "layout.json"), "utf8"));
    if (remixLayout!.scenes.length !== scenes.length) throw new Error(`--remix: в задаче ${opts.fromJob} ${remixLayout!.scenes.length} сцен, а план даёт ${scenes.length} — перерендерите без --remix`);
    scenes = scenes.map((s, i) => ({ ...s, dur: remixLayout!.scenes[i].duration }));
  }
  say(`▸ сцены: ${scenes.length}, ${timeScenes(scenes).duration.toFixed(1)} с (средняя ${(timeScenes(scenes).duration / scenes.length).toFixed(2)} с)`);
  let vo: VoiceoverResult | null = null;
  const wantVoice = opts.voice?.trim();
  if (wantVoice && !NO_VOICE.test(wantVoice)) {
    // the voice-over is written for the beats (one line per scene group, fitted to its seconds) unless promo.json has it
    if (promo.narration.length !== new Set(scenes.map((s) => s.group)).size) {
      say("▸ текст озвучки…");
      try {
        const llm = opts.llm ?? selectStructuredLlm(process.env, "script", { onEvent: (l) => say(`  ${l}`) });
        const n = await writeNarration(promo, narrationGroups(promo, scenes), llm, { model: opts.model });
        promo = { ...promo, narration: n.lines };
        usd += n.usd;
        await addCost(job.id, { step: "plan", provider: n.provider === "anthropic" ? "anthropic" : n.provider, model: n.model, units: { calls: 1 }, usd: n.usd });
        await writeJson(path.join(dir, "promo.json"), PromoSchema, promo);
        for (const [k, l] of n.lines.entries()) say(`    ${k + 1}. ${l}`);
      } catch (err) {
        warnings.push(`текст озвучки не написан, голос читает карточки: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    say(`▸ озвучка (${wantVoice})…`);
    vo = await runStep(job.id, "design", () => makeVoiceover(narrationScript(promo, scenes), wantVoice, path.join(dir, "make", "voice"), { synth: opts.voiceSynth, onEvent: (l) => say(`  ${l.trim()}`) }));
    warnings.push(...vo.warnings);
    // a Gemini voice asked for by name must not quietly become Piper (quota / key problems are reported, not hidden)
    if (/^gemini/i.test(wantVoice) && vo.engine !== "gemini") throw new Error(`голос ${wantVoice} не синтезирован Gemini TTS (движок: ${vo.engine}; ${vo.warnings.join("; ").slice(0, 300) || "квота или ключ?"})`);
    // a group that needs longer for its speech gives the time to its last scene (usually the UI)
    const groups = [...new Set(scenes.map((s) => s.group))].sort((a, b) => a - b);
    groups.forEach((g, k) => {
      const sc = scenes.filter((s) => s.group === g);
      const have = sc.reduce((n, s) => n + s.dur, 0);
      const need = vo!.script.beats[k]?.seconds ?? have;
      if (need > have + 0.01) sc.at(-1)!.dur = Math.round((sc.at(-1)!.dur + need - have) * 30) / 30;
    });
    if (vo.engine !== "piper") {
      const speechS = vo.beats.reduce((n, b) => n + b.end - b.start, 0);
      const chars = vo.beats.reduce((n, b) => n + b.text.length, 0);
      const tts = ttsUsd(vo.engine, vo.model, speechS, chars);
      usd += tts;
      await addCost(job.id, { step: "design", provider: vo.engine === "gemini" ? "gemini tts" : "cloud tts", model: vo.model ?? vo.engine, units: { voice_seconds: Math.round(speechS * 10) / 10, chars }, usd: tts });
    }
  }
  say("▸ музыка…");
  let bed: Awaited<ReturnType<typeof chooseBed>> = null;
  let snapped = 0;
  try {
    const oldMusic = remix ? await readJson(path.join(reuseDir!, "make.json"), (await import("../index.ts")).MakeReportSchema).then((r) => r.music, () => null) : null;
    bed = await chooseBed(remix && oldMusic ? oldMusic : (opts.music ?? "auto").trim(), input, timeScenes(scenes).duration + 2, say);
    if (bed?.bpm && !remix) {
      const grid = await detectBeats(bed.track.file, { offset: bed.offset, seconds: timeScenes(scenes).duration + 4 });
      if (grid.strength >= 0.08 && grid.beats.length >= 4) {
        const r = snapScenesToBeats(scenes, grid.beats, { maxShift: vo ? 0.3 : 0.32, growOnly: !!vo });
        scenes = r.scenes;
        snapped = r.snapped;
      }
    }
  } catch (err) {
    warnings.push(`музыка/доли: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  if (vo) {
    const ns = narrationScript(promo, scenes);
    vo = await layVoiceover(vo, ns);
  }
  const { duration: total } = timeScenes(scenes);
  say(`  ${bed ? `«${bed.track.title}»${bed.bpm ? `, ${bed.bpm} BPM` : ""}, склеек на долю ${snapped}/${scenes.length - 1}` : "без музыки"}; ролик ${total.toFixed(1)} с`);

  // 4. brand marks + composition
  say("▸ композиция…");
  const brands: Record<string, { path: string; hex: string }> = {};
  const brandCredits: string[] = [];
  for (const name of brandCandidates(promo)) {
    try {
      const m = opts.brandFn ? await opts.brandFn(name) : await brandMark(name);
      if (m) {
        brands[name.toLowerCase()] = { path: m.path, hex: m.hex };
        if ("title" in m && m.title) brandCredits.push(brandCreditLine({ title: m.title, license: m.license ?? "CC0-1.0", guidelines: m.guidelines }));
      }
    } catch {
      /* offline: typed names / Lucide icons instead */
    }
  }
  const projectDir = path.join(dir, "make", "project");
  const composed = await runStep(job.id, "design", async () => {
    if (remix) {
      const c = composePromo(promo, scenes, { frame, fontFaces: "", gsapRel: "assets/gsap.min.js", icons: {}, brands });
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, "layout.json"), JSON.stringify({ frame: { width: frame.w, height: frame.h, fps: 30, duration: c.duration, aspect: frame.aspect }, scenes: c.timings }, null, 1));
      return { ...c, overflow: [] as string[] };
    }
    const c = await writePromoProject(promo, scenes, projectDir, { frame, brands });
    if (c.overflow.length) warnings.push(`текст не влез: ${c.overflow.join(", ")}`);
    const { lintProject } = await import("../index.ts");
    warnings.push(...(await lintProject(projectDir)));
    return c;
  });
  say(`  сцен ${composed.timings.length}, звуков ${composed.cues.length}, знаков ${Object.keys(brands).length}`);

  // 5. render
  say("▸ рендер…");
  const rendered = path.join(dir, "make", "rendered.mp4");
  const tr = Date.now();
  await runStep(job.id, "render", async () => {
    if (remix) {
      await fs.mkdir(path.dirname(rendered), { recursive: true });
      return void (await fs.copyFile(path.join(reuseDir!, "make", "rendered.mp4"), rendered));
    }
    if (opts.fakeRender) return opts.fakeRender(projectDir, rendered);
    // blur-heavy kinetic type renders at ~6–9× real time on one worker: a longer leash than the reel's 12×
    const renderer = opts.renderer ?? new HyperFramesRenderer({ workers: opts.workers, timeoutFactor: 30 });
    await renderer.prepare();
    await renderer.render(projectDir, rendered, { quality: opts.quality ?? "looks", onLine: (l) => say(`    ${l}`), signal: opts.signal });
  });
  const renderSeconds = (Date.now() - tr) / 1000;

  // 6. sound: SFX bed (one sound per visual event) as the video's own track, music, voice
  say("▸ звук…");
  const output = path.join(dir, "output_make.mp4");
  let sfxN = 0;
  let withSfx = rendered;
  // the music bed's level (before the final −14 LUFS); the effects sit a fixed distance under it (sfxbed.ts rules)
  const musicLufs = vo ? VOICE_BED.lufs : PROMO_MUSIC_LUFS;
  if (opts.sfx !== false && composed.cues.length) {
    const bedWav = path.join(dir, "make", "sfx.wav");
    sfxN = await renderSfxBed(composed.cues, composed.duration, bedWav, { targetLufs: musicLufs - (vo ? BED_UNDER_VOICE_LU : BED_UNDER_MUSIC_LU) });
    withSfx = path.join(dir, "make", "rendered_sfx.mp4");
    await muxBed(rendered, bedWav, withSfx);
  }
  await mixSoundtrack({ video: withSfx, out: output, duration: composed.duration, music: bed?.track.file ?? null, musicOffset: bed?.offset || undefined, musicLufs: vo ? undefined : PROMO_MUSIC_LUFS, speech: false, voice: vo?.track ?? null, origGainDb: 0 });
  say(`  эффектов ${sfxN}${bed ? `, музыка «${bed.track.title}»` : ""}${vo ? `, голос ${vo.voice.id}` : ""}`);
  const { contactSheet } = await import("../index.ts");
  await contactSheet(rendered, path.join(projectDir, "layout.json"), path.join(dir, "make"), frame).catch(() => {});
  const preview = path.join(dir, "output_make_preview.jpg");
  await ffmpeg(["-ss", "2.4", "-i", output, "-frames:v", "1", "-q:v", "3", preview]).catch(() => {});
  const probe = await ffprobe(output);
  const duration = Number(probe.format.duration) || composed.duration;

  const script: Script = narrationScript(promo, scenes);
  await fs.writeFile(path.join(dir, "script.json"), JSON.stringify(script, null, 1));
  const { MakeReportSchema } = await import("../index.ts");
  const report: MakeReport = await writeJson(path.join(dir, "make.json"), MakeReportSchema, {
    format: "promo",
    topic: input,
    language: promo.language,
    title: promo.title,
    duration,
    beats: scenes.length,
    output,
    preview,
    trends: "skipped",
    music: bed?.track.file ?? null,
    music_attribution: bed?.track.attribution ?? "",
    sfx: sfxN,
    voice: vo ? vo.voice.id : null,
    voice_seconds: vo ? Math.round(vo.beats.reduce((n, b) => n + b.end - b.start, 0) * 10) / 10 : 0,
    aspect,
    width: frame.w,
    height: frame.h,
    images: "ui",
    photo_credits: [],
    // a promo about someone else's product says so first in the description (creditsText prints brand_credits)
    brand_credits: [...(disclaimer(promo) ? [disclaimer(promo)] : []), ...brandCredits],
    music_bpm: bed?.bpm ?? null,
    cuts_on_beat: snapped,
    hook_seconds: scenes[0]?.dur ?? 0,
    usd,
    wall_seconds: (Date.now() - t0) / 1000,
    render_seconds: renderSeconds,
    warnings,
  });
  return { ...report, jobId: job.id, script, trendsData: null };
}
