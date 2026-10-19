import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { EdlSchema, type Edl } from "../schemas/index.ts";
import { exportDesignJob, type ExportOptions } from "../design/export.ts";
import { CutReportSchema } from "../cut/index.ts";
import type { OverlayRenderer, RenderQuality } from "../design/renderer.ts";
import { finalizeOutput, measureLoudness, outputPath } from "./finalize.ts";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { bedStart } from "../audio/beats.ts";
import { loadJob } from "../lib/workspace.ts";
import { loadPreset } from "../plan/presets.ts";
import { mixSoundtrack, speechRangesFrom } from "../audio/mix.ts";
import { isMood, pickMusic, type Mood, type MusicTrack } from "../audio/music.ts";
import { SFX_KINDS, thinCues, type SfxCue } from "../audio/sfx.ts";
import { styledPreset } from "../style/profile.ts";

export const RenderReportSchema = z.object({
  renderer: z.string(),
  quality: z.string(),
  outputs: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["ok", "failed", "skipped"]),
      output: z.string().optional(),
      preview: z.string().optional(),
      duration: z.number().optional(),
      loudness_before: z.number().optional(),
      loudness_after: z.number().optional(),
      captions_language: z.string().nullable().optional(),
      translated: z.boolean().optional(),
      pages: z.number().int().optional(),
      build_seconds: z.number().optional(),
      render_seconds: z.number().optional(),
      finalize_seconds: z.number().optional(),
      music: z.string().optional(),
      music_attribution: z.string().optional(),
      /** stage 27: B-roll inserts (count, share of the runtime, description credits) */
      inserts: z.object({ count: z.number(), coverage: z.number(), first40: z.number(), by_kind: z.record(z.string(), z.number()), credits: z.array(z.string()) }).optional(),
      warnings: z.array(z.string()).default([]),
      error: z.string().optional(),
    }),
  ),
  wall_seconds: z.number(),
});
export type RenderReport = z.infer<typeof RenderReportSchema>;

export interface RenderOptions extends ExportOptions {
  renderer: OverlayRenderer;
  only?: string[];
  quality?: RenderQuality;
  onEvent?: (line: string) => void;
  /** keep the generated project directories (default: kept under workspace/<job>/design/<id>/) */
  edl?: Edl;
  /**
   * background music under the speech (ducked): "auto" (mood from the preset's pace), a mood, a file
   * or "none". Default: on when the EDL output asks for music or the preset's music_default is set.
   */
  music?: string;
}

/** Music track for a montage output, or null (decided once per job and reused by every output). */
async function montageMusic(jobId: string, want: string, pace: string, fallbackMood?: Mood): Promise<MusicTrack | null> {
  if (want === "none") return null;
  if (want !== "auto" && !isMood(want)) {
    if (!(await exists(want))) throw new Error(`музыка не найдена: ${want}`);
    return { file: path.resolve(want), title: path.parse(want).name, creator: "", license: "own", source: "file", url: "", attribution: "" };
  }
  const mood: Mood = want === "auto" ? (fallbackMood ?? (pace === "calm" ? "chill" : "upbeat")) : (want as Mood);
  return pickMusic(mood, jobId, { minSeconds: 30 });
}

/**
 * DESIGN + RENDER for every output of a job: design job → renderer project → overlay MP4 →
 * loudness-normalised output_<id>.mp4 + preview. Outputs are independent; one failure does not stop the others.
 */
export async function renderOutputs(jobId: string, opts: RenderOptions): Promise<RenderReport & { partial: boolean }> {
  const t0 = Date.now();
  const dir = jobDir(jobId);
  const edl = opts.edl ?? (await readJson(path.join(dir, "edl.json"), EdlSchema));
  const quality = opts.quality ?? "looks";
  if (opts.only) {
    const unknown = opts.only.filter((id) => !edl.outputs.some((o) => o.id === id));
    if (unknown.length) throw new Error(`неизвестные выходы: ${unknown.join(", ")} (в плане: ${edl.outputs.map((o) => o.id).join(", ")})`);
  }
  const targets = opts.only ? edl.outputs.filter((o) => opts.only!.includes(o.id)) : edl.outputs;
  const report: RenderReport = { renderer: opts.renderer.name, quality, outputs: [], wall_seconds: 0 };

  const cutFile = path.join(dir, "cut.json");
  const cutReport = (await exists(cutFile)) ? await readJson(cutFile, CutReportSchema) : null;
  const meta = await loadJob(jobId);
  const { preset, mapping: styleMapping } = await styledPreset(jobId, (await loadPreset(opts.preset ?? meta.preset ?? "bold_pop")).preset);
  let track: MusicTrack | null | undefined; // undefined = not looked up yet
  const bedOffsets = new Map<string, number>(); // music file → start (downbeat after the intro), per reel length

  for (const output of targets) {
    const warnings: string[] = [];
    const rough = path.join(dir, `rough_${output.id}.mp4`);
    const cutRecord = cutReport?.outputs.find((o) => o.id === output.id);
    if (!(await exists(rough)) || (cutRecord && cutRecord.status !== "ok")) {
      report.outputs.push({ id: output.id, status: "skipped", warnings, error: cutRecord && cutRecord.status !== "ok" ? `нарезка ${output.id} не удалась (${cutRecord.error ?? "см. cut.json"}) — старый rough не используется` : `нет ${path.basename(rough)} — сначала vedit cut` });
      continue;
    }
    try {
      opts.onEvent?.(`▸ design ${output.id}`);
      const tb = Date.now();
      const job = await exportDesignJob(jobId, output.id, { translate: opts.translate ?? true, llm: opts.llm, model: opts.model, preset: opts.preset, panelImages: opts.panelImages, cutout: opts.cutout, onLog: opts.onEvent, ...(opts.inserts ? { inserts: opts.inserts } : {}), ...(opts.insertOptions ? { insertOptions: opts.insertOptions } : {}) });
      warnings.push(...job.warnings);
      const projectDir = path.join(dir, "design", output.id);
      await fs.rm(projectDir, { recursive: true, force: true });
      await fs.mkdir(projectDir, { recursive: true });
      const built = await opts.renderer.build(job, projectDir);
      warnings.push(...(built.notes ?? []));
      const buildSeconds = (Date.now() - tb) / 1000;

      opts.onEvent?.(`▸ render ${output.id} (${opts.renderer.name}, ${quality})`);
      const overlay = path.join(projectDir, `overlay_${output.id}.mp4`);
      const rendered = await opts.renderer.render(projectDir, overlay, { quality, onLine: (l) => opts.onEvent?.(`    ${l}`) });

      const tf = Date.now();
      const fin = await finalizeOutput(rendered.file, rough, outputPath(dir, output.id), { previewAt: (job.timeline.titles[0]?.at ?? 0.5) + 0.6 });
      // background music, ducked under the speech
      // reference style: the reference decides (stage 23 — its measured music beats the plan's music.enabled, which
      // followed an older DNA); otherwise the plan or the preset
      // stage 27: an expert preset (music "off": clean_min, box_reveal) never gets a bed unless --music asks for one
      const wantMusic = opts.music ?? (output.audio?.music ?? (styleMapping ? (styleMapping.audio.music ? "auto" : "none") : preset.music === "off" ? "none" : output.music.enabled || preset.music_default ? "auto" : "none"));
      const plan = output.audio; // sound design decided at plan time (highlights)
      const planned = (output.sfx ?? []).filter((c): c is SfxCue => (SFX_KINDS as readonly string[]).includes(c.kind));
      const cues = job.inserts?.cues.length ? thinCues([...planned, ...job.inserts.cues], { duration: job.timeline.duration, max: 200 }) : planned;
      let musicNote: { music?: string; music_attribution?: string } = {};
      if (wantMusic !== "none") {
        if (track === undefined) {
          try {
            track = await montageMusic(jobId, wantMusic, preset.pace, plan?.music ? "sport" : undefined);
          } catch (err) {
            track = null;
            warnings.push(err instanceof Error ? err.message : String(err));
          }
          if (!track) warnings.push("музыка не найдена (нет assets/music и нет доступа к Openverse)");
        }
        if (track) {
          // stage 23: the montage bed starts on a downbeat past the intro, follows the speech (no side-chain pumping),
          // fades over the last clip, and the whole mix gets a linear trim to −14 LUFS instead of a dynamic loudnorm
          let musicOffset = plan?.music_offset;
          if (!plan) {
            const key = `${track.file}|${Math.round(fin.duration)}`;
            if (!bedOffsets.has(key)) {
              try {
                const trackSeconds = Number((await ffprobe(track.file)).format.duration) || 0;
                bedOffsets.set(key, (await bedStart(track.file, trackSeconds, fin.duration)).offset);
              } catch {
                bedOffsets.set(key, 0);
              }
            }
            musicOffset = bedOffsets.get(key);
          }
          const words = job.timeline.phrases.flatMap((p) => p.words);
          const lastClip = job.timeline.clips[job.timeline.clips.length - 1];
          opts.onEvent?.(`    музыка: «${track.title}»${track.creator ? ` — ${track.creator}` : ""} (${track.license})${!plan && musicOffset ? `, с ${musicOffset.toFixed(1)} с (сильная доля)` : ""}`);
          const tmp = fin.output.replace(/\.mp4$/i, ".music.mp4");
          await mixSoundtrack(
            plan
              ? { video: fin.output, out: tmp, duration: fin.duration, music: track.file, speech: false, musicOffset: plan.music_offset, musicLufs: plan.music_lufs, origGainDb: plan.orig_gain_db, duck: plan.duck, sfx: cues }
              : {
                  video: fin.output,
                  out: tmp,
                  duration: fin.duration,
                  music: track.file,
                  speech: true,
                  sfx: cues,
                  ...(musicOffset ? { musicOffset } : {}),
                  ...(words.length ? { speechRanges: speechRangesFrom(words) } : {}),
                  ...(lastClip ? { musicFadeOut: lastClip.out_end - lastClip.out_start } : {}),
                  noFinalLoudnorm: true,
                  ...(output.music_duck_db !== undefined ? { musicUnderSpeechDb: output.music_duck_db } : {}),
                },
          );
          await fs.rename(tmp, fin.output);
          // the mix normalises in one pass (dynamic loudnorm lands within ~1 LU): a linear trim brings a planned mix to the target
          {
            const m = await measureLoudness(fin.output);
            // always through the limiter: the one-pass mix can leave true peaks above 0 dBFS even when the level is right
            if (Number.isFinite(m.input_i)) {
              const trimmed = fin.output.replace(/\.mp4$/i, ".trim.mp4");
              await ffmpeg(["-i", fin.output, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", `volume=${(-14 - m.input_i).toFixed(2)}dB,alimiter=limit=0.71:level=false`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-movflags", "+faststart", trimmed]);
              await fs.rename(trimmed, fin.output);
            }
          }
          musicNote = { music: track.file, music_attribution: track.attribution };
        }
      }
      if (!musicNote.music && cues.length) {
        // effects without a music bed (reference style: whooshes on the punch-ins, no music in the reference)
        const tmp = fin.output.replace(/\.mp4$/i, ".sfx.mp4");
        await mixSoundtrack({ video: fin.output, out: tmp, duration: fin.duration, music: null, speech: true, sfx: cues });
        await fs.rename(tmp, fin.output);
      }
      report.outputs.push({
        id: output.id,
        status: "ok",
        output: fin.output,
        preview: fin.preview,
        duration: fin.duration,
        loudness_before: fin.loudness_before,
        loudness_after: fin.loudness_after,
        captions_language: job.captions_language,
        translated: job.translated,
        pages: job.pages.length,
        build_seconds: buildSeconds,
        render_seconds: rendered.seconds,
        finalize_seconds: (Date.now() - tf) / 1000,
        ...musicNote,
        ...(job.inserts ? { inserts: { count: job.inserts.items.length, coverage: job.inserts.stats.coverage, first40: job.inserts.stats.first40, by_kind: job.inserts.stats.by_kind, credits: job.inserts.credits } } : {}),
        warnings,
      });
    } catch (err) {
      report.outputs.push({ id: output.id, status: "failed", warnings, error: err instanceof Error ? err.message : String(err) });
    }
  }

  report.wall_seconds = (Date.now() - t0) / 1000;
  // render.json keeps the records of outputs a --only run did not touch
  const reportFile = path.join(dir, "render.json");
  let stored: RenderReport = report;
  if (opts.only && (await exists(reportFile))) {
    const previous = await readJson(reportFile, RenderReportSchema);
    const touched = new Set(report.outputs.map((o) => o.id));
    stored = { ...report, outputs: [...previous.outputs.filter((o) => !touched.has(o.id) && edl.outputs.some((e) => e.id === o.id)), ...report.outputs] };
  }
  await writeJson(reportFile, RenderReportSchema, stored);
  const failed = report.outputs.filter((o) => o.status !== "ok").length;
  if (targets.length > 0 && failed === targets.length) {
    throw new Error(`все выходы не отрендерились:\n${report.outputs.map((o) => `  ${o.id}: ${o.error}`).join("\n")}`);
  }
  return { ...report, partial: failed > 0 };
}
