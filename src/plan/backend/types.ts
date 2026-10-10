import type { z } from "zod";
import type { CallUsage, Edl, PlanDraft } from "../../schemas/index.ts";
import type { BudgetTracker } from "../budget.ts";
import type { PlanContext } from "../context.ts";

export type BackendName = "api" | "agent" | "mock";
/** 'format' = output_config.format (structured output); 'submit' = terminal submit_edl tool (fallback). */
export type Contract = "format" | "submit";

export interface ToolResult {
  text: string;
  images?: { base64: string; mediaType: "image/jpeg" }[];
  isError?: boolean;
}

export interface PlannerTool {
  name: string;
  description: string;
  inputShape: z.ZodRawShape;
  run: (input: unknown, ctx: { signal?: AbortSignal }) => Promise<ToolResult>;
}

export interface StartRequest {
  system: string; // frozen SYSTEM_PROMPT (+ addenda)
  packText: string; // job-static, byte-stable (cached block)
  taskText: string; // varying
  tools: PlannerTool[]; // name-sorted; [] allowed
  draftJsonSchema: Record<string, unknown>;
  contract: Contract;
  maxTokens: number;
  budget: BudgetTracker;
  ctx: PlanContext; // for the heuristic mock only
  instruction: string;
  currentEdl?: Edl;
}

export type StopReason = "end_turn" | "max_tokens" | "refusal" | "max_iterations" | "budget" | "aborted" | "error";

export interface Turn {
  text: string | null; // final assistant text (JSON in the 'format' contract)
  stopReason: StopReason;
  refusalCategory?: string;
  error?: string;
  errorCode?: PlanErrorCode;
  calls: number;
  perCall: CallUsage[];
  /** true when the backend already charged the BudgetTracker for this turn (per request, mid-turn) */
  charged?: boolean;
  account?: Record<string, unknown>;
  toolsSeen?: string[];
  handle: unknown; // backend-private continuation state
}

export interface PlannerBackend {
  readonly name: BackendName;
  readonly model: string;
  readonly note: string;
  start(req: StartRequest): Promise<Turn>;
  /** repair / nudge / revise follow-up; append-only */
  continue(prev: Turn, userText: string, req: StartRequest): Promise<Turn>;
}

export type PlanErrorCode =
  | "auth"
  | "model"
  | "rate_limit"
  | "network"
  | "api"
  | "refusal"
  | "max_tokens"
  | "loop"
  | "invalid"
  | "nothing_to_plan"
  | "no_backend"
  | "budget"
  | "missing_inputs"
  | "contract";

export class PlanError extends Error {
  constructor(
    message: string,
    public code: PlanErrorCode,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export interface MockTurnScript {
  tools?: { name: string; input: unknown }[];
  text?: string | PlanDraft | Record<string, unknown>;
  stopReason?: StopReason;
  usage?: Partial<CallUsage["usage"]>;
  usd?: number;
  refusalCategory?: string;
}
