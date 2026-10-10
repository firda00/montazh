import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { ToolError } from "@anthropic-ai/sdk/lib/tools/ToolError";
import { z } from "zod";
import type { CallUsage } from "../../schemas/index.ts";
import { normalizeUsage, usdForUsage } from "../pricing.ts";
import { zodToApiSchema } from "../schema-sanitize.ts";
import { PlanError, type PlannerBackend, type PlannerTool, type StartRequest, type Turn } from "./types.ts";

interface Handle {
  history: Anthropic.Beta.BetaMessageParam[];
  unsentToolResult: boolean; // history ends with a tool_result message the model has not seen (max_iterations stop)
}

export interface ApiBackendOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  cacheTtl?: "5m" | "1h";
  client?: Anthropic;
  fallbacks?: boolean; // VEDIT_FALLBACKS=1 — a rescue runs on another model, unpriced
}

type ApiTools = ReturnType<typeof buildTools>;

function buildTools(tools: PlannerTool[]) {
  return tools
    .map((t) => ({
      ...betaZodTool({
        name: t.name,
        description: t.description,
        inputSchema: z.object(t.inputShape),
        run: async (args, c) => {
          const r = await t.run(args, { signal: c?.signal ?? undefined });
          if (r.isError) throw new ToolError(r.text);
          if (r.images?.length) {
            return [
              { type: "text" as const, text: r.text },
              ...r.images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mediaType, data: i.base64 } })),
            ];
          }
          return r.text;
        },
      }),
      input_schema: zodToApiSchema(z.object(t.inputShape)) as { type: "object"; [k: string]: unknown },
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Claude API through the SDK's beta tool runner. Needs ANTHROPIC_API_KEY (or an `ant auth login`
 * profile). Request layout keeps tools + system + pack byte-stable so repairs and revise are cache reads.
 */
export class AnthropicApiBackend implements PlannerBackend {
  readonly name = "api";
  readonly model: string;
  readonly note = "backend: api — Claude API (ANTHROPIC_API_KEY)";
  private readonly client: Anthropic;
  // adapters are built once per tool list (a contract fallback passes a new list with submit_edl and fresh state)
  private readonly toolCache = new WeakMap<PlannerTool[], ApiTools>();
  private requests = 0;

  constructor(private readonly opts: ApiBackendOptions) {
    this.model = opts.model;
    // explicit timeout: the SDK then allows max_tokens 32000 non-streaming
    this.client = opts.client ?? new Anthropic({ maxRetries: 3, timeout: 600_000 });
  }

  private apiTools(req: StartRequest): ApiTools {
    let t = this.toolCache.get(req.tools);
    if (!t) {
      t = buildTools(req.tools);
      this.toolCache.set(req.tools, t);
    }
    return t;
  }

  private cacheMark() {
    return this.opts.cacheTtl === "1h" ? ({ type: "ephemeral", ttl: "1h" } as const) : ({ type: "ephemeral" } as const);
  }

  async start(req: StartRequest): Promise<Turn> {
    const seed: Anthropic.Beta.BetaMessageParam[] = [
      {
        role: "user",
        content: [
          { type: "text", text: req.packText, cache_control: this.cacheMark() },
          { type: "text", text: req.taskText },
        ],
      },
    ];
    return this.runTurn(req, seed, req.maxTokens);
  }

  async continue(prev: Turn, userText: string, req: StartRequest): Promise<Turn> {
    const h = prev.handle as Handle;
    const history = [...h.history];
    const last = history[history.length - 1];
    if (h.unsentToolResult && last?.role === "user" && Array.isArray(last.content)) {
      // the trailing tool_result message was never sent, so appending to it is not a history edit
      history[history.length - 1] = { role: "user", content: [...last.content, { type: "text", text: userText }] };
    } else {
      history.push({ role: "user", content: userText });
    }
    return this.runTurn(req, history, req.maxTokens);
  }

  private async runTurn(req: StartRequest, messages: Anthropic.Beta.BetaMessageParam[], maxTokens: number): Promise<Turn> {
    const perCall: CallUsage[] = [];
    const useFormat = req.contract === "format";
    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.model,
        max_tokens: maxTokens,
        max_iterations: Math.max(1, Math.min(8, req.budget.remainingCalls())),
        stream: false as const,
        output_config: { effort: this.opts.effort, ...(useFormat ? { format: { type: "json_schema" as const, schema: req.draftJsonSchema } } : {}) },
        cache_control: { type: "ephemeral" as const },
        system: [{ type: "text", text: req.system, cache_control: this.cacheMark() }],
        tools: this.apiTools(req),
        messages,
        ...(this.opts.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      },
      { signal: req.budget.signal },
    );

    let last: Anthropic.Beta.BetaMessage | null = null;
    let stopped: Turn["stopReason"] | null = null;
    try {
      for await (const message of runner) {
        this.requests += 1;
        const priced = usdForUsage(message.model, message.usage);
        req.budget.addRequest(priced.usd);
        perCall.push({
          model: message.model,
          usage: normalizeUsage(message.usage),
          ...priced,
          stop_reason: message.stop_reason,
          tools: message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use").map((b) => b.name),
        });
        last = message;
        // only a message that asks for more tool work is worth stopping over; a finished answer is kept
        if (message.stop_reason === "tool_use" && req.budget.exceeded()) {
          // in the submit contract the finished plan arrives as a submit_edl call: run it locally
          // (free, no further request) so the submission is recorded before stopping
          if (message.content.some((b) => b.type === "tool_use" && b.name === "submit_edl")) await runner.generateToolResponse();
          stopped = "budget";
          break; // no further request is made; nothing more is appended to runner.params.messages
        }
      }
    } catch (err) {
      return this.mapError(err, req, perCall, messages);
    }

    const history = stopped ? messages : [...runner.params.messages];
    const base = { calls: perCall.length, perCall, charged: true };
    if (!last) return { text: null, stopReason: "error", error: "no response", ...base, handle: { history, unsentToolResult: false } satisfies Handle };
    if (stopped) return { text: null, stopReason: stopped, ...base, handle: { history, unsentToolResult: false } satisfies Handle };

    const text = last.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n") || null;
    switch (last.stop_reason) {
      case "end_turn":
      case "stop_sequence":
        return { text, stopReason: "end_turn", ...base, handle: { history, unsentToolResult: false } satisfies Handle };
      case "max_tokens": {
        if (maxTokens < 32_000 && !req.budget.exceeded()) {
          // retry once with more room from the point the turn reached: tool results already in the
          // history stay; only the truncated assistant message (received, never sent back) is dropped
          const resume = history[history.length - 1]?.role === "assistant" ? history.slice(0, -1) : history;
          const retry = await this.runTurn(req, resume, 32_000);
          return { ...retry, calls: retry.calls + perCall.length, perCall: [...perCall, ...retry.perCall] };
        }
        return { text, stopReason: "max_tokens", ...base, handle: { history, unsentToolResult: false } satisfies Handle };
      }
      case "refusal":
        return { text: null, stopReason: "refusal", refusalCategory: last.stop_details?.category ?? undefined, ...base, handle: { history, unsentToolResult: false } satisfies Handle };
      case "tool_use":
        // max_iterations: the runner executed this message's tools and appended their results, which the model has not seen yet
        return { text: null, stopReason: "max_iterations", ...base, handle: { history, unsentToolResult: true } satisfies Handle };
      default:
        return { text, stopReason: "end_turn", ...base, handle: { history, unsentToolResult: false } satisfies Handle };
    }
  }

  private mapError(err: unknown, req: StartRequest, perCall: CallUsage[], messages: Anthropic.Beta.BetaMessageParam[]): Turn {
    const base = { calls: perCall.length, perCall, charged: true, handle: { history: messages, unsentToolResult: false } satisfies Handle, text: null };
    if (err instanceof Anthropic.AuthenticationError) return { ...base, stopReason: "error", errorCode: "auth", error: err.message };
    if (err instanceof Anthropic.NotFoundError) return { ...base, stopReason: "error", errorCode: "model", error: `model ${this.model}: ${err.message}` };
    if (err instanceof Anthropic.RateLimitError) return { ...base, stopReason: "error", errorCode: "rate_limit", error: err.message };
    if (err instanceof Anthropic.BadRequestError) {
      if (this.requests === 0 && req.contract === "format" && req.tools.length > 0) {
        // feature detection on the very first request of the job: the API may reject
        // output_config.format together with client tools → the caller switches contract
        throw new PlanError(`API rejected output_config.format with client tools: ${err.message}`, "contract", { status: err.status, perCall });
      }
      return { ...base, stopReason: "error", errorCode: "api", error: err.message };
    }
    if (err instanceof Anthropic.APIUserAbortError) return { ...base, stopReason: "budget", error: "aborted (wall clock)" };
    if (err instanceof Anthropic.APIConnectionError) return { ...base, stopReason: "error", errorCode: "network", error: err.message };
    if (err instanceof Anthropic.APIError) return { ...base, stopReason: "error", errorCode: "api", error: `${err.status ?? ""} ${err.message}`.trim() };
    if (err instanceof PlanError) throw err;
    return { ...base, stopReason: "error", errorCode: "api", error: err instanceof Error ? err.message : String(err) };
  }
}
