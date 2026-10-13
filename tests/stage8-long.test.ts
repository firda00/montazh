import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { createJob, jobDir, readJson, writeJson } = await import("../src/lib/workspace.ts");
const { transcriptFromFaster, labelSpeakers, resolveSpeaker, ASR_SCRIPT } = await import("../src/understand/asr.ts");
const { selectAsr } = await import("../src/understand/index.ts");
const { transcribe } = await import("../src/understand/whisper.ts");
const { buildPlanContext } = await import("../src/plan/context.ts");
const { shortlist, mergeWindows, windowsFromHighlights, isLong, phraseIndex, SPLIT_PHRASES } = await import("../src/plan/shortlist.ts");
const { loadPlanInputs } = await import("../src/plan/index.ts");
const { BUILTIN_PRESETS } = await import("../src/plan/presets.ts");
const { MediaSchema, PresetSchema, ScenesSchema, SpeakersSchema, TranscriptSchema, HighlightsSchema, CostSchema } = await import("../src/schemas/index.ts");
const { MEDIA, makeTranscript } = await import("./helpers/plan-fixture.ts");
import type { StructuredFn } from "../src/lib/llm.ts";
import type { SidecarRunner } from "../src/understand/asr.ts";
import type { ChunkFallback, WhisperCliRunner, WhisperJson } from "../src/understand/whisper.ts";
import type { Speakers, Transcript } from "../src/schemas/index.ts";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VENV_PYTHON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "tools", "asr", ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));

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

test("selectAsr: cpp for short files on a CPU box, faster with a GPU, for files over 20 min or when asked; explicit faster needs the sidecar", async () => {
  const venv = { VEDIT_ASR_PYTHON: process.execPath }; // any existing file stands in for the venv python
  const cpu = { gpu: async () => false };
  assert.equal((await selectAsr("auto", venv, cpu)).engine, "whisper.cpp", "old signature: no duration → short-file rule");
  assert.deepEqual(await selectAsr("auto", venv, cpu, 19 * 60), { engine: "whisper.cpp", python: null, reason: "CPU, short file" });
  const long = await selectAsr("auto", venv, cpu, 137 * 60);
  assert.equal(long.engine, "faster-whisper");
  assert.equal(long.python, process.execPath);
  assert.match(long.reason, /^long file \(137 min > 20 min/);
  const gpu = await selectAsr("auto", venv, { gpu: async () => true });
  assert.deepEqual([gpu.engine, gpu.reason], ["faster-whisper", "GPU"]);
  assert.deepEqual(await selectAsr("auto", { VEDIT_ASR_PYTHON: "C:/nope/python.exe" }, cpu, 137 * 60), { engine: "whisper.cpp", python: null, reason: "sidecar not installed" }, "long file without the sidecar stays on whisper.cpp");
  assert.equal((await selectAsr("cpp", venv, cpu, 137 * 60)).engine, "whisper.cpp", "explicit cpp wins over the long-file rule");
  assert.equal((await selectAsr("faster", venv, { gpu: async () => false })).engine, "faster-whisper");
  assert.equal((await selectAsr("auto", { ...venv, VEDIT_ASR: "faster" }, { gpu: async () => false })).engine, "faster-whisper");
  assert.equal((await selectAsr("cpp", venv)).engine, "whisper.cpp");
  await assert.rejects(() => selectAsr("faster", { VEDIT_ASR_PYTHON: "C:/nope/python.exe" }), /сайдкар не установлен/);
  await assert.rejects(() => selectAsr("auto", { VEDIT_ASR: "turbo" }), /VEDIT_ASR/);
});

test("speaker sidecar selftest: micro-clusters merge into the nearest speaker (numpy only)", { skip: existsSync(VENV_PYTHON) ? false : `no ASR venv at ${VENV_PYTHON} — selftest skipped` }, () => {
  const r = spawnSync(VENV_PYTHON, ["-I", ASR_SCRIPT, "selftest"], { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(r.status, 0, `selftest failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /selftest ok: merge_small_clusters/);
});

/** 16 kHz mono 16-bit WAV: a 440 Hz tone where `speech` says so, digital silence elsewhere. */
async function writeToneWav(file: string, seconds: number, speech: [number, number][]) {
  const rate = 16000;
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const on = speech.some(([a, b]) => t >= a && t < b);
    buf.writeInt16LE(on ? Math.round(12000 * Math.sin(2 * Math.PI * 440 * t)) : 0, 44 + i * 2);
  }
  await fs.writeFile(file, buf);
}

function whisperJson(text: string): WhisperJson {
  const words = text.split(" ");
  return {
    result: { language: "ru" },
    transcription: [{ offsets: { from: 0, to: words.length * 400 }, text: ` ${text}`, tokens: words.map((w, i) => ({ text: ` ${w}`, offsets: { from: i * 400, to: i * 400 + 350 }, p: 0.9, t_dtw: -1 })) }],
  };
}

test("transcribe: a failed whisper-cli chunk is retried once, then handed to faster-whisper with chunk-offset times", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-whisper-"));
  const audio = path.join(dir, "audio.wav");
  await writeToneWav(audio, 10, [[0, 3], [4, 7], [8, 10]]);

  const calls: string[] = [];
  // chunk 0 works, chunk 1 crashes once, chunk 2 crashes every time
  const runCli: WhisperCliRunner = async (wav, outBase) => {
    const name = path.basename(outBase);
    calls.push(name);
    assert.ok(existsSync(wav), "the chunk WAV exists while whisper-cli runs");
    if (name === "chunk_2" || (name === "chunk_1" && calls.filter((c) => c === name).length === 1)) throw new Error("whisper-cli.exe exited with code 3221226505:\nstack overrun");
    await fs.writeFile(`${outBase}.json`, JSON.stringify(whisperJson(name === "chunk_0" ? "Первый кусок." : "Второй кусок.")));
  };
  const fbCalls: { wav: string; duration: number }[] = [];
  const fasterFallback: ChunkFallback = async (wav, duration, outDir) => {
    assert.ok(existsSync(wav), "the chunk WAV is still there for the fallback");
    fbCalls.push({ wav, duration });
    return {
      transcript: { language: "ru", segments: [{ start: 0.5, end: 1.5, text: "Третий кусок.", lang: "ru", words: [{ w: "Третий", start: 0.5, end: 1 }, { w: "кусок.", start: 1, end: 1.5 }] }] },
      chunks: [{ index: 0, start: 0, end: duration, json: path.join(outDir, "whisper", "faster.json"), language: "ru", wall_seconds: 1 }],
      model: "large-v3-turbo (faster-whisper, cpu/int8)",
      method: "faster-whisper",
      wall_seconds: 1,
      warnings: ['dropped likely hallucination "Субтитры сделал DimaTorzok"'],
    };
  };
  const r = await transcribe(audio, 10, dir, { chunk: { target: 4 }, runCli, fasterFallback });
  assert.deepEqual(calls, ["chunk_0", "chunk_1", "chunk_1", "chunk_2", "chunk_2"]);
  assert.equal(fbCalls.length, 1);
  assert.equal(path.basename(fbCalls[0].wav), "chunk_2.wav");
  assert.deepEqual(r.transcript.segments.map((s) => s.text), ["Первый кусок.", "Второй кусок.", "Третий кусок."]);
  assert.equal(r.chunks.length, 3);
  assert.deepEqual(r.chunks.map((c) => c.engine), [undefined, undefined, "faster-whisper"]);
  const c2 = r.chunks[2];
  assert.ok(Math.abs(fbCalls[0].duration - (c2.end - c2.start)) < 1e-9);
  const third = r.transcript.segments[2];
  assert.ok(Math.abs(third.start - (c2.start + 0.5)) < 0.002 && Math.abs(third.end - (c2.start + 1.5)) < 0.002, JSON.stringify({ third, c2 }));
  assert.ok(Math.abs(third.words[1].start - (c2.start + 1)) < 0.002, "words are shifted too");
  assert.ok(r.warnings.some((w) => /^chunk 1: retry after whisper-cli\.exe exited with code 3221226505:$/.test(w)), r.warnings.join("\n"));
  assert.ok(r.warnings.some((w) => /^chunk 2: retry after /.test(w)));
  assert.ok(r.warnings.some((w) => /^chunk 2 \(.*\): whisper-cli crashed twice, transcribed with faster-whisper$/.test(w)));
  assert.ok(r.warnings.some((w) => /^chunk 2: dropped likely hallucination/.test(w)));
  assert.ok(!r.warnings.some((w) => /failed/.test(w)), "nothing is reported as failed");
  assert.ok(!existsSync(path.join(dir, "whisper", "chunk_2.wav")), "chunk WAVs are cleaned up");
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "whisper", "chunks.json"), "utf8")) as { chunks: { engine?: string }[] };
  assert.equal(manifest.chunks[2].engine, "faster-whisper");

  // the fallback fails too → the old warning, with both reasons; no fallback → just whisper-cli's
  const r2 = await transcribe(audio, 10, dir, { chunk: { target: 4 }, runCli, fasterFallback: async () => { throw new Error("no module torch"); } });
  assert.equal(r2.chunks.length, 2);
  assert.ok(r2.warnings.some((w) => /^chunk 2 \(.*\) failed: whisper-cli\.exe exited.*; faster-whisper: no module torch$/s.test(w)), r2.warnings.join("\n"));
  const r3 = await transcribe(audio, 10, dir, { chunk: { target: 4 }, runCli, fasterFallback: null });
  assert.equal(r3.chunks.length, 2);
  assert.ok(r3.warnings.some((w) => /^chunk 2 \(.*\) failed: whisper-cli\.exe exited with code 3221226505:\nstack overrun$/.test(w)), r3.warnings.join("\n"));
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

test("shortlist: over 2000 phrases the index goes in two halves, windows split proportionally, merged and capped; cost summed", async () => {
  const n = 2100;
  const t: Transcript = {
    language: "ru",
    segments: Array.from({ length: n }, (_v, i) => ({ start: i * 2, end: i * 2 + 1.5, text: `фраза ${i}.`, lang: "ru", words: [{ w: "фраза", start: i * 2, end: i * 2 + 0.7 }, { w: `${i}.`, start: i * 2 + 0.8, end: i * 2 + 1.5 }] })),
  };
  assert.ok(n > SPLIT_PHRASES);
  const prompts: string[] = [];
  const ids = (p: string) => [...p.matchAll(/^p(\d+) /gm)].map((m) => Number(m[1]));
  const usage = { input_tokens: 20_000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
  const llm: StructuredFn = async (q) => {
    prompts.push(q.prompt);
    const first = ids(q.prompt)[0] === 0;
    // each half also names an id from the other half, which it never saw: ignored
    const windows = first
      ? [{ from: "p10", to: "p12", why: "a" }, { from: "p500", to: "p501", why: "b" }, { from: "p1500", to: "p1501", why: "foreign" }]
      : [{ from: "p1100", to: "p1102", why: "c" }, { from: "p2099", to: "p2099", why: "d" }, { from: "p5", to: "p6", why: "foreign" }];
    return { data: { windows }, usage, usd: 0.05, estimate: false, model: "mock-model", provider: "mock" };
  };
  const events: string[] = [];
  const r = await shortlist({ transcript: t, highlights: [], instruction: "лучшее", llm, maxWindows: 3, onEvent: (l) => events.push(l) });
  assert.equal(prompts.length, 2, "one call per half");
  const a = ids(prompts[0]);
  const b = ids(prompts[1]);
  assert.deepEqual([a.length, a[0], a.at(-1)], [1050, 0, 1049]);
  assert.deepEqual([b.length, b[0], b.at(-1)], [1050, 1050, 2099]);
  assert.match(prompts[0], /Pick up to 2 candidate windows/, "ceil(3 × 1050 / 2100) = 2 per half");
  assert.match(prompts[1], /Pick up to 2 candidate windows/);
  assert.match(prompts[0], /The video has 1050 phrases/);
  assert.equal(r.windows.length, 3, "4 usable picks, capped at max");
  assert.deepEqual(r.windows.map((w) => w.why), ["a", "b", "c"]);
  assert.ok(!r.windows.some((w) => /foreign/.test(w.why)));
  assert.equal(r.usd, 0.1);
  assert.deepEqual(r.usage, { input_tokens: 40_000, output_tokens: 200 });
  assert.equal(r.calls, 2);
  assert.match(r.note, /^shortlist: 3 окон от модели \(2 прохода, mock-model\)$/);
  assert.ok(events.some((e) => /проход 2\/2: p1050–p2099/.test(e)), events.join("\n"));

  // one half failing keeps the other half's windows and says so
  let k = 0;
  const flaky: StructuredFn = async (q) => {
    if (k++ === 0) throw new Error("overloaded");
    return llm(q);
  };
  const r2 = await shortlist({ transcript: t, highlights: [], instruction: "лучшее", llm: flaky, maxWindows: 3 });
  assert.deepEqual(r2.windows.map((w) => w.why), ["c", "d"]);
  assert.match(r2.note, /2 прохода.*; model call failed \(overloaded\)/);
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
