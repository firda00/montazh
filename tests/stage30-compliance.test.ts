// Stage 30, compliance (not evasion): third-party links need a stored rights confirmation; /takedown deletes a job's
// files and blocks its URL for good (any URL form of the same video); dubbed results say «Неофициальный перевод»;
// the legal drafts say what the bot does; the error hints name GEMINI_API_KEY too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30c-ws-"));

const { createBot, HINTS } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { canonicalLink, creditLine, needsRights, takedown, urlHash } = await import("../src/bot/compliance.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { WORKSPACE_ROOT } = await import("../src/lib/workspace.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");

const L = STRINGS.ru;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30c-"));

test("links: which need a rights confirmation; one hash for every URL form of a video; the credit line", () => {
  for (const u of ["https://www.youtube.com/watch?v=abc", "https://youtu.be/abc", "https://www.tiktok.com/@x/video/123", "https://www.instagram.com/reel/XYZ/", "https://vk.com/video1_2", "https://rutube.ru/video/1/"]) assert.equal(needsRights(u), true, u);
  for (const u of ["https://drive.google.com/file/d/1abcdefghijk/view", "https://disk.yandex.ru/i/abc", "https://www.dropbox.com/s/a/v.mp4?dl=0", "https://example.com/v.mp4"]) assert.equal(needsRights(u), false, u);
  const forms = ["https://www.youtube.com/watch?v=abc&t=10s&si=TRACK", "https://youtu.be/abc", "https://m.youtube.com/watch?v=abc", "https://www.youtube.com/shorts/abc"];
  assert.equal(new Set(forms.map(urlHash)).size, 1, forms.map(canonicalLink).join(" | "));
  assert.notEqual(urlHash("https://youtu.be/abc"), urlHash("https://youtu.be/abd"));
  assert.equal(creditLine({ url: "https://youtu.be/abc", title: "Фильм", channel: "Студия" }, "Источник"), "📎 Источник: «Фильм» — Студия · https://youtu.be/abc");
  assert.equal(creditLine({ url: "https://youtu.be/abc" }, "Source"), "📎 Source: https://youtu.be/abc");
  assert.equal(creditLine({ url: "https://x", title: "T", license: "Creative Commons Attribution license (reuse allowed)" }, "Источник"), "📎 Источник: «T» · https://x (Creative Commons Attribution license (reuse allowed))");
});

test("db: rights confirmations (user, url, time), the URL blocklist, link metadata", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  const u = "https://youtu.be/abc";
  assert.equal(db.hasRights(5, urlHash(u)), false);
  db.confirmRights(5, u, urlHash(u));
  assert.equal(db.hasRights(5, urlHash(u)), true);
  assert.equal(db.hasRights(6, urlHash(u)), false, "per user");
  const r = db.rightsOf(5)[0];
  assert.equal(r.url, u);
  assert.ok(Date.parse(r.created_at) > 0);
  db.blockUrl({ url_hash: urlHash(u), url: u, job: "j1", reason: "жалоба", by: 1 });
  db.blockUrl({ url_hash: urlHash(u), url: u });
  assert.equal(db.isBlocked(urlHash("https://www.youtube.com/watch?v=abc")), true);
  assert.equal(db.blockedUrls()[0].reason, "жалоба", "a repeated block keeps the first reason");
  db.putLinkMeta({ url_hash: "h", url: u, title: "T" });
  db.putLinkMeta({ url_hash: "h", url: u, channel: "C" });
  assert.deepEqual([db.linkMeta("h")?.title, db.linkMeta("h")?.channel], ["T", "C"]);
  db.close();
});

test("takedown(): a job's folder, its source files and the dubbed copies are deleted, the job is purged, its links blocked; paths outside the workspace are never touched", async () => {
  const usersDir = await tmp();
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  const vj = "20261019-abc123";
  const vdir = path.join(WORKSPACE_ROOT, vj);
  await fs.mkdir(vdir, { recursive: true });
  await fs.writeFile(path.join(vdir, "output_reel_1.mp4"), "x");
  await fs.writeFile(path.join(vdir, "output_reel_1_ru.mp4"), "x");
  const src = path.join(usersDir, "5", "uploads", "link_aaaa.mp4");
  await fs.mkdir(path.dirname(src), { recursive: true });
  await fs.writeFile(src, "video");
  const outside = path.join(await tmp(), "not-ours.mp4");
  await fs.writeFile(outside, "keep");
  const url = "https://www.youtube.com/watch?v=FILM01";
  db.insertJob({ id: "jA", user: 5, chat_id: 5, kind: "run", class: "long", status: "done", vedit_job: vj, payload: JSON.stringify({ source: src, sources: [outside], links: [{ url, hash: urlHash(url) }] }) });
  db.insertJob({ id: "jB", user: 5, chat_id: 5, kind: "revise", class: "standard", status: "done", vedit_job: vj, payload: JSON.stringify({ jobId: vj }) });
  const r = await takedown({ db, target: "jA", jobsRoot: WORKSPACE_ROOT, usersDir, by: 1, reason: "DMCA" });
  assert.deepEqual(r.jobs.sort(), ["jA", "jB"], "the revision of the same pipeline job too");
  assert.equal(await fs.stat(vdir).then(() => true, () => false), false);
  assert.equal(await fs.stat(src).then(() => true, () => false), false);
  assert.equal(await fs.readFile(outside, "utf8"), "keep", "outside the users' folder: untouched");
  assert.deepEqual(r.blocked, [urlHash(url)]);
  assert.equal(db.isBlocked(urlHash("https://youtu.be/FILM01")), true);
  assert.equal(db.getJob("jA")?.purged, 1);
  // by URL: blocks it and finds the jobs made from it
  db.insertJob({ id: "jC", user: 6, chat_id: 6, kind: "dub", class: "standard", status: "done", payload: JSON.stringify({ source: "/nowhere", links: [{ url: "https://youtu.be/OTHER", hash: urlHash("https://youtu.be/OTHER") }] }) });
  const r2 = await takedown({ db, target: "https://www.youtube.com/watch?v=OTHER", jobsRoot: WORKSPACE_ROOT, usersDir, by: 1 });
  assert.deepEqual(r2.jobs, ["jC"]);
  assert.equal(db.isBlocked(urlHash("https://youtu.be/OTHER")), true);
  db.close();
});

test("bot: /takedown (admins only) → files gone, the link blocked: the user's next attempt by any URL form is refused, in the reference mode too", async () => {
  const tg = fakeTelegram();
  const out = path.join(await tmp(), "output_reel_1.mp4");
  await fs.writeFile(out, "mp4");
  let downloads = 0;
  const bot = await createBot({
    token: "t",
    workspace: await tmp(),
    adminIds: [1],
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    probeUpload: async () => ({ video: true, duration: 60 }),
    links: {
      progressMs: 0,
      ytdlp: async (_u, dir) => {
        downloads++;
        const f = path.join(dir, "FILM.mp4");
        await fs.writeFile(f, "x".repeat(5000));
        return { files: [f], meta: { title: "Фильм" } };
      },
    },
    pipeline: async () => ({ jobId: "20261019-f00d00", outputs: [{ id: "reel_1", file: out, duration: 30 }] }),
  });
  const url = "https://www.youtube.com/watch?v=FILM02";
  await bot.handleUpdate(tg.text(5, `${url} нарежь лучшие моменты в 3 рилса`));
  await bot.handleUpdate(tg.press(5, "RC:ok", tg.messageIdOf(tg.sent(5, /с чужой платформы/)!)!));
  await bot.idle();
  const job = bot.db.jobsByStatus("done")[0];
  assert.ok(job, "the task next to the link ran after the confirmation");
  assert.match(tg.texts(5).find((t) => t.startsWith("Готово"))!, /📎 Источник: «Фильм» · https:\/\/www\.youtube\.com\/watch\?v=FILM02/);
  const src = bot.session(5).source!;
  assert.ok(await fs.stat(src));
  // not for users
  await bot.handleUpdate(tg.text(5, `/takedown ${job.id}`));
  assert.equal(tg.texts(5).at(-1), L.unknownCommand);
  await bot.handleUpdate(tg.text(1, "/takedown"));
  assert.equal(tg.texts(1).at(-1), L.s30.takedownUsage);
  await bot.handleUpdate(tg.text(1, `/takedown ${job.id} жалоба правообладателя`));
  assert.match(tg.texts(1).at(-1)!, /^🧹 Удаление по жалобе: задач 1, удалено файлов и папок \d+, заблокировано ссылок 1\.$/);
  assert.equal(await fs.stat(src).then(() => true, () => false), false, "the downloaded video is deleted");
  assert.equal(bot.db.blockedUrls()[0].reason, "жалоба правообладателя");
  // the same video again, by its short link: refused before any download or question
  const n = downloads;
  await bot.handleUpdate(tg.text(5, "https://youtu.be/FILM02"));
  await bot.idle();
  assert.equal(tg.texts(5).at(-1), L.s30.linkBlocked);
  assert.equal(downloads, n);
  // and as a style reference
  await bot.handleUpdate(tg.press(5, "H:ref", 1));
  await bot.handleUpdate(tg.text(5, "https://www.youtube.com/shorts/FILM02"));
  assert.equal(tg.texts(5).at(-1), L.s30.linkBlocked);
  await bot.handleUpdate(tg.text(1, "/takedown 20991231-nothing"));
  assert.equal(tg.texts(1).at(-1), L.s30.takedownNothing("20991231-nothing"));
  bot.close();
});

test("legal drafts (ru/uz/en): user warrants rights, confirmation of third-party links, no cookies/DRM, unofficial translation without voice cloning, we don't publish, takedown process, 7-day retention, non-commercial beta", async () => {
  const docs = fileURLToPath(new URL("../docs/legal/", import.meta.url));
  const want: Record<string, RegExp[]> = {
    ru: [/гарантируете/, /Я подтверждаю, что у меня есть права/, /cookies/, /DRM/, /Неофициальный перевод/, /не клонируем голоса третьих лиц/, /не публикуем/, /takedown/, /72 часов/, /7 дней/, /некоммерческая бета/],
    uz: [/kafolat berasiz/, /huquqim borligini/, /cookies/, /DRM/, /Norasmiy tarjima/, /klonlamaymiz/, /e’lon qilmaymiz/, /takedown/, /72 soat/, /7 kundan/, /notijorat beta/],
    en: [/you warrant/, /I confirm that I have the rights/, /cookies/, /DRM/, /Unofficial translation/, /never clone third parties’ voices/, /do not publish/, /takedown/, /72 hours/, /7 days/, /non-commercial beta/],
  };
  for (const [lang, res] of Object.entries(want)) {
    const terms = await fs.readFile(path.join(docs, `terms.${lang}.md`), "utf8");
    for (const re of res) assert.match(terms, re, `terms.${lang}: ${re}`);
    const privacy = await fs.readFile(path.join(docs, `privacy.${lang}.md`), "utf8");
    assert.match(privacy, /\/takedown/, `privacy.${lang}`);
    assert.match(privacy, /yt-dlp/, `privacy.${lang}`);
  }
  // the onboarding summary mentions it too
  assert.match(L.terms(7), /только с правами или для обзора, цитаты, обучения/);
  assert.match(L.terms(7), /«Неофициальный перевод»/);
});

test("error hints name GEMINI_API_KEY next to ANTHROPIC_API_KEY", () => {
  assert.match(HINTS.no_backend!, /GEMINI_API_KEY/);
  assert.match(HINTS.auth!, /GEMINI_API_KEY/);
  assert.match(HINTS.auth!, /ANTHROPIC_API_KEY/);
});
