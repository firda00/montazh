// Stage 30: «Русская версия» — the timing of a dub (fit.ts: re-sync at every phrase, overlap into silence,
// speed-up ≤ 1.25×, trim before the next phrase), the dub track on disk, the ffmpeg mix, and dubVideo end to end
// with a stubbed translator and a stubbed TTS (no network, no API quota). One real ffmpeg mix of a 3-second clip.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30dub-ws-"));

const { fitDub, placeOne, phraseLimits, charBudget, dubRanges, dubSrt, srtTime, wrapCaption, DUB_GAP } = await import("../src/dub/fit.ts");
const { writeDubTrack, saveClip, resample, trimWithFade, atempoStretch } = await import("../src/dub/track.ts");
const { dubVideo, dubJobOutputs, buildDubMix, ffmpegMux, phrasesFromTranscript, unofficialLabel, DUB_RATE, DubReportSchema } = await import("../src/dub/index.ts");
const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
const { createJob, jobDir } = await import("../src/lib/workspace.ts");
type DubPhrase = import("../src/dub/fit.ts").DubPhrase;
type StructuredQuery = import("../src/lib/llm.ts").StructuredQuery;
type TtsBatchFn = import("../src/dub/index.ts").TtsBatchFn;
type MixArgs = import("../src/dub/index.ts").MixArgs;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30dub-"));
const ph = (i: number, start: number, end: number, text = `phrase ${i}`): DubPhrase => ({ i, start, end, text, lang: "en" });

// ── fit ─────────────────────────────────────────────────────────────────────────

test("fit: a dub that fits keeps speed 1; a bit longer runs into the following silence; longer is sped up ≤ 1.25×; what still does not fit is trimmed before the next phrase", () => {
  // phrase 2.0–4.0, next phrase at 6.0 → may run until 5.92
  const limit = 6 - DUB_GAP;
  const fits = placeOne(ph(0, 2, 4), 1.8, limit);
  assert.deepEqual([fits.start, fits.speed, fits.out, fits.trimmed, fits.overlap], [2, 1, 1.8, 0, 0]);
  const overlap = placeOne(ph(0, 2, 4), 2.5, limit);
  assert.deepEqual([overlap.speed, overlap.out, overlap.trimmed], [1, 2.5, 0], "0.5 s into the silence at normal speed");
  assert.equal(overlap.overlap, 0.5);
  const fast = placeOne(ph(0, 2, 4), 3.0, limit);
  assert.ok(fast.speed > 1 && fast.speed <= 1.25, `speed ${fast.speed}`);
  assert.equal(fast.trimmed, 0);
  assert.ok(fast.start + fast.out <= limit + 1e-9);
  const huge = placeOne(ph(0, 2, 4), 8, limit);
  assert.equal(huge.speed, 1.25);
  assert.ok(huge.trimmed > 0);
  assert.ok(Math.abs(huge.start + huge.out - limit) < 0.002, "cut exactly at next start − gap");
  // the last phrase may run up to the end of the video
  const last = placeOne(ph(0, 10, 11), 3, 20);
  assert.ok(last.speed <= 1.25 && last.trimmed === 0, "the last phrase is never cut while the video goes on");
});

test("fit: never drifts — 300 phrases with random clip lengths: every dub starts at its phrase's start and ends before the next one", () => {
  let t = 0;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const phrases: DubPhrase[] = [];
  for (let i = 0; i < 300; i++) {
    const len = 0.6 + rnd() * 5;
    phrases.push(ph(i, t, t + len));
    t += len + rnd() * 1.2; // pauses 0–1.2 s
  }
  const clips = phrases.map((p) => (p.end - p.start) * (0.6 + rnd() * 1.4));
  const { placements, stats } = fitDub(phrases, clips, { mediaDuration: t + 2 });
  for (const [k, p] of placements.entries()) {
    assert.equal(p.start, Math.round(phrases[k].start * 1000) / 1000, `phrase ${k} starts on time`);
    const next = phrases[k + 1];
    if (next) assert.ok(p.start + p.out <= next.start - DUB_GAP + 0.002, `phrase ${k} ends before the next`);
    assert.ok(p.speed >= 1 && p.speed <= 1.25);
  }
  assert.equal(stats.phrases, 300);
  assert.ok(stats.sped_up > 0 && stats.trimmed > 0 && stats.overlapping > 0, JSON.stringify(stats));
  assert.ok(stats.max_speed <= 1.25);
  assert.throws(() => fitDub(phrases, clips.slice(1), { mediaDuration: t }), /фраз/);
  assert.throws(() => fitDub([ph(0, 5, 6), ph(1, 1, 2)], [1, 1], { mediaDuration: 10 }), /по времени/);
});

test("fit helpers: limits, character budgets, duck ranges, SRT", () => {
  const phrases = [ph(0, 0, 2), ph(1, 2.5, 5), ph(2, 5.05, 6)];
  const lim = phraseLimits(phrases, 10);
  assert.deepEqual(lim.map((x) => Math.round(x * 100) / 100), [2.42, 4.97, 10]);
  // ru 14 chars/s: 2 s + 0.42 s of room → ~34 chars
  assert.equal(charBudget(phrases[0], lim[0], "ru"), Math.round(2.42 * 14));
  assert.ok(charBudget(ph(0, 0, 0.3), 0.3, "en") >= 12, "at least a couple of words");
  const ranges = dubRanges([
    { i: 0, start: 0, speed: 1, clip: 1, out: 1, trimmed: 0, overlap: 0, limit: 2 },
    { i: 1, start: 1.5, speed: 1, clip: 1, out: 1, trimmed: 0, overlap: 0, limit: 3 },
    { i: 2, start: 5, speed: 1, clip: 1, out: 1, trimmed: 0, overlap: 0, limit: 7 },
  ]);
  assert.deepEqual(ranges, [{ start: 0, end: 2.5 }, { start: 5, end: 6 }], "pauses under 1 s are bridged");
  assert.equal(srtTime(3723.5), "01:02:03,500");
  assert.equal(wrapCaption("short"), "short");
  assert.equal(wrapCaption("это довольно длинная фраза перевода которая не влезет в одну строку").split("\n").length, 2);
  const srt = dubSrt([{ i: 0, start: 1, speed: 1, clip: 0.4, out: 0.4, trimmed: 0, overlap: 0, limit: 2 }, { i: 1, start: 1.5, speed: 1, clip: 1, out: 1, trimmed: 0, overlap: 0, limit: 3 }], new Map([[0, "Привет"], [1, "Мир"]]));
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:01,480\nПривет\n\n2\n00:00:01,500 --> 00:00:02,500\nМир\n$/, "a short cue is held up to the next one");
});

// ── the track ──────────────────────────────────────────────────────────────────

const tone = (seconds: number, rate = DUB_RATE, amp = 8000) => {
  const pcm = new Int16Array(Math.round(seconds * rate));
  for (let j = 0; j < pcm.length; j++) pcm[j] = Math.round(amp * Math.sin((2 * Math.PI * 220 * j) / rate));
  return { pcm, rate };
};

test("track: clips land at their start sample, silence between, trimmed clips fade out, total length = video length", async () => {
  const dir = await tmp();
  await saveClip(dir, 0, tone(0.5));
  await saveClip(dir, 1, tone(1.0));
  const file = path.join(dir, "dub.wav");
  const r = await writeDubTrack(
    file,
    [
      { i: 0, start: 0.25, speed: 1, clip: 0.5, out: 0.5, trimmed: 0, overlap: 0, limit: 1 },
      { i: 1, start: 1.0, speed: 1.25, clip: 1.0, out: 0.6, trimmed: 0.4, overlap: 0, limit: 1.6 },
    ],
    dir,
    DUB_RATE,
    2.0,
  );
  assert.equal(r.speechSeconds, 1.1);
  const buf = await fs.readFile(file);
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + 44, (buf.length - 44) / 2);
  assert.equal(pcm.length, 2 * DUB_RATE);
  const peak = (a: number, b: number) => Math.max(...Array.from(pcm.subarray(Math.round(a * DUB_RATE), Math.round(b * DUB_RATE)), (x) => Math.abs(x)));
  assert.equal(peak(0, 0.24), 0, "silence before the first phrase");
  assert.ok(peak(0.3, 0.7) > 7000, "phrase 0");
  assert.equal(peak(0.76, 0.99), 0, "silence between");
  assert.ok(peak(1.1, 1.5) > 7000, "phrase 1");
  assert.ok(Math.abs(pcm[Math.round(1.6 * DUB_RATE) - 1]) < 50, "the trimmed end fades to zero");
  assert.equal(peak(1.61, 2), 0, "nothing after the trim");
  // resample / trim helpers
  assert.equal(resample(tone(1, 22050), 24000).pcm.length, 24000);
  assert.equal(trimWithFade(tone(1), 0.5).pcm.length, DUB_RATE / 2);
});

test("ffmpeg atempo speeds a clip up keeping its length ≈ len / speed", async () => {
  const c = tone(1.0);
  const fast = await atempoStretch(c, 1.25);
  assert.ok(Math.abs(fast.pcm.length / DUB_RATE - 0.8) < 0.03, `${fast.pcm.length / DUB_RATE}`);
  assert.equal((await atempoStretch(c, 1)).pcm.length, c.pcm.length, "speed 1 is a no-op");
});

// ── the mix ────────────────────────────────────────────────────────────────────

const mixArgs = (o: Partial<MixArgs> = {}): MixArgs => ({ video: "in.mp4", track: "dub.wav", srt: "dub_ru.srt", out: "out.mp4", mode: "voiceover", ranges: [{ start: 1, end: 3 }], lang: "ru", duration: 10, filterFile: "mix.filter", hasAudio: true, ...o });

test("mix: original ducked −18 dB under the dub (voice-over), video copied, Russian soft subtitles, «Неофициальный перевод» in the metadata; replace keeps the original low; ffmpeg < 7 reads the script the old way", () => {
  const v = buildDubMix(mixArgs());
  assert.ok(v.args.includes("-/filter_complex") && v.args[v.args.indexOf("-/filter_complex") + 1] === "mix.filter");
  assert.deepEqual(v.args.slice(v.args.indexOf("-c:v"), v.args.indexOf("-c:v") + 2), ["-c:v", "copy"]);
  assert.ok(v.args.includes("mov_text") && v.args.includes("language=rus") && v.args.includes(`title=${unofficialLabel("ru")}`));
  assert.ok(v.args.includes("comment=Неофициальный перевод (vedit)"));
  assert.match(v.filter, /\[0:a:0\][^;]*volume='1-0\.874\*min\(1,clip\(min\(\(t-0\.75\)\/0\.25,\(3\.25-t\)\/0\.25\),0,1\)\)':eval=frame\[orig\]/);
  assert.match(v.filter, /loudnorm=I=-16[^;]*\[dub\]/);
  assert.match(v.filter, /\[orig\]\[dub\]amix=inputs=2:normalize=0:duration=first/);
  const r = buildDubMix(mixArgs({ mode: "replace" }));
  assert.match(r.filter, /volume=-20dB,volume='1-0\.749/);
  const silent = buildDubMix(mixArgs({ hasAudio: false, srt: undefined }));
  assert.ok(!silent.filter.includes("[0:a"));
  assert.ok(!silent.args.includes("mov_text"));
  assert.ok(buildDubMix(mixArgs({ ffmpegMajor: 6 })).args.includes("-filter_complex_script"));
  assert.equal(unofficialLabel("uz"), "Norasmiy tarjima");
  assert.equal(unofficialLabel("en"), "Unofficial translation");
});

test("real ffmpeg: a 3-second clip + a dub track + SRT → MP4 with video copied, mixed audio and a Russian subtitle track", async () => {
  const dir = await tmp();
  const video = path.join(dir, "in.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc=size=160x120:rate=10", "-f", "lavfi", "-i", "sine=frequency=300:sample_rate=48000", "-t", "3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", video]);
  await saveClip(dir, 0, tone(1.0));
  const track = path.join(dir, "dub.wav");
  const placements = [{ i: 0, start: 0.5, speed: 1, clip: 1, out: 1, trimmed: 0, overlap: 0, limit: 2 }];
  await writeDubTrack(track, placements, dir, DUB_RATE, 3);
  const srt = path.join(dir, "dub_ru.srt");
  await fs.writeFile(srt, dubSrt(placements, new Map([[0, "Проверка перевода"]])));
  const out = path.join(dir, "out.mp4");
  await ffmpegMux(mixArgs({ video, track, srt, out, duration: 3, ranges: dubRanges(placements), filterFile: path.join(dir, "mix.filter") }));
  const p = await ffprobe(out);
  assert.ok(p.streams.some((s) => s.codec_type === "video" && s.codec_name === "h264"));
  assert.ok(p.streams.some((s) => s.codec_type === "audio"));
  const sub = p.streams.find((s) => s.codec_type === "subtitle");
  assert.equal(sub?.tags?.language, "rus");
  assert.ok(Math.abs(Number(p.format.duration) - 3) < 0.2);
});

// ── end to end with stubs ──────────────────────────────────────────────────────

/** a translator that answers with N characters per item (shorter on the shorten pass) */
function fakeLlm(calls: StructuredQuery[], lengthOf: (it: { i: number; max_chars: number }) => number) {
  return async (q: StructuredQuery) => {
    calls.push(q);
    const items = (JSON.parse(q.prompt.slice(q.prompt.lastIndexOf('{"items"'))) as { items: { i: number; text: string; max_chars: number }[] }).items;
    const shorten = /too long/.test(q.prompt);
    const data = { items: items.map((it) => ({ i: it.i, text: "п".repeat(shorten ? Math.max(4, Math.floor(it.max_chars * 0.6)) : lengthOf(it)) })) };
    return { data, usage: { input_tokens: 100, output_tokens: 50 } as never, usd: 0.001, estimate: false, model: "fake-llm", provider: "mock" as const };
  };
}

/** TTS stub: 15 characters per second of a tone; counts requests */
function fakeTts(batches: string[][]): TtsBatchFn {
  return async (lines) => {
    batches.push(lines);
    return { clips: lines.map((l) => tone(l.length / 15)), engine: "gemini", model: "fake-tts", requests: 1, cached: 0, warnings: [], chars: lines.join("").length };
  };
}

const naiveStretch = async (c: { pcm: Int16Array; rate: number }, speed: number) => ({ pcm: c.pcm.slice(0, Math.round(c.pcm.length / speed)), rate: c.rate });

test("dubVideo: phrases → translation (budget per phrase, chunks) → TTS in batches → fitted, sped up, one shorter re-translation → track + SRT + mix; a re-run costs nothing", async () => {
  const video = path.join(await tmp(), "podcast.mp4");
  await fs.writeFile(video, "fake");
  // 25 phrases of 2 s with 0.5 s pauses; phrase 7 gets a translation far too long for its time
  const phrases = Array.from({ length: 25 }, (_, k) => ph(k, k * 2.5, k * 2.5 + 2, `english phrase number ${k}`));
  const calls: StructuredQuery[] = [];
  const batches: string[][] = [];
  const mixes: MixArgs[] = [];
  const events: string[] = [];
  const llm = fakeLlm(calls, (it) => (it.i === 7 ? it.max_chars * 3 : Math.round(it.max_chars * 0.8)));
  const o = {
    lang: "ru",
    voice: "gemini_charon",
    phrases,
    batch: 10,
    llm,
    tts: fakeTts(batches),
    stretch: naiveStretch,
    probe: async () => ({ duration: 64, hasAudio: true }),
    mux: async (a: MixArgs) => {
      mixes.push(a);
      await fs.writeFile(a.out, "dubbed");
    },
    onEvent: (l: string) => events.push(l),
  };
  process.env.VEDIT_DUB_CHUNK = "10";
  const r = await dubVideo(video, o);
  delete process.env.VEDIT_DUB_CHUNK;
  // translation: 25 phrases in chunks of 10 → 3 calls, then 1 shorten call
  assert.equal(calls.filter((c) => !/too long/.test(c.prompt)).length, 3);
  assert.equal(calls.filter((c) => /too long/.test(c.prompt)).length, 1);
  assert.match(calls[0].prompt, /"max_chars":\d+/);
  assert.match(calls[0].system, /voice-over dub/);
  // TTS: 25 phrases / 10 per request → 3 batches, + 1 for the shortened phrase
  assert.deepEqual(batches.map((b) => b.length), [10, 10, 5, 1]);
  const rep = DubReportSchema.parse(JSON.parse(await fs.readFile(path.join(jobDir(r.jobId), "dub_full_ru.json"), "utf8")));
  assert.equal(rep.label, "Неофициальный перевод");
  assert.equal(rep.phrases, 25);
  assert.equal(rep.shortened, 1);
  assert.equal(rep.tts.batches, 4);
  assert.equal(rep.engine, "gemini");
  assert.ok(rep.cost.translate_usd > 0 && rep.cost.per_minute_usd > 0);
  assert.ok(rep.fit.max_speed <= 1.25);
  // the mix got the track, the SRT and duck ranges; the SRT has a cue per phrase at the phrase start
  assert.equal(mixes.length, 1);
  assert.equal(mixes[0].mode, "voiceover");
  assert.ok(mixes[0].ranges.length >= 1);
  const srt = await fs.readFile(r.srt!, "utf8");
  assert.equal((srt.match(/-->/g) ?? []).length, 25);
  assert.match(srt, /^1\n00:00:00,000 --> /);
  assert.match(srt, /\n8\n00:00:17,500 --> /, "phrase 7 starts at 17.5 s");
  assert.ok(events.some((e) => /^▸ озвучка 1\/3/.test(e)) && events.some((e) => /^▸ перевод фраз 1–10 из 25/.test(e)));
  // placements on disk: every phrase starts at its own start (re-sync)
  // (the voice dir is clips_gemini_charon with a Google key, clips_dmitri without one)
  const work = path.join(jobDir(r.jobId), "dub_full_ru");
  const clipsDir = (await fs.readdir(work)).find((d) => d.startsWith("clips_"))!;
  const placed = JSON.parse(await fs.readFile(path.join(work, clipsDir, "placements.json"), "utf8")) as Record<string, { start: number }>;
  for (const p of phrases) assert.equal(placed[String(p.i)].start, p.start);

  // the same job again (another mode): translations and clips are reused — no model, no TTS
  const before = { calls: calls.length, batches: batches.length };
  const r2 = await dubVideo(video, { ...o, jobId: r.jobId, mode: "replace" });
  assert.equal(calls.length, before.calls, "translations from the cache");
  assert.equal(batches.length, before.batches, "clips reused");
  assert.equal(mixes.at(-1)!.mode, "replace");
  assert.equal(r2.report.tts.requests, 0);
});

test("dubVideo without phrases runs speech recognition (stubbed) and keeps the transcript; empty speech is an error", async () => {
  const video = path.join(await tmp(), "clip.mp4");
  await fs.writeFile(video, "fake");
  const llm = fakeLlm([], (it) => Math.round(it.max_chars * 0.5));
  let asked = 0;
  const asr = async () => (asked++, { language: "en", segments: [{ start: 0.5, end: 2, text: "Hello there.", words: [], lang: "en" }, { start: 3, end: 4, text: "   ", words: [] }, { start: 5, end: 6.5, text: "Bye now.", words: [], lang: "en" }] });
  const r = await dubVideo(video, { lang: "ru", llm, asr, tts: fakeTts([]), stretch: naiveStretch, probe: async () => ({ duration: 8, hasAudio: true }), mux: async (a) => void (await fs.writeFile(a.out, "x")) });
  assert.equal(asked, 1);
  assert.equal(r.report.phrases, 2, "the blank segment is dropped");
  assert.ok(await fs.stat(path.join(jobDir(r.jobId), "transcript.json")));
  // the job's transcript is reused for the full video next time
  await dubVideo(video, { lang: "en", jobId: r.jobId, llm, asr, tts: fakeTts([]), stretch: naiveStretch, probe: async () => ({ duration: 8, hasAudio: true }), mux: async (a) => void (await fs.writeFile(a.out, "x")) });
  assert.equal(asked, 1);
  await assert.rejects(dubVideo(video, { lang: "ru", llm, asr: async () => ({ language: "en", segments: [] }), tts: fakeTts([]), probe: async () => ({ duration: 8, hasAudio: true }), mux: async () => {} }), /нечего озвучивать/);
  assert.deepEqual(phrasesFromTranscript({ language: "en", segments: [{ start: 2, end: 1, text: "x", words: [] }] })[0].end, 2.2);
});

test("dubJobOutputs: every reel of a job → output_<id>_<lang>.mp4 (a reel without a plan is transcribed)", async () => {
  const job = await createJob(path.join(await tmp(), "src.mp4"));
  for (const id of ["reel_1", "reel_2"]) await fs.writeFile(path.join(jobDir(job.id), `output_${id}.mp4`), "mp4");
  const llm = fakeLlm([], (it) => Math.round(it.max_chars * 0.5));
  const asr = async () => ({ language: "en", segments: [{ start: 0, end: 2, text: "One line.", words: [], lang: "en" }] });
  const rs = await dubJobOutputs(job.id, { lang: "ru", llm, asr, tts: fakeTts([]), stretch: naiveStretch, probe: async () => ({ duration: 5, hasAudio: true }), mux: async (a) => void (await fs.writeFile(a.out, "x")) });
  assert.deepEqual(rs.map((r) => path.basename(r.out)).sort(), ["output_reel_1_ru.mp4", "output_reel_2_ru.mp4"]);
  // the dubbed copies are not dubbed again
  const again = await dubJobOutputs(job.id, { lang: "ru", llm, asr, tts: fakeTts([]), stretch: naiveStretch, probe: async () => ({ duration: 5, hasAudio: true }), mux: async (a) => void (await fs.writeFile(a.out, "x")) });
  assert.equal(again.length, 2);
});
