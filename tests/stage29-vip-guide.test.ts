// VIP testers (no limits, no charges), the DB allowlist of the closed beta (/allow, /vip, «✅ Пустить (VIP)» on a
// stranger's notice) and the in-bot guide (7 cards edited in place, «Попробовать», «🖼 Шпаргалка»).
// Fake Bot API (tests/helpers/fake-telegram.ts) and fake pipelines — no network, no Chrome.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s29-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { INVITE } = await import("../src/bot/admin.ts");
const { guideCard, guideHtml, GUIDE_ACTIONS } = await import("../src/bot/guide.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;

const L = STRINGS.ru;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s29-"));

async function boot(extra: Partial<BotOptions> = {}) {
  const tg = fakeTelegram();
  const logs: string[] = [];
  const out = path.join(await tmp(), "output_reel_1.mp4");
  await fs.writeFile(out, "mp4");
  const bot = await createBot({
    token: "t",
    workspace: await tmp(),
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: (l) => logs.push(l),
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    broadcastDelayMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    pipeline: async () => ({ jobId: "20261019-ffffff", outputs: [{ id: "reel_1", file: out, duration: 20 }] }),
    ...extra,
  });
  return { tg, bot, logs };
}

test("migration 4: the allowlist", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  assert.deepEqual(db.migrations(), [1, 2, 3, 4, 5]);
  db.allow(7, 1);
  db.allow(7, 2);
  db.allow(3);
  assert.deepEqual(db.allowedIds(), [3, 7]);
  assert.equal(db.isAllowed(7), true);
  db.disallow(7);
  assert.equal(db.isAllowed(7), false);
  db.close();
});

// ── closed beta ────────────────────────────────────────────────────────────────

test("a stranger of the closed beta: admins get ONE notice with «✅ Пустить (VIP)» / «Игнорировать»; one tap lets them in as VIP", async () => {
  // no tester slots (stage 30): the one-tap notice is the fallback when the slots are used up
  const { tg, bot, logs } = await boot({ allowedUserIds: [1], adminIds: [1, 2], plan: { testerSlots: 0 } });
  await bot.handleUpdate(tg.text(9, "привет", 9, { username: "tester", first_name: "Тимур" }));
  await bot.handleUpdate(tg.text(9, "ау"));
  await bot.handleUpdate(tg.press(9, "H:montage", 5));
  assert.equal(tg.calls.filter((c) => c.params.chat_id === 9 && c.method !== "answerCallbackQuery").length, 0, "the stranger gets nothing");
  assert.ok(logs.some((l) => /пользователь 9 не в TELEGRAM_ALLOWED_USERS/.test(l)));
  for (const admin of [1, 2]) {
    const notices = tg.calls.filter((c) => c.method === "sendMessage" && c.params.chat_id === admin);
    assert.equal(notices.length, 1, `admin ${admin}: one notice only`);
    assert.equal(notices[0].params.text, L.strangerNotice(9, "Тимур", "tester"));
    assert.deepEqual(tg.buttons(tg.keyboardOf(notices[0])), ["✅ Пустить (VIP)=a:let:9", "Игнорировать=a:ign:9"]);
  }
  const notice = tg.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === 1)!;
  await bot.handleUpdate(tg.press(1, "a:let:9", tg.messageIdOf(notice)!));
  assert.equal(tg.edits(1).at(-1), L.strangerLet(9));
  assert.deepEqual([bot.user(9)?.plan, bot.user(9)?.username, bot.db.isAllowed(9)], ["vip", "tester", true]);
  assert.equal(tg.texts(9).at(-1), INVITE, "the invitation goes to the tester");
  await bot.handleUpdate(tg.text(9, "/start"));
  assert.equal(tg.texts(9).at(-1), L.menuText, "now the bot answers");
  // a non-admin cannot press it
  await bot.handleUpdate(tg.press(9, "a:let:10", 1));
  assert.equal(bot.db.isAllowed(10), false);

  // «Игнорировать»: no more notices, still outside
  await bot.handleUpdate(tg.text(10, "hi", 10, { first_name: "Bob" }));
  const n10 = tg.calls.find((c) => c.method === "sendMessage" && c.params.chat_id === 1 && String(c.params.text).includes("id 10"))!;
  await bot.handleUpdate(tg.press(1, "a:ign:10", tg.messageIdOf(n10)!));
  assert.equal(tg.edits(1).at(-1), L.strangerIgnored(10));
  const before = tg.calls.length;
  await bot.handleUpdate(tg.text(10, "hello?"));
  assert.equal(tg.calls.length, before, "nothing to anyone");
  assert.equal(bot.user(10), undefined);
  bot.close();
});

test("/allow and /vip (admins only): DB allowlist on top of TELEGRAM_ALLOWED_USERS, by id or @username, on/off", async () => {
  const { tg, bot } = await boot({ allowedUserIds: [1, 4], plan: { testerSlots: 0 } });
  await bot.handleUpdate(tg.text(4, "/start", 4, { username: "dilya" }));
  await bot.handleUpdate(tg.text(4, "/vip 4 on"));
  assert.equal(tg.texts(4).at(-1), L.unknownCommand, "not for users");
  await bot.handleUpdate(tg.text(1, "/allow"));
  assert.equal(tg.texts(1).at(-1), L.allowUsage);
  await bot.handleUpdate(tg.text(1, "/allow 777"));
  assert.equal(tg.texts(1).at(-1), L.allowSet(777, true));
  await bot.handleUpdate(tg.text(777, "/start"));
  assert.equal(tg.texts(777).at(-1), L.menuText);
  assert.equal(bot.user(777)?.plan, "free", "/allow lets in, VIP is separate");
  await bot.handleUpdate(tg.text(1, "/allow 777 off"));
  const before = tg.texts(777).length;
  await bot.handleUpdate(tg.text(777, "/start"));
  assert.equal(tg.texts(777).length, before, "out again");

  await bot.handleUpdate(tg.text(1, "/vip @dilya on"));
  assert.equal(tg.texts(1).at(-1), L.vipSet(4, true));
  assert.equal(bot.user(4)?.plan, "vip");
  assert.equal(tg.texts(4).at(-1), L.vipUserOn);
  await bot.handleUpdate(tg.text(1, "/vip 555 on"));
  assert.deepEqual([bot.user(555)?.plan, bot.db.isAllowed(555)], ["vip", true], "an id that never wrote is prepared");
  // stage 30: an @username that never wrote is remembered as a pending VIP
  await bot.handleUpdate(tg.text(1, "/vip @nobody on"));
  assert.equal(tg.texts(1).at(-1), L.s30.vipPending("nobody"));
  await bot.handleUpdate(tg.text(1, "/vip 4"));
  assert.equal(tg.texts(1).at(-1), L.vipUsage);
  await bot.handleUpdate(tg.text(1, "/vip 4 off"));
  assert.equal(bot.user(4)?.plan, "free");
  bot.close();
});

test("VIP: no daily cap, no free-plan limit, no credits charged (a free user is refused); «⭐ VIP» on the admin's user card; balance says VIP", async () => {
  const { tg, bot } = await boot({ adminIds: [1], quotas: true, userDailyJobs: 1, plan: { standardPerDay: 1, trialCredits: 0, creditsStandard: 1 } });
  for (const uid of [30, 31]) {
    await bot.handleUpdate(tg.text(uid, "/start", uid, { username: `u${uid}` }));
    await bot.handleUpdate(tg.video(uid, `V${uid}`));
  }
  // the admin makes 30 a VIP from the user card
  await bot.handleUpdate(tg.text(1, "/admin"));
  await bot.handleUpdate(tg.press(1, "a:f", 1));
  await bot.handleUpdate(tg.text(1, "@u30"));
  const card = tg.sent(1, /id 30/)!;
  assert.ok(tg.buttons(tg.keyboardOf(card)).includes("⭐ VIP=a:vip:30"));
  await bot.handleUpdate(tg.press(1, "a:vip:30", tg.messageIdOf(card)!));
  assert.ok(tg.buttons(tg.markupOf(tg.messageIdOf(card)!)).includes("✓ ⭐ VIP (снять)=a:vip:30"));
  assert.equal(bot.user(30)?.plan, "vip");
  assert.equal(tg.texts(30).at(-1), L.vipUserOn);

  for (let i = 0; i < 3; i++) {
    await bot.handleUpdate(tg.text(30, `рилс номер ${i + 1}`));
    await bot.idle();
  }
  const vipJobs = bot.db.jobsByStatus("done").filter((j) => j.user === 30);
  assert.equal(vipJobs.length, 3, "past the daily cap and the free limit");
  assert.ok(vipJobs.every((j) => j.paid_credits === 0));
  await bot.handleUpdate(tg.text(31, "рилс 1"));
  await bot.idle();
  await bot.handleUpdate(tg.text(31, "рилс 2"));
  await bot.idle();
  assert.equal(bot.db.jobsByStatus("done").filter((j) => j.user === 31).length, 1);
  assert.equal(tg.texts(31).at(-1), L.userDailyCap(1));
  await bot.handleUpdate(tg.text(30, "/balance"));
  assert.match(tg.texts(30).at(-1)!, /Тариф: VIP \(без лимитов и списаний\)/);
  bot.close();
});

// ── the guide ──────────────────────────────────────────────────────────────────

test("guide cards: 7 per language, ≤ 6 lines each, compact callback data; ◀️ ▶️ only where there is somewhere to go", () => {
  for (const lang of ["ru", "uz", "en"] as const) {
    const S = STRINGS[lang];
    assert.equal(S.guide.cards.length, 7);
    assert.equal(GUIDE_ACTIONS.length, 7);
    for (let i = 0; i < 7; i++) {
      const c = S.guide.cards[i];
      assert.ok(c.body.split("\n").length <= 6, `${lang} card ${i + 1}: ≤ 6 lines`);
      const g = guideCard(S, i);
      const data = g.kb.inline_keyboard.flat().map((b) => b.callback_data!);
      assert.ok(data.every((d) => Buffer.byteLength(d) <= 64));
      assert.equal(data.includes(`G:p:${i - 1}`), i > 0);
      assert.equal(data.includes(`G:p:${i + 1}`), i < 6);
      assert.ok(g.text.startsWith(S.guide.head(i + 1, 7)));
    }
  }
  assert.equal(guideCard(L, 99).index, 6, "clamped");
  assert.equal(guideCard(L, -3).index, 0);
  const html = guideHtml(STRINGS.uz);
  for (const c of STRINGS.uz.guide.cards) assert.ok(html.includes(c.title.split(" ").slice(1).join(" ").replace(/&/g, "&amp;")), c.title);
  assert.ok(html.includes("width:1080px"));
});

test("📘 Как пользоваться: menu button → card 1; ◀️ ▶️ edit the same message; «Попробовать» opens the flow; «🖼 Шпаргалка» sends the picture", async () => {
  const guideDir = await tmp();
  await fs.writeFile(path.join(guideDir, "guide-ru.png"), "png");
  await fs.writeFile(path.join(guideDir, "guide-en.png"), "png");
  const { tg, bot } = await boot({ guideDir });
  await bot.handleUpdate(tg.text(5, "/start"));
  const menu = tg.sent(5, L.menuText)!;
  assert.ok(tg.buttons(tg.keyboardOf(menu)).includes("📘 Как пользоваться=H:guide"));
  await bot.handleUpdate(tg.press(5, "H:guide", tg.messageIdOf(menu)!));
  const card = tg.sent(5, /^📘 Как пользоваться · 1\/7/)!;
  const id = tg.messageIdOf(card)!;
  assert.equal(card.params.text, `📘 Как пользоваться · 1/7\n\n${L.guide.cards[0].title}\n\n${L.guide.cards[0].body.split("\n").map((l) => `• ${l}`).join("\n")}`);
  assert.deepEqual(tg.buttons(tg.keyboardOf(card)), ["▶️=G:p:1", "▶️ Попробовать=G:t:0", "🖼 Шпаргалка=G:img"]);
  await bot.handleUpdate(tg.press(5, "G:p:1", id));
  assert.match(tg.edits(5).at(-1)!, /^📘 Как пользоваться · 2\/7\n\n🔤 Стили субтитров и вставки/);
  assert.deepEqual(tg.buttons(tg.markupOf(id)), ["◀️=G:p:0", "▶️=G:p:2", "▶️ Попробовать=G:t:1", "🖼 Шпаргалка=G:img"]);
  await bot.handleUpdate(tg.press(5, "G:p:6", id));
  assert.match(tg.edits(5).at(-1)!, /^📘 Как пользоваться · 7\/7\n\n⭐ Оценки/);
  assert.deepEqual(tg.buttons(tg.markupOf(id))[0], "◀️=G:p:5");
  const sent = tg.texts(5).length;
  await bot.handleUpdate(tg.press(5, "G:p:0", id));
  assert.equal(tg.texts(5).length, sent, "navigation never sends new messages");

  // «Попробовать» on «Ролик по теме» → the make flow asks for a topic
  await bot.handleUpdate(tg.press(5, "G:t:2", id));
  assert.equal(tg.texts(5).at(-1), L.makeAskTopic);
  assert.equal(bot.session(5).awaiting, "topic");
  await bot.handleUpdate(tg.press(5, "G:t:1", id));
  assert.match(tg.texts(5).at(-1)!, /⚙️/, "styles → the settings card");
  await bot.handleUpdate(tg.press(5, "G:t:6", id));
  assert.equal(tg.texts(5).at(-1), L.menuText);

  await bot.handleUpdate(tg.press(5, "G:img", id));
  const photo = tg.calls.filter((c) => c.method === "sendPhoto").at(-1)!;
  assert.equal(photo.params.chat_id, 5);
  assert.equal(photo.params.caption, L.guide.sheetCaption);
  // /guide in English
  await bot.handleUpdate(tg.press(5, "S:l:en", 0));
  await bot.handleUpdate(tg.text(5, "/guide"));
  assert.match(tg.texts(5).at(-1)!, /^📘 How to use · 1\/7\n\n🎬 Edit your own videos/);
  bot.close();
});
