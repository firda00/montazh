import { meanLoudness } from "../loudness.ts";
import type { AnalysisChunk, AnalysisContext, VisionProvider, VisionResult } from "./types.ts";

/**
 * No-model fallback. It never invents what is in the frame: every descriptive field is
 * marked unknown, and highlights are ranked only from measurable audio signals —
 * complete phrases, their length and loudness. Gemini replaces this provider.
 */
export class StubVisionProvider implements VisionProvider {
  readonly name = "stub";

  async analyze(chunk: AnalysisChunk, ctx: AnalysisContext): Promise<VisionResult> {
    const scenes: VisionResult["scenes"] = chunk.shots.map((s) => {
      const speech = chunk.phrases.filter((p) => p.start < s.end && p.end > s.start).map((p) => p.text).join(" ");
      const dur = (s.end - s.start).toFixed(1);
      return {
        start: s.start,
        end: s.end,
        description: speech ? `[stub] shot ${s.index}, ${dur}s, speech: "${speech}"` : `[stub] shot ${s.index}, ${dur}s, no speech`,
        objects: [],
        people_count: 0,
        emotion: "unknown",
        shot_type: "unknown",
        quality_score: 0.5,
      };
    });

    const loud = chunk.phrases.map((p) => meanLoudness(ctx.loudness, p.start, p.end));
    const known = loud.filter((l): l is number => l !== null);
    const lo = Math.min(...known, -40);
    const hi = Math.max(...known, -10);
    const highlights: VisionResult["highlights"] = chunk.phrases.map((p, i) => {
      const dur = p.end - p.start;
      const loudNorm = loud[i] === null ? 0.5 : (loud[i]! - lo) / Math.max(1, hi - lo);
      // sweet spot for a reel beat is 2–8 s
      const lenScore = dur < 1 ? 0.2 : dur <= 8 ? 1 : Math.max(0.3, 1 - (dur - 8) / 20);
      const score = Math.round((0.3 + 0.4 * loudNorm + 0.3 * lenScore) * 100) / 100;
      const reason = `[stub] complete phrase, ${dur.toFixed(1)}s${loud[i] !== null ? `, ${loud[i]!.toFixed(1)} LUFS` : ""}: "${p.text}"`;
      return { start: p.start, end: p.end, reason, score: Math.min(1, Math.max(0, score)) };
    });

    return { scenes, highlights, cost: { model: "stub", usd: 0, units: { chunk_seconds: chunk.end - chunk.start } } };
  }
}
