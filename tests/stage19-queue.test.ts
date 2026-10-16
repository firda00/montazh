// Stage 19: the global job queue (concurrency, per-user limits, fair order, cancel), real cancellation of a
// child process through the job signal, progress parsing, and restart recovery of persisted jobs.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s19q-ws-"));

const { JobQueue } = await import("../src/bot/queue.ts");
const { createBot, MSG, parseStage } = await import("../src/bot/index.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { withJobSignal, jobSignal } = await import("../src/lib/abort.ts");
const { runProcess } = await import("../src/lib/ffmpeg.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type JobOutcome = import("../src/bot/queue.ts").JobOutcome;

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

/** a queue whose jobs wait for their gate */
function harness(maxJobs: number, perUserQueued = 2) {
  const started: string[] = [];
  const gates = new Map<string, ReturnType<typeof gate>>();
  const signals = new Map<string, AbortSignal>();
  const q = new JobQueue({
    maxJobs,
    perUserQueued,
    cancelGraceMs: 50,
    run: async (id, signal): Promise<JobOutcome> => {
      started.push(id);
      signals.set(id, signal);
      const g = gate();
      gates.set(id, g);
      await g.p;
      return signal.aborted ? "cancelled" : "done";
    },
  });
  const finish = async (id: string) => {
    gates.get(id)!.open();
    await tick();
  };
  return { q, started, finish, signals };
}

test("queue: global concurrency, one running job per user, at most two waiting per user", async () => {
  const { q, started, finish } = harness(2);
  q.enqueue("a1", 1);
  q.enqueue("a2", 1);
  q.enqueue("b1", 2);
  assert.deepEqual(started, ["a1", "b1"], "a2 waits: user 1 already runs a job");
  assert.equal(q.position("a2"), 1);
  q.enqueue("a3", 1);
  assert.equal(q.canEnqueue(1), false, "a2 and a3 wait — the user's queue is full");
  assert.equal(q.canEnqueue(2), true);
  q.enqueue("c1", 3);
  assert.deepEqual(q.counts(), { running: 2, waiting: 3 });
  await finish("b1");
  assert.deepEqual(started, ["a1", "b1", "c1"], "the free slot goes to user 3, not to user 1's second job");
  await finish("a1");
  assert.deepEqual(started.slice(3), ["a2"]);
  await finish("c1");
  await finish("a2");
  assert.deepEqual(started.slice(4), ["a3"]);
  await finish("a3");
  await q.idle();
});

test("queue: fair round-robin order — a user with a stack of jobs does not block newcomers", async () => {
  const { q, started, finish } = harness(1, 5);
  q.enqueue("x0", 9); // runs
  for (const id of ["a1", "a2", "a3"]) q.enqueue(id, 1);
  q.enqueue("b1", 2);
  q.enqueue("c1", 3);
  q.enqueue("b2", 2);
  // first round: one job per user (a, b, c by arrival), then the second round
  assert.deepEqual(q.order().map((w) => w.id), ["a1", "b1", "c1", "a2", "b2", "a3"]);
  assert.equal(q.position("c1"), 3);
  for (const id of ["x0", "a1", "b1", "c1", "a2", "b2", "a3"]) await finish(id);
  assert.deepEqual(started, ["x0", "a1", "b1", "c1", "a2", "b2", "a3"]);
});

test("queue: cancel removes a waiting job, aborts a running one, and a job that ignores the abort frees its slot after the grace period", async () => {
  const { q, started, signals } = harness(1);
  q.enqueue("r1", 1);
  q.enqueue("w1", 2);
  q.enqueue("w2", 3);
  assert.equal(q.cancel("w1"), "queued");
  assert.equal(q.has("w1"), false);
  assert.equal(q.cancel("r1"), "running");
  assert.equal(signals.get("r1")!.aborted, true);
  assert.equal(q.isAborted("r1"), true);
  // r1 never resolves: after 50 ms the slot is released anyway
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(started, ["r1", "w2"]);
  assert.equal(q.cancel("nope"), null);
});

test("job signal: cancelling kills the running child process (spawned deep inside the pipeline) right away", async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const run = withJobSignal(ac.signal, async () => {
    assert.equal(jobSignal(), ac.signal);
    await new Promise((r) => setTimeout(r, 10)); // still the same job after an await
    return runProcess(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  });
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(run, /failed to start|abort/i);
  assert.ok(Date.now() - t0 < 10_000, "the 60 s child was killed");
  assert.equal(jobSignal(), undefined, "outside a job there is no signal (CLI unchanged)");
});

test("progress lines → stage and overall percent (monotonic, render share by output)", () => {
  let s = { stage: "start" as const, pct: 0 } as Parameters<typeof parseStage>[1];
  const seen: string[] = [];
  for (const line of ["▸ подготовка видео…", "▸ анализ речи… (60 с видео)", "▸ план…", "▸ план готов: 2 выход(ов)\n• reel_1…", "▸ нарезка…", "▸ рендер reel_1 (1/2)…", "▸ рендер reel_1 (1/2) 50%…", "▸ рендер reel_2 (2/2) 75%…", "▸ подготовка видео…"]) {
    s = parseStage(line, s);
    seen.push(`${s.stage}:${s.pct}`);
  }
  assert.deepEqual(seen, ["prepare:8", "understand:20", "plan:40", "plan:50", "cut:58", "render:60", "render:69", "render:91", "prepare:91"]);
  assert.equal(parseStage("▸ рендер reel_2 (2/2) 75%…", { stage: "cut", pct: 58 }).renderPct, 88);
  assert.deepEqual(parseStage("▸ звук…", { stage: "render", pct: 70 }), { stage: "audio", pct: 92 });
  assert.deepEqual(parseStage("что-то непонятное", { stage: "plan", pct: 40 }), { stage: "plan", pct: 40 });
});

test("bot: 🛑 on a waiting card cancels it (credits back), 🛑 on a running card aborts the pipeline; queue positions are shown and updated", async () => {
  const tg = fakeTelegram();
  const started: string[] = [];
  const g = gate();
  const bot = await createBot({
    token: "t",
    workspace: await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s19q-")),
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    onboarding: false,
    plan: { standardPerDay: 0, creditsStandard: 1 },
    maxJobs: 1,
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    make: async (a) => {
      started.push(a.topic);
      await Promise.race([g.p, new Promise((r) => a.signal.addEventListener("abort", r))]);
      return { jobId: "20261016-x", outputs: [] };
    },
  });
  await bot.handleUpdate(tg.text(1, "/start"));
  bot.db.addCredits(1, 5);
  await bot.handleUpdate(tg.text(1, "/make первая"));
  await bot.handleUpdate(tg.text(2, "/start"));
  bot.db.addCredits(2, 1);
  await bot.handleUpdate(tg.text(2, "/make вторая"));
  const card2 = tg.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === 2 && String(c.params.text).startsWith("✨"))!;
  const card2Id = tg.messageIdOf(card2)!;
  assert.match(tg.edits(2).at(-1)!, /⏳ в очереди: 1/);
  assert.equal(bot.user(2)!.credits, 0, "charged when queued");
  const job2 = bot.db.lastJob(2)!.id;
  assert.deepEqual(tg.buttons(tg.markupOf(card2Id)), [`🛑 Отменить=X:${job2}`]);
  // another user cannot cancel it
  await bot.handleUpdate(tg.press(1, `X:${job2}`, card2Id));
  assert.equal(tg.lastToast(), MSG.notYours);
  await bot.handleUpdate(tg.press(2, `X:${job2}`, card2Id));
  assert.equal(bot.db.getJob(job2)!.status, "cancelled");
  assert.equal(bot.user(2)!.credits, 1, "refunded");
  assert.match(tg.edits(2).at(-1)!, /🛑 отменено/);
  assert.deepEqual(tg.markupOf(card2Id), []);
  // the running one
  const job1 = bot.db.lastJob(1)!.id;
  await bot.handleUpdate(tg.press(1, `X:${job1}`, 1));
  await bot.idle();
  assert.equal(bot.db.getJob(job1)!.status, "cancelled");
  assert.deepEqual(started, ["первая"]);
  assert.equal(bot.user(1)!.credits, 5, "a cancelled running job is refunded too");
  bot.close();
});

test("restart: a job that was running is failed (refunded, user told, retry button); waiting jobs run again", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s19q-restart-"));
  const db = new BotDb(path.join(workspace, "_bot", "vedit.db"));
  db.touchUser(5, {}, { onboarding: "done", credits: 0 });
  db.touchUser(6, {}, { onboarding: "done", lang: "en" });
  const iso = new Date().toISOString();
  db.insertJob({ id: "jrun", user: 5, chat_id: 5, kind: "make", class: "standard", payload: JSON.stringify({ topic: "кофе", aspect: "9:16" }), status: "running", paid_credits: 1, status_msg_id: 77, created_at: iso, started_at: iso });
  db.insertJob({ id: "jwait", user: 6, chat_id: 6, kind: "make", class: "standard", payload: JSON.stringify({ topic: "tea", aspect: "16:9" }), status: "queued", status_msg_id: 78, created_at: iso });
  db.close();
  const tg = fakeTelegram();
  const made: string[] = [];
  const bot = await createBot({ token: "t", workspace, callMethod: tg.callMethod, download: tg.download, onLog: () => {}, statusEditMs: 0, cleanupIntervalMs: 0, quotas: false, make: async (a) => (made.push(`${a.topic} ${a.aspect}`), { jobId: "20261016-r", outputs: [] }) });
  await bot.idle();
  assert.equal(bot.db.getJob("jrun")!.status, "failed");
  assert.equal(bot.user(5)!.credits, 1, "the credit of the interrupted job is back");
  assert.equal(tg.texts(5).at(-1), MSG.restarted);
  assert.deepEqual(tg.buttons(tg.keyboardOf(tg.sent(5, MSG.restarted))), ["🔁 Попробовать ещё раз=R:jrun"]);
  assert.ok(tg.calls.some((c) => c.method === "editMessageText" && c.params.message_id === 77 && /✖/.test(String(c.params.text))));
  assert.deepEqual(made, ["tea 16:9"], "the waiting job ran after the restart");
  assert.equal(bot.db.getJob("jwait")!.status, "done");
  assert.ok(tg.calls.some((c) => c.method === "editMessageText" && c.params.message_id === 78 && /✅ done/.test(String(c.params.text))), "its old card is reused, in the user's language");
  await bot.handleUpdate(tg.press(5, "R:jrun", 1));
  await bot.idle();
  assert.deepEqual(made, ["tea 16:9", "кофе 9:16"]);
  bot.close();
});
