import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { MODULES, moduleUsage, moduleStatus, formatModules } = await import("../src/modules.ts");
const { createJob, jobDir, updateStep, writeJson } = await import("../src/lib/workspace.ts");
const { addCost } = await import("../src/lib/cost.ts");
const { JobSchema, StepNameSchema } = await import("../src/schemas/index.ts");
const { loadPrompt, fill, promptNames, promptsHash } = await import("../src/lib/prompts.ts");
const { SYSTEM_PROMPT, PROMPT_VERSION, buildTaskText, buildRepairText } = await import("../src/plan/prompt.ts");

test("registry: unique ids, every pipeline step owned by a module, every backend carries a licence", () => {
  const ids = MODULES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const step of StepNameSchema.options) {
    if (step === "revise") continue; // revise is the planner's second mode, not a module
    assert.ok(MODULES.some((m) => m.step === step), `no module for step ${step}`);
  }
  for (const m of MODULES) for (const b of m.backends) assert.ok(b.license.length > 0, `${m.id}/${b.id} has no licence`);
  assert.ok(!MODULES.some((m) => m.backends.some((b) => /remotion/i.test(b.id) && !/не использовать|прототип/i.test(b.license + b.title))), "Remotion stays marked as a non-production prototype");
});

test("prompts: every file loads, templates fill, unknown keys fail, comments are stripped, version tracks the files", () => {
  const names = promptNames();
  assert.ok(names.length >= 14, names.join(","));
  for (const n of names) assert.ok(loadPrompt(n).length > 0, n);
  assert.ok(!SYSTEM_PROMPT.includes("<!--"), "editor comments never reach the model");
  assert.match(SYSTEM_PROMPT, /^You are the planning stage/);
  assert.match(SYSTEM_PROMPT, /never create new "tS" refs\.$/);
  assert.equal(fill("a {{x}} b {{ y }}", { x: 1, y: "z" }), "a 1 b z");
  assert.throws(() => fill("{{nope}}", {}), /no value for \{\{nope\}\}/);
  assert.match(PROMPT_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+\+[0-9a-f]{10}$/);
  assert.ok(PROMPT_VERSION.endsWith(promptsHash()));
  assert.equal(buildTaskText({ instruction: "x", presetName: "bold_pop", mode: "full", toolsAvailable: false }), "INSTRUCTION:\nx\nPRESET: bold_pop\nMODE: FULL\nTOOLS: none — decide from the pack\nProduce the plan now.");
  assert.match(buildTaskText({ instruction: "x", presetName: "p", mode: "shortlist", toolsAvailable: true, speaker: "S2" }), /MODE: SHORTLIST\nSPEAKER: only S2's phrases/);
  assert.match(buildRepairText([], 1, 2), /^VALIDATION ISSUES \(attempt 1 of 2\):/);
});

test("moduleUsage: counts runs, failures and cost per module from the workspace, within the window", async () => {
  const a = await createJob("C:/videos/a.mp4");
  await updateStep(a.id, "ingest", { status: "ok" });
  await updateStep(a.id, "understand", { status: "ok" });
  await updateStep(a.id, "plan", { status: "ok" });
  await updateStep(a.id, "cut", { status: "failed" });
  await addCost(a.id, { step: "understand", provider: "whisper.cpp (local)", model: "m", units: {}, usd: 0 });
  await addCost(a.id, { step: "understand", provider: "antigravity-cli", model: "g", units: {}, usd: 0 });
  await addCost(a.id, { step: "plan", provider: "anthropic", model: "claude", units: { shortlist: 1 }, usd: 0.05 });
  await addCost(a.id, { step: "plan", provider: "anthropic", model: "claude", units: {}, usd: 0.2 });
  await addCost(a.id, { step: "design", provider: "anthropic", model: "claude", units: {}, usd: 0.03 });

  const b = await createJob("C:/ws/_bot/123/x.mp4");
  await updateStep(b.id, "ingest", { status: "ok" });
  await updateStep(b.id, "plan", { status: "ok" });
  await addCost(b.id, { step: "plan", provider: "agent", model: "claude", units: {}, usd: 0.1 });

  // an old job outside the window
  const old = await createJob("C:/videos/old.mp4");
  const oldFile = path.join(jobDir(old.id), "job.json");
  await writeJson(oldFile, JobSchema, { ...old, created_at: "2020-01-01T00:00:00.000Z", steps: { plan: { status: "ok" } } });

  const u = await moduleUsage(30);
  assert.deepEqual([u.get("planner")!.runs, u.get("planner")!.ok, Math.round(u.get("planner")!.usd * 1000)], [2, 2, 300]);
  assert.deepEqual([u.get("shortlist")!.runs, u.get("shortlist")!.usd], [1, 0.05]);
  assert.deepEqual([u.get("cut")!.runs, u.get("cut")!.failed], [1, 1]);
  assert.equal(u.get("translate")!.runs, 0, "no design step ran");
  assert.equal(u.get("translate")!.usd, 0.03, "but its cost entry is still attributed");
  assert.equal(u.get("asr")!.runs, 1);
  assert.equal(u.get("vision")!.runs, 1);
  assert.equal(u.get("speakers")!.runs, 0);
  assert.equal(u.get("bot")!.runs, 1);
  assert.equal(u.get("cli")!.runs, 1, "job a only: b is a bot job, the old one is outside the window");
  assert.equal(u.get("ingest")!.runs, 2);

  const s = await moduleStatus({ days: 30, env: {} });
  assert.equal(s.modules.length, MODULES.length);
  const text = formatModules(s, 30);
  assert.match(text, /модуль\s+этап\s+бэкенд/);
  assert.match(text, /planner\s+plan/);
  assert.match(text, /промпты: \d+ файлов/);
  const bot = s.modules.find((m) => m.id === "bot")!;
  assert.equal(bot.ready, false, "no token in an empty env");
});

test("presets and limits are part of the registry; VEDIT_BUDGET_* overrides the budget and bad values are refused", async () => {
  const { presetsCatalog, limitsCatalog } = await import("../src/modules.ts");
  const { budgetFromEnv, BudgetTracker, DEFAULT_BUDGET } = await import("../src/plan/budget.ts");

  const presets = await presetsCatalog();
  assert.ok(presets.some((p) => p.name === "bold_pop" && p.source === "file" && p.outro), JSON.stringify(presets));
  assert.ok(presets.some((p) => p.name === "calm"));
  // a broken preset file is listed with its error, not hidden
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-presets-"));
  await fs.writeFile(path.join(dir, "broken.json"), "{ \"name\": \"broken\" }");
  const withBroken = await presetsCatalog(dir);
  assert.ok(withBroken.find((p) => p.name === "broken")?.error, "schema error surfaces");
  assert.ok(withBroken.some((p) => p.name === "bold_pop" && p.source === "builtin"), "built-ins stay listed when the dir lacks them");

  assert.deepEqual(budgetFromEnv({}), DEFAULT_BUDGET);
  const b = budgetFromEnv({ VEDIT_BUDGET_USD: "3", VEDIT_BUDGET_WALL_S: "600", VEDIT_BUDGET_FRAMES: "2" });
  assert.deepEqual([b.maxUsd, b.maxWallMs, b.frameBudget, b.maxCalls], [3, 600_000, 2, DEFAULT_BUDGET.maxCalls]);
  assert.throws(() => budgetFromEnv({ VEDIT_BUDGET_CALLS: "many" }), /VEDIT_BUDGET_CALLS/);
  assert.throws(() => budgetFromEnv({ VEDIT_BUDGET_USD: "-1" }), /VEDIT_BUDGET_USD/);
  process.env.VEDIT_BUDGET_REPAIRS = "5";
  try {
    assert.equal(new BudgetTracker().budget.maxRepairs, 5, "the tracker reads the environment");
    assert.equal(new BudgetTracker({ maxRepairs: 1 }).budget.maxRepairs, 1, "an explicit value (flag) wins");
  } finally {
    delete process.env.VEDIT_BUDGET_REPAIRS;
  }

  const limits = limitsCatalog({ VEDIT_BUDGET_USD: "3", VEDIT_PLANNER_MODEL: "claude-sonnet-5-5" });
  const usd = limits.find((l) => l.id === "budget.maxUsd")!;
  assert.deepEqual([usd.value, usd.default, usd.set_by], ["$3", "$1.5", "env VEDIT_BUDGET_USD"]);
  assert.equal(limits.find((l) => l.id === "planner.model")!.value, "claude-sonnet-5-5");
  assert.ok(limits.some((l) => l.id === "shortlist.long_phrases" && l.value === "250"));
  const bad = limitsCatalog({ VEDIT_BUDGET_USD: "x" });
  assert.match(bad.find((l) => l.id === "budget.maxUsd")!.value, /^✖/);

  const s = await moduleStatus({ days: 1, env: {} });
  const text = formatModules(s, 1);
  assert.match(text, /ПРЕСЕТЫ[\s\S]*bold_pop[\s\S]*ЛИМИТЫ[\s\S]*budget\.maxUsd/);
});
