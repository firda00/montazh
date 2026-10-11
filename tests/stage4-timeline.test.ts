import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDesignTimeline, paginate } from "../src/design/timeline.ts";
import { EdlSchema } from "../src/schemas/index.ts";
import { MEDIA, makeTranscript } from "./helpers/plan-fixture.ts";

const transcript = makeTranscript();
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-6, msg ?? `${a} ≈ ${b}`);

test("words are mapped through clips onto the output timeline", () => {
  const edl = EdlSchema.parse({
    outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08, speed: 2 }], titles: [{ at: 0, text: "Hi" }, { at: 99, text: "late" }] }],
    reasoning: "",
  });
  const t = buildDesignTimeline(edl.outputs[0], transcript, MEDIA);
  assert.equal(t.width, 1080);
  assert.equal(t.height, 1920);
  near(t.duration, 4.7, "clip 2 is 71.85 frames → rounded up to 72 like the cut does");
  assert.deepEqual(t.clips.map((c) => [c.out_start, c.out_end]), [[0, 2.3], [2.3, 4.7]]);
  // first phrase lands at 0, second phrase (p2) starts at the clip boundary, compressed 2x
  assert.equal(t.phrases[0].phrase, 0);
  assert.equal(t.phrases[0].start, 0);
  assert.equal(t.phrases[1].phrase, 2);
  assert.equal(t.phrases[1].start, 2.3);
  assert.equal(t.phrases[1].words[0].w, "Каждое");
  near(t.phrases[1].words[0].end, 2.3 + (8.74 - 8.29) / 2);
  // phrases from source ranges outside the clips never appear
  assert.ok(!t.phrases.some((p) => p.phrase === 1));
  // titles: default duration, late title clamped near the end
  assert.deepEqual(t.titles.map((x) => [x.at, x.duration]), [[0, 2.5], [4.2, 0.5]]);
});

test("a word is dropped when its midpoint is outside the clip; phrases split at cuts", () => {
  const edl = EdlSchema.parse({ outputs: [{ id: "a", aspect: "16:9", clips: [{ src_start: 9.0, src_end: 13.08 }, { src_start: 3.2, src_end: 5.75 }] }], reasoning: "" });
  const t = buildDesignTimeline(edl.outputs[0], transcript, MEDIA);
  assert.ok(!t.phrases[0].words.some((w) => w.w === "Каждое"), "«Каждое» (8.29–8.74) is before the clip");
  assert.equal(t.phrases[0].clip, 0);
  assert.equal(t.phrases[1].phrase, 1, "the second clip brings phrase p1 after p2 on the output timeline");
  assert.ok(t.phrases[1].start >= t.phrases[0].end);
});

test("paginate splits long phrases into short caption pages", () => {
  const t = buildDesignTimeline(EdlSchema.parse({ outputs: [{ id: "a", aspect: "1:1", clips: [{ src_start: 8.29, src_end: 13.08 }] }], reasoning: "" }).outputs[0], transcript, MEDIA);
  const pages = paginate(t.phrases[0], 3, 30);
  assert.ok(pages.length >= 3);
  assert.ok(pages.every((p) => p.length <= 3));
  assert.equal(pages.flat().length, t.phrases[0].words.length, "no word lost");
});
