import { DEFAULT_GEMINI_MODEL, GeminiVisionProvider, type MediaResolution } from "./gemini.ts";
import { StubVisionProvider } from "./stub.ts";
import type { VisionProvider } from "./types.ts";

export type VisionChoice = "auto" | "stub" | "gemini";

/**
 * Picks the vision model: Gemini when GEMINI_API_KEY is set (or explicitly requested),
 * otherwise the honest stub. Model and frame resolution come from VEDIT_VISION_MODEL / VEDIT_VISION_RESOLUTION.
 */
export function selectVisionProvider(choice: VisionChoice = "auto", env: NodeJS.ProcessEnv = process.env): { provider: VisionProvider; note: string } {
  if (choice === "stub") return { provider: new StubVisionProvider(), note: "vision: stub (requested)" };
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    if (choice === "gemini") throw new Error("--vision gemini: GEMINI_API_KEY не задан (ключ — aistudio.google.com/apikey, в .env)");
    return { provider: new StubVisionProvider(), note: "vision: stub — GEMINI_API_KEY not set" };
  }
  const model = env.VEDIT_VISION_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const res = (env.VEDIT_VISION_RESOLUTION?.trim() || "default") as MediaResolution;
  if (!["low", "medium", "high", "default"].includes(res)) throw new Error(`VEDIT_VISION_RESOLUTION: ожидается low | medium | high, получено "${res}"`);
  const provider = new GeminiVisionProvider({ apiKey, model, mediaResolution: res });
  return { provider, note: `vision: gemini (${model}${res !== "default" ? `, ${res} res` : ""})` };
}

export * from "./types.ts";
export { DEFAULT_GEMINI_MODEL, GEMINI_PRICES, GeminiVisionProvider } from "./gemini.ts";
