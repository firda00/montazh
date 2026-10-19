// Stage 28: ratings → reasons → comment (text / voice), the AI critic (self-review) and the admin analytics.
// Fake Bot API (tests/helpers/fake-telegram.ts), fake pipelines, a stubbed critic and a fake Gemini fetch — no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s28-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
const { summarizeFeedback, formatFeedbackSummary, formatLowList, formatDisagree, feedbackReportMarkdown, feedbackKind, LOW_REASONS, HIGH_REASONS, aiGradeFor } = await import("../src/bot/feedback.ts");
const { runSelfReview, parseReview, likelyIssue, classifyReviewError, selfReviewEnabled, REVIEW_RESPONSE_SCHEMA } = await import("../src/review/self-review.ts");
const { GeminiError } = await import("../src/understand/vision/gemini.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type SelfReviewResult = import("../src/review/self-review.ts").SelfReviewResult;
type Review = import("../src/review/self-review.ts").Review;
type FeedbackRow = import("../src/bot/db.ts").FeedbackRow;
type SelfReviewRow = import("../src/bot/db.ts").SelfReviewRow;

const L = STRINGS.ru;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s28-"));

async function outputFile(name = "output_reel_1.mp4") {
  const f = path.join(await tmp(), name);
  await fs.writeFile(f, `mp4 ${name} ${Math.random()}`);
  return f;
}

const review = (over: Partial<Record<string, number>> = {}, confidence = 0.9): Review =>
  parseReview({
    scores: Object.fromEntries(["hook", "visual_relevance", "dynamics", "captions", "audio", "text_accuracy", "overall"].map((k) => [k, { score: over[k] ?? 4, reason: `${k} ok` }])),
    fixes: ["Поднять субтитры на 0:03", "Убрать паузу на 0:10", "Заменить картинку на 0:12", "лишняя"],
    summary: "Нормально, но субтитры мешают.",
    confidence,
  });

const ok = (r: Review, cost = 0.004): SelfReviewResult => ({ status: "ok", review: r, model: "gemini-3.5-flash-lite", usage: { promptTokenCount: 12000, candidatesTokenCount: 400 }, cost_usd: cost, hash: "h1", cached: false, seconds: 3 });

async function boot(extra: Partial<BotOptions> = {}) {
  const tg = fakeTelegram();
  const logs: string[] = [];
  const bot = await createBot({ token: "t", workspace: await tmp(), callMethod: tg.callMethod, download: tg.download, onLog: (l) => logs.push(l), statusEditMs: 0, cleanupIntervalMs: 0, broadcastDelayMs: 0, albumDelayMs: 0, onboarding: false, quotas: false, ...extra });
  return { tg, bot, logs };
}

/** video → task → delivered result; returns the bot job id and the result message id */
async function runOnce(tg: ReturnType<typeof fakeTelegram>, bot: Awaited<ReturnType<typeof createBot>>, chat: number, task = "сделай рилс 30 секунд") {
  await bot.handleUpdate(tg.video(chat, `V${chat}${Math.random().toString(36).slice(2, 6)}`));
  await bot.handleUpdate(tg.text(chat, task));
  await bot.idle();
  const result = tg.sent(chat, /^Готово: 1 ролик/)!;
  const resultId = tg.messageIdOf(result)!;
  const jobId = /A:(\w+)/.exec(tg.buttons(tg.keyboardOf(result)).join(" "))![1];
  return { jobId, resultId };
}

// ── storage ────────────────────────────────────────────────────────────────────

test("migration 3: outputs, feedback (one record per job/output/user, editable), self_review", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  assert.deepEqual(db.migrations(), [1, 2, 3, 4, 5]);
  db.putOutputs("j1", [{ id: "reel_1", file: "a.mp4", duration: 31.5, aspect: "9:16" }]);
  db.putOutputs("j1", [{ id: "reel_1", file: "b.mp4", duration: 30 }]);
  assert.deepEqual(
    db.outputsOf("j1").map((o) => [o.output_id, o.file, o.duration]),
    [["reel_1", "b.mp4", 30]],
  );
  db.upsertFeedback({ job: "j1", output_id: "reel_1", user: 5, stars: 2, reasons: '["subs"]', kind: "montage" });
  db.upsertFeedback({ job: "j1", output_id: "reel_1", user: 5, stars: 3, comment: "мелко" });
  const f = db.getFeedback("j1", "reel_1", 5)!;
  assert.deepEqual([f.stars, f.reasons, f.comment, f.kind], [3, '["subs"]', "мелко", "montage"], "edit keeps untouched fields");
  assert.equal(db.feedbackSince().length, 1);
  assert.throws(() => db.upsertFeedback({ job: "j1", output_id: "x", user: 5, stars: 7 }), /CHECK/);
  db.putSelfReview({ job: "j1", output_id: "reel_1", status: "ok", hash: "abc", scores: "{}", overall: 3, cost_usd: 0.002 });
  db.putSelfReview({ job: "j1", output_id: "reel_1", status: "ok", hash: "abc", scores: "{}", overall: 4, cost_usd: 0.002 });
  assert.equal(db.selfReviewsOf("j1").length, 1, "one review per output (replaced)");
  assert.equal(db.selfReviewByHash("abc")?.overall, 4);
  db.close();
  const again = new BotDb(db.file);
  assert.deepEqual(again.migrations(), [1, 2, 3, 4, 5]);
  assert.equal(again.feedbackSince().length, 1);
  again.close();
});

// ── the flow in the bot ────────────────────────────────────────────────────────

test("≤3⭐: reason chips toggle → «Готово» → voice comment transcribed and stored → result restored → humble ack from a confident self-review", async () => {
  const out = await outputFile();
  const reviewed: { file: string; kind?: string; task?: string }[] = [];
  const { tg, bot, logs } = await boot({
    pipeline: async () => ({ jobId: "20261019-aaaaaa", outputs: [{ id: "reel_1", file: out, duration: 30.5, aspect: "9:16" }] }),
    selfReview: async (file, ctx) => (reviewed.push({ file, kind: ctx.kind, task: ctx.task }), ok(review({ captions: 2, overall: 3 }))),
    transcribeNote: async () => "субтитры закрывают лицо на третьей секунде",
  });
  const { jobId, resultId } = await runOnce(tg, bot, 3);
  assert.equal(reviewed.length, 1, "the critic ran in the background after delivery");
  assert.deepEqual(reviewed[0], { file: out, kind: "montage", task: "сделай рилс 30 секунд" });
  const sr = bot.db.selfReviewsOf(jobId)[0];
  assert.deepEqual([sr.status, sr.overall, JSON.parse(sr.fixes).length, sr.model], ["ok", 3, 3, "gemini-3.5-flash-lite"]);
  assert.ok(bot.db.costSince("2000-01-01") >= 0.004, "the review cost counts toward the daily budget");
  assert.ok(logs.some((l) => /самопроверка .*reel_1: 3\/5/.test(l)));

  // 2⭐ → the same message asks why
  await bot.handleUpdate(tg.press(3, `r:${jobId}:2`, resultId));
  assert.equal(bot.db.getJob(jobId)!.rating, 2);
  assert.equal(tg.edits(3).at(-1), L.fb.askLow(2));
  const chips = tg.buttons(tg.markupOf(resultId));
  assert.deepEqual(chips, [...LOW_REASONS.map((c) => `${(L.fb.low as Record<string, string>)[c]}=fb:${jobId}:t:${c}`), `✅ Готово=fb:${jobId}:ok`]);
  assert.ok(chips.every((b) => Buffer.byteLength(b.split("=").slice(1).join("="), "utf8") <= 64), "callback_data ≤ 64 bytes");
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:t:subs`, resultId));
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:t:dyn`, resultId));
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:t:dyn`, resultId));
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:t:nonsense`, resultId));
  assert.ok(tg.buttons(tg.markupOf(resultId)).includes(`✓ Субтитры=fb:${jobId}:t:subs`));
  assert.ok(tg.buttons(tg.markupOf(resultId)).includes(`Нет динамики / скучно=fb:${jobId}:t:dyn`));
  assert.deepEqual(JSON.parse(bot.db.getFeedback(jobId, "reel_1", 3)!.reasons), ["subs"]);

  await bot.handleUpdate(tg.press(3, `fb:${jobId}:ok`, resultId));
  assert.equal(tg.edits(3).at(-1), L.fb.comment);
  assert.deepEqual(tg.buttons(tg.markupOf(resultId)), [`✅ Готово=fb:${jobId}:end`]);

  // a voice note now is a comment, not an avatar voice
  await bot.handleUpdate(tg.msg(3, 3, { voice: { file_id: "VOICE1", duration: 6, file_size: 9000 } }));
  const f = bot.db.getFeedback(jobId, "reel_1", 3)!;
  assert.deepEqual([f.stars, f.comment, f.comment_kind, f.kind, f.preset, f.aspect, f.duration], [2, "субтитры закрывают лицо на третьей секунде", "voice", "montage", "bold_pop", "9:16", 30.5]);
  assert.equal(bot.session(3).avatar_voice, undefined);
  assert.equal(bot.session(3).awaiting, undefined);
  const texts = tg.texts(3);
  assert.ok(texts.includes(L.fb.heard("субтитры закрывают лицо на третьей секунде")));
  assert.equal(texts.at(-1), "Похоже, проблема в субтитрах. Учтём.");
  assert.equal(bot.db.getFeedback(jobId, "reel_1", 3)!.acked, 1);
  // the result message is back: its text, the action buttons and the rating (tap = change)
  assert.match(tg.edits(3).at(-1)!, /^Готово: 1 ролик/);
  assert.deepEqual(tg.buttons(tg.markupOf(resultId)).at(-1), `⭐⭐ · изменить=fb:${jobId}:re`);
  assert.ok(tg.buttons(tg.markupOf(resultId)).includes(`✏️ Поправить=E:${jobId}`));

  // re-rate: stars again → 5⭐ (other side: reasons reset) → «Всё отлично» → text comment; still one record, no second ack
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:re`, resultId));
  assert.deepEqual(tg.buttons(tg.markupOf(resultId)).at(-1), `5⭐=r:${jobId}:5`);
  await bot.handleUpdate(tg.press(3, `r:${jobId}:5`, resultId));
  assert.equal(tg.edits(3).at(-1), L.fb.askHigh(5));
  assert.deepEqual(
    tg.buttons(tg.markupOf(resultId)).map((b) => b.split("=")[0]),
    [...HIGH_REASONS.map((c) => (L.fb.high as Record<string, string>)[c]), "✅ Готово"],
  );
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:t:all`, resultId));
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:ok`, resultId));
  const before = tg.texts(3).length;
  await bot.handleUpdate(tg.text(3, "огонь, беру"));
  const g = bot.db.getFeedback(jobId, "reel_1", 3)!;
  assert.deepEqual([g.stars, JSON.parse(g.reasons), g.comment, g.comment_kind], [5, ["all"], "огонь, беру", "text"]);
  assert.equal(bot.db.feedbackSince().length, 1, "one record per (job, output, user)");
  assert.deepEqual(tg.texts(3).slice(before), [L.fb.thanks]);
  assert.equal(bot.db.getJob(jobId)!.rating, 5);
  // someone else cannot rate this job
  await bot.handleUpdate(tg.press(4, `fb:${jobId}:t:subs`, resultId));
  assert.equal(tg.lastToast(), L.jobGone);
  bot.close();
});

test("«Готово» without a comment; a comment window that expired lets the text through as a new task; no ack without a confident review", async () => {
  const out = await outputFile();
  const runs: string[] = [];
  const { tg, bot } = await boot({
    pipeline: async (a) => (runs.push(a.instruction), { jobId: "20261019-bbbbbb", outputs: [{ id: "reel_1", file: out, duration: 20 }] }),
    // unsure critic: no «Похоже, проблема в …»
    selfReview: async () => ok(review({ captions: 1, overall: 2 }, 0.3)),
  });
  const { jobId, resultId } = await runOnce(tg, bot, 7);
  await bot.handleUpdate(tg.press(7, `r:${jobId}:1`, resultId));
  await bot.handleUpdate(tg.press(7, `fb:${jobId}:t:wait`, resultId));
  await bot.handleUpdate(tg.press(7, `fb:${jobId}:ok`, resultId));
  await bot.handleUpdate(tg.press(7, `fb:${jobId}:end`, resultId));
  assert.equal(tg.lastToast(), L.fb.thanks);
  assert.ok(!tg.texts(7).some((t) => t.startsWith("Похоже")), "an unsure critic stays quiet");
  assert.deepEqual(JSON.parse(bot.db.getFeedback(jobId, "reel_1", 7)!.reasons), ["wait"]);
  assert.equal(bot.db.getFeedback(jobId, "reel_1", 7)!.comment, null);
  // chips → «Готово» → 20 min later the text is a task again
  await bot.handleUpdate(tg.press(7, `fb:${jobId}:re`, resultId));
  await bot.handleUpdate(tg.press(7, `r:${jobId}:3`, resultId));
  assert.deepEqual(JSON.parse(bot.db.getFeedback(jobId, "reel_1", 7)!.reasons), ["wait"], "same side: reasons kept");
  await bot.handleUpdate(tg.press(7, `fb:${jobId}:ok`, resultId));
  // the in-memory session is the source of truth: age it the way a 20-minute-old one would look
  (bot.session(7) as { fb_at?: number }).fb_at = Date.now() - 20 * 60_000;
  await bot.handleUpdate(tg.text(7, "сделай ещё один рилс 15 секунд"));
  await bot.idle();
  assert.equal(runs.at(-1), "сделай ещё один рилс 15 секунд");
  assert.equal(bot.db.getFeedback(jobId, "reel_1", 7)!.comment, null);
  bot.close();
});

test("self-review in the bot: a throwing critic is stored as failed, a quota skip pauses further reviews for an hour, several outputs → one record for «*»", async () => {
  const outs = [await outputFile("a.mp4"), await outputFile("b.mp4")];
  let calls = 0;
  let mode: "throw" | "quota" = "throw";
  const { tg, bot, logs } = await boot({
    pipeline: async () => ({ jobId: "20261019-cccccc", outputs: outs.map((file, i) => ({ id: `reel_${i + 1}`, file, duration: 15 })) }),
    selfReview: async () => {
      calls++;
      if (mode === "throw") throw new Error("boom");
      return { status: "skipped", reason: "Gemini generate 429: RESOURCE_EXHAUSTED PerDay", cost_usd: 0 };
    },
  });
  await bot.handleUpdate(tg.video(9, "VV1"));
  await bot.handleUpdate(tg.text(9, "сделай 2 рилса"));
  await bot.idle();
  const first = bot.db.jobsByStatus("done")[0].id;
  assert.deepEqual(
    bot.db.selfReviewsOf(first).map((r) => [r.output_id, r.status, r.error]),
    [
      ["reel_1", "failed", "boom"],
      ["reel_2", "failed", "boom"],
    ],
  );
  assert.ok(logs.some((l) => /⚠ самопроверка .*boom/.test(l)));
  mode = "quota";
  await bot.handleUpdate(tg.text(9, "ещё 2 рилса"));
  await bot.idle();
  const second = bot.db.jobsByStatus("done").find((j) => j.id !== first)!.id;
  assert.equal(calls, 3, "after the quota answer the second output is not sent to Gemini");
  assert.deepEqual(
    bot.db.selfReviewsOf(second).map((r) => r.status),
    ["skipped", "skipped"],
  );
  assert.match(bot.db.selfReviewsOf(second)[1].error!, /квота: пауза до/);
  assert.ok(Date.parse(bot.db.getKv("review.pause_until")!) > Date.now() + 50 * 60_000);
  // the rating of a result with two videos is one record for "*"
  const result = tg.sent(9, /^Готово: 2 ролик/)!;
  await bot.handleUpdate(tg.press(9, `r:${second}:4`, tg.messageIdOf(result)!));
  assert.equal(bot.db.getFeedback(second, "*", 9)?.duration, 30);
  bot.close();
});

test("self-review off by default in createBot (tests, private deployments): nothing is reviewed", async () => {
  const out = await outputFile();
  const { tg, bot } = await boot({ pipeline: async () => ({ jobId: "20261019-dddddd", outputs: [{ id: "reel_1", file: out }] }) });
  const { jobId } = await runOnce(tg, bot, 11);
  assert.deepEqual(bot.db.selfReviewsOf(jobId), []);
  assert.equal(bot.db.outputsOf(jobId).length, 1);
  bot.close();
});

// ── the critic ─────────────────────────────────────────────────────────────────

function fakeGemini(answer: () => { status: number; body: unknown }) {
  const seen: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url.replace(/^https:\/\/generativelanguage\.googleapis\.com/, "")}`);
    if (url.endsWith("/upload/v1beta/files")) return new Response("{}", { status: 200, headers: { "x-goog-upload-url": "https://upload.example/u1" } });
    if (url === "https://upload.example/u1") return Response.json({ file: { name: "files/abc", uri: "https://files/abc", state: "ACTIVE", mimeType: "video/mp4" } });
    if (init?.method === "DELETE") return new Response("{}", { status: 200 });
    if (url.includes(":generateContent")) {
      const a = answer();
      return new Response(typeof a.body === "string" ? a.body : JSON.stringify(a.body), { status: a.status });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

const geminiAnswer = (data: unknown) => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] } }], usageMetadata: { promptTokenCount: 20000, candidatesTokenCount: 600, thoughtsTokenCount: 400 } } });

test("runSelfReview: upload → JSON verdict (clamped, 3 fixes) → upload deleted; priced; cached by content hash; quota → skipped, bad JSON → failed; off / no key → skipped", async () => {
  const file = await outputFile("final.mp4");
  const cacheDir = await tmp();
  const prepare = async (src: string, dst: string) => void (await fs.copyFile(src, dst));
  const raw = { scores: { ...Object.fromEntries(["hook", "visual_relevance", "dynamics", "captions", "audio", "text_accuracy"].map((k) => [k, { score: 4, reason: "ok" }])), captions: { score: 9, reason: "too big" }, overall: { score: 0, reason: "meh" } }, fixes: ["a", " ", "b", "c", "d"], summary: "s", confidence: 0.8 };
  const g = fakeGemini(() => geminiAnswer(raw));
  const env = { GEMINI_API_KEY: "k" };
  const r = await runSelfReview(file, { kind: "montage", task: "рилс", style: "clean_min", duration: 30, aspect: "9:16" }, { fetchFn: g.fetchFn, prepare, cacheDir, env, sleep: async () => {} });
  assert.equal(r.status, "ok");
  if (r.status !== "ok") return;
  assert.equal(r.review.scores.captions.score, 5, "clamped to 5");
  assert.equal(r.review.scores.overall.score, 1, "clamped to 1");
  assert.deepEqual(r.review.fixes, ["a", "b", "c"]);
  assert.equal(r.model, "gemini-3.5-flash-lite");
  assert.equal(Math.round(r.cost_usd * 1e6), Math.round(20000 * 0.3 + 1000 * 2.5), "$0.3 / $2.5 per 1M");
  assert.ok(g.seen.some((s) => s.startsWith("DELETE ") && s.includes("files/abc")), "the upload is deleted");
  assert.ok(g.seen.some((s) => s.includes("gemini-3.5-flash-lite:generateContent")));
  // the same file again: from the cache, no request, $0
  const before = g.seen.length;
  const again = await runSelfReview(file, {}, { fetchFn: g.fetchFn, prepare, cacheDir, env });
  assert.equal(again.status === "ok" && again.cached, true);
  assert.equal(again.cost_usd, 0);
  assert.equal(g.seen.length, before);

  const other = await outputFile("other.mp4");
  const quota = fakeGemini(() => ({ status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 20 PerDay" } } }));
  const q = await runSelfReview(other, {}, { fetchFn: quota.fetchFn, prepare, cacheDir: null, env, sleep: async () => {} });
  assert.equal(q.status, "skipped");
  assert.ok(quota.seen.some((s) => s.startsWith("DELETE ")), "deleted even when the model refuses");
  const bad = fakeGemini(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } }));
  const b = await runSelfReview(other, {}, { fetchFn: bad.fetchFn, prepare, cacheDir: null, env, sleep: async () => {} });
  assert.equal(b.status, "failed");
  assert.equal((await runSelfReview(other, {}, { env: { GEMINI_API_KEY: "k", VEDIT_SELF_REVIEW: "off" } })).status, "skipped");
  const nokey = await runSelfReview(other, {}, { env: {} });
  assert.deepEqual([nokey.status, nokey.status !== "ok" && nokey.reason], ["skipped", "нет GEMINI_API_KEY"]);
  assert.equal((await runSelfReview(path.join(cacheDir, "missing.mp4"), {}, { env })).status, "failed");
  assert.equal(selfReviewEnabled({}), true);
  assert.equal(selfReviewEnabled({ VEDIT_SELF_REVIEW: "off" }), false);
  assert.equal(classifyReviewError(new GeminiError("x", 429)), "skipped");
  assert.equal(classifyReviewError(new Error("socket hang up")), "failed");
  assert.deepEqual(Object.keys(REVIEW_RESPONSE_SCHEMA.properties.scores.properties), ["hook", "visual_relevance", "dynamics", "captions", "audio", "text_accuracy", "overall"]);
});

test("likelyIssue: only a confident critic, a matching reason first, a unique worst criterion otherwise", () => {
  assert.equal(likelyIssue(review({ captions: 2 }), ["subs"]), "subs");
  assert.equal(likelyIssue(review({ audio: 1 }), ["voice"]), "voice");
  assert.equal(likelyIssue(review({ dynamics: 2 }), ["cut"]), "dyn");
  assert.equal(likelyIssue(review({ visual_relevance: 2 }), []), "vis");
  assert.equal(likelyIssue(review({ hook: 1 }), ["other"]), "hook");
  assert.equal(likelyIssue(review({ captions: 2, audio: 2 }), []), undefined, "a tie is not confident");
  assert.equal(likelyIssue(review({ captions: 2 }), ["vis"]), undefined, "the user said something else");
  assert.equal(likelyIssue(review({ captions: 3 }), ["subs"]), undefined, "3 is not a problem");
  assert.equal(likelyIssue(review({ captions: 1 }, 0.4), ["subs"]), undefined, "unsure");
  assert.throws(() => parseReview({ scores: {} }), /не по схеме/);
});

// ── analytics ──────────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-19T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const fb = (job: string, stars: number, days: number, extra: Partial<FeedbackRow> = {}): FeedbackRow => ({ job, output_id: "reel_1", user: 1, stars, reasons: "[]", comment: null, comment_kind: null, kind: "montage", preset: "bold_pop", voice: null, aspect: "9:16", duration: 30, cost_usd: 0.1, acked: 0, created_at: ago(days), updated_at: ago(days), ...extra });
const sr = (job: string, overall: number, extra: Partial<SelfReviewRow> = {}): SelfReviewRow => ({ job, output_id: "reel_1", hash: null, status: "ok", scores: JSON.stringify({ hook: { score: 4, reason: "" }, captions: { score: overall, reason: "" }, overall: { score: overall, reason: "" } }), overall, fixes: JSON.stringify([`fix ${job}`]), summary: null, confidence: 0.8, model: "m", cost_usd: 0.003, error: null, created_at: ago(1), ...extra });

test("summary math: averages per window, distribution, by kind / style / voice, top reasons, low list with fixes, disagreements ≥ 2", () => {
  const rows = [
    fb("j1", 1, 1, { reasons: '["subs","dyn"]', comment: "мелкие субтитры" }),
    fb("j2", 2, 3, { reasons: '["subs"]', kind: "make", preset: "make", voice: "gemini_charon" }),
    fb("j3", 5, 2, { reasons: '["hook","all"]', kind: "make", preset: "make", voice: "gemini_charon" }),
    fb("j4", 4, 10, { reasons: '["hook"]', preset: "clean_min" }),
    fb("j5", 3, 40, { reasons: '["vis"]', kind: "highlights" }),
  ];
  const reviews = [sr("j1", 4), sr("j3", 2), sr("j4", 4), sr("x", 1, { status: "skipped", scores: null, overall: null })];
  const s7 = summarizeFeedback(rows, reviews, { days: 7, now: NOW });
  assert.deepEqual(s7.avg7, { avg: 2.67, n: 3 });
  assert.deepEqual(s7.avg30, { avg: 3, n: 4 });
  assert.deepEqual(s7.avgAll, { avg: 3, n: 5 });
  assert.deepEqual(s7.dist, [1, 1, 0, 0, 1]);
  assert.deepEqual(
    s7.byKind.map((x) => [x.key, x.avg, x.n]),
    [
      ["make", 3.5, 2],
      ["montage", 1, 1],
    ],
  );
  assert.deepEqual(
    s7.byVoice.map((x) => [x.key, x.n]),
    [["gemini_charon", 2]],
  );
  assert.deepEqual(s7.lowReasons, [
    { code: "subs", n: 2 },
    { code: "dyn", n: 1 },
  ]);
  assert.deepEqual(s7.highReasons, [
    { code: "all", n: 1 },
    { code: "hook", n: 1 },
  ]);
  assert.deepEqual(
    s7.low.map((x) => [x.f.job, x.ai?.overall, x.ai?.fixes[0]]),
    [
      ["j1", 4, "fix j1"],
      ["j2", undefined, undefined],
    ],
  );
  assert.deepEqual(
    s7.disagree.map((d) => [d.f.job, d.ai, d.diff]),
    [
      ["j1", 4, 3],
      ["j3", 2, -3],
    ],
  );
  assert.equal(s7.reviews.ok, 3);
  assert.equal(s7.reviews.skipped, 1);
  const all = summarizeFeedback(rows, reviews, { days: 0, now: NOW });
  assert.equal(all.dist.reduce((a, b) => a + b, 0), 5);
  assert.equal(all.byStyle.find((x) => x.key === "clean_min")?.avg, 4);
  // "*" = the mean over the job's outputs
  assert.equal(aiGradeFor({ job: "j9", output_id: "*" }, [sr("j9", 2), sr("j9", 5, { output_id: "reel_2" })])?.overall, 3.5);
  const text = formatFeedbackSummary(L, s7);
  assert.match(text, /📊 Оценки · 7 д/);
  assert.match(text, /Средняя: 7 д 2\.67 \(3\) · 30 д 3\.00 \(4\) · всё время 3\.00 \(5\)/);
  assert.match(text, /Распределение: 1⭐ 1 · 2⭐ 1 · 3⭐ 0 · 4⭐ 0 · 5⭐ 1/);
  assert.match(text, /По типу: по теме 3\.50 \(2\) · монтаж 1\.00 \(1\)/);
  assert.match(text, /Почему низкие \(1–3⭐\): Субтитры 2 · Нет динамики \/ скучно 1/);
  assert.match(text, /Почему высокие \(4–5⭐\): Всё отлично 1 · Хук 1/);
  assert.match(text, /Расхождения ИИ и пользователей \(\|разница\| ≥ 2\): 2/);
  assert.match(formatLowList(L, s7), /j1 · ⭐ · монтаж\/bold_pop · id 1\n {2}Пользователь: Субтитры, Нет динамики \/ скучно — «мелкие субтитры»\n {2}ИИ 4\/5: fix j1/);
  assert.match(formatDisagree(L, s7), /j1 · Пользователь 1⭐ · ИИ 4 \(\+3\)/);
  assert.match(feedbackReportMarkdown(L, s7, new Date(NOW)), /^# Оценки и самопроверка — отчёт[\s\S]*```\n📊 Оценки · 7 д/);
  assert.equal(formatFeedbackSummary(L, summarizeFeedback([], [], { now: NOW })), "📊 Оценки · 30 д\nОценок пока нет.");
  assert.equal(feedbackKind({ kind: "run", class: "standard", payload: JSON.stringify({ instruction: "хайлайты игры: лучшие броски" }) }), "highlights");
  assert.equal(feedbackKind({ kind: "run", class: "standard", payload: JSON.stringify({ instruction: "рилс", like: "x.json" }) }), "reference");
  assert.equal(feedbackKind({ kind: "avatar_import", class: "standard", payload: "{}" }), "avatar");
});

test("/admin → 📊 Оценки: the card, window switch in place, low list with open buttons, one job with the critic's grades, the video", async () => {
  const out = await outputFile();
  const { tg, bot } = await boot({
    adminIds: [1],
    pipeline: async () => ({ jobId: "20261019-eeeeee", outputs: [{ id: "reel_1", file: out, duration: 30 }] }),
    selfReview: async () => ok(review({ captions: 2, overall: 4 })),
  });
  const { jobId, resultId } = await runOnce(tg, bot, 21);
  await bot.handleUpdate(tg.press(21, `r:${jobId}:1`, resultId));
  await bot.handleUpdate(tg.press(21, `fb:${jobId}:t:subs`, resultId));
  await bot.handleUpdate(tg.press(21, `fb:${jobId}:ok`, resultId));
  await bot.handleUpdate(tg.text(21, "субтитры налезают на лицо"));

  await bot.handleUpdate(tg.text(1, "/admin"));
  await bot.handleUpdate(tg.press(1, "a:fb:30:n", 1));
  const card = tg.sent(1, /^📊 Оценки · 30 д/)!;
  assert.match(String(card.params.text), /Средняя: 7 д 1\.00 \(1\)/);
  assert.match(String(card.params.text), /Самопроверка ИИ: проверено 1, пропущено 0, средняя 4\.00, расходы \$0\.0040/);
  assert.match(String(card.params.text), /Расхождения ИИ и пользователей \(\|разница\| ≥ 2\): 1/);
  assert.deepEqual(tg.buttons(tg.keyboardOf(card)), ["7 д=a:fb:7", "✓ 30 д=a:fb:30", "всё время=a:fb:0", "👎 Низкие=a:fl:30", "⚖️ Расхождения=a:fd:30"]);
  const cardId = tg.messageIdOf(card)!;
  await bot.handleUpdate(tg.press(1, "a:fb:7", cardId));
  assert.match(tg.edits(1).at(-1)!, /^📊 Оценки · 7 д/);
  await bot.handleUpdate(tg.press(1, "a:fl:30", cardId));
  const low = tg.sent(1, /^Последние низкие оценки/)!;
  assert.match(String(low.params.text), new RegExp(`${jobId} · ⭐ · монтаж/bold_pop · id 21\\n  Пользователь: Субтитры — «субтитры налезают на лицо»\\n  ИИ 4/5: Поднять субтитры на 0:03; Убрать паузу на 0:10; Заменить картинку на 0:12`));
  assert.deepEqual(tg.buttons(tg.keyboardOf(low)), [`🔎 ${jobId}=a:fo:${jobId}`]);
  await bot.handleUpdate(tg.press(1, "a:fd:30", cardId));
  assert.match(tg.texts(1).at(-1)!, new RegExp(`${jobId} · Пользователь 1⭐ · ИИ 4 \\(\\+3\\)`));
  await bot.handleUpdate(tg.press(1, `a:fo:${jobId}`, cardId));
  const detail = tg.sent(1, /^🔎 /)!;
  assert.match(String(detail.params.text), /Пользователь 21: ⭐ · Субтитры\n {2}«субтитры налезают на лицо»/);
  assert.match(String(detail.params.text), /ИИ reel_1: 4\/5 · gemini-3\.5-flash-lite · \$0\.0040 · уверенность 0\.90/);
  assert.match(String(detail.params.text), /субтитры 2: captions ok/);
  await bot.handleUpdate(tg.press(1, `a:fv:${jobId}`, cardId));
  assert.ok(tg.calls.some((c) => c.method === "sendDocument" && c.params.chat_id === 1));
  // not for users
  await bot.handleUpdate(tg.press(21, "a:fb:30:n", 5));
  assert.ok(!tg.texts(21).some((t) => t.startsWith("📊 Оценки")));
  bot.close();
});
