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
  const messages = (chatId?: number) => calls.filter((c) => c.method === "sendMessage" && (chatId === undefined || c.params.chat_id === chatId)).map((c) => String(c.params.text));
  const videos = () => calls.filter((c) => c.method === "sendVideo");
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
  const running = await startBot({ token: "TEST", workspace, callMethod: tg.callMethod, download: tg.download, onLog: (l) => logs.push(l), pollTimeout: 1, ...extra });
  return { running, workspace, logs };
}

test("/start replies with help", async () => {
  const tg = fakeTelegram();
  const { running } = await boot(tg, { pipeline: async () => assert.fail("pipeline must not run") });
  tg.text(1, 1, "/start");
  await waitFor(() => tg.messages(1).length === 1, "help");
  assert.equal(tg.messages(1)[0], MSG.help);
  assert.match(tg.messages(1)[0], /\/revise/);
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

test("video then text: runs the pipeline, posts progress, sends outputs in order with captions", async () => {
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
  const src = path.join(workspace, "_bot", "3", "FILE-abc_1.mp4");
  assert.deepEqual(tg.downloads, [src]);

  tg.text(3, 3, "3 рилса по 30 секунд");
  await waitFor(() => tg.videos().length === 3 && tg.messages(3).some((m) => m.startsWith("Готово")), "videos sent");
  await running.bot.idle();

  assert.equal(seen.length, 1);
  assert.equal(seen[0].source, src);
  assert.equal(seen[0].instruction, "3 рилса по 30 секунд");
  assert.equal(seen[0].preset, "bold_pop");
  const msgs = tg.messages(3);
  assert.ok(msgs.includes("▸ анализ речи…") && msgs.includes("▸ план…"), "progress messages");
  assert.ok(msgs.indexOf("▸ план…") < msgs.findIndex((m) => m.startsWith("Готово")));

  const sent = tg.videos();
  assert.deepEqual(
    sent.map((c) => (c.params.video as File).name),
    ["output_reel_1.mp4", "output_reel_2.mp4", "output_sq_1.mp4"],
  );
  assert.ok(sent.every((c) => c.params.video instanceof Blob && c.params.chat_id === 3 && c.params.supports_streaming === true));
  assert.equal(await (sent[0].params.video as File).text(), "video reel_1");
  assert.match(String(sent[0].params.caption), /^reel_1 · 29\.8 с · 9:16\n«Взял самые живые фразы/);
  assert.match(String(sent[2].params.caption), /^sq_1 · 15\.0 с · 1:1/);
  assert.equal(sent[1].params.duration, 30);
  assert.ok(tg.calls.some((c) => c.method === "sendChatAction" && c.params.action === "upload_video"));
  await running.stop();
});

test("a second text while busy is rejected; /cancel stops after the current step", async () => {
  const tg = fakeTelegram();
  const gate = deferred();
  let runs = 0;
  const pipeline: PipelineFn = async (args) => {
    runs++;
    await args.progress("▸ анализ речи…");
    await gate.promise;
    return { jobId: "j", outputs: [] };
  };
  const { running } = await boot(tg, { pipeline });
  tg.video(4, 4, "V1");
  tg.text(4, 4, "первая задача");
  await waitFor(() => tg.messages(4).includes("▸ анализ речи…"), "pipeline started");
  assert.ok(running.bot.isBusy(4));
  tg.text(4, 4, "вторая задача");
  await waitFor(() => tg.messages(4).includes(MSG.busy), "busy reply");
  tg.text(4, 4, "/revise убери интро");
  await waitFor(() => tg.messages(4).filter((m) => m === MSG.busy).length === 2, "busy reply for /revise");
  tg.text(4, 4, "/status");
  await waitFor(() => tg.messages(4).some((m) => m.startsWith("Сейчас: монтаж")), "status while busy");
  assert.match(tg.messages(4).find((m) => m.startsWith("Сейчас"))!, /анализ речи/);
  tg.text(4, 4, "/cancel");
  await waitFor(() => tg.messages(4).includes(MSG.cancelling), "cancelling");
  gate.resolve();
  await running.bot.idle();
  assert.equal(runs, 1);
  assert.equal(tg.messages(4).at(-1), MSG.cancelled);
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
  const { running } = await boot(tg, { pipeline });
  tg.video(5, 5, "V");
  tg.text(5, 5, "рилс");
  await waitFor(() => tg.messages(5).some((m) => m.startsWith("✖")), "error reply");
  await running.bot.idle();
  const err = tg.messages(5).find((m) => m.startsWith("✖"))!;
  assert.equal(err, `✖ план: превышен бюджет планирования $1.50\n→ ${HINTS.budget}`);

  tg.text(5, 5, "ещё раз");
  await waitFor(() => tg.messages(5).includes("✖ ffmpeg упал"), "second error, first line only");
  await running.bot.idle();
  tg.text(5, 5, "/start");
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
  const { running } = await boot(tg, { callMethod: flaky, pipeline: async () => ({ jobId: "j", outputs: [] }) });
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
  const { running } = await boot(tg, { limits: { uploadBytes: 4 }, pipeline: async () => ({ jobId: "j", outputs: [{ id: "reel_big", file: big, duration: 10 }] }) });
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

test("state.json is written and reloaded after a restart", async () => {
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

  const stateFile = path.join(first.workspace, "_bot", "state.json");
  const saved = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.chats["8"].source, path.join(first.workspace, "_bot", "8", "SRC.mp4"));
  assert.equal(saved.chats["8"].jobId, "20261011-bbbbbb");
  assert.equal(saved.chats["8"].prompt, "2 рилса по 20 секунд");
  assert.ok(saved.offset >= 2);

  // a fresh bot over the same workspace remembers the source video and the job
  const tg2 = fakeTelegram(1000, saved.offset); // update ids keep growing across restarts, as on the real server
  const second = await boot(tg2, { workspace: first.workspace, pipeline });
  assert.equal(second.running.bot.state.chats["8"].jobId, "20261011-bbbbbb");
  tg2.text(8, 8, "теперь 1 рилс");
  await waitFor(() => tg2.messages(8).some((m) => m.startsWith("Новых роликов нет")), "second run");
  await second.running.bot.idle();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].source, saved.chats["8"].source);
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
