import type { Highlights, Media, Scenes, Transcript } from "../../schemas/index.ts";
import type { Shot } from "../shots.ts";
import type { LoudnessPoint } from "../loudness.ts";

/** A slice of the video that fits in one model call (spec: 2–5 min). */
export interface AnalysisChunk {
  index: number;
  start: number;
  end: number;
  shots: Shot[];
  phrases: Transcript["segments"];
}

export interface AnalysisContext {
  media: Media;
  language: string;
  loudness: LoudnessPoint[];
}

export interface VisionResult {
  scenes: Scenes;
  highlights: Highlights;
  cost: { model: string; usd: number; units: Record<string, number> };
}

export interface VisionProvider {
  readonly name: string;
  analyze(chunk: AnalysisChunk, ctx: AnalysisContext): Promise<VisionResult>;
}
