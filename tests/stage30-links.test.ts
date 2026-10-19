// Stage 30: a YouTube / TikTok / Instagram link as the starting point. Stubbed yt-dlp (no network): rights
// confirmation first → download → the link card (✂️ best moments, 🎯 edit mine like this, 🌐 Russian version,
// 🧑 avatar with this script + the usual modes) → each flow with fake pipelines; a 1.5-hour podcast is a long job;
// the credit line «📎 Источник» and «Неофициальный перевод» reach the delivered message.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30l-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { LinkError, parseYtDlpMeta, ytDlpArgs } = await import("../src/ingest/links.ts");
const { urlHash } = await import("../src/bot/compliance.ts");
const { StyleProfileSchema } = await import("../src/style/profile.ts");
const { DEFAULT_DNA } = await import("../src/style/dna.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;
type DubArgs = import("../src/bot/pipelines.ts").DubArgs;
type DubOutputsArgs = import("../src/bot/pipelines.ts").DubOutputsArgs;
type AvatarFromVideoArgs = import("../src/bot/pipelines.ts").AvatarFromVideoArgs;

const L = STRINGS.ru;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30l-"));
const YT = "https://www.youtube.com/watch?v=PODCAST01";
const META = { title: "Большой подкаст о технологиях", channel: "Tech Talks", url: YT, duration: 5400 };

async function boot(extra: Partial<BotOptions> & { seconds?: number; ytError?: Error } = {}) {
  const tg = fakeTelegram();
  const runs: PipelineArgs[] = [];
  const dubs: DubArgs[] = [];
  const dubOuts: DubOutputsArgs[] = [];
  const avatars: AvatarFromVideoArgs[] = [];
  const styles: { file?: string; url?: string }[] = [];
  const yt: string[] = [];
  const out = path.join(await tmp(), "output_reel_1.mp4");
  await fs.writeFile(out, "mp4");
  const { seconds, ytError, ...rest } = extra;
  const bot = await createBot({
    token: "t",
    workspace: await tmp(),
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    probeUpload: async () => ({ video: true, duration: seconds ?? 5400 }),
    links: {
      progressMs: 0,
      ytdlp: async (url, dir) => {
        yt.push(url);
        if (ytError) throw ytError;
        const f = path.join(dir, "PODCAST01.mp4");
        await fs.writeFile(f, "x".repeat(5000));
        return { files: [f], meta: { ...META, url } };
      },
    },
    pipeline: async (a) => (runs.push(a), { jobId: "20261019-aaaaaa", outputs: [{ id: "reel_1", file: out, duration: 30, aspect: "9:16" }], reasoning: "лучшие моменты" }),
    dub: async (a) => (dubs.push(a), { jobId: "20261019-dddddd", outputs: [{ id: `dub_${a.lang}`, file: out, duration: 5400 }], reasoning: "ru · 900 фраз" }),
    dubOutputs: async (a) => (dubOuts.push(a), { outputs: a.outputs.map((o) => ({ ...o, id: `${o.id}_${a.lang}` })), summary: "Неофициальный перевод · ru", notes: [] }),
    avatarFromVideo: async (a) => (avatars.push(a), { jobId: "20261019-eeeeee", outputs: [], message: "avatar bundle" }),
    styleExtract: async (input, o) => {
      styles.push({ file: input.file, url: input.url });
      assert.ok(input.file && (await fs.stat(input.file)), "a copy of the downloaded video is analysed");
      const profile = StyleProfileSchema.parse({ key: "s".repeat(64), source: { kind: "telegram", name: "ref.mp4" }, created_at: new Date().toISOString(), dna: { ...structuredClone(DEFAULT_DNA), style_summary: "Быстрые склейки." }, measured: { duration: 30, cuts: [], total_cuts: 0, asl: 30, hook_cuts: 0, hook_asl: 0, body_asl: 30, speech: { words: 0, language: "ru", wpm: 0, pause_median_ms: 0, pause_p90_ms: 0, long_pauses_per_min: 0, speech_ratio: 0, fillers: 0 }, audio: { speech_lufs: -16, gap_lufs: null, music_likely: false }, picture: { yavg: 120, yrange: 170, satavg: 52, width: 1080, height: 1920 } } });
      return { profile, cached: false, file: await o.cache.put(profile, []) };
    },
    ...rest,
  });
  return { tg, bot, runs, dubs, dubOuts, avatars, styles, yt };
}

/** sends the link, confirms the rights, returns the card */
async function linkCard(b: Awaited<ReturnType<typeof boot>>, uid: number, url = YT) {
  await b.bot.handleUpdate(b.tg.text(uid, url));
  const ask = b.tg.sent(uid, /с чужой платформы/)!;
  await b.bot.handleUpdate(b.tg.press(uid, "RC:ok", b.tg.messageIdOf(ask)!));
  await b.bot.idle();
  return b.tg.sent(uid, /Видео по ссылке получено/)!;
}

test("yt-dlp: public content only (no cookies, no login, no user config), metadata line parsed", () => {
  const args = ytDlpArgs(YT, "/tmp/x", 2048 * 1024 * 1024);
  for (const f of ["--ignore-config", "--no-cookies", "--no-cookies-from-browser", "--no-playlist"]) assert.ok(args.includes(f), f);
  assert.ok(!args.some((a) => /^--cookies(-from-browser)?$|^--username$|^--password$|^--netrc/.test(a)));
  assert.ok(args.includes("after_move:%(.{title,channel,uploader,webpage_url,license,duration,extractor})j"));
  assert.deepEqual(parseYtDlpMeta('{"title":"T","uploader":"U","webpage_url":"https://x","duration":12.5,"license":null}'), { title: "T", channel: "U", url: "https://x", license: undefined, extractor: undefined, duration: 12.5 });
  assert.equal(parseYtDlpMeta("not json"), undefined);
});

test("a platform link: the rights question first (nothing downloaded), «✅ Подтверждаю» → download → the link card with ✂️ 🎯 🌐 🧑 + the usual modes; the same link later is not asked again; «Отмена» drops it", async () => {
  const b = await boot();
  const { tg, bot, yt } = b;
  await bot.handleUpdate(tg.text(3, YT));
  const ask = tg.sent(3, /с чужой платформы/)!;
  assert.equal(ask.params.text, L.s30.rightsAsk(1));
  assert.match(String(ask.params.text), /«Я подтверждаю, что у меня есть права на это видео или я использую его в допустимых целях \(обзор, цитата, обучение\)»/);
  assert.deepEqual(tg.buttons(tg.keyboardOf(ask)), ["✅ Подтверждаю=RC:ok", "Отмена=RC:no"]);
  assert.equal(yt.length, 0, "nothing is downloaded before the confirmation");
  await bot.handleUpdate(tg.press(3, "RC:ok", tg.messageIdOf(ask)!));
  await bot.idle();
  assert.equal(tg.edits(3).find((e) => e === L.s30.rightsOk), L.s30.rightsOk);
  assert.equal(bot.db.hasRights(3, urlHash(YT)), true);
  assert.deepEqual(bot.db.rightsOf(3).map((r) => r.url), [YT], "who, which link, when — stored");
  assert.equal(yt.length, 1);
  const card = tg.sent(3, /Видео по ссылке получено/)!;
  assert.equal(card.params.text, L.s30.linkCard(META.title));
  const kb = tg.buttons(tg.keyboardOf(card));
  assert.deepEqual(kb.slice(0, 4), ["✂️ Нарезка лучших моментов=LK:cut", "🎯 Смонтировать мой ролик так же=LK:ref", "🌐 Русская версия=D:open", "🧑 Аватар по этому сценарию=LK:av"]);
  assert.ok(kb.includes("✓ Рилсы из лучших моментов=M:m:reels") && kb.includes("Один вирусный ролик=M:m:viral") && kb.includes("🌐 Озвучить на русском=M:d") && kb.at(-1) === "▶️ Начать=M:go");
  // the same video by another URL form: confirmed already (the canonical video), so no second question
  await bot.handleUpdate(tg.text(3, "https://youtu.be/PODCAST01"));
  await bot.idle();
  assert.equal(tg.texts(3).filter((t) => t === L.s30.rightsAsk(1)).length, 1, "not asked again (same canonical video)");
  // «Отмена» on another link
  await bot.handleUpdate(tg.text(3, "https://www.tiktok.com/@a/video/12345"));
  const ask2 = tg.sent(3, /с чужой платформы/)!;
  await bot.handleUpdate(tg.press(3, "RC:no", tg.messageIdOf(ask2)!));
  assert.equal(tg.edits(3).at(-1), L.s30.rightsNo);
  assert.equal(bot.db.hasRights(3, urlHash("https://www.tiktok.com/@a/video/12345")), false);
  // a stale button
  await bot.handleUpdate(tg.press(3, "RC:ok", tg.messageIdOf(ask2)!));
  assert.equal(tg.lastToast(), L.s30.rightsGone);
  bot.close();
});

test("✂️ Нарезка лучших моментов on a 1.5-hour podcast: a long job, reels instruction, the credit line in the result; links kept for /takedown", async () => {
  const b = await boot();
  const card = await linkCard(b, 4);
  await b.bot.handleUpdate(b.tg.press(4, "LK:cut", b.tg.messageIdOf(card)!));
  await b.bot.idle();
  assert.equal(b.runs.length, 1);
  assert.match(b.runs[0].instruction, /^3 рилса по 30 секунд из самых сильных моментов/);
  const job = b.bot.db.jobsByStatus("done")[0];
  assert.equal(job.class, "long", "a 90-minute video is a long job");
  const p = JSON.parse(job.payload) as { links: { url: string; hash: string }[]; credit: string };
  assert.deepEqual(p.links, [{ url: YT, hash: urlHash(YT) }]);
  const credit = `📎 Источник: «${META.title}» — ${META.channel} · ${YT}`;
  assert.equal(p.credit, credit);
  const result = b.tg.sent(4, /^Готово: 1 ролик/)!;
  assert.match(String(result.params.text), new RegExp(credit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(b.bot.db.jobsByLink(urlHash(YT)).map((j) => j.id), [job.id]);
  b.bot.close();
});

test("🎯 Смонтировать мой ролик так же: the downloaded video becomes a style reference (a copy, analysis only), then the user's own video is edited in that style", async () => {
  const b = await boot();
  const card = await linkCard(b, 5);
  await b.bot.handleUpdate(b.tg.press(5, "LK:ref", b.tg.messageIdOf(card)!));
  await b.bot.idle();
  assert.equal(b.styles.length, 1);
  assert.equal(b.styles[0].url, YT);
  assert.notEqual(b.styles[0].file, b.bot.session(5).source, "a copy, not the batch file");
  assert.ok(b.tg.texts(5).includes(L.s30.refFromLink));
  assert.match(b.tg.texts(5).at(-1)!, /^🎯 Стиль примера: /);
  const s = b.bot.session(5);
  assert.ok(s.ref, "the reference is set");
  assert.deepEqual(s.sources, [], "the reference is not part of the next montage");
  // the user's own video → the card offers «как в примере» → ▶️
  await b.bot.handleUpdate(b.tg.video(5, "OWN"));
  await b.bot.idle();
  const own = b.tg.sent(5, L.videoSaved)!;
  await b.bot.handleUpdate(b.tg.press(5, "M:go", b.tg.messageIdOf(own)!));
  await b.bot.idle();
  assert.equal(b.runs.length, 1);
  assert.ok(b.runs[0].like, "edited like the reference");
  assert.ok(!b.runs[0].source.includes("link_"), "the reference video is never the source");
  b.bot.close();
});

test("🧑 Аватар по этому сценарию: the avatar pipeline gets the downloaded video (speech retold, not copied)", async () => {
  const b = await boot({ seconds: 120 });
  const card = await linkCard(b, 6);
  await b.bot.handleUpdate(b.tg.press(6, "LK:av", b.tg.messageIdOf(card)!));
  await b.bot.idle();
  assert.equal(b.avatars.length, 1);
  assert.equal(b.avatars[0].video, b.bot.session(6).source);
  assert.ok(b.tg.texts(6).includes(L.s30.avatarFromLink));
  assert.ok(b.tg.texts(6).some((t) => t.startsWith("avatar bundle") && t.includes("📎 Источник")));
  assert.equal(b.bot.db.jobsByStatus("done")[0].class, "standard");
  b.bot.close();
});

test("🌐 Русская версия: the dub card (language, voice, voice-over/replace) → ▶️ → the dub job; «Неофициальный перевод» heads the description; the source credit in the message", async () => {
  const b = await boot();
  const card = await linkCard(b, 7);
  await b.bot.handleUpdate(b.tg.press(7, "D:open", b.tg.messageIdOf(card)!));
  const dc = b.tg.sent(7, /Перевод и озвучка/)!;
  assert.equal(dc.params.text, L.s30.dubCard(META.title, 90));
  assert.match(String(dc.params.text), /Неофициальный перевод/);
  const id = b.tg.messageIdOf(dc)!;
  assert.ok(b.tg.buttons(b.tg.keyboardOf(dc)).includes("✓ Русский=DB:l:ru"));
  assert.ok(b.tg.buttons(b.tg.keyboardOf(dc)).includes("✓ 🔉 Закадровый=DB:m:voiceover"));
  await b.bot.handleUpdate(b.tg.press(7, "DB:l:en", id));
  await b.bot.handleUpdate(b.tg.press(7, "DB:v:gemini_kore", id));
  await b.bot.handleUpdate(b.tg.press(7, "DB:m:replace", id));
  const kb = b.tg.buttons(b.tg.markupOf(id));
  assert.ok(kb.includes("✓ English=DB:l:en") && kb.includes("✓ 🔇 Заменить речь=DB:m:replace") && kb.some((x) => x.startsWith("✓ ") && x.endsWith("=DB:v:gemini_kore")));
  await b.bot.handleUpdate(b.tg.press(7, "DB:go", id));
  await b.bot.idle();
  assert.equal(b.dubs.length, 1);
  assert.deepEqual([b.dubs[0].lang, b.dubs[0].voice, b.dubs[0].mode, b.dubs[0].source], ["en", "gemini_kore", "replace", b.bot.session(7).source]);
  const job = b.bot.db.jobsByStatus("done")[0];
  assert.equal(job.kind, "dub");
  assert.equal(job.class, "long");
  // the video's description starts with the label; the closing message carries the source
  const doc = b.tg.calls.find((c) => c.method === "sendDocument" && c.params.chat_id === 7);
  assert.ok(doc, "the dubbed video is sent");
  assert.match(String(doc!.params.caption), /Unofficial translation/);
  assert.ok(b.tg.texts(7).some((t) => t.includes(`📎 Источник: «${META.title}»`)));
  b.bot.close();
});

test("🌐 Озвучить на русском on the montage card: the reels are dubbed after the montage (captions in Russian), label in the description", async () => {
  const b = await boot({ seconds: 60 });
  await b.bot.handleUpdate(b.tg.video(8, "V1"));
  await b.bot.idle();
  const card = b.tg.sent(8, L.videoSaved)!;
  const id = b.tg.messageIdOf(card)!;
  assert.ok(b.tg.buttons(b.tg.keyboardOf(card)).includes("🌐 Русская версия=D:open"), "an uploaded video offers the Russian version too");
  await b.bot.handleUpdate(b.tg.press(8, "M:d", id));
  assert.ok(b.tg.buttons(b.tg.markupOf(id)).includes("✓ 🌐 Озвучить на русском=M:d"));
  await b.bot.handleUpdate(b.tg.press(8, "M:go", id));
  await b.bot.idle();
  assert.equal(b.runs.length, 1);
  assert.match(b.runs[0].instruction, /, субтитры на русском$/);
  assert.ok(!/языке речи/.test(b.runs[0].instruction));
  assert.equal(b.dubOuts.length, 1);
  assert.deepEqual([b.dubOuts[0].jobId, b.dubOuts[0].lang], ["20261019-aaaaaa", "ru"]);
  const doc = b.tg.calls.find((c) => c.method === "sendDocument" && c.params.chat_id === 8)!;
  assert.match(String(doc.params.caption), /^reel_1_ru/);
  assert.match(String(doc.params.caption), /Неофициальный перевод/);
  b.bot.close();
});

test("a platform that wants a login: a polite refusal (we never use anyone's login) — asks for the file", async () => {
  const b = await boot({ ytError: new LinkError("login", "сайт требует вход: Sign in to confirm") });
  await b.bot.handleUpdate(b.tg.text(9, "https://www.instagram.com/reel/XYZ123/"));
  const ask = b.tg.sent(9, /с чужой платформы/)!;
  await b.bot.handleUpdate(b.tg.press(9, "RC:ok", b.tg.messageIdOf(ask)!));
  await b.bot.idle();
  assert.equal(b.tg.edits(9).at(-1), L.s30.linkLogin);
  assert.equal(b.bot.session(9).sources.length, 0);
  b.bot.close();
});

test("cloud storage links (Drive, Yandex Disk, Dropbox) and direct files are the user's own: no question", async () => {
  const b = await boot();
  await b.bot.handleUpdate(b.tg.text(10, "https://drive.google.com/file/d/1AbcDefGhiJkl/view"));
  await b.bot.idle();
  assert.equal(b.tg.texts(10).filter((t) => t === L.s30.rightsAsk(1)).length, 0);
  b.bot.close();
});
