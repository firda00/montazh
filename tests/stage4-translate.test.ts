import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { createJob, jobDir, readJson } = await import("../src/lib/workspace.ts");
const { CostSchema } = await import("../src/schemas/index.ts");
const { translatePhrases, applyTranslations, retimePhrase, TranslationCacheSchema } = await import("../src/design/translate.ts");
const { buildDesignTimeline } = await import("../src/design/timeline.ts");
const { EdlSchema } = await import("../src/schemas/index.ts");
const { MEDIA, makeTranscript } = await import("./helpers/plan-fixture.ts");
import type { StructuredFn } from "../src/lib/llm.ts";

const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 5.75 }, { src_start: 29.37, src_end: 32.07 }], captions: { enabled: true, language: "uz" } }], reasoning: "" });
const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);

test("retimePhrase spreads translated words over the original span", () => {
  const p = timeline.phrases[0]; // "Добро пожаловать в наше кафе." 0–2.3
  const r = retimePhrase(p, "Bizning kafemizga xush kelibsiz.", "uz");
  assert.equal(r.lang, "uz");
  assert.equal(r.words.length, 4);
  assert.equal(r.words[0].start, p.start);
  assert.equal(r.words[3].end, p.end);
  for (let i = 1; i < r.words.length; i++) assert.ok(r.words[i].start >= r.words[i - 1].end - 1e-9);
  assert.ok(r.words[1].end - r.words[1].start > r.words[3].end - r.words[3].start, "longer words get more time");
});

test("translatePhrases batches untranslated phrases, caches them, logs cost; en phrases stay as they are when target is en", async () => {
  const job = await createJob("C:/fixture/cafe.mp4");
  const calls: string[] = [];
  const llm: StructuredFn = async (q) => {
    calls.push(q.prompt);
    const items = (JSON.parse(q.prompt.slice(q.prompt.indexOf("{"))) as { items: { i: number; text: string }[] }).items;
    return { data: { items: items.map((it) => ({ i: it.i, text: `UZ(${it.text})` })) }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.001, estimate: true, model: "mock", provider: "mock" };
  };
  const t1 = await translatePhrases(job.id, timeline.phrases, "uz", llm);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Uzbek/);
  assert.equal(t1.size, timeline.phrases.length, "ru and en phrases both translated to uz");
  const cache = await readJson(path.join(jobDir(job.id), "translations_uz.json"), TranslationCacheSchema);
  assert.equal(Object.keys(cache.entries).length, timeline.phrases.length);
  const cost = await readJson(path.join(jobDir(job.id), "cost.json"), CostSchema);
  assert.equal(cost.entries[0].step, "design");

  const t2 = await translatePhrases(job.id, timeline.phrases, "uz", llm);
  assert.equal(calls.length, 1, "second run is served from the cache");
  assert.deepEqual([...t2.entries()], [...t1.entries()]);

  const applied = applyTranslations(timeline.phrases, t1, "uz");
  assert.ok(applied.every((p) => p.lang === "uz"));
  assert.match(applied[0].text, /^UZ\(/);

  // target = en: the English phrases are not sent for translation
  const t3 = await translatePhrases(job.id, timeline.phrases, "en", llm);
  assert.equal(calls.length, 2);
  assert.ok(!/Thank you/.test(calls[1]));
  assert.ok(!t3.has(timeline.phrases.find((p) => p.lang === "en")!.phrase));
});
