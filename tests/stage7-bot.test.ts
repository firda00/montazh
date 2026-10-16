// Telegram bot against a fake Bot API (injected callMethod + download) and a fake pipeline —
// no network, no ffmpeg/whisper/renderer. VEDIT_WORKSPACE is set before the dynamic imports.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bot-ws-"));

const { startBot, HINTS, MSG } = await import("../src/bot/index.ts");
const { callMethod, TelegramError } = await import("../src/bot/telegram-api.ts");
const { PlanError } = await import("../src/plan/backend/types.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type PipelineFn = import("../src/bot/index.ts").PipelineFn;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;
type TgUpdate = import("../src/bot/telegram-api.ts").TgUpdate;

interface Call {
  method: string;
  params: Record<string, unknown>;
}

function fakeTelegram(fileSize = 1000, firstUpdateId = 1) {
  const calls: Call[] = [];
  const queue: TgUpdate[] = [];
  let wake: (() => void) | null = null;
  let nextUpdate = firstUpdateId;
  let nextMsg = 1;
  const callMethodFake: CallMethod = async <T,>(_token: string, method: string, params: Record<string, unknown> = {}, opts: { signal?: AbortSignal } = {}) => {
    if (method === "getUpdates") {
      for (;;) {
        const pending = queue.filter((u) => u.update_id >= (params.offset as number));
        if (pending.length) return pending as T;
        await new Promise<void>((resolve, reject) => {
          wake = resolve;
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
    }
    calls.push({ method, params });
    if (method === "getFile") return { file_id: params.file_id, file_size: fileSize, file_path: `videos/${params.file_id}.mp4` } as T;
    if (method === "sendChatAction") return true as T;
    return { message_id: nextMsg++, chat: { id: params.chat_id, type: "private" } } as T;
  };
  const downloads: string[] = [];
  const download = async (_token: string, _file: unknown, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "fake-mp4");
    downloads.push(dest);
  };
  const push = (u: Omit<TgUpdate, "update_id">) => {
    queue.push({ update_id: nextUpdate++, ...u });
    const w = wake;
    wake = null;
    w?.();
  };
  const text = (chatId: number, userId: number, t: string) => push({ message: { message_id: nextUpdate, chat: { id: chatId, type: "private" }, from: { id: userId }, text: t } });
  const video = (chatId: number, userId: number, fileId: string, size = fileSize) =>
    push({ message: { message_id: nextUpdate, chat: { id: chatId, type: "private" }, from: { id: userId }, video: { file_id: fileId, file_size: size, mime_type: "video/mp4" } } });
  // new messages and edits of progress cards, in order
  const messages = (chatId?: number) => calls.filter((c) => (c.method === "sendMessage" || c.method === "editMessageText") && (chatId === undefined || c.params.chat_id === chatId)).map((c) => String(c.params.text));
  // finished reels: documents by default (/send file), videos with /send video
  const videos = () => calls.filter((c) => c.method === "sendVideo" || (c.method === "sendDocument" && /\.mp4$/i.test((c.params.document as File | undefined)?.name ?? "")));
  return { calls, callMethod: callMethodFake, download, downloads, text, video, messages, videos };
}

async function waitFor(pred: () => boolean, what: string, ms = 4000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function makeOutputs(ids: string[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bot-out-"));
  const files: string[] = [];
  for (const id of ids) {
    const f = path.join(dir, `output_${id}.mp4`);
    await fs.writeFile(f, `video ${id}`);
    files.push(f);
  }
  return files;
}

async function boot(tg: ReturnType<typeof fakeTelegram>, extra: Partial<BotOptions> = {}) {
  const workspace = extra.workspace ?? (await fs.mkdtemp(path.join(os.tmpdir(), "vedit-bot-")));
  const logs: string[] = [];
  // stage 7–18 behaviour: no registration, no quotas, every card edit visible at once
  const running = await startBot({ token: "TEST", workspace, callMethod: tg.callMethod, download: tg.download, onLog: (l) => logs.push(l), pollTimeout: 1, onboarding: false, quotas: false, statusEditMs: 0, cleanupIntervalMs: 0, ...extra });
  return { running, workspace, logs };
}

test("/start shows the main menu (inline buttons under the message); /help replies with help", async () => {
  const tg = fakeTelegram();
  const { running } = await boot(tg, { pipeline: async () => assert.fail("pipeline must not run") });
  tg.text(1, 1, "/start");
  await waitFor(() => tg.messages(1).length === 1, "menu");
  assert.equal(tg.messages(1)[0], MSG.menuText);
  const kb = tg.calls.find((c) => c.method === "sendMessage")!.params.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] };
  assert.deepEqual(kb.inline_keyboard.flat().map((b) => b.text), Object.values(MSG.menu));
  assert.ok(kb.inline_keyboard.flat().every((b) => b.callback_data.startsWith("H:")));
  tg.text(1, 1, "/help");
  await waitFor(() => tg.messages(1).length === 2, "help");
  assert.equal(tg.messages(1)[1], MSG.help);
  assert.match(tg.messages(1)[1], /\/revise/);
  await running.stop();
});

test("a text without a video asks for a video", async () => {
  const tg = fakeTelegram();
  let ran = false;
  const { running } = await boot(tg, { pipeline: async () => ((ran = true), { jobId: "x", outputs: [] }) });
  tg.text(2, 2, "3 рилса по 30 секунд");
  await waitFor(() => tg.messages(2).length === 1, "reply");
  assert.equal(tg.messages(2)[0], MSG.needVideo);
  assert.equal(ran, false);
  await running.stop();
});

test("video then text: runs the pipeline, posts progress, sends outputs in order as files (no recompression) with captions", async () => {
  const tg = fakeTelegram();
  const files = await makeOutputs(["reel_1", "reel_2", "sq_1"]);
  const seen: PipelineArgs[] = [];
  const pipeline: PipelineFn = async (args) => {
    seen.push(args);
    args.onJob("20261011-aaaaaa");
    await args.progress("▸ анализ речи…");
    await args.progress("▸ план…");
    return {
      jobId: "20261011-aaaaaa",
      reasoning: "Взял самые живые фразы про кофе и самсу.",
      outputs: [
        { id: "reel_1", file: files[0], duration: 29.8, aspect: "9:16" },
        { id: "reel_2", file: files[1], duration: 30.2, aspect: "9:16" },
        { id: "sq_1", file: files[2], duration: 15, aspect: "1:1" },
      ],
    };
  };
  const { running, workspace } = await boot(tg, { pipeline });
  tg.video(3, 3, "FILE-abc_1");
  await waitFor(() => tg.messages(3).length === 1, "video saved");
  assert.equal(tg.messages(3)[0], MSG.videoSaved);
  const src = path.join(workspace, "users", "3", "uploads", "FILE-abc_1.mp4");
  assert.deepEqual(tg.downloads, [src]);

  tg.text(3, 3, "3 рилса по 30 секунд");
  await waitFor(() => tg.videos().length === 3 && tg.messages(3).some((m) => m.startsWith("Готово")), "videos sent");
  await running.bot.idle();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, src);
  assert.equal(seen[0].instruction, "3 рилса по 30 секунд");
  assert.equal(seen[0].preset, "bold_pop");
  const msgs = tg.messages(3);
  assert.ok(msgs.some((m) => m.includes("▸ анализ речи…")) && msgs.some((m) => m.includes("▸ план…")), "progress on the card");
  assert.ok(msgs.findIndex((m) => m.includes("▸ план…")) < msgs.findIndex((m) => m.startsWith("Готово")));
  // one card, edited in place: progress bar, then «готово» without the cancel button
  const edits = tg.calls.filter((c) => c.method === "editMessageText");
  assert.ok(edits.length >= 3 && new Set(edits.map((c) => c.params.message_id)).size === 1);
  assert.match(String(edits.find((c) => String(c.params.text).includes("▸ план…"))!.params.text), /[▓░]{10} \d+% · план/);
  assert.match(String(edits.at(-1)!.params.text), /✅ готово/);

  const sent = tg.videos();
  assert.ok(sent.every((c) => c.method === "sendDocument"), "default /send file: documents, not videos");
  assert.deepEqual(
    sent.map((c) => (c.params.document as File).name),
    ["20261011-aaaaaa_reel_1.mp4", "20261011-aaaaaa_reel_2.mp4", "20261011-aaaaaa_sq_1.mp4"],
  );
  assert.ok(sent.every((c) => c.params.document instanceof Blob && c.params.chat_id === 3 && c.params.disable_content_type_detection === true));
  assert.equal(await (sent[0].params.document as File).text(), "video reel_1");
  assert.match(String(sent[0].params.caption), /^reel_1 · 29\.8 с · 9:16\n«Взял самые живые фразы/);
  assert.match(String(sent[2].params.caption), /^sq_1 · 15\.0 с · 1:1/);
  assert.ok(tg.calls.some((c) => c.method === "sendChatAction" && c.params.action === "upload_document"));
  await running.stop();
});

test("a second task while busy waits in the queue (max 2 waiting); /cancel stops the running one and drops the waiting ones", async () => {
  const tg = fakeTelegram();
  const gate = deferred();
  let runs = 0;
  let aborted = false;
  const pipeline: PipelineFn = async (args) => {
    runs++;
    args.signal.addEventListener("abort", () => (aborted = true));
    args.onJob("20261011-cccccc"); // /revise below waits for this job
    await args.progress("▸ анализ речи…");
    await gate.promise;
    return { jobId: "j", outputs: [] };
  };
  const { running } = await boot(tg, { pipeline, maxJobs: 1 });
  tg.video(4, 4, "V1");
  tg.text(4, 4, "первая задача");
  await waitFor(() => tg.messages(4).some((m) => m.includes("▸ анализ речи…")), "pipeline started");
  assert.ok(running.bot.isBusy(4));
  tg.text(4, 4, "вторая задача");
  await waitFor(() => tg.messages(4).some((m) => m.includes(MSG.stage.queued(1))), "queued card");
  tg.text(4, 4, "/revise убери интро");
  await waitFor(() => tg.messages(4).some((m) => m.includes(MSG.stage.queued(2))), "second waiting job");
  tg.text(4, 4, "третья задача");
  await waitFor(() => tg.messages(4).includes(MSG.busy), "the queue of one user is full");
  tg.text(4, 4, "/status");
  await waitFor(() => tg.messages(4).some((m) => m.startsWith("Сейчас: ")), "status while busy");
  const st = tg.messages(4).find((m) => m.startsWith("Сейчас"))!;
  assert.match(st, /Монтаж, шаг «понимаю видео»/);
  assert.match(st, /В очереди: 🎬 Монтаж, место 1/);
  assert.match(st, /В очереди: ✏️ Правка, место 2/);
  tg.text(4, 4, "/cancel");
  await waitFor(() => tg.messages(4).includes(MSG.cancelling), "cancelling");
  await waitFor(() => aborted, "the running pipeline got the abort signal");
  gate.resolve();
  await running.bot.idle();
  assert.equal(runs, 1);
  assert.equal(tg.messages(4).filter((m) => m.includes(MSG.stage.cancelled)).length, 3, "all three cards say «отменено»");
  assert.equal(running.bot.isBusy(4), false);
  await running.stop();
});

test("unauthorized user ids are ignored when allowedUserIds is set", async () => {
  const tg = fakeTelegram();
  const { running, logs } = await boot(tg, { allowedUserIds: [10], pipeline: async () => assert.fail("pipeline must not run") });
  tg.text(20, 20, "/start");
  tg.video(20, 20, "INTRUDER");
  tg.text(10, 10, "/start");
  await waitFor(() => tg.messages(10).length === 1, "allowed user served");
  assert.equal(tg.messages(20).length, 0);
  assert.equal(tg.downloads.length, 0);
  assert.equal(tg.calls.filter((c) => c.params.chat_id === 20).length, 0);
  assert.ok(logs.some((l) => /20 не в TELEGRAM_ALLOWED_USERS/.test(l)));
  await running.stop();
});

test("PlanError 'budget' is reported with the hint and the bot keeps handling updates", async () => {
  const tg = fakeTelegram();
  let n = 0;
  const pipeline: PipelineFn = async () => {
    n++;
    if (n === 1) throw new PlanError("превышен бюджет планирования $1.50\nподробности в plan.json", "budget");
    throw new Error("ffmpeg упал\nstack…");
  };
  // the user is an admin: they get the technical error (regular users get a friendly text)
  const { running } = await boot(tg, { pipeline, adminIds: [5] });
  tg.video(5, 5, "V");
  tg.text(5, 5, "рилс");
  await waitFor(() => tg.messages(5).some((m) => m.startsWith("✖")), "error reply");
  await running.bot.idle();
  const err = tg.messages(5).find((m) => m.startsWith("✖"))!;
  assert.equal(err, `✖ план: превышен бюджет планирования $1.50\n→ ${HINTS.budget}`);

  tg.text(5, 5, "ещё раз");
  await waitFor(() => tg.messages(5).includes("✖ ffmpeg упал"), "second error, first line only");
  await running.bot.idle();
  tg.text(5, 5, "/help");
  await waitFor(() => tg.messages(5).at(-1) === MSG.help, "still alive");
  assert.equal(n, 2);
  await running.stop();
});

test("a failing Bot API call inside an update does not kill the loop", async () => {
  const tg = fakeTelegram();
  const base = tg.callMethod;
  let failGetFile = true;
  const flaky: CallMethod = async (token, method, params, opts) => {
    if (method === "getFile" && failGetFile) {
      failGetFile = false;
      throw new TelegramError("getFile", "Bad Request: file is temporarily unavailable", 400);
    }
    return base(token, method, params, opts);
  };
  const { running } = await boot(tg, { callMethod: flaky, adminIds: [6], pipeline: async () => ({ jobId: "j", outputs: [] }) });
  tg.video(6, 6, "V");
  await waitFor(() => tg.messages(6).length === 1, "error reply");
  assert.match(tg.messages(6)[0], /^✖ Telegram getFile: Bad Request/);
  tg.video(6, 6, "V");
  await waitFor(() => tg.messages(6).at(-1) === MSG.videoSaved, "next update handled");
  await running.stop();
});

test("size limits: >20 MB video is refused with the local Bot API hint; >50 MB output is replied with its path", async () => {
  const tg = fakeTelegram();
  const [big] = await makeOutputs(["reel_big"]);
  // admins see the local Bot API hint; regular users only the size
  const { running } = await boot(tg, { limits: { uploadBytes: 4 }, adminIds: [7], pipeline: async () => ({ jobId: "j", outputs: [{ id: "reel_big", file: big, duration: 10 }] }) });
  tg.video(7, 7, "HUGE", 25 * 1024 * 1024);
  await waitFor(() => tg.messages(7).length === 1, "too large reply");
  assert.match(tg.messages(7)[0], /25 МБ.*до 20 МБ/);
  assert.match(tg.messages(7)[0], /TELEGRAM_API_BASE/);
  assert.equal(tg.calls.filter((c) => c.method === "getFile").length, 0);

  tg.video(7, 7, "SMALL");
  tg.text(7, 7, "рилс");
  await waitFor(() => tg.messages(7).some((m) => m.startsWith("Готово")), "done");
  assert.equal(tg.videos().length, 0);
  assert.ok(tg.messages(7).some((m) => m.includes("больше лимита отправки") && m.includes(big)));
  await running.stop();
});

test("the session (video, job, task) and the getUpdates offset live in the DB and survive a restart", async () => {
  const tg = fakeTelegram();
  const calls: PipelineArgs[] = [];
  const pipeline: PipelineFn = async (args) => {
    calls.push(args);
    args.onJob("20261011-bbbbbb");
    return { jobId: "20261011-bbbbbb", outputs: [] };
  };
  const first = await boot(tg, { pipeline });
  tg.video(8, 8, "SRC");
  tg.text(8, 8, "2 рилса по 20 секунд");
  await waitFor(() => tg.messages(8).some((m) => m.startsWith("Новых роликов нет")), "pipeline finished");
  await first.running.bot.idle();
  await first.running.stop();
  const saved = { offset: first.running.bot.offset, session: first.running.bot.session(8) };
  first.running.bot.close();
  assert.ok(await fs.stat(path.join(first.workspace, "_bot", "vedit.db")));
  assert.equal(saved.session.source, path.join(first.workspace, "users", "8", "uploads", "SRC.mp4"));
  assert.equal(saved.session.jobId, "20261011-bbbbbb");
  assert.equal(saved.session.prompt, "2 рилса по 20 секунд");
  assert.ok(saved.offset >= 2);

  // a fresh bot over the same workspace remembers the source video and the job
  const tg2 = fakeTelegram(1000, saved.offset); // update ids keep growing across restarts, as on the real server
  const second = await boot(tg2, { workspace: first.workspace, pipeline });
  assert.equal(second.running.bot.offset, saved.offset);
  assert.equal(second.running.bot.session(8).jobId, "20261011-bbbbbb");
  tg2.text(8, 8, "теперь 1 рилс");
  await waitFor(() => tg2.messages(8).some((m) => m.startsWith("Новых роликов нет")), "second run");
  await second.running.bot.idle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source, saved.session.source);
  assert.ok(!tg2.messages(8).includes(MSG.needVideo));
  tg2.text(8, 8, "/status");
  await waitFor(() => tg2.messages(8).some((m) => m.includes("job 20261011-bbbbbb")), "status");
  assert.match(tg2.messages(8).find((m) => m.includes("job 20261011-bbbbbb"))!, /не найдена/);
  await second.running.stop();
});

test("/revise runs the injected revise function on the remembered job", async () => {
  const tg = fakeTelegram();
  const [file] = await makeOutputs(["reel_1"]);
  const edits: { jobId: string; edit: string }[] = [];
  const { running } = await boot(tg, {
    pipeline: async (a) => (a.onJob("job-r"), { jobId: "job-r", outputs: [] }),
    revise: async (a) => {
      edits.push({ jobId: a.jobId, edit: a.edit });
      await a.progress("▸ правка плана…");
      return { jobId: a.jobId, outputs: [{ id: "reel_1", file, duration: 12.3 }] };
    },
  });
  tg.text(9, 9, "/revise без задачи");
  await waitFor(() => tg.messages(9).includes(MSG.reviseNoJob), "no job yet");
  tg.video(9, 9, "V");
  tg.text(9, 9, "рилс");
  await waitFor(() => tg.messages(9).some((m) => m.startsWith("Новых роликов нет")), "run done");
  await running.bot.idle();
  tg.text(9, 9, "/revise");
  await waitFor(() => tg.messages(9).includes(MSG.reviseUsage), "usage");
  tg.text(9, 9, "/revise в reel_1 убери приветствие");
  await waitFor(() => tg.videos().length === 1, "revised video sent");
  await running.bot.idle();
  assert.deepEqual(edits, [{ jobId: "job-r", edit: "в reel_1 убери приветствие" }]);
  assert.match(String(tg.videos()[0].params.caption), /^reel_1 · 12\.3 с/);
  await running.stop();
});

test("callMethod: retries 429 after retry_after, sends files as multipart, raises TelegramError with the description", async () => {
  const requests: { url: string; body: unknown }[] = [];
  const sleeps: number[] = [];
  const replies = [
    { ok: false, error_code: 429, description: "Too Many Requests: retry after 2", parameters: { retry_after: 2 } },
    { ok: true, result: { message_id: 1 } },
    { ok: false, error_code: 400, description: "Bad Request: chat not found" },
  ];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: init.body });
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  }) as unknown as typeof fetch;
  const opts = { fetch: fakeFetch, sleep: async (ms: number) => void sleeps.push(ms) };
  const video = new File([new Uint8Array([1, 2, 3])], "output_reel_1.mp4", { type: "video/mp4" });
  const r = await callMethod<{ message_id: number }>("TOKEN", "sendVideo", { chat_id: 1, video, caption: "reel_1" }, opts);
  assert.equal(r.message_id, 1);
  assert.deepEqual(sleeps, [2000]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "https://api.telegram.org/botTOKEN/sendVideo");
  const form = requests[1].body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal((form.get("video") as File).name, "output_reel_1.mp4");
  assert.equal(form.get("chat_id"), "1");
  await assert.rejects(
    () => callMethod("TOKEN", "sendMessage", { chat_id: 1, text: "x" }, opts),
    (e: unknown) => e instanceof TelegramError && e.description === "Bad Request: chat not found" && e.errorCode === 400,
  );
  assert.equal(typeof requests[2].body, "string", "plain params go as JSON");
});
