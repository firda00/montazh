import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { createJob, jobDir, readJson, writeJson } = await import("../src/lib/workspace.ts");
const { transcriptFromFaster, labelSpeakers, resolveSpeaker } = await import("../src/understand/asr.ts");
const { selectAsr } = await import("../src/understand/index.ts");
const { buildPlanContext } = await import("../src/plan/context.ts");
const { shortlist, mergeWindows, windowsFromHighlights, isLong, phraseIndex } = await import("../src/plan/shortlist.ts");
const { loadPlanInputs } = await import("../src/plan/index.ts");
const { BUILTIN_PRESETS } = await import("../src/plan/presets.ts");
const { MediaSchema, PresetSchema, ScenesSchema, SpeakersSchema, TranscriptSchema, HighlightsSchema, CostSchema } = await import("../src/schemas/index.ts");
const { MEDIA, makeTranscript } = await import("./helpers/plan-fixture.ts");
import type { StructuredFn } from "../src/lib/llm.ts";
import type { SidecarRunner } from "../src/understand/asr.ts";
import type { Speakers, Transcript } from "../src/schemas/index.ts";

const preset = PresetSchema.parse(BUILTIN_PRESETS.bold_pop);

test("transcriptFromFaster: phrases split at sentence ends, hallucinations dropped, words fall back to the segment", () => {
  const { transcript, dropped } = transcriptFromFaster({
    engine: "faster-whisper",
    model: "large-v3-turbo",
    device: "cpu",
    compute_type: "int8",
    language: "ru",
    language_probability: 0.99,
    duration: 10,
    wall_seconds: 3,
    segments: [
      { start: 0, end: 4, text: "Привет всем. Начинаем.", words: [{ w: "Привет", start: 0, end: 0.5 }, { w: "всем.", start: 0.5, end: 1 }, { w: "Начинаем.", start: 2, end: 4 }] },
      { start: 5, end: 6, text: "Редактор субтитров А.Семкин", words: [] },
      { start: 7, end: 8, text: "Без слов", words: [] },
    ],
  });
  assert.deepEqual(dropped, ["Редактор субтитров А.Семкин"]);
  assert.equal(transcript.language, "ru");
  assert.deepEqual(transcript.segments.map((s) => s.text), ["Привет всем.", "Начинаем.", "Без слов"]);
  assert.equal(transcript.segments[2].words.length, 1);
  assert.equal(transcript.segments[0].lang, "ru");
});

test("labelSpeakers: phrases get speakers from the sidecar, speakers.json is written", async () => {
  const job = await createJob("C:/fixture/cafe.mp4");
  const dir = jobDir(job.id);
  const t = makeTranscript();
  const run: SidecarRunner = async (_python, args) => {
    assert.equal(args[0], "speakers");
    const phrases = JSON.parse(await fs.readFile(args[args.indexOf("--phrases") + 1], "utf8")) as { start: number }[];
    assert.equal(phrases.length, t.segments.length);
    const out = args[args.indexOf("--out") + 1];
    await fs.writeFile(
      out,
      JSON.stringify({
        engine: "ecapa",
        num_speakers: 2,
        speakers: [{ id: "S1", seconds: 20, phrases: 6 }, { id: "S2", seconds: 2, phrases: 2 }],
        phrases: phrases.map((_p, i) => ({ i, speaker: i >= 6 ? "S2" : "S1", confidence: 0.9 })),
        wall_seconds: 1.5,
      }),
    );
    return { code: 0, stderr: "" };
  };
  const r = await labelSpeakers("C:/fixture/audio.wav", t, dir, { python: "py", run });
  assert.deepEqual(r.transcript.segments.map((s) => s.speaker), ["S1", "S1", "S1", "S1", "S1", "S1", "S2", "S2"]);
  const sp = await readJson(path.join(dir, "speakers.json"), SpeakersSchema);
  assert.equal(sp.speakers[1].id, "S2");
  assert.equal(sp.speakers[1].first_at, 29.37);
  assert.match(sp.speakers[0].sample, /Каждое утро/, "sample is the speaker's longest phrase");

  // failure surfaces with the sidecar's last lines
  const bad: SidecarRunner = async () => ({ code: 1, stderr: "Traceback\nRuntimeError: no module torch" });
  await assert.rejects(() => labelSpeakers("a.wav", t, dir, { python: "py", run: bad }), /speaker labelling failed.*no module torch/s);

  // resolveSpeaker: by id, by time, by "most"
  const speakers: Speakers = sp;
  assert.equal(resolveSpeaker("s2", r.transcript, speakers), "S2");
  assert.equal(resolveSpeaker("0:30", r.transcript, speakers), "S2");
  assert.equal(resolveSpeaker("4", r.transcript, speakers), "S1");
  assert.equal(resolveSpeaker("most", r.transcript, speakers), "S1");
  assert.throws(() => resolveSpeaker("S9", r.transcript, speakers), /S9 not found/);
  assert.throws(() => resolveSpeaker("abc", r.transcript, speakers), /expected S<n>/);
});

test("selectAsr: cpp on a CPU box, faster only with a GPU or when asked, explicit faster needs the sidecar", async () => {
  const venv = { VEDIT_ASR_PYTHON: process.execPath }; // any existing file stands in for the venv python
  assert.equal((await selectAsr("auto", venv, { gpu: async () => false })).engine, "whisper.cpp");
  assert.equal((await selectAsr("auto", venv, { gpu: async () => true })).engine, "faster-whisper");
  assert.equal((await selectAsr("faster", venv, { gpu: async () => false })).engine, "faster-whisper");
  assert.equal((await selectAsr("auto", { ...venv, VEDIT_ASR: "faster" }, { gpu: async () => false })).engine, "faster-whisper");
  assert.equal((await selectAsr("cpp", venv)).engine, "whisper.cpp");
  await assert.rejects(() => selectAsr("faster", { VEDIT_ASR_PYTHON: "C:/nope/python.exe" }), /сайдкар не установлен/);
  await assert.rejects(() => selectAsr("auto", { VEDIT_ASR: "turbo" }), /VEDIT_ASR/);
});

function labelled(): Transcript {
  const t = makeTranscript();
  t.segments.forEach((s, i) => (s.speaker = i >= 6 ? "S2" : "S1"));
  return t;
}
const SPEAKERS: Speakers = { engine: "ecapa", speakers: [{ id: "S1", seconds: 20, phrases: 6, first_at: 0, sample: "Добро пожаловать" }, { id: "S2", seconds: 2, phrases: 2, first_at: 29.37, sample: "Thank you" }] };
const HIGHLIGHTS = HighlightsSchema.parse([
  { start: 8.29, end: 13.08, reason: "kazan", score: 0.9 },
  { start: 29.37, end: 30.35, reason: "thanks", score: 0.8 },
  { start: 0, end: 2.3, reason: "welcome", score: 0.7 },
]);
const SCENES = ScenesSchema.parse([
  { start: 0, end: 8.5, description: "[stub] a", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
  { start: 8.5, end: 23, description: "[stub] b", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
  { start: 23, end: 35, description: "[stub] c", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
]);

test("buildPlanContext: speaker labels in the pack, speaker filter keeps one person's phrases and their highlights", () => {
  const full = buildPlanContext({ media: MEDIA, transcript: labelled(), scenes: SCENES, highlights: HIGHLIGHTS, preset, speakers: SPEAKERS });
  const pack = JSON.parse(full.packText) as { phrases: { id: string; spk?: string }[]; speakers: { id: string }[]; speaker_filter?: string; omitted?: unknown };
  assert.equal(pack.phrases[0].spk, "S1");
  assert.equal(pack.phrases[7].spk, "S2");
  assert.deepEqual(pack.speakers.map((s) => s.id), ["S1", "S2"]);
  assert.equal(pack.speaker_filter, undefined);
  assert.equal(pack.omitted, undefined);
  assert.equal(full.mode, "full");

  const only = buildPlanContext({ media: MEDIA, transcript: labelled(), scenes: SCENES, highlights: HIGHLIGHTS, preset, speakers: SPEAKERS, speaker: "S2" });
  assert.equal(only.phrases.length, 2);
  assert.deepEqual(only.phrases.map((p) => p.id), ["p0", "p1"], "ids are renumbered over the kept phrases");
  assert.equal(only.phrases[0].text, "Thank you for watching.");
  assert.deepEqual(only.highlights.map((h) => h.reason), ["thanks"], "highlights that touch no kept phrase are dropped");
  assert.equal(only.scenes.length, 3, "scenes stay (the cut needs their edges)");
  assert.deepEqual(only.omitted, { phrases: 6, scenes: 0 });
  const p2 = JSON.parse(only.packText) as { speaker_filter: string; omitted: { phrases: number } };
  assert.equal(p2.speaker_filter, "S2");
  assert.equal(p2.omitted.phrases, 6);
  assert.notEqual(only.packHash, full.packHash);
});

test("buildPlanContext with windows: shortlist mode keeps only what the windows cover, gaps are per window", () => {
  const windows = [
    { id: "w0", start: 0, end: 6, why: "intro", source: "model" as const },
    { id: "w1", start: 19, end: 28, why: "offer", source: "model" as const },
  ];
  const ctx = buildPlanContext({ media: MEDIA, transcript: labelled(), scenes: SCENES, highlights: HIGHLIGHTS, preset, speakers: SPEAKERS, windows });
  assert.equal(ctx.mode, "shortlist");
  assert.deepEqual(ctx.phrases.map((p) => p.text.slice(0, 10)), ["Добро пожа", "Здесь гото", "Попробуйте", "Ждём вас к"]);
  assert.deepEqual(ctx.scenes.map((s) => s.id), ["s0", "s1", "s2"], "every scene touches a window (c starts at 23, inside w1)");
  assert.deepEqual(ctx.omitted, { phrases: 4, scenes: 0 });
  // no gap spanning the hole between windows (6 → 19)
  assert.ok(!ctx.gaps.some((g) => g.start < 19 && g.end > 6), JSON.stringify(ctx.gaps));
  assert.ok(ctx.gaps.some((g) => Math.abs(g.start - 2.3) < 0.01 && Math.abs(g.end - 3.2) < 0.01), "silence inside w0 is a gap");
  assert.ok(ctx.gaps.some((g) => Math.abs(g.start - 27.16) < 0.01 && Math.abs(g.end - 28) < 0.01), "trailing silence of w1 up to the window edge");
  assert.deepEqual(ctx.highlights.map((h) => h.reason), ["welcome"]);
  const pack = JSON.parse(ctx.packText) as { media: { mode: string }; windows: { id: string; phrases: string[] }[] };
  assert.equal(pack.media.mode, "shortlist");
  assert.deepEqual(pack.windows[1].phrases, ["p2", "p3"]);
});

test("shortlist: model windows are expanded to whole phrases with context, merged, split when too long; fallbacks", async () => {
  const t = labelled();
  assert.equal(isLong(t, 1000), false);
  assert.equal(isLong(t, 70_000), true);
  assert.match(phraseIndex(t), /^p0 0:00-0:02 S1 ru: Добро пожаловать в наше кафе\./m);

  const calls: string[] = [];
  const llm: StructuredFn = async (q) => {
    calls.push(q.prompt);
    return { data: { windows: [{ from: "p2", to: "p3", why: "казан" }, { from: "p3", to: "p4", why: "огонь" }, { from: "p9", to: "p1", why: "bad" }, { from: "p6", to: "p7", why: "thanks" }] }, usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.01, estimate: false, model: "mock-model", provider: "mock" };
  };
  const r = await shortlist({ transcript: t, highlights: HIGHLIGHTS, instruction: "лучшие моменты", llm, maxWindows: 10 });
  assert.match(calls[0], /INSTRUCTION: лучшие моменты/);
  assert.match(calls[0], /Speakers: S1, S2/);
  assert.equal(r.usd, 0.01);
  assert.equal(r.model, "mock-model");
  // p2–p3 and p3–p4 overlap → one core p2..p4, shown with context as p1..p5 (3.2–27.16); p6–p7 is a separate core
  // (29.37 > 16.42 + 0.5) even though its context phrase p5 overlaps the first window; the bad pick is ignored
  assert.equal(r.windows.length, 2, JSON.stringify(r.windows));
  assert.deepEqual([r.windows[0].start, r.windows[0].end], [3.2, 27.16]);
  assert.equal(r.windows[0].why, "казан; огонь");
  assert.deepEqual([r.windows[1].start, r.windows[1].end], [23.36, 32.07]);
  assert.equal(r.windows[0].source, "model");

  // too-long picks are split at phrase boundaries
  const r2 = await shortlist({ transcript: t, highlights: HIGHLIGHTS, instruction: "x", llm: async () => ({ data: { windows: [{ from: "p0", to: "p7", why: "all" }] }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0, estimate: false, model: "m", provider: "mock" }), maxWindowSeconds: 12 });
  assert.equal(r2.windows.length, 4, JSON.stringify(r2.windows));
  assert.ok(r2.windows.every((w) => w.end - w.start <= 12 + 2 * 5), "each window is one ≤12 s core plus a context phrase on each side");

  // garbage → highlights fallback; no llm → highlights
  const r3 = await shortlist({ transcript: t, highlights: HIGHLIGHTS, instruction: "x", llm: async () => ({ data: { windows: [{ from: "zz", to: "p1", why: "" }] }, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0, estimate: false, model: "m", provider: "mock" }) });
  assert.match(r3.note, /no usable windows/);
  assert.equal(r3.windows[0].source, "highlights");
  const r4 = await shortlist({ transcript: t, highlights: HIGHLIGHTS, instruction: "x" });
  assert.deepEqual(r4.windows, windowsFromHighlights(t, HIGHLIGHTS, 24));
  const r5 = await shortlist({ transcript: t, highlights: HIGHLIGHTS, instruction: "x", llm: async () => { throw new Error("quota"); } });
  assert.match(r5.note, /failed \(quota\)/);

  assert.deepEqual(mergeWindows([{ start: 10, end: 11, why: "a", source: "model" }], { language: "ru", segments: [] }), [{ id: "w0", start: 10, end: 11, why: "a", source: "model" }], "no phrases → windows kept as given");
});

test("loadPlanInputs: --speaker needs speakers.json, resolves it, long mode shortlists and revise reuses the same pack", async () => {
  const job = await createJob("C:/fixture/cafe.mp4");
  const dir = jobDir(job.id);
  await writeJson(path.join(dir, "media.json"), MediaSchema, MEDIA);
  await writeJson(path.join(dir, "transcript.json"), TranscriptSchema, labelled());
  await writeJson(path.join(dir, "scenes.json"), ScenesSchema, SCENES);
  await writeJson(path.join(dir, "highlights.json"), HighlightsSchema, HIGHLIGHTS);
  await assert.rejects(() => loadPlanInputs(job.id, "bold_pop", { speaker: "S2" }), /нет speakers\.json/);
  await writeJson(path.join(dir, "speakers.json"), SpeakersSchema, SPEAKERS);

  const a = await loadPlanInputs(job.id, "bold_pop", { speaker: "0:30" });
  assert.equal(a.ctx.speaker, "S2");
  assert.equal(a.ctx.phrases.length, 2);
  assert.ok(a.warnings.some((w) => /только говорящий S2/.test(w)));

  const llm: StructuredFn = async () => ({ data: { windows: [{ from: "p0", to: "p1", why: "intro" }] }, usage: { input_tokens: 300, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.02, estimate: false, model: "mock-model", provider: "anthropic" });
  const b = await loadPlanInputs(job.id, "bold_pop", { long: true, instruction: "best", llm, onEvent: () => {} });
  assert.equal(b.ctx.mode, "shortlist");
  assert.equal(b.ctx.windows.length, 1);
  assert.ok(b.ctx.phrases.length < 8);
  const cost = await readJson(path.join(dir, "cost.json"), CostSchema);
  assert.equal(cost.entries.at(-1)?.units.shortlist, 1);
  assert.equal(cost.entries.at(-1)?.usd, 0.02);

  // revise path: reuse → identical pack without calling the model again
  const c = await loadPlanInputs(job.id, "bold_pop", { reuse: { speaker: b.ctx.speaker, windows: b.ctx.windows }, llm: async () => { throw new Error("must not be called"); } });
  assert.equal(c.ctx.packHash, b.ctx.packHash);

  // not long by default for this short transcript
  const d = await loadPlanInputs(job.id, "bold_pop", { instruction: "best", llm: async () => { throw new Error("must not be called"); } });
  assert.equal(d.ctx.mode, "full");
});
