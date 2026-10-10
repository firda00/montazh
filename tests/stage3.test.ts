import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { buildPlanContext, renderPack } from "../src/plan/context.ts";
import { draftFromEdl, nearestBoundaryRef, parseRef, resolveRef } from "../src/plan/refs.ts";
import { resolveDraft } from "../src/plan/resolve.ts";
import { draftJsonSchema, zodToApiSchema } from "../src/plan/schema-sanitize.ts";
import { makePlannerTools, newToolState } from "../src/plan/tools.ts";
import { parseDraft, runPlannerLoop } from "../src/plan/loop.ts";
import { BudgetTracker } from "../src/plan/budget.ts";
import { SYSTEM_PROMPT, buildTaskText } from "../src/plan/prompt.ts";
import { usdForUsage } from "../src/plan/pricing.ts";
import { MockBackend, heuristicDraft } from "../src/plan/backend/mock.ts";
import { selectBackend } from "../src/plan/backend/index.ts";
import { diffEdl, needsCut } from "../src/plan/diff.ts";
import { EdlSchema, type PlanDraft } from "../src/schemas/index.ts";
import { z } from "zod";
import { BUILTIN_PRESETS } from "../src/plan/presets.ts";
import { GOOD_DRAFT, BAD_DRAFT_UNKNOWN_REF, HIGHLIGHTS, MEDIA, SCENES, TINY_JPEG, longTranscript, makeFixtureContext, makeTranscript } from "./helpers/plan-fixture.ts";

const ctx = makeFixtureContext();

test("context: deterministic pack with ids, gaps and cross-refs", () => {
  const again = makeFixtureContext();
  assert.equal(ctx.packText, again.packText);
  assert.equal(ctx.packHash, again.packHash);
  assert.deepEqual(ctx.phrases.map((p) => p.id), ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
  assert.deepEqual(ctx.scenes.map((s) => s.id), ["s0", "s1", "s2"]);
  assert.ok(ctx.gaps.some((g) => g.start === 5.75 && g.end === 8.29), "pause between p1 and p2 is a gap");
  assert.ok(ctx.gaps.some((g) => g.start === 32.07 && g.end === 35), "trailing silence is a gap");
  assert.ok(ctx.gaps.some((g) => g.start === 2.3 && g.end === 3.2), "a 0.9 s pause is a gap");
  assert.ok(ctx.gaps.every((g) => g.end - g.start >= 0.5), "nothing shorter than 0.5 s is a gap");
  assert.deepEqual(ctx.scenes[1].phrases, ["p2", "p3", "p4"]);
  assert.equal(ctx.highlights[0].phrases[0], "p0");
  assert.equal(ctx.mode, "full");
  assert.ok(!ctx.packText.includes("C:/"), "no paths in the pack");
  assert.ok(ctx.packText.includes('"is_stub":true'));
});

test("context: very long transcript → compact mode", () => {
  const long = buildPlanContext({ media: { ...MEDIA, duration: 1600 }, transcript: longTranscript(), scenes: SCENES, highlights: HIGHLIGHTS, preset: BUILTIN_PRESETS.bold_pop });
  assert.equal(long.mode, "compact");
  assert.ok(long.packText.length < renderPack({ ...long, mode: "full" }).length);
});

test("refs: parse table and resolution", () => {
  assert.deepEqual(parseRef("p3"), { kind: "p", n: 3, edge: undefined });
  assert.deepEqual(parseRef("p3.end"), { kind: "p", n: 3, edge: "end" });
  assert.deepEqual(parseRef("s1.start"), { kind: "s", n: 1, edge: "start" });
  assert.deepEqual(parseRef("g2"), { kind: "g", n: 2, edge: undefined });
  assert.deepEqual(parseRef("p3.w4"), { kind: "w", n: 3, k: 4 });
  assert.deepEqual(parseRef("t12.4"), { kind: "t", seconds: 12.4 });
  assert.equal(parseRef("P3"), null);
  assert.equal(parseRef("x1"), null);
  assert.equal(parseRef("12.4"), null);

  const a = resolveRef("p2", "start", ctx);
  const b = resolveRef("p2", "end", ctx);
  assert.ok(a.ok && b.ok);
  assert.equal(a.t, 8.29);
  assert.equal(b.t, 13.08);
  const gap = ctx.gaps.find((g) => g.start === 5.75)!;
  const gs = resolveRef(gap.id, "start", ctx);
  const ge = resolveRef(gap.id, "end", ctx);
  assert.ok(gs.ok && ge.ok);
  assert.equal(gs.t, 8.29, "a gap used as a clip start means the clip starts when the pause ends");
  assert.equal(ge.t, 5.75, "a gap used as a clip end means the clip ends when the pause starts");
  const w = resolveRef("p2.w1", "start", ctx);
  assert.ok(w.ok && w.t === 8.74);
  assert.ok(!resolveRef("p99", "start", ctx).ok);
  assert.ok(!resolveRef("p2.w99", "end", ctx).ok);
});

test("refs: draftFromEdl round-trips boundaries and keeps hand-set edges as tS", () => {
  const edl = EdlSchema.parse({
    outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 8.29, src_end: 13.08 }, { src_start: 10, src_end: 16.42 }], captions: { enabled: true, language: "uz" } }],
    reasoning: "x",
  });
  const d = draftFromEdl(edl, ctx);
  assert.deepEqual(d.outputs[0].clips[0], { start: "p2", end: "p2", speed: 1, crop: "center" });
  assert.equal(d.outputs[0].clips[1].start, "t10.000");
  assert.equal(d.outputs[0].clips[1].end, "p3");
  assert.equal(nearestBoundaryRef(23.1, "start", ctx), "s2");
  assert.equal(nearestBoundaryRef(5.75, "end", ctx), "p1");
});

test("resolveDraft: good draft → EDL with defaults, no errors", () => {
  const r = resolveDraft(GOOD_DRAFT, ctx, { mode: "plan" });
  assert.deepEqual(r.errors, []);
  assert.ok(r.edl);
  const edl = EdlSchema.parse(r.edl);
  assert.equal(edl.outputs.length, 2);
  assert.equal(edl.outputs[0].clips[0].src_start, 0);
  assert.equal(edl.outputs[0].clips[0].src_end, 2.3);
  assert.equal(edl.outputs[0].clips[2].src_end, 27.16);
  assert.equal(edl.outputs[0].captions.style, "bold_pop");
  assert.equal(edl.outputs[0].transitions, "cut");
  assert.equal(r.outputs[0].duration_s, 14.65);
});

test("resolveDraft: error and warning catalogue", () => {
  const bad = resolveDraft(BAD_DRAFT_UNKNOWN_REF, ctx, { mode: "plan" });
  assert.ok(bad.errors.some((e) => e.code === "unknown_ref" && e.output === "reel_1" && /p99/.test(e.message)));
  assert.ok(bad.edl, "the valid output survives");
  assert.equal(bad.edl!.outputs.length, 1);

  const mk = (clips: PlanDraft["outputs"][0]["clips"], extra: Partial<PlanDraft["outputs"][0]> = {}): PlanDraft => ({
    brief: { style_words: [] },
    outputs: [{ id: "a", aspect: "9:16", clips, captions: { enabled: false }, titles: [], music: { enabled: false }, ...extra }],
    reasoning: "",
  });
  assert.ok(resolveDraft(mk([{ start: "p3", end: "p1" }]), ctx, { mode: "plan" }).errors.some((e) => e.code === "empty_clip"));
  assert.ok(resolveDraft(mk([{ start: "t1", end: "p1" }]), ctx, { mode: "plan" }).errors.some((e) => e.code === "raw_time"));
  assert.ok(resolveDraft(mk([{ start: "p0", end: "p0", speed: 9 }]), ctx, { mode: "plan" }).errors.some((e) => e.code === "bad_speed"));
  assert.ok(resolveDraft(mk([{ start: "p0", end: "p0", speed: 2 }]), ctx, { mode: "plan" }).warnings.some((e) => e.code === "speech_speed"));
  assert.ok(resolveDraft(mk([{ start: "p0", end: "p0" }], { id: "bad id" }), ctx, { mode: "plan" }).errors.some((e) => e.code === "bad_id"));
  const dup: PlanDraft = { brief: { style_words: [] }, outputs: [mk([{ start: "p0", end: "p0" }]).outputs[0], mk([{ start: "p1", end: "p1" }]).outputs[0]], reasoning: "" };
  assert.ok(resolveDraft(dup, ctx, { mode: "plan" }).errors.some((e) => e.code === "duplicate_id"));

  // scene edge inside «Каждое» → snapped with a warning
  const scene = resolveDraft(mk([{ start: "s1", end: "p2" }]), ctx, { mode: "plan" });
  assert.deepEqual(scene.errors, []);
  assert.ok(scene.warnings.some((w) => w.code === "cuts_word" && /Каждое/.test(w.message)));
  assert.equal(scene.edl!.outputs[0].clips[0].src_start, 8.29);

  // word and gap refs are allowed with warnings
  const word = resolveDraft(mk([{ start: "p2.w3", end: "p2" }]), ctx, { mode: "plan" });
  assert.deepEqual(word.errors, []);
  assert.ok(word.warnings.some((w) => w.code === "mid_phrase"));
  const gap = ctx.gaps.find((g) => g.start === 5.75)!;
  const g = resolveDraft(mk([{ start: "p1", end: gap.id }]), ctx, { mode: "plan" });
  assert.deepEqual(g.errors, []);
  assert.ok(g.warnings.some((w) => w.code === "gap_cut"));

  // duration far from target → error with candidates
  const short = resolveDraft(mk([{ start: "p0", end: "p0" }], { target_duration: 30 }), ctx, { mode: "plan" });
  const off = short.errors.find((e) => e.code === "duration_off");
  assert.ok(off && /too short/.test(off.message) && /p1/.test(off.suggestion ?? ""));
  // count mismatch
  const cm = resolveDraft({ ...mk([{ start: "p0", end: "p0" }]), brief: { outputs_requested: 3, style_words: [] } }, ctx, { mode: "plan" });
  assert.ok(cm.errors.some((e) => e.code === "count_mismatch"));
  // captions without language → filled with a warning
  const cap = resolveDraft(mk([{ start: "p0", end: "p0" }], { captions: { enabled: true } }), ctx, { mode: "plan" });
  assert.ok(cap.warnings.some((w) => w.code === "captions_no_language"));
  assert.equal(cap.edl!.outputs[0].captions?.language, "ru");
  // title outside the output is clamped
  const title = resolveDraft(mk([{ start: "p0", end: "p0" }], { titles: [{ at: 99, text: "x" }] }), ctx, { mode: "plan" });
  assert.ok(title.warnings.some((w) => w.code === "title_outside"));
  // revise mode accepts a carried-over tS and rejects a new one
  const current = EdlSchema.parse({ outputs: [{ id: "a", aspect: "9:16", clips: [{ src_start: 10, src_end: 13.08 }] }] });
  assert.deepEqual(resolveDraft(mk([{ start: "t10.000", end: "p2" }]), ctx, { mode: "revise", currentEdl: current }).errors, []);
  assert.ok(resolveDraft(mk([{ start: "t11.000", end: "p2" }]), ctx, { mode: "revise", currentEdl: current }).errors.some((e) => e.code === "raw_time"));
});

test("revise: an unchanged plan round-trips byte-identical through refs", () => {
  const edl = EdlSchema.parse({
    outputs: [
      { id: "reel_1", aspect: "9:16", clips: [{ src_start: 0.01, src_end: 5.74 }, { src_start: 8.29, src_end: 13.08 }], captions: { enabled: true, language: "uz" } },
      { id: "wide_1", aspect: "16:9", clips: [{ src_start: 29.37, src_end: 32.07 }] },
    ],
    reasoning: "r",
  });
  const back = resolveDraft(draftFromEdl(edl, ctx), ctx, { mode: "revise", currentEdl: edl });
  assert.deepEqual(back.errors, []);
  assert.deepEqual(EdlSchema.parse(back.edl!).outputs.map((o) => o.clips), edl.outputs.map((o) => o.clips));
  assert.deepEqual(diffEdl(edl, EdlSchema.parse(back.edl!)).unchanged, ["reel_1", "wide_1"]);
});

test("revise: titles/captions added by an edit get preset defaults, existing ones keep theirs", () => {
  const edl = EdlSchema.parse({
    outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }], captions: { enabled: false }, titles: [{ at: 0, text: "old" }] }],
    reasoning: "r",
  });
  // the calm preset has different styles than the ones the old plan carries (EdlSchema fills title style "hero")
  const calm = makeFixtureContext({ preset: BUILTIN_PRESETS.calm });
  const draft = draftFromEdl(edl, calm);
  draft.outputs[0].captions = { enabled: true, language: "uz" };
  draft.outputs[0].titles.push({ at: 1, text: "new" });
  const r = EdlSchema.parse(resolveDraft(draft, calm, { mode: "revise", currentEdl: edl }).edl!);
  assert.equal(r.outputs[0].captions.style, "clean", "captions switched on by the edit take the preset style");
  assert.equal(r.outputs[0].titles[0].style, "hero", "the old title keeps its style");
  assert.equal(r.outputs[0].titles[1].style, "minimal", "the new title takes the preset style");
  // and an untouched output stays identical even under a different preset
  const same = EdlSchema.parse(resolveDraft(draftFromEdl(edl, calm), calm, { mode: "revise", currentEdl: edl }).edl!);
  assert.deepEqual(diffEdl(edl, same).unchanged, ["reel_1"]);
});

test("revise: a target on one output never leaks into an untouched sibling; count is not checked", () => {
  const edl = EdlSchema.parse({
    outputs: [
      { id: "reel_1", aspect: "9:16", target_duration: 15, clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }, { src_start: 19.6, src_end: 27.16 }] },
      { id: "reel_2", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }] },
    ],
    reasoning: "r",
  });
  const draft = draftFromEdl(edl, ctx);
  assert.equal(draft.brief.target_duration_s, undefined);
  assert.equal(draft.brief.outputs_requested, undefined);
  const back = resolveDraft(draft, ctx, { mode: "revise", currentEdl: edl });
  assert.deepEqual(back.errors, []);
  assert.deepEqual(diffEdl(edl, EdlSchema.parse(back.edl!)).unchanged, ["reel_1", "reel_2"]);
  // even if the model echoes a brief target/count, carried outputs ignore it and the count is not enforced on edits
  const echoed = { ...draft, brief: { ...draft.brief, target_duration_s: 15, aspect: "9:16" as const, outputs_requested: 2 }, outputs: [...draft.outputs, { ...draft.outputs[1], id: "reel_3", clips: [{ start: "p4", end: "p4" }] }] };
  const r = resolveDraft(echoed, ctx, { mode: "revise", currentEdl: edl });
  assert.equal(r.outputs[1].target_s, null, "carried output ignores the echoed brief target");
  assert.equal(r.outputs[2].target_s, 15, "a NEW output in an edit still takes the brief target");
  assert.deepEqual(r.errors.map((e) => `${e.output}:${e.code}`), ["reel_3:duration_off"], "only the new 2.7 s output is far from its 15 s target");
  assert.ok(!r.errors.some((e) => e.code === "count_mismatch"));
});

test("tools: sorted, validated, budgeted, traced", async () => {
  const state = newToolState();
  const calls: string[] = [];
  const extracted: string[] = [];
  const tools = makePlannerTools(ctx, state, {
    framesDir: await fs.mkdtemp(`${process.env.TEMP ?? "/tmp"}/vedit-frames-`),
    extractFrame: async (_v, _t, file) => {
      extracted.push(file);
      await fs.writeFile(file, TINY_JPEG);
      return file;
    },
    frameBudget: 2,
    maxToolCalls: 4,
    onCall: (r) => calls.push(r.name),
  }, { contract: "format", mode: "plan", maxRepairs: 2 });
  assert.deepEqual(tools.map((t) => t.name), ["get_scene_details", "get_transcript_range", "preview_frame", "validate_edl"]);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));

  const r1 = await by.get_transcript_range.run({ start: 8, end: 14, words: true }, {});
  const j1 = JSON.parse(r1.text);
  assert.deepEqual(j1.phrases.map((p: { id: string }) => p.id), ["p2"]);
  assert.equal(j1.phrases[0].words[0].i, 0);
  assert.deepEqual(JSON.parse((await by.get_transcript_range.run({ start: 0, end: 500 }, {})).text).range, [0, 35], "range is clamped to the media");
  assert.ok((await by.get_transcript_range.run({ start: "x" }, {})).isError, "invalid args");

  const r2 = JSON.parse((await by.get_scene_details.run({ id: "s1" }, {})).text);
  assert.equal(r2.edges.start.inside_word.w, "Каждое");
  assert.equal(r2.edges.start.safe, 8.29);
  assert.equal(r2.is_stub, true);
  assert.ok((await by.get_scene_details.run({ id: "s9" }, {})).isError);

  // 4 counted calls used (invalid-argument calls are not counted) → budget text on the next
  const budgetText = await by.get_transcript_range.run({ start: 0, end: 5 }, {});
  assert.ok(/budget/.test(budgetText.text) && !budgetText.isError);
  // validate_edl is exempt from the call budget
  const v = JSON.parse((await by.validate_edl.run({ plan: GOOD_DRAFT }, {})).text);
  assert.equal(v.ok, true);
  assert.equal(v.resolved[0].clips.length, 3);

  // preview_frame: exempt? no — but budgeted by frames; use a fresh state for clarity
  const state2 = newToolState();
  const tools2 = makePlannerTools(ctx, state2, { framesDir: await fs.mkdtemp(`${process.env.TEMP ?? "/tmp"}/vedit-frames-`), extractFrame: async (_v, _t, file) => (await fs.writeFile(file, TINY_JPEG), file), frameBudget: 1 }, { contract: "format", mode: "plan", maxRepairs: 2 });
  const pf = Object.fromEntries(tools2.map((t) => [t.name, t])).preview_frame;
  const f1 = await pf.run({ t: 12.4 }, {});
  assert.equal(f1.images?.length, 1);
  assert.match(f1.text, /s1, p2/);
  const f1again = await pf.run({ t: 12.4 }, {});
  assert.equal(f1again.images?.length, 1, "cached frame is free");
  const f2 = await pf.run({ t: 20 }, {});
  assert.ok(!f2.images && /budget/.test(f2.text));
  assert.ok((await pf.run({ t: 99 }, {})).isError);
  assert.equal(state2.trace.filter((r) => r.image).length, 2);
  assert.deepEqual(calls.slice(0, 2), ["get_transcript_range", "get_transcript_range"]);
});

test("schema sanitizer keeps enums, drops constraints, closes objects", () => {
  const s = zodToApiSchema(z.object({ n: z.number().int().min(1).max(5), e: z.enum(["a", "b"]), s: z.string().max(3).optional(), arr: z.array(z.string()).min(2) }));
  const text = JSON.stringify(s);
  for (const k of ["$schema", "minimum", "maximum", "maxLength", "minItems"]) assert.ok(!text.includes(`"${k}"`), `${k} dropped`);
  assert.ok(text.includes('"enum":["a","b"]'));
  assert.equal(s.additionalProperties, false);
  const draft = draftJsonSchema();
  assert.equal(JSON.stringify(draft).includes('"9:16"'), true);
});

const loopOpts = (backend: MockBackend, contract: "format" | "submit" = "format", budget: Partial<ConstructorParameters<typeof BudgetTracker>[0]> = {}) => {
  const tracker = new BudgetTracker(budget);
  const state = newToolState();
  const tools = makePlannerTools(ctx, state, { framesDir: "/tmp/x", extractFrame: async (_v, _t, f) => (await fs.writeFile(f, TINY_JPEG), f) }, { contract, mode: "plan", maxRepairs: 2 });
  return { backend, opts: { budget: tracker, maxRepairs: 2, contract, tools, state, system: SYSTEM_PROMPT, draftJsonSchema: draftJsonSchema() } };
};
const task = { kind: "plan" as const, instruction: "2 рилса", presetName: "bold_pop" };

test("loop: happy path is one call", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: GOOD_DRAFT }] }));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(r.calls, 1);
  assert.equal(backend.received.length, 0);
  assert.ok(r.resolved?.edl);
});

test("loop: repair round trip carries the issues", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: BAD_DRAFT_UNKNOWN_REF }, { text: GOOD_DRAFT }] }));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(r.repairs, 1);
  assert.match(backend.received[0], /unknown_ref/);
  assert.match(backend.received[0], /p99/);
  assert.ok(r.fixed.some((f) => f.code === "unknown_ref"));
});

test("loop: exhausted repairs → partial when something is valid, else failed", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: BAD_DRAFT_UNKNOWN_REF }, { text: BAD_DRAFT_UNKNOWN_REF }, { text: BAD_DRAFT_UNKNOWN_REF }] }));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "partial");
  assert.equal(r.repairs, 2);
  assert.equal(r.resolved?.edl?.outputs.length, 1);

  const allBad: PlanDraft = { ...BAD_DRAFT_UNKNOWN_REF, outputs: [BAD_DRAFT_UNKNOWN_REF.outputs[0]] };
  const { backend: b2, opts: o2 } = loopOpts(new MockBackend({ turns: [{ text: allBad }, { text: allBad }, { text: allBad }] }));
  const r2 = await runPlannerLoop(b2, ctx, task, o2);
  assert.equal(r2.status, "failed");
  assert.equal(r2.errorCode, "invalid");
  assert.ok(r2.draft, "the last draft is kept for edl.draft.json");
});

test("loop: invalid JSON counts as a repair; refusal fails without repair", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: "not json at all" }, { text: "```json\n" + JSON.stringify(GOOD_DRAFT) + "\n```" }] }));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(r.repairs, 1);
  assert.match(backend.received[0], /invalid_json/);

  const { backend: b2, opts: o2 } = loopOpts(new MockBackend({ turns: [{ stopReason: "refusal", refusalCategory: "cyber" }] }));
  const r2 = await runPlannerLoop(b2, ctx, task, o2);
  assert.equal(r2.status, "failed");
  assert.equal(r2.errorCode, "refusal");
  assert.equal(b2.received.length, 0);
});

test("loop: tool turns are traced and usage summed", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ tools: [{ name: "get_scene_details", input: { id: "s1" } }, { name: "preview_frame", input: { t: 3 } }], text: GOOD_DRAFT, usage: { input_tokens: 5000, output_tokens: 700 }, usd: 0.05 }] }));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.deepEqual(opts.state.trace.map((t) => t.name), ["get_scene_details", "preview_frame"]);
  assert.equal(opts.state.frames, 1);
  assert.equal(r.usage.input_tokens, 5000);
  assert.equal(r.usd, 0.05);
});

test("loop: budget exceeded stops with partial or failed", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: BAD_DRAFT_UNKNOWN_REF, usd: 2 }, { text: GOOD_DRAFT }] }), "format", { maxUsd: 1 });
  opts.budget.addRequest(2);
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "partial");
  assert.equal(backend.received.length, 0, "no repair once the budget is gone");
});

test("loop: submit contract — accepted via tool, or nudged then failed", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ tools: [{ name: "submit_edl", input: { plan: GOOD_DRAFT } }], text: "Done." }] }), "submit");
  assert.ok(opts.tools.some((t) => t.name === "submit_edl"));
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(opts.state.submitted?.draft.outputs.length, 2);

  const { backend: b2, opts: o2 } = loopOpts(new MockBackend({ turns: [{ text: "I will plan later." }, { text: "still thinking" }, { text: "no" }] }), "submit");
  const r2 = await runPlannerLoop(b2, ctx, task, o2);
  assert.equal(r2.status, "failed");
  assert.equal(b2.received.length, 2);
  assert.match(b2.received[0], /submit_edl/);
});

test("loop: uncharged backends are metered per turn; max_iterations gets a nudge, not a bogus repair", async () => {
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: GOOD_DRAFT, usd: 0.5 }] }));
  await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(opts.budget.usd, 0.5);
  assert.equal(opts.budget.calls, 1);

  const { backend: b2, opts: o2 } = loopOpts(new MockBackend({ turns: [{ stopReason: "max_iterations" }, { text: GOOD_DRAFT }] }));
  const r2 = await runPlannerLoop(b2, ctx, task, o2);
  assert.equal(r2.status, "ok");
  assert.equal(r2.repairs, 0, "a tool-budget stop is not a validation failure");
  assert.match(b2.received[0], /tool budget/);
  assert.ok(!/VALIDATION ISSUES/.test(b2.received[0]));
});

test("resolveDraft: messages keep the draft's clip numbering when an earlier clip is skipped", () => {
  const draft: PlanDraft = {
    brief: { style_words: [] },
    outputs: [{ id: "a", aspect: "9:16", clips: [{ start: "p99", end: "p99" }, { start: "s1", end: "p2" }], captions: { enabled: false }, titles: [], music: { enabled: false } }],
    reasoning: "",
  };
  const r = resolveDraft(draft, ctx, { mode: "plan" });
  const w = r.warnings.find((x) => x.code === "cuts_word");
  assert.ok(w && w.clip === 1 && /^clip 1 /.test(w.message), `got ${w?.message}`);
});

test("loop: nothing to plan is refused before any call", async () => {
  const empty = buildPlanContext({ media: MEDIA, transcript: { language: "unknown", segments: [] }, scenes: [], highlights: [], preset: BUILTIN_PRESETS.bold_pop });
  const { backend, opts } = loopOpts(new MockBackend({ turns: [{ text: GOOD_DRAFT }] }));
  await assert.rejects(() => runPlannerLoop(backend, empty, task, opts), (e: Error & { code?: string }) => e.code === "nothing_to_plan");
});

test("parseDraft tolerates fences and prose", () => {
  assert.ok(parseDraft(`Here is the plan:\n${JSON.stringify(GOOD_DRAFT)}\nHope it helps`).draft);
  assert.equal(parseDraft(null).issues[0].code, "invalid_json");
  assert.equal(parseDraft("{}").issues[0].code, "schema");
});

test("diff: fields → stages → affected outputs", () => {
  const prev = EdlSchema.parse(resolveDraft(GOOD_DRAFT, ctx, { mode: "plan" }).edl!);
  const next = EdlSchema.parse({ ...prev, outputs: [{ ...prev.outputs[0], clips: prev.outputs[0].clips.slice(1) }, { ...prev.outputs[1], captions: { enabled: false } }, { id: "reel_3", aspect: "1:1", clips: [{ src_start: 0, src_end: 2.3 }] }] });
  const d = diffEdl(prev, next);
  assert.deepEqual(d.changed, [{ id: "reel_1", fields: ["clips"] }, { id: "wide_1", fields: ["captions"] }]);
  assert.deepEqual(d.added, ["reel_3"]);
  assert.deepEqual(d.stages.wide_1, ["design", "render"]);
  assert.deepEqual(needsCut(d), ["reel_3", "reel_1"]);
  assert.deepEqual(diffEdl(prev, prev).unchanged, ["reel_1", "wide_1"]);
});

test("pricing: only known models are priced", () => {
  const { usd, priced } = usdForUsage("claude-opus-5-5", { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 15000, cache_creation_input_tokens: 0 });
  assert.ok(priced);
  assert.ok(Math.abs(usd - (1000 * 4 + 500 * 20 + 15000 * 0.2) / 1e6) < 1e-9);
  const w = usdForUsage("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 600, ephemeral_1h_input_tokens: 400 } });
  assert.ok(Math.abs(w.usd - (600 * 5 + 400 * 8) / 1e6) < 1e-9);
  assert.deepEqual(usdForUsage("claude-mystery-9", { input_tokens: 1, output_tokens: 1 }), { usd: 0, priced: false });
});

test("backend selection by credentials", () => {
  const o = { model: "claude-opus-5-5", effort: "medium" as const };
  assert.equal(selectBackend("auto", o, { ANTHROPIC_API_KEY: "k" } as NodeJS.ProcessEnv, { loginExists: () => true }).name, "api");
  assert.equal(selectBackend("auto", o, {} as NodeJS.ProcessEnv, { loginExists: () => true }).name, "agent");
  assert.equal(selectBackend("auto", o, { CLAUDE_CODE_OAUTH_TOKEN: "t" } as NodeJS.ProcessEnv, { loginExists: () => false }).name, "agent");
  assert.throws(() => selectBackend("auto", o, {} as NodeJS.ProcessEnv, { loginExists: () => false }), (e: Error & { code?: string }) => e.code === "no_backend");
  assert.throws(() => selectBackend("api", o, {} as NodeJS.ProcessEnv, { loginExists: () => true }), (e: Error & { code?: string }) => e.code === "auth");
  assert.equal(selectBackend("mock", o, {} as NodeJS.ProcessEnv, { loginExists: () => false }).name, "mock");
});

test("prompt is frozen and task text varies only with the instruction", () => {
  assert.ok(!SYSTEM_PROMPT.includes("${"));
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(SYSTEM_PROMPT));
  const a = buildTaskText({ instruction: "x", presetName: "bold_pop", mode: "full", toolsAvailable: true });
  const b = buildTaskText({ instruction: "y", presetName: "bold_pop", mode: "full", toolsAvailable: true });
  assert.equal(a.replace("x", "y"), b);
});

test("heuristic mock reads count, duration, aspect and caption language", () => {
  const d = heuristicDraft(ctx, "2 рилса по 10 секунд, субтитры на узбекском");
  assert.equal(d.outputs.length, 2);
  assert.equal(d.outputs[0].aspect, "9:16");
  assert.equal(d.outputs[0].captions.language, "uz");
  assert.ok(d.reasoning.startsWith("[mock]"));
  const r = resolveDraft(d, ctx, { mode: "plan" });
  assert.deepEqual(r.errors, []);
  for (const o of r.outputs) assert.ok(Math.abs(o.duration_s - 10) <= 5, `${o.id} ${o.duration_s}s`);
});

test("fixture transcript has the planned word boundary", () => {
  const t = makeTranscript();
  assert.deepEqual(t.segments[2].words[0], { w: "Каждое", start: 8.29, end: 8.74 });
});
