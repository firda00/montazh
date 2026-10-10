import { test } from "node:test";
import assert from "node:assert/strict";
import { atempoChain, cropScaleFilter, expectedDuration, sanitizeClips } from "../src/cut/index.ts";
import { EdlSchema, type Media } from "../src/schemas/index.ts";

const media = { duration: 60, fps: 30, normalized_path: "n.mp4" } as Media;

test("atempo chains stay within 0.5..2", () => {
  assert.deepEqual(atempoChain(1), []);
  assert.deepEqual(atempoChain(2), ["atempo=2.000000"]);
  assert.deepEqual(atempoChain(4), ["atempo=2", "atempo=2.000000"]);
  assert.deepEqual(atempoChain(0.25), ["atempo=0.5", "atempo=0.500000"]);
});

test("crop filter targets delivery size", () => {
  assert.match(cropScaleFilter("9:16"), /scale=1080:1920/);
  assert.match(cropScaleFilter("16:9"), /scale=1920:1080/);
});

test("clips past the end are clamped or skipped with warnings", () => {
  const { clips, warnings } = sanitizeClips(
    [
      { src_start: 55, src_end: 70, speed: 1, crop: "center" },
      { src_start: 61, src_end: 65, speed: 1, crop: "center" },
    ],
    media,
  );
  assert.equal(clips.length, 1);
  assert.equal(clips[0].src_end, 60);
  assert.equal(warnings.length, 2);
});

test("expected duration accounts for speed", () => {
  assert.equal(
    expectedDuration([
      { src_start: 0, src_end: 4, speed: 2, crop: "center" },
      { src_start: 10, src_end: 11, speed: 0.5, crop: "center" },
    ]),
    4,
  );
});

test("EDL schema fills defaults and rejects bad plans", () => {
  const ok = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 1, src_end: 2 }] }] });
  assert.equal(ok.outputs[0].clips[0].speed, 1);
  assert.equal(ok.outputs[0].captions.enabled, false);

  assert.equal(EdlSchema.safeParse({ outputs: [] }).success, false);
  const dup = { id: "a", aspect: "1:1", clips: [{ src_start: 0, src_end: 1 }] };
  assert.equal(EdlSchema.safeParse({ outputs: [dup, dup] }).success, false);
  assert.equal(
    EdlSchema.safeParse({ outputs: [{ id: "a", aspect: "1:1", clips: [{ src_start: 3, src_end: 1 }] }] }).success,
    false,
  );
});
