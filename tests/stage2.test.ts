import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dtwPresetFor,
  isHallucination,
  parseSilenceLog,
  parseWhisperJson,
  planSpeechChunks,
  splitPhrases,
  wordsFromSegment,
  type WhisperSegment,
} from "../src/understand/whisper.ts";
import { parseSceneLog, shotsFromCuts } from "../src/understand/shots.ts";
import { parseLoudnessLog, meanLoudness } from "../src/understand/loudness.ts";
import { makeChunks } from "../src/understand/index.ts";
import { checkClipBoundaries, snapClipsToWords } from "../src/plan/validate.ts";
import type { Transcript } from "../src/schemas/index.ts";

const tok = (text: string, from: number, to: number, dtw = -1) => ({ text, offsets: { from, to }, p: 0.9, t_dtw: dtw });

// "Привет, мир. Пока" — two phrases, punctuation attached, timestamp tokens ignored
const seg: WhisperSegment = {
  offsets: { from: 0, to: 3000 },
  text: " Привет, мир. Пока",
  tokens: [
    tok("[_BEG_]", 0, 0, -1),
    tok(" При", 100, 300, 30),
    tok("вет", 300, 600, 60),
    tok(",", 600, 600, 60),
    tok(" мир", 700, 1100, 110),
    tok(".", 1100, 1100, 110),
    tok(" По", 1500, 1700, 170),
    tok("ка", 1700, 2000, 200),
    tok("[_TT_200]", 2000, 2000, -1),
  ],
};

test("tokens → words with heuristic timestamps", () => {
  const words = wordsFromSegment(seg, "tokens");
  assert.deepEqual(
    words.map((w) => [w.w, w.start, w.end]),
    [
      ["Привет,", 0.1, 0.6],
      ["мир.", 0.7, 1.1],
      ["Пока", 1.5, 2.0],
    ],
  );
});

test("DTW timestamps: word spans previous boundary → last token", () => {
  const words = wordsFromSegment(seg, "dtw");
  assert.deepEqual(
    words.map((w) => [w.w, w.start, w.end]),
    [
      ["Привет,", 0, 0.6],
      ["мир.", 0.6, 1.1],
      ["Пока", 1.1, 2.0],
    ],
  );
});

test("silences bound DTW words: no start inside a pause, no stretch across one", () => {
  // pause 1.15–1.45 s sits between "мир." and "Пока"; "Пока" would otherwise start at 1.1
  const words = wordsFromSegment(seg, "dtw", 0, [{ start: 1.15, end: 1.45 }]);
  assert.deepEqual(
    words.map((w) => [w.w, w.start, w.end]),
    [
      ["Привет,", 0, 0.6],
      ["мир.", 0.6, 1.1],
      ["Пока", 1.45, 2.0],
    ],
  );
  // a pause inside a word's DTW span caps its end
  const capped = wordsFromSegment(seg, "dtw", 0, [{ start: 0.4, end: 0.7 }]);
  assert.deepEqual([capped[0].start, capped[0].end], [0, 0.4]);
  assert.deepEqual([capped[1].start, capped[1].end], [0.7, 1.1]);
});

test("DTW falls back to tokens when t_dtw is missing", () => {
  const noDtw = { ...seg, tokens: seg.tokens.map((t) => ({ ...t, t_dtw: -1 })) };
  assert.deepEqual(wordsFromSegment(noDtw, "dtw"), wordsFromSegment(noDtw, "tokens"));
});

test("phrases split at sentence punctuation", () => {
  const t = parseWhisperJson({ result: { language: "ru" }, transcription: [seg] }, "tokens");
  assert.equal(t.language, "ru");
  assert.deepEqual(
    t.segments.map((s) => s.text),
    ["Привет, мир.", "Пока"],
  );
  assert.equal(t.segments[0].start, 0.1);
  assert.equal(t.segments[0].end, 1.1);
  assert.deepEqual(splitPhrases([]), []);
});

test("chunk offset shifts words and known hallucinations are dropped", () => {
  const words = wordsFromSegment(seg, "tokens", 10_000);
  assert.deepEqual([words[0].start, words[0].end], [10.1, 10.6]);
  const raw = {
    result: { language: "ru" },
    transcription: [seg, { ...seg, text: " Редактор субтитров А.Семкин Корректор А.Егорова" }],
  };
  const t = parseWhisperJson(raw, "tokens", 10);
  assert.equal(t.segments.length, 2);
  assert.equal(t.segments[0].lang, "ru");
  assert.equal(t.segments[0].start, 10.1);
  assert.ok(isHallucination("Субтитры сделал DimaTorzok"));
  assert.ok(!isHallucination("Thank you for watching."));
});

test("silence log → speech chunks packed under the window size", () => {
  const log = "[silencedetect] silence_start: 5.3\n[silencedetect] silence_end: 8.2 | silence_duration: 2.9\nsilence_start: 16.4\nsilence_end: 19.5\nsilence_start: 32\n";
  const silences = parseSilenceLog(log, 35);
  assert.deepEqual(silences, [
    { start: 5.3, end: 8.2 },
    { start: 16.4, end: 19.5 },
    { start: 32, end: 35 },
  ]);
  // runs: 0–5.3, 8.2–16.4, 19.5–32 → first two fit in 28 s, third starts a new chunk
  const chunks = planSpeechChunks(silences, 35, { target: 28, pad: 0.3 });
  assert.deepEqual(chunks, [
    { start: 0, end: 16.7 },
    { start: 19.2, end: 32.3 },
  ]);
  // neighbours closer than 2×pad meet in the middle
  const tight = planSpeechChunks([{ start: 10, end: 10.4 }], 20, { target: 9, pad: 0.3 });
  assert.deepEqual(tight, [
    { start: 0, end: 10.2 },
    { start: 10.2, end: 20 },
  ]);
  assert.deepEqual(planSpeechChunks([{ start: 0, end: 20 }], 20), []);
  // speech longer than the target is never cut
  assert.deepEqual(planSpeechChunks([], 100, { target: 28 }), [{ start: 0, end: 100 }]);
});

test("DTW preset inferred from model name", () => {
  assert.equal(dtwPresetFor("ggml-large-v3-turbo-q5_0.bin"), "large.v3.turbo");
  assert.equal(dtwPresetFor("ggml-small.en.bin"), "small.en");
  assert.equal(dtwPresetFor("ggml-medium-q8_0.bin"), "medium");
  assert.equal(dtwPresetFor("custom.bin"), null);
});

test("scene log → cuts → shots, flashes merged", () => {
  const log = `frame:0 pts:1 pts_time:11.6\nlavfi.scene_score=0.95\nfoo\nframe:1 pts:2 pts_time:11.8\nlavfi.scene_score=0.4\nframe:2 pts:3 pts_time:23.1\nlavfi.scene_score=0.8\n`;
  const cuts = parseSceneLog(log);
  assert.deepEqual(cuts.map((c) => c.t), [11.6, 11.8, 23.1]);
  const shots = shotsFromCuts(cuts, 35);
  assert.deepEqual(
    shots.map((s) => [s.start, s.end]),
    [
      [0, 11.6],
      [11.6, 23.1],
      [23.1, 35],
    ],
  );
  assert.equal(shots[1].cut_score, 0.95);
  assert.deepEqual(shotsFromCuts([], 10).map((s) => [s.start, s.end]), [[0, 10]]);
  // a 0.2 s tail is folded into the previous shot
  assert.deepEqual(shotsFromCuts([{ t: 9.8, score: 1 }], 10).map((s) => [s.start, s.end]), [[0, 10]]);
});

test("loudness log parsed, -inf clamped", () => {
  const log = `frame:0 pts:0 pts_time:0\nlavfi.r128.M=-inf\nframe:1 pts:4800 pts_time:0.1\nlavfi.r128.M=-23.5\nframe:2 pts:9600 pts_time:0.2\nlavfi.r128.M=-20.5\n`;
  const pts = parseLoudnessLog(log);
  assert.deepEqual(pts, [
    { t: 0, lufs: -70 },
    { t: 0.1, lufs: -23.5 },
    { t: 0.2, lufs: -20.5 },
  ]);
  assert.equal(meanLoudness(pts, 0.05, 0.25), -22);
  assert.equal(meanLoudness(pts, 5, 6), null);
});

test("chunks follow shot boundaries and cap very long shots", () => {
  const shots = [
    { index: 0, start: 0, end: 100, cut_score: 0 },
    { index: 1, start: 100, end: 190, cut_score: 1 },
    { index: 2, start: 190, end: 250, cut_score: 1 },
    { index: 3, start: 250, end: 900, cut_score: 1 },
  ];
  assert.deepEqual(makeChunks(shots, 180, 300), [
    { start: 0, end: 190 },
    { start: 190, end: 490 },
    { start: 490, end: 790 },
    { start: 790, end: 900 },
  ]);
});

const transcript: Transcript = {
  language: "ru",
  segments: [
    {
      start: 1,
      end: 3,
      text: "Добро пожаловать",
      words: [
        { w: "Добро", start: 1, end: 1.5 },
        { w: "пожаловать", start: 1.6, end: 3 },
      ],
    },
  ],
};

test("clip edges inside a word are reported and snapped outward", () => {
  const clips = [{ src_start: 1.2, src_end: 2.0, speed: 1, crop: "center" as const }];
  const issues = checkClipBoundaries(clips, transcript);
  assert.deepEqual(issues.map((i) => [i.edge, i.word.w, i.suggested]), [
    ["start", "Добро", 1],
    ["end", "пожаловать", 3],
  ]);
  const snapped = snapClipsToWords(clips, transcript, 0.4);
  assert.equal(snapped.clips[0].src_start, 1);
  assert.equal(snapped.clips[0].src_end, 2.0); // 1 s shift exceeds maxShift → left alone
  assert.equal(snapped.notes.length, 2);
  assert.match(snapped.notes[1], /not snapped/);
  // edges in silence or exactly on boundaries are fine
  assert.deepEqual(checkClipBoundaries([{ src_start: 0.5, src_end: 1.5, speed: 1, crop: "center" }], transcript), []);
});
