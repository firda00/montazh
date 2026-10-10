import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { AgentSdkBackend } from "./agent.ts";
import { AnthropicApiBackend } from "./anthropic.ts";
import { MockBackend } from "./mock.ts";
import { PlanError, type PlannerBackend } from "./types.ts";

export type BackendChoice = "auto" | "api" | "agent" | "mock";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface BackendOptions {
  model: string;
  effort: Effort;
  cacheTtl?: "5m" | "1h";
  verbose?: boolean;
}

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Existence of the Claude Code login file is the only probe; the file is never read. */
export function claudeLoginExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  return existsSync(path.join(dir, ".credentials.json"));
}

export function selectBackend(
  choice: BackendChoice,
  opts: BackendOptions,
  env: NodeJS.ProcessEnv = process.env,
  probe: { loginExists: () => boolean } = { loginExists: () => claudeLoginExists(env) },
): PlannerBackend {
  const hasKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const hasLogin = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN) || probe.loginExists();
  if (choice === "mock") return new MockBackend({ heuristic: true });
  if (choice === "api" || (choice === "auto" && hasKey)) {
    if (!hasKey) throw new PlanError("бэкенд api требует ANTHROPIC_API_KEY (или ANTHROPIC_AUTH_TOKEN) в окружении / .env", "auth");
    return new AnthropicApiBackend({ model: opts.model, effort: opts.effort, cacheTtl: opts.cacheTtl, fallbacks: env.VEDIT_FALLBACKS === "1" });
  }
  if (choice === "agent" || (choice === "auto" && hasLogin)) {
    if (!hasLogin && choice === "agent") throw new PlanError("бэкенд agent: не найден вход Claude Code (выполните `claude /login`) и нет CLAUDE_CODE_OAUTH_TOKEN", "auth");
    return new AgentSdkBackend({ model: opts.model, effort: opts.effort, verbose: opts.verbose });
  }
  throw new PlanError("нет ANTHROPIC_API_KEY и нет входа Claude Code: задайте ключ в .env, выполните `claude /login`, или передайте готовый план через --edl <file>", "no_backend");
}

export { AgentSdkBackend, AnthropicApiBackend, MockBackend };
export * from "./types.ts";
