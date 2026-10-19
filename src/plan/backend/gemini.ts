import { z } from "zod";
import type { CallUsage } from "../../schemas/index.ts";
import { GeminiCallError } from "../../lib/gemini-rest.ts";
import {
  answerText,
  BLOCKED_FINISH,
  generateWithFallback,
  geminiTextUsd,
  plannerModels,
  servedModel,
  thinkingLevel,
  toGeminiSchema,
  type GeminiContent,
  type GeminiPart,
  type GeminiResponse,
} from "../../lib/gemini-llm.ts";
import { zodToApiSchema } from "../schema-sanitize.ts";
import { PlanError, type PlannerBackend, type PlannerTool, type StartRequest, type ToolResult, type Turn } from "./types.ts";

interface Handle {
  contents: GeminiContent[];
  /** contents end with a functionResponse turn the model has not seen (max_iterations / budget stop) */
  unsentToolResult: boolean;
}

export interface GeminiBackendOptions {
  key: string;
  /** a gemini-* id is tried first; a Claude id (the shared --model / VEDIT_PLANNER_MODEL) is ignored */
  model?: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  env?: NodeJS.ProcessEnv;
  /** explicit model list (tests); default VEDIT_GEMINI_PLANNER_MODEL → 3.8-flash → 3.6-flash → 3.5-flash */
  models?: string[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  verbose?: boolean;
}

type Decl = { name: string; description: string; parameters: Record<string, unknown> };

/** a signature Gemini accepts on function calls it did not produce itself (conversation moved to another model) */
const FOREIGN_SIGNATURE = "skip_thought_signature_validator";

/** A tool's text result → the functionResponse.response object (JSON objects as they are, anything else wrapped). */
export function toResponseObject(r: ToolResult): Record<string, unknown> {
  if (r.isError) return { error: r.text };
  try {
    const v = JSON.parse(r.text) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    return { result: v };
  } catch {
    return { result: r.text };
  }
}

/**
 * Planner on the Gemini API (stage 29): the same contract as the Claude API backend — the planner tools
 * (transcript ranges, scene details, preview frames, validate_edl, submit_edl) run through Gemini function
 * calling (generateContent + functionDeclarations, toolConfig AUTO), the final answer is the structured
 * PlanDraft (responseSchema, contract "format") or a submit_edl call (contract "submit"); the loop above
 * validates it with the same resolver and sends repair rounds through continue(). Every request is priced
 * and charged to the BudgetTracker; 429 / 503 / 404 move to the next model of the list.
 */
export class GeminiPlannerBackend implements PlannerBackend {
  readonly name = "gemini";
  readonly model: string;
  readonly note: string;
  private readonly models: string[];
  private readonly dead = new Set<string>();
  private readonly declCache = new WeakMap<PlannerTool[], Decl[]>();
  private schemaCache: { src: Record<string, unknown>; out: Record<string, unknown> } | null = null;
  private requests = 0;
  /** the model that wrote the model turns of the current conversation (thought signatures belong to it) */
  private author: string | null = null;

  constructor(private readonly opts: GeminiBackendOptions) {
    this.models = opts.models ?? plannerModels(opts.env ?? process.env, opts.model);
    this.model = this.models[0];
    this.note = `backend: gemini — Gemini API (GEMINI_API_KEY), модель ${this.model}${this.models.length > 1 ? ` (запасные: ${this.models.slice(1).join(", ")})` : ""}`;
  }

  private decls(tools: PlannerTool[]): Decl[] {
    let d = this.declCache.get(tools);
    if (!d) {
      d = tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(zodToApiSchema(z.object(t.inputShape))) })).sort((a, b) => a.name.localeCompare(b.name));
      this.declCache.set(tools, d);
    }
    return d;
  }

  private responseSchema(src: Record<string, unknown>) {
    if (this.schemaCache?.src !== src) this.schemaCache = { src, out: toGeminiSchema(src) };
    return this.schemaCache.out;
  }

  async start(req: StartRequest): Promise<Turn> {
    this.author = null;
    return this.runTurn(req, [{ role: "user", parts: [{ text: req.packText }, { text: req.taskText }] }], req.maxTokens);
  }

  async continue(prev: Turn, userText: string, req: StartRequest): Promise<Turn> {
    const h = (prev.handle as Handle | null) ?? { contents: [], unsentToolResult: false };
    const contents = [...h.contents];
    const last = contents[contents.length - 1];
    // a trailing user turn (unsent function responses, or a final answer that was never stored) is extended, not duplicated
    if (last?.role === "user") contents[contents.length - 1] = { role: "user", parts: [...last.parts, { text: userText }] };
    else contents.push({ role: "user", parts: [{ text: userText }] });
    return this.runTurn(req, contents, req.maxTokens);
  }

  private log(line: string) {
    if (this.opts.verbose) console.error(`  ${line}`);
  }

  /** a conversation written by another model: its thought signatures would not validate → mark them foreign */
  private transform = (model: string, body: Record<string, unknown>) => {
    if (!this.author || this.author === model) return body;
    const contents = (body.contents as GeminiContent[]).map((c) =>
      c.role !== "model" ? c : { ...c, parts: c.parts.map((p) => (p.functionCall ? { ...p, thoughtSignature: FOREIGN_SIGNATURE } : p.thoughtSignature ? (({ thoughtSignature: _s, ...rest }) => rest)(p) : p)) },
    );
    return { ...body, contents };
  };

  private async runTurn(req: StartRequest, start: GeminiContent[], maxTokens: number): Promise<Turn> {
    const contents = [...start];
    const perCall: CallUsage[] = [];
    const decls = this.decls(req.tools);
    const useFormat = req.contract === "format";
    const maxIter = Math.max(1, Math.min(8, req.budget.remainingCalls()));
    const base = () => ({ calls: perCall.length, perCall, charged: true as const });
    const handle = (unsent: boolean): Handle => ({ contents, unsentToolResult: unsent });
    let malformed = 0;

    for (let iter = 0; iter < maxIter; iter++) {
      if (iter > 0 && req.budget.exceeded()) return { text: null, stopReason: "budget", ...base(), handle: handle(true) };
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: req.system }] },
        contents,
        ...(decls.length ? { tools: [{ functionDeclarations: decls }], toolConfig: { functionCallingConfig: { mode: "AUTO" } } } : {}),
        generationConfig: {
          maxOutputTokens: maxTokens,
          thinkingConfig: { thinkingLevel: thinkingLevel(this.opts.effort) },
          ...(useFormat ? { responseMimeType: "application/json", responseSchema: this.responseSchema(req.draftJsonSchema) } : {}),
        },
      };
      let json: GeminiResponse;
      let model: string;
      try {
        ({ json, model } = await generateWithFallback(this.models, body, { key: this.opts.key, fetch: this.opts.fetch, signal: req.budget.signal, dead: this.dead, sleep: this.opts.sleep, maxWait: 65, transform: this.transform, onEvent: (l) => this.log(l) }));
      } catch (err) {
        return this.mapError(err, req, perCall, contents);
      }
      this.requests += 1;
      const served = servedModel(json, model);
      const priced = geminiTextUsd(served, json.usageMetadata);
      req.budget.addRequest(priced.usd);
      const cand = json.candidates?.[0];
      const parts: GeminiPart[] = cand?.content?.parts ?? [];
      const calls = parts.filter((p) => p.functionCall);
      const finish = cand?.finishReason ?? (json.promptFeedback?.blockReason ? "BLOCKED" : null);
      perCall.push({ model: served, usage: priced.usage, usd: priced.usd, priced: priced.priced, stop_reason: finish, tools: calls.map((p) => p.functionCall!.name) });

      const blocked = json.promptFeedback?.blockReason ?? (finish && BLOCKED_FINISH.has(finish) ? finish : null);
      if (blocked) return { text: null, stopReason: "refusal", refusalCategory: blocked, ...base(), handle: handle(false) };

      if (!calls.length) {
        const text = answerText(parts) || null;
        if (finish === "MAX_TOKENS") {
          // retry once with more room from the same point (the truncated answer is never sent back)
          if (maxTokens < 32_000 && !req.budget.exceeded()) {
            const retry = await this.runTurn(req, contents, 32_000);
            return { ...retry, calls: retry.calls + perCall.length, perCall: [...perCall, ...retry.perCall] };
          }
          return { text, stopReason: "max_tokens", ...base(), handle: handle(false) };
        }
        if (!text && malformed < 1 && (finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL" || finish === "STOP" || finish === "OTHER")) {
          // a broken function call or an empty answer: say so once and let the model try again
          malformed += 1;
          const nudge = finish === "MALFORMED_FUNCTION_CALL" || finish === "UNEXPECTED_TOOL_CALL" ? "Your last function call was malformed (invalid arguments). Call the tool again with valid JSON arguments, or give the final answer." : "Your reply was empty. Give the final answer now.";
          const last = contents[contents.length - 1];
          if (last?.role === "user") contents[contents.length - 1] = { role: "user", parts: [...last.parts, { text: nudge }] };
          else contents.push({ role: "user", parts: [{ text: nudge }] });
          continue;
        }
        if (parts.length) contents.push({ role: "model", parts });
        this.author = model;
        return { text, stopReason: "end_turn", ...base(), handle: handle(false) };
      }

      contents.push({ role: "model", parts });
      this.author = model;
      const responses: GeminiPart[] = [];
      for (const p of calls) {
        const fc = p.functionCall!;
        const tool = req.tools.find((t) => t.name === fc.name);
        let r: ToolResult;
        if (!tool) r = { text: `unknown tool ${fc.name}; available: ${req.tools.map((t) => t.name).join(", ")}`, isError: true };
        else {
          try {
            r = await tool.run(fc.args ?? {}, { signal: req.budget.signal });
          } catch (err) {
            r = { text: `tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        }
        responses.push({
          functionResponse: {
            name: fc.name,
            ...(fc.id ? { id: fc.id } : {}),
            response: toResponseObject(r),
            ...(r.images?.length ? { parts: r.images.map((i) => ({ inlineData: { mimeType: i.mediaType, data: i.base64 } })) } : {}),
          },
        });
      }
      contents.push({ role: "user", parts: responses });
      // in the submit contract an accepted submit_edl is already recorded by the tool: stopping here loses nothing
      if (req.budget.exceeded()) return { text: null, stopReason: "budget", ...base(), handle: handle(true) };
    }
    return { text: null, stopReason: "max_iterations", ...base(), handle: handle(true) };
  }

  private mapError(err: unknown, req: StartRequest, perCall: CallUsage[], contents: GeminiContent[]): Turn {
    const base = { calls: perCall.length, perCall, charged: true, text: null, handle: { contents, unsentToolResult: false } satisfies Handle };
    if (req.budget.signal.aborted) return { ...base, stopReason: "budget", error: "aborted (wall clock)" };
    if (err instanceof GeminiCallError) {
      if (err.kind === "auth") return { ...base, stopReason: "error", errorCode: "auth", error: `Gemini: ${err.message}` };
      if (err.kind === "quota") return { ...base, stopReason: "error", errorCode: "rate_limit", error: `Gemini: ${err.message}` };
      if (err.kind === "transient") return { ...base, stopReason: "error", errorCode: err.status === 0 ? "network" : "rate_limit", error: `Gemini: ${err.message}` };
      if (err.status === 404) return { ...base, stopReason: "error", errorCode: "model", error: `Gemini: ${err.message}` };
      if (err.status === 400 && this.requests === 0 && req.contract === "format" && req.tools.length > 0) {
        // the very first request of the job: this model may not take responseSchema together with tools → submit contract
        throw new PlanError(`Gemini rejected responseSchema with tools: ${err.message}`, "contract", { status: err.status, perCall });
      }
      return { ...base, stopReason: "error", errorCode: "api", error: `Gemini: ${err.message}` };
    }
    if (err instanceof PlanError) throw err;
    return { ...base, stopReason: "error", errorCode: "api", error: err instanceof Error ? err.message : String(err) };
  }
}
