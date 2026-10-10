import { StubVisionProvider } from "./stub.ts";
import type { VisionProvider } from "./types.ts";

export type VisionChoice = "auto" | "stub" | "gemini";

/**
 * Picks the vision model. Gemini is wired in here once its API is integrated
 * (stage 2b); until then every choice resolves to the stub and says so.
 */
export function selectVisionProvider(choice: VisionChoice = "auto"): { provider: VisionProvider; note: string } {
  if (choice === "stub") return { provider: new StubVisionProvider(), note: "vision: stub (requested)" };
  if (!process.env.GEMINI_API_KEY) {
    return { provider: new StubVisionProvider(), note: "vision: stub — GEMINI_API_KEY not set" };
  }
  return { provider: new StubVisionProvider(), note: "vision: stub — Gemini provider not implemented yet" };
}

export * from "./types.ts";
