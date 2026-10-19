// Stage 24: "send video(s) → montage" bug bash. Links instead of files (Google Drive, Yandex Disk, Dropbox, direct,
// yt-dlp), the 20 MB Bot API limit message, local Bot API files, every upload form Telegram has (video note,
// animation, .MOV as octet-stream), background uploads that never block other users, one card per burst, ▶️ twice,
// /cancel of a link download, a photo during a montage, restart in the middle of a batch.
// Fake Bot API + fake pipeline; links are served by a local http server (no internet).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s24-ws-"));

const { createBot, isVideoMessage, looksLikeTask, MSG } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { classifyLink, downloadLink, findLinks, LinkError, linkKey, parseDriveConfirm, textWithoutLinks } = await import("../src/ingest/links.ts");
const { downloadFile, limitsFor, makeBotApi, TelegramError } = await import("../src/bot/telegram-api.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
const { urlHash } = await import("../src/bot/compliance.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;

const tmp = (p = "vedit-s24-") => fs.mkdtemp(path.join(os.tmpdir(), p));
const MB = 1024 * 1024;
const L = STRINGS.ru;

// ── a real small video and a local "internet" ──────────────────────────────────

const mediaDir = await tmp("vedit-s24-media-");
const clip = path.join(mediaDir, "clip.mp4");
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip]);
const clipBytes = await fs.readFile(clip);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;
const routes = new Map<string, Handler>();
const hits: string[] = [];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  hits.push(`${u.pathname}${u.search}`);
  const h = routes.get(u.pathname);
  if (!h) return void res.writeHead(404).end("no");
  await h(req, res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
after(() => server.close());

const sendVideo: Handler = (_req, res) => void res.writeHead(200, { "content-type": "video/mp4", "content-length": String(clipBytes.length) }).end(clipBytes);
routes.set("/v.mp4", sendVideo);
routes.set("/page", (_req, res) => void res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<html><body>a player</body></html>"));
routes.set("/huge.mp4", (_req, res) => void res.writeHead(200, { "content-type": "video/mp4", "content-length": String(3 * MB) }).end(Buffer.alloc(16)));
routes.set("/stream.mp4", (_req, res) => {
  // no content-length: the cap is enforced while streaming
  res.writeHead(200, { "content-type": "video/mp4" });
  for (let i = 0; i < 40; i++) res.write(Buffer.alloc(64 * 1024));
  res.end();
});
routes.set("/garbage.mp4", (_req, res) => void res.writeHead(200, { "content-type": "video/mp4" }).end(Buffer.alloc(50_000, 7)));
let releaseSlow: () => void = () => {};
routes.set("/slow.mp4", async (_req, res) => {
  res.writeHead(200, { "content-type": "video/mp4", "content-length": String(clipBytes.length) });
  res.write(clipBytes.subarray(0, 1000));
  await new Promise<void>((r) => (releaseSlow = r));
  res.end(clipBytes.subarray(1000));
});
routes.set("/stall.mp4", (_req, res) => {
  res.writeHead(200, { "content-type": "video/mp4" });
  res.write(Buffer.alloc(100)); // then nothing
});

// Google Drive: the "can't scan for viruses" page, then the file from drive.usercontent.google.com
routes.set("/gdrive/uc", (req, res) => {
  const id = new URL(req.url!, "http://x").searchParams.get("id");
  if (id === "PRIVATE1234") return void res.writeHead(200, { "content-type": "text/html" }).end('<html><title>Google Drive: Sign-in</title><a href="https://accounts.google.com/ServiceLogin?x">login</a></html>');
  res.writeHead(200, { "content-type": "text/html" }).end(
    `<html><body>Google Drive can't scan this file for viruses.<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="submit" value="Download anyway"/><input type="hidden" name="id" value="${id}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="abc-123"></form></body></html>`,
  );
});
routes.set("/gdrive-dl/download", (req, res) => {
  const q = new URL(req.url!, "http://x").searchParams;
  if (q.get("confirm") !== "t" || q.get("uuid") !== "abc-123") return void res.writeHead(400).end("bad");
  res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="IMG_0420.MOV"' }).end(clipBytes);
});
// Yandex Disk public API
routes.set("/ya/resources", (req, res) => {
  const key = new URL(req.url!, "http://x").searchParams.get("public_key") ?? "";
  if (key.includes("/d/folder")) {
    return void res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({ type: "dir", name: "trip", _embedded: { items: [{ type: "file", name: "b.mp4", path: "/b.mp4", size: clipBytes.length, media_type: "video" }, { type: "file", name: "notes.txt", path: "/notes.txt", size: 10, media_type: "document" }, { type: "file", name: "a.MOV", path: "/a.MOV", size: clipBytes.length, media_type: "video" }] } }),
    );
  }
  if (key.includes("/i/missing")) return void res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "DiskNotFoundError" }));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "file", name: "video.mp4", size: clipBytes.length, media_type: "video" }));
});
routes.set("/ya/resources/download", (req, res) => {
  const p = new URL(req.url!, "http://x").searchParams.get("path") ?? "";
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ href: `${base}/ya-file${p || "/one"}` }));
});
for (const p of ["/ya-file/one", "/ya-file/a.MOV", "/ya-file/b.mp4"]) routes.set(p, sendVideo);
routes.set("/dropbox/s/abc/clip.mp4", (req, res) => {
  if (new URL(req.url!, "http://x").searchParams.get("dl") !== "1") return void res.writeHead(200, { "content-type": "text/html" }).end("<html>preview</html>");
  sendVideo(req, res);
});

/** fetch with the cloud hosts pointed at the local server */
const routedFetch: typeof fetch = (input, init) => {
  const u = new URL(String(input instanceof Request ? input.url : input));
  let to = u.toString();
  if (u.hostname === "drive.google.com") to = `${base}/gdrive${u.pathname}${u.search}`;
  else if (u.hostname === "drive.usercontent.google.com") to = `${base}/gdrive-dl${u.pathname}${u.search}`;
  else if (u.hostname === "cloud-api.yandex.net") to = `${base}/ya${u.pathname.replace("/v1/disk/public", "")}${u.search}`;
  else if (u.hostname.endsWith("dropbox.com")) to = `${base}/dropbox${u.pathname}${u.search}`;
  return fetch(to, init);
};

const noYtdlp = async () => {
  throw new LinkError("no_ytdlp", "yt-dlp не найден");
};

// ── links: parsing ─────────────────────────────────────────────────────────────

test("links: classify Google Drive / Yandex Disk / Dropbox / platforms / direct; find links in a message", () => {
  assert.deepEqual(classifyLink("https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing"), { kind: "gdrive", url: "https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view?usp=sharing", id: "1AbCdEfGhIjKlMn" });
  assert.equal(classifyLink("https://drive.google.com/open?id=1AbCdEfGhIjKlMn")?.id, "1AbCdEfGhIjKlMn");
  assert.equal(classifyLink("https://drive.google.com/drive/folders/1xyzxyzxyzxyz")?.kind, "gdrive_folder");
  assert.equal(classifyLink("https://disk.yandex.ru/i/AbCdEf123")?.kind, "yadisk");
  assert.equal(classifyLink("https://yadi.sk/d/AbCdEf123")?.kind, "yadisk");
  assert.equal(classifyLink("https://www.dropbox.com/scl/fi/abc/IMG.MOV?rlkey=x&dl=0")?.kind, "dropbox");
  for (const u of ["https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/shorts/abc", "https://www.instagram.com/reel/Cx/", "https://vm.tiktok.com/ZM/", "https://vk.com/video-1_2"]) assert.equal(classifyLink(u)?.kind, "platform", u);
  assert.equal(classifyLink("https://example.com/files/v.mp4")?.kind, "direct");
  assert.equal(classifyLink("ftp://example.com/v.mp4"), null);
  assert.deepEqual(findLinks("вот (https://disk.yandex.ru/i/AbC), и https://youtu.be/x. сделай рилс"), ["https://disk.yandex.ru/i/AbC", "https://youtu.be/x"]);
  assert.equal(textWithoutLinks("https://youtu.be/x  сделай 2 рилса"), "сделай 2 рилса");
  assert.ok(looksLikeTask("сделай 2 рилса по 20 секунд") && looksLikeTask("один вирусный ролик") && looksLikeTask("16:9"));
  assert.ok(!looksLikeTask("вот") && !looksLikeTask("вот видео") && !looksLikeTask(""));
  assert.equal(linkKey("https://a/b"), linkKey(" https://a/b "));
});

test("links: the Google Drive virus-scan page → its 'Download anyway' URL; the old confirm link too", () => {
  const html = `<form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="hidden" name="id" value="1Ab"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="u-1"></form>`;
  assert.equal(parseDriveConfirm(html), "https://drive.usercontent.google.com/download?id=1Ab&confirm=t&uuid=u-1");
  assert.equal(parseDriveConfirm('<a href="/uc?export=download&amp;confirm=AbC1&amp;id=1Ab">Download</a>'), "https://drive.google.com/uc?export=download&confirm=AbC1&id=1Ab");
  assert.equal(parseDriveConfirm("<html>nothing</html>"), null);
});

// ── links: downloading ─────────────────────────────────────────────────────────

const dl = async (url: string, extra: Partial<import("../src/ingest/links.ts").DownloadLinkOptions> = {}) => {
  const dir = await tmp();
  return { dir, files: await downloadLink(url, dir, linkKey(url), { maxBytes: 2 * MB, fetch: routedFetch, ytdlp: noYtdlp, ...extra }) };
};
const rejectsCode = async (p: Promise<unknown>, code: string) => assert.rejects(p, (e: unknown) => e instanceof LinkError && e.code === code);

test("links: a direct video link is downloaded, size-capped, checked by ffprobe; a page / garbage / huge file is refused", async () => {
  const progress: number[] = [];
  const { files, dir } = await dl(`${base}/v.mp4`, { onProgress: (b) => progress.push(b), progressMs: 0 });
  assert.equal(files.length, 1);
  assert.equal(files[0].bytes, clipBytes.length);
  assert.match(path.basename(files[0].file), /^link_[0-9a-f]{16}\.mp4$/);
  assert.ok(progress.length >= 1);
  assert.deepEqual((await fs.readdir(dir)).filter((f) => f.endsWith(".part")), [], "no .part left");
  await rejectsCode(dl(`${base}/page`), "not_video"); // a web page and no yt-dlp
  await rejectsCode(dl(`${base}/huge.mp4`), "too_big"); // content-length over the cap
  await rejectsCode(dl(`${base}/stream.mp4`, { maxBytes: 1 * MB }), "too_big"); // no content-length: capped while streaming
  await rejectsCode(dl(`${base}/garbage.mp4`), "not_video"); // "video/mp4" that ffprobe cannot read
  await rejectsCode(dl(`${base}/nope.mp4`), "http");
  await rejectsCode(dl(`${base}/stall.mp4`, { idleMs: 300 }), "timeout");
  const ac = new AbortController();
  const p = dl(`${base}/slow.mp4`, { signal: ac.signal });
  setTimeout(() => ac.abort(), 150);
  await rejectsCode(p, "cancelled");
  releaseSlow();
});

test("links: Google Drive (confirm page of a large file), private Drive file, Drive folder", async () => {
  const { files } = await dl("https://drive.google.com/file/d/1BigFileIdXYZ/view?usp=sharing");
  assert.equal(files[0].name, "IMG_0420.MOV");
  assert.match(files[0].file, /\.mov$/i, "the extension follows the real file name");
  assert.ok(hits.some((h) => h.startsWith("/gdrive-dl/download?id=1BigFileIdXYZ")));
  await rejectsCode(dl("https://drive.google.com/file/d/PRIVATE1234/view"), "private");
  await rejectsCode(dl("https://drive.google.com/drive/folders/1xyzxyzxyzxyz"), "folder");
});

test("links: Yandex Disk file and folder (videos only, sorted), missing link; Dropbox gets dl=1; platforms go to yt-dlp", async () => {
  const one = await dl("https://disk.yandex.ru/i/AbCdEf");
  assert.equal(one.files.length, 1);
  const folder = await dl("https://disk.yandex.ru/d/folderXYZ");
  assert.deepEqual(folder.files.map((f) => f.name), ["a.MOV", "b.mp4"]);
  assert.ok(folder.files.every((f, i) => path.basename(f.file).includes(`_${i + 1}.`)));
  await rejectsCode(dl("https://disk.yandex.ru/i/missing"), "private");
  const dbx = await dl("https://www.dropbox.com/s/abc/clip.mp4?dl=0");
  assert.equal(dbx.files[0].bytes, clipBytes.length);
  await rejectsCode(dl("https://youtu.be/abc"), "no_ytdlp");
  // yt-dlp present: its file is moved next to the uploads under the link's name
  const yt = await dl("https://www.youtube.com/shorts/abc", {
    ytdlp: async (_u, dir) => {
      const f = path.join(dir, "abc.mp4");
      await fs.copyFile(clip, f);
      return [f];
    },
  });
  assert.match(path.basename(yt.files[0].file), /^link_[0-9a-f]{16}\.mp4$/);
  assert.deepEqual((await fs.readdir(yt.dir)).filter((f) => f.startsWith(".")), [], "the yt-dlp work dir is removed");
});

// ── Bot API: limits, local server ──────────────────────────────────────────────

test("Bot API: cloud 20 MB vs local server 2000 MB; a local server's absolute file_path is copied from disk", async () => {
  assert.equal(limitsFor().downloadBytes, 20 * MB);
  assert.equal(limitsFor("http://127.0.0.1:8081").downloadBytes, 2000 * MB);
  assert.equal(makeBotApi("t", { apiBase: "http://127.0.0.1:8081" }).local, true);
  assert.equal(makeBotApi("t").local, false);
  const dest = path.join(await tmp(), "copy.mp4");
  await downloadFile("t", { file_id: "x", file_path: clip }, dest, { fetch: () => assert.fail("no HTTP for a local path") });
  assert.equal((await fs.stat(dest)).size, clipBytes.length);
  // the path is not on this machine (the server runs in a container): its HTTP route is tried
  const urls: string[] = [];
  const dest2 = path.join(await tmp(), "copy2.mp4");
  await downloadFile("t", { file_id: "x", file_path: "/var/lib/telegram-bot-api/t/videos/file_1.mp4" }, dest2, { apiBase: base, fetch: (u) => (urls.push(String(u)), fetch(`${base}/v.mp4`)) });
  assert.deepEqual(urls, [`${base}/file/bott/var/lib/telegram-bot-api/t/videos/file_1.mp4`]);
});

// ── the bot ────────────────────────────────────────────────────────────────────

async function boot(extra: Partial<BotOptions> = {}, tg = fakeTelegram()) {
  const runs: PipelineArgs[] = [];
  const logs: string[] = [];
  const workspace = extra.workspace ?? (await tmp());
  const bot = await createBot({
    token: "t",
    workspace,
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: (l) => logs.push(l),
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    pipeline: async (a) => (runs.push(a), { jobId: `job${runs.length}`, outputs: [] }),
    links: { fetch: routedFetch, ytdlp: noYtdlp, progressMs: 0 },
    ...extra,
  });
  return { tg, bot, runs, logs, workspace };
}
const doc = (fileId: string, file_name: string, mime_type = "application/octet-stream", file_size = 1000) => ({ document: { file_id: fileId, file_name, mime_type, file_size } });

test("bot: menu 🎬 → one video → card → ▶️ runs on that video; ▶️ twice starts one job; more videos after the run start a new batch", async () => {
  const { tg, bot, runs } = await boot();
  await bot.handleUpdate(tg.press(1, "H:montage", 0));
  assert.match(tg.texts(1).at(-1)!, /ссылкой: Google Диск, Яндекс Диск, Dropbox или YouTube/);
  await bot.handleUpdate(tg.video(1, "V1"));
  const card = tg.messageIdOf(tg.sent(1, L.videoSaved)!)!;
  await bot.handleUpdate(tg.press(1, "M:go", card));
  await bot.handleUpdate(tg.press(1, "M:go", card)); // a double tap
  await bot.idle();
  assert.equal(runs.length, 1, "one job");
  assert.equal(tg.lastToast(), L.cardStale);
  assert.match(runs[0].source, /V1\.mp4$/);
  assert.equal(runs[0].sources, undefined);
  // after the run: a new video is a new batch with its own card
  await bot.handleUpdate(tg.video(1, "V2"));
  const card2 = tg.messageIdOf(tg.sent(1, L.videoSaved)!)!;
  assert.notEqual(card2, card);
  assert.deepEqual(bot.session(1).sources.map((f) => path.basename(f)), ["V2.mp4"]);
  bot.close();
});

test("bot: a burst of 4 files (debounced) → ONE card for 4 videos → ▶️ combines all 4; a text sent while files download waits for them", async () => {
  const tg = fakeTelegram();
  const gates = new Map<string, () => void>();
  // slow downloads: each file waits for its gate
  const download = async (t: string, f: { file_id: string }, dest: string) => {
    await new Promise<void>((r) => gates.set(f.file_id, r));
    await tg.download(t, f, dest);
  };
  const { bot, runs } = await boot({ albumDelayMs: 40, download: download as never }, tg);
  for (const id of ["A", "B", "C", "D"]) await bot.handleUpdate(tg.msg(2, 2, doc(id, `IMG_${id}.MOV`)));
  // the polling loop was not held: all four are queued, none downloaded yet
  assert.equal(bot.session(2).sources.length, 0);
  for (const id of ["A", "B", "C", "D"]) {
    while (!gates.has(id)) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 60)); // longer than the debounce: still no card while files are pending
    assert.equal(tg.texts(2).filter((x) => x.startsWith("Получено видео") || x === L.videoSaved).length, 0);
    gates.get(id)!();
  }
  await bot.idle();
  const cards = tg.texts(2).filter((x) => x.startsWith("Получено видео") || x === L.videoSaved);
  assert.deepEqual(cards, [L.batchSaved(4)], "one card for the burst");
  const card = tg.messageIdOf(tg.sent(2, L.batchSaved(4))!)!;
  await bot.handleUpdate(tg.press(2, "M:go", card));
  await bot.idle();
  assert.equal(runs.at(-1)!.sources?.length, 4);

  // video, then a task typed while it downloads: the task waits and sees the video
  await bot.handleUpdate(tg.video(2, "E"));
  await bot.handleUpdate(tg.text(2, "сделай 2 рилса по 20 секунд"));
  while (!gates.has("E")) await new Promise((r) => setTimeout(r, 2));
  gates.get("E")!();
  await bot.idle();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].instruction, "сделай 2 рилса по 20 секунд");
  assert.match(runs[1].source, /E\.mp4$/);
  assert.equal(tg.texts(2).filter((x) => x === L.videoSaved).length, 0, "no stray card after the run took the batch");
  bot.close();
});

test("bot: ▶️ pressed while another video of the batch is still downloading waits for it and takes both", async () => {
  const tg = fakeTelegram();
  let release!: () => void;
  const download = async (t: string, f: { file_id: string }, dest: string) => {
    if (f.file_id === "LATE") await new Promise<void>((r) => (release = r));
    await tg.download(t, f, dest);
  };
  const { bot, runs } = await boot({ albumDelayMs: 10, download: download as never }, tg);
  await bot.handleUpdate(tg.video(12, "FIRST"));
  await bot.idle();
  const card = tg.messageIdOf(tg.sent(12, L.videoSaved)!)!;
  await bot.handleUpdate(tg.video(12, "LATE"));
  while (!release) await new Promise((r) => setTimeout(r, 2));
  await bot.handleUpdate(tg.press(12, "M:go", card));
  assert.equal(tg.lastToast(), L.uploadsPending);
  assert.equal(runs.length, 0);
  release();
  await bot.idle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sources?.length, 2);
  bot.close();
});

test("bot: a slow upload of one user does not hold another user", async () => {
  const tg = fakeTelegram();
  let releaseA!: () => void;
  const download = async (t: string, f: { file_id: string }, dest: string) => {
    if (f.file_id === "SLOW") await new Promise<void>((r) => (releaseA = r));
    await tg.download(t, f, dest);
  };
  const { bot } = await boot({ albumDelayMs: 10, download: download as never }, tg);
  await bot.handleUpdate(tg.video(10, "SLOW"));
  await bot.handleUpdate(tg.video(11, "FAST"));
  const t0 = Date.now();
  while (!tg.texts(11).includes(L.videoSaved)) {
    assert.ok(Date.now() - t0 < 3000, "user 11 got the card while user 10 was still uploading");
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(tg.texts(10).length, 0);
  releaseA();
  await bot.idle();
  assert.ok(tg.texts(10).includes(L.videoSaved));
  bot.close();
});

test("bot: caption with a task runs at once; every Telegram video form is accepted; non-videos are refused clearly", async () => {
  const { tg, bot, runs } = await boot();
  await bot.handleUpdate(tg.video(3, "CAP", 3, { caption: "сделай один рилс 30 секунд" }));
  await bot.idle();
  assert.equal(runs[0].instruction, "сделай один рилс 30 секунд");
  // forms
  const forms = [
    { video_note: { file_id: "ROUND", length: 384, duration: 5, file_size: 1000 } },
    { animation: { file_id: "GIF", duration: 2, mime_type: "video/mp4", file_size: 1000 }, document: { file_id: "GIF", file_name: "a.gif.mp4", mime_type: "video/mp4" } },
    doc("MOV", "IMG_0001.MOV"),
    doc("NONAME", "IMG_0002"),
    doc("MKV", "clip.mkv", "video/x-matroska"),
  ];
  for (const f of forms) assert.ok(isVideoMessage({ message_id: 1, chat: { id: 3, type: "private" }, ...f } as never), JSON.stringify(f));
  assert.equal(isVideoMessage({ message_id: 1, chat: { id: 3, type: "private" }, ...doc("Z", "archive.zip") } as never), null);
  for (const f of forms) await bot.handleUpdate(tg.msg(3, 3, f));
  assert.equal(bot.session(3).sources.length, 5);
  // a PDF: a clear "not a video"; a "video" file that is really sound only: refused after ffprobe
  await bot.handleUpdate(tg.msg(3, 3, doc("PDF", "notes.pdf", "application/pdf")));
  assert.equal(tg.texts(3).at(-1), L.notVideo);
  bot.close();
  const tg2 = fakeTelegram();
  const big: CallMethod = async (tok, method, params, opts) => {
    const r = await tg2.callMethod(tok, method, params, opts);
    return (method === "getFile" ? { ...(r as object), file_size: 50_000 } : r) as never;
  };
  const b2 = await boot({ callMethod: big, probeUpload: async () => ({ video: false }) }, tg2);
  await b2.bot.handleUpdate(tg2.msg(4, 4, doc("SOUND", "voice.mp4", "video/mp4", 50_000)));
  assert.equal(tg2.texts(4).at(-1), L.notVideo);
  assert.equal(b2.bot.session(4).sources.length, 0);
  b2.bot.close();
});

test("bot: >20 MB file → the exact message with the link advice (ru/uz/en); getFile 'file is too big' without a size → the same advice", async () => {
  const { tg, bot } = await boot();
  await bot.handleUpdate(tg.msg(5, 5, { video: { file_id: "BIG", file_size: 87 * MB, mime_type: "video/mp4" } }));
  assert.equal(
    tg.texts(5).at(-1),
    "Файл 87 МБ, а Telegram даёт боту скачивать файлы только до 20 МБ — пришлите ссылку на видео (Google Диск / Яндекс Диск / Dropbox / YouTube) или сожмите видео. Ссылку просто вставьте сообщением.",
  );
  assert.match(STRINGS.uz.tooLarge(87, 20, true), /^Fayl 87 MB, Telegram esa botga faqat 20 MB gacha fayl yuklab olishga ruxsat beradi — videoga havola yuboring \(Google Disk/);
  assert.match(STRINGS.en.tooLarge(87, 20, true), /^The file is 87 MB, but Telegram lets bots download files only up to 20 MB — send a link/);
  bot.close();
  const tg2 = fakeTelegram();
  const refusing: CallMethod = async (tok, method, params, opts) => {
    if (method === "getFile") throw new TelegramError("getFile", "Bad Request: file is too big", 400);
    return tg2.callMethod(tok, method, params, opts);
  };
  const b2 = await boot({ callMethod: refusing }, tg2);
  await b2.bot.handleUpdate(tg2.msg(5, 5, doc("NOSIZE", "IMG.MOV")));
  assert.match(tg2.texts(5).at(-1)!, /^Файл больше 20 МБ, а Telegram даёт боту скачивать файлы только до 20 МБ — пришлите ссылку/);
  assert.equal(b2.bot.session(5).sources.length, 0);
  b2.bot.close();
});

test("bot: a link is an upload — progress message, card; link + task runs it; the same link twice is not re-downloaded; errors are plain words", async () => {
  const { tg, bot, runs } = await boot({ links: { fetch: routedFetch, ytdlp: noYtdlp, progressMs: 0, maxBytes: 2 * MB } });
  await bot.handleUpdate(tg.text(6, `${base}/v.mp4`));
  assert.equal(tg.texts(6)[0], L.linkStart);
  assert.deepEqual(tg.buttons(tg.keyboardOf(tg.sent(6, L.linkStart))), ["🛑 Отменить загрузку=XD"]);
  assert.ok(tg.edits(6).some((e) => e.startsWith("✅ Скачано по ссылке:")));
  assert.equal(tg.texts(6).at(-1), L.videoSaved);
  assert.equal(bot.session(6).sources.length, 1);
  const first = bot.session(6).sources[0];
  // a Drive link with a task next to it: downloaded, then the task runs on both videos
  const before = hits.length;
  await bot.handleUpdate(tg.text(6, "https://drive.google.com/file/d/1BigFileIdXYZ/view?usp=sharing сделай один вирусный ролик"));
  await bot.idle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].instruction, "сделай один вирусный ролик");
  assert.equal(runs[0].sources?.length, 2);
  assert.ok(hits.length > before);
  // the same direct link again: no second download
  const n = hits.filter((h) => h === "/v.mp4").length;
  await bot.handleUpdate(tg.text(6, `${base}/v.mp4`));
  assert.equal(hits.filter((h) => h === "/v.mp4").length, n);
  assert.equal(bot.session(6).source, first);
  // errors, as a regular user sees them (no English, no stack)
  for (const [url, msg] of [
    [`${base}/page`, L.linkNotVideo],
    [`${base}/huge.mp4`, L.linkTooBig(3, 2)],
    ["https://drive.google.com/file/d/PRIVATE1234/view", L.linkPrivate],
    ["https://drive.google.com/drive/folders/1xyzxyzxyzxyz", L.linkFolder],
    ["https://youtu.be/abc", L.linkNoYtdlp],
  ] as const) {
    // stage 30: a platform link is processed after the rights confirmation (given here up front)
    if (url.includes("youtu")) bot.db.confirmRights(6, url, urlHash(url));
    await bot.handleUpdate(tg.text(6, url));
    assert.equal(tg.edits(6).at(-1), msg, url);
  }
  bot.close();
});

test("bot: /cancel and 🛑 stop a link download; a photo during a montage is not taken for the avatar", async () => {
  const { tg, bot } = await boot({ albumDelayMs: 10 });
  await bot.handleUpdate(tg.text(7, `${base}/slow.mp4`));
  while (!tg.texts(7).includes(L.linkStart)) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 50));
  await bot.handleUpdate(tg.text(7, "/cancel"));
  await bot.idle();
  releaseSlow();
  assert.equal(tg.edits(7).at(-1), L.linkCancelled);
  assert.equal(bot.session(7).sources.length, 0);
  // 🛑 on the status message
  await bot.handleUpdate(tg.text(7, `${base}/slow.mp4?2`));
  while (tg.texts(7).filter((x) => x === L.linkStart).length < 2) await new Promise((r) => setTimeout(r, 2));
  await new Promise((r) => setTimeout(r, 50));
  await bot.handleUpdate(tg.press(7, "XD", 0));
  assert.equal(tg.lastToast(), L.linkCancelled);
  await bot.idle();
  releaseSlow();
  // photo while a montage batch is open
  await bot.handleUpdate(tg.video(7, "V"));
  await bot.idle();
  await bot.handleUpdate(tg.msg(7, 7, { photo: [{ file_id: "P", width: 90, height: 160 }] }));
  assert.equal(tg.texts(7).at(-1), L.photoInMontage);
  assert.equal(bot.session(7).avatar_photo, undefined);
  // …but in the avatar menu it is the avatar photo
  await bot.handleUpdate(tg.press(7, "H:avatar", 0));
  await bot.handleUpdate(tg.msg(7, 7, { photo: [{ file_id: "P", width: 90, height: 160 }] }));
  assert.ok(bot.session(7).avatar_photo);
  bot.close();
});

test("bot: menu 🎬 again starts a fresh card (the old one is not edited up the chat); a restart in the middle of a burst still sends the card", async () => {
  const { tg, bot, workspace } = await boot({ albumDelayMs: 60_000 });
  await bot.handleUpdate(tg.press(8, "H:montage", 0));
  await bot.handleUpdate(tg.video(8, "R1"));
  await bot.handleUpdate(tg.video(8, "R2"));
  // wait for both downloads; the card timer (60 s) is still waiting when the bot "crashes"
  while (bot.session(8).sources.length < 2) await new Promise((r) => setTimeout(r, 2));
  assert.equal(tg.texts(8).filter((x) => x.startsWith("Получено видео")).length, 0);
  bot.close();
  const tg2 = fakeTelegram();
  const again = await boot({ workspace }, tg2);
  await again.bot.idle();
  assert.deepEqual(tg2.texts(8), [L.batchSaved(2)], "the card of the open batch after the restart");
  const card = tg2.messageIdOf(tg2.sent(8, L.batchSaved(2))!)!;
  await again.bot.handleUpdate(tg2.press(8, "M:go", card));
  await again.bot.idle();
  assert.equal(again.runs[0].sources?.length, 2);
  // 🎬 again, a new video: a new card message, not an edit of the old one
  await again.bot.handleUpdate(tg2.press(8, "H:montage", 0));
  await again.bot.handleUpdate(tg2.video(8, "R3"));
  await again.bot.handleUpdate(tg2.press(8, "H:montage", 0));
  await again.bot.handleUpdate(tg2.video(8, "R4"));
  assert.equal(tg2.texts(8).filter((x) => x === L.videoSaved).length, 2);
  again.bot.close();
});

test("bot: 🏀 on a batch of several videos sends all of them (combined), not only the last", async () => {
  const { tg, bot, runs } = await boot();
  await bot.handleUpdate(tg.video(9, "G1"));
  await bot.handleUpdate(tg.video(9, "G2"));
  const card = tg.messageIdOf(tg.sent(9, L.videoSaved)!)!; // the card of the first video, edited for the second
  await bot.handleUpdate(tg.press(9, "M:m:hl", card));
  await bot.handleUpdate(tg.press(9, "M:go", card));
  await bot.idle();
  assert.equal(runs[0].sources?.length, 2);
  assert.match(runs[0].instruction, /хайлайты/);
  assert.equal(MSG.videoSaved, L.videoSaved);
  bot.close();
});

// ── formats from phones: ingest + combine ──────────────────────────────────────

test("ingest/combine: iPhone-like HEVC 10-bit HLG with rotation 90 → upright SDR BT.709; no-audio clip gets silence; cover art is not the video", async () => {
  const { ingest } = await import("../src/ingest/index.ts");
  const { combineSources } = await import("../src/ingest/combine.ts");
  const { ffprobe } = await import("../src/lib/ffmpeg.ts");
  const { createJob } = await import("../src/lib/workspace.ts");
  const dir = await tmp();
  const raw = path.join(dir, "raw.mov");
  const iphone = path.join(dir, "IMG_0001.MOV");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=1", "-f", "lavfi", "-i", "sine=duration=1", "-vf", "format=yuv420p10le", "-c:v", "libx265", "-preset", "ultrafast", "-x265-params", "log-level=error:colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc", "-color_primaries", "bt2020", "-color_trc", "arib-std-b67", "-colorspace", "bt2020nc", "-tag:v", "hvc1", "-c:a", "aac", "-shortest", raw]);
  await ffmpeg(["-display_rotation", "90", "-i", raw, "-c", "copy", iphone]);
  const silent = path.join(dir, "silent.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=180x320:rate=24:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", silent]);
  const job = await createJob(iphone, { prompt: "x", preset: "bold_pop" });
  const media = await ingest(job.id, iphone);
  assert.deepEqual([media.width, media.height], [180, 320], "upright portrait");
  const v = (await ffprobe(media.normalized_path)).streams.find((s) => s.codec_type === "video")!;
  assert.equal(v.color_transfer, "bt709", "tone-mapped to SDR, not HLG tags on 8-bit");
  assert.equal(v.pix_fmt, "yuv420p");
  const out = path.join(dir, "combined.mp4");
  const map = await combineSources([iphone, silent], out);
  assert.deepEqual(map.canvas, { width: 1080, height: 1920 });
  const p = await ffprobe(out);
  assert.ok(p.streams.some((s) => s.codec_type === "audio"), "silence for the clip without sound");
  assert.equal(p.streams.find((s) => s.codec_type === "video")!.color_transfer, "bt709");
  assert.ok(Math.abs(Number(p.format.duration) - 2) < 0.2);
});
