// Stage 34: Monetization & Billing — tariffs, card transfer checkout with receipt verification,
// 1-click admin approval/rejection, promo codes, free-trial watermark and 1-click watermark removal.
import fs from "node:fs/promises";
import type { BotApi, InlineButton, InlineKeyboard, TgMessage } from "./telegram-api.ts";
import type { BotDb, Lang, PaymentRow } from "./db.ts";

export type TariffId = "start" | "creator" | "pro";

export interface Tariff {
  id: TariffId;
  credits: number;
  vipDays: number;
  priceUzs: number;
  priceUsd: number;
}

export const TARIFFS: Record<TariffId, Tariff> = {
  start: { id: "start", credits: 10, vipDays: 0, priceUzs: 49_000, priceUsd: 4 },
  creator: { id: "creator", credits: 30, vipDays: 0, priceUzs: 119_000, priceUsd: 10 },
  pro: { id: "pro", credits: 0, vipDays: 30, priceUzs: 249_000, priceUsd: 20 },
};

export const isTariffId = (s: unknown): s is TariffId => s === "start" || s === "creator" || s === "pro";

const fmtUzs = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

export interface BillingStrings {
  btnStartPkg: string;
  btnCreatorPkg: string;
  btnProPkg: string;
  btnPromo: string;
  btnUnwatermark: (credits: number) => string;
  shopCard: (credits: number, plan: string) => string;
  checkoutAsk: (pkgTitle: string, priceUzs: string, cardInfo: string) => string;
  receiptSaved: (id: number, pkgTitle: string) => string;
  receiptNeedMedia: string;
  adminReceiptCaption: (p: PaymentRow, userLine: string, pkgTitle: string) => string;
  btnApprove: (id: number) => string;
  btnReject: (id: number) => string;
  adminApproved: (id: number, user: number, pkgTitle: string) => string;
  adminRejected: (id: number, user: number) => string;
  adminAlreadyHandled: (id: number, status: string) => string;
  userApprovedCredits: (id: number, added: number, balance: number) => string;
  userApprovedVip: (id: number, days: number) => string;
  userRejected: (id: number) => string;
  promoAsk: string;
  promoRedeemed: (credits: number, vipDays: number, balance: number) => string;
  promoNotFound: string;
  promoExhausted: string;
  promoAlreadyUsed: string;
  unwmNeedCredits: (need: number, have: number) => string;
  unwmSending: (left: number) => string;
  unwmCaption: (outId: string) => string;
  watermarkNotice: string;
  pkgTitle: Record<TariffId, string>;
}

const BILLING_RU: BillingStrings = {
  btnStartPkg: `🚀 Старт · 10 кр. (${fmtUzs(TARIFFS.start.priceUzs)} сум)`,
  btnCreatorPkg: `🔥 Креатор · 30 кр. (${fmtUzs(TARIFFS.creator.priceUzs)} сум)`,
  btnProPkg: `👑 PRO Безлимит 30 дн. (${fmtUzs(TARIFFS.pro.priceUzs)} сум)`,
  btnPromo: "🎁 Ввести промокод",
  btnUnwatermark: (c) => `✨ Без водяного знака (${c} кр.)`,
  shopCard: (credits, plan) =>
    [
      "💎 Тарифы и пополнение баланса",
      `Ваш тариф: ${plan === "vip" ? "👑 PRO / VIP (без лимитов и без водяного знака)" : "Бесплатный (пробный с водяным знаком)"}`,
      `Баланс кредитов: ${credits}`,
      "",
      "Выберите пакет ниже:",
      `• 🚀 Старт (10 кредитов) — ${fmtUzs(TARIFFS.start.priceUzs)} сум (~10 рилсов без водяного знака)`,
      `• 🔥 Креатор (30 кредитов) — ${fmtUzs(TARIFFS.creator.priceUzs)} сум (выгода 20%, без водяного знака)`,
      `• 👑 PRO Безлимит (30 дней) — ${fmtUzs(TARIFFS.pro.priceUzs)} сум (без дневных лимитов, без списаний, без водяного знака)`,
      "",
      "После выбора тарифа бот пришлёт реквизиты карты (Uzcard / Humo / Visa). Отправьте скриншот чека в чат — и кредиты начислятся сразу после подтверждения!",
    ].join("\n"),
  checkoutAsk: (pkgTitle, priceUzs, cardInfo) =>
    [
      `💳 Оплата пакета: ${pkgTitle}`,
      `Сумма к переводу: ${priceUzs} сум`,
      "",
      "Реквизиты для перевода:",
      cardInfo,
      "",
      "📸 Сделайте перевод и отправьте сюда скриншот (фото или PDF-файл) чека следующим сообщением.",
    ].join("\n"),
  receiptSaved: (id, pkgTitle) => `✅ Чек получен (заявка #${id} · ${pkgTitle})!\nАдминистратор проверит перевод и подтвердит оплату — уведомление придёт сюда автоматически.`,
  receiptNeedMedia: "Пожалуйста, пришлите фото (скриншот) или PDF-файл чека об оплате, либо нажмите /cancel для отмены.",
  adminReceiptCaption: (p, userLine, pkgTitle) =>
    [
      `💰 Новая заявка на оплату #${p.id}`,
      `Клиент: ${userLine} (id ${p.user})`,
      `Пакет: ${pkgTitle}`,
      `Сумма: ${fmtUzs(p.price_uzs)} сум`,
    ].join("\n"),
  btnApprove: (id) => `✅ Одобрить #${id}`,
  btnReject: (id) => `❌ Отклонить #${id}`,
  adminApproved: (id, user, pkgTitle) => `✅ Заявка #${id} одобрена: пользователю ${user} выдан пакет «${pkgTitle}».`,
  adminRejected: (id, user) => `❌ Заявка #${id} (пользователь ${user}) отклонена.`,
  adminAlreadyHandled: (id, status) => `Заявка #${id} уже обработана (${status}).`,
  userApprovedCredits: (id, added, balance) => `🎉 Оплата #${id} подтверждена! Начислено +${added} кр. Ваш баланс: ${balance} кр.\nВсе ваши ролики теперь рендерятся без водяного знака!`,
  userApprovedVip: (id, days) => `🎉 Оплата #${id} подтверждена! Вам включён тариф 👑 PRO (VIP) на ${days} дн.: без дневных лимитов, без списания кредитов и без водяного знака!`,
  userRejected: (id) => `✖ Заявка на оплату #${id} не подтверждена. Проверьте чек и отправьте его снова через 💳 Баланс.`,
  promoAsk: "🎁 Напишите промокод следующим сообщением (или `/promo КОД`):",
  promoRedeemed: (credits, vipDays, balance) =>
    vipDays > 0
      ? `🎉 Промокод активирован! Вам открыт 👑 PRO (VIP) на ${vipDays} дн.${credits ? ` + ${credits} кр. (баланс: ${balance})` : ""}.`
      : `🎉 Промокод активирован! Начислено +${credits} кр. Ваш баланс: ${balance} кр.`,
  promoNotFound: "✖ Такого промокода не существует.",
  promoExhausted: "✖ Лимит активаций этого промокода уже исчерпан.",
  promoAlreadyUsed: "✖ Вы уже активировали этот промокод ранее.",
  unwmNeedCredits: (need, have) => `Для скачивания оригинала без водяного знака нужен ${need} кредит (сейчас у вас ${have}). Выберите пакет ниже, чтобы пополнить баланс:`,
  unwmSending: (left) => `✨ Отправляю чистый оригинал без водяного знака (осталось кредитов: ${left})…`,
  unwmCaption: (outId) => `✨ ${outId} · чистый оригинал без водяного знака`,
  watermarkNotice: "💧 Пробная версия с водяным знаком. Чтобы получать чистые ролики без водяного знака, пополните баланс (💳 Баланс) или нажмите «✨ Без водяного знака» ниже.",
  pkgTitle: {
    start: "🚀 Старт (10 кредитов)",
    creator: "🔥 Креатор (30 кредитов)",
    pro: "👑 PRO Безлимит (30 дней)",
  },
};

const BILLING_UZ: BillingStrings = {
  btnStartPkg: `🚀 Start · 10 kr. (${fmtUzs(TARIFFS.start.priceUzs)} so‘m)`,
  btnCreatorPkg: `🔥 Kreator · 30 kr. (${fmtUzs(TARIFFS.creator.priceUzs)} so‘m)`,
  btnProPkg: `👑 PRO Cheksiz 30 kun (${fmtUzs(TARIFFS.pro.priceUzs)} so‘m)`,
  btnPromo: "🎁 Promokod kiritish",
  btnUnwatermark: (c) => `✨ Suv belgisisiz (${c} kr.)`,
  shopCard: (credits, plan) =>
    [
      "💎 Tariflar va balansni to‘ldirish",
      `Tarifingiz: ${plan === "vip" ? "👑 PRO / VIP (limitsiz va suv belgisisiz)" : "Bepul (suv belgisi bilan sinov)"}`,
      `Kreditlar balansi: ${credits}`,
      "",
      "Quyidagi paketlardan birini tanlang:",
      `• 🚀 Start (10 kredit) — ${fmtUzs(TARIFFS.start.priceUzs)} so‘m (~10 ta rils suv belgisisiz)`,
      `• 🔥 Kreator (30 kredit) — ${fmtUzs(TARIFFS.creator.priceUzs)} so‘m (20% foyda, suv belgisisiz)`,
      `• 👑 PRO Cheksiz (30 kun) — ${fmtUzs(TARIFFS.pro.priceUzs)} so‘m (kunlik limitsiz va suv belgisisiz)`,
      "",
      "Paketni tanlaganingizdan so‘ng bot karta raqamini (Uzcard / Humo / Visa) yuboradi. To‘lov cheki skrinshotini yuboring — tasdiqlangach kreditlar darhol tushadi!",
    ].join("\n"),
  checkoutAsk: (pkgTitle, priceUzs, cardInfo) =>
    [
      `💳 Paket to‘lovi: ${pkgTitle}`,
      `O‘tkazma summasi: ${priceUzs} so‘m`,
      "",
      "O‘tkazma uchun rekvizitlar:",
      cardInfo,
      "",
      "📸 To‘lovni amalga oshiring va chek skrinshotini (rasm yoki PDF) keyingi xabarda shu yerga yuboring.",
    ].join("\n"),
  receiptSaved: (id, pkgTitle) => `✅ Chek qabul qilindi (so‘rov #${id} · ${pkgTitle})!\nAdministrator to‘lovni tekshirib tasdiqlaydi — xabar shu yerga avtomatik keladi.`,
  receiptNeedMedia: "Iltimos, to‘lov cheki skrinshotini (rasm yoki PDF fayl) yuboring yoki bekor qilish uchun /cancel ni bosing.",
  adminReceiptCaption: (p, userLine, pkgTitle) =>
    [
      `💰 Yangi to‘lov so‘rovi #${p.id}`,
      `Mijoz: ${userLine} (id ${p.user})`,
      `Paket: ${pkgTitle}`,
      `Summa: ${fmtUzs(p.price_uzs)} so‘m`,
    ].join("\n"),
  btnApprove: (id) => `✅ Tasdiqlash #${id}`,
  btnReject: (id) => `❌ Rad etish #${id}`,
  adminApproved: (id, user, pkgTitle) => `✅ So‘rov #${id} tasdiqlandi: foydalanuvchi ${user} ga «${pkgTitle}» berildi.`,
  adminRejected: (id, user) => `❌ So‘rov #${id} (foydalanuvchi ${user}) rad etildi.`,
  adminAlreadyHandled: (id, status) => `So‘rov #${id} allaqachon ko‘rib chiqilgan (${status}).`,
  userApprovedCredits: (id, added, balance) => `🎉 To‘lov #${id} tasdiqlandi! +${added} kr. qo‘shildi. Balansingiz: ${balance} kr.\nEndi barcha videolaringiz suv belgisisiz tayyorlanadi!`,
  userApprovedVip: (id, days) => `🎉 To‘lov #${id} tasdiqlandi! Sizga ${days} kunga 👑 PRO (VIP) yoqildi: kunlik limitsiz, kredit yechilmasdan va suv belgisisiz!`,
  userRejected: (id) => `✖ To‘lov so‘rovi #${id} tasdiqlanmadi. Chekni tekshirib, 💳 Balans orqali qayta yuboring.`,
  promoAsk: "🎁 Promokodni keyingi xabarda yozing (yoki `/promo KOD`):",
  promoRedeemed: (credits, vipDays, balance) =>
    vipDays > 0
      ? `🎉 Promokod faollashtirildi! Sizga ${vipDays} kunga 👑 PRO (VIP) ochildi${credits ? ` + ${credits} kr. (balans: ${balance})` : ""}.`
      : `🎉 Promokod faollashtirildi! +${credits} kr. qo‘shildi. Balansingiz: ${balance} kr.`,
  promoNotFound: "✖ Bunday promokod mavjud emas.",
  promoExhausted: "✖ Bu promokodning foydalanish limiti tugagan.",
  promoAlreadyUsed: "✖ Siz bu promokodni avval ishlatgansiz.",
  unwmNeedCredits: (need, have) => `Suv belgisisiz asl videoni olish uchun ${need} kredit kerak (hozir sizda ${have} bor). Balansni to‘ldirish uchun quyidagi paketni tanlang:`,
  unwmSending: (left) => `✨ Suv belgisisiz toza videoni yuboryapman (qolgan kreditlar: ${left})…`,
  unwmCaption: (outId) => `✨ ${outId} · suv belgisisiz toza video`,
  watermarkNotice: "💧 Suv belgisi bilan sinov versiyasi. Videolarni suv belgisisiz olish uchun balansni to‘ldiring (💳 Balans) yoki pastdagi «✨ Suv belgisisiz» tugmasini bosing.",
  pkgTitle: {
    start: "🚀 Start (10 kredit)",
    creator: "🔥 Kreator (30 kredit)",
    pro: "👑 PRO Cheksiz (30 kun)",
  },
};

const BILLING_EN: BillingStrings = {
  btnStartPkg: `🚀 Starter · 10 cr. (${fmtUzs(TARIFFS.start.priceUzs)} UZS)`,
  btnCreatorPkg: `🔥 Creator · 30 cr. (${fmtUzs(TARIFFS.creator.priceUzs)} UZS)`,
  btnProPkg: `👑 PRO Unlimited 30d (${fmtUzs(TARIFFS.pro.priceUzs)} UZS)`,
  btnPromo: "🎁 Redeem promo code",
  btnUnwatermark: (c) => `✨ Remove watermark (${c} cr.)`,
  shopCard: (credits, plan) =>
    [
      "💎 Plans & Top Up",
      `Your plan: ${plan === "vip" ? "👑 PRO / VIP (unlimited, no watermark)" : "Free trial (watermarked)"}`,
      `Credits: ${credits}`,
      "",
      "Choose a package below:",
      `• 🚀 Starter (10 credits) — ${fmtUzs(TARIFFS.start.priceUzs)} UZS (~10 clean reels without watermark)`,
      `• 🔥 Creator (30 credits) — ${fmtUzs(TARIFFS.creator.priceUzs)} UZS (save 20%, no watermark)`,
      `• 👑 PRO Unlimited (30 days) — ${fmtUzs(TARIFFS.pro.priceUzs)} UZS (unlimited jobs, no watermark)`,
      "",
      "After picking a package, you’ll get card transfer details (Uzcard / Humo / Visa). Send the receipt screenshot in chat and your credits/PRO will be activated right away!",
    ].join("\n"),
  checkoutAsk: (pkgTitle, priceUzs, cardInfo) =>
    [
      `💳 Checkout: ${pkgTitle}`,
      `Amount: ${priceUzs} UZS`,
      "",
      "Payment details:",
      cardInfo,
      "",
      "📸 Make the transfer and send a screenshot (photo or PDF) of the receipt in your next message.",
    ].join("\n"),
  receiptSaved: (id, pkgTitle) => `✅ Receipt received (order #${id} · ${pkgTitle})!\nAn administrator will verify the transfer and activate your package shortly.`,
  receiptNeedMedia: "Please send a photo (screenshot) or PDF receipt of your payment, or type /cancel to abort.",
  adminReceiptCaption: (p, userLine, pkgTitle) =>
    [
      `💰 New payment order #${p.id}`,
      `Customer: ${userLine} (id ${p.user})`,
      `Package: ${pkgTitle}`,
      `Amount: ${fmtUzs(p.price_uzs)} UZS`,
    ].join("\n"),
  btnApprove: (id) => `✅ Approve #${id}`,
  btnReject: (id) => `❌ Reject #${id}`,
  adminApproved: (id, user, pkgTitle) => `✅ Order #${id} approved: granted “${pkgTitle}” to user ${user}.`,
  adminRejected: (id, user) => `❌ Order #${id} (user ${user}) rejected.`,
  adminAlreadyHandled: (id, status) => `Order #${id} was already processed (${status}).`,
  userApprovedCredits: (id, added, balance) => `🎉 Payment #${id} confirmed! +${added} credits added. Your balance: ${balance} cr.\nAll your videos now render without a watermark!`,
  userApprovedVip: (id, days) => `🎉 Payment #${id} confirmed! 👑 PRO (VIP) is now active for ${days} days: no daily limits, no credit charges, and no watermark!`,
  userRejected: (id) => `✖ Payment order #${id} could not be verified. Please check your receipt and try again via 💳 Balance.`,
  promoAsk: "🎁 Send your promo code in the next message (or `/promo CODE`):",
  promoRedeemed: (credits, vipDays, balance) =>
    vipDays > 0
      ? `🎉 Promo code redeemed! 👑 PRO (VIP) unlocked for ${vipDays} days${credits ? ` + ${credits} cr. (balance: ${balance})` : ""}.`
      : `🎉 Promo code redeemed! +${credits} cr. added. Balance: ${balance} cr.`,
  promoNotFound: "✖ Promo code not found.",
  promoExhausted: "✖ This promo code has reached its usage limit.",
  promoAlreadyUsed: "✖ You have already used this promo code.",
  unwmNeedCredits: (need, have) => `Removing the watermark requires ${need} credit (you have ${have}). Choose a package below to top up:`,
  unwmSending: (left) => `✨ Sending the clean original without watermark (credits left: ${left})…`,
  unwmCaption: (outId) => `✨ ${outId} · clean original (no watermark)`,
  watermarkNotice: "💧 Free trial version with watermark. Top up your balance (💳 Balance) or tap “✨ Remove watermark” below to get the clean file.",
  pkgTitle: {
    start: "🚀 Starter (10 credits)",
    creator: "🔥 Creator (30 credits)",
    pro: "👑 PRO Unlimited (30 days)",
  },
};

export const BILLING_STRINGS: Record<Lang, BillingStrings> = {
  ru: BILLING_RU,
  uz: BILLING_UZ,
  en: BILLING_EN,
};

export const tb = (lang: Lang | undefined | null): BillingStrings => BILLING_STRINGS[lang ?? "ru"] ?? BILLING_RU;

export function buyKb(lang: Lang): InlineKeyboard {
  const B = tb(lang);
  return {
    inline_keyboard: [
      [btn(B.btnStartPkg, "B:pkg:start")],
      [btn(B.btnCreatorPkg, "B:pkg:creator")],
      [btn(B.btnProPkg, "B:pkg:pro")],
      [btn(B.btnPromo, "B:promo")],
    ],
  };
}

export function paymentAdminKb(lang: Lang, id: number): InlineKeyboard {
  const B = tb(lang);
  return {
    inline_keyboard: [[btn(B.btnApprove(id), `B:ok:${id}`), btn(B.btnReject(id), `B:no:${id}`)]],
  };
}

/** Renders a watermarked copy (`*_wm.mp4`) for free-trial users while keeping the clean original untouched. */
export async function defaultWatermarkVideo(file: string): Promise<string> {
  const out = file.replace(/\.mp4$/i, "") + "_wm.mp4";
  const { ffmpeg } = await import("../lib/ffmpeg.ts");
  try {
    // Semi-transparent banner with crisp DEMO · @montaj AI text in the top-right corner
    await ffmpeg([
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      "drawbox=x=iw-260:y=28:w=236:h=52:color=black@0.58:t=fill,drawtext=text='DEMO  AI MONTAJ':fontcolor=white@0.92:fontsize=26:x=iw-242:y=42",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ]);
    return out;
  } catch {
    // Fallback if ffmpeg was built without libfreetype (drawtext): drawbox watermark frame
    await ffmpeg([
      "-i",
      file,
      "-map",
      "0:v:0",
      "-map",
      "0:a?",
      "-vf",
      "drawbox=x=iw-240:y=28:w=216:h=48:color=white@0.45:t=fill,drawbox=x=iw-236:y=32:w=208:h=40:color=black@0.55:t=fill",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ]);
    return out;
  }
}

export interface BillingDeps {
  db: BotDb;
  api: BotApi;
  envAdmins: Set<number>;
  isAdmin: (uid: number) => boolean;
  isVip: (uid: number) => boolean;
  langOf: (uid: number) => Lang;
  say: (chatId: number, text: string, kb?: InlineKeyboard) => Promise<number | undefined>;
  edit: (chatId: number, msgId: number, text: string, kb?: InlineKeyboard) => Promise<void>;
  setAwaiting: (uid: number, val: string | undefined) => void;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export function billingHandlers(d: BillingDeps) {
  const { db, api, envAdmins, isAdmin, isVip, langOf, say, edit, setAwaiting, env, log } = d;

  const allAdmins = (): number[] => [...new Set([...envAdmins, ...db.adminIds()])];

  function cardDetails(): string {
    const fromDb = db.getKv("billing.card")?.trim();
    if (fromDb) return fromDb;
    const fromEnv = env.VEDIT_PAYMENT_CARD?.trim();
    if (fromEnv) return fromEnv;
    return "💳 Карта Uzcard / Humo / Visa: напишите администратору или укажите через /setcard <номер карты>";
  }

  async function shop(uid: number, chatId: number) {
    const lang = langOf(uid);
    const B = tb(lang);
    const u = db.getUser(uid);
    await say(chatId, B.shopCard(u?.credits ?? 0, isVip(uid) ? "vip" : (u?.plan ?? "free")), buyKb(lang));
  }

  async function promoCommand(uid: number, chatId: number, rawCode: string) {
    const lang = langOf(uid);
    const B = tb(lang);
    const code = rawCode.trim();
    if (!code) {
      setAwaiting(uid, "promo");
      await say(chatId, B.promoAsk);
      return;
    }
    const r = db.redeemPromo(uid, code);
    if (!r.ok) {
      await say(chatId, r.reason === "not_found" ? B.promoNotFound : r.reason === "exhausted" ? B.promoExhausted : B.promoAlreadyUsed);
      return;
    }
    log(`[${uid}] промокод ${code.toUpperCase()}: +${r.credits} кр., vip_days=${r.vip_days}`);
    await say(chatId, B.promoRedeemed(r.credits, r.vip_days, r.balance));
  }

  async function addPromoCommand(uid: number, chatId: number, arg: string) {
    const parts = arg.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      await say(chatId, "Формат: `/addpromo <КОД> <кредиты> [макс_активаций] [vip_дней]`\nПример: `/addpromo START2026 5 100`");
      return;
    }
    const [code, crStr, usesStr, vipStr] = parts;
    const credits = Number(crStr) || 0;
    const maxUses = Number(usesStr) > 0 ? Number(usesStr) : 1;
    const vipDays = Number(vipStr) > 0 ? Number(vipStr) : 0;
    const row = db.upsertPromo({ code, credits, max_uses: maxUses, vip_days: vipDays, created_by: uid });
    log(`админ ${uid}: промокод ${row.code} (${row.credits} кр., vip=${row.vip_days} дн., лимит ${row.max_uses})`);
    await say(chatId, `✅ Промокод создан: ${row.code}\nКредитов: ${row.credits}, VIP дней: ${row.vip_days}, лимит активаций: ${row.max_uses}`);
  }

  async function setCardCommand(uid: number, chatId: number, arg: string) {
    const val = arg.trim();
    if (!val) {
      await say(chatId, `Текущие реквизиты оплаты:\n${cardDetails()}\n\nЧтобы изменить: /setcard 8600 0000 0000 0000 (Имя Фамилия, Uzcard/Humo)`);
      return;
    }
    db.setKv("billing.card", val);
    log(`админ ${uid}: обновлены реквизиты карты`);
    await say(chatId, `✅ Реквизиты для оплаты сохранены:\n${val}`);
  }

  async function paymentsCommand(uid: number, chatId: number) {
    const rev = db.revenueStats();
    const pending = db.pendingPayments();
    const lines = [
      "💰 Выручка и оплаты",
      `Оплачено заказов: ${rev.count} на сумму ${fmtUzs(rev.total_uzs)} сум`,
      `Ожидают проверки: ${rev.pending}`,
      `Реквизиты: ${cardDetails()}`,
    ];
    if (pending.length) {
      lines.push("", "Ожидают подтверждения:");
      for (const p of pending.slice(0, 10)) {
        lines.push(`• #${p.id} · user ${p.user} · ${p.pkg} (${fmtUzs(p.price_uzs)} сум)`);
      }
    }
    await say(chatId, lines.join("\n"));
  }

  /** Handles receipt photo or document when user is in `awaiting === "pay:<pkg>"` */
  async function onReceipt(uid: number, m: TgMessage, pkgRaw: string): Promise<boolean> {
    const chatId = m.chat.id;
    const lang = langOf(uid);
    const B = tb(lang);
    const pkgId = isTariffId(pkgRaw) ? pkgRaw : "start";
    const pkg = TARIFFS[pkgId];
    const photo = m.photo?.length ? m.photo[m.photo.length - 1] : undefined;
    const doc = m.document;
    if (!photo && !doc) {
      await say(chatId, B.receiptNeedMedia);
      return true;
    }
    const fileId = photo ? photo.file_id : doc!.file_id;
    const kind = photo ? "photo" : "document";
    setAwaiting(uid, undefined);
    const payment = db.insertPayment({
      user: uid,
      pkg: pkg.id,
      credits: pkg.credits,
      vip_days: pkg.vipDays,
      price_uzs: pkg.priceUzs,
      receipt_file_id: fileId,
      receipt_kind: kind,
    });
    log(`[${uid}] чек оплаты #${payment.id}: пакет ${pkg.id} (${pkg.priceUzs} сум)`);
    await say(chatId, B.receiptSaved(payment.id, B.pkgTitle[pkg.id]));

    const u = db.getUser(uid);
    const userLine = [u?.first_name, u?.username ? `@${u.username}` : null].filter(Boolean).join(" ") || String(uid);
    for (const adminId of allAdmins()) {
      const aLang = langOf(adminId);
      const aB = tb(aLang);
      const caption = aB.adminReceiptCaption(payment, userLine, aB.pkgTitle[pkg.id]);
      const kb = paymentAdminKb(aLang, payment.id);
      try {
        if (kind === "photo") await api.sendPhoto(adminId, fileId, caption, kb);
        else await api.sendDocument(adminId, fileId, caption, { reply_markup: kb });
      } catch {
        await say(adminId, caption, kb);
      }
    }
    return true;
  }

  async function unwatermark(uid: number, chatId: number, jobId: string): Promise<string | undefined> {
    const lang = langOf(uid);
    const B = tb(lang);
    const job = db.getJob(jobId);
    if (!job || (job.user !== uid && !isAdmin(uid))) return undefined;
    const outs = db.outputsOf(jobId);
    if (!outs.length) return undefined;
    const freeUnlock = isAdmin(uid) || isVip(uid);
    let left = db.getUser(uid)?.credits ?? 0;
    if (!freeUnlock) {
      if (left < 1) {
        await say(chatId, B.unwmNeedCredits(1, left), buyKb(lang));
        return undefined;
      }
      left = db.addCredits(uid, -1);
      db.addUsage({ user: uid, kind: "credits:unwatermark", units: 1, cost_usd: 0, job_id: jobId });
    }
    await say(chatId, B.unwmSending(left));
    for (const out of outs) {
      try {
        await fs.stat(out.file);
        await api.sendDocument(chatId, out.file, B.unwmCaption(out.id || out.output_id), { disableContentTypeDetection: true });
      } catch {
        await api.sendVideo(chatId, out.file, { caption: B.unwmCaption(out.output_id), duration: out.duration ?? undefined }).catch(() => {});
      }
    }
    return undefined;
  }

  async function callback(uid: number, chatId: number, msgId: number | undefined, data: string): Promise<string | undefined> {
    const [, op, arg] = data.split(":");
    const lang = langOf(uid);
    const B = tb(lang);

    if (op === "shop") {
      await shop(uid, chatId);
      return undefined;
    }
    if (op === "pkg" && isTariffId(arg)) {
      const pkg = TARIFFS[arg];
      setAwaiting(uid, `pay:${pkg.id}`);
      await say(chatId, B.checkoutAsk(B.pkgTitle[pkg.id], fmtUzs(pkg.priceUzs), cardDetails()));
      return undefined;
    }
    if (op === "promo") {
      setAwaiting(uid, "promo");
      await say(chatId, B.promoAsk);
      return undefined;
    }
    if (op === "unwm" && arg) {
      return unwatermark(uid, chatId, arg);
    }
    if ((op === "ok" || op === "no") && arg) {
      if (!isAdmin(uid)) return undefined;
      const payId = Number(arg);
      const existing = db.getPayment(payId);
      if (!existing) return "Заявка не найдена";
      if (existing.status !== "pending") return B.adminAlreadyHandled(payId, existing.status);
      const decision = op === "ok" ? "paid" : "rejected";
      const updated = db.claimPayment(payId, decision, uid);
      if (!updated) return B.adminAlreadyHandled(payId, "processed");
      const pkgId = isTariffId(updated.pkg) ? updated.pkg : "start";
      const summary = decision === "paid" ? B.adminApproved(payId, updated.user, B.pkgTitle[pkgId]) : B.adminRejected(payId, updated.user);
      if (msgId) await edit(chatId, msgId, summary).catch(() => {});
      await say(chatId, summary);

      const uLang = langOf(updated.user);
      const uB = tb(uLang);
      if (decision === "paid") {
        log(`админ ${uid}: оплата #${payId} одобрена (user ${updated.user}, pkg ${updated.pkg})`);
        if (updated.vip_days > 0) {
          await say(updated.user, uB.userApprovedVip(payId, updated.vip_days));
        } else {
          const bal = db.getUser(updated.user)?.credits ?? updated.credits;
          await say(updated.user, uB.userApprovedCredits(payId, updated.credits, bal));
        }
      } else {
        log(`админ ${uid}: оплата #${payId} отклонена (user ${updated.user})`);
        await say(updated.user, uB.userRejected(payId));
      }
      return undefined;
    }
    return undefined;
  }

  return {
    shop,
    promoCommand,
    addPromoCommand,
    setCardCommand,
    paymentsCommand,
    onReceipt,
    callback,
  };
}
