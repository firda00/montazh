import { AgyVisionProvider, DEFAULT_AGY_MODEL, findAgy } from "./agy.ts";
import { DEFAULT_GEMINI_MODEL, GeminiVisionProvider, type MediaResolution } from "./gemini.ts";
import { StubVisionProvider } from "./stub.ts";
import type { VisionProvider } from "./types.ts";

export type VisionChoice = "auto" | "stub" | "gemini" | "agy";

/**
 * Picks the vision model.
 *   gemini — Gemini API (GEMINI_API_KEY)
 *   agy    — Antigravity CLI with the Google login (no key; frames are viewed by the agent)
 *   stub   — honest no-model fallback
 * `auto` (or VEDIT_VISION unset) prefers the API key, then the CLI when it is installed, then the stub.
 * Model and frame resolution come from VEDIT_VISION_MODEL / VEDIT_VISION_RESOLUTION.
 */
export async function selectVisionProvider(choice: VisionChoice = "auto", env: NodeJS.ProcessEnv = process.env, probe: { agy?: () => Promise<string | null> } = {}): Promise<{ provider: VisionProvider; note: string }> {
  const want: VisionChoice = choice === "auto" ? ((env.VEDIT_VISION?.trim() || "auto") as VisionChoice) : choice;
  if (!["auto", "stub", "gemini", "agy"].includes(want)) throw new Error(`VEDIT_VISION: ожидается auto | stub | gemini | agy, получено "${want}"`);
  if (want === "stub") return { provider: new StubVisionProvider(), note: "vision: stub (requested)" };

  const apiKey = env.GEMINI_API_KEY?.trim();
  const model = env.VEDIT_VISION_MODEL?.trim();
  if (want === "gemini" || (want === "auto" && apiKey)) {
    if (!apiKey) throw new Error("--vision gemini: GEMINI_API_KEY не задан (ключ — aistudio.google.com/apikey, в .env); без ключа есть --vision agy (Antigravity CLI)");
    const res = (env.VEDIT_VISION_RESOLUTION?.trim() || "default") as MediaResolution;
    if (!["low", "medium", "high", "default"].includes(res)) throw new Error(`VEDIT_VISION_RESOLUTION: ожидается low | medium | high, получено "${res}"`);
    const m = model || DEFAULT_GEMINI_MODEL;
    return { provider: new GeminiVisionProvider({ apiKey, model: m, mediaResolution: res }), note: `vision: gemini (${m}${res !== "default" ? `, ${res} res` : ""})` };
  }

  const bin = await (probe.agy ?? (() => findAgy(env)))();
  if (want === "agy" || (want === "auto" && bin)) {
    if (!bin) throw new Error("--vision agy: Antigravity CLI (agy) не найден в PATH — установите Antigravity и войдите в Google-аккаунт, или задайте VEDIT_AGY_BIN");
    const m = model || DEFAULT_AGY_MODEL;
    return { provider: new AgyVisionProvider({ bin, model: m }), note: `vision: antigravity-cli (${m}, вход Google, без ключа)` };
  }
  return { provider: new StubVisionProvider(), note: "vision: stub — GEMINI_API_KEY not set and agy not installed" };
}

export * from "./types.ts";
export { DEFAULT_GEMINI_MODEL, GEMINI_PRICES, GeminiVisionProvider } from "./gemini.ts";
export { AgyVisionProvider, DEFAULT_AGY_MODEL, findAgy } from "./agy.ts";
