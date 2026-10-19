import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { serverForced } from "./server.ts";

/**
 * Which LLM provider runs a text step (stage 29): Claude (API key or, off-server, the Claude Code login) or
 * Gemini (GEMINI_API_KEY). Nothing in the pipeline depends on Claude alone any more.
 *
 *   VEDIT_LLM=auto|claude|gemini            — every LLM step (default auto)
 *   VEDIT_LLM_<STEP>=auto|claude|gemini     — one step: PLANNER, SCRIPT, DESIGN, TRANSLATE, SHORTLIST, HIGHLIGHTS, AVATAR, PANELS
 *   VEDIT_LLM_FALLBACK=on|off               — a Claude failure (auth / quota / overload / network) retries the step on Gemini once (default on)
 *
 * auto = Claude when ANTHROPIC_API_KEY (or the Claude Code login outside server mode) is there, else Gemini when
 * GEMINI_API_KEY is there, else a clear error.
 */

export type LlmProvider = "claude" | "gemini";
export type LlmChoice = "auto" | LlmProvider;
export type LlmStep = "planner" | "script" | "design" | "translate" | "shortlist" | "highlights" | "avatar" | "panels";

export class LlmUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailable";
  }
}

/** Existence of the Claude Code login file is the only probe; the file is never read. */
export function claudeLoginExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return existsSync(path.join(dir, ".credentials.json"));
}

/**
 * The Claude Code subscription can be used: CLAUDE_CODE_OAUTH_TOKEN or the login file — never in server
 * mode (VEDIT_SERVER=1), where only ANTHROPIC_API_KEY counts.
 */
export function claudeLoginAvailable(env: NodeJS.ProcessEnv = process.env, loginExists: () => boolean = () => claudeLoginExists(env)): boolean {
  if (serverForced(env)) return false;
  return Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) || loginExists();
}

export function claudeKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

export function claudeAvailable(env: NodeJS.ProcessEnv = process.env, loginExists?: () => boolean): boolean {
  return claudeKey(env) || claudeLoginAvailable(env, loginExists);
}

/** GEMINI_API_KEY (or GOOGLE_API_KEY, as for TTS and vision) */
export function geminiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || null;
}

function parseChoice(raw: string | undefined, name: string): LlmChoice | null {
  const v = raw?.trim().toLowerCase();
  if (!v) return null;
  if (v === "auto" || v === "claude" || v === "gemini") return v;
  if (v === "anthropic") return "claude";
  if (v === "google") return "gemini";
  throw new LlmUnavailable(`${name}: ожидается auto | claude | gemini, получено "${raw}"`);
}

/** The configured choice for a step: VEDIT_LLM_<STEP>, then VEDIT_LLM, then auto. */
export function llmChoice(step?: LlmStep, env: NodeJS.ProcessEnv = process.env): LlmChoice {
  const own = step ? parseChoice(env[`VEDIT_LLM_${step.toUpperCase()}`], `VEDIT_LLM_${step.toUpperCase()}`) : null;
  return own ?? parseChoice(env.VEDIT_LLM, "VEDIT_LLM") ?? "auto";
}

export function fallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.VEDIT_LLM_FALLBACK?.trim().toLowerCase();
  return !v || !["0", "off", "false", "no"].includes(v);
}

export interface ProviderPick {
  provider: LlmProvider;
  choice: LlmChoice;
  reason: string;
  /** the provider to retry on when this one fails with auth / quota / overload (null: none) */
  fallback: LlmProvider | null;
}

/** Resolves the provider of a step; throws LlmUnavailable with a hint when nothing can run it. */
export function resolveLlmProvider(step?: LlmStep, env: NodeJS.ProcessEnv = process.env, probe: { loginExists?: () => boolean } = {}): ProviderPick {
  const choice = llmChoice(step, env);
  const hasClaude = claudeAvailable(env, probe.loginExists);
  const hasGemini = Boolean(geminiKey(env));
  const varName = step && env[`VEDIT_LLM_${step.toUpperCase()}`]?.trim() ? `VEDIT_LLM_${step.toUpperCase()}` : "VEDIT_LLM";
  const fb = (p: LlmProvider): LlmProvider | null => (p === "claude" && hasGemini && fallbackEnabled(env) ? "gemini" : null);
  if (choice === "gemini") {
    if (!hasGemini) throw new LlmUnavailable(`${varName}=gemini, но нет GEMINI_API_KEY в .env`);
    return { provider: "gemini", choice, reason: `${varName}=gemini`, fallback: null };
  }
  if (choice === "claude") {
    if (!hasClaude) throw new LlmUnavailable(serverForced(env) ? `${varName}=claude, но в серверном режиме нужен ANTHROPIC_API_KEY` : `${varName}=claude, но нет ANTHROPIC_API_KEY и входа Claude Code`);
    return { provider: "claude", choice, reason: `${varName}=claude`, fallback: fb("claude") };
  }
  if (hasClaude) return { provider: "claude", choice, reason: claudeKey(env) ? "auto: ANTHROPIC_API_KEY" : "auto: вход Claude Code", fallback: fb("claude") };
  if (hasGemini) return { provider: "gemini", choice, reason: "auto: нет Claude, есть GEMINI_API_KEY", fallback: null };
  throw new LlmUnavailable(
    serverForced(env)
      ? "серверный режим (VEDIT_SERVER=1): нет ни ANTHROPIC_API_KEY, ни GEMINI_API_KEY — нужен хотя бы один ключ модели в .env (достаточно GEMINI_API_KEY)"
      : "нет ANTHROPIC_API_KEY, входа Claude Code и GEMINI_API_KEY: задайте один из ключей в .env (достаточно GEMINI_API_KEY) или выполните `claude /login`",
  );
}

/**
 * Is this failure of a Claude call worth one retry on Gemini? Auth / billing / quota / overload / network —
 * yes; a refusal, an invalid answer or a budget stop — no (Gemini would not fix those, or must not bypass them).
 */
export function isProviderFailure(err: unknown): boolean {
  const e = err as { status?: number; code?: string; name?: string; message?: string } | null;
  if (!e) return false;
  if (["refusal", "budget", "invalid", "loop", "max_tokens", "contract", "nothing_to_plan", "missing_inputs"].includes(e.code ?? "")) return false;
  if (e.code === "auth" || e.code === "rate_limit" || e.code === "network" || e.code === "no_backend") return true;
  if (typeof e.status === "number" && [401, 402, 403, 404, 408, 429, 500, 502, 503, 504, 529].includes(e.status)) return true;
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") return true;
  return /authenticat|unauthori[sz]ed|permission|invalid x-api-key|api[_ ]key|credit balance|billing|quota|rate[_ ]?limit|overload|too many requests|\b(401|403|429|500|502|503|529)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket hang up|oauth|not logged in|login/i.test(e.message ?? "");
}
