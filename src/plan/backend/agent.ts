import os from "node:os";
import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallUsage, PlanUsage } from "../../schemas/index.ts";
import { AGENT_ADDENDUM } from "../prompt.ts";
import type { PlannerBackend, StartRequest, Turn } from "./types.ts";

interface Handle {
  sessionId?: string;
  /** cumulative figures the SDK reported so far for this session (results carry running totals) */
  cumulative: { usage: PlanUsage; usd: number };
}

const ZERO_USAGE: PlanUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };

function sumInto(a: PlanUsage, b: PlanUsage): PlanUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    thinking_tokens: a.thinking_tokens + b.thinking_tokens,
  };
}

function minusUsage(a: PlanUsage, b: PlanUsage): PlanUsage {
  return {
    input_tokens: Math.max(0, a.input_tokens - b.input_tokens),
    output_tokens: Math.max(0, a.output_tokens - b.output_tokens),
    cache_read_input_tokens: Math.max(0, a.cache_read_input_tokens - b.cache_read_input_tokens),
    cache_creation_input_tokens: Math.max(0, a.cache_creation_input_tokens - b.cache_creation_input_tokens),
    thinking_tokens: Math.max(0, a.thinking_tokens - b.thinking_tokens),
  };
}

export interface AgentBackendOptions {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  verbose?: boolean;
}

/**
 * Runs the planner through the Claude Agent SDK, i.e. the bundled Claude Code CLI, which
 * uses the local Claude Code login when ANTHROPIC_API_KEY is unset. Cost figures are the
 * SDK's estimate, not a bill.
 */
export class AgentSdkBackend implements PlannerBackend {
  readonly name = "agent";
  readonly model: string;
  readonly note = "backend: agent — вход Claude Code по подписке (ANTHROPIC_API_KEY не задан); стоимость — оценка SDK, не счёт";

  constructor(private readonly opts: AgentBackendOptions) {
    this.model = opts.model;
  }

  start(req: StartRequest) {
    return this.run(req, `${req.packText}\n\n${req.taskText}`, { cumulative: { usage: ZERO_USAGE, usd: 0 } });
  }

  continue(prev: Turn, userText: string, req: StartRequest) {
    const handle = (prev.handle as Handle | null) ?? { cumulative: { usage: ZERO_USAGE, usd: 0 } };
    if (process.env.VEDIT_AGENT_RESUME === "1") return this.run(req, userText, handle);
    // Default: a fresh session that restates the task and the previous answer. Resuming a CLI
    // session re-uploads its whole transcript (measured: ~145k cache-write tokens for one repair);
    // a fresh session with the same system + pack prefix is a cache read instead.
    const prompt = `${req.packText}\n\n${req.taskText}\n\nYOUR PREVIOUS ANSWER:\n${prev.text ?? "(no plan was returned)"}\n\n${userText}`;
    return this.run(req, prompt, { cumulative: { usage: ZERO_USAGE, usd: 0 } });
  }

  private async run(req: StartRequest, prompt: string, prev: Handle): Promise<Turn> {
    const resume = prev.sessionId;
    const server = createSdkMcpServer({
      name: "vedit",
      version: "1.0.0",
      tools: req.tools.map((t) =>
        tool(
          t.name,
          t.description,
          t.inputShape,
          async (args) => {
            const r = await t.run(args, { signal: req.budget.signal });
            return {
              content: [{ type: "text" as const, text: r.text }, ...(r.images ?? []).map((i) => ({ type: "image" as const, data: i.base64, mimeType: i.mediaType }))],
              ...(r.isError ? { isError: true } : {}),
            };
          },
          { alwaysLoad: true },
        ),
      ),
    });

    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.budget.signal.addEventListener("abort", onAbort, { once: true });

    // env REPLACES the subprocess environment: spread it so PATH/USERPROFILE survive and the /login credential is found
    const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_PROJECT_DIR_NAME: "vedit" };
    const options: Options = {
      systemPrompt: req.system + AGENT_ADDENDUM,
      model: this.model,
      effort: this.opts.effort,
      thinking: { type: "adaptive" },
      ...(req.contract === "format" ? { outputFormat: { type: "json_schema", schema: req.draftJsonSchema } } : {}),
      mcpServers: { vedit: server },
      strictMcpConfig: true, // no project/user/plugin MCP servers in the planner session
      tools: [],
      allowedTools: ["mcp__vedit__*"],
      disallowedTools: ["ToolSearch"],
      permissionMode: "dontAsk",
      settingSources: [],
      maxTurns: Math.max(1, req.budget.remainingCalls()),
      maxBudgetUsd: Math.max(0.01, req.budget.budget.maxUsd - req.budget.usd),
      cwd: os.tmpdir(), // ASCII cwd; the tools never touch cwd
      env,
      abortController: abort,
      ...(resume ? { resume } : {}),
      ...(this.opts.verbose ? { stderr: (d: string) => process.stderr.write(d) } : {}),
    };

    let sessionId = resume;
    let toolsSeen: string[] | undefined;
    let account: Record<string, unknown> | undefined;
    let text: string | null = null;
    let stop: Turn["stopReason"] = "error";
    let error: string | undefined;
    let errorCode: Turn["errorCode"];
    let usage: PlanUsage = { ...ZERO_USAGE };
    let usd = 0;
    let model = this.model;
    let numTurns = 1;

    try {
      const q = query({ prompt, options });
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "system" && m.subtype === "init") {
          sessionId = m.session_id;
          toolsSeen = m.tools;
          account = { apiKeySource: m.apiKeySource, model: m.model, claude_code_version: m.claude_code_version, mcp_servers: m.mcp_servers };
          try {
            const info = await q.accountInfo();
            account = { ...account, ...info };
          } catch {
            /* optional */
          }
        } else if (m.type === "assistant") {
          const err = (m as { error?: string }).error;
          if (err) {
            error = err;
            errorCode = err === "authentication_failed" || err === "oauth_org_not_allowed" ? "auth" : err === "rate_limit" ? "rate_limit" : err === "model_not_found" ? "model" : "api";
          }
        } else if (m.type === "result") {
          sessionId = m.session_id;
          numTurns = m.num_turns;
          usd = m.total_cost_usd;
          const perModel = Object.entries(m.modelUsage ?? {});
          for (const [name, u] of perModel) {
            usage = {
              input_tokens: usage.input_tokens + u.inputTokens,
              output_tokens: usage.output_tokens + u.outputTokens,
              cache_read_input_tokens: usage.cache_read_input_tokens + u.cacheReadInputTokens,
              cache_creation_input_tokens: usage.cache_creation_input_tokens + u.cacheCreationInputTokens,
              thinking_tokens: usage.thinking_tokens + (u.thinkingTokens ?? 0),
            };
            model = name;
          }
          if (m.subtype === "success") {
            text = m.structured_output != null ? JSON.stringify(m.structured_output) : m.result;
            stop = m.is_error ? "error" : "end_turn";
            if (m.is_error && !error) error = m.result;
          } else {
            stop = m.subtype === "error_max_turns" ? "max_iterations" : m.subtype === "error_max_budget_usd" ? "budget" : "error";
            error = error ?? (m.errors?.length ? m.errors.join("; ") : m.subtype);
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted || req.budget.signal.aborted) stop = "budget";
      else {
        stop = "error";
        error = error ?? (err instanceof Error ? err.message : String(err));
      }
    } finally {
      req.budget.signal.removeEventListener("abort", onAbort);
    }

    // a resumed session reports running totals: charge this turn only for the increase
    const resumed = Boolean(resume) && (usd >= prev.cumulative.usd || usage.output_tokens >= prev.cumulative.usage.output_tokens);
    const turnUsage = resumed ? minusUsage(usage, prev.cumulative.usage) : usage;
    const turnUsd = resumed ? Math.max(0, usd - prev.cumulative.usd) : usd;
    const cumulative = resumed ? { usage, usd } : { usage: { ...prev.cumulative.usage, ...sumInto(prev.cumulative.usage, usage) }, usd: prev.cumulative.usd + usd };
    const perCall: CallUsage[] = [{ model, usage: turnUsage, usd: turnUsd, priced: false, stop_reason: stop, tools: [] }];
    return { text, stopReason: stop, error, errorCode, calls: Math.max(1, numTurns), perCall, account, toolsSeen, handle: { sessionId, cumulative } satisfies Handle };
  }
}
