// Stage 29: no lock-in to Claude — Gemini planner backend (function-calling tool loop, repair rounds, model
// fallback, cost), Gemini StructuredFn (schema conversion, repair retry, JSON-mode fallback), provider selection
// (VEDIT_LLM / VEDIT_LLM_<STEP>), Claude → Gemini fallback. Offline: every request goes to a stubbed fetch.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s29llm-ws-"));

const { toGeminiSchema, reviveEncoded, geminiTextUsd, geminiUsage, servedModel, priceFor, generateWithFallback, plannerModels, textModels, thinkingLevel } = await import("../src/lib/gemini-llm.ts");
const { resolveLlmProvider, llmChoice, isProviderFailure, fallbackEnabled } = await import("../src/lib/llm-provider.ts");
const { makeGeminiStructured, selectStructuredLlm, withFallback } = await import("../src/lib/llm.ts");
const { GeminiPlannerBackend, toResponseObject } = await import("../src/plan/backend/gemini.ts");
const { selectBackend, fallbackBackend, PlanError } = await import("../src/plan/backend/index.ts");
const { zodToApiSchema, draftJsonSchema } = await import("../src/plan/schema-sanitize.ts");
const { makePlannerTools, newToolState } = await import("../src/plan/tools.ts");
const { runPlannerLoop } = await import("../src/plan/loop.ts");
const { BudgetTracker } = await import("../src/plan/budget.ts");
const { SYSTEM_PROMPT, SUBMIT_ADDENDUM } = await import("../src/plan/prompt.ts");
const { GOOD_DRAFT, BAD_DRAFT_UNKNOWN_REF, TINY_JPEG, makeFixtureContext } = await import("./helpers/plan-fixture.ts");

const noSleep = async () => {};
const ctx = makeFixtureContext();
const KEY = "test-key";

type Reply = { status?: number; json: unknown };
/** a fetch stub: each request goes to the next handler (the last one repeats); bodies are recorded */
function stubFetch(handlers: ((url: string, body: any) => Reply)[]) {
  const calls: { url: string; body: any; key: string | null }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    calls.push({ url: String(url), body, key: new Headers(init?.headers).get("x-goog-api-key") });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    const r = h(String(url), body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const usage = (p: number, c: number, extra: Record<string, number> = {}) => ({ promptTokenCount: p, candidatesTokenCount: c, totalTokenCount: p + c, ...extra });
const textReply = (text: string, u = usage(1000, 200), finishReason = "STOP"): Reply => ({ json: { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason }], usageMetadata: u, modelVersion: "gemini-3.8-flash" } });
const callReply = (calls: { name: string; args: unknown; id?: string }[], u = usage(1000, 50)): Reply => ({
  json: { candidates: [{ content: { role: "model", parts: calls.map((c, i) => ({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) }, ...(i === 0 ? { thoughtSignature: "SIG-1" } : {}) })) }, finishReason: "STOP" }], usageMetadata: u, modelVersion: "gemini-3.8-flash" },
});
const errReply = (status: number, message: string, details: unknown[] = []): Reply => ({ status, json: { error: { code: status, message, status: status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE", details } } });
const perDay = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier", quotaValue: "20" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "73000s" }];
const perMinute = [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateContentInputTokensPerModelPerMinute-FreeTier" }] }, { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "3s" }];
const QUOTA_MSG = "You exceeded your current quota, please check your plan and billing details.";

// ---------------------------------------------------------------- schema conversion

test("schema: $ref inlined, anyOf+null → nullable, const → enum, records and additionalProperties simplified", () => {
  const src = zodToApiSchema(
    z.object({
      kind: z.literal("cut"),
      mode: z.enum(["a", "b"]),
      note: z.string().nullable(),
      n: z.number().int().min(1).max(5),
      tags: z.array(z.string()),
      meta: z.record(z.string(), z.number()),
      pick: z.union([z.object({ a: z.string(), both: z.number() }), z.object({ b: z.string(), both: z.number() })]),
    }),
  );
  const g = toGeminiSchema(src);
  const text = JSON.stringify(g);
  for (const k of ["$ref", "$defs", "additionalProperties", "anyOf", "const", "$schema", "propertyNames"]) assert.ok(!text.includes(`"${k}"`), `${k} removed`);
  const p = g.properties as Record<string, any>;
  assert.deepEqual(p.kind, { type: "string", enum: ["cut"] });
  assert.deepEqual(p.mode.enum, ["a", "b"]);
  assert.equal(p.note.type, "string");
  assert.equal(p.note.nullable, true);
  assert.equal(p.tags.items.type, "string");
  assert.equal(p.meta.type, "string", "a free-form record becomes a JSON string");
  assert.match(p.meta.description, /encoded as a string/);
  assert.equal(p.pick.type, "object");
  assert.deepEqual(Object.keys(p.pick.properties).sort(), ["a", "b", "both"]);
  assert.deepEqual(p.pick.required, ["both"], "merged objects require only what every branch requires");
  assert.deepEqual(g.propertyOrdering, ["kind", "mode", "note", "n", "tags", "meta", "pick"]);
  // the answer for the record comes back as a string and is decoded again
  assert.deepEqual(reviveEncoded({ meta: '{"x":1}', tags: ["a"] }, g), { meta: { x: 1 }, tags: ["a"] });
});

test("schema: the planner's PlanDraft converts without refs and keeps the aspect enum", () => {
  const g = toGeminiSchema(draftJsonSchema());
  const text = JSON.stringify(g);
  assert.ok(!text.includes("$ref") && !text.includes("additionalProperties"));
  assert.ok(text.includes('"9:16"'));
  const clip = (g.properties as any).outputs.items.properties.clips.items;
  assert.deepEqual(clip.required, ["start", "end"]);
  assert.equal(clip.properties.start.type, "string");
});

// ---------------------------------------------------------------- pricing

test("cost: cached tokens at the cache rate, thinking billed as output, 2027 price step, unknown models unpriced", () => {
  const u = { promptTokenCount: 10_000, cachedContentTokenCount: 4_000, candidatesTokenCount: 500, thoughtsTokenCount: 1_500 };
  const pu = geminiUsage(u);
  assert.deepEqual(pu, { input_tokens: 6_000, output_tokens: 2_000, cache_read_input_tokens: 4_000, cache_creation_input_tokens: 0, thinking_tokens: 1_500 });
  const now = geminiTextUsd("gemini-3.8-flash", u, new Date("2026-10-19T00:00:00Z"));
  assert.equal(now.priced, true);
  assert.ok(Math.abs(now.usd - (6_000 * 0.75 + 4_000 * 0.075 + 2_000 * 3.75) / 1e6) < 1e-12);
  const later = geminiTextUsd("gemini-3.8-flash", u, new Date("2027-01-02T00:00:00Z"));
  assert.ok(Math.abs(later.usd - 2 * now.usd) < 1e-12, "3.8-flash doubles on 2027-01-01");
  assert.deepEqual(priceFor("models/gemini-3.5-flash-lite"), { in: 0.3, out: 2.5, cacheRead: 0.03 });
  assert.deepEqual(geminiTextUsd("gemini-3.7-flash", u).usd, 0);
  assert.equal(geminiTextUsd("gemini-3.7-flash", u).priced, false);
  assert.equal(servedModel({ modelVersion: "gemini-3.8-flash" }, "gemini-3.7-flash"), "gemini-3.8-flash", "an alias is priced by the model that answered");
  assert.equal(servedModel({}, "gemini-3.6-flash"), "gemini-3.6-flash");
});

test("models: configured first, then the fallback list; Claude ids ignored; effort → thinking level", () => {
  assert.deepEqual(plannerModels({}), ["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"]);
  assert.deepEqual(plannerModels({ VEDIT_GEMINI_PLANNER_MODEL: "gemini-3.1-pro-preview" }, "claude-opus-5-5")[0], "gemini-3.1-pro-preview");
  assert.equal(textModels({}, "gemini-3.6-flash")[0], "gemini-3.6-flash");
  assert.equal(textModels({}, "claude-opus-5-5")[0], "gemini-3.8-flash");
  assert.equal(thinkingLevel("low"), "low");
  assert.equal(thinkingLevel("medium"), "medium");
  assert.equal(thinkingLevel("max"), "high");
});

// ---------------------------------------------------------------- model fallback

test("fallback: 503 that does not clear → next model; per-day quota → model skipped for the run; per-minute → same model waits", async () => {
  const s1 = stubFetch([(url) => (url.includes("gemini-a") ? errReply(503, "overloaded") : textReply("{}"))]);
  const r1 = await generateWithFallback(["gemini-a", "gemini-b"], { contents: [] }, { key: KEY, fetch: s1.fn, sleep: noSleep });
  assert.equal(r1.model, "gemini-b");
  assert.equal(s1.calls.filter((c) => c.url.includes("gemini-a")).length, 3, "the overloaded model got its retries first");

  const dead = new Set<string>();
  const s2 = stubFetch([(url) => (url.includes("gemini-a") ? errReply(429, QUOTA_MSG, perDay) : textReply("{}"))]);
  assert.equal((await generateWithFallback(["gemini-a", "gemini-b"], { contents: [] }, { key: KEY, fetch: s2.fn, sleep: noSleep, dead })).model, "gemini-b");
  assert.ok(dead.has("gemini-a"));
  assert.equal(s2.calls.filter((c) => c.url.includes("gemini-a")).length, 1, "a per-day quota is not retried");
  await generateWithFallback(["gemini-a", "gemini-b"], { contents: [] }, { key: KEY, fetch: s2.fn, sleep: noSleep, dead });
  assert.equal(s2.calls.filter((c) => c.url.includes("gemini-a")).length, 1, "a dead model is skipped on later calls");

  const waits: number[] = [];
  const s3 = stubFetch([() => errReply(429, QUOTA_MSG, perMinute), () => textReply("{}")]);
  const r3 = await generateWithFallback(["gemini-a", "gemini-b"], { contents: [] }, { key: KEY, fetch: s3.fn, sleep: async (ms) => void waits.push(ms) });
  assert.equal(r3.model, "gemini-a", "a per-minute limit is waited out on the same model");
  assert.deepEqual(waits, [3000]);

  const s4 = stubFetch([() => errReply(400, "API key not valid. Please pass a valid API key.")]);
  await assert.rejects(generateWithFallback(["gemini-a", "gemini-b"], { contents: [] }, { key: KEY, fetch: s4.fn, sleep: noSleep }), (e: { kind?: string }) => e.kind === "auth");
  assert.equal(s4.calls.length, 1, "a bad key is not tried on other models");
});

// ---------------------------------------------------------------- planner backend

const loopSetup = (contract: "format" | "submit" = "format", budget: Record<string, number> = {}) => {
  const tracker = new BudgetTracker(budget);
  const state = newToolState();
  const tools = makePlannerTools(ctx, state, { framesDir: path.join(os.tmpdir(), "vedit-s29-frames"), extractFrame: async (_v, _t, f) => (await fs.mkdir(path.dirname(f), { recursive: true }), await fs.writeFile(f, TINY_JPEG), f) }, { contract, mode: "plan", maxRepairs: 2 });
  return { budget: tracker, maxRepairs: 2, contract, tools, state, system: SYSTEM_PROMPT + (contract === "submit" ? SUBMIT_ADDENDUM : ""), draftJsonSchema: draftJsonSchema() };
};
const task = { kind: "plan" as const, instruction: "2 рилса по 15 секунд", presetName: "bold_pop" };

test("planner: tool loop round trip — function calls run locally, responses go back with ids and signatures", async () => {
  const s = stubFetch([
    () => callReply([{ name: "get_transcript_range", args: { start: 0, end: 20 }, id: "c1" }, { name: "preview_frame", args: { t: 9 }, id: "c2" }], usage(5000, 80)),
    () => textReply(JSON.stringify(GOOD_DRAFT), usage(6000, 900, { cachedContentTokenCount: 4000, thoughtsTokenCount: 300 })),
  ]);
  const backend = new GeminiPlannerBackend({ key: KEY, effort: "medium", models: ["gemini-3.8-flash"], fetch: s.fn, sleep: noSleep });
  const opts = loopSetup();
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(r.calls, 2);
  assert.ok(r.resolved?.edl);
  assert.equal(s.calls[0].key, KEY);
  assert.match(s.calls[0].url, /models\/gemini-3\.8-flash:generateContent$/);

  const first = s.calls[0].body;
  assert.equal(first.systemInstruction.parts[0].text, opts.system);
  assert.equal(first.contents[0].parts[0].text, ctx.packText, "the pack is its own (cacheable) part");
  assert.deepEqual(first.tools[0].functionDeclarations.map((d: any) => d.name), ["get_scene_details", "get_transcript_range", "preview_frame", "validate_edl"]);
  assert.equal(first.toolConfig.functionCallingConfig.mode, "AUTO");
  assert.equal(first.generationConfig.responseMimeType, "application/json");
  assert.ok(!JSON.stringify(first.generationConfig.responseSchema).includes("$ref"));
  assert.equal(first.generationConfig.thinkingConfig.thinkingLevel, "medium");

  const second = s.calls[1].body.contents;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, "model");
  assert.equal(second[1].parts[0].thoughtSignature, "SIG-1", "the model turn is sent back verbatim");
  const responses = second[2].parts.map((p: any) => p.functionResponse);
  assert.deepEqual(responses.map((f: any) => [f.name, f.id]), [["get_transcript_range", "c1"], ["preview_frame", "c2"]]);
  assert.ok(Array.isArray(responses[0].response.phrases), "JSON tool results go back as objects");
  assert.equal(responses[1].parts[0].inlineData.mimeType, "image/jpeg", "frames go back as multimodal function response parts");
  assert.deepEqual(opts.state.trace.map((t) => t.name), ["get_transcript_range", "preview_frame"]);

  // cost: both requests priced and charged to the budget
  const expected = (5000 * 0.75 + 80 * 3.75 + 2000 * 0.75 + 4000 * 0.075 + 1200 * 3.75) / 1e6; // thinking is billed as output
  assert.ok(Math.abs(r.usd - expected) < 1e-9);
  assert.ok(r.priced);
  assert.equal(r.usage.cache_read_input_tokens, 4000);
  assert.equal(r.usage.thinking_tokens, 300);
  assert.ok(Math.abs(opts.budget.usd - expected) < 1e-9);
  assert.equal(opts.budget.calls, 2);
});

test("planner: validation issues → repair round in the same conversation", async () => {
  const s = stubFetch([() => textReply(JSON.stringify(BAD_DRAFT_UNKNOWN_REF)), () => textReply(JSON.stringify(GOOD_DRAFT))]);
  const backend = new GeminiPlannerBackend({ key: KEY, effort: "low", models: ["gemini-3.8-flash"], fetch: s.fn, sleep: noSleep });
  const r = await runPlannerLoop(backend, ctx, task, loopSetup());
  assert.equal(r.status, "ok");
  assert.equal(r.repairs, 1);
  const contents = s.calls[1].body.contents;
  assert.equal(contents[1].role, "model");
  assert.match(contents[2].parts[0].text, /VALIDATION ISSUES/);
  assert.match(contents[2].parts[0].text, /p99/);
});

test("planner: submit contract — the plan arrives as a submit_edl call, a rejection is fixed in the same turn", async () => {
  const s = stubFetch([
    () => callReply([{ name: "submit_edl", args: { plan: BAD_DRAFT_UNKNOWN_REF }, id: "s1" }]),
    () => callReply([{ name: "submit_edl", args: { plan: GOOD_DRAFT }, id: "s2" }]),
    () => textReply("Готово."),
  ]);
  const backend = new GeminiPlannerBackend({ key: KEY, effort: "medium", models: ["gemini-3.8-flash"], fetch: s.fn, sleep: noSleep });
  const opts = loopSetup("submit");
  const r = await runPlannerLoop(backend, ctx, task, opts);
  assert.equal(r.status, "ok");
  assert.equal(opts.state.submitAttempts, 2);
  assert.equal(s.calls[1].body.contents[2].parts[0].functionResponse.response.accepted, false);
  assert.ok(!s.calls[0].body.generationConfig.responseSchema, "no responseSchema in the submit contract");
});

test("planner: blocked answer → refusal; bad key → auth error; budget stops the tool loop", async () => {
  const blocked = stubFetch([() => ({ json: { candidates: [{ content: { parts: [] }, finishReason: "SAFETY" }], usageMetadata: usage(100, 0) } })]);
  const r1 = await runPlannerLoop(new GeminiPlannerBackend({ key: KEY, effort: "low", models: ["gemini-3.8-flash"], fetch: blocked.fn, sleep: noSleep }), ctx, task, loopSetup());
  assert.equal(r1.status, "failed");
  assert.equal(r1.errorCode, "refusal");

  const bad = stubFetch([() => errReply(401, "unauthorized")]);
  const r2 = await runPlannerLoop(new GeminiPlannerBackend({ key: KEY, effort: "low", models: ["gemini-3.8-flash"], fetch: bad.fn, sleep: noSleep }), ctx, task, loopSetup());
  assert.equal(r2.status, "failed");
  assert.equal(r2.errorCode, "auth");

  // every request costs $0.2 at a $0.3 budget: the second request is the last one
  const loop = stubFetch([() => callReply([{ name: "get_transcript_range", args: { start: 0, end: 10 } }], usage(200_000, 13_334))]);
  const r3 = await runPlannerLoop(new GeminiPlannerBackend({ key: KEY, effort: "low", models: ["gemini-3.8-flash"], fetch: loop.fn, sleep: noSleep }), ctx, task, loopSetup("format", { maxUsd: 0.3 }));
  assert.equal(r3.status, "failed");
  assert.equal(r3.errorCode, "budget");
  assert.equal(loop.calls.length, 2);
});

test("planner: the first request rejected for responseSchema + tools → contract error (the caller switches to submit)", async () => {
  const s = stubFetch([() => errReply(400, "Function calling with a response mime type 'application/json' is unsupported")]);
  const backend = new GeminiPlannerBackend({ key: KEY, effort: "low", models: ["gemini-3.8-flash"], fetch: s.fn, sleep: noSleep });
  await assert.rejects(runPlannerLoop(backend, ctx, task, loopSetup()), (e: { code?: string }) => e.code === "contract");
});

test("planner: tool results map to response objects", () => {
  assert.deepEqual(toResponseObject({ text: '{"a":1}' }), { a: 1 });
  assert.deepEqual(toResponseObject({ text: "[1,2]" }), { result: [1, 2] });
  assert.deepEqual(toResponseObject({ text: "plain" }), { result: "plain" });
  assert.deepEqual(toResponseObject({ text: "bad", isError: true }), { error: "bad" });
});

// ---------------------------------------------------------------- structured

const Q = { system: "sys", prompt: "write it", schema: zodToApiSchema(z.object({ title: z.string(), n: z.number() })), effort: "medium" as const, maxTokens: 4000 };

test("structured: responseSchema from the zod schema, priced answer, Claude model id ignored", async () => {
  const s = stubFetch([() => textReply('{"title":"x","n":2}', usage(1000, 100))]);
  const llm = makeGeminiStructured({ key: KEY, env: {}, fetch: s.fn, sleep: noSleep });
  const r = await llm({ ...Q, model: "claude-opus-5-5" });
  assert.deepEqual(r.data, { title: "x", n: 2 });
  assert.equal(r.provider, "gemini");
  assert.equal(r.model, "gemini-3.8-flash");
  assert.equal(r.estimate, false);
  assert.ok(Math.abs(r.usd - (1000 * 0.75 + 100 * 3.75) / 1e6) < 1e-12);
  assert.match(s.calls[0].url, /gemini-3\.8-flash/);
  const gen = s.calls[0].body.generationConfig;
  assert.equal(gen.responseMimeType, "application/json");
  assert.deepEqual(gen.responseSchema.required, ["title", "n"]);
  assert.equal(gen.thinkingConfig.thinkingLevel, "medium");
});

test("structured: invalid JSON → one repair retry; still invalid → error; blocked twice → refusal", async () => {
  const s = stubFetch([() => textReply('{"title": "x", '), () => textReply('{"title":"y","n":1}')]);
  const r = await makeGeminiStructured({ key: KEY, env: {}, fetch: s.fn, sleep: noSleep })(Q);
  assert.deepEqual(r.data, { title: "y", n: 1 });
  assert.equal(s.calls.length, 2);
  assert.match(s.calls[1].body.contents.at(-1).parts[0].text, /not valid JSON/);
  assert.ok(r.usage.input_tokens >= 2000, "both attempts are counted");

  const bad = stubFetch([() => textReply("not json")]);
  await assert.rejects(makeGeminiStructured({ key: KEY, env: {}, fetch: bad.fn, sleep: noSleep })(Q), (e: { code?: string }) => e.code === "invalid");

  const blocked = stubFetch([() => ({ json: { candidates: [{ finishReason: "PROHIBITED_CONTENT" }], usageMetadata: usage(10, 0) } })]);
  await assert.rejects(makeGeminiStructured({ key: KEY, env: {}, fetch: blocked.fn, sleep: noSleep })(Q), (e: { code?: string }) => e.code === "refusal");
  assert.equal(blocked.calls.length, 2);
});

test("structured: a schema the API rejects → JSON mode with the schema in the prompt", async () => {
  const s = stubFetch([() => errReply(400, "Invalid JSON payload: response_schema.properties: unsupported"), () => textReply('{"title":"z","n":3}')]);
  const r = await makeGeminiStructured({ key: KEY, env: {}, fetch: s.fn, sleep: noSleep })(Q);
  assert.deepEqual(r.data, { title: "z", n: 3 });
  assert.ok(!s.calls[1].body.generationConfig.responseSchema);
  assert.match(s.calls[1].body.systemInstruction.parts[0].text, /JSON Schema/);
});

// ---------------------------------------------------------------- provider selection and fallback

test("provider matrix: VEDIT_LLM / VEDIT_LLM_<STEP> × keys × login × server mode", () => {
  const no = { loginExists: () => false };
  const yes = { loginExists: () => true };
  const cases: [NodeJS.ProcessEnv, { loginExists: () => boolean }, string | RegExp, ("gemini" | null)?][] = [
    [{ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, no, "claude", "gemini"],
    [{ ANTHROPIC_API_KEY: "k" }, no, "claude", null],
    [{ GEMINI_API_KEY: "g" }, no, "gemini", null],
    [{ GEMINI_API_KEY: "g" }, yes, "claude", "gemini"],
    [{ GEMINI_API_KEY: "g", VEDIT_SERVER: "1" }, yes, "gemini", null],
    [{ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", VEDIT_LLM: "gemini" }, yes, "gemini", null],
    [{ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", VEDIT_LLM_FALLBACK: "off" }, no, "claude", null],
    [{ GEMINI_API_KEY: "g", VEDIT_LLM: "claude" }, no, /VEDIT_LLM=claude/],
    [{ ANTHROPIC_API_KEY: "k", VEDIT_LLM: "gemini" }, no, /GEMINI_API_KEY/],
    [{}, no, /GEMINI_API_KEY/],
    [{ VEDIT_SERVER: "1" }, yes, /серверный режим/],
    [{ GEMINI_API_KEY: "g", VEDIT_LLM: "chatgpt" }, no, /auto \| claude \| gemini/],
  ];
  for (const [env, probe, want, fb] of cases) {
    if (want instanceof RegExp) assert.throws(() => resolveLlmProvider("script", env, probe), want, JSON.stringify(env));
    else {
      const p = resolveLlmProvider("script", env, probe);
      assert.equal(p.provider, want, JSON.stringify(env));
      assert.equal(p.fallback, fb ?? null, `fallback for ${JSON.stringify(env)}`);
    }
  }
  // per-step override wins over VEDIT_LLM
  const env = { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", VEDIT_LLM: "claude", VEDIT_LLM_TRANSLATE: "gemini" };
  assert.equal(llmChoice("translate", env), "gemini");
  assert.equal(llmChoice("script", env), "claude");
  assert.equal(resolveLlmProvider("translate", env, no).provider, "gemini");
  assert.equal(fallbackEnabled({}), true);
  assert.equal(fallbackEnabled({ VEDIT_LLM_FALLBACK: "0" }), false);
});

test("planner selection: gemini backend, auto by keys, VEDIT_LLM_PLANNER, Claude-only errors unchanged", () => {
  const o = { model: "claude-opus-5-5", effort: "medium" as const };
  const no = { loginExists: () => false };
  assert.equal(selectBackend("gemini", o, { GEMINI_API_KEY: "g" }, no).name, "gemini");
  assert.equal(selectBackend("gemini", o, { GEMINI_API_KEY: "g" }, no).model, "gemini-3.8-flash", "a Claude --model is not sent to Gemini");
  assert.equal(selectBackend("auto", o, { GEMINI_API_KEY: "g", VEDIT_SERVER: "1" }, { loginExists: () => true }).name, "gemini");
  assert.equal(selectBackend("auto", o, { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, no).name, "api");
  assert.equal(selectBackend("auto", o, { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", VEDIT_LLM_PLANNER: "gemini" }, no).name, "gemini");
  assert.equal(selectBackend("auto", o, { GEMINI_API_KEY: "g" }, { loginExists: () => true }).name, "agent");
  assert.throws(() => selectBackend("gemini", o, {}, no), (e: unknown) => e instanceof PlanError && e.code === "auth");
  assert.throws(() => selectBackend("auto", o, {}, no), (e: unknown) => e instanceof PlanError && e.code === "no_backend");

  const api = selectBackend("api", o, { ANTHROPIC_API_KEY: "k" }, no);
  assert.equal(fallbackBackend(api, o, { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" })?.name, "gemini");
  assert.equal(fallbackBackend(api, o, { ANTHROPIC_API_KEY: "k" }), null);
  assert.equal(fallbackBackend(api, o, { ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g", VEDIT_LLM_FALLBACK: "off" }), null);
  assert.equal(fallbackBackend(selectBackend("gemini", o, { GEMINI_API_KEY: "g" }, no), o, { GEMINI_API_KEY: "g" }), null);
});

test("fallback: a Claude provider failure is retried once on Gemini (logged); refusals and bad answers are not", async () => {
  const s = stubFetch([() => textReply('{"title":"g","n":9}')]);
  const lines: string[] = [];
  const auth = Object.assign(new Error("401 invalid x-api-key"), { status: 401 });
  const llm = selectStructuredLlm({ ANTHROPIC_API_KEY: "k", GEMINI_API_KEY: "g" }, "script", { fetch: s.fn, claude: async () => Promise.reject(auth), onEvent: (l) => lines.push(l) });
  const r = await llm({ ...Q, model: "claude-opus-5-5" });
  assert.equal(r.provider, "gemini");
  assert.deepEqual(r.data, { title: "g", n: 9 });
  assert.match(s.calls[0].url, /gemini-3\.8-flash/, "the Claude model id is dropped on the way to Gemini");
  assert.ok(lines.some((l) => /Claude недоступен \(script\).*Gemini/.test(l)));

  const refusal = new PlanError("модель отказалась", "refusal");
  const noFb = withFallback(async () => Promise.reject(refusal), async () => ({ data: 1, usage: geminiUsage({}), usd: 0, estimate: false, model: "x", provider: "gemini" }), () => {});
  await assert.rejects(noFb(Q), (e: unknown) => e === refusal);

  for (const e of [{ status: 429 }, { status: 529, message: "Overloaded" }, { name: "APIConnectionError", message: "Connection error." }, { code: "auth", message: "x" }, { message: "Claude Code: billing_error" }, { message: "Your credit balance is too low" }]) assert.equal(isProviderFailure(e), true, JSON.stringify(e));
  for (const e of [{ code: "refusal", message: "auth" }, { code: "invalid", message: "x" }, { code: "budget", message: "429" }, new SyntaxError("Unexpected token"), null]) assert.equal(isProviderFailure(e), false, JSON.stringify(e));

  // only Gemini configured: selectStructuredLlm returns Gemini directly
  const only = stubFetch([() => textReply('{"title":"o","n":0}')]);
  assert.equal((await selectStructuredLlm({ GEMINI_API_KEY: "g", VEDIT_SERVER: "1" }, "translate", { fetch: only.fn })(Q)).provider, "gemini");
  assert.equal(only.calls[0].key, "g");
});
