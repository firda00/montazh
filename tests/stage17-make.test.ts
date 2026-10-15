// make motion + music choices: odometer digits, energetic mood under a narrator, TTS cost estimate. Pure functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { odoDigits, odoHtml } from "../src/make/scenes.ts";
import { energeticMood } from "../src/make/index.ts";
import { ttsUsd } from "../src/voice/voiceover.ts";

test("odometer markup: one 0-9-0-9 strip per digit, other characters static, long numbers stay text", () => {
  const h = odoHtml("$7 500", "sc0-num");
  assert.equal((h.match(/class="ods"/g) ?? []).length, 4);
  assert.match(h, /^<span class="odc">\$<\/span><span class="od"><span class="ods" id="sc0-num-od1">/);
  assert.match(h, /<span class="odc">&nbsp;<\/span>/);
  assert.equal((h.match(/class="odd"/g) ?? []).length, 80, "20 cells per strip");
  assert.ok(odoDigits("350–400"));
  assert.ok(!odoDigits("EUDR"));
  assert.ok(!odoDigits("1234567890123"));
  assert.equal(odoHtml("1234567890123", "x"), "1234567890123");
  assert.equal(odoHtml("<b>", "x"), "&lt;b&gt;");
});

test("music under a narrator: 'dramatic' becomes 'upbeat' unless the topic asks for drama", () => {
  assert.equal(energeticMood("dramatic", "почему кофе дорожает в 2026"), "upbeat");
  assert.equal(energeticMood("dramatic", "трагедия Титаника"), "dramatic");
  assert.equal(energeticMood("tech", "почему кофе дорожает"), "tech");
});

test("TTS cost estimate: Gemini API, Cloud Gemini-TTS, Chirp 3 HD", () => {
  assert.equal(ttsUsd("gemini", "gemini-3.8-flash-tts", 60, 900), 0.0173);
  assert.equal(ttsUsd("cloud", "gemini-2.5-flash-tts", 60, 900), 0.015);
  assert.equal(ttsUsd("cloud", "chirp3-hd", 60, 1000), 0.03);
});
