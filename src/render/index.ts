import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { EdlSchema, type Edl } from "../schemas/index.ts";
import { exportDesignJob, type ExportOptions } from "../design/export.ts";
import { CutReportSchema } from "../cut/index.ts";
import type { OverlayRenderer, RenderQuality } from "../design/renderer.ts";
import { finalizeOutput, outputPath } from "./finalize.ts";

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
      const job = await exportDesignJob(jobId, output.id, { translate: opts.translate ?? true, llm: opts.llm, model: opts.model });
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
