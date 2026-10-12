export interface Budget {
  maxUsd: number;
  maxWallMs: number;
  maxCalls: number;
  maxRepairs: number;
  maxToolCalls: number;
  frameBudget: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxUsd: 1.5,
  maxWallMs: 240_000, // SPEC §8: a 10-minute video should finish within 5 minutes end-to-end
  maxCalls: 12,
  maxRepairs: 2,
  maxToolCalls: 16,
  frameBudget: 6,
};

/** Environment overrides of the defaults; flags (--budget, --max-repairs, --frames) win over both. */
export const BUDGET_ENV: Record<keyof Budget, { env: string; unit: string; what: string }> = {
  maxUsd: { env: "VEDIT_BUDGET_USD", unit: "$", what: "стоимость одного планирования" },
  maxWallMs: { env: "VEDIT_BUDGET_WALL_S", unit: "с", what: "время одного планирования" },
  maxCalls: { env: "VEDIT_BUDGET_CALLS", unit: "запросов", what: "запросов к модели на план" },
  maxRepairs: { env: "VEDIT_BUDGET_REPAIRS", unit: "раз", what: "попыток исправить план" },
  maxToolCalls: { env: "VEDIT_BUDGET_TOOL_CALLS", unit: "вызовов", what: "вызовов инструментов на план" },
  frameBudget: { env: "VEDIT_BUDGET_FRAMES", unit: "кадров", what: "превью-кадров на план" },
};

/** DEFAULT_BUDGET with VEDIT_BUDGET_* applied; a value that is not a positive number is an error, never silently ignored. */
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): Budget {
  const b: Budget = { ...DEFAULT_BUDGET };
  for (const key of Object.keys(BUDGET_ENV) as (keyof Budget)[]) {
    const raw = env[BUDGET_ENV[key].env]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${BUDGET_ENV[key].env}: ожидается положительное число, получено "${raw}"`);
    b[key] = key === "maxWallMs" ? n * 1000 : n;
  }
  return b;
}

export type BudgetExceeded = null | "usd" | "wall" | "calls";

export class BudgetTracker {
  readonly budget: Budget;
  readonly signal: AbortSignal;
  readonly startedAt = Date.now();
  usd = 0;
  calls = 0;
  private readonly controller = new AbortController();

  constructor(budget: Partial<Budget> = {}, parent?: AbortSignal) {
    this.budget = { ...budgetFromEnv(), ...budget };
    const signals = [this.controller.signal, AbortSignal.timeout(this.budget.maxWallMs)];
    if (parent) signals.push(parent);
    this.signal = AbortSignal.any(signals);
  }

  addRequest(usd: number, calls = 1) {
    this.calls += calls;
    this.usd += usd;
  }

  remainingCalls() {
    return Math.max(0, this.budget.maxCalls - this.calls);
  }

  elapsedMs() {
    return Date.now() - this.startedAt;
  }

  exceeded(): BudgetExceeded {
    if (this.usd >= this.budget.maxUsd) return "usd";
    if (this.signal.aborted || this.elapsedMs() >= this.budget.maxWallMs) return "wall";
    if (this.calls >= this.budget.maxCalls) return "calls";
    return null;
  }

  abort() {
    this.controller.abort();
  }
}
