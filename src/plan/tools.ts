import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { extractFrame as realExtractFrame } from "../understand/shots.ts";
import { PlanDraftSchema, type Edl, type PlanDraft, type ToolCallRecord } from "../schemas/index.ts";
import { phrasesOverlapping, type PlanContext } from "./context.ts";
import { resolveDraft, type ResolvedDraft } from "./resolve.ts";
import { allWords, wordAt } from "./validate.ts";
import type { Contract, PlannerTool, ToolResult } from "./backend/types.ts";

export interface ToolDeps {
  framesDir: string;
  extractFrame?: (video: string, t: number, file: string) => Promise<string>;
  frameBudget?: number;
  maxToolCalls?: number;
  onCall?: (rec: ToolCallRecord) => void;
}

export interface ToolState {
  calls: number;
  frames: number;
  frameCache: Map<number, Promise<ToolResult>>;
  trace: ToolCallRecord[];
  submitted: { draft: PlanDraft; resolved: ResolvedDraft } | null;
  submitAttempts: number;
}

export function newToolState(): ToolState {
  return { calls: 0, frames: 0, frameCache: new Map(), trace: [], submitted: null, submitAttempts: 0 };
}

export interface ToolOptions {
  contract: Contract;
  mode: "plan" | "revise";
  currentEdl?: Edl;
  maxRepairs: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const MAX_RANGE = 180;

/** Backend-neutral planner tools, name-sorted. Every call is validated, budgeted and traced. */
export function makePlannerTools(ctx: PlanContext, state: ToolState, deps: ToolDeps, opts: ToolOptions): PlannerTool[] {
  const frameBudget = deps.frameBudget ?? 6;
  const maxToolCalls = deps.maxToolCalls ?? 16;
  const extract = deps.extractFrame ?? realExtractFrame;

  function define<S extends z.ZodRawShape>(name: string, description: string, shape: S, impl: (input: z.infer<z.ZodObject<S>>, rctx: { signal?: AbortSignal }) => Promise<ToolResult>, exempt = false): PlannerTool {
    const schema = z.object(shape);
    return {
      name,
      description,
      inputShape: shape,
      run: async (input, rctx) => {
        const t0 = Date.now();
        let res: ToolResult;
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          res = { text: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`, isError: true };
        } else if (!exempt && state.calls >= maxToolCalls) {
          res = { text: JSON.stringify({ note: "tool budget used — decide from the pack and answer" }) };
        } else {
          if (!exempt) state.calls += 1;
          try {
            res = await impl(parsed.data, rctx);
          } catch (err) {
            res = { text: `tool failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
          }
        }
        const rec: ToolCallRecord = { name, input, ok: !res.isError, ms: Date.now() - t0, summary: res.text.slice(0, 160), ...(res.images?.length ? { image: true } : {}) };
        state.trace.push(rec);
        deps.onCall?.(rec);
        return res;
      },
    };
  }

  const words = allWords(ctx.transcript);
  const MAX_SNAP = 0.4; // same limit as resolveDraft
  const edgeInfo = (t: number, side: "start" | "end") => {
    const w = wordAt(words, t);
    if (!w) return { inside_word: null, safe: r2(t) };
    const safe = side === "start" ? w.start : w.end;
    const shift = Math.abs(safe - t);
    return shift <= MAX_SNAP
      ? { inside_word: { w: w.w, start: w.start, end: w.end }, safe }
      : { inside_word: { w: w.w, start: w.start, end: w.end }, safe: null, note: `the harness will not move this edge ${r2(shift)}s; use a phrase or gap ref instead` };
  };

  const tools: PlannerTool[] = [
    define(
      "get_transcript_range",
      "Phrases and silence gaps inside a time range, with per-word timestamps and word indexes when words=true (needed before a pN.wK cut). Use in compact mode or for word indexes; ask for all ranges you need in one turn. Max 180 s per call.",
      {
        start: z.number().describe("seconds"),
        end: z.number().describe("seconds, greater than start"),
        words: z.boolean().optional().describe("include word timestamps and indexes"),
      },
      async ({ start, end, words: withWords }) => {
        const s = Math.max(0, start);
        const e = Math.min(ctx.duration, end);
        if (e <= s) return { text: `end must be after start (video is 0–${r2(ctx.duration)}s)`, isError: true };
        if (e - s > MAX_RANGE) return { text: `range too long (${r2(e - s)}s); max ${MAX_RANGE}s per call`, isError: true };
        const phrases = phrasesOverlapping(ctx, s, e).map((p) => ({
          id: p.id,
          start: p.start,
          end: p.end,
          lang: p.lang,
          text: p.text,
          ...(withWords ? { words: p.words.map((w, i) => ({ i, w: w.w, start: w.start, end: w.end })) } : {}),
        }));
        const gaps = ctx.gaps.filter((g) => g.start < e && g.end > s).map((g) => ({ id: g.id, start: g.start, end: g.end }));
        return { text: JSON.stringify({ range: [r2(s), r2(e)], phrases, gaps }) };
      },
    ),

    define(
      "get_scene_details",
      "Metadata of one scene (sN): boundaries, description (stub descriptions carry no visual information), the phrases it contains, and what the harness will snap its edges to when they land inside a word.",
      { id: z.string().describe("scene id, e.g. s3") },
      async ({ id }) => {
        const s = ctx.scenes.find((x) => x.id === id);
        if (!s) return { text: ctx.scenes.length ? `unknown scene ${id}; valid ids are s0..s${ctx.scenes.length - 1}` : "this video has no detected scenes", isError: true };
        return {
          text: JSON.stringify({
            id: s.id,
            start: s.start,
            end: s.end,
            description: s.description,
            objects: s.objects,
            people_count: s.people_count,
            emotion: s.emotion,
            shot_type: s.shot_type,
            quality_score: s.quality_score,
            is_stub: s.is_stub,
            phrases: s.phrases.map((pid) => ctx.phrases[Number(pid.slice(1))]).filter(Boolean).map((p) => ({ id: p.id, start: p.start, end: p.end, text: p.text })),
            edges: { start: edgeInfo(s.start, "start"), end: edgeInfo(s.end, "end") },
            prev: s.index > 0 ? `s${s.index - 1}` : null,
            next: s.index < ctx.scenes.length - 1 ? `s${s.index + 1}` : null,
          }),
        };
      },
    ),

    define(
      "preview_frame",
      `One JPEG frame of the source video at time t (640 px wide). The only way to know what is actually visible. Use only when the instruction depends on visuals; request every frame you need in one turn. Budget: ${frameBudget} per plan.`,
      { t: z.number().describe("seconds in [0, duration]") },
      async ({ t }) => {
        if (t < 0 || t > ctx.duration) return { text: `t must be within 0–${r2(ctx.duration)}s`, isError: true };
        const ms = Math.round(t * 1000);
        const cached = state.frameCache.get(ms);
        if (cached) return cached;
        if (state.frames >= frameBudget) return { text: JSON.stringify({ note: "frame budget used; decide from scenes and phrases" }) };
        state.frames += 1;
        const job = (async (): Promise<ToolResult> => {
          await fs.mkdir(deps.framesDir, { recursive: true });
          const file = path.join(deps.framesDir, `preview_${String(ms).padStart(7, "0")}.jpg`);
          await extract(ctx.media.normalized_path, t, file);
          const base64 = (await fs.readFile(file)).toString("base64");
          const scene = ctx.scenes.find((s) => t >= s.start && t < s.end);
          const phrase = ctx.phrases.find((p) => t >= p.start && t <= p.end);
          const where = [scene?.id, phrase ? `${phrase.id} "${phrase.text.slice(0, 60)}"` : "no speech"].filter(Boolean).join(", ");
          return { text: `frame at ${t.toFixed(3)}s — ${where}; previews_left ${Math.max(0, frameBudget - state.frames)}`, images: [{ base64, mediaType: "image/jpeg" }] };
        })();
        state.frameCache.set(ms, job);
        return job;
      },
    ),

    define(
      "validate_edl",
      "Runs the same validation the harness applies to your final answer: resolves refs to seconds, keeps words whole, checks durations. Only needed for unusual plans; the final answer is validated anyway.",
      { plan: PlanDraftSchema },
      async ({ plan }) => {
        const r = resolveDraft(plan, ctx, { mode: opts.mode, currentEdl: opts.currentEdl });
        return { text: JSON.stringify({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, resolved: summarize(r) }) };
      },
      true,
    ),
  ];

  if (opts.contract === "submit") {
    tools.push(
      define(
        "submit_edl",
        "Submit the complete plan. Returns accepted:true, or the list of errors to fix before submitting again.",
        { plan: PlanDraftSchema },
        async ({ plan }) => {
          state.submitAttempts += 1;
          const r = resolveDraft(plan, ctx, { mode: opts.mode, currentEdl: opts.currentEdl });
          if (r.errors.length === 0) {
            state.submitted = { draft: plan, resolved: r };
            return { text: JSON.stringify({ accepted: true, warnings: r.warnings, resolved: summarize(r), next: "Reply with one sentence." }) };
          }
          const left = Math.max(0, opts.maxRepairs + 1 - state.submitAttempts);
          return { text: JSON.stringify({ accepted: false, attempt: state.submitAttempts, attempts_left: left, final: left === 0, errors: r.errors, warnings: r.warnings }) };
        },
        true,
      ),
    );
  }

  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

function summarize(r: ResolvedDraft) {
  return r.outputs.map((o) => ({ id: o.id, duration_s: o.duration_s, target_s: o.target_s, clips: o.clips.map((c) => ({ start_s: r2(c.start), end_s: r2(c.end), from: c.from, to: c.to })) }));
}
