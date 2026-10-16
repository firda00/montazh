// Stage 15: voices. Catalogue licences, Russian TTS normalisation, sentence-by-sentence synthesis (stubbed:
// no Piper, no downloads), beats stretched to the speech, the mix graph with voice + ducking, make with a voice,
// avatar export with a Piper / Chatterbox-preset voice, bot /voice and /send routing. No network, no models.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-voice-ws-"));

const { VOICES, getVoice, requireVoice, piperVoiceFor, formatVoices, NO_VOICE } = await import("../src/voice/catalog.ts");
const { normalizeForTts, numberToWords, ordinalToWords, pluralIndex, splitSentences, stripMarkup } = await import("../src/voice/normalize.ts");
const { synthesize, setSentenceSynth, wavBytes } = await import("../src/voice/piper.ts");
const { fitBeatsToSpeech, beatStarts, layVoiceTrack, captionCues, narrationLines, resolveMakeVoice, VOICE_LEAD, VOICE_TAIL } = await import("../src/voice/voiceover.ts");
const { buildMixGraph, mixSoundtrack } = await import("../src/audio/mix.ts");
const { ScriptSchema, normalizeScript } = await import("../src/make/script.ts");
const { make } = await import("../src/make/index.ts");
const { exportAvatarJob } = await import("../src/avatar/export.ts");
const { createBot, MSG, outputFileName } = await import("../src/bot/index.ts");
const { MODULES } = await import("../src/modules.ts");
const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
const { readZip } = await import("../src/lib/zip.ts");
const { jobDir, readJson } = await import("../src/lib/workspace.ts");
const { AvatarScriptSchema, AvatarStateSchema } = await import("../src/avatar/schema.ts");
type SentenceSynth = import("../src/voice/piper.ts").SentenceSynth;
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;
type TgUpdate = import("../src/bot/telegram-api.ts").TgUpdate;
type TgMessage = import("../src/bot/telegram-api.ts").TgMessage;
type StructuredFn = import("../src/lib/llm.ts").StructuredFn;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-voice-"));

/** A fake Piper: a 220 Hz tone, 60 ms per character, so lengths are predictable. */
const RATE = 22050;
const calls: string[] = [];
const stub: SentenceSynth = async (text) => {
  calls.push(text);
  const n = Math.round(RATE * 0.06 * text.length);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) pcm[i] = Math.round(4000 * Math.sin((2 * Math.PI * 220 * i) / RATE));
  return { pcm, rate: RATE };
};
// every synthesize() in this file (make, avatar) goes through the stub, never to Piper
setSentenceSynth(stub);

test("catalogue: unique ids, clean licences only (no NC / unknown), ruslan and irina excluded, presets resolve", () => {
  const ids = VOICES.map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const v of VOICES) {
    assert.ok(v.license && v.engineLicense && v.source && v.name, v.id);
    assert.ok(!/(\bNC\b|non-?commercial|некоммерч|unknown|неизвест)/i.test(v.license), `${v.id}: ${v.license}`);
    assert.ok(v.engine === "gemini" || v.engine === "chirp3" ? /(Gemini API|Google Cloud).*коммерц/i.test(v.license) : /(CC0|public domain|MIT|CC-BY|Apache)/i.test(v.license), `${v.id}: ${v.license}`);
    if (v.engine === "piper") assert.ok(v.piper && v.piper.bytes > 1e6 && v.piper.key.includes(v.piper.path.split("/")[2]), v.id);
    if (v.refFrom) assert.equal(getVoice(v.refFrom)?.engine, "piper", v.id);
  }
  assert.ok(!VOICES.some((v) => /ruslan|irina|lessac|ryan|hfc_/i.test(`${v.id} ${v.piper?.key ?? ""}`)));
  assert.ok(VOICES.some((v) => v.language === "ru" && v.gender === "female"), "a female Russian voice (Chatterbox)");
  assert.ok(VOICES.filter((v) => v.language === "en" && v.engine === "piper").length >= 2);
  assert.equal(getVoice("ru_RU-denis-medium")?.id, "denis");
  assert.equal(getVoice("DENIS")?.id, "denis");
  assert.equal(getVoice("nope"), undefined);
  assert.throws(() => requireVoice("nope"), /не найден/);
  assert.equal(piperVoiceFor(requireVoice("chatterbox_dmitri"))?.id, "dmitri");
  assert.equal(piperVoiceFor(requireVoice("chatterbox_default")), undefined);
  assert.ok(NO_VOICE.test("none") && NO_VOICE.test("off") && NO_VOICE.test("выкл") && !NO_VOICE.test("denis"));
  assert.match(formatVoices(), /denis\s+муж\s+ru\s+piper\s+локально\s+CC0/);
});

test("normalisation: numbers with agreement, years, $, %, ×3, abbreviations; emojis and markdown gone", () => {
  assert.deepEqual([pluralIndex(1), pluralIndex(3), pluralIndex(11), pluralIndex(22), pluralIndex(25), pluralIndex(101)], [0, 1, 2, 1, 2, 0]);
  assert.equal(numberToWords(2026), "две тысячи двадцать шесть");
  assert.equal(numberToWords(1_000_001), "один миллион один");
  assert.equal(numberToWords(21, "f"), "двадцать одна");
  assert.equal(ordinalToWords(2026, "prep"), "две тысячи двадцать шестом");
  assert.equal(ordinalToWords(2003, "gen"), "две тысячи третьего");
  assert.equal(ordinalToWords(1999, "prep"), "тысяча девятьсот девяносто девятом");
  assert.equal(ordinalToWords(2000, "nom"), "двухтысячный");
  const ru = (s: string) => normalizeForTts(s, "ru");
  assert.equal(ru("Почему кофе дорожает в 2026? 🔥☕"), "Почему кофе дорожает в две тысячи двадцать шестом году?");
  assert.equal(ru("к 2030 году"), "к две тысячи тридцатому году");
  assert.equal(ru("Цена выросла на 30%, потом на 21% и 1,5%."), "Цена выросла на тридцать процентов, потом на двадцать один процент и полтора процента.");
  assert.equal(ru("Рынок — $5 млн, т.е. 2,5 млрд руб."), "Рынок — пять миллионов долларов, то есть две целых пять десятых миллиарда рублей.");
  assert.equal(ru("Продажи выросли ×3."), "Продажи выросли в три раза.");
  assert.equal(ru("Это 22 $ и 100 ₽"), "Это двадцать два доллара и сто рублей");
  assert.equal(ru("21 тысяча чашек и 2 минуты"), "двадцать одна тысяча чашек и две минуты");
  assert.equal(ru("**Важно**: смотри [сюда](https://x.y) #кофе"), "Важно: смотри сюда кофе");
  assert.equal(ru("ИИ и т.д."), "искусственный интеллект и так далее");
  assert.equal(normalizeForTts("Up 30% to $5m 🚀", "en"), "Up 30 percent to 5 million dollars");
  assert.equal(stripMarkup("## Заголовок\n- пункт 👍"), "Заголовок\nпункт");
  assert.deepEqual(splitSentences("Привет! Как дела? Отлично…"), ["Привет!", "Как дела?", "Отлично…"]);
  const long = splitSentences(`${"слово ".repeat(30)}, ${"ещё ".repeat(40)}`, 120);
  assert.ok(long.length >= 2 && long.every((x) => x.length <= 120), JSON.stringify(long));
});

test("synthesize: sentence by sentence, normalised text to the engine, exact line/sentence timings, valid WAV", async () => {
  calls.length = 0;
  const out = path.join(tmp, "s.wav");
  const r = await synthesize(["Цена выросла на 30%. Вот почему.", "", "Подпишись!"], "denis", out, { sentencePauseMs: 200, linePauseMs: 400, tailMs: 100 });
  assert.deepEqual(calls, ["Цена выросла на тридцать процентов.", "Вот почему.", "Подпишись!"]);
  assert.equal(r.sentences.length, 3);
  assert.equal(r.lines.length, 3, "empty lines keep their index");
  const len = (t: string) => Math.round(RATE * 0.06 * t.length) / RATE;
  assert.ok(Math.abs(r.sentences[0].end - len(calls[0])) < 0.01, JSON.stringify(r.sentences[0]));
  assert.ok(Math.abs(r.sentences[1].start - (r.sentences[0].end + 0.2)) < 0.002, "sentence pause");
  assert.ok(Math.abs(r.sentences[2].start - (r.sentences[1].end + 0.4)) < 0.002, "line pause");
  assert.equal(r.lines[0].end, r.sentences[1].end);
  assert.equal(r.lines[2].start, r.sentences[2].start);
  assert.equal(r.clips.length, 3);
  assert.equal(r.clips[1].pcm.length, 0);
  const probe = await ffprobe(out);
  assert.ok(Math.abs(Number(probe.format.duration) - r.duration) < 0.01, `${probe.format.duration} vs ${r.duration}`);
  assert.equal(Math.abs(r.duration - (r.sentences[2].end + 0.1)) < 0.002, true);
  await assert.rejects(() => synthesize("x", "chatterbox_default", out), /только в Colab/);
  assert.equal(wavBytes(new Int16Array(10), 16000).length, 44 + 20);
});

const SCRIPT = ScriptSchema.parse({
  title: "Кофе",
  language: "ru",
  beats: [
    { text: "Кофе подорожал на 30%.", voiceover: "За год чашка кофе подорожала почти на треть.", seconds: 3 },
    { text: "Засуха в Бразилии.", seconds: 4 },
    { text: "Бери зерно.", voiceover: "Хочешь дешевле? Бери зерно, а не капсулы.", seconds: 3 },
  ],
});

test("voiceover timing: beats stretch to the speech on the frame grid, speech laid at scene starts, captions follow it", () => {
  assert.deepEqual(narrationLines(SCRIPT), ["За год чашка кофе подорожала почти на треть.", "Засуха в Бразилии.", "Хочешь дешевле? Бери зерно, а не капсулы."]);
  const fitted = fitBeatsToSpeech(SCRIPT, [4.2, 0.9, 30]);
  assert.equal(fitted.beats[0].seconds, Math.ceil((VOICE_LEAD + 4.2 + VOICE_TAIL) * 30) / 30);
  assert.equal(fitted.beats[1].seconds, 2, "short speech: at least 2 s");
  assert.equal(fitted.beats[2].seconds, 15, "capped");
  assert.equal(fitBeatsToSpeech(SCRIPT, [0, 0, 0]).beats[1].seconds, 4, "no speech: unchanged");
  const starts = beatStarts(fitted);
  assert.equal(starts[1].start, starts[0].duration);
  const clip = (s: number) => ({ pcm: new Int16Array(Math.round(s * 1000)).fill(1000), rate: 1000 });
  const laid = layVoiceTrack([clip(4.2), clip(0.9), clip(2)], starts, 25);
  assert.equal(laid.pcm.length, 25000);
  assert.deepEqual(laid.at.map((x) => Math.round(x * 1000) / 1000), starts.map((s) => Math.round((s.start + VOICE_LEAD) * 1000) / 1000));
  // an overlong clip pushes the next one later instead of overlapping it
  const pushed = layVoiceTrack([clip(9), clip(1)], [{ start: 0 }, { start: 3 }], 15);
  assert.ok(pushed.at[1] >= 0.25 + 9 + 0.1 - 1e-9);
  const cues = captionCues([{ line: 0, text: "Раз два три четыре пять шесть семь восемь", start: 1, end: 3 }], [1], [10], 4);
  assert.deepEqual(cues.map((c) => c.text), ["Раз два три четыре", "пять шесть семь восемь"]);
  assert.equal(cues[0].start, 10);
  assert.ok(Math.abs(cues.at(-1)!.end - 12) < 0.002);
  assert.equal(resolveMakeVoice("chatterbox_denis", "ru").voice.id, "denis");
  assert.match(resolveMakeVoice("chatterbox_default", "ru").warning!, /только в аватаре/);
  assert.match(resolveMakeVoice("john", "ru").warning!, /акцент/);
  assert.equal(resolveMakeVoice("denis", "Russian").warning, undefined, "language names from the script writer count as codes");
});

test("script: voiceover is optional in the model answer and kept when given", async () => {
  const s = await normalizeScript({ title: "T", language: "ru", beats: [{ text: "А", emphasis: "", icon: "x", seconds: 3, voiceover: "  Скажи   это. " }, { text: "Б", emphasis: "", icon: "x", seconds: 3 }, { text: "В", emphasis: "", icon: "x", seconds: 3 }], hashtags: [] });
  assert.equal(s.beats[0].voiceover, "Скажи это.");
  assert.equal(s.beats[1].voiceover, undefined);
});

test("mix graph: voice on top, music and effects side-chain ducked under it, loudness normalised", async () => {
  const g = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", voice: "voice.wav", sfx: [{ t: 1, kind: "whoosh" }, { t: 2, kind: "pop" }] }, { hasAudio: false, sfxFile: (k) => `${k}.wav` });
  const fc = g.args[g.args.indexOf("-filter_complex") + 1];
  assert.ok(g.args.includes("voice.wav") && g.args.includes("m.mp3"));
  assert.match(fc, /\[1:a\][^;]*loudnorm=I=-16[^;]*asplit=3\[vo\]\[vk0\]\[vk1\]/);
  assert.match(fc, /\[mus\]\[vk0\]sidechaincompress/);
  assert.match(fc, /\[fxbus\]\[vk1\]sidechaincompress[^;]*\[fxduck\]/);
  assert.match(fc, /loudnorm=I=-22/, "music bed 6 dB under the voice in the gaps (ducked further while it talks)");
  assert.match(fc, /\[mus\]\[vk0\]sidechaincompress=threshold=0\.004:ratio=3:attack=10:release=160/, "gentle, fast-release ducking");
  assert.match(fc, /\[vo\]\[duck\]\[fxduck\]amix=inputs=3[^;]*loudnorm=I=-14/);
  assert.match(fc, /\[3:a\]adelay=1000\|1000,volume=-2\.0dB/, "effects 5 dB quieter under a voice");
  // without a voice nothing changes
  const plain = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", sfx: [] }, { hasAudio: false, sfxFile: (k) => k });
  assert.ok(!/sidechain|vo\]/.test(plain.args.join(" ")));
  // voice only (no music, no effects)
  const vo = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, voice: "voice.wav" }, { hasAudio: false, sfxFile: (k) => k });
  assert.match(vo.args.join(" "), /loudnorm=I=-16:TP=-2:LRA=9\[vo\];\[vo\]amix=inputs=1/);

  // real ffmpeg: a silent clip + music + a voice → one AAC track at about −14 LUFS
  const video = path.join(tmp, "silent.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=160x284:rate=30:duration=4", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video]);
  const music = path.join(tmp, "music.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=330:duration=6", "-ac", "2", music]);
  const voice = path.join(tmp, "voice.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=180:duration=2,tremolo=f=5:d=0.8,adelay=1000", "-ac", "1", "-ar", "22050", voice]);
  const out = path.join(tmp, "mixed.mp4");
  const r = await mixSoundtrack({ video, out, duration: 4, music, voice, sfx: [{ t: 0.5, kind: "pop" }] });
  assert.deepEqual([r.voice, r.music, r.cues], [true, true, 1]);
  const p = await ffprobe(out);
  assert.ok(p.streams.some((s) => s.codec_type === "audio"));
  assert.ok(Math.abs(Number(p.format.duration) - 4) < 0.15);
});

test("make --voice: narration synthesised, beats stretched to it, voice track mixed, report records the voice", async () => {
  calls.length = 0;
  const raw = {
    title: "Кофе дорожает",
    language: "ru",
    beats: [
      { text: "Чашка кофе за год подорожала на 30%.", emphasis: "30%", icon: "coffee", seconds: 3, voiceover: "За год чашка кофе подорожала почти на треть." },
      { text: "Засуха в Бразилии срезала урожай.", emphasis: "Бразилии", icon: "cloud-sun", seconds: 4, voiceover: "Всё из-за засухи в Бразилии: урожай арабики упал." },
      { text: "Подпишись.", emphasis: "", icon: "bell", seconds: 3 },
    ],
    hashtags: ["кофе"],
  };
  const llm: StructuredFn = async () => ({ data: raw, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0, estimate: false, model: "mock", provider: "mock" });
  const r = await make("почему кофе дорожает", {
    llm,
    trends: false,
    director: false,
    music: "none",
    voice: "denis",
    fakeRender: async (_dir, out) => {
      await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=270x480:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    },
  });
  assert.equal(r.voice, "denis");
  assert.ok(r.voice_seconds > 0);
  assert.equal(calls.length, 3, "two voiceovers + the on-screen text of the last beat (no voiceover)");
  assert.ok(calls.includes("За год чашка кофе подорожала почти на треть.") && calls.includes("Подпишись."));
  const dir = jobDir(r.jobId);
  const saved = await readJson(path.join(dir, "script.json"), ScriptSchema);
  const speech0 = Math.round(RATE * 0.06 * "За год чашка кофе подорожала почти на треть.".length) / RATE;
  assert.equal(saved.beats[0].seconds, Math.ceil((VOICE_LEAD + speech0 + VOICE_TAIL) * 30 - 1e-6) / 30, "beat 1 follows its speech");
  const vj = JSON.parse(await fs.readFile(path.join(dir, "make", "voice", "voice.json"), "utf8"));
  assert.equal(vj.voice, "denis");
  assert.equal(vj.beats.length, 3);
  const track = await ffprobe(path.join(dir, "make", "voice", "voice.wav"));
  const total = saved.beats.reduce((n, b) => n + Math.round(b.seconds * 30), 0) / 30;
  assert.ok(Math.abs(Number(track.format.duration) - total) < 0.02, `voice track ${track.format.duration} vs video ${total}`);
  const lay = JSON.parse(await fs.readFile(path.join(dir, "make", "project", "layout.json"), "utf8"));
  assert.ok(Math.abs(lay.frame.duration - total) < 0.02, "the composition is as long as the voiced script");
});

async function face() {
  const f = path.join(tmp, "face.png");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=600x900:rate=1", "-frames:v", "1", f]);
  return f;
}

test("avatar export --voice: Piper voice → speech_in.wav with line timings; Chatterbox preset → Piper-made voice_ref.wav; a voice file wins", async () => {
  const photo = await face();
  const a = await exportAvatarJob({ text: "Привет! Это аватар.\nВторой абзац про кофе: плюс 30%.", photo, voiceId: "denis", language: "ru" });
  const zip = await readZip(a.bundle);
  assert.ok(zip.has("speech_in.wav") && !zip.has("voice_ref.wav"), [...zip.keys()].join(","));
  const script = AvatarScriptSchema.parse(JSON.parse(zip.get("script.json")!.toString("utf8")));
  assert.equal(script.speech, "speech_in.wav");
  assert.equal(script.voice_id, "denis");
  assert.equal(script.speech_meta?.engine, "piper");
  assert.equal(script.speech_meta?.lines.length, 2);
  assert.ok(script.speech_meta!.lines[1].start > script.speech_meta!.lines[0].end);
  const st = await readJson(path.join(jobDir(a.jobId), "avatar.json"), AvatarStateSchema);
  assert.deepEqual([st.voice, st.voice_id, st.source], ["library", "denis", "text"]);
  const sp = (await ffprobe(path.join(jobDir(a.jobId), "avatar", "job", "speech_in.wav"))).streams[0] as unknown as { sample_rate: string; channels: number };
  assert.deepEqual([sp.sample_rate, sp.channels], ["24000", 1]);

  const b = await exportAvatarJob({ text: "Привет! Это клон.", photo, voiceId: "chatterbox_denis", language: "ru" });
  const zb = await readZip(b.bundle);
  assert.ok(zb.has("voice_ref.wav") && !zb.has("speech_in.wav"));
  assert.equal(b.state.voice, "clone");
  assert.equal(b.script.voice_id, "chatterbox_denis");

  const c = await exportAvatarJob({ text: "Привет!", photo, voiceId: "chatterbox_default", language: "ru" });
  assert.equal(c.state.voice, "default");
  assert.ok(!(await readZip(c.bundle)).has("voice_ref.wav"));

  const own = path.join(tmp, "own.wav");
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=200:duration=6", own]);
  const d = await exportAvatarJob({ text: "Привет!", photo, voice: own, voiceId: "denis", language: "ru" });
  assert.equal(d.state.voice, "clone", "the user's own sample wins over the catalogue");
  assert.equal(d.state.voice_id, undefined);
});

// ---- bot ----
function fakeApi() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const callMethod: CallMethod = async <T,>(_t: string, method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === "getFile") return { file_id: params.file_id, file_size: 100, file_path: `x/${params.file_id}` } as T;
    if (method === "sendChatAction") return true as T;
    return { message_id: calls.length, chat: { id: params.chat_id, type: "private" } } as T;
  };
  const download = async (_t: string, _f: unknown, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "x");
  };
  const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.params.text));
  return { calls, callMethod, download, texts };
}
let nextId = 1;
const msg = (m: Partial<TgMessage>): TgUpdate => ({ update_id: nextId++, message: { message_id: nextId, chat: { id: 9, type: "private" }, from: { id: 1 }, ...m } });

test("bot: /voice lists, sets (with a sample voice message), turns off; /make and /avatar get the voice; a voice note wins", async () => {
  const fake = fakeApi();
  const makes: (string | undefined)[] = [];
  const avatars: { voice?: string; voiceId?: string }[] = [];
  const samples: string[] = [];
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-voice-bot-")),
    callMethod: fake.callMethod,
    download: fake.download,
    onLog: () => {},
    onboarding: false,
    quotas: false,
    cleanupIntervalMs: 0,
    voiceSample: async (id, dest) => {
      samples.push(id);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, "OggS");
      return dest;
    },
    make: async (a) => (makes.push(a.voice), { jobId: "j", outputs: [] }),
    avatarExport: async (a) => (avatars.push({ voice: a.voice, voiceId: a.voiceId }), { jobId: "j", outputs: [], message: "ok" }),
  });
  assert.match(MSG.help, /\/voice/);
  assert.match(MSG.help, /\/send file \| video \| both/);

  await bot.handleUpdate(msg({ text: "/voice" }));
  assert.match(fake.texts().at(-1)!, /сейчас: авто — (dmitri|gemini_charon)[\s\S]*gemini_charon[\s\S]*denis[\s\S]*chatterbox_default/);
  await bot.handleUpdate(msg({ text: "/voice ДЕНИС" }));
  await bot.idle();
  assert.equal(bot.settings(1).voice, "denis");
  assert.match(fake.texts().at(-1)!, /^Голос: denis/);
  const voiceMsg = fake.calls.find((c) => c.method === "sendVoice");
  assert.ok(voiceMsg && (voiceMsg.params.voice as File).type === "audio/ogg", "a sample goes out as a voice message");
  assert.deepEqual(samples, ["denis"]);
  // the second time the cached sample is reused
  await bot.handleUpdate(msg({ text: "/voice denis" }));
  await bot.idle();
  assert.deepEqual(samples, ["denis"]);
  assert.equal(fake.calls.filter((c) => c.method === "sendVoice").length, 2);

  await bot.handleUpdate(msg({ text: "/voice nope" }));
  assert.equal(fake.texts().at(-1), MSG.voiceUnknown("nope"));
  await bot.handleUpdate(msg({ text: "/make почему кофе дорожает" }));
  await bot.idle();
  await bot.handleUpdate(msg({ text: "/avatar Привет! Это текст." }));
  await bot.idle();
  assert.deepEqual(makes, ["denis"]);
  assert.deepEqual(avatars[0], { voice: undefined, voiceId: "denis" });

  // the user's own voice note wins over the catalogue voice
  await bot.handleUpdate(msg({ voice: { file_id: "vo-9", duration: 6, mime_type: "audio/ogg" } }));
  await bot.handleUpdate(msg({ text: "/avatar Привет ещё раз." }));
  await bot.idle();
  assert.match(avatars[1].voice!, /vo-9/);
  assert.equal(avatars[1].voiceId, undefined);

  // chatterbox_default has no local sample
  await bot.handleUpdate(msg({ text: "/voice chatterbox_default" }));
  await bot.idle();
  assert.equal(fake.calls.filter((c) => c.method === "sendVoice").length, 2);
  assert.match(fake.texts().at(-1)!, /Им будет говорить \/avatar/);

  await bot.handleUpdate(msg({ text: "/voice off" }));
  assert.equal(bot.settings(1).voice, "off");
  assert.equal(fake.texts().at(-1), MSG.voiceOff);
  await bot.handleUpdate(msg({ text: "/make тема" }));
  await bot.idle();
  assert.deepEqual(makes, ["denis", undefined]);
});

test("bot: /send file (default) | video | both; oversize outputs go as a shrunk copy", async () => {
  const fake = fakeApi();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-send-"));
  const small = path.join(dir, "output_reel_1.mp4");
  await fs.writeFile(small, "small video");
  const big = path.join(dir, "output_reel_2.mp4");
  await fs.writeFile(big, "x".repeat(2000));
  const shrunk: string[] = [];
  const outputs = [{ id: "reel_1", file: small, duration: 12, aspect: "9:16" }];
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-send-bot-")),
    callMethod: fake.callMethod,
    download: fake.download,
    onLog: () => {},
    onboarding: false,
    quotas: false,
    cleanupIntervalMs: 0,
    limits: { uploadBytes: 1000 },
    adminIds: [1], // the server path of the original is shown to admins only
    shrinkVideo: async (f) => {
      shrunk.push(f);
      const out = f.replace(/\.mp4$/, "_tg.mp4");
      await fs.writeFile(out, "shrunk");
      return out;
    },
    make: async () => ({ jobId: "20261014-abcdef", title: "почему кофе дорожает", outputs }),
  });
  const sent = () => fake.calls.filter((c) => c.method === "sendVideo" || c.method === "sendDocument");

  await bot.handleUpdate(msg({ text: "/make почему кофе дорожает" }));
  await bot.idle();
  assert.deepEqual(sent().map((c) => c.method), ["sendDocument"]);
  assert.equal((sent()[0].params.document as File).name, "почему_кофе_дорожает_reel_1.mp4");
  assert.equal(sent()[0].params.disable_content_type_detection, true);

  await bot.handleUpdate(msg({ text: "/send видео" }));
  assert.equal(bot.settings(1).send, "video");
  fake.calls.length = 0;
  await bot.handleUpdate(msg({ text: "/make тема" }));
  await bot.idle();
  assert.deepEqual(sent().map((c) => c.method), ["sendVideo"]);

  await bot.handleUpdate(msg({ text: "/send both" }));
  fake.calls.length = 0;
  outputs.push({ id: "reel_2", file: big, duration: 40, aspect: "9:16" });
  await bot.handleUpdate(msg({ text: "/make тема" }));
  await bot.idle();
  assert.deepEqual(sent().map((c) => c.method), ["sendVideo", "sendDocument", "sendVideo", "sendDocument"]);
  assert.deepEqual(shrunk, [big]);
  assert.equal(await (sent()[3].params.document as File).text(), "shrunk");
  assert.ok(fake.texts().some((t) => /reel_2: оригинал .* больше лимита .* сжатую копию; оригинал на сервере/.test(t) && t.includes(big)));

  await bot.handleUpdate(msg({ text: "/send nonsense" }));
  assert.equal(fake.texts().at(-1), MSG.sendUsage("both"));
  // a document that fails falls back to a video
  await bot.handleUpdate(msg({ text: "/send file" }));
  assert.equal(outputFileName({ jobId: "20261014-abcdef" }, "reel_1"), "20261014-abcdef_reel_1.mp4");
  assert.equal(outputFileName({ jobId: "j", title: "  Кофе: $5 / чашка!  " }, "make"), "Кофе_5_чашка_make.mp4");
});

test("registry: voice module lists every catalogue voice with its licence, cost $0", async () => {
  const m = MODULES.find((x) => x.id === "voice")!;
  assert.ok(m);
  assert.ok(m.backends.some((b) => b.id === "piper" && /MIT/.test(b.license) && /GPL/.test(b.license)));
  for (const v of VOICES) assert.ok(m.backends.some((b) => b.id === `voice:${v.id}` && b.license === v.license), v.id);
  assert.ok(m.cost!({ step: "design", provider: "piper (local)", model: "x", units: {}, usd: 0 } as never));
  const p = await m.probe({});
  assert.equal(p.active, "piper");
});
