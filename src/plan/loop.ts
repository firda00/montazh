import { PlanDraftSchema, type CallUsage, type Edl, type PlanDraft, type PlanIssue, type PlanUsage } from "../schemas/index.ts";
import type { BudgetTracker } from "./budget.ts";
import type { PlanContext } from "./context.ts";
import { sumUsage } from "./pricing.ts";
import { buildRepairText, buildReviseText, buildTaskText, NUDGE_TEXT } from "./prompt.ts";
import { draftFromEdl } from "./refs.ts";
import { resolveDraft, type ResolvedDraft } from "./resolve.ts";
import type { ToolState } from "./tools.ts";
import { PlanError, type Contract, type PlannerBackend, type PlannerTool, type StartRequest, type Turn } from "./backend/types.ts";

export interface LoopTask {
  kind: "plan" | "revise";
  instruction: string;
  currentEdl?: Edl;
  presetName: string;
}

export interface LoopOptions {
  budget: BudgetTracker;
  maxRepairs: number;
  contract: Contract;
  tools: PlannerTool[];
  state: ToolState;
  system: string;
  draftJsonSchema: Record<string, unknown>;
  maxTokens?: number;
  onTurn?: (turn: Turn) => void | Promise<void>;
}

export interface LoopResult {
  status: "ok" | "partial" | "failed";
  draft: PlanDraft | null;
  resolved: ResolvedDraft | null;
  turns: Turn[];
  calls: number;
  repairs: number;
  fixed: PlanIssue[];
  issues: PlanIssue[];
  perCall: CallUsage[];
  usage: PlanUsage;
  usd: number;
  priced: boolean;
  estimate: boolean;
  error?: string;
  errorCode?: PlanError["code"];
  stopReason?: Turn["stopReason"];
  account?: Record<string, unknown>;
  toolsSeen?: string[];
}

const FENCE = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/;

export function parseDraft(text: string | null): { draft: PlanDraft | null; issues: PlanIssue[] } {
  if (!text) return { draft: null, issues: [{ severity: "error", code: "invalid_json", message: "the reply contained no plan JSON" }] };
  let body = text.trim();
  const m = FENCE.exec(body);
  if (m) body = m[1];
  // tolerate prose around a single JSON object
  if (!body.startsWith("{")) {
    const a = body.indexOf("{");
    const b = body.lastIndexOf("}");
    if (a >= 0 && b > a) body = body.slice(a, b + 1);
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { draft: null, issues: [{ severity: "error", code: "invalid_json", message: `reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  const parsed = PlanDraftSchema.safeParse(json);
  if (!parsed.success) {
    return { draft: null, issues: parsed.error.issues.map((i) => ({ severity: "error" as const, code: "schema" as const, message: `${i.path.join(".") || "(root)"}: ${i.message}` })) };
  }
  return { draft: parsed.data, issues: [] };
}

/** start → classify → parse → resolve → repair (≤ maxRepairs) → ok | partial | failed. No I/O. */
export async function runPlannerLoop(backend: PlannerBackend, ctx: PlanContext, task: LoopTask, opts: LoopOptions): Promise<LoopResult> {
  if (ctx.phrases.length === 0 && ctx.scenes.length === 0) {
    throw new PlanError("нечего планировать: ни фраз, ни сцен (понимание видео не запускалось или пустое)", "nothing_to_plan");
  }
  const mode = task.kind;
  const currentDraft = task.currentEdl ? draftFromEdl(task.currentEdl, ctx) : null;
  const taskText = task.kind === "revise" && currentDraft
    ? buildReviseText(currentDraft, task.instruction)
    : buildTaskText({ instruction: task.instruction, presetName: task.presetName, mode: ctx.mode, toolsAvailable: opts.tools.length > 0 });
  const req: StartRequest = {
    system: opts.system,
    packText: ctx.packText,
    taskText,
    tools: opts.tools,
    draftJsonSchema: opts.draftJsonSchema,
    contract: opts.contract,
    maxTokens: opts.maxTokens ?? 16_000,
    budget: opts.budget,
    ctx,
    instruction: task.instruction,
    currentEdl: task.currentEdl,
  };

  const turns: Turn[] = [];
  const fixed: PlanIssue[] = [];
  let repairs = 0;
  let nudges = 0;
  let draft: PlanDraft | null = null;
  let resolved: ResolvedDraft | null = null;
  let lastIssues: PlanIssue[] = [];

  const finish = (status: LoopResult["status"], extra: Partial<LoopResult> = {}): LoopResult => {
    const perCall = turns.flatMap((t) => t.perCall);
    const last = turns[turns.length - 1];
    return {
      status,
      draft,
      resolved,
      turns,
      calls: turns.reduce((n, t) => n + t.calls, 0),
      repairs,
      fixed,
      issues: lastIssues,
      perCall,
      usage: sumUsage(perCall.map((c) => c.usage)),
      usd: perCall.reduce((s, c) => s + c.usd, 0),
      priced: perCall.every((c) => c.priced),
      estimate: backend.name === "agent",
      stopReason: last?.stopReason,
      account: turns.find((t) => t.account)?.account,
      toolsSeen: turns.find((t) => t.toolsSeen)?.toolsSeen,
      ...extra,
    };
  };

  let turn = await backend.start(req);
  turns.push(turn);
  await opts.onTurn?.(turn);

  for (;;) {
    // classify the stop
    if (turn.stopReason === "refusal") return finish("failed", { error: `модель отказалась планировать${turn.refusalCategory ? ` (${turn.refusalCategory})` : ""}`, errorCode: "refusal" });
    if (turn.stopReason === "max_tokens") return finish("failed", { error: "ответ модели обрезан по max_tokens даже после повтора", errorCode: "max_tokens" });
    if (turn.stopReason === "error") return finish("failed", { error: turn.error ?? "backend error", errorCode: turn.errorCode ?? "api" });
    const outOfBudget = turn.stopReason === "budget" || turn.stopReason === "aborted";

    // extract the draft
    let issues: PlanIssue[] = [];
    if (opts.contract === "submit" && opts.state.submitted) {
      draft = opts.state.submitted.draft;
    } else if (turn.text || turn.stopReason === "end_turn") {
      const p = parseDraft(turn.text);
      draft = p.draft ?? draft;
      issues = p.issues;
    }

    if (draft) {
      resolved = resolveDraft(draft, ctx, { mode, currentEdl: task.currentEdl });
      issues = [...issues.filter((i) => i.code !== "invalid_json"), ...resolved.issues];
    }
    lastIssues = issues;
    const errors = issues.filter((i) => i.severity === "error");
    if (draft && resolved && errors.length === 0) return finish("ok");

    if (outOfBudget) {
      const reason = opts.budget.exceeded() ?? "budget";
      return resolved?.edl ? finish("partial", { error: `бюджет исчерпан (${reason}); сохранены выходы без ошибок` }) : finish("failed", { error: `бюджет исчерпан (${reason}) до валидного плана`, errorCode: "budget" });
    }

    // repair or nudge
    const needNudge = opts.contract === "submit" && !opts.state.submitted && !draft;
    const canContinue = opts.budget.exceeded() === null && opts.budget.remainingCalls() > 0;
    if (canContinue && (needNudge ? nudges < opts.maxRepairs : repairs < opts.maxRepairs)) {
      let text: string;
      if (needNudge) {
        nudges += 1;
        text = NUDGE_TEXT;
      } else {
        repairs += 1;
        fixed.push(...errors);
        text = buildRepairText(issues, repairs, opts.maxRepairs);
      }
      turn = await backend.continue(turn, text, req);
      turns.push(turn);
      await opts.onTurn?.(turn);
      continue;
    }

    // out of repairs: keep what is valid
    if (resolved?.edl) return finish("partial", { error: `${errors.length} ошибок осталось после ${repairs} исправлений; выходы с ошибками отброшены` });
    const code: PlanError["code"] = !canContinue ? (opts.budget.exceeded() === null ? "loop" : "budget") : "invalid";
    return finish("failed", { error: draft ? `план невалиден после ${repairs} исправлений` : "модель не вернула план", errorCode: code });
  }
}
