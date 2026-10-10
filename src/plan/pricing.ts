import type { PlanUsage } from "../schemas/index.ts";

/** USD per million tokens. Source: bundled Claude API docs (skill 2.1.295, cached 2026-10-06). Only models listed here are ever priced. */
export const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; batchIn: number; batchOut: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8, batchIn: 2, batchOut: 10 },
};

/** The subset of the API usage object we read; typed loosely so beta/non-beta shapes both fit. */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  service_tier?: string | null;
  output_tokens_details?: { thinking_tokens?: number | null } | null;
}

export function normalizeUsage(u: UsageLike): PlanUsage {
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    thinking_tokens: u.output_tokens_details?.thinking_tokens ?? 0,
  };
}

/** Prices one request. Unknown models are never priced from memory: { usd: 0, priced: false }. */
export function usdForUsage(model: string, u: UsageLike): { usd: number; priced: boolean } {
  const p = PRICES[model];
  if (!p) return { usd: 0, priced: false };
  const w1 = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5 = u.cache_creation?.ephemeral_5m_input_tokens ?? Math.max(0, (u.cache_creation_input_tokens ?? 0) - w1);
  const [pin, pout] = u.service_tier === "batch" ? [p.batchIn, p.batchOut] : [p.in, p.out];
  const usd = (u.input_tokens * pin + w5 * p.cacheWrite5m + w1 * p.cacheWrite1h + (u.cache_read_input_tokens ?? 0) * p.cacheRead + u.output_tokens * pout) / 1e6;
  return { usd, priced: true };
}

export function sumUsage(list: PlanUsage[]): PlanUsage {
  return list.reduce(
    (acc, u) => ({
      input_tokens: acc.input_tokens + u.input_tokens,
      output_tokens: acc.output_tokens + u.output_tokens,
      cache_read_input_tokens: acc.cache_read_input_tokens + u.cache_read_input_tokens,
      cache_creation_input_tokens: acc.cache_creation_input_tokens + u.cache_creation_input_tokens,
      thinking_tokens: acc.thinking_tokens + u.thinking_tokens,
    }),
    { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 },
  );
}
