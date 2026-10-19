// Stage 19: users & storage, onboarding, i18n, buttons, quotas, admin, retention, migration of state.json.
// Fake Bot API (tests/helpers/fake-telegram.ts) and fake pipelines — no network, no ffmpeg/renderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s19-ws-"));

const { createBot, MSG, draftInstruction } = await import("../src/bot/index.ts");
const { STRINGS, menuAction, voiceLabel } = await import("../src/bot/i18n.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { FREE_PLAN_FIELDS, dayStart, freePlanFromEnv, maxJobsFromEnv } = await import("../src/bot/plans.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
const { VOICES } = await import("../src/voice/catalog.ts");
const { WORKSPACE_ROOT } = await import("../src/lib/workspace.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type MakeArgs = import("../src/bot/index.ts").MakeArgs;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s19-"));

async function outputFile(name = "output_make.mp4") {
  const f = path.join(await tmp(), name);
  await fs.writeFile(f, "mp4");
  return f;
}

async function boot(extra: Partial<BotOptions> = {}) {
  const tg = fakeTelegram();
  const logs: string[] = [];
  const bot = await createBot({ token: "t", workspace: await tmp(), callMethod: tg.callMethod, download: tg.download, onLog: (l) => logs.push(l), statusEditMs: 0, cleanupIntervalMs: 0, broadcastDelayMs: 0, albumDelayMs: 0, ...extra });
  return { tg, bot, logs };
}

// ── storage ────────────────────────────────────────────────────────────────────

test("db: migrations table, users with credits that never go negative, lookup by @username, settings and sessions", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  assert.deepEqual(db.migrations(), [1, 2, 3]);
  const u = db.touchUser(42, { username: "Alisher", first_name: "Алишер" });
  assert.equal(u.onboarding, "lang");
  assert.equal(u.lang, "ru");
  assert.equal(db.addCredits(42, 5), 5);
  assert.equal(db.addCredits(42, -9), 0);
  assert.equal(db.findUser("@alisher")?.tg_id, 42);
  assert.equal(db.findUser("42")?.first_name, "Алишер");
  db.setSetting(42, "aspect", "16:9");
  db.setSetting(42, "voice", "denis");
  db.setSetting(42, "voice", undefined);
  assert.deepEqual(db.getSettings(42), { aspect: "16:9" });
  db.setSession(42, { source: "a.mp4", sources: [] });
  assert.deepEqual(db.getSession(42), { source: "a.mp4", sources: [] });
  // a second open of the same file does not re-run migrations
  db.close();
  const again = new BotDb(db.file);
  assert.deepEqual(again.migrations(), [1, 2, 3]);
  assert.equal(again.getUser(42)?.credits, 0);
  again.close();
});

test("plans: env overrides, bad values refused, quota day starts at local midnight (UTC+5)", () => {
  const p = freePlanFromEnv({ VEDIT_FREE_JOBS_PER_DAY: "5", VEDIT_CREDITS_LONG: "4" });
  assert.equal(p.standardPerDay, 5);
  assert.equal(p.creditsLong, 4);
  assert.equal(p.longPerDay, 1);
  assert.throws(() => freePlanFromEnv({ VEDIT_TRIAL_CREDITS: "-1" }), /VEDIT_TRIAL_CREDITS/);
  assert.equal(maxJobsFromEnv({}, 8 * 1024 ** 3), 1);
  assert.equal(maxJobsFromEnv({}, 24 * 1024 ** 3), 2);
  assert.equal(maxJobsFromEnv({ VEDIT_MAX_JOBS: "3" }), 3);
  // 2026-10-16 03:00 UTC = 08:00 in Tashkent → the day started 2026-10-15 19:00 UTC
  assert.equal(dayStart(Date.parse("2026-10-16T03:00:00Z"), 5), "2026-10-15T19:00:00.000Z");
  assert.equal(dayStart(Date.parse("2026-10-16T20:00:00Z"), 5), "2026-10-16T19:00:00.000Z");
  assert.ok(FREE_PLAN_FIELDS.every((f) => f.env.startsWith("VEDIT_")));
});

// ── i18n ───────────────────────────────────────────────────────────────────────

test("i18n: ru, uz, en have the same keys, no empty strings, same function arity, and are really translated", () => {
  const sample = (fn: (...a: never[]) => unknown, n: number) => {
    const args = [3, 5, 1, 15].slice(0, n);
    try {
      return (fn as (...a: unknown[]) => unknown)(...args);
    } catch {
      return "ok"; // functions taking objects are exercised by the bot tests
    }
  };
  const walk = (ru: Record<string, unknown>, other: Record<string, unknown>, lang: string, prefix = ""): { same: string[]; total: number } => {
    let same: string[] = [];
    let total = 0;
    assert.deepEqual(Object.keys(other).sort(), Object.keys(ru).sort(), `${lang}: keys of ${prefix || "root"}`);
    for (const k of Object.keys(ru)) {
      const a = ru[k];
      const b = other[k];
      const key = `${prefix}${k}`;
      assert.equal(typeof b, typeof a, `${lang}.${key}: type`);
      if (typeof a === "string") {
        assert.ok((b as string).trim().length > 0, `${lang}.${key} is empty`);
        total++;
        if (a === b) same.push(key);
      } else if (typeof a === "function") {
        assert.equal((b as () => void).length, (a as () => void).length, `${lang}.${key}: arity`);
        const out = sample(b as never, (a as () => void).length);
        assert.ok(typeof out !== "string" || out.trim().length > 0, `${lang}.${key}() is empty`);
        total++;
        if (sample(a as never, (a as () => void).length) === out && out !== "ok") same.push(key);
      } else if (a && typeof a === "object") {
        const r = walk(a as Record<string, unknown>, b as Record<string, unknown>, lang, `${key}.`);
        same = same.concat(r.same);
        total += r.total;
      }
    }
    return { same, total };
  };
  for (const lang of ["uz", "en"] as const) {
    const r = walk(STRINGS.ru as unknown as Record<string, unknown>, STRINGS[lang] as unknown as Record<string, unknown>, lang);
    // only the trilingual language prompt and language-neutral bits may stay identical
    assert.ok(r.same.every((k) => ["langPrompt", "kind.avatar", "purpose.sport", "mode.hl"].includes(k) || /^(btnCredits|countLabel|secondsLabel)$/.test(k)), `${lang}: untranslated ${r.same.join(", ")}`);
    assert.ok(r.total > 120, `${lang}: ${r.total} strings`);
  }
  assert.match(STRINGS.uz.menu.make, /Mavzu bo‘yicha rolik/);
  assert.ok(!/[а-яё]/i.test(STRINGS.uz.help.replace(/\/\w+/g, "")), "Uzbek in Latin script");
  // every menu label of every language maps back to its action
  for (const lang of ["ru", "uz", "en"] as const) for (const [k, label] of Object.entries(STRINGS[lang].menu)) assert.equal(menuAction(label), k);
  assert.equal(menuAction("просто текст"), undefined);
  assert.equal(voiceLabel(VOICES.find((v) => v.id === "gemini_charon")!, "en"), "Charon (Gemini) ♂");
  assert.match(voiceLabel(VOICES.find((v) => v.id === "gemini_kore")!, "ru"), /^Кора \(Gemini\) ♀$/);
  // the stage 7–16 MSG table is the Russian one
  assert.equal(MSG.videoSaved, STRINGS.ru.videoSaved);
});

// ── onboarding ─────────────────────────────────────────────────────────────────

test("onboarding in Uzbek: language → intro + purpose → terms (with the texts) → trial credits and the main menu; /start again shows the menu", async () => {
  const { tg, bot } = await boot({ pipeline: async () => assert.fail("no pipeline before registration"), plan: { trialCredits: 4 } });
  await bot.handleUpdate(tg.text(50, "salom", 50, { username: "aziz", first_name: "Aziz" }));
  assert.equal(tg.texts(50).at(-1), STRINGS.ru.langPrompt);
  const langMsg = [...tg.calls].reverse().find((c) => c.method === "sendMessage")!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(langMsg)), ["🇷🇺 Русский=L:ru", "🇺🇿 O‘zbekcha=L:uz", "🇬🇧 English=L:en"]);
  const msgId = tg.messageIdOf(langMsg)!;
  // a video before registration only repeats the step
  await bot.handleUpdate(tg.video(50, "EARLY"));
  assert.equal(tg.texts(50).at(-1), STRINGS.ru.langPrompt);

  await bot.handleUpdate(tg.press(50, "L:uz", msgId));
  assert.equal(bot.user(50)!.lang, "uz");
  assert.equal(bot.user(50)!.onboarding, "purpose");
  assert.equal(tg.edits(50).at(-1), `${STRINGS.uz.intro}\n\n${STRINGS.uz.askPurpose}`);
  assert.deepEqual(tg.buttons(tg.markupOf(msgId)), ["Blog / kontent=P:blog", "Biznes / reklama=P:biz", "Sport=P:sport", "Boshqa=P:other"]);
  // other buttons are refused with a toast until registration ends
  await bot.handleUpdate(tg.press(50, "M:go", msgId));
  assert.equal(tg.lastToast(), STRINGS.uz.needStart);

  await bot.handleUpdate(tg.press(50, "P:sport", msgId));
  assert.equal(bot.user(50)!.purpose, "sport");
  assert.match(tg.edits(50).at(-1)!, /foydalanish shartlari va maxfiylik/);
  assert.match(tg.edits(50).at(-1)!, /7 kundan keyin/);
  assert.deepEqual(tg.buttons(tg.markupOf(msgId)), ["📄 Shartlar=T:terms", "🔒 Maxfiylik=T:privacy", "✅ Qabul qilaman=T:ok"]);
  await bot.handleUpdate(tg.press(50, "T:terms", msgId));
  assert.match(tg.texts(50).at(-1)!, /Foydalanish shartlari \(qoralama\)/);
  await bot.handleUpdate(tg.press(50, "T:privacy", msgId));
  assert.match(tg.texts(50).at(-1)!, /Anthropic \(Claude\)/);

  await bot.handleUpdate(tg.press(50, "T:ok", msgId));
  const u = bot.user(50)!;
  assert.equal(u.onboarding, "done");
  assert.ok(u.accepted_terms_at);
  assert.equal(u.credits, 4);
  const welcome = [...tg.calls].reverse().find((c) => c.method === "sendMessage")!;
  assert.equal(welcome.params.text, STRINGS.uz.welcome(4, 3, 1, 15));
  assert.deepEqual((welcome.params.reply_markup as { inline_keyboard: { text: string }[][] }).inline_keyboard.flat().map((b) => b.text), Object.values(STRINGS.uz.menu));
  // a user registered after the switch never gets the "remove the old keyboard" message
  assert.ok(!tg.calls.some((c) => (c.params.reply_markup as { remove_keyboard?: boolean } | undefined)?.remove_keyboard));

  await bot.handleUpdate(tg.text(50, "/start"));
  assert.equal(tg.texts(50).at(-1), STRINGS.uz.menuText);
  // menu buttons work in Uzbek: the inline button and the old label typed as text
  await bot.handleUpdate(tg.press(50, "H:balance", msgId));
  assert.match(tg.texts(50).at(-1)!, /💳 Balans[\s\S]*Kreditlar: 4[\s\S]*Bugun bepul: oddiy 0\/3, uzun 0\/1[\s\S]*Tez orada: to‘lov/);
  await bot.handleUpdate(tg.text(50, STRINGS.uz.menu.balance));
  assert.match(tg.texts(50).at(-1)!, /💳 Balans/);
  bot.close();
});

test("closed beta: TELEGRAM_ALLOWED_USERS ignores strangers (messages and buttons); the first allowed id is the admin", async () => {
  const { tg, bot, logs } = await boot({ allowedUserIds: [1, 2], onboarding: false });
  await bot.handleUpdate(tg.text(9, "/start"));
  await bot.handleUpdate(tg.press(9, "S:a:16:9", 5));
  assert.equal(tg.calls.filter((c) => c.params.chat_id === 9 && c.method !== "answerCallbackQuery").length, 0);
  assert.equal(bot.user(9), undefined, "strangers are not even stored");
  assert.ok(logs.some((l) => /9 не в TELEGRAM_ALLOWED_USERS/.test(l)));
  await bot.handleUpdate(tg.text(1, "/admin"));
  assert.equal(tg.texts(1).at(-1), STRINGS.ru.adminMenu);
  await bot.handleUpdate(tg.text(2, "/admin"));
  assert.equal(tg.texts(2).at(-1), STRINGS.ru.unknownCommand, "/admin is invisible to non-admins");
  bot.close();
});

// ── buttons ────────────────────────────────────────────────────────────────────

test("🏀 preselects highlights only for one video; a second video switches the card to one clip; /clear forgets the mode", async () => {
  const { tg, bot } = await boot({ onboarding: false, quotas: false, pipeline: async () => assert.fail("no run") });
  await bot.handleUpdate(tg.press(4, "H:highlights", 1));
  await bot.handleUpdate(tg.video(4, "G1"));
  assert.equal(bot.session(4).draft?.mode, "hl");
  await bot.handleUpdate(tg.video(4, "G2"));
  assert.equal(bot.session(4).draft?.mode, "viral", "several videos are not a highlights batch");
  await bot.handleUpdate(tg.text(4, "/clear"));
  assert.equal(bot.session(4).intent, undefined);
  await bot.handleUpdate(tg.video(4, "T1"));
  assert.equal(bot.session(4).draft?.mode, "reels", "after /clear the 🏀 choice is gone");
  bot.close();
});

test("montage by buttons: video → option card; mode / format / style toggles edit the keyboard; ▶️ starts the run with the composed instruction", async () => {
  const runs: PipelineArgs[] = [];
  const out = await outputFile("output_reel_1.mp4");
  const { tg, bot } = await boot({ onboarding: false, quotas: false, pipeline: async (a) => (runs.push(a), { jobId: "20261016-aaaaaa", outputs: [{ id: "reel_1", file: out, duration: 30, aspect: "16:9" }] }) });
  await bot.handleUpdate(tg.text(3, MSG.menu.montage));
  assert.equal(tg.texts(3).at(-1), MSG.montageAsk(20));
  await bot.handleUpdate(tg.video(3, "V1"));
  const card = tg.sent(3, MSG.videoSaved)!;
  const id = tg.messageIdOf(card)!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(card)), [
    "✓ Рилсы из лучших моментов=M:m:reels",
    "Один вирусный ролик=M:m:viral",
    "Хайлайты=M:m:hl",
    "По отдельности на каждого=M:m:pp",
    "1 шт=M:n:1",
    "✓ 3 шт=M:n:3",
    "5 шт=M:n:5",
    "✓ 30 с=M:s:30",
    "60 с=M:s:60",
    "90 с=M:s:90",
    "✓ 9:16=M:a:9:16",
    "16:9=M:a:16:9",
    "✓ Динамичный=M:y:pop",
    "Чистые (как у экспертов)=M:y:clean",
    "Плашка с подсветкой=M:y:box",
    "Сплит=M:y:split",
    "Спокойный=M:y:calm",
    "▶️ Начать=M:go",
  ]);
  await bot.handleUpdate(tg.press(3, "M:m:viral", id));
  await bot.handleUpdate(tg.press(3, "M:a:16:9", id));
  await bot.handleUpdate(tg.press(3, "M:y:split", id));
  const kb = tg.buttons(tg.markupOf(id));
  assert.ok(kb.includes("✓ Один вирусный ролик=M:m:viral") && kb.includes("✓ 16:9=M:a:16:9") && kb.includes("✓ Сплит=M:y:split") && kb.includes("✓ 60 с=M:s:60"));
  assert.ok(!kb.some((b) => b.includes("M:n:")), "the count chips are only for reels");
  assert.equal(tg.calls.filter((c) => c.method === "answerCallbackQuery").length, 3, "every press is answered");
  await bot.handleUpdate(tg.press(3, "M:go", id));
  await bot.idle();
  assert.equal(runs.length, 1);
  assert.match(runs[0].instruction, /самый вирусный ролик около 60 секунд[\s\S]*Формат 16:9\. Субтитры на языке речи\./);
  assert.equal(runs[0].preset, "split_news");
  assert.deepEqual(tg.markupOf(id), [], "the card loses its buttons once the job is accepted");
  // the result card: another take, edit, other format, rating
  const result = tg.sent(3, /^Готово: 1 ролик/)!;
  const resultId = tg.messageIdOf(result)!;
  const jobId = /A:(\w+)/.exec(tg.buttons(tg.keyboardOf(result)).join(" "))![1];
  assert.deepEqual(tg.buttons(tg.keyboardOf(result)), [`🔁 Ещё вариант=A:${jobId}`, `✏️ Поправить=E:${jobId}`, `📐 Другой формат=F:${jobId}`, ...[1, 2, 3, 4, 5].map((n) => `${n}⭐=r:${jobId}:${n}`)]);
  await bot.handleUpdate(tg.press(3, `r:${jobId}:4`, resultId));
  assert.equal(bot.db.getJob(jobId)!.rating, 4);
  assert.equal(tg.lastToast(), MSG.rated(4));
  // stage 28: the same message asks what was liked; «Готово» twice brings the result back with the stars
  assert.equal(tg.buttons(tg.markupOf(resultId)).at(-1), `✅ Готово=fb:${jobId}:ok`);
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:ok`, resultId));
  await bot.handleUpdate(tg.press(3, `fb:${jobId}:end`, resultId));
  assert.deepEqual(tg.buttons(tg.markupOf(resultId)).at(-1), `⭐⭐⭐⭐ · изменить=fb:${jobId}:re`);
  assert.ok(draftInstruction({ mode: "reels", count: 5, seconds: 90, aspect: "9:16", style: "pop" }).startsWith("5 рилсов по 90 секунд"));
  assert.match(draftInstruction({ mode: "hl", count: 1, seconds: 60, aspect: "9:16", style: "pop" }), /броски/);
  bot.close();
});

test("make by buttons: topic → format and voice card with ▶️ samples → start; result buttons re-run (edit, other format, another take)", async () => {
  const makes: MakeArgs[] = [];
  const samples: string[] = [];
  const out = await outputFile();
  const { tg, bot } = await boot({
    onboarding: false,
    quotas: false,
    make: async (a) => {
      makes.push(a);
      a.onJob(`20261016-m${makes.length}`);
      return { jobId: `20261016-m${makes.length}`, title: a.topic, outputs: [{ id: "make", file: out, duration: 35, aspect: a.aspect }] };
    },
    voiceSample: async (id, dest) => {
      samples.push(id);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, "OggS");
      return dest;
    },
  });
  await bot.handleUpdate(tg.text(4, MSG.menu.make));
  assert.equal(tg.texts(4).at(-1), MSG.makeAskTopic);
  await bot.handleUpdate(tg.text(4, "почему кофе дорожает"));
  const card = tg.sent(4, "Тема: «почему кофе дорожает»")!;
  const id = tg.messageIdOf(card)!;
  const kb = tg.buttons(tg.keyboardOf(card));
  assert.deepEqual(kb.slice(0, 5), ["✓ 9:16=K:a:9:16", "16:9=K:a:16:9", "1:1=K:a:1:1", "✓ Авто=K:v:auto", "Без голоса=K:v:off"]);
  assert.ok(kb.includes("Харон (Gemini) ♂=K:v:gemini_charon") && kb.includes("▶️=K:p:dmitri"));
  await bot.handleUpdate(tg.press(4, "K:p:dmitri", id));
  await bot.idle();
  assert.deepEqual(samples, ["dmitri"]);
  assert.ok(tg.calls.some((c) => c.method === "sendVoice"));
  await bot.handleUpdate(tg.press(4, "K:v:gemini_kore", id));
  await bot.handleUpdate(tg.press(4, "K:a:16:9", id));
  await bot.handleUpdate(tg.press(4, "K:go", id));
  await bot.idle();
  assert.deepEqual([makes[0].topic, makes[0].aspect, makes[0].voice], ["почему кофе дорожает", "16:9", "gemini_kore"]);
  const jobId = bot.db.lastJob(4)!.id;
  // ✏️ → a text → the topic again with the note
  await bot.handleUpdate(tg.press(4, `E:${jobId}`, 1));
  assert.equal(tg.texts(4).at(-1), MSG.askEdit);
  await bot.handleUpdate(tg.text(4, "короче и про Бразилию"));
  await bot.idle();
  assert.equal(makes[1].topic, "почему кофе дорожает. Учти правку: короче и про Бразилию");
  // 📐 → the same script in the other frame
  await bot.handleUpdate(tg.press(4, `F:${jobId}`, 1));
  await bot.idle();
  assert.deepEqual([makes[2].aspect, makes[2].fromJob], ["9:16", "20261016-m1"]);
  // 🔁 → a new script on the same topic
  await bot.handleUpdate(tg.press(4, `A:${jobId}`, 1));
  await bot.idle();
  assert.deepEqual([makes[3].topic, makes[3].aspect], ["почему кофе дорожает", "16:9"]);
  bot.close();
});

test("settings card: format, style, delivery, voice list with samples, language (menu switches), news opt-out — all stored per user", async () => {
  const { tg, bot } = await boot({ onboarding: false, quotas: false, voiceSample: async (_id, dest) => (await fs.mkdir(path.dirname(dest), { recursive: true }), await fs.writeFile(dest, "OggS"), dest) });
  await bot.handleUpdate(tg.text(5, MSG.menu.settings));
  const card = tg.sent(5, "⚙️ Настройки")!;
  const id = tg.messageIdOf(card)!;
  assert.match(String(card.params.text), /Формат: 9:16[\s\S]*Стиль монтажа: Динамичный[\s\S]*Голос: Авто[\s\S]*Как присылать: файлом[\s\S]*Язык: Русский[\s\S]*Новости бота: вкл/);
  for (const d of ["S:a:16:9", "S:y:calm", "S:s:both", "S:n"]) await bot.handleUpdate(tg.press(5, d, id));
  assert.deepEqual(bot.settings(5), { aspect: "16:9", style: "calm", send: "both" });
  assert.equal(bot.user(5)!.news, 0);
  assert.match(tg.edits(5).at(-1)!, /Формат: 16:9[\s\S]*Спокойный[\s\S]*видео и файлом[\s\S]*Новости бота: выкл/);
  await bot.handleUpdate(tg.press(5, "S:v", id));
  assert.equal(tg.edits(5).at(-1), MSG.voicePick);
  assert.ok(tg.buttons(tg.markupOf(id)).includes("▶️=VP:denis"));
  await bot.handleUpdate(tg.press(5, "V:denis", id));
  await bot.idle();
  assert.equal(bot.settings(5).voice, "denis");
  assert.ok(tg.calls.some((c) => c.method === "sendVoice"), "choosing a voice plays its sample");
  await bot.handleUpdate(tg.press(5, "S:back", id));
  assert.match(tg.edits(5).at(-1)!, /Голос: Денис ♂/);
  await bot.handleUpdate(tg.press(5, "S:l:en", id));
  assert.equal(bot.user(5)!.lang, "en");
  assert.match(tg.edits(5).at(-1)!, /^⚙️ Settings/);
  assert.equal(tg.texts(5).at(-1), STRINGS.en.menuText, "the menu comes back in English");
  // the settings are used: a new make gets the format, the voice
  bot.close();
});

test("long callback payloads go through the short id map (≤ 64 bytes on the wire)", async () => {
  const { tg, bot } = await boot({ onboarding: false, quotas: false });
  await bot.handleUpdate(tg.text(6, MSG.menu.settings));
  const id = tg.messageIdOf(tg.sent(6, "⚙️")!)!;
  const short = bot.db.putCallback("S:a:16:9");
  await bot.handleUpdate(tg.press(6, `~${short}`, id));
  assert.equal(bot.settings(6).aspect, "16:9");
  for (const c of tg.calls) {
    const kb = (c.params.reply_markup as { inline_keyboard?: { callback_data?: string }[][] } | undefined)?.inline_keyboard;
    for (const b of kb?.flat() ?? []) assert.ok(Buffer.byteLength(b.callback_data ?? "") <= 64, String(b.callback_data));
  }
  bot.close();
});

// ── quotas ─────────────────────────────────────────────────────────────────────

test("quotas: free jobs per day, then credits (charged, refunded on failure), then refusal; long jobs (highlights) have their own limit", async () => {
  let fail = false;
  const out = await outputFile();
  const { tg, bot } = await boot({
    onboarding: false,
    plan: { standardPerDay: 2, longPerDay: 1, creditsStandard: 1, creditsLong: 3, trialCredits: 0 },
    make: async (a) => {
      if (fail) throw new Error("render упал");
      return { jobId: "20261016-q", title: a.topic, outputs: [{ id: "make", file: out }] };
    },
    pipeline: async () => ({ jobId: "20261016-h", outputs: [] }),
  });
  const make = async (t: string) => {
    await bot.handleUpdate(tg.text(7, `/make ${t}`));
    await bot.idle();
  };
  await make("один");
  await make("два");
  await make("три");
  assert.equal(tg.texts(7).at(-1), MSG.quotaExceeded(false, 1, 0));
  assert.equal(bot.db.jobsByStatus("done").length, 2);
  bot.db.addCredits(7, 2);
  await make("три");
  assert.equal(bot.user(7)!.credits, 1, "one credit charged");
  assert.ok(tg.edits(7).some((e) => e.includes(MSG.paidNote(1, 1))));
  fail = true;
  await make("четыре");
  assert.equal(bot.user(7)!.credits, 1, "a failed paid job gives the credit back");
  assert.equal(tg.texts(7).at(-1), MSG.failed, "a regular user gets the friendly text");
  fail = false;
  await bot.handleUpdate(tg.text(7, MSG.menu.balance));
  assert.match(tg.texts(7).at(-1)!, /Кредиты: 1[\s\S]*обычных 2\/2, длинных 0\/1/);

  // highlights: long class, its own daily limit
  await bot.handleUpdate(tg.video(7, "GAME"));
  const card = tg.messageIdOf(tg.sent(7, MSG.videoSaved)!)!;
  await bot.handleUpdate(tg.press(7, "M:m:hl", card));
  await bot.handleUpdate(tg.press(7, "M:go", card));
  await bot.idle();
  assert.equal(bot.db.lastJob(7)!.class, "long");
  await bot.handleUpdate(tg.video(7, "GAME2"));
  const card2 = tg.messageIdOf(tg.sent(7, MSG.videoSaved)!)!;
  await bot.handleUpdate(tg.press(7, "M:m:hl", card2));
  await bot.handleUpdate(tg.press(7, "M:go", card2));
  assert.equal(tg.texts(7).at(-1), MSG.quotaExceeded(true, 3, 1));
  assert.ok(tg.markupOf(card2).length > 0, "a refused card keeps its buttons");
  bot.close();
});

// ── admin ──────────────────────────────────────────────────────────────────────

test("admin: stats, find a user, +credits (user notified in their language), ban/unban, make admin, live limits; non-admins cannot press admin buttons", async () => {
  const { tg, bot } = await boot({ onboarding: false, adminIds: [1] });
  await bot.handleUpdate(tg.text(20, "привет", 20, { username: "dilnoza", first_name: "Dilnoza" }));
  bot.db.updateUser(20, { lang: "uz" });
  // a non-admin pressing an admin button
  await bot.handleUpdate(tg.press(20, "a:c:20:20", 1));
  assert.equal(bot.user(20)!.credits, 0);
  assert.equal(tg.lastToast(), STRINGS.uz.unknownCommand);

  await bot.handleUpdate(tg.text(1, "/admin"));
  const menu = tg.sent(1, MSG.adminMenu)!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(menu)), ["📊 Статистика=a:st", "👤 Найти пользователя=a:f", "📣 Рассылка=a:b", "⚙️ Лимиты=a:l", "📊 Оценки=a:fb:30:n"]);
  await bot.handleUpdate(tg.press(1, "a:st", 1));
  assert.match(tg.texts(1).at(-1)!, /Пользователи: 2 \(новых сегодня 2[\s\S]*Очередь: в работе 0\/\d+, ждут 0/);
  await bot.handleUpdate(tg.press(1, "a:f", 1));
  assert.equal(tg.texts(1).at(-1), MSG.askUser);
  await bot.handleUpdate(tg.text(1, "@Dilnoza"));
  const card = tg.sent(1, "👤 Dilnoza @dilnoza · id 20")!;
  const cardId = tg.messageIdOf(card)!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(card)), ["+1 кр.=a:c:20:1", "+5 кр.=a:c:20:5", "+20 кр.=a:c:20:20", "🚫 Заблокировать=a:ban:20", "⭐ Сделать админом=a:adm:20"]);
  await bot.handleUpdate(tg.press(1, "a:c:20:5", cardId));
  assert.equal(bot.user(20)!.credits, 5);
  assert.equal(tg.texts(20).at(-1), STRINGS.uz.creditsGrantedUser(5, 5));
  assert.match(tg.edits(1).at(-1)!, /кредиты: 5/);
  await bot.handleUpdate(tg.press(1, "a:ban:20", cardId));
  assert.equal(bot.user(20)!.status, "banned");
  await bot.handleUpdate(tg.text(20, "/make тема"));
  assert.equal(tg.texts(20).at(-1), STRINGS.uz.banned);
  await bot.handleUpdate(tg.press(1, "a:ban:20", cardId));
  assert.equal(bot.user(20)!.status, "active");
  await bot.handleUpdate(tg.press(1, "a:ban:1", cardId));
  assert.equal(bot.user(1)!.status, "active", "an env admin cannot be banned");
  await bot.handleUpdate(tg.press(1, "a:adm:20", cardId));
  assert.equal(bot.user(20)!.role, "admin");
  await bot.handleUpdate(tg.text(20, "/admin"));
  assert.equal(tg.texts(20).at(-1), STRINGS.uz.adminMenu, "a granted admin gets the panel");

  await bot.handleUpdate(tg.press(1, "a:l", 1));
  const limits = tg.sent(1, "⚙️ Лимиты бесплатного тарифа")!;
  assert.match(String(limits.params.text), /1\. бесплатных обычных задач в день: 3/);
  await bot.handleUpdate(tg.press(1, "a:lv:0:+", tg.messageIdOf(limits)!));
  await bot.handleUpdate(tg.press(1, "a:lv:6:-", tg.messageIdOf(limits)!));
  assert.equal(bot.db.getKv("plan.free.standardPerDay"), "4");
  assert.equal(bot.db.getKv("plan.free.uploadMb"), "15");
  assert.match(tg.edits(1).at(-1)!, /1\. бесплатных обычных задач в день: 4/);
  await bot.handleUpdate(tg.text(20, STRINGS.uz.menu.balance));
  assert.match(tg.texts(20).at(-1)!, /administrator/, "admins have no limits");
  bot.close();
});

test("admin broadcast: text → confirm → sent to active registered users (≤ 20/s), not to banned or opted-out ones; footer in each user's language", async () => {
  const { tg, bot } = await boot({ onboarding: false, adminIds: [1] });
  for (const id of [11, 12, 13, 14]) await bot.handleUpdate(tg.text(id, "/start"));
  bot.db.updateUser(12, { news: 0 });
  bot.db.updateUser(13, { status: "banned" });
  bot.db.updateUser(14, { lang: "en" });
  await bot.handleUpdate(tg.press(1, "a:b", 1));
  assert.equal(tg.texts(1).at(-1), MSG.askBroadcast);
  await bot.handleUpdate(tg.text(1, "Новые голоса уже в боте!"));
  const confirm = tg.sent(1, "Отправить 3 пользователям?")!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(confirm)), ["✅ Отправить=a:bs", "✖ Отмена=a:bx"]);
  await bot.handleUpdate(tg.press(1, "a:bs", tg.messageIdOf(confirm)!));
  await bot.idle();
  const got = (id: number) => tg.texts(id).filter((t) => t.startsWith("Новые голоса"));
  assert.equal(got(11).length, 1);
  assert.equal(got(12).length, 0, "opted out");
  assert.equal(got(13).length, 0, "banned");
  assert.ok(got(14)[0].endsWith(STRINGS.en.broadcastFooter));
  assert.equal(got(1).length, 1, "the admin is a user too");
  assert.equal(tg.texts(1).at(-1), MSG.broadcastDone(3, 0));
  // cancel path
  await bot.handleUpdate(tg.press(1, "a:b", 1));
  await bot.handleUpdate(tg.text(1, "другое"));
  await bot.handleUpdate(tg.press(1, "a:bx", tg.messageIdOf(tg.sent(1, "другое")!)!));
  assert.equal(tg.edits(1).at(-1), MSG.broadcastCancelled);
  bot.close();
});

test("a failed job: the user gets a friendly text + «Попробовать ещё раз», admins get the technical error; retry re-runs the same job", async () => {
  let n = 0;
  const { tg, bot } = await boot({
    onboarding: false,
    quotas: false,
    adminIds: [1],
    make: async (a) => {
      if (++n === 1) throw new Error("hyperframes render прерван (таймаут 300s)\nstack…");
      return { jobId: "20261016-ok", title: a.topic, outputs: [] };
    },
  });
  await bot.handleUpdate(tg.text(30, "/make кофе"));
  await bot.idle();
  const fail = tg.sent(30, MSG.failed)!;
  const jobId = bot.db.lastJob(30)!.id;
  assert.deepEqual(tg.buttons(tg.keyboardOf(fail)), [`🔁 Попробовать ещё раз=R:${jobId}`]);
  assert.ok(!tg.texts(30).some((t) => /hyperframes/.test(t)), "no technical details for the user");
  assert.equal(tg.texts(1).at(-1), MSG.adminJobFailed(30, jobId, "make", "✖ hyperframes render прерван (таймаут 300s)"));
  assert.equal(bot.db.getJob(jobId)!.status, "failed");
  await bot.handleUpdate(tg.press(30, `R:${jobId}`, tg.messageIdOf(fail)!));
  await bot.idle();
  assert.equal(n, 2);
  assert.match(tg.texts(30).at(-1)!, /^Новых роликов нет/);
  bot.close();
});

// ── retention & migration ──────────────────────────────────────────────────────

test("retention: old uploads and finished job folders are deleted, fresh ones and folders shared with a recent revision are kept", async () => {
  const { bot } = await boot({ onboarding: false, retentionDays: 7 });
  const now = Date.parse("2026-10-16T12:00:00Z");
  const old = new Date(now - 9 * 86_400_000);
  const up = path.join(bot.usersDir, "77", "uploads");
  await fs.mkdir(up, { recursive: true });
  await fs.writeFile(path.join(up, "old.mp4"), "x".repeat(100));
  await fs.writeFile(path.join(up, "new.mp4"), "y");
  await fs.utimes(path.join(up, "old.mp4"), old, old);
  const oldAvatar = path.join(bot.usersDir, "77", "avatar");
  await fs.mkdir(oldAvatar, { recursive: true });
  await fs.writeFile(path.join(oldAvatar, "p.jpg"), "z");
  await fs.utimes(path.join(oldAvatar, "p.jpg"), old, old);
  const mk = async (name: string) => {
    await fs.mkdir(path.join(WORKSPACE_ROOT, name), { recursive: true });
    await fs.writeFile(path.join(WORKSPACE_ROOT, name, "output_reel_1.mp4"), "v");
  };
  await mk("20261001-aaaaaa");
  await mk("20261002-bbbbbb");
  const iso = (ms: number) => new Date(ms).toISOString();
  bot.db.insertJob({ id: "jold", user: 77, chat_id: 77, kind: "run", class: "standard", payload: "{}", status: "done", vedit_job: "20261001-aaaaaa", created_at: iso(old.getTime()), finished_at: iso(old.getTime()) });
  bot.db.insertJob({ id: "jold2", user: 77, chat_id: 77, kind: "run", class: "standard", payload: "{}", status: "done", vedit_job: "20261002-bbbbbb", created_at: iso(old.getTime()), finished_at: iso(old.getTime()) });
  // a revision of the second job two days ago keeps its folder
  bot.db.insertJob({ id: "jrev", user: 77, chat_id: 77, kind: "revise", class: "standard", payload: "{}", status: "done", vedit_job: "20261002-bbbbbb", created_at: iso(now - 2 * 86_400_000), finished_at: iso(now - 2 * 86_400_000) });
  const r = await bot.retention(now);
  assert.equal(r.files, 2);
  assert.equal(r.jobs, 1);
  assert.deepEqual(await fs.readdir(up), ["new.mp4"]);
  assert.equal(await fs.stat(oldAvatar).catch(() => null), null, "an emptied folder goes too");
  assert.equal(await fs.stat(path.join(WORKSPACE_ROOT, "20261001-aaaaaa")).catch(() => null), null);
  assert.ok(await fs.stat(path.join(WORKSPACE_ROOT, "20261002-bbbbbb")));
  assert.equal(bot.db.getJob("jold")!.purged, 1);
  assert.equal(bot.db.getJob("jold2")!.purged, 0);
  bot.close();
});

test("migration: the stage 7–18 state.json becomes users, settings and sessions; the offset is kept; migrated users only confirm the terms", async () => {
  const workspace = await tmp();
  const botDir = path.join(workspace, "_bot");
  await fs.mkdir(botDir, { recursive: true });
  const src = path.join(botDir, "111", "SRC.mp4");
  await fs.mkdir(path.dirname(src), { recursive: true });
  await fs.writeFile(src, "video");
  await fs.writeFile(
    path.join(botDir, "state.json"),
    JSON.stringify({ version: 1, offset: 4242, chats: { "111": { source: src, sources: [src], batch_closed: true, style: "split_news", voice: "denis", send: "video", jobId: "20261010-cafe00", prompt: "3 рилса" }, "-100500": { sources: [] } } }),
  );
  const tg = fakeTelegram();
  const bot = await createBot({ token: "t", workspace, callMethod: tg.callMethod, download: tg.download, onLog: () => {}, statusEditMs: 0, cleanupIntervalMs: 0 });
  assert.equal(bot.offset, 4242);
  assert.deepEqual(bot.settings(111), { style: "split_news", voice: "denis", send: "video" });
  assert.equal(bot.session(111).source, src);
  assert.equal(bot.session(111).jobId, "20261010-cafe00");
  assert.equal(bot.user(111)!.onboarding, "terms");
  assert.equal(bot.user(-100500), undefined, "group chats are not users");
  assert.ok(await fs.stat(path.join(botDir, "state.json.migrated")));
  assert.equal(await fs.stat(path.join(botDir, "state.json")).catch(() => null), null);
  await bot.handleUpdate(tg.text(111, "привет"));
  assert.equal(tg.texts(111).at(-1), MSG.terms(7));
  await bot.handleUpdate(tg.press(111, "T:ok", 5));
  assert.equal(bot.user(111)!.onboarding, "done");
  // the old video is still the current one
  await bot.handleUpdate(tg.text(111, "/status"));
  assert.match(tg.texts(111).at(-1)!, /Видео: SRC\.mp4[\s\S]*Задача: 3 рилса/);
  bot.close();
  // a second start does not migrate again
  const again = await createBot({ token: "t", workspace, callMethod: tg.callMethod, download: tg.download, onLog: () => {}, cleanupIntervalMs: 0 });
  assert.equal(again.user(111)!.onboarding, "done");
  again.close();
});
