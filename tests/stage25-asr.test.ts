import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Stage 25, offline: the ASR post-correction keeps every timing, the whisper prompt, per-phrase language, caption hygiene. */
const { applyFixes, fixTranscript, whisperPrompt, termsFrom, detectLanguage, tidyTranscript, asrFixEnabled } = await import("../src/understand/asrfix.ts");
const { transcribe } = await import("../src/understand/whisper.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
type Transcript = import("../src/schemas/index.ts").Transcript;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-asr25-"));

/** a phrase from words with 0.4 s slots */
function phrase(start: number, words: string[], lang = "ru") {
  const ws = words.map((w, k) => ({ w, start: Math.round((start + k * 0.4) * 1000) / 1000, end: Math.round((start + k * 0.4 + 0.35) * 1000) / 1000 }));
  return { start: ws[0].start, end: ws.at(-1)!.end, text: words.join(" "), words: ws, lang };
}
const T: Transcript = {
  language: "ru",
  segments: [
    phrase(0, ["Вышла", "статья", "о", "переходе", "от", "Грок", "0", "к", "Грок", "1."]),
    phrase(5, ["Просто", "Грок,", "Грок,", "Грок?"]),
    phrase(8, ["по", "сравнению", "с", "GPT-3", "и", "5?"]),
    phrase(11, ["есть", "нейросеть", "LAMA,", "и", "она", "на", "опен", "сорсе."]),
  ],
};
const times = (t: Transcript) => t.segments.flatMap((s) => s.words.flatMap((w) => [w.start, w.end]));

test("applyFixes: words replaced in place, every boundary kept (1:1, merge, more words on the last token)", () => {
  const { transcript: out, applied } = applyFixes(T, [
    { p: 0, wrong: "Грок 0 к Грок 1", right: "Grok-0 к Grok-1" }, // same count → 1:1
    { p: 1, wrong: "Грок, Грок, Грок?", right: "Grok Grok Grok" }, // the commas and the question mark stay
    { p: 2, wrong: "GPT-3 и 5", right: "GPT-3.5" }, // fewer → merged, span = union
    { p: 3, wrong: "LAMA", right: "Llama" },
    { p: 3, wrong: "опен сорсе", right: "опенсорсе" },
    { p: 3, wrong: "нет такого", right: "x" }, // not in the phrase → ignored
    { p: 9, wrong: "a", right: "b" }, // no such phrase → ignored
  ]);
  assert.equal(applied.length, 5);
  assert.equal(out.segments[0].text, "Вышла статья о переходе от Grok-0 к Grok-1.");
  assert.equal(out.segments[1].text, "Просто Grok, Grok, Grok?");
  assert.equal(out.segments[2].text, "по сравнению с GPT-3.5?");
  assert.equal(out.segments[3].text, "есть нейросеть Llama, и она на опенсорсе.");
  // the merged word spans exactly the words it replaced
  const merged = out.segments[2].words.at(-1)!;
  assert.deepEqual([merged.start, merged.end], [T.segments[2].words[3].start, T.segments[2].words[5].end]);
  // no new boundary anywhere: every start/end of the result was a start/end before
  const before = new Set(times(T));
  for (const x of times(out)) assert.ok(before.has(x), `boundary ${x} is new`);
  // phrases keep their start/end and count
  assert.deepEqual(out.segments.map((s) => [s.start, s.end]), T.segments.map((s) => [s.start, s.end]));
  // more right words than wrong ones ride on the last token (no split, no invented boundary)
  const more = applyFixes(T, [{ p: 3, wrong: "LAMA,", right: "Meta Llama" }]).transcript;
  assert.equal(more.segments[3].words[2].w, "Meta Llama,");
  assert.equal(more.segments[3].words.length, T.segments[3].words.length);
  // the input is not mutated
  assert.equal(T.segments[0].words[5].w, "Грок");
});

test("fixTranscript: one structured request with the hint and numbered phrases, cached by content", async () => {
  const requests: { system: string; text: string }[] = [];
  const client = {
    generate: async (_models: string[], body: { system: string; parts: { text: string }[] }) => {
      requests.push({ system: body.system, text: body.parts[0].text });
      return { data: { fixes: [{ p: 3, wrong: "LAMA", right: "Llama" }, { p: 0, wrong: "Грок", right: "Grok" }] }, text: "", model: "gemini-3.5-flash-lite", usage: { promptTokenCount: 1000, candidatesTokenCount: 50 }, requests: 1 };
    },
  } as unknown as import("../src/understand/gemini-client.ts").GeminiClient;
  const cacheDir = path.join(tmp, "cache");
  const r = await fixTranscript(T, { hint: "Интервью Илона Маска про Grok", client, cacheDir });
  assert.equal(requests.length, 1);
  assert.match(requests[0].text, /HINT[^\n]*Grok/);
  assert.match(requests[0].text, /p3 \[ru\]: есть нейросеть LAMA, и она на опен сорсе\./);
  assert.match(requests[0].system, /Never rephrase/);
  assert.equal(r.changes.length, 2);
  assert.equal(r.transcript.segments[3].words[2].w, "Llama,");
  assert.equal(r.transcript.segments[0].words[5].w, "Grok", "the first match in the phrase");
  assert.ok(r.usd > 0 && r.usd < 0.01);
  const again = await fixTranscript(T, { hint: "Интервью Илона Маска про Grok", client, cacheDir });
  assert.equal(requests.length, 1, "second time from the cache");
  assert.equal(again.cached, true);
  assert.deepEqual(again.transcript, r.transcript);
  assert.equal(asrFixEnabled({ VEDIT_ASR_FIX: "off", GEMINI_API_KEY: "k" }), false);
  assert.equal(asrFixEnabled({ GEMINI_API_KEY: "k" }), true);
  assert.equal(asrFixEnabled({}), false, "no key: no pass");
});

test("whisper prompt: only the hint's names and terms, short; passed to whisper-cli as --prompt", async () => {
  assert.deepEqual(termsFrom("Интервью с Илоном Маском про xAI, Grok и GPT-3.5"), ["xAI", "Grok", "GPT-3.5", "Илоном", "Маском"]);
  assert.equal(whisperPrompt("10 рилсов по 30 секунд, самые сильные мысли"), "", "no names → no prompt (a prompt can make whisper skip speech)");
  const p = whisperPrompt("Интервью с Илоном Маском про xAI, Grok и GPT-3.5");
  assert.equal(p, "Илоном, Маском, GPT-3.5, Grok, xAI.");
  assert.ok(p.length <= 200);
  // the CLI runner gets it
  const wav = path.join(tmp, "tone.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=f=300:d=3", "-ac", "1", "-ar", "16000", wav]);
  const seen: (string | undefined)[] = [];
  const runCli = async (_wav: string, outBase: string, o: { prompt?: string }) => {
    seen.push(o.prompt);
    await fs.writeFile(`${outBase}.json`, JSON.stringify({ result: { language: "ru" }, transcription: [{ offsets: { from: 0, to: 1000 }, text: " Привет.", tokens: [{ text: " Привет.", offsets: { from: 0, to: 900 }, p: 0.9, t_dtw: -1 }] }] }));
  };
  const prev = process.env.VEDIT_WHISPER_PROMPT;
  delete process.env.VEDIT_WHISPER_PROMPT;
  try {
    await transcribe(wav, 3, path.join(tmp, "w1"), { runCli: runCli as never, prompt: "Интервью про Grok и xAI", fasterFallback: null });
    await transcribe(wav, 3, path.join(tmp, "w2"), { runCli: runCli as never, fasterFallback: null });
  } finally {
    if (prev !== undefined) process.env.VEDIT_WHISPER_PROMPT = prev;
  }
  assert.match(seen[0] ?? "", /Grok/);
  assert.equal(seen[1], undefined, "no hint, no prompt");
});

test("per-phrase language and caption hygiene", () => {
  assert.equal(detectLanguage("Это беседа с Илоном Маском.", "ru"), "ru");
  assert.equal(detectLanguage("This is a great question, and the answer is simple", "ru"), "en");
  assert.equal(detectLanguage("Bu juda yaxshi g'oya va biz uni qilamiz", "ru"), "uz");
  assert.equal(detectLanguage("Бу жуда яхши ғоя", "ru"), "uz");
  assert.equal(detectLanguage("OK", "ru"), "ru", "too little text: the chunk's language");
  const t = tidyTranscript({ language: "ru", segments: [phrase(0, ["привет,,", "мир"]), phrase(2, ["«ну", "да»"])] });
  assert.equal(t.segments[0].text, "Привет, мир");
  assert.equal(t.segments[1].text, "«Ну да»");
  assert.deepEqual(times(t), times({ language: "ru", segments: [phrase(0, ["a", "b"]), phrase(2, ["c", "d"])] }));
});
