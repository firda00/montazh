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

export type BudgetExceeded = null | "usd" | "wall" | "calls";

export class BudgetTracker {
  readonly budget: Budget;
  readonly signal: AbortSignal;
  readonly startedAt = Date.now();
  usd = 0;
  calls = 0;
  private readonly controller = new AbortController();

  constructor(budget: Partial<Budget> = {}, parent?: AbortSignal) {
    this.budget = { ...DEFAULT_BUDGET, ...budget };
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
