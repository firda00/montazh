import fs from "node:fs/promises";
import path from "node:path";
import { addCost } from "../lib/cost.ts";
import { exists, jobDir, loadJob, readJson, writeJson } from "../lib/workspace.ts";
import {
  EdlSchema,
  HighlightsSchema,
  JobSchema,
  MediaSchema,
  PlanReportSchema,
  ScenesSchema,
  SpeakersSchema,
  TranscriptSchema,
  type Edl,
  type PlanReport,
  type ToolCallRecord,
  type Transcript,
} from "../schemas/index.ts";
import { DEFAULT_MODEL, selectBackend, type BackendChoice, type Effort } from "./backend/index.ts";
import { PlanError, type Contract, type PlannerBackend, type Turn } from "./backend/types.ts";
import { BudgetTracker, type Budget } from "./budget.ts";
import { buildPlanContext, type PlanContext } from "./context.ts";
import { runPlannerLoop, type LoopResult, type LoopTask } from "./loop.ts";
import { loadPreset } from "./presets.ts";
import { PROMPT_VERSION, SUBMIT_ADDENDUM, SYSTEM_PROMPT } from "./prompt.ts";
import { draftJsonSchema } from "./schema-sanitize.ts";
import { makePlannerTools, newToolState, type ToolDeps } from "./tools.ts";
import { isLong, shortlist, type Window } from "./shortlist.ts";
import { resolveSpeaker } from "../understand/asr.ts";
import { SourcesSchema } from "../ingest/combine.ts";
import { selectStructuredLlm, type StructuredFn } from "../lib/llm.ts";

export interface PlanOptions {
  instruction: string;
  preset?: string;
  backend?: BackendChoice;
  backendInstance?: PlannerBackend;
  model?: string;
  effort?: Effort;
  budget?: Partial<Budget>;
  tools?: boolean;
  contract?: Contract;
  cacheTtl?: "5m" | "1h";
  verbose?: boolean;
  onEvent?: (line: string) => void;
  /** test hook: replaces ffmpeg frame extraction */
  extractFrame?: ToolDeps["extractFrame"];
  /** plan only this person's phrases: S<n>, a time in the video (mm:ss) or "most" */
  speaker?: string;
  /** long-video mode (shortlist stage); default: by size */
  long?: boolean;
  maxWindows?: number;
  /** test hook: the shortlist call */
  shortlistLlm?: StructuredFn;
}

export interface PlanResult {
  report: PlanReport;
  edl: Edl | null;
  partial: boolean;
}

export interface LoadedInputs {
  ctx: PlanContext;
  warnings: string[];
  presetName: string;
}

export interface SelectOptions {
  speaker?: string;
  long?: boolean;
  maxWindows?: number;
  instruction?: string;
  llm?: StructuredFn;
  onEvent?: (line: string) => void;
  /** revise: the speaker/windows of the plan being edited, so the pack (and its refs) is the same */
  reuse?: { speaker?: string; windows?: Window[] };
}

export async function loadPlanInputs(jobId: string, presetName: string, sel: SelectOptions = {}): Promise<LoadedInputs> {
  const dir = jobDir(jobId);
  const mediaFile = path.join(dir, "media.json");
  if (!(await exists(mediaFile))) throw new PlanError(`нет media.json в задаче ${jobId}: сначала vedit ingest / vedit run`, "missing_inputs");
  const media = await readJson(mediaFile, MediaSchema);
  const warnings: string[] = [];
  const optional = async <T>(name: string, schema: Parameters<typeof readJson>[1], empty: T): Promise<T> => {
    const f = path.join(dir, name);
    if (await exists(f)) return (await readJson(f, schema)) as T;
    warnings.push(`${name} отсутствует — планирование без него`);
    return empty;
  };
  const transcript = await optional<Transcript>("transcript.json", TranscriptSchema, { language: "unknown", segments: [] });
  const scenes = await optional("scenes.json", ScenesSchema, []);
  const highlights = await optional("highlights.json", HighlightsSchema, []);
  const { preset, note } = await loadPreset(presetName);
  if (note) warnings.push(note);
  const sourcesFile = path.join(dir, "sources.json");
  const sources = (await exists(sourcesFile)) ? (await readJson(sourcesFile, SourcesSchema)).sources : undefined;
  const speakersFile = path.join(dir, "speakers.json");
  const speakers = (await exists(speakersFile)) ? await readJson(speakersFile, SpeakersSchema) : undefined;

  // who: an explicit speaker, or the one the plan being revised was built for
  let speaker = sel.reuse?.speaker;
  if (sel.speaker) {
    if (!speakers) throw new PlanError(`--speaker: в задаче ${jobId} нет speakers.json — говорящие размечаются на этапе understand (нужен сайдкар tools/asr)`, "missing_inputs");
    speaker = resolveSpeaker(sel.speaker, transcript, speakers);
    warnings.push(`только говорящий ${speaker} (${speakers.speakers.find((s) => s.id === speaker)?.seconds ?? 0}s речи)`);
  }

  // long video: shortlist stage picks the windows the planner will see
  let windows = sel.reuse?.windows;
  if (!windows) {
    const probe = buildPlanContext({ media, transcript, scenes, highlights, preset, speakers, sources, speaker });
    const filtered = speaker ? { ...transcript, segments: transcript.segments.filter((s) => s.speaker === speaker) } : transcript;
    const long = sel.long ?? isLong(filtered, probe.tokenEstimate);
    if (long) {
      let llm = sel.llm;
      if (!llm) {
        try {
          llm = selectStructuredLlm();
        } catch {}
      }
      const r = await shortlist({ transcript: filtered, highlights, instruction: sel.instruction ?? "", llm, maxWindows: sel.maxWindows, onEvent: sel.onEvent });
      windows = r.windows;
      warnings.push(r.note);
      if (r.usage) {
        await addCost(jobId, { step: "plan", provider: r.provider === "anthropic" ? "anthropic" : (r.provider ?? "shortlist"), model: r.model ?? "shortlist", units: { ...r.usage, calls: r.calls ?? 1, shortlist: 1, estimate: r.estimate ? 1 : 0 }, usd: r.usd });
      }
    }
  }
  const ctx = buildPlanContext({ media, transcript, scenes, highlights, preset, speakers, sources, speaker, windows });
  if (ctx.windows.length) sel.onEvent?.(`  окна: ${ctx.windows.map((w) => `${w.id} ${Math.round(w.start)}-${Math.round(w.end)}s`).join(", ")}`);
  return { ctx, warnings, presetName: preset.name };
}

export interface RunLoopArgs {
  jobId: string;
  ctx: PlanContext;
  task: LoopTask;
  opts: PlanOptions;
  step: "plan" | "revise";
}

/** Shared by plan() and revise(): backend, tools, budget, loop, cost logging, contract fallback. */
export async function runPlanning(args: RunLoopArgs): Promise<{ loop: LoopResult; backend: PlannerBackend; contract: Contract; toolCalls: ToolCallRecord[]; effort: Effort; warnings: string[] }> {
  const { jobId, ctx, task, opts, step } = args;
  const effort: Effort = opts.effort ?? "medium";
  const model = opts.model ?? process.env.VEDIT_PLANNER_MODEL ?? DEFAULT_MODEL;
  const choice: BackendChoice = opts.backend ?? (process.env.VEDIT_PLANNER as BackendChoice | undefined) ?? "auto";
  const backend = opts.backendInstance ?? selectBackend(choice, { model, effort, cacheTtl: opts.cacheTtl, verbose: opts.verbose });
  opts.onEvent?.(backend.note);
  const warnings: string[] = [];

  const attempt = async (contract: Contract) => {
    const budget = new BudgetTracker(opts.budget);
    const state = newToolState();
    const deps: ToolDeps = {
      framesDir: path.join(jobDir(jobId), "frames"),
      extractFrame: opts.extractFrame,
      frameBudget: budget.budget.frameBudget,
      maxToolCalls: budget.budget.maxToolCalls,
      onCall: (rec) => opts.verbose && opts.onEvent?.(`  ⚙ ${rec.name} ${JSON.stringify(rec.input).slice(0, 60)} ${rec.ms}ms${rec.ok ? "" : " ✖"}`),
    };
    const tools = opts.tools === false ? [] : makePlannerTools(ctx, state, deps, { contract, mode: task.kind, currentEdl: task.currentEdl, maxRepairs: budget.budget.maxRepairs });
    const onTurn = async (turn: Turn) => {
      for (const c of turn.perCall) {
        await addCost(jobId, {
          step,
          provider: backend.name === "api" ? "anthropic" : backend.name,
          model: c.model,
          units: { ...c.usage, calls: 1, tool_calls: c.tools.length, unpriced: c.priced ? 0 : 1, estimate: backend.name === "agent" ? 1 : 0 },
          usd: c.usd,
        });
      }
      opts.onEvent?.(`  ↳ ${turn.stopReason}, ${turn.calls} запрос(ов), $${turn.perCall.reduce((s, c) => s + c.usd, 0).toFixed(3)}`);
    };
    const loop = await runPlannerLoop(backend, ctx, task, {
      budget,
      maxRepairs: budget.budget.maxRepairs,
      contract,
      tools,
      state,
      system: SYSTEM_PROMPT + (contract === "submit" ? SUBMIT_ADDENDUM : ""),
      draftJsonSchema: draftJsonSchema(),
      onTurn,
    });
    return { loop, toolCalls: state.trace };
  };

  let contract: Contract = opts.contract ?? "format";
  try {
    const r = await attempt(contract);
    return { ...r, backend, contract, effort, warnings };
  } catch (err) {
    if (err instanceof PlanError && err.code === "contract" && contract === "format") {
      // requests made before the rejection are still money: log them
      for (const c of (err.details?.perCall as { model: string; usage: Record<string, number>; usd: number; priced: boolean; tools: string[] }[] | undefined) ?? []) {
        await addCost(jobId, { step, provider: "anthropic", model: c.model, units: { ...c.usage, calls: 1, tool_calls: c.tools.length, unpriced: c.priced ? 0 : 1, estimate: 0 }, usd: c.usd });
      }
      warnings.push(`api_rejected_format_with_tools: ${err.message}`);
      opts.onEvent?.("  ⚠ API не принял structured output вместе с инструментами — переключаюсь на submit_edl");
      contract = "submit";
      const r = await attempt(contract);
      return { ...r, backend, contract, effort, warnings };
    }
    throw err;
  }
}

export function buildReport(kind: "plan" | "revise", loop: LoopResult, extra: { backend: PlannerBackend; contract: Contract; effort: string; ctx: PlanContext; instruction: string; preset: string; toolCalls: ToolCallRecord[]; warnings: string[]; startedAt: number }): PlanReport {
  const outputs = (loop.resolved?.outputs ?? []).map((o) => ({
    id: o.id,
    status: o.output ? ("ok" as const) : ("dropped" as const),
    aspect: o.aspect,
    duration_s: o.duration_s,
    target_s: o.target_s,
    clips: o.clips.length,
    captions_language: o.captions_language,
  }));
  const cacheMiss = loop.perCall.length >= 2 && loop.perCall.slice(1).every((c) => c.usage.cache_read_input_tokens === 0) && extra.backend.name === "api";
  return PlanReportSchema.parse({
    kind,
    status: loop.status,
    backend: extra.backend.name,
    backend_note: extra.backend.note,
    backend_account: loop.account,
    contract: extra.contract,
    model: extra.backend.model,
    effort: extra.effort,
    mode: extra.ctx.mode,
    speaker: extra.ctx.speaker,
    windows: extra.ctx.windows.length ? extra.ctx.windows : undefined,
    pack_hash: extra.ctx.packHash,
    pack_tokens_estimate: extra.ctx.tokenEstimate,
    prompt_version: PROMPT_VERSION,
    instruction: extra.instruction,
    preset: extra.preset,
    calls: loop.calls,
    repairs: loop.repairs,
    tool_calls: extra.toolCalls,
    tools_seen: loop.toolsSeen,
    per_call: loop.perCall,
    usage: loop.usage,
    usd: loop.usd,
    priced: loop.priced,
    estimate: loop.estimate,
    outputs,
    fixed: loop.fixed,
    issues: loop.issues,
    warnings: [...extra.warnings, ...(cacheMiss ? ["кэш промпта не сработал: cache_read_input_tokens = 0 во всех запросах после первого"] : [])],
    draft: loop.draft ?? undefined,
    error: loop.error,
    error_code: loop.errorCode,
    wall_seconds: (Date.now() - extra.startedAt) / 1000,
  });
}

/** PLAN: instruction + analysis → edl.json (always writes plan.json; edl.draft.json on failure). */
export async function plan(jobId: string, opts: PlanOptions): Promise<PlanResult> {
  const startedAt = Date.now();
  const dir = jobDir(jobId);
  const job = await loadJob(jobId);
  const presetName = opts.preset ?? job.preset ?? "bold_pop";
  const inputs = await loadPlanInputs(jobId, presetName, { speaker: opts.speaker, long: opts.long, maxWindows: opts.maxWindows, instruction: opts.instruction, llm: opts.shortlistLlm, onEvent: opts.onEvent });
  await writeJson(path.join(dir, "job.json"), JobSchema, { ...job, prompt: opts.instruction, preset: inputs.presetName });

  const task: LoopTask = { kind: "plan", instruction: opts.instruction, presetName: inputs.presetName };
  const run = await runPlanning({ jobId, ctx: inputs.ctx, task, opts, step: "plan" });
  const report = buildReport("plan", run.loop, { backend: run.backend, contract: run.contract, effort: run.effort, ctx: inputs.ctx, instruction: opts.instruction, preset: inputs.presetName, toolCalls: run.toolCalls, warnings: [...inputs.warnings, ...run.warnings], startedAt });
  await writeJson(path.join(dir, "plan.json"), PlanReportSchema, report);

  if (run.loop.resolved?.edl && report.status !== "failed") {
    const edl = await writeJson(path.join(dir, "edl.json"), EdlSchema, run.loop.resolved.edl);
    return { report, edl, partial: report.status === "partial" };
  }
  if (run.loop.draft) await fs.writeFile(path.join(dir, "edl.draft.json"), JSON.stringify(run.loop.draft, null, 2));
  throw new PlanError(report.error ?? "план не получен", (report.error_code as PlanError["code"] | undefined) ?? "invalid", { report });
}
