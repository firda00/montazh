import { detectAspect } from "../../lib/aspect.ts";
import type { CallUsage, PlanDraft } from "../../schemas/index.ts";
import type { PlanContext } from "../context.ts";
import type { MockTurnScript, PlannerBackend, StartRequest, Turn } from "./types.ts";

const DEFAULT_USAGE: CallUsage["usage"] = { input_tokens: 1000, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };

/**
 * Offline backend. Scripted turns run the REAL tool code (so budgets and traces are
 * exercised); the heuristic mode plans from the pack with simple rules and marks its
 * reasoning with [mock] — never auto-selected.
 */
export class MockBackend implements PlannerBackend {
  readonly name = "mock";
  readonly model = "mock";
  readonly note: string;
  readonly received: string[] = [];
  private i = 0;

  constructor(private readonly opts: { turns?: MockTurnScript[]; heuristic?: boolean } = {}) {
    this.note = opts.heuristic ? "backend: mock — эвристика без модели, план помечен [mock]" : "backend: mock (scripted)";
  }

  async start(req: StartRequest): Promise<Turn> {
    return this.next(req);
  }

  async continue(_prev: Turn, userText: string, req: StartRequest): Promise<Turn> {
    this.received.push(userText);
    return this.next(req);
  }

  private async next(req: StartRequest): Promise<Turn> {
    if (this.opts.heuristic) {
      const draft = heuristicDraft(req.ctx, req.instruction, req.currentEdl ? "revise" : "plan");
      return { text: JSON.stringify(draft), stopReason: "end_turn", calls: 1, perCall: [{ model: "mock", usage: { ...DEFAULT_USAGE }, usd: 0, priced: true, stop_reason: "end_turn", tools: [] }], handle: null };
    }
    const script = this.opts.turns?.[this.i++];
    if (!script) return { text: null, stopReason: "error", error: "mock script exhausted", calls: 1, perCall: [], handle: null };
    const toolNames: string[] = [];
    for (const call of script.tools ?? []) {
      const tool = req.tools.find((t) => t.name === call.name);
      if (!tool) throw new Error(`mock script calls unknown tool ${call.name}`);
      toolNames.push(call.name);
      await tool.run(call.input, { signal: req.budget.signal });
    }
    const text = script.text === undefined ? null : typeof script.text === "string" ? script.text : JSON.stringify(script.text);
    const usage = { ...DEFAULT_USAGE, ...(script.usage ?? {}) };
    return {
      text,
      stopReason: script.stopReason ?? "end_turn",
      refusalCategory: script.refusalCategory,
      calls: 1,
      perCall: [{ model: "mock", usage, usd: script.usd ?? 0, priced: true, stop_reason: script.stopReason ?? "end_turn", tools: toolNames }],
      handle: null,
    };
  }
}

// ---- heuristic planner (no model) ----

function parseInstruction(instruction: string, ctx: PlanContext) {
  const s = instruction.toLowerCase();
  const count = /(\d+)\s*(рилс|reel|ролик|видео|shorts|клип|short)/.exec(s);
  const dur = /(?:по\s*)?(\d+)\s*(сек|с\b|second|sec)/.exec(s);
  const min = /(\d+)\s*(мин|minute|min\b)/.exec(s);
  // the format the instruction names ("для ютуба" → 16:9, "шортс"/"рилс" → 9:16, "квадрат" → 1:1), else the preset's
  const aspect: "9:16" | "1:1" | "16:9" = detectAspect(s) ?? ctx.preset.default_aspect;
  const lang = /узбек|uzbek|o'zbek|oʻzbek/.test(s) ? "uz" : /русск|russian/.test(s) ? "ru" : /англ|english/.test(s) ? "en" : ctx.transcript.language;
  const captions = !/без субтитр|no captions|no subtitles/.test(s);
  return {
    outputs: count ? Number(count[1]) : 1,
    target: dur ? Number(dur[1]) : min ? Number(min[1]) * 60 : 30,
    aspect,
    lang,
    captions,
    styleWords: ["динамич", "спокойн", "dynamic", "calm", "быстр", "энергич"].filter((w) => s.includes(w)),
  };
}

/** Packs highlights (then remaining phrases) into whole-phrase clips per output. */
export function heuristicDraft(ctx: PlanContext, instruction: string, mode: "plan" | "revise" = "plan"): PlanDraft {
  const brief = parseInstruction(instruction, ctx);
  const used = new Set<number>();
  const order: number[] = [];
  for (const h of ctx.highlights) for (const pid of h.phrases) order.push(Number(pid.slice(1)));
  for (const p of ctx.phrases) order.push(p.index);
  const outputs: PlanDraft["outputs"] = [];
  for (let k = 0; k < brief.outputs; k++) {
    const picked: number[] = [];
    let total = 0;
    for (const idx of order) {
      if (used.has(idx) || picked.includes(idx)) continue;
      const p = ctx.phrases[idx];
      if (!p) continue;
      const len = p.end - p.start;
      if (total + len > brief.target * 1.1 && total >= brief.target * 0.6) break;
      picked.push(idx);
      total += len;
      if (total >= brief.target * 0.9) break;
    }
    picked.forEach((i) => used.add(i));
    const runs = contiguousRuns(picked.sort((a, b) => a - b), ctx);
    outputs.push({
      id: `reel_${k + 1}`,
      aspect: brief.aspect,
      target_duration: brief.target,
      clips: runs.map(([a, b]) => ({ start: `p${a}`, end: `p${b}`, speed: 1, crop: brief.aspect === "9:16" ? "auto_face" : "center" })),
      captions: { enabled: brief.captions, language: brief.lang, style: ctx.preset.caption_style },
      titles: [],
      music: { enabled: false },
    });
  }
  return {
    brief: { outputs_requested: brief.outputs, target_duration_s: brief.target, aspect: brief.aspect, captions_language: brief.lang, style_words: brief.styleWords },
    outputs,
    reasoning: `[mock] эвристический план без модели (${mode}): фразы из топа highlights упакованы в ${brief.outputs} выход(ов) по ~${brief.target} с.`,
  };
}

/** Adjacent phrases become one clip only when no real pause (≥ 0.5 s) separates them. */
function contiguousRuns(sorted: number[], ctx: PlanContext): [number, number][] {
  const runs: [number, number][] = [];
  for (const n of sorted) {
    const last = runs[runs.length - 1];
    const joined = last && n === last[1] + 1 && ctx.phrases[n].start - ctx.phrases[last[1]].end < 0.5;
    if (joined) last[1] = n;
    else runs.push([n, n]);
  }
  return runs;
}
