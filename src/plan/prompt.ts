import type { PlanDraft, PlanIssue } from "../schemas/index.ts";
import { fill, loadPrompt, promptsHash } from "../lib/prompts.ts";
import { formatIssuesForModel } from "./resolve.ts";

/**
 * Planner prompts live in prompts/planner.*.md (see src/lib/prompts.ts). The version is the
 * hand-bumped base plus a hash over every prompt file, so an edited file changes plan.json's
 * prompt_version without anyone remembering to bump it.
 */
export const PROMPT_VERSION = `2026-10-12.2+${promptsHash()}`;

// Frozen: no interpolation, no job data, no dates — this block is prompt-cached across jobs.
export const SYSTEM_PROMPT = loadPrompt("planner.system");

export const SUBMIT_ADDENDUM = `\n\n${loadPrompt("planner.submit")}`;

export const AGENT_ADDENDUM = `\n\n${loadPrompt("planner.agent")}`;

export const NUDGE_TEXT = loadPrompt("planner.nudge");
export const TOOL_BUDGET_NUDGE_TEXT = loadPrompt("planner.nudge-tools");

export function buildTaskText(o: { instruction: string; presetName: string; mode: "full" | "compact" | "shortlist"; toolsAvailable: boolean; speaker?: string; style?: string }) {
  const speaker = o.speaker ? `\n${fill(loadPrompt("planner.speaker"), { speaker: o.speaker })}` : "";
  const style = o.style ? `\n${o.style}` : "";
  return fill(loadPrompt("planner.task"), { instruction: o.instruction, preset: o.presetName, mode: o.mode.toUpperCase(), speaker, style, tools: o.toolsAvailable ? "available" : "none — decide from the pack" });
}

export function buildRepairText(issues: PlanIssue[], attempt: number, max: number) {
  return fill(loadPrompt("planner.repair"), { attempt, max, issues: formatIssuesForModel(issues) });
}

export function buildReviseText(current: PlanDraft, edit: string) {
  return fill(loadPrompt("planner.revise"), { current: JSON.stringify(current), edit });
}
