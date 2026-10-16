// End-to-end smoke of the multi-user bot WITHOUT Telegram: a second bot instance against a recording fake
// Bot API (no polling — the live bot keeps the token), in a throwaway workspace. Prints every message,
// edit, keyboard and toast as a text "screenshot".
//   npx tsx tools/bot-smoke.ts
// Scenarios: onboarding in Uzbek → make-from-topic by buttons (the real `make` with a stub writer, no trends,
// no pictures, no music, a 2-second fake render) → cancel a job while it waits in the queue → admin grants credits.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-smoke-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { make, creditsText } = await import("../src/make/index.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
type CallMethod = import("../src/bot/telegram-api.ts").CallMethod;
type TgUpdate = import("../src/bot/telegram-api.ts").TgUpdate;
type StructuredFn = import("../src/lib/llm.ts").StructuredFn;
type MakeFn = import("../src/bot/index.ts").MakeFn;

const NAMES: Record<number, string> = { 1: "админ", 501: "Aziz (uz)", 502: "Ольга (ru)" };
const who = (id: unknown) => NAMES[Number(id)] ?? String(id);
const out: string[] = [];
const print = (s = "") => {
  out.push(s);
  console.log(s);
};
const indent = (s: string, pad = "   ") => s.split("\n").map((l) => pad + l).join("\n");
const kbText = (m: unknown): string => {
  const mk = m as { inline_keyboard?: { text: string }[][]; keyboard?: { text: string }[][] } | undefined;
  const rows = mk?.inline_keyboard ?? mk?.keyboard;
  if (!rows?.length) return "";
  return rows.map((r) => "   " + r.map((b) => `[ ${b.text} ]`).join(" ")).join("\n") + (mk?.keyboard ? "   (меню под полем ввода)" : "");
};

// ── fake Telegram ──
let nextMsg = 1000;
const lastIds = new Map<string, number>();
const callMethod: CallMethod = async <T,>(_token: string, method: string, p: Record<string, unknown> = {}) => {
  switch (method) {
    case "sendMessage": {
      const id = nextMsg++;
      print(`→ ${who(p.chat_id)} #${id}:\n${indent(String(p.text))}`);
      const k = kbText(p.reply_markup);
      if (k) print(k);
      lastIds.set(String(p.chat_id), id);
      return { message_id: id, chat: { id: p.chat_id, type: "private" } } as T;
    }
    case "editMessageText":
      print(`✎ ${who(p.chat_id)} #${p.message_id}:\n${indent(String(p.text))}`);
      if (kbText(p.reply_markup)) print(kbText(p.reply_markup));
      return true as T;
    case "editMessageReplyMarkup":
      print(`✎ ${who(p.chat_id)} #${p.message_id} кнопки:${kbText(p.reply_markup) ? `\n${kbText(p.reply_markup)}` : " (убраны)"}`);
      return true as T;
    case "answerCallbackQuery":
      if (p.text) print(`   💬 ${p.text}`);
      return true as T;
    case "sendDocument": {
      const f = p.document as File;
      print(`📎 ${who(p.chat_id)}: ${f.name} (${f.size} байт)${p.caption ? `\n${indent(String(p.caption))}` : ""}`);
      return { message_id: nextMsg++, chat: { id: p.chat_id, type: "private" } } as T;
    }
    case "sendVideo":
    case "sendVoice":
      print(`🎞 ${who(p.chat_id)}: ${method}`);
      return { message_id: nextMsg++, chat: { id: p.chat_id, type: "private" } } as T;
    default:
      return true as T;
  }
};

// ── the real make with a stub writer and a 2-second fake render; "медленно" topics wait (to show the queue) ──
const SCRIPT = {
  title: "Nega qahva qimmatlashmoqda",
  language: "uz",
  beats: [
    { text: "Arabika bir yilda 40 foizga qimmatladi.", emphasis: "40 foizga", icon: "coffee", seconds: 3 },
    { text: "Braziliyadagi qurg‘oqchilik hosilni kesdi.", emphasis: "qurg‘oqchilik", icon: "cloud-sun", seconds: 3 },
    { text: "Yetkazib berish va dollar narxni yana oshirdi.", emphasis: "dollar", icon: "truck", seconds: 3 },
    { text: "Kapsula emas, don sotib olish arzonroq.", emphasis: "don", icon: "shopping-cart", seconds: 3 },
  ],
  hashtags: ["qahva", "narxlar"],
};
const llm: StructuredFn = async () => ({ data: SCRIPT, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0, estimate: false, model: "stub", provider: "stub" });
let releaseSlow!: () => void;
const slow = new Promise<void>((r) => (releaseSlow = r));
const makeFn: MakeFn = async ({ topic, aspect, signal, onJob, progress, log }) => {
  if (/медленно/.test(topic)) {
    await progress("▸ тренды (поиск в вебе через Antigravity)…");
    await Promise.race([slow, new Promise((r) => signal.addEventListener("abort", r))]);
  }
  const r = await make(topic, {
    llm,
    trends: false,
    director: false,
    images: "none",
    music: "none",
    sfx: false,
    aspect,
    signal,
    fakeRender: (_dir, file) => ffmpeg(["-f", "lavfi", "-i", "color=c=0x223344:size=270x480:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", file]).then(() => undefined),
    onEvent: (l) => {
      if (/^job /.test(l)) onJob(l.slice(4).trim());
      else if (/^▸/.test(l)) void progress(l);
      else log(`  ${l.trim()}`);
    },
  });
  const credits = creditsText(r);
  return { jobId: r.jobId, title: topic, outputs: [{ id: "make", file: r.output, duration: r.duration, aspect: r.aspect }], reasoning: `${r.title}${credits ? `\n${credits}` : ""}`, notes: r.warnings.slice(0, 2) };
};

const logs: string[] = [];
// the montage pipeline is a stub here (the real one needs whisper + the planner): it reports progress like the real one
const pipeline: import("../src/bot/index.ts").PipelineFn = async ({ instruction, preset, progress, onJob }) => {
  onJob("20261016-demo00");
  for (const l of ["▸ подготовка видео…", "▸ анализ речи… (48 с видео)", "▸ план…", "▸ нарезка…", "▸ рендер reel_1 (1/1)…", "▸ рендер reel_1 (1/1) 50%…"]) await progress(l);
  print(`   (пайплайн получил: «${instruction}», пресет ${preset})`);
  return { jobId: "20261016-demo00", outputs: [] };
};
const download = async (_t: string, _f: unknown, dest: string) => {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, "video");
};
const bot = await createBot({ token: "SMOKE", workspace: process.env.VEDIT_WORKSPACE, callMethod, download, onLog: (l) => logs.push(l), adminIds: [1], maxJobs: 1, statusEditMs: 0, cleanupIntervalMs: 0, make: makeFn, pipeline });

let upd = 1;
const say = async (from: number, text: string, user: { username?: string; first_name?: string } = {}) => {
  print(`\n← ${who(from)}: ${text}`);
  await bot.handleUpdate({ update_id: upd++, message: { message_id: upd, chat: { id: from, type: "private" }, from: { id: from, ...user }, text } } as TgUpdate);
};
const press = async (from: number, data: string, label: string, msgId = lastIds.get(String(from)) ?? 0) => {
  print(`\n← ${who(from)} нажимает [ ${label} ] (${data})`);
  await bot.handleUpdate({ update_id: upd++, callback_query: { id: `q${upd}`, from: { id: from }, message: { message_id: msgId, chat: { id: from, type: "private" } }, data } } as TgUpdate);
};
const uz = STRINGS.uz;

print("════ 1. Регистрация на узбекском ════");
await say(501, "Salom", { username: "aziz_uz", first_name: "Aziz" });
const onboardingMsg = lastIds.get("501")!;
await press(501, "L:uz", "🇺🇿 O‘zbekcha", onboardingMsg);
await press(501, "P:blog", uz.purpose.blog, onboardingMsg);
await press(501, "T:ok", uz.btnAccept, onboardingMsg);

print("\n════ 2. Ролик по теме кнопками (настоящий make: заглушка сценариста, без трендов и картинок, рендер-заглушка 2 с) ════");
await say(501, uz.menu.make);
await say(501, "nega qahva qimmatlashmoqda");
const card = lastIds.get("501")!;
await press(501, "K:v:off", uz.voiceNone, card);
await press(501, "K:go", uz.btnStart, card);
await bot.idle();
const done = bot.db.lastJob(501)!;
await press(501, `r:${done.id}:5`, "5⭐", done.result_msg_id ?? 0);

print("\n════ 3. Отмена задачи, пока она ждёт в очереди (одна задача одновременно) ════");
await say(502, "/start");
await press(502, "L:ru", "🇷🇺 Русский", lastIds.get("502"));
await press(502, "P:biz", STRINGS.ru.purpose.biz, lastIds.get("502"));
await press(502, "T:ok", STRINGS.ru.btnAccept, lastIds.get("502"));
await say(502, "/make медленно: тренды кофе 2026");
await say(501, "/make choy narxi");
const waiting = bot.db.lastJob(501)!;
await press(501, `X:${waiting.id}`, uz.btnCancel, waiting.status_msg_id ?? 0);
releaseSlow();
await bot.idle();

print("\n════ 4. Админ начисляет кредиты ════");
await say(1, "/start");
await say(1, "/admin");
await press(1, "a:f", STRINGS.ru.btnFind);
await say(1, "@aziz_uz");
await press(1, "a:c:501:5", "+5 кр.");
await say(501, uz.menu.balance);
await press(1, "a:st", STRINGS.ru.btnStats);
await bot.idle();

print("\n════ 5. Монтаж кнопками и настройки (пайплайн монтажа — заглушка) ════");
await say(502, STRINGS.ru.menu.montage);
print(`\n← ${who(502)} присылает видео (48 с)`);
await bot.handleUpdate({ update_id: upd++, message: { message_id: upd, chat: { id: 502, type: "private" }, from: { id: 502 }, video: { file_id: "VID-1", file_size: 5_000_000, duration: 48 } } } as TgUpdate);
const mcard = lastIds.get("502")!;
await press(502, "M:m:reels", STRINGS.ru.mode.reels, mcard);
await press(502, "M:n:1", "1 шт", mcard);
await press(502, "M:a:16:9", "16:9", mcard);
await press(502, "M:go", STRINGS.ru.btnStart, mcard);
await bot.idle();
await say(502, STRINGS.ru.menu.settings);
const scard = lastIds.get("502")!;
await press(502, "S:s:both", STRINGS.ru.sendNames.both, scard);
await press(502, "S:l:uz", "UZ", scard);
await say(502, "/help");

print("\n════ итог ════");
for (const id of [501, 502]) {
  const u = bot.user(id)!;
  print(`${who(id)}: язык ${u.lang}, цель ${u.purpose}, кредиты ${u.credits}, условия приняты ${u.accepted_terms_at ? "да" : "нет"}`);
}
for (const j of [...bot.db.jobsByStatus("done", "failed", "cancelled")]) print(`задача ${j.id}: ${j.kind} ${j.status} (${j.class}, кредитов ${j.paid_credits}, оценка ${j.rating ?? "—"})`);
bot.close();
await fs.writeFile(path.join(process.env.VEDIT_WORKSPACE!, "smoke.txt"), out.join("\n"));
console.error(`\nтранскрипт: ${path.join(process.env.VEDIT_WORKSPACE!, "smoke.txt")}; лог бота: ${logs.length} строк`);
