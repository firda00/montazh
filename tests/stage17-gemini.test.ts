// Gemini TTS engine (src/voice/gemini.ts) with a stubbed fetch: PCM/WAV decoding, both request shapes,
// 429 backoff, model fallback, cache, the missing-key fallback to Piper, catalogue entries, make voiceover timings.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-gemini-ws-"));
delete process.env.GEMINI_API_KEY;
delete process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_CLOUD_API_KEY;
delete process.env.VEDIT_GEMINI_TTS_MODEL;
delete process.env.VEDIT_CLOUD_TTS_MODEL;
delete process.env.VEDIT_GEMINI_TTS_API;

const { audioToPcm, audioFromResponse, requestFor, retryDelaySeconds, geminiTts, geminiTtsModels, geminiApiKey, GEMINI_TTS_MODELS, GEMINI_KEY_HELP, ttsCacheKey, resetGeminiState, NARRATOR_STYLE } = await import("../src/voice/gemini.ts");
const { cloudTts, cloudRequest, cloudApiKey, cloudGeminiModels, bcp47, chirpName, CLOUD_KEY_HELP, CLOUD_TTS_URL, resetCloudState } = await import("../src/voice/cloudtts.ts");
const { VOICES, getVoice, autoVoice, piperVoiceFor, sampleVoiceFor, isLocal, formatVoices } = await import("../src/voice/catalog.ts");
const { synthesize, wavBytes, splitLineTimes, cloudBackend, TTS_KEYS_HELP } = await import("../src/voice/piper.ts");
const { resolveMakeVoice, makeVoiceover, geminiStyle } = await import("../src/voice/voiceover.ts");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-gemini-"));

/** n samples of a 220 Hz tone at 24 kHz (non-silent, so trimSilence keeps it) */
function tone(seconds: number, rate = 24000): Int16Array {
  const n = Math.round(seconds * rate);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate));
  return a;
}
const pcmBytes = (a: Int16Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);

interface Call {
  url: string;
  body: Record<string, unknown>;
  key: string | null;
}
/** A fetch stub: `respond` gets each call and returns [status, json]. */
function stubFetch(respond: (c: Call, n: number) => [number, unknown] | Promise<[number, unknown]>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = { url: String(url), body: JSON.parse(String(init?.body ?? "{}")), key: new Headers(init?.headers).get("x-goog-api-key") };
    calls.push(c);
    const [status, json] = await respond(c, calls.length);
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}
/** an interactions-API answer with base64 WAV of `seconds` of audio */
const interactionsAudio = (seconds: number) => ({ steps: [{ type: "user_input" }, { type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wavBytes(tone(seconds), 24000).toString("base64") }] }] });
/** the text length of a request (either shape), to make longer lines longer audio */
const textOf = (c: Call) => {
  const b = c.body as { input?: { content: { text: string }[] }[]; contents?: { parts: { text: string }[] }[] };
  return b.input?.[0].content[0].text ?? b.contents?.[0].parts[0].text ?? "";
};
const noSleep = async () => {};
/** a Cloud TTS answer: LINEAR16 with a WAV header */
const cloudAudio = (seconds: number) => ({ audioContent: wavBytes(tone(seconds), 24000).toString("base64") });
const cloudText = (c: Call) => (c.body as { input: { text: string } }).input.text;
/** body checks below read the interactions shape */
const interactionsFirst = () => {
  resetGeminiState();
  process.env.VEDIT_GEMINI_TTS_API = "interactions";
};

test("audio decoding: WAV container and raw L16 (rate from the mime), stereo downmix", () => {
  const a = tone(0.5);
  const wav = audioToPcm(wavBytes(a, 24000));
  assert.equal(wav.rate, 24000);
  assert.equal(wav.pcm.length, a.length);
  assert.equal(wav.pcm[100], a[100]);
  const raw = audioToPcm(pcmBytes(a), "audio/L16;codec=pcm;rate=24000");
  assert.equal(raw.rate, 24000);
  assert.deepEqual(Array.from(raw.pcm.slice(0, 50)), Array.from(a.slice(0, 50)));
  assert.equal(audioToPcm(pcmBytes(a), "audio/L16;rate=16000").rate, 16000);
  // a stereo WAV is averaged to mono
  const st = new Int16Array([100, 300, -200, -400]);
  const h = wavBytes(st, 24000);
  h.writeUInt16LE(2, 22); // channels
  const m = audioToPcm(h);
  assert.deepEqual(Array.from(m.pcm), [200, -300]);
});

test("request shapes: interactions (current docs) and generateContent (legacy) carry the voice and the style", () => {
  const i = requestFor("interactions", "gemini-3.8-flash-tts", "Привет", "Kore", "calm narrator");
  assert.match(i.url, /\/v1beta\/interactions$/);
  const ib = i.body as { model: string; input: { type: string; content: { text: string; annotations: { type: string; style: string }[] }[] }[]; response_format: { type: string }; generation_config: { speech_config: { voice: string }[] } };
  assert.equal(ib.model, "gemini-3.8-flash-tts");
  assert.equal(ib.input[0].type, "user_input");
  assert.equal(ib.input[0].content[0].text, "Привет");
  assert.deepEqual(ib.input[0].content[0].annotations, [{ type: "speech_metadata", style: "calm narrator" }]);
  assert.equal(ib.response_format.type, "audio");
  assert.deepEqual(ib.generation_config.speech_config, [{ voice: "Kore" }]);
  const g = requestFor("generateContent", "gemini-2.5-flash-preview-tts", "Привет", "Charon", "calm narrator");
  assert.match(g.url, /models\/gemini-2\.5-flash-preview-tts:generateContent$/);
  const gb = g.body as { contents: { parts: { text: string }[] }[]; generationConfig: { responseModalities: string[]; speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: string } } } } };
  assert.deepEqual(gb.generationConfig.responseModalities, ["AUDIO"]);
  assert.equal(gb.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, "Charon");
  assert.match(gb.contents[0].parts[0].text, /^Say in the voice of calm narrator:\nПривет$/);
  // newer models would read the prefix aloud: bare text
  assert.equal((requestFor("generateContent", "gemini-3.8-flash-tts", "Привет", "Charon", "calm").body as typeof gb).contents[0].parts[0].text, "Привет");
  // response parsing, both shapes
  assert.equal(audioFromResponse(interactionsAudio(0.1))?.mime, "audio/wav");
  const legacy = { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: "AAAA" } }] } }] };
  assert.deepEqual(audioFromResponse(legacy), { data: "AAAA", mime: "audio/L16;codec=pcm;rate=24000" });
  assert.equal(audioFromResponse({ steps: [{ type: "model_output", content: [{ type: "text", text: "no" }] }] }), null);
});

test("models: env override first, then the defaults; key from GEMINI_API_KEY or GOOGLE_API_KEY", () => {
  assert.deepEqual(geminiTtsModels({}), [...GEMINI_TTS_MODELS]);
  assert.equal(GEMINI_TTS_MODELS[0], "gemini-3.8-flash-tts");
  const m = geminiTtsModels({ VEDIT_GEMINI_TTS_MODEL: "my-tts, gemini-2.5-flash-preview-tts" });
  assert.deepEqual(m.slice(0, 2), ["my-tts", "gemini-2.5-flash-preview-tts"]);
  assert.equal(new Set(m).size, m.length);
  assert.equal(geminiApiKey({ GOOGLE_API_KEY: " g " }), "g");
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "a", GOOGLE_API_KEY: "g" }), "a");
  assert.equal(geminiApiKey({ GEMINI_API_KEY: "" }), undefined);
  assert.equal(retryDelaySeconds({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } }), 7);
  assert.equal(retryDelaySeconds({}, "3"), 3);
  assert.equal(retryDelaySeconds({}, null), null);
});

test("429: waits (RetryInfo) and retries; 404 model → next model; answers are cached", async () => {
  resetGeminiState();
  delete process.env.VEDIT_GEMINI_TTS_API;
  const waits: number[] = [];
  const f = stubFetch((c, n) => {
    if (c.body.model === "gemini-3.8-flash-tts" || /3\.8-flash-tts:/.test(c.url)) return [404, { error: { code: 404, message: "models/gemini-3.8-flash-tts is not found" } }];
    if (n <= 4) return [429, { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (requests per minute)", details: [{ retryDelay: "2s" }] } }];
    return [200, interactionsAudio(0.8)];
  });
  const cacheDir = path.join(tmp, "cache1");
  const r = await geminiTts("Кофе дорожает.", "Kore", { key: "k", fetch: f.fn, cacheDir, sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.model, "gemini-3.1-flash-tts-preview");
  assert.equal(r.api, "interactions", "interactions is the first shape (its style is not read aloud)");
  assert.equal(r.rate, 24000);
  assert.ok(Math.abs(r.pcm.length / r.rate - 0.8) < 0.01);
  assert.deepEqual(waits, [2000, 2000]);
  assert.ok(f.calls.every((c) => c.key === "k"), "the key goes in the x-goog-api-key header, never in the URL");
  assert.ok(f.calls.every((c) => !/key=/.test(c.url)));
  const n = f.calls.length;
  const again = await geminiTts("Кофе дорожает.", "Kore", { key: "k", fetch: f.fn, cacheDir, sleep: noSleep });
  assert.equal(again.cached, true);
  assert.equal(f.calls.length, n, "second identical request comes from the cache");
  await fs.access(path.join(cacheDir, `${ttsCacheKey("Кофе дорожает.", "Kore", NARRATOR_STYLE, "gemini-3.1-flash-tts-preview")}.wav`));
  // a different voice or style is a different cache entry
  await geminiTts("Кофе дорожает.", "Puck", { key: "k", fetch: f.fn, cacheDir, sleep: noSleep });
  assert.equal(f.calls.length, n + 1);
});

test("interactions shape refused (400) → generateContent shape with raw PCM; daily quota skips to the next model; bad key is fatal", async () => {
  interactionsFirst();
  const f = stubFetch((c) => {
    if (/interactions$/.test(c.url)) return [400, { error: { code: 400, message: "Invalid JSON payload received. Unknown name \"response_format\"" } }];
    return [200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: pcmBytes(tone(0.5)).toString("base64") } }] } }] }];
  });
  const r = await geminiTts("Тест", "Charon", { key: "k", models: ["gemini-2.5-flash-preview-tts"], fetch: f.fn, cacheDir: null, sleep: noSleep });
  assert.equal(r.api, "generateContent");
  assert.ok(Math.abs(r.pcm.length / 24000 - 0.5) < 0.01);

  const waits: number[] = [];
  const q = stubFetch((c) => (c.body.model === "a" ? [429, { error: { code: 429, message: "Quota exceeded for metric: generate_requests_per_model_per_day" } }] : [200, interactionsAudio(0.3)]));
  const r2 = await geminiTts("Тест", "Charon", { key: "k", models: ["a", "b"], fetch: q.fn, cacheDir: null, sleep: async (ms) => void waits.push(ms) });
  assert.equal(r2.model, "b");
  assert.deepEqual(waits, [], "a daily quota is not waited out");

  const bad = stubFetch(() => [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }]);
  await assert.rejects(geminiTts("Тест", "Charon", { key: "bad", fetch: bad.fn, cacheDir: null, sleep: noSleep }), (e: Error & { fatal?: boolean }) => e.fatal === true && /aistudio\.google\.com/.test(e.message));
  assert.equal(bad.calls.length, 1);
  await assert.rejects(geminiTts("Тест", "Charon", { key: "", fetch: bad.fn, cacheDir: null }), /GEMINI_API_KEY/);
});

test("catalogue: 2 male + 2 female Russian Gemini voices with Piper fallbacks, auto voice, licence note", () => {
  const g = VOICES.filter((v) => v.engine === "gemini");
  assert.equal(g.filter((v) => v.gender === "male").length, 2);
  assert.equal(g.filter((v) => v.gender === "female").length, 2);
  assert.deepEqual(g.map((v) => v.gemini!.voiceName).sort(), ["Aoede", "Charon", "Kore", "Puck"]);
  for (const v of g) {
    assert.equal(v.language, "ru");
    assert.match(v.name, /[а-яё]/i);
    assert.match(v.license, /Gemini API.*коммерц.*платный/i);
    assert.equal(piperVoiceFor(v)?.engine, "piper", v.id);
    assert.ok(isLocal(v));
    assert.equal(sampleVoiceFor(v)?.id, v.id);
  }
  assert.equal(getVoice("charon")?.id, "gemini_charon");
  assert.equal(getVoice("Кора")?.id, "gemini_kore");
  assert.equal(autoVoice("ru", true).id, "gemini_charon");
  assert.equal(autoVoice("ru", false).id, "dmitri");
  assert.equal(autoVoice("en", false).id, "john");
  assert.equal(resolveMakeVoice("auto", "ru", false).voice.id, "dmitri");
  assert.equal(resolveMakeVoice("auto", "ru", true).voice.id, "gemini_charon");
  const r = resolveMakeVoice("gemini_kore", "uz");
  assert.equal(r.voice.id, "gemini_kore");
  assert.equal(r.warning, undefined, "Gemini voices speak the text's language");
  assert.match(formatVoices(), /gemini_kore\s+жен\s+ru\s+gemini\s+Gemini\/Cloud TTS/);
  assert.match(formatVoices(), /chirp_orus\s+муж\s+ru\s+chirp3\s+Cloud TTS/);
  assert.match(GEMINI_KEY_HELP, /aistudio\.google\.com[\s\S]*Get API key[\s\S]*GEMINI_API_KEY=.*\.env/);
  assert.match(geminiStyle(), /documentary narrator/);
  assert.match(geminiStyle(0.85), /faster/);
});

test("synthesize with a Gemini voice: one request per line, same style each time, exact line timings, 24 kHz WAV", async () => {
  interactionsFirst();
  const f = stubFetch((c) => [200, interactionsAudio(0.4 + textOf(c).length / 40)]);
  const out = path.join(tmp, "g.wav");
  const lines = ["Арабика стоит $7500 за тонну. Это рекорд.", "", "Робуста — до 5300 долларов!"];
  const r = await synthesize(lines, "gemini_charon", out, { gemini: { key: "k", fetch: f.fn, cacheDir: null, style: "S", sleep: noSleep } });
  assert.equal(r.engine, "gemini");
  assert.equal(r.voice, "gemini_charon");
  assert.equal(r.model, "gemini-3.8-flash-tts");
  assert.equal(r.sampleRate, 24000);
  assert.equal(f.calls.length, 2, "one request per non-empty line");
  for (const c of f.calls) {
    const b = c.body as { input: { content: { text: string; annotations: { style: string }[] }[] }[]; generation_config: { speech_config: { voice: string }[] } };
    assert.equal(b.input[0].content[0].annotations[0].style, "S");
    assert.equal(b.generation_config.speech_config[0].voice, "Charon");
  }
  // numbers go to Gemini as written (it reads them in the right case); markup would be stripped
  assert.match(textOf(f.calls[0]), /\$7500 за тонну\. Это рекорд\./);
  assert.equal(r.lines.length, 3);
  assert.equal(r.lines[1].start, 0);
  assert.equal(r.lines[1].end, 0);
  assert.ok(r.lines[2].start > r.lines[0].end + 0.3, "line pause between lines");
  assert.equal(r.sentences.filter((s) => s.line === 0).length, 2);
  const s0 = r.sentences.filter((s) => s.line === 0);
  assert.equal(s0[0].start, r.lines[0].start);
  assert.equal(s0[1].end, r.lines[0].end);
  assert.ok(s0[0].end <= s0[1].start + 1e-9);
  assert.equal(r.clips.length, 3);
  assert.equal(r.clips[1].pcm.length, 0);
  const wav = await fs.readFile(out);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.ok(Math.abs((wav.length - 44) / 2 / 24000 - r.duration) < 0.002);
  assert.deepEqual(splitLineTimes(["ab", "abcdef"], 0, 1).map((t) => t.end > t.start), [true, true]);
});

test("no key: a Gemini voice falls back to its Piper voice with the how-to-get-a-key warning", async () => {
  const seen: string[] = [];
  const stub = async (text: string, v: { id: string }) => (seen.push(v.id), { pcm: tone(0.3, 22050), rate: 22050 });
  const events: string[] = [];
  const r = await synthesize("Кофе дорожает.", "gemini_kore", path.join(tmp, "fb.wav"), { synth: stub, onEvent: (l) => events.push(l) });
  assert.equal(r.engine, "piper");
  assert.equal(r.voice, "dmitri");
  assert.deepEqual(seen, ["dmitri"]);
  assert.match(r.warnings[0], /gemini_kore[\s\S]*Piper dmitri[\s\S]*aistudio\.google\.com/);
  assert.ok(events.some((e) => /^⚠/.test(e)));
});

test("make voiceover with a Gemini voice: beats stretched to the speech, voice.json records engine and model", async () => {
  interactionsFirst();
  const f = stubFetch((c) => [200, interactionsAudio(1 + textOf(c).length / 30)]);
  const script = {
    version: 1,
    topic: "кофе",
    language: "ru",
    title: "Кофе",
    hook: "Арабика $7500",
    beats: [
      { text: "Арабика: $7500 за тонну", emphasis: "$7500", icon: "coffee", seconds: 3, voiceover: "Арабика подорожала до семи с половиной тысяч долларов за тонну." },
      { text: "Робуста: до $5300", emphasis: "$5300", icon: "trending-up", seconds: 3, voiceover: "Робуста тоже растёт." },
    ],
    hashtags: [],
    sources: [],
  };
  const dir = path.join(tmp, "vo");
  const vo = await makeVoiceover(script as never, "gemini_puck", dir, { gemini: { key: "k", fetch: f.fn, cacheDir: null, sleep: noSleep } });
  assert.equal(vo.engine, "gemini");
  assert.equal(vo.voice.id, "gemini_puck");
  assert.equal(vo.beats.length, 2);
  assert.ok(vo.script.beats[0].seconds > 3, "the beat grows to fit the longer speech");
  assert.ok(vo.beats[1].start >= vo.script.beats[0].seconds, "beat 2 speech starts in its own scene");
  assert.ok(vo.words.length >= 10);
  const meta = JSON.parse(await fs.readFile(path.join(dir, "voice.json"), "utf8"));
  assert.equal(meta.engine, "gemini");
  assert.equal(meta.model, "gemini-3.8-flash-tts");
  const style = (f.calls[0].body as { input: { content: { annotations: { style: string }[] }[] }[] }).input[0].content[0].annotations[0].style;
  assert.match(style, /narrator/);
});

test("generateContent answer as a full RIFF WAV in inlineData (mimeType audio/wav) decodes without the header", async () => {
  resetGeminiState();
  process.env.VEDIT_GEMINI_TTS_API = "generateContent";
  const f = stubFetch(() => [200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wavBytes(tone(0.5), 24000).toString("base64") } }] } }] }]);
  const r = await geminiTts("Тест", "Charon", { key: "k", fetch: f.fn, cacheDir: null, sleep: noSleep });
  assert.equal(r.model, "gemini-3.8-flash-tts");
  assert.equal(r.api, "generateContent");
  assert.equal(r.pcm.length, 12000);
  assert.match(f.calls[0].url, /gemini-3\.8-flash-tts:generateContent$/);
});

test("Cloud TTS: request shapes for Gemini-TTS and Chirp 3 HD, key in the header, WAV answer, model fallback", async () => {
  resetCloudState();
  assert.equal(bcp47("ru"), "ru-RU");
  assert.equal(bcp47("en"), "en-US");
  assert.equal(chirpName("ru-RU", "Orus"), "ru-RU-Chirp3-HD-Orus");
  assert.deepEqual(cloudGeminiModels({}).slice(0, 2), ["gemini-2.5-flash-tts", "gemini-2.5-pro-tts"]);
  assert.equal(cloudGeminiModels({ VEDIT_CLOUD_TTS_MODEL: "x" })[0], "x");
  assert.equal(cloudApiKey({ GOOGLE_CLOUD_API_KEY: " c " }), "c");
  const g = cloudRequest({ kind: "gemini", voiceName: "Charon", languageCode: "ru-RU" }, "Привет", { model: "gemini-2.5-flash-tts", prompt: "narrator" }) as { input: { text: string; prompt: string }; voice: { languageCode: string; name: string; modelName: string }; audioConfig: { audioEncoding: string; sampleRateHertz: number } };
  assert.deepEqual(g.input, { text: "Привет", prompt: "narrator" });
  assert.deepEqual(g.voice, { languageCode: "ru-RU", name: "Charon", modelName: "gemini-2.5-flash-tts" });
  assert.deepEqual(g.audioConfig, { audioEncoding: "LINEAR16", sampleRateHertz: 24000 });
  const c = cloudRequest({ kind: "chirp3", voiceName: "Orus", languageCode: "ru-RU" }, "Привет", { speakingRate: 1.05, prompt: "ignored" }) as { input: Record<string, string>; voice: { name: string }; audioConfig: { speakingRate?: number } };
  assert.deepEqual(c.input, { text: "Привет" }, "Chirp 3 HD takes no style prompt");
  assert.equal(c.voice.name, "ru-RU-Chirp3-HD-Orus");
  assert.equal(c.audioConfig.speakingRate, 1.05);

  const f = stubFetch((_call, n) => (n === 1 ? [404, { error: { code: 404, message: "model gemini-2.5-flash-tts not found" } }] : n === 2 ? [429, { error: { code: 429, message: "Quota exceeded" } }] : [200, cloudAudio(0.6)]));
  const waits: number[] = [];
  const r = await cloudTts("Кофе.", { kind: "gemini", voiceName: "Kore", languageCode: "ru-RU" }, { key: "ck", fetch: f.fn, cacheDir: null, prompt: "p", sleep: async (ms) => void waits.push(ms) });
  assert.equal(r.model, "gemini-2.5-pro-tts");
  assert.equal(r.rate, 24000);
  assert.ok(Math.abs(r.pcm.length / 24000 - 0.6) < 0.01, "the WAV header is not read as samples");
  assert.deepEqual(waits, [2000]);
  assert.ok(f.calls.every((x) => x.url === CLOUD_TTS_URL && x.key === "ck"));

  const bad = stubFetch(() => [400, { error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } }]);
  await assert.rejects(cloudTts("x", { kind: "chirp3", voiceName: "Orus", languageCode: "ru-RU" }, { key: "bad", fetch: bad.fn, cacheDir: null }), (e: Error & { fatal?: boolean }) => e.fatal === true && /Cloud Text-to-Speech API/.test(e.message));
  assert.match(CLOUD_KEY_HELP, /console\.cloud\.google\.com[\s\S]*APIs & Services[\s\S]*Cloud Text-to-Speech API[\s\S]*Create credentials[\s\S]*GOOGLE_CLOUD_API_KEY=/);
  assert.match(TTS_KEYS_HELP, /GOOGLE_CLOUD_API_KEY[\s\S]*GEMINI_API_KEY/);
});

test("key routing: Cloud first when both keys exist; Chirp without the Cloud key speaks through the Gemini API; 2+2 Chirp voices", async () => {
  interactionsFirst();
  resetCloudState();
  const chirp = VOICES.filter((v) => v.engine === "chirp3");
  assert.equal(chirp.filter((v) => v.gender === "male").length, 2);
  assert.equal(chirp.filter((v) => v.gender === "female").length, 2);
  for (const v of chirp) {
    assert.equal(v.language, "ru");
    assert.match(v.license, /коммерц.*1 млн символов/);
    assert.equal(piperVoiceFor(v)?.engine, "piper");
  }
  const charon = getVoice("gemini_charon")!;
  const orus = getVoice("chirp_orus")!;
  assert.equal(cloudBackend(charon, { cloud: { key: "c" }, gemini: { key: "g" } })?.kind, "cloud-gemini");
  assert.equal(cloudBackend(orus, { cloud: { key: "c" }, gemini: { key: "g" } })?.kind, "cloud-chirp3");
  assert.equal(cloudBackend(charon, { cloud: { key: "" }, gemini: { key: "g" } })?.kind, "gemini-api");
  assert.match(cloudBackend(orus, { cloud: { key: "" }, gemini: { key: "g" } })!.warning!, /GOOGLE_CLOUD_API_KEY/);
  assert.equal(cloudBackend(orus, { cloud: { key: "" }, gemini: { key: "" } }), null);

  // both keys: the Cloud endpoint is used, with the narration style as the Gemini-TTS prompt
  const cf = stubFetch((c) => [200, cloudAudio(0.5 + cloudText(c).length / 40)]);
  const gf = stubFetch(() => [500, {}]);
  const r = await synthesize(["Арабика: $7500 за тонну.", "Робуста дешевле."], "gemini_charon", path.join(tmp, "cloud.wav"), { gemini: { key: "g", fetch: gf.fn, cacheDir: null, style: "S" }, cloud: { key: "c", fetch: cf.fn, cacheDir: null, sleep: noSleep } });
  assert.equal(r.engine, "cloud");
  assert.equal(r.model, "gemini-2.5-flash-tts");
  assert.equal(cf.calls.length, 2);
  assert.equal(gf.calls.length, 0);
  assert.equal((cf.calls[0].body as { input: { prompt: string } }).input.prompt, "S");
  assert.ok(r.lines[1].start > r.lines[0].end);

  // Chirp voice + Cloud key → chirp3-hd
  const cf2 = stubFetch(() => [200, cloudAudio(0.7)]);
  const r2 = await synthesize("Кофе дорожает.", "chirp_leda", path.join(tmp, "chirp.wav"), { cloud: { key: "c", fetch: cf2.fn, cacheDir: null, speakingRate: 1.05 } });
  assert.equal(r2.model, "chirp3-hd");
  assert.equal((cf2.calls[0].body as { voice: { name: string } }).voice.name, "ru-RU-Chirp3-HD-Leda");

  // Chirp voice with only the Gemini key → the same voice name through the Gemini API, with a warning
  const gf2 = stubFetch(() => [200, interactionsAudio(0.5)]);
  const r3 = await synthesize("Кофе дорожает.", "chirp_fenrir", path.join(tmp, "chirp-g.wav"), { cloud: { key: "" }, gemini: { key: "g", fetch: gf2.fn, cacheDir: null } });
  assert.equal(r3.engine, "gemini");
  assert.equal((gf2.calls[0].body as { generation_config: { speech_config: { voice: string }[] } }).generation_config.speech_config[0].voice, "Fenrir");
  assert.match(r3.warnings[0], /Gemini API/);
  assert.equal(resolveMakeVoice("chirp_orus", "ru").voice.id, "chirp_orus");
});

test("a rejected key or exhausted quota does not fail the video: Piper speaks instead, with the reason", async () => {
  resetGeminiState();
  const bad = stubFetch(() => [403, { error: { code: 403, message: "Permission denied", status: "PERMISSION_DENIED" } }]);
  const seen: string[] = [];
  const stub = async (_t: string, v: { id: string }) => (seen.push(v.id), { pcm: tone(0.3, 22050), rate: 22050 });
  const r = await synthesize("Кофе дорожает.", "gemini_puck", path.join(tmp, "denied.wav"), { synth: stub, cloud: { key: "" }, gemini: { key: "k", fetch: bad.fn, cacheDir: null, sleep: noSleep } });
  assert.equal(r.engine, "piper");
  assert.equal(r.voice, "denis");
  assert.deepEqual(seen, ["denis"]);
  assert.match(r.warnings[0], /gemini_puck[\s\S]*не получился[\s\S]*Piper denis/);
});
