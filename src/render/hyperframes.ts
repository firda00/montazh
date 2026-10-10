import fs from "node:fs/promises";
import path from "node:path";
import { exists } from "../lib/workspace.ts";
import type { DesignJob } from "../design/export.ts";
import type { BuildResult, OverlayRenderer, RenderQuality, RenderResult } from "../design/renderer.ts";
import { buildLayout, loadFontMetrics } from "../design/layout.ts";
import { HF_BIN, ROOT, writeHyperframesProject } from "../design/hyperframes/project.ts";
import { describeFinding, parseLintJson, parseProgress, runCli } from "./cli-runner.ts";
import { currentSystem, planWorkers, type WorkerPlan } from "./workers.ts";

export interface HyperFramesOptions {
  bin?: string;
  /** explicit worker count; otherwise planned from free memory */
  workers?: number;
  framesCacheDir?: string;
  fontFile?: string;
  gsapFile?: string;
  /** render timeout as a multiple of the output duration (plus 60 s) */
  timeoutFactor?: number;
}

export const QUALITY_FLAG: Record<RenderQuality, string> = { draft: "draft", looks: "looks", delivery: "delivery" };

export class HyperFramesRenderer implements OverlayRenderer {
  readonly name = "hyperframes";
  private readonly bin: string;
  lastPlan: WorkerPlan | null = null;

  constructor(private readonly opts: HyperFramesOptions = {}) {
    this.bin = opts.bin ?? HF_BIN;
  }

  async prepare() {
    if (!(await exists(this.bin))) throw new Error(`hyperframes CLI not found at ${this.bin} — run npm install`);
  }

  async build(job: DesignJob, projectDir: string): Promise<BuildResult> {
    const fontFile = this.opts.fontFile ?? path.join(ROOT, job.design.font.file);
    const metrics = await loadFontMetrics(fontFile, { family: job.design.font.family, weight: job.design.font.weight });
    const layout = buildLayout(job, metrics);
    const project = await writeHyperframesProject(job, layout, projectDir, { fontFile, gsapFile: this.opts.gsapFile });
    const notes: string[] = [];
    if (metrics.source === "heuristic") notes.push(`шрифт ${fontFile} не прочитан — ширины слов оценены эвристически`);

    const lint = await runCli(this.bin, ["lint", "--json"], projectDir);
    const parsed = parseLintJson(lint.stdout);
    await fs.writeFile(path.join(projectDir, "lint.json"), parsed ? JSON.stringify(parsed, null, 1) : lint.stdout + lint.stderr);
    if (!parsed) throw new Error(`hyperframes lint не вернул JSON (exit ${lint.code}): ${(lint.stderr || lint.stdout).slice(-400)}`);
    const findings = parsed.findings ?? [];
    if (parsed.errorCount > 0 || !parsed.ok) {
      const errs = findings.filter((f) => (f.severity ?? "error") === "error").map(describeFinding);
      throw new Error(`композиция не прошла lint (${parsed.errorCount} ошибок):\n  ${errs.join("\n  ")}`);
    }
    for (const f of findings.filter((f) => f.severity === "warning")) notes.push(`lint: ${describeFinding(f)}`);
    return { entry: project.entry, notes };
  }

  async render(projectDir: string, outFile: string, o: { quality: RenderQuality; onLine?: (line: string) => void; signal?: AbortSignal }): Promise<RenderResult> {
    const plan = planWorkers(currentSystem(), this.opts.workers);
    this.lastPlan = plan;
    const layoutText = await fs.readFile(path.join(projectDir, "layout.json"), "utf8").catch(() => "");
    const frame = layoutText ? ((JSON.parse(layoutText) as { frame?: { duration?: number; fps?: number } }).frame ?? {}) : {};
    const args = ["render", "--quality", QUALITY_FLAG[o.quality], "-o", outFile, "-w", String(plan.workers), plan.lowMemory ? "--low-memory-mode" : "--no-low-memory-mode", "--quiet"];
    if (frame.fps) args.push("-f", String(frame.fps));
    if (this.opts.framesCacheDir) args.push("--frames-cache-dir", this.opts.framesCacheDir);
    o.onLine?.(`воркеров: ${plan.workers}${plan.lowMemory ? " (low-memory)" : ""}, свободно ${plan.freeMemMB} MB`);

    const timeoutMs = ((frame.duration ?? 60) * (this.opts.timeoutFactor ?? 6) + 60) * 1000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const onAbort = () => ac.abort();
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const t0 = Date.now();
    let lastPct = -1;
    const log: string[] = [];
    try {
      const res = await runCli(
        this.bin,
        args,
        projectDir,
        (line) => {
          log.push(line);
          const p = parseProgress(line);
          if (p) {
            const bucket = Math.floor(p.pct / 25) * 25;
            if (bucket !== lastPct) {
              lastPct = bucket;
              o.onLine?.(`${p.code} ${p.pct}%`);
            }
          } else if (/rendered in|Error|error:/i.test(line)) o.onLine?.(line.slice(0, 200));
        },
        ac.signal,
      );
      const seconds = (Date.now() - t0) / 1000;
      await fs.writeFile(path.join(projectDir, "render.log"), log.join("\n"));
      if (res.code !== 0 || !(await exists(outFile))) {
        throw new Error(`hyperframes render завершился с кодом ${res.code}${ac.signal.aborted ? " (таймаут/отмена)" : ""}: ${log.filter((l) => /error/i.test(l)).slice(-5).join(" | ").slice(0, 500)}`);
      }
      return { file: outFile, seconds, log: log.join("\n") };
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    }
  }
}
