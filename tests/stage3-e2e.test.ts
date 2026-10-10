// plan()/revise() against a temporary workspace with the mock backend. VEDIT_WORKSPACE is
// read when workspace.ts loads, so it is set before the dynamic imports below.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { createJob, jobDir, readJson, writeJson } = await import("../src/lib/workspace.ts");
const { MediaSchema, TranscriptSchema, ScenesSchema, HighlightsSchema, EdlSchema, PlanReportSchema, ReviseReportSchema, CostSchema } = await import("../src/schemas/index.ts");
const { plan } = await import("../src/plan/index.ts");
const { revise } = await import("../src/plan/revise.ts");
const { MockBackend } = await import("../src/plan/backend/mock.ts");
const { GOOD_DRAFT, BAD_DRAFT_UNKNOWN_REF, MEDIA, SCENES, HIGHLIGHTS, TINY_JPEG, makeTranscript } = await import("./helpers/plan-fixture.ts");
const { CutReportSchema } = await import("../src/cut/index.ts");

async function seedJob() {
  const job = await createJob("C:/fixture/cafe.mp4");
  const dir = jobDir(job.id);
  await writeJson(path.join(dir, "media.json"), MediaSchema, MEDIA);
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, makeTranscript());
  await writeJson(path.join(dir, "scenes.json"), ScenesSchema, SCENES);
  await writeJson(path.join(dir, "highlights.json"), HighlightsSchema, HIGHLIGHTS);
  return job.id;
}
const extractFrame = async (_v: string, _t: number, file: string) => (await fs.writeFile(file, TINY_JPEG), file);

test("plan(): writes edl.json, plan.json and cost entries", async () => {
  const id = await seedJob();
  const r = await plan(id, { instruction: "2 рилса", backendInstance: new MockBackend({ turns: [{ text: GOOD_DRAFT, usd: 0.1 }] }), extractFrame });
  assert.equal(r.report.status, "ok");
  assert.equal(r.partial, false);
  const edl = await readJson(path.join(jobDir(id), "edl.json"), EdlSchema);
  assert.equal(edl.outputs.length, 2);
  const report = await readJson(path.join(jobDir(id), "plan.json"), PlanReportSchema);
  assert.equal(report.backend, "mock");
  assert.equal(report.calls, 1);
  assert.equal(report.usd, 0.1);
  const cost = await readJson(path.join(jobDir(id), "cost.json"), CostSchema);
  assert.equal(cost.entries.length, 1);
  assert.equal(cost.entries[0].step, "plan");
  assert.equal(cost.total_usd, 0.1);
});

test("plan(): failure keeps the draft and the report", async () => {
  const id = await seedJob();
  const allBad = { ...BAD_DRAFT_UNKNOWN_REF, outputs: [BAD_DRAFT_UNKNOWN_REF.outputs[0]] };
  await assert.rejects(
    () => plan(id, { instruction: "x", backendInstance: new MockBackend({ turns: [{ text: allBad }, { text: allBad }, { text: allBad }] }), extractFrame }),
    (e: Error & { code?: string }) => e.code === "invalid",
  );
  const report = await readJson(path.join(jobDir(id), "plan.json"), PlanReportSchema);
  assert.equal(report.status, "failed");
  assert.equal(report.repairs, 2);
  assert.ok(await fs.stat(path.join(jobDir(id), "edl.draft.json")));
  await assert.rejects(() => fs.stat(path.join(jobDir(id), "edl.json")));
  const cost = await readJson(path.join(jobDir(id), "cost.json"), CostSchema);
  assert.equal(cost.entries.length, 3, "every turn is logged even when the plan fails");
});

test("plan(): --no-tools passes an empty tool list; missing understand → nothing_to_plan", async () => {
  const id = await seedJob();
  let seen: number | undefined;
  const backend = new MockBackend({ turns: [{ text: GOOD_DRAFT }] });
  const orig = backend.start.bind(backend);
  backend.start = async (req) => ((seen = req.tools.length), orig(req));
  await plan(id, { instruction: "x", backendInstance: backend, tools: false, extractFrame });
  assert.equal(seen, 0);

  const bare = await createJob("C:/fixture/cafe.mp4");
  await writeJson(path.join(jobDir(bare.id), "media.json"), MediaSchema, MEDIA);
  await assert.rejects(() => plan(bare.id, { instruction: "x", backendInstance: new MockBackend({ turns: [{ text: GOOD_DRAFT }] }) }), (e: Error & { code?: string }) => e.code === "nothing_to_plan");
});

test("revise(): a partial result keeps the previous version of an output the model broke", async () => {
  const id = await seedJob();
  await plan(id, { instruction: "x", backendInstance: new MockBackend({ turns: [{ text: GOOD_DRAFT }] }), extractFrame });
  const broken = { ...GOOD_DRAFT, outputs: [{ ...GOOD_DRAFT.outputs[0], clips: [{ start: "p99", end: "p2" }] }, { ...GOOD_DRAFT.outputs[1], captions: { enabled: false } }] };
  const r = await revise(id, { edit: "сломай reel_1", backendInstance: new MockBackend({ turns: [{ text: broken }, { text: broken }, { text: broken }] }), extractFrame });
  assert.equal(r.report.status, "partial");
  assert.deepEqual(r.edl.outputs.map((o) => o.id), ["reel_1", "wide_1"], "reel_1 is not deleted");
  assert.equal(r.edl.outputs[0].clips.length, 3, "reel_1 keeps its previous clips");
  assert.deepEqual(r.report.diff.changed.map((c) => c.id), ["wide_1"]);
  assert.deepEqual(r.affected, []);
  assert.ok(r.report.warnings.some((w) => /reel_1: правка не применена/.test(w)));
});

test("revise(): diff, backup, affected outputs and cut.json merge", async () => {
  const id = await seedJob();
  await plan(id, { instruction: "x", backendInstance: new MockBackend({ turns: [{ text: GOOD_DRAFT }] }), extractFrame });
  const dir = jobDir(id);
  // pretend a cut happened
  await writeJson(path.join(dir, "cut.json"), CutReportSchema, { outputs: [{ id: "reel_1", status: "ok", path: "a", duration: 14.6, expected_duration: 14.65, warnings: [] }, { id: "wide_1", status: "ok", path: "b", duration: 2.7, expected_duration: 2.7, warnings: [] }] });

  const changed = { ...GOOD_DRAFT, outputs: [{ ...GOOD_DRAFT.outputs[0], clips: GOOD_DRAFT.outputs[0].clips.slice(1), target_duration: 12 }, { ...GOOD_DRAFT.outputs[1], captions: { enabled: false } }] };
  const r = await revise(id, { edit: "убери первый кусок в reel_1, выключи субтитры в wide_1", backendInstance: new MockBackend({ turns: [{ text: changed }] }), extractFrame });
  assert.equal(r.report.status, "ok");
  assert.deepEqual(r.report.diff.changed.map((c) => c.id), ["reel_1", "wide_1"]);
  assert.deepEqual(r.affected, ["reel_1"]);
  assert.deepEqual(r.report.diff.stages.wide_1, ["design", "render"]);
  assert.equal(r.report.previous_edl, "edl.v1.json");
  assert.ok(await fs.stat(path.join(dir, "edl.v1.json")));
  const rr = await readJson(path.join(dir, "revise.json"), ReviseReportSchema);
  assert.equal(rr.kind, "revise");
  const cost = await readJson(path.join(dir, "cost.json"), CostSchema);
  assert.deepEqual(cost.entries.map((e) => e.step), ["plan", "revise"]);

  // the revise prompt carried the current plan as refs
  const backend = new MockBackend({ turns: [{ text: changed }] });
  const origStart = backend.start.bind(backend);
  let taskText = "";
  backend.start = async (req) => ((taskText = req.taskText), origStart(req));
  await revise(id, { edit: "ещё раз", backendInstance: backend, extractFrame });
  assert.match(taskText, /CURRENT PLAN/);
  assert.match(taskText, /"start":"p2"/);
  assert.equal(r.report.diff.removed.length, 0);
});
