import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { parseTimestamp, mapChunkEvents, dedupeEvents, planEventChunks, detectEvents, hoopFromAnswer, hoopAt } = await import("../src/understand/events.ts");
const { GeminiClient, retryDelayMs, isModelUnavailable } = await import("../src/understand/gemini-client.ts");
const { ballBlobs, classifyShot, medianBackground, onsetEnvelope, strongestOnset, roiForHoop } = await import("../src/understand/refine.ts");
const { selectHighlights, buildHighlightEdl, makeScore, streaks, applyDirection, outLen, zoomPoint, refill } = await import("../src/highlights/plan.ts");
const { highlightsIntent, wantsHighlights, parseHighlightsBrief, sportOf } = await import("../src/highlights/intent.ts");
const { beatGridFromEnvelope, nearestBeat } = await import("../src/audio/beats.ts");
const { buildCutArgs, zoomShakeFilter, flashFilter } = await import("../src/cut/index.ts");
const { buildMixGraph, duckFilter } = await import("../src/audio/mix.ts");
const { EdlSchema } = await import("../src/schemas/index.ts");
const { createJob } = await import("../src/lib/workspace.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
type SportEvent = import("../src/understand/events.ts").SportEvent;
type Media = import("../src/schemas/index.ts").Media;

// ---------------------------------------------------------------- events: parsing and conversion

test("parseTimestamp: MM:SS, MM:SS.s, H:MM:SS, plain seconds; garbage is NaN", () => {
  assert.equal(parseTimestamp("03:41.5"), 221.5);
  assert.equal(parseTimestamp("1:02:03"), 3723);
  assert.equal(parseTimestamp("12.5"), 12.5);
  assert.equal(parseTimestamp(7), 7);
  assert.ok(Number.isNaN(parseTimestamp("about 3 min")));
});

test("mapChunkEvents: chunk-relative → source time, clamped, key fallback, make/miss made consistent, bad times dropped", () => {
  const chunk = { index: 2, start: 960, end: 1440 };
  const r = mapChunkEvents(
    {
      hoop_x: 0.49,
      hoop_y: 0.51,
      events: [
        { start: "00:10", end: "00:13", key: "00:12.5", type: "shot_miss", outcome: "make", confidence: 0.9, quality: 0.7, distance: "long", ball_x: 0.5, ball_y: 0.52, speech: false, description: " Бросок " },
        { start: "07:58", end: "08:30", type: "people_approach", confidence: 0.8, speech: true, description: "Подходит парень" },
        { start: "soon", end: "later", type: "shot_make", description: "?" },
        { start: "01:00", end: "01:02", key: "05:00", type: "slam", confidence: 2, description: "" },
      ],
    },
    chunk,
  );
  assert.equal(r.dropped, 1);
  const [a, b, c] = r.events;
  assert.deepEqual([a.type, a.outcome, a.start, a.key, a.end], ["shot_make", "make", 970, 972.5, 973], "a miss with outcome make becomes a make");
  assert.deepEqual(a.target, { x: 0.5, y: 0.52 });
  assert.equal(a.description, "Бросок");
  assert.equal(b.type, "other", "unknown type");
  assert.equal(b.confidence, 1, "confidence clamped");
  assert.equal(b.key, 1021.4, "out-of-range key → 70 % of the event");
  assert.deepEqual([c.start, c.end, c.speech], [1438, 1440, true], "clamped to the chunk end");
});

test("dedupeEvents: same shot logged by two chunks at the seam → one, the more confident", () => {
  const ev = (id: string, key: number, confidence: number, type: SportEvent["type"] = "shot_make"): SportEvent => ({ id, type, outcome: "make", start: key - 2, end: key + 1, key, confidence, quality: 0.5, distance: "mid", description: id, target: null, speech: false, chunk: 0 });
  const out = dedupeEvents([ev("a", 100, 0.6), ev("b", 101, 0.9, "shot_miss"), ev("c", 110, 0.5)]);
  assert.deepEqual(out.map((e) => e.id), ["b", "c"]);
});

test("planEventChunks: equal chunks, last one ends at the duration", () => {
  const c = planEventChunks(3280.26, 480);
  assert.equal(c.length, 7);
  assert.equal(c[6].end, 3280.26);
  assert.ok(Math.abs(c[1].start - 468.61) < 0.01);
});

test("hoopFromAnswer: 0-1000 boxes normalised, rim derived from the box; hoopAt takes the latest sample", () => {
  const h = hoopFromAnswer(5, { found: true, x0: 457, y0: 510, x1: 525, y1: 545 });
  assert.deepEqual(h.box, { x0: 0.457, y0: 0.51, x1: 0.525, y1: 0.545 });
  assert.ok(h.rim && Math.abs(h.rim.x - 0.491) < 1e-9);
  assert.equal(hoopFromAnswer(5, { found: false }).found, false);
  const hs = [h, { ...h, t: 300, rim: { x: 0.6, y: 0.5 } }];
  assert.equal(hoopAt(hs, 100)!.t, 5);
  assert.equal(hoopAt(hs, 400)!.t, 300);
});

test("GeminiClient: 429 waits the server's retryDelay, a model without quota falls through to the next one", async () => {
  assert.equal(retryDelayMs('{"retryDelay": "37s"}'), 37000);
  assert.ok(isModelUnavailable(429, "Quota exceeded ... limit: 0, model: x"));
  assert.ok(!isModelUnavailable(429, "Resource exhausted"));
  const waits: number[] = [];
  let calls = 0;
  const fetchFn = (async (url: string) => {
    calls++;
    if (url.includes("model-a")) return new Response("quota limit: 0", { status: 429 });
    if (calls === 2) return new Response('{"error":{"details":[{"retryDelay":"3s"}]}}', { status: 429 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }), { status: 200 });
  }) as typeof fetch;
  const c = new GeminiClient({ apiKey: "k", fetchFn, sleep: async (ms) => void waits.push(ms) });
  const r = await c.generate(["model-a", "model-b"], { system: "s", parts: [{ text: "x" }], schema: {} });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(r.model, "model-b");
  assert.deepEqual(waits, [10000], "max(retryDelay 3 s, backoff 10 s)");
});

test("detectEvents: upload → generate → delete per chunk with a stubbed Gemini; answers cached; times converted", async () => {
  const src = path.resolve("tests/fixtures/timecode_60s_1080p25.mp4");
  const job = await createJob(src);
  const log: string[] = [];
  const answer = { hoop_x: 0.5, hoop_y: 0.4, events: [{ start: "00:05", end: "00:08", key: "00:07", type: "shot_make", outcome: "make", confidence: 0.8, quality: 0.6, distance: "mid", speech: false, description: "Бросок" }] };
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    log.push(`${init?.method ?? "GET"} ${u.replace(/^https:\/\/[^/]+/, "")}`);
    if (u.endsWith("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://up.test/u1" } });
    if (u === "https://up.test/u1") return new Response(JSON.stringify({ file: { name: "files/f1", uri: "https://files/f1", state: "ACTIVE", mimeType: "video/mp4" } }), { status: 200 });
    if (u.includes(":generateContent")) {
      const body = JSON.parse(String(init!.body));
      const isHoop = !!body.contents[0].parts[0].inline_data;
      const text = isHoop ? JSON.stringify({ found: true, x0: 0.45, y0: 0.38, x1: 0.55, y1: 0.45 }) : JSON.stringify(answer);
      if (!isHoop) assert.ok([2, 0.5].includes(body.contents[0].parts[0].video_metadata.fps));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 50 } }), { status: 200 });
    }
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const opts = { apiKey: "k", fetchFn, chunkSeconds: 30, models: ["m1"], hoopEvery: 100 };
  const r = await detectEvents(job.id, src, 60, opts);
  assert.equal(r.chunks.length, 2);
  assert.deepEqual(r.events.map((e) => e.key), [7, 37], "second chunk shifted by 30 s");
  assert.equal(log.filter((l) => l.startsWith("DELETE")).length, 2, "uploads deleted");
  assert.equal(r.hoops.length, 1);
  assert.equal(r.usage.input_tokens, 5000, "2 chunks × (main + people pass) + 1 still");
  const before = log.length;
  const again = await detectEvents(job.id, src, 60, opts);
  assert.equal(log.length, before, "second run: everything from the cache");
  assert.ok(again.chunks.every((c) => c.cached));
});

// ---------------------------------------------------------------- refinement: ball at the rim, audio transient

/** Synthetic ROI frames: beige background, a brown disk following `path` (one point per frame or null). */
function synthFrames(w: number, h: number, pts: ({ x: number; y: number } | null)[], r = 9): Buffer[] {
  return pts.map((p) => {
    const f = Buffer.alloc(w * h * 3);
    for (let i = 0; i < w * h; i++) (f[i * 3] = 200), (f[i * 3 + 1] = 196), (f[i * 3 + 2] = 190);
    if (p)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if ((x - p.x) ** 2 + (y - p.y) ** 2 <= r * r) {
            const k = (y * w + x) * 3;
            (f[k] = 110), (f[k + 1] = 70), (f[k + 2] = 50);
          }
    return f;
  });
}

const RIM = { cx: 100, ry: 100, rw: 40, netBottom: 135 };
const W = 200;
const H = 220;

test("classifyShot: a ball dropping through the ring is a make, the rim moment and the net moment are found", () => {
  // 60 fps: above → ring at frame 20 → inside the net → below
  const pts = Array.from({ length: 60 }, (_, i) => (i < 5 ? null : { x: 100 + (i < 20 ? (20 - i) * 1.5 : 0), y: 20 + i * 4 }));
  const frames = synthFrames(W, H, pts);
  const bg = medianBackground(synthFrames(W, H, [null, null, null]));
  const v = classifyShot(ballBlobs(frames, W, H, bg, RIM.rw), RIM, 60, [], 20);
  assert.equal(v.verdict, "make");
  assert.ok(v.rimFrame !== null && Math.abs(v.rimFrame - 18) <= 1, `rim frame ${v.rimFrame}`);
  assert.ok(v.throughFrame !== null && v.throughFrame > v.rimFrame!);
});

test("classifyShot: a ball that hits the ring and bounces out sideways is a miss", () => {
  const pts = Array.from({ length: 60 }, (_, i) => {
    if (i < 5) return null;
    if (i <= 20) return { x: 120, y: 20 + i * 4 };
    return { x: 120 + (i - 20) * 6, y: 100 - (i - 20) * 2 };
  });
  const frames = synthFrames(W, H, pts);
  const bg = medianBackground(synthFrames(W, H, [null]));
  const v = classifyShot(ballBlobs(frames, W, H, bg, RIM.rw), RIM, 60, [], 20);
  assert.equal(v.verdict, "miss");
  assert.equal(v.throughFrame, null);
});

test("ballBlobs ignores white (net) and blue (backboard) changes and person-sized blobs", () => {
  const f = synthFrames(W, H, [null])[0];
  for (let y = 120; y < 130; y++) for (let x = 90; x < 110; x++) f.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3); // white
  for (let y = 0; y < 200; y++) for (let x = 0; x < 60; x++) ((f[(y * W + x) * 3] = 120), (f[(y * W + x) * 3 + 1] = 80), (f[(y * W + x) * 3 + 2] = 60)); // big brown body
  const bg = medianBackground(synthFrames(W, H, [null]));
  assert.deepEqual(ballBlobs([f], W, H, bg, RIM.rw)[0], []);
});

test("roiForHoop: the ROI holds the rim with room above for the ball's approach", () => {
  const g = roiForHoop({ t: 0, found: true, box: { x0: 0.457, y0: 0.51, x1: 0.525, y1: 0.545 }, rim: { x: 0.491, y: 0.514 } }, 720, 1280)!;
  assert.ok(g.rim.cx > 0 && g.rim.cx < g.roi.w);
  assert.ok(g.rim.ry > 2.5 * g.rim.rw, "≥ 2.5 rim widths above the ring");
  assert.ok(g.roi.w % 2 === 0 && g.roi.h % 2 === 0);
});

test("audio transient: the onset is found within 10 ms of a synthetic rim clank", () => {
  const sr = 16000;
  const s = new Float32Array(sr * 3);
  for (let i = 0; i < s.length; i++) s[i] = 0.01 * Math.sin(i * 0.37); // quiet hum
  const at = 1.734;
  for (let i = Math.round(at * sr); i < Math.round((at + 0.08) * sr); i++) s[i] += 0.6 * Math.sin(i * 1.9) * Math.exp(-(i / sr - at) * 40);
  const env = onsetEnvelope(s, sr, 0.01);
  const t = strongestOnset(env, 0.01, 1.6, 0.5);
  assert.ok(t !== null && Math.abs(t - at) <= 0.011, `onset ${t}`);
  assert.equal(strongestOnset(env, 0.01, 0.5, 0.3), null, "nothing stands out in the hum");
});

// ---------------------------------------------------------------- selection and EDL

const hoops = [{ t: 0, found: true, box: { x0: 0.457, y0: 0.51, x1: 0.525, y1: 0.545 }, rim: { x: 0.49, y: 0.515 } }];
function shot(id: string, key: number, outcome: "make" | "miss", o: Partial<SportEvent> = {}): SportEvent {
  return {
    id,
    type: outcome === "make" ? "shot_make" : "shot_miss",
    outcome,
    start: key - 2,
    end: key + 1,
    key,
    confidence: 0.9,
    quality: 0.5,
    distance: "mid",
    description: `бросок ${id}`,
    target: null,
    speech: false,
    chunk: 0,
    refined: { key, method: "ball", motion_t: key, audio_t: null, motion_peak: outcome === "make" ? 0.85 : 0.8, net_motion: 0.2, local_verdict: outcome, through_t: outcome === "make" ? key + 0.1 : null, rolled: false },
    ...o,
  };
}

const events: SportEvent[] = [
  shot("m1", 30, "make"),
  shot("m2", 60, "make", { distance: "long", quality: 0.9 }),
  shot("x1", 80, "miss"),
  shot("m3", 100, "make"),
  shot("m4", 130, "make"),
  shot("m5", 160, "make"),
  shot("x2", 190, "miss"),
  shot("x3", 220, "miss"),
  shot("m6", 250, "make", { distance: "close" }),
  shot("m7", 280, "make"),
  shot("m8", 310, "make"),
  shot("m9", 340, "make"),
  shot("m10", 370, "make"),
  { id: "p1", type: "people_approach", outcome: "none", start: 400, end: 412, key: 405, confidence: 0.9, quality: 0.8, distance: "unknown", description: "подходят двое, просят покидать", target: null, speech: true, chunk: 0 },
];

test("streaks and scores: misses reset a streak; a long clean make outscores a close one", () => {
  const st = streaks(events);
  assert.equal(st.get("m1"), 1);
  assert.equal(st.get("m2"), 2);
  assert.equal(st.get("m3"), 1, "x1 reset the streak");
  assert.equal(st.get("m5"), 3);
  assert.ok(makeScore(events[1]) > makeScore(events[8]));
});

test("selectHighlights: the strongest make opens, the rest chronological; a social beat kept; no misses while makes suffice; length near the target", () => {
  const { picks, seconds } = selectHighlights(events, { target: 50, min: 45, max: 60 });
  assert.equal(picks[0].event.id, "m2", "long, high-quality make first");
  const rest = picks.slice(1).map((p) => p.event.start);
  assert.deepEqual(rest, [...rest].sort((a, b) => a - b));
  assert.ok(picks.some((p) => p.role === "social"));
  assert.ok(!picks.some((p) => p.role === "miss"));
  assert.ok(seconds >= 40 && seconds <= 60, `${seconds}`);
  assert.equal(picks.filter((p) => p.replay).length, 1);
  assert.ok(picks.find((p) => p.event.id === "m5")?.callout === "x3", "a streak of three gets a callout");
});

test("selectHighlights: with few makes, at most two misses fill in", () => {
  const few = events.filter((e) => e.outcome !== "make" || ["m1", "m2"].includes(e.id));
  const { picks, notes } = selectHighlights(few, { target: 50, min: 45, max: 60 });
  assert.ok(picks.filter((p) => p.role === "miss").length <= 2);
  assert.ok(notes.some((n) => /меньше цели/.test(n)));
});

test("buildHighlightEdl: lead 1× → slow 0.5× with a punch-in on the rim and a flash at the net moment → tail; impacts on beats", () => {
  const { picks } = selectHighlights(events, { target: 50, min: 45, max: 60 });
  const beats = Array.from({ length: 200 }, (_, i) => Math.round(i * 0.5 * 1000) / 1000); // 120 BPM
  const plan = buildHighlightEdl(picks, { hoops, frame: { width: 720, height: 1280 }, beats, title: "ВЕЧЕРНИЙ БАСКЕТ" });
  const out = plan.output;
  EdlSchema.parse({ outputs: [out] });
  const [lead, slowC, tail] = out.clips;
  assert.deepEqual([lead.speed, slowC.speed, tail.speed], [1, 0.5, 1]);
  assert.equal(slowC.zoom!.to, 1.9);
  assert.ok(Math.abs(slowC.zoom!.x - 0.49) < 0.01 && Math.abs(slowC.zoom!.y - 0.515) < 0.01, "zoom centred on the rim");
  assert.equal(slowC.volume, 0);
  assert.ok(out.clips.every((c) => c.hfr));
  // the net moment of every make lands on a beat (whole-frame rounding: within one frame)
  for (const t of plan.timeline.filter((x) => x.impact !== null && x.beat_aligned)) {
    const b = nearestBeat(beats, t.impact!, 0.25)!;
    assert.ok(Math.abs(b - t.impact!) <= 1 / 30 + 1e-6, `${t.id} impact ${t.impact} vs beat ${b}`);
  }
  assert.ok(plan.timeline.filter((x) => x.beat_aligned).length >= 5);
  assert.ok(out.sfx!.some((c) => c.kind === "swish") && out.sfx!.some((c) => c.kind === "whoosh"));
  assert.equal(out.titles[0].text, "ВЕЧЕРНИЙ БАСКЕТ");
  assert.ok(out.titles.some((t) => t.style === "callout"));
  // social: own audio, music ducks there, captions on
  const social = plan.timeline.find((t) => t.role === "social")!;
  assert.deepEqual(out.audio!.duck, [{ start: social.start, end: social.end }]);
  assert.equal(out.captions.enabled, true);
  // the timeline matches the cut's whole-frame clip lengths
  const total = out.clips.reduce((s, c) => s + outLen(c), 0);
  assert.ok(Math.abs(total - plan.timeline[plan.timeline.length - 1].end) < 0.002);
});

test("applyDirection: unknown ids ignored, at least four makes kept, title cleaned, opener moved first", () => {
  const { picks } = selectHighlights(events, { target: 50, min: 45, max: 60 });
  const r = applyDirection(picks, { title: "вечерний баскет 🏀 #hoops", opener: "m3", drop: ["m1", "m4", "m6", "m7", "m8", "m9", "zzz"], callouts: [{ id: "m3", text: "чистый" }, { id: "nope", text: "x" }], labels: [{ id: "p1", text: "Просят покидать 🏀" }], reasoning: "" });
  assert.equal(r.picks.find((p) => p.event.id === "p1")?.label, "Просят покидать");
  assert.equal(r.title, "ВЕЧЕРНИЙ БАСКЕТ");
  assert.equal(r.picks[0].event.id, "m3");
  assert.equal(r.picks[0].callout, "ЧИСТЫЙ");
  assert.ok(r.picks.filter((p) => p.role === "make").length >= 4);
});

test("zoomPoint maps a source point into the output crop (portrait source → 16:9 output)", () => {
  assert.deepEqual(zoomPoint({ x: 0.5, y: 0.5 }, { width: 720, height: 1280 }, "16:9"), { x: 0.5, y: 0.5 });
  const p = zoomPoint({ x: 0.49, y: 0.515 }, { width: 720, height: 1280 }, "9:16");
  assert.deepEqual(p, { x: 0.49, y: 0.515 });
});

// ---------------------------------------------------------------- beats

test("beat grid: 120 BPM impulse train with an offset phase", () => {
  const hop = 0.01;
  const env = new Array(3000).fill(0);
  for (let t = 0.23; t < 30; t += 0.5) env[Math.round(t / hop)] = 1;
  const g = beatGridFromEnvelope(env, 30, hop);
  assert.ok(Math.abs(g.bpm - 120) < 1.5, `bpm ${g.bpm}`);
  assert.ok(Math.abs(g.phase - 0.23) <= 0.011, `phase ${g.phase}`);
  assert.ok(g.strength > 0.3);
  assert.equal(nearestBeat(g.beats, 1.48, 0.15), null, "no beat within ±0.15 s of 1.48 (beats at 1.23, 1.73)");
  assert.ok(Math.abs(nearestBeat(g.beats, 1.3, 0.15)! - 1.23) < 0.02);
});

// ---------------------------------------------------------------- cut and mix with the effects

test("buildCutArgs: hfr clips read the original, zoom/shake/flash/volume land in the filter graph", () => {
  const media = { source_path: "orig.mp4", normalized_path: "norm.mp4", duration: 100, fps: 30, width: 720, height: 1280, has_audio: true, audio_path: null, source: { fps: 59.94, width: 720, height: 1280, video_codec: "h264", audio_codec: "aac", rotation: 0 } } as Media;
  const out = EdlSchema.parse({ outputs: [{ id: "h", aspect: "9:16", clips: [{ src_start: 1, src_end: 2, volume: 0.6, hfr: true }, { src_start: 2, src_end: 3, speed: 0.5, hfr: true, volume: 0, zoom: { x: 0.49, y: 0.515, from: 1, to: 1.6, ease: 0.45 }, flash: [1.2], shake: [1.2] }, { src_start: 3, src_end: 4 }] }] }).outputs[0];
  const args = buildCutArgs(out, out.clips, media, "o.mp4");
  const inputs = args.filter((_, i) => args[i - 1] === "-i");
  assert.deepEqual(inputs, ["orig.mp4", "orig.mp4", "norm.mp4"]);
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.match(fc, /eval=frame:flags=bicubic,crop=1080:1920/);
  assert.match(fc, /eq=brightness='0\.32\*exp/);
  assert.match(fc, /volume=0\.6/);
  assert.match(fc, /atempo=0\.5.*volume=0[,;]/s);
  assert.match(zoomShakeFilter("9:16", undefined, [0.5]), /scale=w='trunc\(1080\*1\.04\/2\)\*2'/, "a shake without zoom works at 1.04×");
  assert.match(flashFilter([0.1, 0.9]), /\+0\.32/);
});

test("animated punch-in renders: the frame size stays 1080×1920 while the zoom grows", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-zoom-"));
  const out = path.join(dir, "z.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=720x1280:r=60:d=1", "-vf", `scale=1080:1920,${zoomShakeFilter("9:16", { x: 0.5, y: 0.4, from: 1, to: 1.6, ease: 0.3, at: 0 }, [0.5])},${flashFilter([0.5])},fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "ultrafast", out]);
  const { ffprobe } = await import("../src/lib/ffmpeg.ts");
  const v = (await ffprobe(out)).streams.find((s) => s.codec_type === "video")!;
  assert.deepEqual([v.width, v.height], [1080, 1920]);
});

test("mix: music offset, court audio gain and volume-automated ducking for the people talking", () => {
  const g = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 50, music: "m.mp3", speech: false, musicOffset: 12.5, origGainDb: -2, duck: [{ start: 10, end: 16 }], sfx: [{ t: 3, kind: "swish" }] }, { hasAudio: true, sfxFile: (k) => `${k}.wav` });
  const a = g.args.join(" ");
  assert.match(a, /-stream_loop -1 -ss 12\.500 -i m\.mp3/);
  const fc = g.args[g.args.indexOf("-filter_complex") + 1];
  assert.match(fc, /volume=-2\.0dB\[orig\]/);
  assert.match(fc, /volume='1-0\.684\*min\(1,clip\(min\(\(t-9\.75\)\/0\.25,\(16\.25-t\)\/0\.25\),0,1\)\)':eval=frame\[mus\]/);
  assert.ok(!/sidechaincompress/.test(fc), "no side-chain pumping on every ball bounce");
  assert.equal(duckFilter([]), "");
});

// ---------------------------------------------------------------- intent

test("highlights intent: sport words are strong, 'лучшие моменты' is weak and needs a non-speech video", () => {
  assert.equal(highlightsIntent("есть одно видео, нужно смонтировать, как мы играем в баскет: нарезать отличные моменты"), "strong");
  assert.equal(highlightsIntent("нарезка лучших моментов баскетбола, музыка, акценты на бросках"), "strong");
  assert.equal(highlightsIntent("сделай хайлайты"), "weak");
  assert.equal(highlightsIntent("3 рилса по 30 секунд для кафе"), null);
  assert.equal(wantsHighlights("weak", 0.6), false, "a podcast's best moments stay a speech edit");
  assert.equal(wantsHighlights("weak", 0.1), true);
  assert.equal(wantsHighlights("weak", null), false);
  assert.equal(sportOf("футбол во дворе"), "football (soccer)");
  assert.deepEqual(parseHighlightsBrief("хайлайты на 45 секунд для ютуба, титр «ИГРА НА ДЕНЬГИ»"), { target: 45, aspect: "16:9", title: "ИГРА НА ДЕНЬГИ" });
  assert.equal(parseHighlightsBrief("на минуту").target, 60);
});

// ---------------------------------------------------------------- net swing, a ball on the ring, the scan

test("netSwing: the net moving after the ball went through vs a still net", async () => {
  const { netSwing, rolledOnRim } = await import("../src/understand/refine.ts");
  const still = synthFrames(W, H, Array.from({ length: 60 }, () => null));
  // the net region (ring → net bottom, ±0.45 rim widths) changes from frame 32 on
  const moving = still.map((f, i) => {
    if (i < 32) return f;
    const g = Buffer.from(f);
    for (let y = RIM.ry; y < RIM.netBottom; y++) for (let x = RIM.cx - 18; x < RIM.cx + 18; x += 2) g.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
    return g;
  });
  assert.ok(netSwing(moving, W, RIM, 20, 24, 60)! > 0.3);
  assert.equal(netSwing(still, W, RIM, 20, 24, 60), 0);
  // ball resting on the ring for 0.3 s
  const track = Array.from({ length: 40 }, (_, i) => ({ i, x: RIM.cx - 10, y: i < 10 ? RIM.ry - 40 + i * 4 : RIM.ry - 12, n: 200 }));
  assert.equal(rolledOnRim(track, RIM, 60), true);
  assert.equal(rolledOnRim(track.slice(0, 12), RIM, 60), false);
});

test("scanWindow: a ball dropping through the ring in an 8 s window is a make candidate at its rim time", async () => {
  const { scanWindow } = await import("../src/understand/scan.ts");
  const pts = Array.from({ length: 120 }, (_, i) => (i < 40 || i > 70 ? null : { x: 100, y: 20 + (i - 40) * 6 }));
  const c = scanWindow(synthFrames(W, H, pts), { x: 0, y: 0, w: W, h: H }, RIM, 30, 100);
  assert.equal(c.length, 1);
  assert.equal(c[0].verdict, "make");
  assert.ok(Math.abs(c[0].t - (100 + 53 / 30)) < 0.1, `${c[0].t}`);
});

test("isModelUnavailable: the free tier's daily quota counts as unavailable, a per-minute limit does not", () => {
  assert.ok(isModelUnavailable(429, '"quotaId": "GenerateRequestsPerDayPerProjectPerModel-FreeTier"'));
  assert.ok(isModelUnavailable(429, '"retryDelay": "46072s"'));
  assert.ok(!isModelUnavailable(429, '"retryDelay": "37s"'));
});

test("isJunkText: whisper loops and empty strings are not captions; real short questions are", async () => {
  const { isJunkText } = await import("../src/highlights/index.ts");
  assert.equal(isJunkText("Alakaba, nil lokat da usedo? Alakaba, nil lokat da usedo? Alakaba, nil lokat da usedo?"), true);
  assert.equal(isJunkText("I don't know, I don't know, I don't know."), true);
  assert.equal(isJunkText("..."), true);
  assert.equal(isJunkText("Можно с вами покидать мяч?"), false);
});

test("refill: after the editor dropped makes, the selection is topped up to the target without overlaps", () => {
  const { picks } = selectHighlights(events, { target: 50, min: 45, max: 60 });
  const cut = picks.filter((p, i) => i === 0 || p.role !== "make" || i % 2 === 0);
  const r = refill(cut, events, { target: 50, max: 60, exclude: new Set(["m1"]) });
  assert.ok(r.length > cut.length);
  assert.ok(!r.some((p) => p.event.id === "m1"));
  assert.equal(r[0].event.id, cut[0].event.id, "the opener stays first");
});
