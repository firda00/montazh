import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { claudeLoginExists, DEFAULT_MODEL } from "../plan/backend/index.ts";
import { PlanError } from "../plan/backend/types.ts";
import { normalizeUsage, usdForUsage } from "../plan/pricing.ts";
import type { PlanUsage } from "../schemas/index.ts";

export interface StructuredQuery {
  system: string;
  prompt: string;
  /** JSON Schema (already sanitized) the answer must follow */
  schema: Record<string, unknown>;
  model?: string;
  effort?: "low" | "medium" | "high";
  maxBudgetUsd?: number;
  maxTokens?: number;
}

export interface StructuredResult {
  data: unknown;
  usage: PlanUsage;
  usd: number;
  /** true when usd is the Agent SDK's estimate rather than a priced API call */
  estimate: boolean;
  model: string;
  provider: "anthropic" | "agent" | "mock";
}

export type StructuredFn = (q: StructuredQuery) => Promise<StructuredResult>;

/**
 * One structured-output call without tools, for small jobs such as caption translation.
 * Uses the Claude API when a key is present, otherwise the Claude Code login (Agent SDK).
 */
export function selectStructuredLlm(env: NodeJS.ProcessEnv = process.env): StructuredFn {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return anthropicStructured;
  if (env.CLAUDE_CODE_OAUTH_TOKEN || claudeLoginExists(env)) return agentStructured;
  throw new PlanError("нет ANTHROPIC_API_KEY и нет входа Claude Code — перевод субтитров недоступен", "no_backend");
}

function stripFences(text: string) {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  return m ? m[1] : text;
}

export const anthropicStructured: StructuredFn = async (q) => {
  const client = new Anthropic({ maxRetries: 3, timeout: 300_000 });
  const model = q.model ?? DEFAULT_MODEL;
  const res = await client.messages.create({
    model,
    max_tokens: q.maxTokens ?? 8000,
    system: q.system,
    output_config: { effort: q.effort ?? "low", format: { type: "json_schema", schema: q.schema } },
    messages: [{ role: "user", content: q.prompt }],
  });
  if (res.stop_reason === "refusal") throw new PlanError("модель отказалась выполнять запрос", "refusal");
  const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
  const priced = usdForUsage(res.model, res.usage);
  return { data: JSON.parse(stripFences(text)), usage: normalizeUsage(res.usage), usd: priced.usd, estimate: false, model: res.model, provider: "anthropic" };
};

export const agentStructured: StructuredFn = async (q) => {
  const model = q.model ?? DEFAULT_MODEL;
  const options: Options = {
    systemPrompt: q.system,
    model,
    effort: q.effort ?? "low",
    thinking: { type: "adaptive" },
    outputFormat: { type: "json_schema", schema: q.schema },
    tools: [],
    strictMcpConfig: true,
    permissionMode: "dontAsk",
    settingSources: [],
    maxTurns: 2,
    maxBudgetUsd: q.maxBudgetUsd ?? 0.5,
    cwd: os.tmpdir(),
    env: { ...process.env, CLAUDE_CODE_PROJECT_DIR_NAME: "vedit" },
  };
  let usage: PlanUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
  let usd = 0;
  let data: unknown;
  let text = "";
  let usedModel = model;
  for await (const m of query({ prompt: q.prompt, options }) as AsyncIterable<SDKMessage>) {
    if (m.type !== "result") continue;
    usd = m.total_cost_usd;
    for (const [name, u] of Object.entries(m.modelUsage ?? {})) {
      usedModel = name;
      usage = {
        input_tokens: usage.input_tokens + u.inputTokens,
        output_tokens: usage.output_tokens + u.outputTokens,
        cache_read_input_tokens: usage.cache_read_input_tokens + u.cacheReadInputTokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens + u.cacheCreationInputTokens,
        thinking_tokens: usage.thinking_tokens + (u.thinkingTokens ?? 0),
      };
    }
    if (m.subtype === "success") {
      if (m.structured_output != null) data = m.structured_output;
      else text = m.result;
    } else throw new PlanError(`структурированный запрос не удался: ${m.subtype}${"errors" in m && m.errors?.length ? ` — ${m.errors.join("; ")}` : ""}`, "api");
  }
  if (data === undefined) {
    if (!text) throw new PlanError("модель не вернула ответ", "api");
    data = JSON.parse(stripFences(text));
  }
  return { data, usage, usd, estimate: true, model: usedModel, provider: "agent" };
};
