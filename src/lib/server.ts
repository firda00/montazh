/**
 * Server mode: the bot runs on a machine where only API keys exist (no Antigravity CLI with a Google
 * login, no Claude Code subscription login). Under server mode providers never try those logins:
 *   Claude      → Claude API (ANTHROPIC_API_KEY), never the Agent SDK login; without a key the LLM steps run on Gemini (stage 29)
 *   trends      → Gemini API + Google Search grounding (GEMINI_API_KEY), never agy
 *   AI images   → Gemini image model over the API, never agy
 *   vision      → Gemini API (as before), never agy
 *   max jobs    → 1 by default (VEDIT_MAX_JOBS overrides)
 *
 * VEDIT_SERVER=1 forces it, VEDIT_SERVER=0 forbids it; unset = auto: on when there is no `agy` on PATH
 * and no Claude Code login (that is exactly a fresh server). The flag is sync (read in sync selectors);
 * the auto-detection is async (it looks up agy on PATH).
 */

/** true / false when VEDIT_SERVER is set, null when it is not (auto). */
export function serverFlag(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = env.VEDIT_SERVER?.trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`VEDIT_SERVER: ожидается 1 или 0, получено "${env.VEDIT_SERVER}"`);
}

/** VEDIT_SERVER=1: logins (agy, Claude Code) are off-limits. Sync; a bad value counts as "not forced". */
export function serverForced(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return serverFlag(env) === true;
  } catch {
    return false;
  }
}

export interface ServerMode {
  on: boolean;
  /** "env": VEDIT_SERVER set; "auto": decided from what is installed */
  source: "env" | "auto";
  reason: string;
}

/** Server mode with auto-detection (no agy and no Claude Code login → on). Probes are injectable for tests. */
export async function detectServerMode(env: NodeJS.ProcessEnv = process.env, probe: { agy?: () => Promise<string | null>; login?: () => boolean } = {}): Promise<ServerMode> {
  const flag = serverFlag(env);
  if (flag !== null) return { on: flag, source: "env", reason: flag ? "VEDIT_SERVER=1" : "VEDIT_SERVER=0" };
  const agy = await (probe.agy ?? (async () => (await import("../understand/vision/agy.ts")).findAgy(env)))();
  const login = probe.login ? probe.login() : !!env.CLAUDE_CODE_OAUTH_TOKEN || (await import("../plan/backend/index.ts")).claudeLoginExists(env);
  if (!agy && !login) return { on: true, source: "auto", reason: "нет agy и входа Claude Code — только ключи API" };
  return { on: false, source: "auto", reason: [agy ? "agy найден" : "", login ? "вход Claude Code найден" : ""].filter(Boolean).join(", ") };
}
