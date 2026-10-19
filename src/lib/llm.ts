import os from "node:os";
import Anthropic from "@anthropic-ai/sdk";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DEFAULT_MODEL } from "../plan/backend/index.ts";
import { PlanError } from "../plan/backend/types.ts";
import { normalizeUsage, usdForUsage } from "../plan/pricing.ts";
import type { PlanUsage } from "../schemas/index.ts";
import { GeminiCallError } from "./gemini-rest.ts";
import { answerText, BLOCKED_FINISH, generateWithFallback, geminiTextUsd, reviveEncoded, servedModel, textModels, thinkingLevel, toGeminiSchema, type GeminiContent } from "./gemini-llm.ts";
import { claudeKey, geminiKey, isProviderFailure, LlmUnavailable, resolveLlmProvider, type LlmStep } from "./llm-provider.ts";

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
  /** false when the model has no price table entry (usd is then 0, not a real figure) */
  priced?: boolean;
  model: string;
  provider: "anthropic" | "agent" | "gemini" | "mock";
}

export type StructuredFn = (q: StructuredQuery) => Promise<StructuredResult>;

export interface SelectLlmOptions {
  /** test hooks */
  fetch?: typeof fetch;
  claude?: StructuredFn;
  onEvent?: (line: string) => void;
  loginExists?: () => boolean;
}

/**
 * One structured-output call without tools (script, art director, translation, shortlist, highlights editor…).
 * Provider (stage 29): VEDIT_LLM_<STEP> / VEDIT_LLM = auto | claude | gemini — auto takes Claude (API key, else the
 * Claude Code login outside server mode), else Gemini (GEMINI_API_KEY). With VEDIT_LLM_FALLBACK on (default) a
 * Claude call that fails on auth / quota / overload / network is retried once on Gemini, and the switch is logged.
 */
export function selectStructuredLlm(env: NodeJS.ProcessEnv = process.env, step?: LlmStep, o: SelectLlmOptions = {}): StructuredFn {
  let pick;
  try {
    pick = resolveLlmProvider(step, env, { loginExists: o.loginExists });
  } catch (err) {
    if (err instanceof LlmUnavailable) throw new PlanError(err.message, "no_backend");
    throw err;
  }
  const gemini = () => makeGeminiStructured({ key: geminiKey(env)!, env, fetch: o.fetch, onEvent: o.onEvent });
  if (pick.provider === "gemini") return gemini();
  const claude = o.claude ?? (claudeKey(env) ? anthropicStructured : agentStructured);
  if (!pick.fallback) return claude;
  return withFallback(claude, gemini(), o.onEvent ?? ((l) => console.error(`  ${l}`)), step);
}

/** Claude first; on a provider failure (not a refusal or a bad answer) the same query once on Gemini. */
export function withFallback(primary: StructuredFn, backup: StructuredFn, log: (line: string) => void, step?: string): StructuredFn {
  return async (q) => {
    try {
      return await primary(q);
    } catch (err) {
      if (!isProviderFailure(err)) throw err;
      const why = err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : String(err);
      log(`⚠ Claude недоступен${step ? ` (${step})` : ""}: ${why} → повтор на Gemini`);
      const { model: _claudeModel, ...rest } = q;
      return backup(rest);
    }
  };
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
  return { data: JSON.parse(stripFences(text)), usage: normalizeUsage(res.usage), usd: priced.usd, estimate: false, priced: priced.priced, model: res.model, provider: "anthropic" };
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
  let assistantErr: string | undefined;
  const errCode = (): "auth" | "rate_limit" | "api" => (assistantErr === "authentication_failed" || assistantErr === "oauth_org_not_allowed" ? "auth" : assistantErr === "rate_limit" ? "rate_limit" : "api");
  for await (const m of query({ prompt: q.prompt, options }) as AsyncIterable<SDKMessage>) {
    if (m.type === "assistant") {
      const err = (m as { error?: string }).error;
      // auth / rate limit / billing surface here: kept so a failed result carries a code the caller can fall back on
      if (err) assistantErr = err;
      continue;
    }
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
    } else throw new PlanError(`структурированный запрос не удался: ${m.subtype}${"errors" in m && m.errors?.length ? ` — ${m.errors.join("; ")}` : ""}${assistantErr ? ` (${assistantErr})` : ""}`, errCode());
  }
  if (data === undefined) {
    if (!text) throw new PlanError(`модель не вернула ответ${assistantErr ? ` (${assistantErr})` : ""}`, errCode());
    data = JSON.parse(stripFences(text));
  }
  return { data, usage, usd, estimate: true, model: usedModel, provider: "agent" };
};

// ---------------------------------------------------------------- Gemini

export interface GeminiStructuredOptions {
  key: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  models?: string[];
  onEvent?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const ZERO: PlanUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
const addUsage = (a: PlanUsage, b: PlanUsage): PlanUsage => ({
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  thinking_tokens: a.thinking_tokens + b.thinking_tokens,
});

function mapGeminiError(err: unknown): never {
  if (err instanceof GeminiCallError) {
    const code = err.kind === "auth" ? "auth" : err.kind === "quota" ? "rate_limit" : err.kind === "transient" ? "network" : "api";
    throw new PlanError(`Gemini: ${err.message}`, code, { status: err.status });
  }
  throw err;
}

/**
 * Gemini StructuredFn: generateContent with responseSchema = toGeminiSchema(q.schema), model list with fallback
 * (VEDIT_GEMINI_LLM_MODEL → 3.8-flash → 3.6-flash → 3.5-flash). One repair round when the answer is blocked,
 * truncated or not JSON; when the API rejects the schema itself, the same request goes once more without
 * responseSchema (JSON mode, the schema spelled out in the prompt). A Claude model id in q.model is ignored.
 */
export function makeGeminiStructured(o: GeminiStructuredOptions): StructuredFn {
  const dead = new Set<string>();
  return async (q) => {
    const models = o.models ?? textModels(o.env ?? process.env, q.model);
    const gschema = toGeminiSchema(q.schema);
    let usage = ZERO;
    let usd = 0;
    let priced = true;
    let lastModel = models[0];
    let schemaInPrompt = false;
    const contents: GeminiContent[] = [{ role: "user", parts: [{ text: q.prompt }] }];
    const maxOut = Math.max(8192, (q.maxTokens ?? 8000) * 2);

    const call = async () => {
      const generationConfig: Record<string, unknown> = {
        responseMimeType: "application/json",
        ...(schemaInPrompt ? {} : { responseSchema: gschema }),
        maxOutputTokens: maxOut,
        thinkingConfig: { thinkingLevel: thinkingLevel(q.effort ?? "low") },
      };
      const system = schemaInPrompt ? `${q.system}\n\nAnswer with one JSON object that follows this JSON Schema exactly:\n${JSON.stringify(q.schema)}` : q.system;
      const { json, model } = await generateWithFallback(models, { systemInstruction: { parts: [{ text: system }] }, contents, generationConfig }, { key: o.key, fetch: o.fetch, onEvent: o.onEvent, dead, sleep: o.sleep });
      lastModel = servedModel(json, model);
      const p = geminiTextUsd(lastModel, json.usageMetadata);
      usage = addUsage(usage, p.usage);
      usd += p.usd;
      priced = priced && p.priced;
      return json;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      let json;
      try {
        json = await call();
      } catch (err) {
        // the API did not take the converted schema: once more in plain JSON mode
        if (err instanceof GeminiCallError && err.status === 400 && !schemaInPrompt && /schema|response_schema|responseSchema|INVALID_ARGUMENT/i.test(err.message)) {
          o.onEvent?.(`Gemini не принял responseSchema (${err.message.slice(0, 120)}) → JSON-режим со схемой в промпте`);
          schemaInPrompt = true;
          attempt -= 1;
          continue;
        }
        mapGeminiError(err);
      }
      const cand = json.candidates?.[0];
      const blocked = json.promptFeedback?.blockReason || (cand?.finishReason && BLOCKED_FINISH.has(cand.finishReason) ? cand.finishReason : null);
      const text = answerText(cand?.content?.parts);
      let problem: string;
      if (blocked) problem = `the answer was blocked (${blocked})`;
      else if (!text) problem = `no answer text (finishReason ${cand?.finishReason ?? "?"})`;
      else {
        try {
          const data = reviveEncoded(JSON.parse(stripFences(text)), gschema);
          return { data, usage, usd, estimate: false, priced, model: lastModel, provider: "gemini" };
        } catch (err) {
          problem = `${cand?.finishReason === "MAX_TOKENS" ? "the answer was cut by the token limit; be more concise. " : ""}not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (attempt === 1) {
        if (blocked) throw new PlanError(`Gemini отказался отвечать (${blocked})`, "refusal");
        throw new PlanError(`Gemini вернул невалидный ответ: ${problem}`, "invalid");
      }
      // one repair round, appended to the same conversation
      if (text && !blocked) contents.push({ role: "model", parts: [{ text }] });
      contents.push({
        role: "user",
        parts: [{ text: blocked ? `${q.prompt}\n\n(This is a routine video-editing / content task. Answer with the JSON object only.)` : `Your previous answer could not be used: ${problem}. Return the complete answer again as one JSON object that follows the schema, nothing else.` }],
      });
      if (blocked) contents.splice(0, contents.length - 1);
    }
    throw new PlanError("Gemini не вернул ответ", "api");
  };
}
