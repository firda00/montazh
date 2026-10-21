// Stage 30: testers of the closed beta. The first N strangers (VEDIT_TESTER_SLOTS, default 4; /admin → ⚙️ Лимиты)
// are let in on their first message with ⭐ VIP, the admins get «👤 Новый тестировщик … (слот k/N)» with
// [🚫 Отозвать]; after that the one-tap «✅ Пустить (VIP)» notice is the fallback. `/vip @username on` for someone who
// never wrote is remembered and applied when they write (no slot used). Fake Bot API, fake pipelines.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30t-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { FREE_PLAN_FIELDS, freePlanFromEnv } = await import("../src/bot/plans.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;

const L = STRINGS.ru;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s30t-"));

async function boot(extra: Partial<BotOptions> = {}) {
  const tg = fakeTelegram();
  const logs: string[] = [];
  const bot = await createBot({ token: "t", workspace: await tmp(), callMethod: tg.callMethod, download: tg.download, onLog: (l) => logs.push(l), statusEditMs: 0, cleanupIntervalMs: 0, broadcastDelayMs: 0, albumDelayMs: 0, onboarding: false, ...extra });
  return { tg, bot, logs };
}

test("db (migration 5): testers with auto slots and revocation, pending @usernames (case-insensitive)", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  assert.deepEqual(db.migrations(), [1, 2, 3, 4, 5, 6]);
  db.addTester(10, "auto", "a");
  db.addTester(11, "auto", null);
  db.addTester(12, "pending", "c");
  assert.equal(db.testerSlotsUsed(), 2, "pending testers take no slot");
  db.revokeTester(10, 1);
  assert.equal(db.testerSlotsUsed(), 1);
  assert.ok(db.getTester(10)?.revoked_at);
  assert.deepEqual(db.activeTesters().map((t) => t.tg_id), [11, 12]);
  db.addPendingVip("@Timur_K", 1);
  assert.equal(db.hasPendingVip("timur_k"), true);
  assert.equal(db.hasPendingVip("@TIMUR_K"), true);
  assert.deepEqual(db.pendingVips(), ["timur_k"]);
  assert.equal(db.removePendingVip("Timur_K"), true);
  assert.equal(db.removePendingVip("Timur_K"), false);
  db.close();
});

test("plan: VEDIT_TESTER_SLOTS (default 4) is a live limit in /admin → ⚙️ Лимиты", async () => {
  assert.equal(freePlanFromEnv({}).testerSlots, 4);
  assert.equal(freePlanFromEnv({ VEDIT_TESTER_SLOTS: "2" }).testerSlots, 2);
  assert.throws(() => freePlanFromEnv({ VEDIT_TESTER_SLOTS: "-1" }), /VEDIT_TESTER_SLOTS/);
  const idx = FREE_PLAN_FIELDS.findIndex((f) => f.key === "testerSlots");
  assert.ok(idx >= 0);
  const { tg, bot } = await boot({ allowedUserIds: [1] });
  await bot.handleUpdate(tg.text(1, "/admin"));
  await bot.handleUpdate(tg.press(1, "a:l", 1));
  const card = tg.sent(1, /Лимиты бесплатного тарифа/)!;
  assert.match(String(card.params.text), new RegExp(`${idx + 1}\\. автодоступ тестировщиков[^\\n]*: 4`));
  await bot.handleUpdate(tg.press(1, `a:lv:${idx}:+`, tg.messageIdOf(card)!));
  assert.equal(bot.db.planLimits(freePlanFromEnv({})).testerSlots, 5);
  bot.close();
});

test("closed beta: the first N strangers get in with VIP on /start, the admins get «Новый тестировщик … (слот k/N)» + 🚫 Отозвать; then the one-tap notice; revoking frees the slot, the revoked one stays out", async () => {
  const { tg, bot } = await boot({ allowedUserIds: [1], adminIds: [1], plan: { testerSlots: 2 } });
  // stranger 21 presses /start → in at once, VIP, served immediately
  await bot.handleUpdate(tg.text(21, "/start", 21, { username: "aziz", first_name: "Азиз" }));
  assert.equal(tg.texts(21).at(-1), L.menuText, "served right away");
  assert.deepEqual([bot.user(21)?.plan, bot.db.isAllowed(21), bot.db.getTester(21)?.via], ["vip", true, "auto"]);
  const n21 = tg.sent(1, /Новый тестировщик/)!;
  assert.equal(n21.params.text, L.s30.testerNotice(21, "Азиз", "aziz", 1, 2));
  assert.equal(n21.params.text, "👤 Новый тестировщик: Азиз @aziz · id 21 (слот 1/2)");
  assert.deepEqual(tg.buttons(tg.keyboardOf(n21)), ["🚫 Отозвать=a:rv:21"]);
  await bot.handleUpdate(tg.text(22, "/start", 22, { first_name: "Лола" }));
  assert.equal(tg.sent(1, /Новый тестировщик: Лола/)!.params.text, "👤 Новый тестировщик: Лола · id 22 (слот 2/2)");
  // the slots are used: stranger 23 → the old notice with «✅ Пустить (VIP)»
  await bot.handleUpdate(tg.text(23, "/start", 23, { first_name: "Bob" }));
  assert.equal(tg.texts(23).length, 0, "not served");
  assert.equal(tg.texts(1).at(-1), L.strangerNotice(23, "Bob", ""));
  // /admin shows the slots and who
  await bot.handleUpdate(tg.text(1, "/admin"));
  assert.equal(tg.texts(1).at(-1), `${L.adminMenu}\n\n${L.s30.adminTesters(2, 2, ["@aziz", "22"], [])}`);
  assert.match(tg.texts(1).at(-1)!, /🧪 Автодоступ тестировщиков: 2\/2 — @aziz, 22\n⏳ Ждут VIP: —/);
  // 🚫 Отозвать: out of the allowlist, back to free, the slot is free again
  await bot.handleUpdate(tg.press(1, "a:rv:21", tg.messageIdOf(n21)!));
  assert.equal(tg.edits(1).at(-1), L.s30.testerRevoked(21));
  assert.deepEqual([bot.user(21)?.plan, bot.db.isAllowed(21), bot.db.testerSlotsUsed()], ["free", false, 1]);
  const before21 = tg.texts(21).length;
  await bot.handleUpdate(tg.text(21, "/start"));
  assert.equal(tg.texts(21).length, before21, "a revoked tester is not let in again automatically");
  // the freed slot goes to the next newcomer
  await bot.handleUpdate(tg.text(24, "/start", 24, { first_name: "Нигора" }));
  assert.equal(tg.texts(24).at(-1), L.menuText);
  assert.match(tg.texts(1).join("\n"), /Новый тестировщик: Нигора · id 24 \(слот 2\/2\)/);
  // a non-admin cannot revoke
  await bot.handleUpdate(tg.press(24, "a:rv:22", 1));
  assert.equal(bot.db.isAllowed(22), true);
  // VIP: no limits for the tester
  assert.equal(bot.user(24)?.plan, "vip");
  bot.close();
});

test("«Игнорировать» on a stranger keeps them out even when a slot frees up", async () => {
  const { tg, bot } = await boot({ allowedUserIds: [1], plan: { testerSlots: 0 } });
  await bot.handleUpdate(tg.text(30, "hi", 30, { first_name: "X" }));
  const notice = tg.sent(1, /Незнакомец/)!;
  await bot.handleUpdate(tg.press(1, "a:ign:30", tg.messageIdOf(notice)!));
  bot.db.setKv("plan.free.testerSlots", "3");
  await bot.handleUpdate(tg.text(30, "/start"));
  assert.equal(tg.texts(30).length, 0);
  assert.equal(bot.db.isAllowed(30), false);
  bot.close();
});

test("/vip @username on for someone who never wrote: remembered; they get in with VIP on their first message (any case), no slot used; /vip @x off forgets", async () => {
  const { tg, bot } = await boot({ allowedUserIds: [1], plan: { testerSlots: 1 } });
  await bot.handleUpdate(tg.text(1, "/vip @Timur_K on"));
  assert.equal(tg.texts(1).at(-1), L.s30.vipPending("timur_k"));
  await bot.handleUpdate(tg.text(1, "/vip @ghost on"));
  await bot.handleUpdate(tg.text(1, "/vip @ghost off"));
  assert.equal(tg.texts(1).at(-1), L.s30.vipPendingRemoved("ghost"));
  await bot.handleUpdate(tg.text(1, "/admin"));
  assert.match(tg.texts(1).at(-1)!, /⏳ Ждут VIP: @timur_k$/);
  // Timur writes (username in another case)
  await bot.handleUpdate(tg.text(40, "/start", 40, { username: "TIMUR_k", first_name: "Тимур" }));
  assert.equal(tg.texts(40).at(-1), L.menuText);
  assert.deepEqual([bot.user(40)?.plan, bot.db.isAllowed(40), bot.db.getTester(40)?.via, bot.db.testerSlotsUsed()], ["vip", true, "pending", 0]);
  assert.equal(tg.texts(1).at(-1), L.s30.pendingArrived(40, "Тимур", "TIMUR_k"));
  assert.deepEqual(bot.db.pendingVips(), []);
  // the one auto slot is still free for a stranger
  await bot.handleUpdate(tg.text(41, "/start", 41, { first_name: "A" }));
  assert.equal(bot.user(41)?.plan, "vip");
  // a bare number that never wrote stays the stage-29 behaviour; garbage is still "not found"
  await bot.handleUpdate(tg.text(1, "/vip 555 on"));
  assert.equal(bot.user(555)?.plan, "vip");
  await bot.handleUpdate(tg.text(1, "/vip @x on"));
  assert.equal(tg.texts(1).at(-1), L.userNotFound("@x"), "too short for a Telegram username");
  bot.close();
});

test("open registration: no auto slots, but a pending @username still becomes VIP on the first message", async () => {
  const { tg, bot } = await boot({ adminIds: [1] });
  await bot.handleUpdate(tg.text(1, "/vip @dilya_s on"));
  await bot.handleUpdate(tg.text(50, "/start", 50, { username: "dilya_s" }));
  assert.equal(bot.user(50)?.plan, "vip");
  await bot.handleUpdate(tg.text(51, "/start", 51, { username: "someone" }));
  assert.equal(bot.user(51)?.plan, "free", "open registration: everyone else is a regular user");
  assert.equal(bot.db.getTester(51), undefined);
  await bot.handleUpdate(tg.text(1, "/admin"));
  assert.match(tg.texts(1).at(-1)!, /🧪 Автодоступ тестировщиков: 0\/4 — @dilya_s \(по @\)/);
  bot.close();
});
