import { AgentSdkBackend } from "./agent.ts";
import { AnthropicApiBackend } from "./anthropic.ts";
import { GeminiPlannerBackend } from "./gemini.ts";
import { MockBackend } from "./mock.ts";
import { PlanError, type PlannerBackend } from "./types.ts";
import { serverForced } from "../../lib/server.ts";
import { claudeKey, claudeLoginAvailable, claudeLoginExists, geminiKey, LlmUnavailable, resolveLlmProvider } from "../../lib/llm-provider.ts";

export { claudeLoginAvailable, claudeLoginExists };

/** auto | api (Claude API) | agent (Claude Code login) | gemini (Gemini API) | mock */
export type BackendChoice = "auto" | "api" | "agent" | "gemini" | "mock";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BackendOptions {
  model: string;
  effort: Effort;
  cacheTtl?: "5m" | "1h";
  verbose?: boolean;
  /** test hook: fetch for the Gemini backend */
  fetch?: typeof fetch;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

function claudeBackend(choice: "api" | "agent" | "auto", opts: BackendOptions, env: NodeJS.ProcessEnv, loginExists: () => boolean): PlannerBackend {
  const hasKey = claudeKey(env);
  const hasLogin = claudeLoginAvailable(env, loginExists);
  if (choice === "api" || (choice === "auto" && hasKey)) {
    if (!hasKey) throw new PlanError("бэкенд api требует ANTHROPIC_API_KEY (или ANTHROPIC_AUTH_TOKEN) в окружении / .env", "auth");
    return new AnthropicApiBackend({ model: opts.model, effort: opts.effort, cacheTtl: opts.cacheTtl, fallbacks: env.VEDIT_FALLBACKS === "1" });
  }
  if (choice === "agent" || hasLogin) {
    if (!hasLogin) throw new PlanError(serverForced(env) ? "бэкенд agent недоступен в серверном режиме (VEDIT_SERVER=1): нужен ANTHROPIC_API_KEY" : "бэкенд agent: не найден вход Claude Code (выполните `claude /login`) и нет CLAUDE_CODE_OAUTH_TOKEN", "auth");
    return new AgentSdkBackend({ model: opts.model, effort: opts.effort, verbose: opts.verbose });
  }
  throw new PlanError("нет ANTHROPIC_API_KEY и нет входа Claude Code", "no_backend");
}

export function geminiBackend(opts: BackendOptions, env: NodeJS.ProcessEnv = process.env): GeminiPlannerBackend {
  const key = geminiKey(env);
  if (!key) throw new PlanError("бэкенд gemini требует GEMINI_API_KEY в окружении / .env", "auth");
  return new GeminiPlannerBackend({ key, model: opts.model, effort: opts.effort, env, fetch: opts.fetch, verbose: opts.verbose });
}

/**
 * Planner backend. `auto` follows VEDIT_LLM_PLANNER / VEDIT_LLM (auto | claude | gemini): Claude (API key, else
 * the Claude Code login outside server mode), else Gemini (GEMINI_API_KEY), else a clear error.
 */
export function selectBackend(
  choice: BackendChoice,
  opts: BackendOptions,
  env: NodeJS.ProcessEnv = process.env,
  probe: { loginExists: () => boolean } = { loginExists: () => claudeLoginExists(env) },
): PlannerBackend {
  if (choice === "mock") return new MockBackend({ heuristic: true });
  if (choice === "gemini") return geminiBackend(opts, env);
  if (choice === "api" || choice === "agent") return claudeBackend(choice, opts, env, probe.loginExists);
  let pick;
  try {
    pick = resolveLlmProvider("planner", env, probe);
  } catch (err) {
    if (err instanceof LlmUnavailable) throw new PlanError(`${err.message}; или передайте готовый план через --edl <file>`, "no_backend");
    throw err;
  }
  return pick.provider === "gemini" ? geminiBackend(opts, env) : claudeBackend("auto", opts, env, probe.loginExists);
}

/** The backend a failed Claude planning run is retried on (VEDIT_LLM_FALLBACK, GEMINI_API_KEY), or null. */
export function fallbackBackend(primary: PlannerBackend, opts: BackendOptions, env: NodeJS.ProcessEnv = process.env): PlannerBackend | null {
  if (primary.name !== "api" && primary.name !== "agent") return null;
  try {
    const pick = resolveLlmProvider("planner", env, { loginExists: () => true });
    if (pick.fallback !== "gemini") return null;
  } catch {
    return null;
  }
  return geminiBackend(opts, env);
}

export { AgentSdkBackend, AnthropicApiBackend, GeminiPlannerBackend, MockBackend };
export * from "./types.ts";
