import type { DesignJob } from "./export.ts";

export type RenderQuality = "draft" | "looks" | "delivery";

export interface BuildResult {
  /** entry file of the generated project (e.g. index.html or render.mjs) */
  entry: string;
  notes?: string[];
}

export interface RenderResult {
  /** the rendered MP4 (video + the rough cut's audio), before final loudness normalisation */
  file: string;
  seconds: number;
  log: string;
}

/**
 * A pluggable overlay renderer: turns a DesignJob into a project on disk, then into an MP4.
 * Stage 4 prototypes both HyperFrames and Remotion behind this interface.
 */
export interface OverlayRenderer {
  readonly name: string;
  build(job: DesignJob, projectDir: string): Promise<BuildResult>;
  render(projectDir: string, outFile: string, opts: { quality: RenderQuality; onLine?: (line: string) => void }): Promise<RenderResult>;
}
