// Stage 20: server mode (API keys only) — provider selection without agy / Claude Code login, Gemini trends with
// Google Search grounding and Gemini images (stubbed fetch), Chrome / whisper / font discovery on Linux paths,
// and the bot's server guards (per-user daily cap, global daily API budget).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-ws-"));

const { serverFlag, serverForced, detectServerMode } = await import("../src/lib/server.ts");
const { selectBackend, claudeLoginAvailable, PlanError } = await import("../src/plan/backend/index.ts");
const { selectStructuredLlm } = await import("../src/lib/llm.ts");
const { findAgy } = await import("../src/understand/vision/agy.ts");
const { parseGrounded, attachSources, researchTrendsGemini, TrendsUnavailable } = await import("../src/make/trends-gemini.ts");
const { researchTrends, trendsBackend } = await import("../src/make/trends.ts");
const { generateImagesGemini, imageFromResponse } = await import("../src/make/images-gemini.ts");
const { generateImages, imageBackend } = await import("../src/make/images.ts");
const { geminiPost, GeminiCallError, isHardQuota } = await import("../src/lib/gemini-rest.ts");
const { maxJobsFromEnv, userDailyJobsFromEnv, dailyBudgetUsdFromEnv } = await import("../src/bot/plans.ts");
const { findHeadlessChrome, explicitChrome, chromeEnv } = await import("../src/lib/chrome.ts");
const { whisperPaths } = await import("../src/understand/whisper.ts");
const { systemFontFile, drawtextFont } = await import("../src/lib/sysfont.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
const { createBot } = await import("../src/bot/index.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");

const noSleep = async () => {};

/** a fetch stub: each call goes to the next handler; requests are recorded */
function stubFetch(handlers: ((url: string, body: any) => { status: number; json: unknown })[]) {
  const calls: { url: string; body: any; key: string | null }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    const key = new Headers(init?.headers).get("x-goog-api-key");
    calls.push({ url: String(url), body, key });
    const h = handlers[Math.min(calls.length - 1, handlers.length - 1)];
    const r = h(String(url), body);
    return new Response(JSON.stringify(r.json), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const TRENDS_JSON = { facts: [{ text: "Spain won Euro 2024 beating England 2-1", source: "https://made-up.example/x" }, { text: "Record 2.7 million tickets sold", source: "" }], angles: ["a"], hooks: ["h"], avoid: [] };

// ── server mode ──
test("server mode: VEDIT_SERVER forces / forbids, auto = no agy and no Claude Code login", async () => {
  assert.equal(serverFlag({}), null);
  assert.equal(serverFlag({ VEDIT_SERVER: "1" }), true);
  assert.equal(serverFlag({ VEDIT_SERVER: "off" }), false);
  assert.throws(() => serverFlag({ VEDIT_SERVER: "maybe" }), /VEDIT_SERVER/);
  assert.equal(serverForced({ VEDIT_SERVER: "maybe" }), false);
  assert.equal((await detectServerMode({ VEDIT_SERVER: "1" })).on, true);
  assert.deepEqual((await detectServerMode({}, { agy: async () => null, login: () => false })).on, true);
  assert.equal((await detectServerMode({}, { agy: async () => "/usr/bin/agy", login: () => false })).on, false);
  assert.equal((await detectServerMode({}, { agy: async () => null, login: () => true })).on, false);
  assert.equal((await detectServerMode({ VEDIT_SERVER: "0" }, { agy: async () => null, login: () => false })).on, false);
});

test("server mode: Claude goes to the API only; agy is never found", async () => {
  const opts = { model: "m", effort: "low" as const };
  const login = { loginExists: () => true };
  assert.equal(selectBackend("auto", opts, { VEDIT_SERVER: "1", ANTHROPIC_API_KEY: "k" }, login).name, "api");
  assert.throws(() => selectBackend("auto", opts, { VEDIT_SERVER: "1" }, login), (e: unknown) => e instanceof PlanError && /VEDIT_SERVER/.test(e.message));
  assert.throws(() => selectBackend("agent", opts, { VEDIT_SERVER: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" }, login), /серверном режиме/);
  assert.equal(claudeLoginAvailable({ VEDIT_SERVER: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" }, () => true), false);
  assert.equal(claudeLoginAvailable({ CLAUDE_CODE_OAUTH_TOKEN: "t" }, () => false), true);
  assert.throws(() => selectStructuredLlm({ VEDIT_SERVER: "1", CLAUDE_CODE_OAUTH_TOKEN: "t" }), /серверный режим/);
  assert.equal(await findAgy({ VEDIT_SERVER: "1", VEDIT_AGY_BIN: "/opt/agy" }), null);
  assert.equal(await findAgy({ VEDIT_AGY_BIN: "/opt/agy" }), "/opt/agy");
  assert.equal(await trendsBackend({ VEDIT_SERVER: "1", GEMINI_API_KEY: "g" }), "gemini-search");
  assert.equal(await trendsBackend({ VEDIT_SERVER: "1" }), null);
  assert.equal(await imageBackend({ VEDIT_SERVER: "1", GOOGLE_API_KEY: "g" }), "gemini-image");
  assert.equal(await imageBackend({ VEDIT_AGY_BIN: "/opt/agy", GEMINI_API_KEY: "g" }), "agy", "local laptop: agy first");
});

test("limits: one job at a time in server mode; per-user daily cap and daily budget from env", () => {
  assert.equal(maxJobsFromEnv({ VEDIT_SERVER: "1" }, 24 * 1024 ** 3), 1);
  assert.equal(maxJobsFromEnv({}, 24 * 1024 ** 3), 2);
  assert.equal(maxJobsFromEnv({ VEDIT_SERVER: "1", VEDIT_MAX_JOBS: "2" }, 24 * 1024 ** 3), 2);
  assert.equal(userDailyJobsFromEnv({}), 10);
  assert.equal(userDailyJobsFromEnv({ VEDIT_USER_DAILY_JOBS: "0" }), 0);
  assert.throws(() => userDailyJobsFromEnv({ VEDIT_USER_DAILY_JOBS: "-1" }), /VEDIT_USER_DAILY_JOBS/);
  assert.equal(dailyBudgetUsdFromEnv({}), 10);
  assert.equal(dailyBudgetUsdFromEnv({ VEDIT_BUDGET_DAILY_USD: "2.5" }), 2.5);
  assert.throws(() => dailyBudgetUsdFromEnv({ VEDIT_BUDGET_DAILY_USD: "lots" }), /VEDIT_BUDGET_DAILY_USD/);
});

// ── Gemini REST helper ──
test("gemini-rest: short 429 is retried, free-tier / daily quota is not, bad key is auth", async () => {
  const ok = stubFetch([() => ({ status: 429, json: { error: { message: "Resource exhausted, retry", details: [{ retryDelay: "1s" }] } } }), () => ({ status: 200, json: { ok: 1 } })]);
  assert.deepEqual(await geminiPost("u", {}, { key: "k", fetch: ok.fn, sleep: noSleep }), { ok: 1 });
  assert.equal(ok.calls.length, 2);
  assert.equal(ok.calls[0].key, "k");
  const quota = stubFetch([() => ({ status: 429, json: { error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric generate_content_free_tier_requests, limit: 0" } } })]);
  await assert.rejects(geminiPost("u", {}, { key: "k", fetch: quota.fn, sleep: noSleep }), (e: unknown) => e instanceof GeminiCallError && e.kind === "quota");
  assert.equal(quota.calls.length, 1);
  const auth = stubFetch([() => ({ status: 400, json: { error: { message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT" } } })]);
  await assert.rejects(geminiPost("u", {}, { key: "k", fetch: auth.fn, sleep: noSleep }), (e: unknown) => e instanceof GeminiCallError && e.kind === "auth");
  const nf = stubFetch([() => ({ status: 404, json: { error: { message: "models/x is not found" } } })]);
  await assert.rejects(geminiPost("u", {}, { key: "k", fetch: nf.fn, sleep: noSleep }), (e: unknown) => e instanceof GeminiCallError && e.kind === "unsupported");
  assert.ok(isHardQuota("Image generation is not available on the free tier"));
  assert.ok(!isHardQuota("Resource has been exhausted (e.g. check quota)."));
});

// ── trends: Gemini + Google Search grounding ──
const interactionsAnswer = (json: unknown) => ({
  id: "int_1",
  steps: [
    { type: "google_search_call", queries: ["euro 2024 winner", "euro 2024 tickets"] },
    { type: "google_search_result", call_id: "search_001", search_suggestions: "<div/>" },
    {
      type: "model_output",
      content: [
        {
          type: "text",
          text: "```json\n" + JSON.stringify(json) + "\n```\nSpain won Euro 2024 beating England 2-1 in Berlin.",
          annotations: [{ type: "url_citation", url: "https://www.aljazeera.com/sports/euro-2024-final", title: "aljazeera.com", start_index: JSON.stringify(json).length + 13, end_index: JSON.stringify(json).length + 63 }],
        },
      ],
    },
  ],
  usage: { total_input_tokens: 1000, total_output_tokens: 400, total_thought_tokens: 100 },
});

test("trends (gemini): interactions answer → TrendsSchema, sources from the grounding citations", async () => {
  const f = stubFetch([(url, body) => (assert.match(url, /\/v1beta\/interactions$/), assert.deepEqual(body.tools, [{ type: "google_search" }]), { status: 200, json: interactionsAnswer(TRENDS_JSON) })]);
  const r = await researchTrendsGemini("Евро 2024", { key: "g", fetch: f.fn, sleep: noSleep, models: ["gemini-3.8-flash"] });
  assert.equal(r.provider, "gemini-search");
  assert.equal(r.model, "gemini-3.8-flash");
  assert.equal(r.trends.facts[0].source, "https://www.aljazeera.com/sports/euro-2024-final", "the made-up URL is replaced by the citation that supports the fact");
  assert.equal(r.trends.facts[1].source, "", "no citation shares its words — left unsourced");
  assert.deepEqual(r.queries, ["euro 2024 winner", "euro 2024 tickets"]);
  assert.deepEqual(r.sources, ["https://www.aljazeera.com/sports/euro-2024-final"]);
  assert.deepEqual(r.usage, { input_tokens: 1000, output_tokens: 500 });
  assert.ok(r.usd > 0.02 && r.usd < 0.04, `search queries priced: ${r.usd}`);
  assert.match(f.calls[0].body.input, /Евро 2024/);
});

test("trends (gemini): interactions 404 → generateContent with groundingMetadata; free-tier quota → next model; nothing → TrendsUnavailable", async () => {
  const gc = {
    candidates: [
      {
        content: { parts: [{ text: JSON.stringify(TRENDS_JSON) }] },
        groundingMetadata: {
          webSearchQueries: ["euro 2024"],
          groundingChunks: [{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "uefa.com" } }, { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "bbc.com" } }],
          groundingSupports: [{ segment: { text: "A record 2.7 million tickets were sold" }, groundingChunkIndices: [1] }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
  };
  const f = stubFetch([
    () => ({ status: 429, json: { error: { message: "Grounding with Google Search is not available on the free tier for gemini-3.8-flash" } } }),
    (url) => (assert.match(url, /interactions$/), { status: 404, json: { error: { message: "not found" } } }),
    (url, body) => (assert.match(url, /models\/gemini-2\.5-flash:generateContent$/), assert.deepEqual(body.tools, [{ google_search: {} }]), { status: 200, json: gc }),
  ]);
  const r = await researchTrendsGemini("euro", { key: "g", fetch: f.fn, sleep: noSleep, models: ["gemini-3.8-flash", "gemini-2.5-flash"] });
  assert.equal(r.model, "gemini-2.5-flash");
  assert.equal(r.trends.facts[1].source, "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", "matched by the supported segment");
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 25 });
  const none = stubFetch([() => ({ status: 429, json: { error: { message: "limit: 0, free_tier" } } })]);
  await assert.rejects(researchTrendsGemini("x", { key: "g", fetch: none.fn, sleep: noSleep, models: ["a", "b"] }), TrendsUnavailable);
  assert.equal(none.calls.length, 2, "one call per model, no retry on a hard quota");
  const bad = stubFetch([() => ({ status: 403, json: { error: { message: "Permission denied: API key" } } })]);
  await assert.rejects(researchTrendsGemini("x", { key: "g", fetch: bad.fn, sleep: noSleep, models: ["a", "b"] }), (e: unknown) => e instanceof TrendsUnavailable && /ключ/.test(e.message));
  assert.equal(bad.calls.length, 1, "a bad key stops at once");
});

test("trends: researchTrends uses Gemini when there is no agy (server mode)", async () => {
  const prev = process.env.VEDIT_SERVER;
  process.env.VEDIT_SERVER = "1";
  try {
    const f = stubFetch([() => ({ status: 200, json: interactionsAnswer(TRENDS_JSON) })]);
    const r = await researchTrends("тема", { gemini: { key: "g", fetch: f.fn, sleep: noSleep, models: ["m1"] } });
    assert.equal(r.provider, "gemini-search");
    assert.equal(r.trends.angles[0], "a");
  } finally {
    if (prev === undefined) delete process.env.VEDIT_SERVER;
    else process.env.VEDIT_SERVER = prev;
  }
});

test("parseGrounded / attachSources: same-site source kept as the citation URL; no citations → model sources kept", () => {
  const g = parseGrounded({ outputs: [{ type: "text", text: "t", annotations: [{ type: "url_citation", url: "https://www.bbc.com/news/1", title: "bbc.com", start_index: 0, end_index: 1 }] }] });
  assert.equal(g.citations.length, 1);
  const t = attachSources({ facts: [{ text: "x", source: "https://bbc.com/other" }], angles: [], hooks: [], avoid: [] }, g.citations);
  assert.equal(t.facts[0].source, "https://www.bbc.com/news/1");
  const keep = { facts: [{ text: "x", source: "https://a.example" }], angles: [], hooks: [], avoid: [] };
  assert.deepEqual(attachSources(keep, []), keep);
});

// ── images: Gemini image model ──
async function tinyPng(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-png-"));
  const f = path.join(dir, "a.png");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=0x336699:s=16x28", "-frames:v", "1", f]);
  return (await fs.readFile(f)).toString("base64");
}

test("images (gemini): interactions image → file; free tier (no quota) on model 1 → model 2; all out of quota → reported missing, not thrown", async () => {
  const png = await tinyPng();
  assert.deepEqual(imageFromResponse({ candidates: [{ content: { parts: [{ text: "x" }, { inlineData: { mimeType: "image/jpeg", data: "QQ==" } }] } }] }), { data: "QQ==", mime: "image/jpeg" });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-img-"));
  const f = stubFetch([
    () => ({ status: 400, json: { error: { status: "FAILED_PRECONDITION", message: "Image generation is not available on the free tier. Enable billing." } } }),
    (url, body) => (assert.match(url, /interactions$/), assert.deepEqual(body.response_format, { type: "image", aspect_ratio: "9:16" }), { status: 200, json: { steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png }] }] } }),
    () => ({ status: 200, json: { steps: [{ type: "model_output", content: [{ type: "image", mime_type: "image/png", data: png }] }] } }),
  ]);
  const r = await generateImagesGemini([{ beat: 1, prompt: "a market" }, { beat: 3, prompt: "a bridge" }], dir, { key: "g", fetch: f.fn, sleep: noSleep, models: ["lite", "banana"], style: "s", aspect: "9:16", frameWords: "vertical 9:16" });
  assert.deepEqual([...r.written.keys()], [1, 3]);
  assert.equal(r.model, "banana");
  assert.equal(f.calls.length, 3, "the dropped model is not asked again for the second image");
  assert.match(f.calls[1].body.input[0].text, /a market/);
  assert.equal(r.usd, 0.068);
  const empty = stubFetch([() => ({ status: 429, json: { error: { message: "Quota exceeded ... limit: 0" } } })]);
  const r2 = await generateImagesGemini([{ beat: 0, prompt: "p" }, { beat: 1, prompt: "q" }], dir, { key: "g", fetch: empty.fn, sleep: noSleep, models: ["a"], style: "s", aspect: "1:1", frameWords: "square" });
  assert.equal(r2.written.size, 0);
  assert.deepEqual(r2.failed.map((x) => x.beat), [0, 1]);
  assert.equal(empty.calls.length, 1);
});

test("images: generateImages without agy (server mode) → Gemini → normalised JPEG at the frame size", async () => {
  const png = await tinyPng();
  const prev = process.env.VEDIT_SERVER;
  process.env.VEDIT_SERVER = "1";
  try {
    const out = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-out-"));
    const f = stubFetch([() => ({ status: 200, json: { output_image: { mime_type: "image/png", data: png } } })]);
    const r = await generateImages([{ beat: 2, prompt: "p" }], out, { style: "s", gemini: { key: "g", fetch: f.fn, sleep: noSleep, models: ["m"] } });
    assert.equal(r.provider, "gemini-image");
    assert.deepEqual(r.missing, []);
    assert.ok((await fs.stat(r.files.get(2)!)).size > 0);
    assert.equal(path.basename(r.files.get(2)!), "scene_2.jpg");
  } finally {
    if (prev === undefined) delete process.env.VEDIT_SERVER;
    else process.env.VEDIT_SERVER = prev;
  }
});

// ── Linux / ARM paths ──
test("chrome: env first, then caches incl. Playwright's headless shell (linux-arm64)", async () => {
  assert.equal(explicitChrome({ CHROME_PATH: "/c", PUPPETEER_EXECUTABLE_PATH: "/p" }), "/p");
  assert.equal(explicitChrome({ VEDIT_CHROME: "/v", HYPERFRAMES_BROWSER_PATH: "/h" }), "/v");
  assert.deepEqual(chromeEnv({ HYPERFRAMES_BROWSER_PATH: "/h" }), {}, "HyperFrames already has it");
  assert.deepEqual(chromeEnv({ VEDIT_CHROME: process.execPath }), { HYPERFRAMES_BROWSER_PATH: process.execPath });
  assert.deepEqual(chromeEnv({ VEDIT_CHROME: "/nope/chrome" }), {}, "a missing file is not passed on");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-home-"));
  const exe = process.platform === "win32" ? "headless_shell.exe" : "headless_shell";
  const shell = path.join(home, ".cache", "ms-playwright", "chromium_headless_shell-1200", "chrome-linux", exe);
  await fs.mkdir(path.dirname(shell), { recursive: true });
  await fs.writeFile(shell, "bin");
  assert.equal(await findHeadlessChrome({}, home), shell);
  assert.equal(await findHeadlessChrome({ VEDIT_CHROME: "/x" }, home), "/x");
});

test("whisper / fonts: configurable paths, no Windows-only defaults on Linux", () => {
  assert.deepEqual(whisperPaths({ VEDIT_WHISPER_BIN: "/w/bin", VEDIT_WHISPER_MODEL: "/w/m.bin", WHISPER_BIN: "/old" }, "linux"), { bin: "/w/bin", model: "/w/m.bin" });
  assert.equal(whisperPaths({ WHISPER_BIN: "/old" }, "linux").bin, "/old");
  const lin = whisperPaths({}, "linux").bin;
  assert.ok(lin.endsWith(path.join("vendor", "whisper", "bin", "whisper-cli")), lin);
  assert.ok(whisperPaths({}, "win32").bin.endsWith("whisper-cli.exe"));
  assert.equal(systemFontFile("linux", (p) => p.includes("dejavu")), "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
  assert.ok(systemFontFile("linux", () => false).endsWith("Inter-Variable.ttf"), "the repo's Inter when the distro has no fonts");
  assert.equal(drawtextFont("C:/Windows/Fonts/arial.ttf"), "fontfile='C\\:/Windows/Fonts/arial.ttf'");
  assert.equal(drawtextFont("/usr/share/fonts/a.ttf"), "fontfile='/usr/share/fonts/a.ttf'");
});

// ── bot: server guards ──
test("bot: per-user daily cap and the global daily API budget refuse new jobs (admins exempt)", async () => {
  const tg = fakeTelegram();
  const made: string[] = [];
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s20-bot-")),
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    onboarding: false,
    quotas: false,
    adminIds: [99],
    userDailyJobs: 2,
    dailyBudgetUsd: 1,
    maxJobs: 1,
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    make: async (a) => (made.push(a.topic), { jobId: "20261016-s20", outputs: [] }),
  });
  for (const u of [1, 2, 99]) await bot.handleUpdate(tg.text(u, "/start"));
  for (const topic of ["one", "two", "three"]) {
    await bot.handleUpdate(tg.text(1, `/make ${topic}`));
    await bot.idle();
  }
  assert.deepEqual(made, ["one", "two"]);
  assert.match(tg.texts(1).at(-1)!, /дневной максимум/);
  // spend over the budget: user 2 is refused, the admin is not
  bot.db.addUsage({ user: 1, kind: "make", units: 0, cost_usd: 1.2 });
  await bot.handleUpdate(tg.text(2, "/make four"));
  await bot.idle();
  assert.match(tg.texts(2).at(-1)!, /бюджет/);
  await bot.handleUpdate(tg.text(99, "/make five"));
  await bot.idle();
  assert.deepEqual(made, ["one", "two", "five"]);
  bot.close();
});
