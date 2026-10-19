// Exports a renderer-independent design job for one output: the output timeline
// (words/phrases/titles in output seconds), the preset's design spec and media paths.
//   npx tsx src/design/export.ts <job_id> <output_id> [out.json] [--translate]
import path from "node:path";
import fs from "node:fs/promises";
import { exists, jobDir, readJson } from "../lib/workspace.ts";
export { photoCreditLine };
import { EdlSchema, MediaSchema, TranscriptSchema, PresetSchema, JobSchema, ScenesSchema, type Scenes } from "../schemas/index.ts";
import { CutReportSchema, clipFocus } from "../cut/index.ts";
import { loadPreset } from "../plan/presets.ts";
import { buildDesignTimeline, paginate, type DesignTimeline, type OutPhrase } from "./timeline.ts";
import { applyTranslations, translatePhrases } from "./translate.ts";
import { selectStructuredLlm, type StructuredFn } from "../lib/llm.ts";
import { directPanels, fallbackPanels, PanelsSchema, resanitizePanels, type Panels } from "./panels.ts";
import { generateImages } from "../make/images.ts";
import { findPhotos, photoCreditLine, type PhotoCredit } from "../make/photos.ts";
import { FRAMES } from "../lib/aspect.ts";
import { panelFrame, videoOffset } from "./hyperframes/split.ts";
import { resolveFaceTrack, toOutputFrame, type FaceTrack, type FrameView } from "./faces.ts";
import { cutoutGeometry, resolveCutout, type CutoutMode } from "./matte.ts";
import { addCost } from "../lib/cost.ts";
import { writeJson } from "../lib/workspace.ts";
import { styledPreset } from "../style/profile.ts";
import type { DesignSpec } from "../schemas/index.ts";
import { buildInserts, type BuildInsertsOptions, type InsertsTrack } from "./inserts.ts";

export interface DesignJob {
  job_id: string;
  rough_path: string;
  timeline: DesignTimeline;
  pages: { start: number; end: number; words: OutPhrase["words"] }[];
  design: DesignSpec;
  preset: string;
  captions_language: string | null;
  translated: boolean;
  warnings: string[];
  /** vertical centre of the face/subject over the output's clips (0 = top), from the vision step; absent without focus data */
  face_y?: number;
  /** split layout: top-half panels, the hook title and their images (absolute paths by panel index) */
  panels?: Panels;
  panel_images?: Record<number, string>;
  /** split layout: real photos used on panels (CC BY needs attribution: lines go into the description) */
  panel_credits?: PhotoCredit[];
  /**
   * split layout: the speaker cut out — `plate` (H.264, width×plate_height: the speaker over the designed
   * background, the box below the seam) and `pop` (VP9+alpha WebM, width×overlap: the head above the seam)
   */
  cutout?: { plate: string; pop?: string; width: number; plate_height: number; overlap: number; y0?: number; scaled_height?: number };
  /**
   * stage 23: face boxes over time in the COMPOSITION frame (fractions; split layout: mapped into the bottom box),
   * from the rough cut (MediaPipe) or estimated from scenes.json; captions and titles are placed off them
   */
  faces?: FaceTrack;
  /** stage 27: B-roll inserts over the talking head (src/design/inserts.ts) */
  inserts?: InsertsTrack;
}

export interface ExportOptions {
  /** translate captions into output.captions.language when the speech is in another language */
  translate?: boolean;
  /** design preset to use instead of the job's (e.g. split_news) */
  preset?: string;
  /** split layout: reuse saved panels (default true) / generate panel images (default true) */
  reusePanels?: boolean;
  panelImages?: boolean;
  llm?: StructuredFn;
  model?: string;
  /** split layout: speaker cutout mode instead of the preset's design.split.cutout */
  cutout?: CutoutMode;
  /** progress lines of long design steps (the matte sidecar) */
  onLog?: (line: string) => void;
  /** face track: "auto" (default) = sidecar → scenes → none; "scenes" = skip the sidecar; "off" = no track */
  faces?: "auto" | "scenes" | "off";
  /** stage 27: B-roll inserts "on" / "off" instead of the preset's design.inserts.enabled */
  inserts?: "on" | "off";
  /** stage 27: insert options (tests: offline, stub Gemini / fetch / capture) */
  insertOptions?: BuildInsertsOptions;
}

export async function exportDesignJob(jobId: string, outputId: string, opts: ExportOptions = {}): Promise<DesignJob> {
  const dir = jobDir(jobId);
  const job = await readJson(path.join(dir, "job.json"), JobSchema);
  const media = await readJson(path.join(dir, "media.json"), MediaSchema);
  // no transcript (e.g. --skip-understand) → no captions, the overlay still gets titles/outro
  const transcriptFile = path.join(dir, "transcript.json");
  const transcript = (await exists(transcriptFile)) ? await readJson(transcriptFile, TranscriptSchema) : { language: "unknown", segments: [] };
  const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
  const output = edl.outputs.find((o) => o.id === outputId);
  if (!output) throw new Error(`output ${outputId} not in edl.json (${edl.outputs.map((o) => o.id).join(", ")})`);
  // reference style (style.json): its captions / colours / overlays on top of the preset
  const { preset } = await styledPreset(jobId, (await loadPreset(opts.preset ?? job.preset ?? "bold_pop")).preset);
  const design = PresetSchema.parse(preset).design;
  // the cut may have snapped/clamped clip edges: build the timeline from what was actually cut
  const cutFile = path.join(dir, "cut.json");
  const cutRecord = (await exists(cutFile)) ? (await readJson(cutFile, CutReportSchema)).outputs.find((o) => o.id === outputId) : undefined;
  const usedClips = cutRecord?.status === "ok" && cutRecord.clips ? cutRecord.clips : output.clips;
  const timeline = buildDesignTimeline(output, transcript, media, cutRecord?.status === "ok" ? cutRecord.clips : undefined);
  // the house style decides the title look: an EDL title left at the schema default ("hero") follows the preset
  if (preset.title_style === "card") timeline.titles = timeline.titles.map((t) => (t.style === "hero" ? { ...t, style: "card" } : t));
  // stage 27: an expert preset draws the hook plain (no card, caps, accent word) — also over plans made for another preset
  if (preset.title_style === "plain") timeline.titles = timeline.titles.map((t) => (t.style === "hero" || t.style === "card" ? { ...t, style: "plain" } : t));
  const scenesFile = path.join(dir, "scenes.json");
  const scenes = (await exists(scenesFile)) ? await readJson(scenesFile, ScenesSchema) : undefined;
  const faceY = scenes ? faceCentreY(usedClips, scenes) : undefined;

  const target = output.captions.enabled ? (output.captions.language ?? null) : null;
  // the inserts follow what is SAID (the captions may be translated below)
  const spokenPhrases = timeline.phrases;
  let translated = false;
  const warnings: string[] = [];
  if (opts.translate && target && timeline.phrases.some((p) => p.lang !== target)) {
    try {
      const llm = opts.llm ?? selectStructuredLlm(process.env, "translate");
      const translations = await translatePhrases(jobId, timeline.phrases, target, llm, { model: opts.model });
      timeline.phrases = applyTranslations(timeline.phrases, translations, target);
      translated = translations.size > 0;
    } catch (err) {
      // captions stay in the spoken language rather than failing the whole output
      warnings.push(`перевод субтитров на ${target} не выполнен: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  const pages = timeline.phrases.flatMap((p) => paginate(p, design.captions.max_words, design.captions.max_chars).map((words) => ({ start: words[0].start, end: words[words.length - 1].end, words })));
  // split layout: the director decides what the top half shows; images via Antigravity (cached per output)
  let split: { panels?: Panels; panel_images?: Record<number, string>; panel_credits?: PhotoCredit[]; cutout?: DesignJob["cutout"] } = {};
  if (design.layout === "split") {
    const panelsFile = path.join(dir, "design", `${outputId}.panels.json`);
    const imgDir = path.join(dir, "design", `${outputId}-panels`);
    let panels: Panels;
    if (opts.reusePanels !== false && (await exists(panelsFile))) panels = await readJson(panelsFile, PanelsSchema);
    else {
      try {
        const llm = opts.llm ?? selectStructuredLlm(process.env, "panels");
        const d = await directPanels(timeline.phrases, timeline.duration, { llm, language: timeline.phrases[0]?.lang ?? transcript.language, instruction: job.prompt ?? "", model: opts.model });
        panels = d.panels;
        await addCost(jobId, { step: "design", provider: d.provider === "anthropic" ? "anthropic" : d.provider, model: d.model, units: { ...d.usage, calls: 1, panels: d.panels.panels.length, estimate: d.estimate ? 1 : 0 }, usd: d.usd });
      } catch (err) {
        panels = fallbackPanels(timeline.duration, output.titles[0]?.text ?? "", timeline.phrases);
        warnings.push(`режиссёр панелей не ответил, простая панель: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
      await fs.mkdir(path.dirname(panelsFile), { recursive: true });
      await writeJson(panelsFile, PanelsSchema, panels);
    }
    // saved panels (also ones from before the anti-slop rules) pass the metaphor filter again
    panels = resanitizePanels(panels, timeline.phrases);
    for (const n of panels.notes) warnings.push(n);
    const images: Record<number, string> = {};
    let credits: PhotoCredit[] = [];
    const creditsFile = path.join(imgDir, "credits.json");
    if (await exists(creditsFile)) credits = JSON.parse(await fs.readFile(creditsFile, "utf8")) as PhotoCredit[];
    // 1) real photos (Openverse: CC0 / PDM / CC BY), cropped to the panel frame; cached as scene_<i>.jpg
    const box = panelFrame(1080, 1920, design.split.seam);
    const frame = { ...FRAMES["9:16"], w: box.w, h: box.h };
    const photoTodo: { beat: number; query: string }[] = [];
    for (const [i, p] of panels.panels.entries()) {
      if (p.source !== "photo") continue;
      const f = path.join(imgDir, `scene_${i}.jpg`);
      if ((await exists(f)) && credits.some((c) => c.beat === i)) images[i] = f;
      else photoTodo.push({ beat: i, query: p.photo_query });
    }
    if (photoTodo.length && opts.panelImages !== false) {
      try {
        const r = await findPhotos(photoTodo, imgDir, { frame });
        for (const [b, f] of r.files) images[b] = f;
        credits = [...credits.filter((c) => !r.files.has(c.beat)), ...r.credits];
        await fs.mkdir(imgDir, { recursive: true });
        await fs.writeFile(creditsFile, JSON.stringify(credits, null, 1));
        if (r.missing.length) warnings.push(`фото для панелей ${r.missing.join(", ")} не нашлось — там будет графика`);
        await addCost(jobId, { step: "design", provider: "openverse", model: "images", units: { requests: r.requests, photos: r.files.size }, usd: 0 });
      } catch (err) {
        warnings.push(`поиск фото не удался: ${err instanceof Error ? err.message.split("\n")[0] : String(err)} — панели покажут графику`);
      }
    }
    // 2) AI images only for panels the director left as "ai" (documentary prompts that passed the filter)
    const todo: { beat: number; prompt: string }[] = [];
    for (const [i, p] of panels.panels.entries()) {
      if (p.source !== "ai") continue;
      const f = path.join(imgDir, `scene_${i}.jpg`);
      if (await exists(f)) images[i] = f;
      else todo.push({ beat: i, prompt: p.image_prompt });
    }
    if (todo.length && opts.panelImages !== false) {
      try {
        const r = await generateImages(todo, imgDir, { style: panels.image_style || design.split.image_style });
        for (const [b, f] of r.files) images[b] = f;
        if (r.missing.length) warnings.push(`картинки панелей не получены: ${r.missing.join(", ")} — там будет графика`);
        await addCost(jobId, { step: "design", provider: r.provider === "gemini-image" ? "gemini-image" : "antigravity-cli", model: r.model, units: { ...r.usage, images: r.files.size, wall_seconds: r.wall_seconds, ...(r.provider === "gemini-image" ? {} : { subscription: 1 }) }, usd: r.usd });
      } catch (err) {
        warnings.push(`картинки панелей не сгенерированы: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    // 3) everything else (and any missing picture) is a code-rendered graphic
    const usedCredits = credits.filter((c) => images[c.beat] && panels.panels[c.beat]?.source === "photo");
    split = { panels, panel_images: images, panel_credits: usedCredits };
    // 4) the speaker cut out over a designed background (MediaPipe matte, cached per rough cut)
    const mode = opts.cutout ?? design.split.cutout;
    if (mode !== "off") {
      const g = cutoutGeometry(1080, 1920, design.split.seam, design.split.pop_out);
      const rough = path.join(dir, `rough_${outputId}.mp4`);
      const r = await resolveCutout(mode, rough, path.join(dir, "design", `${outputId}-cutout`), { width: g.width, height: g.height, overlap: g.overlap, bg: design.split.panel_bg, accent: design.split.accent }, { onLog: opts.onLog && ((l) => opts.onLog!(`    ${l}`)) });
      warnings.push(...r.warnings);
      if (r.cutout) {
        const c = r.cutout;
        opts.onLog?.(`    вырезание фона: ${c.cached ? "из кэша" : `${c.stats.timings.wall_seconds.toFixed(0)} с (${c.stats.timings.realtime_factor}× реального времени)`}, спикер ${Math.round(c.stats.coverage.median * 100)}% кадра`);
        const o = c.stats.output as { y0: number; scaled_height?: number };
        Object.assign(split, { cutout: { plate: c.plate, ...(c.pop ? { pop: c.pop } : {}), width: c.width, plate_height: c.plateHeight, overlap: c.overlap, y0: o.y0, ...(o.scaled_height ? { scaled_height: o.scaled_height } : {}) } });
      }
    }
  }
  // stage 23: the face track of the rough cut (the framing after crop and punch-ins), mapped into the composition frame
  let faces: FaceTrack | undefined;
  if (design.captions.avoid_face && opts.faces !== "off") {
    const rough = path.join(dir, `rough_${outputId}.mp4`);
    const clips = usedClips.map((c, i) => ({ ...c, out_start: timeline.clips[i]?.out_start ?? 0, out_end: timeline.clips[i]?.out_end ?? 0 }));
    const r = await resolveFaceTrack({ rough, cacheDir: path.join(dir, "design", `${outputId}-faces`), clips, scenes, media, aspect: output.aspect }, { ...(opts.faces === "scenes" ? { python: null } : {}), onLog: opts.onLog && ((l) => opts.onLog!(`    ${l}`)) });
    warnings.push(...r.warnings);
    if (r.track.source === "mediapipe") opts.onLog?.(`    лица: ${r.cached ? "из кэша" : `${r.seconds?.toFixed(0) ?? "?"} с`}, лицо в ${Math.round((r.track.samples.filter((x) => x.boxes.length).length / Math.max(1, r.track.samples.length)) * 100)}% кадров`);
    faces = r.track;
    if (design.layout === "split" && faces.source !== "none") {
      const W = timeline.width;
      const H = timeline.height;
      const cut = (split as { cutout?: DesignJob["cutout"] }).cutout;
      const view: FrameView =
        cut && cut.y0 !== undefined
          ? { kind: "cutout", seam: design.split.seam, overlap: cut.overlap, y0: cut.y0, layerW: cut.width, scaledH: cut.scaled_height ?? Math.round((H * cut.width) / W), frameW: W, frameH: H }
          : { kind: "split", seam: design.split.seam, offsetPct: videoOffset(faceY, H, Math.round(design.split.seam * H)), frameW: W, frameH: H, roughW: W, roughH: H };
      faces = toOutputFrame(faces, view);
    }
  }
  // stage 27: B-roll inserts (full-frame layout only; split has its own panels)
  let inserts: InsertsTrack | undefined;
  const wantInserts = opts.inserts === "on" || (opts.inserts !== "off" && design.inserts.enabled);
  if (wantInserts && design.layout !== "split" && spokenPhrases.length) {
    design.inserts.enabled = true;
    try {
      const insDir = path.join(dir, "design", `${outputId}-inserts`);
      // the hook title at the start stays alone on screen until the first insert (reel #14: title 0–2.3 s, cutaway at 2.27 s)
      const hook = timeline.titles.find((t) => t.at < 0.5);
      const track = await buildInserts(
        { jobId, phrases: spokenPhrases, ...(hook ? { hookEnd: hook.at + hook.duration } : {}), duration: timeline.duration, language: spokenPhrases[0]?.lang ?? transcript.language, design, ...(faces ? { faces } : {}), hints: output.insert_hints ?? [], dir: insDir, W: timeline.width, H: timeline.height, fps: timeline.fps },
        { ...opts.insertOptions, onLog: opts.insertOptions?.onLog ?? (opts.onLog && ((l) => opts.onLog!(`    ${l}`))) },
      );
      inserts = track;
      const first = track.items.find((i) => i.kind !== "chips");
      if (hook && first && first.start < hook.at + hook.duration) hook.duration = Math.max(1.5, Math.round((first.start - hook.at) * 1000) / 1000);
      const st = track.stats;
      opts.onLog?.(`    вставки: ${st.scheduled} из ${st.candidates} кандидатов, ${Math.round(st.coverage * 100)}% времени, ${Math.round(st.first40 * 100)}% в первых 40%`);
      for (const it of track.items) opts.onLog?.(`      ${it.start.toFixed(2)}–${it.end.toFixed(2)} ${it.kind} «${it.word}» ${it.label}`);
      await fs.mkdir(insDir, { recursive: true });
      await fs.writeFile(path.join(dir, "design", `${outputId}.inserts.json`), JSON.stringify(track, null, 1));
      const usd = st.gemini.usd + st.vision.usd;
      if (st.gemini.calls || st.vision.requests) await addCost(jobId, { step: "design", provider: "gemini", model: st.gemini.model || "gemini-flash-lite", units: { inserts: st.scheduled, text_calls: st.gemini.calls, vision_requests: st.vision.requests, site_captures: st.captures.ok - st.captures.cached }, usd });
    } catch (err) {
      warnings.push(`вставки не построены: ${err instanceof Error ? err.message.split(/\r?\n/)[0] : String(err)}`);
    }
  } else if (opts.inserts === "on" && design.layout === "split") warnings.push("вставки в сплите не делаются: там свои панели");
  return { job_id: jobId, rough_path: path.join(dir, `rough_${outputId}.mp4`), timeline, pages, design, preset: preset.name, captions_language: target, translated, warnings, ...(faceY !== undefined ? { face_y: faceY } : {}), ...split, ...(faces ? { faces } : {}), ...(inserts ? { inserts } : {}) };
}

/** Duration-weighted mean of the clips' focus y (each clip's focus = overlap-weighted scene focus); undefined without any focus. */
export function faceCentreY(clips: { src_start: number; src_end: number }[], scenes: Scenes): number | undefined {
  let sum = 0;
  let weight = 0;
  for (const c of clips) {
    const f = clipFocus(c, scenes);
    if (!f) continue;
    const w = Math.max(0, c.src_end - c.src_start);
    sum += f.y * w;
    weight += w;
  }
  return weight > 0 ? Math.round((sum / weight) * 1000) / 1000 : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("design", "export.ts"))) {
  const args = process.argv.slice(2);
  const translate = args.includes("--translate");
  const [jobId, outputId, out] = args.filter((a) => !a.startsWith("--"));
  if (!jobId || !outputId) throw new Error("usage: tsx src/design/export.ts <job_id> <output_id> [out.json] [--translate]");
  const job = await exportDesignJob(jobId, outputId, { translate });
  const text = JSON.stringify(job, null, 2);
  if (out) await fs.writeFile(out, text);
  else process.stdout.write(text);
}

/** "Фото (Openverse): …" lines for the split panels of these outputs (CC BY needs attribution in the description). */
export async function panelCreditsText(jobId: string, outputIds: string[]): Promise<string> {
  const lines: string[] = [];
  for (const id of outputIds) {
    const f = path.join(jobDir(jobId), "design", `${id}-panels`, "credits.json");
    if (!(await exists(f))) continue;
    try {
      const credits = JSON.parse(await fs.readFile(f, "utf8")) as PhotoCredit[];
      for (const c of credits) if (await exists(c.file)) lines.push(photoCreditLine(c));
    } catch {}
  }
  const uniq = [...new Set(lines)];
  return uniq.length ? `Фото (Openverse): ${uniq.join("; ")}` : "";
}
