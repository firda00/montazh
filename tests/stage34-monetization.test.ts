// Stage 34: Monetization & Billing — tariffs, card transfer receipt verification,
// 1-click admin approval/rejection, promo codes, free-trial watermark and 1-click watermark removal.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s34-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s34-"));

async function boot(extra: Partial<BotOptions> = {}) {
  const tg = fakeTelegram();
  const bot = await createBot({
    token: "t",
    workspace: await tmp(),
    callMethod: tg.callMethod,
    download: tg.download,
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    broadcastDelayMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    adminIds: [1],
    ...extra,
  });
  return { tg, bot };
}

test("card transfer flow: /setcard → user picks package → sends receipt photo → admin approves in 1 click → credits & PRO granted; /payments shows revenue", async () => {
  const { tg, bot } = await boot({ plan: { standardPerDay: 1, trialCredits: 0 } });

  // Admin sets card details
  await bot.handleUpdate(tg.text(1, "/setcard 8600 1234 5678 9012 · Firdavs (Uzcard)"));
  assert.match(tg.texts(1).at(-1)!, /Реквизиты для оплаты сохранены/);

  // User 10 opens /buy, selects "start" package (10 credits, 49 000 UZS)
  await bot.handleUpdate(tg.text(10, "/buy", 10, { username: "aziz", first_name: "Aziz" }));
  assert.match(tg.texts(10).at(-1)!, /Тарифы и пополнение баланса/);
  await bot.handleUpdate(tg.press(10, "B:pkg:start", 1));
  assert.match(tg.texts(10).at(-1)!, /8600 1234 5678 9012/);

  // User 10 sends receipt photo
  await bot.handleUpdate(tg.msg(10, 10, { photo: [{ file_id: "RECEIPT_PHOTO_1" }] }));
  assert.match(tg.texts(10).at(-1)!, /Чек получен \(заявка #1/);

  // Admin 1 receives the order with Approve / Reject buttons
  assert.match(tg.texts(1).at(-1)!, /Новая заявка на оплату #1[\s\S]*49 000 сум/);
  await bot.handleUpdate(tg.press(1, "B:ok:1", 2));
  assert.equal(bot.user(10)!.credits, 10, "10 credits granted on approval");
  assert.match(tg.texts(10).at(-1)!, /Оплата #1 подтверждена! Начислено \+10 кр\./);

  // Double-clicking approve does not grant twice
  await bot.handleUpdate(tg.press(1, "B:ok:1", 2));
  assert.equal(bot.user(10)!.credits, 10);

  // User 11 in Uzbek buys PRO (VIP 30 days)
  await bot.handleUpdate(tg.text(11, "/start", 11, { username: "jasur", first_name: "Jasur" }));
  bot.db.updateUser(11, { lang: "uz" });
  await bot.handleUpdate(tg.press(11, "B:pkg:pro", 1));
  assert.match(tg.texts(11).at(-1)!, /249 000 so‘m/);
  await bot.handleUpdate(tg.msg(11, 11, { photo: [{ file_id: "RECEIPT_PHOTO_2" }] }));
  assert.match(tg.texts(11).at(-1)!, /Chek qabul qilindi \(so‘rov #2/);
  await bot.handleUpdate(tg.press(1, "B:ok:2", 3));
  assert.equal(bot.user(11)!.plan, "vip", "PRO upgrades user to vip plan");
  assert.match(tg.texts(11).at(-1)!, /PRO \(VIP\) yoqildi/);

  // Admin checks /payments revenue summary
  await bot.handleUpdate(tg.text(1, "/payments"));
  assert.match(tg.texts(1).at(-1)!, /Оплачено заказов: 2 на сумму 298 000 сум/);
  bot.close();
});

test("promo codes: /addpromo by admin → /promo by user grants credits once and enforces max_uses", async () => {
  const { tg, bot } = await boot({ plan: { trialCredits: 0 } });
  await bot.handleUpdate(tg.text(1, "/addpromo BONUS5 5 1"));
  assert.match(tg.texts(1).at(-1)!, /Промокод создан: BONUS5/);

  await bot.handleUpdate(tg.text(20, "/promo bonus5"));
  assert.equal(bot.user(20)!.credits, 5);
  assert.match(tg.texts(20).at(-1)!, /Промокод активирован! Начислено \+5 кр\./);

  // Same user tries again
  await bot.handleUpdate(tg.text(20, "/promo bonus5"));
  assert.match(tg.texts(20).at(-1)!, /уже активировали/);

  // Second user tries after max_uses=1 is exhausted
  await bot.handleUpdate(tg.text(21, "/promo BONUS5"));
  assert.match(tg.texts(21).at(-1)!, /исчерпан/);
  assert.equal(bot.user(21)!.credits, 0);
  bot.close();
});

test("free-trial watermark & 1-click unwatermark: free user gets watermarked reel + «✨ Без водяного знака (1 кр.)» button; unlocking sends clean original", async () => {
  const dir = await tmp();
  const cleanFile = path.join(dir, "output_reel_1.mp4");
  await fs.writeFile(cleanFile, "CLEAN_ORIGINAL_VIDEO_BYTES");

  const watermarkedFiles: string[] = [];
  const { tg, bot } = await boot({
    plan: { standardPerDay: 1, trialCredits: 0, creditsStandard: 1 },
    watermarkFree: async (file) => {
      const wm = file.replace(/\.mp4$/i, "_wm.mp4");
      await fs.writeFile(wm, "WATERMARKED_DEMO_VIDEO_BYTES");
      watermarkedFiles.push(wm);
      return wm;
    },
    make: async (a) => ({ jobId: "20261021-wm1", title: a.topic, outputs: [{ id: "reel_1", file: cleanFile, duration: 20 }] }),
  });

  // Free user (0 credits) runs 1 free trial job → receives watermarked copy + unlock button
  await bot.handleUpdate(tg.text(30, "/make тест водяного знака"));
  await bot.idle();
  assert.equal(watermarkedFiles.length, 1, "free trial job was watermarked");
  const resultMsg = tg.sent(30, /^Готово: 1 ролик/)!;
  assert.match(String(resultMsg.params.text), /Пробная версия с водяным знаком/);
  const buttons = tg.buttons(tg.keyboardOf(resultMsg));
  const unwmBtn = buttons.find((b) => b.includes("B:unwm:"));
  assert.ok(unwmBtn, "result keyboard has 1-click unwatermark button");
  const jobId = unwmBtn!.split("B:unwm:")[1];

  // Clicking unwatermark with 0 credits prompts top-up tariffs
  await bot.handleUpdate(tg.press(30, `B:unwm:${jobId}`, tg.messageIdOf(resultMsg)!));
  assert.match(tg.texts(30).at(-1)!, /нужен 1 кредит/);

  // User gets 2 credits and clicks unwatermark → 1 credit charged, clean original sent
  bot.db.addCredits(30, 2);
  await bot.handleUpdate(tg.press(30, `B:unwm:${jobId}`, tg.messageIdOf(resultMsg)!));
  assert.equal(bot.user(30)!.credits, 1, "1 credit spent to unlock clean video");
  assert.match(tg.texts(30).at(-1)!, /Отправляю чистый оригинал без водяного знака/);
  bot.close();
});
