import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GeminiVisionProvider, buildPrompt, mapAnswer, priceUsage, DEFAULT_GEMINI_MODEL } from "../src/understand/vision/gemini.ts";
import { selectVisionProvider } from "../src/understand/vision/index.ts";
import type { AnalysisChunk, AnalysisContext } from "../src/understand/vision/types.ts";
import { ScenesSchema, HighlightsSchema, type Media } from "../src/schemas/index.ts";
import { ffmpeg } from "../src/lib/ffmpeg.ts";
import { clipFocus, cropScaleFilter, buildCutArgs } from "../src/cut/index.ts";

const media = { duration: 6, fps: 30, width: 1920, height: 1080, normalized_path: "n.mp4" } as Media;
const chunk: AnalysisChunk = {
  index: 1,
  start: 2,
  end: 6,
  shots: [
    { index: 3, start: 1.5, end: 3, cut_score: 0.3 },
    { index: 4, start: 3, end: 6, cut_score: 0.5 },
  ],
  phrases: [{ start: 2.2, end: 4, text: "Добро пожаловать.", words: [] }],
};
const ctx: AnalysisContext = { media, language: "ru", loudness: [] };

test("prompt lists shots and phrases in clip-relative time", () => {
  const p = buildPrompt(chunk, ctx);
  assert.match(p, /starts at 2s of the original/);
  assert.match(p, /3: 0-1s/, "shot 3 is clamped to the chunk and shifted");
  assert.match(p, /4: 1-4s/);
  assert.match(p, /0\.2-2s: Добро пожаловать\./);
  assert.match(p, /focus_x/);
});

test("mapAnswer: one scene per shot, missing shots stay honest, focus clamped, highlights shifted and clamped", () => {
  const r = mapAnswer(
    {
      scenes: [{ shot: 4, description: " Cook at the stove ", objects: ["pan", " ", "rice"], people_count: 1.4, emotion: "calm", shot_type: "medium", quality_score: 1.7, focus_x: 0.8, focus_y: -0.2 }],
      highlights: [
        { start: -1, end: 2.5, reason: "intro", score: 0.9 },
        { start: 3, end: 9, reason: "payoff", score: 2 },
        { start: 1, end: 1.2, reason: "too short", score: 0.5 },
      ],
    },
    chunk,
  );
  ScenesSchema.parse(r.scenes);
  HighlightsSchema.parse(r.highlights);
  assert.equal(r.scenes.length, 2);
  assert.deepEqual([r.scenes[0].start, r.scenes[0].end], [2, 3], "shot 3 clipped to the chunk");
  assert.match(r.scenes[0].description, /not described/);
  assert.equal(r.scenes[0].focus, undefined);
  assert.equal(r.scenes[1].description, "Cook at the stove");
  assert.deepEqual(r.scenes[1].objects, ["pan", "rice"]);
  assert.equal(r.scenes[1].people_count, 1);
  assert.equal(r.scenes[1].quality_score, 1);
  assert.deepEqual(r.scenes[1].focus, { x: 0.8, y: 0 });
  assert.deepEqual(r.highlights.map((h) => [h.start, h.end, h.score]), [[2, 4.5, 0.9], [5, 6, 1]]);
});

test("priceUsage: known models priced from the table, unknown ones unpriced", () => {
  const p = priceUsage(DEFAULT_GEMINI_MODEL, { promptTokenCount: 1_000_000, candidatesTokenCount: 500_000, thoughtsTokenCount: 500_000 });
  assert.equal(p.priced, true);
  assert.ok(Math.abs(p.usd - 0.5) < 1e-9);
  assert.deepEqual(priceUsage("gemini-9-ultra", { promptTokenCount: 10 }), { usd: 0, priced: false });
});

test("selectVisionProvider: key → gemini, agy on PATH → antigravity-cli, neither → stub; explicit choices fail loudly", async () => {
  const noAgy = { agy: async () => null };
  const agy = { agy: async () => "C:/agy/agy.exe" };
  assert.equal((await selectVisionProvider("auto", {}, noAgy)).provider.name, "stub");
  await assert.rejects(() => selectVisionProvider("gemini", {}, noAgy), /GEMINI_API_KEY/);
  await assert.rejects(() => selectVisionProvider("agy", {}, noAgy), /agy/);
  const g = await selectVisionProvider("auto", { GEMINI_API_KEY: "k", VEDIT_VISION_MODEL: "gemini-2.5-flash", VEDIT_VISION_RESOLUTION: "low" }, agy);
  assert.equal(g.provider.name, "gemini", "the API key wins over the CLI");
  assert.match(g.note, /gemini-2\.5-flash, low res/);
  await assert.rejects(() => selectVisionProvider("auto", { GEMINI_API_KEY: "k", VEDIT_VISION_RESOLUTION: "huge" }, agy), /VEDIT_VISION_RESOLUTION/);
  const a = await selectVisionProvider("auto", {}, agy);
  assert.equal(a.provider.name, "antigravity-cli");
  assert.match(a.note, /gemini-3\.8-flash-low/);
  assert.equal((await selectVisionProvider("auto", { VEDIT_VISION: "stub", GEMINI_API_KEY: "k" }, agy)).provider.name, "stub", "VEDIT_VISION overrides auto");
  assert.equal((await selectVisionProvider("auto", { VEDIT_VISION: "agy", GEMINI_API_KEY: "k", VEDIT_VISION_MODEL: "gemini-3.1-pro-low" }, agy)).note, "vision: antigravity-cli (gemini-3.1-pro-low, вход Google, без ключа)");
  await assert.rejects(() => selectVisionProvider("auto", { VEDIT_VISION: "nope" }, agy), /VEDIT_VISION/);
});

const answer = {
  scenes: [
    { shot: 0, description: "Colour bars", objects: ["bars"], people_count: 0, emotion: "none", shot_type: "screen", quality_score: 0.4, focus_x: null, focus_y: null },
  ],
  highlights: [{ start: 0.5, end: 2, reason: "pattern", score: 0.3 }],
};
const okJson = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

async function makeClipSource(dir: string) {
  const src = path.join(dir, "src.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=3", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", src]);
  return src;
}

test("GeminiVisionProvider: inline request shape, structured answer mapped, cost logged, temp clip removed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-gem-"));
  const src = await makeClipSource(dir);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 100, thoughtsTokenCount: 50 } });
  }) as typeof fetch;
  const p = new GeminiVisionProvider({ apiKey: "secret-key", fetchFn, tmpDir: dir, mediaResolution: "low" });
  const c: AnalysisChunk = { index: 0, start: 0.5, end: 2.5, shots: [{ index: 0, start: 0, end: 3, cut_score: 0 }], phrases: [] };
  const r = await p.analyze(c, { media: { ...media, normalized_path: src, duration: 3 }, language: "unknown", loudness: [] });

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, new RegExp(`/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent$`));
  assert.equal((calls[0].init.headers as Record<string, string>)["x-goog-api-key"], "secret-key");
  const body = JSON.parse(String(calls[0].init.body)) as { contents: { parts: Record<string, unknown>[] }[]; generationConfig: Record<string, unknown> };
  const [mediaPart, textPart] = body.contents[0].parts;
  assert.equal((mediaPart.inline_data as { mime_type: string }).mime_type, "video/mp4");
  assert.ok(((mediaPart.inline_data as { data: string }).data ?? "").length > 1000, "base64 clip is attached");
  assert.match(String(textPart.text), /This clip is 2 seconds/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.mediaResolution, "MEDIA_RESOLUTION_LOW");
  assert.ok(body.generationConfig.responseSchema);

  assert.equal(r.scenes.length, 1);
  assert.deepEqual([r.scenes[0].start, r.scenes[0].end], [0.5, 2.5]);
  assert.equal(r.scenes[0].description, "Colour bars");
  assert.equal(r.scenes[0].focus, undefined);
  assert.deepEqual(r.highlights, [{ start: 1, end: 2.5, reason: "pattern", score: 0.3 }]);
  assert.equal(r.cost.model, DEFAULT_GEMINI_MODEL);
  assert.ok(Math.abs(r.cost.usd - (1200 * 0.1 + 150 * 0.4) / 1e6) < 1e-12);
  assert.deepEqual(r.cost.units, { chunk_seconds: 2, input_tokens: 1200, output_tokens: 150 });
  const left = (await fs.readdir(dir)).filter((f) => f.startsWith("vedit-gemini-"));
  assert.deepEqual(left, [], "temporary clip is deleted");
  await fs.rm(dir, { recursive: true, force: true });
});

test("GeminiVisionProvider: large clips go through the Files API (start → upload → poll → generate → delete); API errors surface", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-gem-"));
  const src = await makeClipSource(dir);
  const seq: string[] = [];
  let polls = 0;
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    seq.push(`${method} ${u.replace(/^https?:\/\/[^/]+/, "")}`);
    if (u.endsWith("/upload/v1beta/files") && method === "POST") {
      const h = init?.headers as Record<string, string>;
      assert.equal(h["X-Goog-Upload-Protocol"], "resumable");
      assert.equal(h["X-Goog-Upload-Header-Content-Type"], "video/mp4");
      return okJson({}, { "x-goog-upload-url": "https://files.test/session-1" });
    }
    if (u === "https://files.test/session-1") {
      assert.equal((init?.headers as Record<string, string>)["X-Goog-Upload-Command"], "upload, finalize");
      assert.ok((init?.body as Uint8Array).byteLength > 1000);
      return okJson({ file: { name: "files/abc", uri: "https://files.test/v1beta/files/abc", state: "PROCESSING", mimeType: "video/mp4" } });
    }
    if (u.endsWith("/v1beta/files/abc") && method === "GET") {
      polls++;
      return okJson({ name: "files/abc", uri: "https://files.test/v1beta/files/abc", state: polls >= 2 ? "ACTIVE" : "PROCESSING", mimeType: "video/mp4" });
    }
    if (u.includes(":generateContent")) {
      const body = JSON.parse(String(init?.body)) as { contents: { parts: Record<string, unknown>[] }[] };
      assert.deepEqual(body.contents[0].parts[0], { file_data: { mime_type: "video/mp4", file_uri: "https://files.test/v1beta/files/abc" } });
      return okJson({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
    }
    if (u.endsWith("/v1beta/files/abc") && method === "DELETE") return okJson({});
    throw new Error(`unexpected request ${method} ${u}`);
  }) as typeof fetch;
  const p = new GeminiVisionProvider({ apiKey: "k", fetchFn, tmpDir: dir, inlineMaxBytes: 0, pollMs: 1 });
  const c: AnalysisChunk = { index: 0, start: 0, end: 3, shots: [{ index: 0, start: 0, end: 3, cut_score: 0 }], phrases: [] };
  const r = await p.analyze(c, { media: { ...media, normalized_path: src, duration: 3 }, language: "unknown", loudness: [] });
  assert.equal(r.scenes[0].description, "Colour bars");
  assert.deepEqual(seq, [
    "POST /upload/v1beta/files",
    "POST /session-1",
    "GET /v1beta/files/abc",
    "GET /v1beta/files/abc",
    `POST /v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`,
    "DELETE /v1beta/files/abc",
  ]);

  const failing = new GeminiVisionProvider({ apiKey: "k", tmpDir: dir, fetchFn: (async () => new Response("quota", { status: 429, statusText: "Too Many Requests" })) as typeof fetch });
  await assert.rejects(() => failing.analyze(c, { media: { ...media, normalized_path: src, duration: 3 }, language: "unknown", loudness: [] }), /Gemini 429/);
  const garbage = new GeminiVisionProvider({ apiKey: "k", tmpDir: dir, fetchFn: (async () => okJson({ candidates: [{ content: { parts: [{ text: "not json" }] } }] })) as typeof fetch });
  await assert.rejects(() => garbage.analyze(c, { media: { ...media, normalized_path: src, duration: 3 }, language: "unknown", loudness: [] }), /not the expected JSON/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("auto_face: crop follows the overlap-weighted focus of the scenes a clip spans; ffmpeg accepts the expression", async () => {
  const scenes = ScenesSchema.parse([
    { start: 0, end: 2, description: "a", objects: [], people_count: 1, emotion: "x", shot_type: "medium", quality_score: 0.5, focus: { x: 0.2, y: 0.5 } },
    { start: 2, end: 4, description: "b", objects: [], people_count: 1, emotion: "x", shot_type: "medium", quality_score: 0.5, focus: { x: 1, y: 0.3 } },
    { start: 4, end: 6, description: "c", objects: [], people_count: 0, emotion: "x", shot_type: "wide", quality_score: 0.5 },
  ]);
  const f = clipFocus({ src_start: 1, src_end: 4 }, scenes)!;
  assert.ok(Math.abs(f.x - (0.2 * 1 + 1 * 2) / 3) < 1e-9);
  assert.ok(Math.abs(f.y - (0.5 * 1 + 0.3 * 2) / 3) < 1e-9);
  assert.equal(clipFocus({ src_start: 4, src_end: 6 }, scenes), null, "no focus in the shots → centre crop");

  assert.ok(!/crop=[^,]*:[^,]*:/.test(cropScaleFilter("9:16")), "centre crop has no offset");
  const vf = cropScaleFilter("9:16", { x: 1, y: 0.5 });
  assert.match(vf, /crop=[^:]+:[^:]+:trunc\(clip\(iw\*1\.0000-ow\/2\\,0\\,iw-ow\)\/2\)\*2:trunc\(clip\(ih\*0\.5000-oh\/2\\,0\\,ih-oh\)\/2\)\*2,scale=1080:1920/);

  // only the auto_face clip gets the offset
  const clips = [
    { src_start: 0, src_end: 1, speed: 1, crop: "auto_face" as const },
    { src_start: 1, src_end: 2, speed: 1, crop: "center" as const },
  ];
  const args = buildCutArgs({ id: "a", aspect: "9:16", clips, captions: { enabled: false }, titles: [], music: { enabled: false }, transitions: "cut" }, clips, media, "out.mp4", [{ x: 1, y: 0.5 }, { x: 0, y: 0 }]);
  const fc = args[args.indexOf("-filter_complex") + 1];
  assert.equal((fc.match(/clip\(iw/g) ?? []).length, 1);

  // the expression is valid ffmpeg: a 16:9 source cropped to 9:16 around the right edge keeps the rightmost columns
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-face-"));
  const out = path.join(dir, "o.png");
  // testsrc2 is black-ish on the left and has a bright block top-right; crop at x=1 must differ from the centre crop
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1:duration=1", "-vf", cropScaleFilter("9:16", { x: 1, y: 0.5 }), "-frames:v", "1", out]);
  const outC = path.join(dir, "c.png");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1:duration=1", "-vf", cropScaleFilter("9:16"), "-frames:v", "1", outC]);
  assert.notDeepEqual(await fs.readFile(out), await fs.readFile(outC));
  await fs.rm(dir, { recursive: true, force: true });
});
