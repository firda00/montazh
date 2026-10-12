import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgyVisionProvider, AGY_JSON_SCHEMA, buildAgyPrompt, extractJson, parseAgyStream, toJsonSchema, type AgyRunner } from "../src/understand/vision/agy.ts";
import type { AnalysisChunk, AnalysisContext } from "../src/understand/vision/types.ts";
import { ScenesSchema, type Media } from "../src/schemas/index.ts";

const media = { duration: 10, fps: 30, width: 1920, height: 1080, normalized_path: "n.mp4" } as Media;
const ctx: AnalysisContext = { media, language: "ru", loudness: [] };

test("toJsonSchema strips Gemini-only keys and turns nullable into a type union", () => {
  const s = AGY_JSON_SCHEMA as { properties: { scenes: { items: { properties: Record<string, { type: unknown }>; propertyOrdering?: unknown } } } };
  assert.equal(s.properties.scenes.items.propertyOrdering, undefined);
  assert.deepEqual(s.properties.scenes.items.properties.focus_x.type, ["number", "null"]);
  assert.equal(s.properties.scenes.items.properties.shot.type, "integer");
  assert.ok(!JSON.stringify(AGY_JSON_SCHEMA).includes("nullable"));
  assert.deepEqual(toJsonSchema({ a: [{ nullable: true, type: "string" }] }), { a: [{ type: ["string", "null"] }] });
});

test("parseAgyStream takes the final result event; plain json output also works", () => {
  const out = [
    '{"event":"init","init":{"model":"x"}}',
    '{"event":"step_update","step_update":{"text_delta":"{"}}',
    '{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"{\\"scenes\\":[]}","usage":{"input_tokens":5,"output_tokens":2}}}',
    "",
  ].join("\r\n");
  const r = parseAgyStream(out);
  assert.equal(r.status, "SUCCESS");
  assert.equal(r.response, '{"scenes":[]}');
  assert.equal(parseAgyStream('{"conversation_id":"c","status":"ERROR","response":"","error":"boom"}').error, "boom");
  assert.throws(() => parseAgyStream("nothing here"), /no result line/);
});

test("extractJson accepts bare, fenced and prose-wrapped JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n```json\n{"a":2}\n```\nDone.'), { a: 2 });
  assert.deepEqual(extractJson('I looked at the frames. {"a":3} That is all.'), { a: 3 });
  assert.throws(() => extractJson("no json at all"), /not JSON/);
});

async function framesDir() {
  const job = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-agy-"));
  const dir = path.join(job, "frames");
  await fs.mkdir(dir);
  const f3 = path.join(dir, "shot_003.jpg");
  const f4 = path.join(dir, "shot_004.jpg");
  await fs.writeFile(f3, "jpg");
  await fs.writeFile(f4, "jpg");
  return { job, dir, f3, f4 };
}

test("AgyVisionProvider: runs the CLI in the frames dir with the schema file, feeds the prompt on stdin, maps the answer, logs subscription usage", async () => {
  const { job, dir, f3, f4 } = await framesDir();
  const chunk: AnalysisChunk = {
    index: 2,
    start: 4,
    end: 10,
    shots: [
      { index: 3, start: 3, end: 6, cut_score: 0.3, frame: f3 },
      { index: 4, start: 6, end: 10, cut_score: 0.5, frame: f4 },
    ],
    phrases: [{ start: 5, end: 7, text: "Секрет плова.", words: [] }],
  };
  const calls: { args: string[]; stdin: string; cwd: string; schema: unknown }[] = [];
  const run: AgyRunner = async (args, stdin, cwd) => {
    const schemaFile = args[args.indexOf("--json-schema") + 1];
    calls.push({ args, stdin, cwd, schema: JSON.parse(await fs.readFile(schemaFile, "utf8")) });
    const answer = {
      scenes: [
        { shot: 3, description: "Cook stirs the kazan", objects: ["kazan"], people_count: 1, emotion: "focused", shot_type: "medium", quality_score: 0.8, focus_x: 0.6, focus_y: 0.4 },
        { shot: 4, description: "Rice close-up", objects: ["rice"], people_count: 0, emotion: "none", shot_type: "close-up", quality_score: 0.9, focus_x: null, focus_y: null },
      ],
      highlights: [{ start: 1, end: 3, reason: "секрет плова", score: 0.7 }],
    };
    const result = { conversation_id: "c", status: "SUCCESS", response: JSON.stringify(answer), duration_seconds: 42.5, usage: { input_tokens: 30000, output_tokens: 400, thinking_tokens: 100 } };
    return { code: 0, stdout: `{"event":"init","init":{}}\n{"event":"result","result":${JSON.stringify(result)}}\n`, stderr: "" };
  };
  const p = new AgyVisionProvider({ run, tmpDir: job, model: "gemini-3.8-flash-low" });
  const r = await p.analyze(chunk, ctx);

  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.cwd, dir, "the agent is started inside the frames directory");
  assert.deepEqual(c.args.slice(0, 2), ["--model", "gemini-3.8-flash-low"]);
  assert.ok(c.args.includes("--input-format") && c.args.includes("stream-json"));
  assert.deepEqual(c.schema, AGY_JSON_SCHEMA);
  const msg = JSON.parse(c.stdin.trim()) as { event: string; message: { role: string; content: { type: string; text: string }[] } };
  assert.equal(msg.event, "user");
  assert.equal(msg.message.content[0].type, "text");
  const prompt = msg.message.content[0].text;
  assert.match(prompt, /shot 3: 0-2s, frame: shot_003\.jpg/);
  assert.match(prompt, /shot 4: 2-6s, frame: shot_004\.jpg/);
  assert.match(prompt, /1-3s: Секрет плова\./);
  assert.match(prompt, /VIEW EVERY FRAME FILE/);

  ScenesSchema.parse(r.scenes);
  assert.equal(r.scenes.length, 2);
  assert.deepEqual([r.scenes[0].start, r.scenes[0].end], [4, 6]);
  assert.deepEqual(r.scenes[0].focus, { x: 0.6, y: 0.4 });
  assert.equal(r.scenes[1].focus, undefined);
  assert.deepEqual(r.highlights, [{ start: 5, end: 7, reason: "секрет плова", score: 0.7 }]);
  assert.equal(r.cost.usd, 0);
  assert.equal(r.cost.model, "gemini-3.8-flash-low");
  assert.deepEqual(r.cost.units, { chunk_seconds: 6, frames: 2, input_tokens: 30000, output_tokens: 500, wall_seconds: 42.5, subscription: 1 });
  const left = (await fs.readdir(job)).filter((f) => f.startsWith("vedit-agy-schema-"));
  assert.deepEqual(left, [], "schema file removed");
  await fs.rm(job, { recursive: true, force: true });
});

test("AgyVisionProvider: CLI errors, non-JSON answers and missing frames surface as errors", async () => {
  const { job, f3 } = await framesDir();
  const chunk: AnalysisChunk = { index: 0, start: 0, end: 6, shots: [{ index: 3, start: 0, end: 6, cut_score: 0, frame: f3 }], phrases: [] };
  const errRun: AgyRunner = async () => ({ code: 1, stdout: '{"event":"result","result":{"status":"ERROR","response":"","error":"token expired"}}\n', stderr: "" });
  await assert.rejects(() => new AgyVisionProvider({ run: errRun, tmpDir: job }).analyze(chunk, ctx), /ERROR: token expired/);
  const proseRun: AgyRunner = async () => ({ code: 0, stdout: '{"event":"result","result":{"status":"SUCCESS","response":"I could not open the files."}}\n', stderr: "" });
  await assert.rejects(() => new AgyVisionProvider({ run: proseRun, tmpDir: job }).analyze(chunk, ctx), /not JSON/);
  const noFrames: AnalysisChunk = { ...chunk, shots: [{ index: 3, start: 0, end: 6, cut_score: 0 }] };
  await assert.rejects(() => new AgyVisionProvider({ run: proseRun, tmpDir: job }).analyze(noFrames, ctx), /no shot frames/);
  await fs.rm(job, { recursive: true, force: true });
});

test("buildAgyPrompt marks shots without a frame", () => {
  const chunk: AnalysisChunk = { index: 0, start: 0, end: 3, shots: [{ index: 0, start: 0, end: 3, cut_score: 0 }], phrases: [] };
  assert.match(buildAgyPrompt(chunk, ctx, []), /shot 0: 0-3s, \(no frame\)/);
});
