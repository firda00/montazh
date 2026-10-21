// Stage 32: «🗓 Контент-план» — niche → idea cards on a schedule (✅ / ✏️ / ❌) → a make job → the ready card →
// 📢 the user's Telegram channel (after a confirmation) / 🕒 a scheduled post / 📥 the manual pack; /connect_channel with
// the admin checks; the persisted scheduler (tick), rate limits, restart recovery; tokens sealed at rest. Fake Bot API,
// fake make, a stub idea source — no network, no renders.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s32-ws-"));

const { createBot } = await import("../src/bot/index.ts");
const { STRINGS, menuAction } = await import("../src/bot/i18n.ts");
const { BotDb } = await import("../src/bot/db.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
const cp = await import("../src/bot/contentplan.ts");
const { sealToken, openToken, tokenKey, TokenKeyError } = await import("../src/bot/secrets.ts");
const { stubPublisher, PublishError, postUrl } = await import("../src/bot/publishers.ts");
type BotOptions = import("../src/bot/index.ts").BotOptions;
type MakeArgs = import("../src/bot/index.ts").MakeArgs;
type IdeasQuery = import("../src/bot/contentplan.ts").IdeasQuery;

const L = STRINGS.ru;
const C = L.cp;
const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s32-"));
const BOT_ID = 999;
const OWNER = 7;
const CHANNEL = -1001234567;

/** the fake Bot API plus the chat methods of /connect_channel: @mychan is a channel where the bot posts and 7 is the creator */
function telegram(o: { botStatus?: string; canPost?: boolean; chatType?: string } = {}) {
  const tg = fakeTelegram();
  const chatCalls: { method: string; params: Record<string, unknown> }[] = [];
  const callMethod: typeof tg.callMethod = async (token, method, params = {}, opts) => {
    if (method === "getMe") return { id: BOT_ID, is_bot: true, first_name: "vedit" } as never;
    if (method === "getChat") {
      chatCalls.push({ method, params });
      if (params.chat_id !== "@mychan" && params.chat_id !== CHANNEL) throw Object.assign(new Error("Bad Request: chat not found"), {});
      return { id: CHANNEL, type: o.chatType ?? "channel", title: "Мой канал", username: "mychan" } as never;
    }
    if (method === "getChatMember") {
      chatCalls.push({ method, params });
      if (params.user_id === BOT_ID) return { status: o.botStatus ?? "administrator", can_post_messages: o.canPost ?? true } as never;
      return { status: params.user_id === OWNER ? "creator" : "member" } as never;
    }
    return tg.callMethod(token, method, params, opts);
  };
  return { ...tg, callMethod, chatCalls };
}

async function boot(extra: Partial<BotOptions> = {}, tgo: Parameters<typeof telegram>[0] = {}) {
  const tg = telegram(tgo);
  const logs: string[] = [];
  const out = path.join(await tmp(), "make.mp4");
  await fs.writeFile(out, "fake-mp4");
  const makes: MakeArgs[] = [];
  const queries: IdeasQuery[] = [];
  const clock = { now: Date.now() };
  const ws = extra.workspace ?? (await tmp());
  const bot = await createBot({
    token: "t",
    workspace: ws,
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: (l) => logs.push(l),
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    broadcastDelayMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    make: async (a) => {
      makes.push(a);
      a.onJob(`20261020-c${makes.length}`);
      return { jobId: `20261020-c${makes.length}`, title: "Венчур в Узбекистане: 3 сделки недели", outputs: [{ id: "make", file: out, duration: 40, aspect: a.aspect }] };
    },
    ...extra,
    contentPlan: {
      tickMs: 0,
      minGapMs: 0,
      now: () => clock.now,
      ideas: async (q) => {
        queries.push(q);
        return {
          ideas: [
            { idea: "Почему инвесторы заходят в узбекский финтех", angle: "Объём сделок вырос вдвое", hook: "Деньги идут туда, где их не ждали", source: "spot.uz" },
            { idea: "Как стартапу получить первый чек", angle: "", hook: "Первый чек — самый трудный" },
            { idea: "Три ошибки основателей на питче" },
          ],
          usd: 0.002,
        };
      },
      ...extra.contentPlan,
    },
  });
  return { tg, bot, logs, makes, queries, clock, out, ws };
}

/** sets the niche through the menu and runs one scheduler pass */
async function withPlan(b: Awaited<ReturnType<typeof boot>>, uid = OWNER) {
  await b.bot.handleUpdate(b.tg.press(uid, "H:plan", 1));
  await b.bot.handleUpdate(b.tg.text(uid, "венчурный рынок Узбекистана"));
  await b.bot.idle();
}

/** the idea card of an item, its id from the ✅ button */
const itemIdOf = (tg: ReturnType<typeof telegram>, card: ReturnType<ReturnType<typeof telegram>["sent"]>) => Number(/CP:ok:(\d+)/.exec(tg.buttons(tg.keyboardOf(card)).join(" "))?.[1]);

// ── pure helpers ───────────────────────────────────────────────────────────────

test("helpers: trends → ideas (angles first, then facts, no duplicates), make topic with the CTA, captions with hashtags, times and slots", () => {
  const ideas = cp.ideasFromTrends({ facts: [{ text: "Сделок вдвое больше", source: "a.uz" }], angles: ["Финтех растёт", "финтех растёт", "Первый чек"], hooks: ["Хук 1", "Хук 2"] }, 3);
  assert.deepEqual(ideas.map((i) => i.idea), ["Финтех растёт", "Первый чек", "Сделок вдвое больше"]);
  assert.deepEqual([ideas[0].angle, ideas[0].hook, ideas[0].source], ["Сделок вдвое больше", "Хук 1", "a.uz"]);
  assert.equal(cp.ideasFromTrends({ facts: [], angles: ["a", "b", "c"], hooks: [] }, 2).length, 2);

  assert.equal(cp.makeTopic({ idea: "Финтех растёт.", angle: "x2", hook: "Деньги" }, { cta: "Подписывайтесь" }), "Финтех растёт. Факт: x2. Хук: Деньги. В конце призыв: Подписывайтесь");
  assert.equal(cp.makeTopic({ idea: "Тема", angle: null, hook: null }, {}, "короче"), "Тема. Учти правку: короче");

  assert.equal(cp.autoTags("венчурный рынок Узбекистана", []), "#венчурный #рынок #узбекистана");
  assert.equal(cp.autoTags("x", ["стартапы", "AI & ML", "a"]), "#стартапы #aiml");
  const cap = cp.buildCaption({ title: "Заголовок", idea: "Идея", hook: "Хук", profile: { cta: "Подписывайтесь", hashtags: "#a #b" }, niche: "n", topics: [] });
  assert.equal(cap, "Заголовок\n\nХук\n\nПодписывайтесь\n\n#a #b");
  const long = cp.buildCaption({ idea: "x".repeat(3000), profile: {}, niche: "венчурный рынок", topics: [] });
  assert.ok(long.length <= cp.CAPTION_MAX && long.endsWith("#венчурный #рынок"), "clipped to the Telegram caption limit, hashtags kept");

  assert.deepEqual(cp.parseTimes("19:00, 9.30 10:00"), ["09:30", "10:00", "19:00"]);
  assert.equal(cp.parseTimes("25:00"), undefined);
  assert.equal(cp.parseTimes("утром"), undefined);

  // Tashkent (+5): 2026-10-20 08:00 local = 03:00Z
  const now = Date.parse("2026-10-20T03:00:00Z");
  const slots = cp.nextSlots(now, ["10:00", "19:00"], 5, 4, 2);
  assert.deepEqual(slots.map((s) => new Date(s).toISOString()), ["2026-10-20T05:00:00.000Z", "2026-10-20T14:00:00.000Z", "2026-10-21T05:00:00.000Z", "2026-10-21T14:00:00.000Z"]);
  assert.deepEqual(slots.slice(0, 3).map((s) => cp.slotLabel(s, now, 5, C)), ["сегодня 10:00", "сегодня 19:00", "завтра 10:00"]);
  assert.equal(cp.slotLabel(Date.parse("2026-10-23T14:00:00Z"), now, 5, C), "23.10 19:00");
  assert.equal(cp.nextSlots(Date.parse("2026-10-20T04:58:00Z"), ["10:00"], 5, 1, 2)[0], Date.parse("2026-10-21T05:00:00Z"), "a slot under 5 minutes away is skipped");
  // 3 ideas a week: now, then 09:00 on day 2 and day 4
  assert.deepEqual(cp.proposeTimes(now, 3, 5).map((t) => new Date(t).toISOString()), [new Date(now).toISOString(), "2026-10-22T04:00:00.000Z", "2026-10-24T04:00:00.000Z"]);
});

test("secrets: tokens sealed with AES-256-GCM (VEDIT_TOKEN_KEY hex or base64), a wrong key or a tampered value fails, no key → nothing stored", () => {
  assert.equal(tokenKey({}), null);
  const hex = "ab".repeat(32);
  const key = tokenKey({ VEDIT_TOKEN_KEY: hex })!;
  assert.equal(key.length, 32);
  assert.deepEqual(tokenKey({ VEDIT_TOKEN_KEY: key.toString("base64") }), key);
  assert.throws(() => tokenKey({ VEDIT_TOKEN_KEY: "short" }), TokenKeyError);
  const sealed = sealToken("IGQVJ-secret-token", key);
  assert.match(sealed, /^v1:/);
  assert.ok(!sealed.includes("secret"));
  assert.notEqual(sealToken("IGQVJ-secret-token", key), sealed, "a fresh IV every time");
  assert.equal(openToken(sealed, key), "IGQVJ-secret-token");
  assert.throws(() => openToken(sealed, Buffer.alloc(32, 1)));
  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1] ^= 1;
  assert.throws(() => openToken(`v1:${raw.toString("base64")}`, key));
});

test("db (migration 6): plans, items with atomic claims, accounts (re-connect keeps auto_publish off), publish log and rate counters", async () => {
  const db = new BotDb(path.join(await tmp(), "vedit.db"));
  assert.deepEqual(db.migrations(), [1, 2, 3, 4, 5, 6]);
  db.upsertPlan(5, { niche: "фитнес", next_ideas_at: "2026-10-20T00:00:00.000Z" });
  assert.equal(db.getPlan(5)?.per_week, 3);
  assert.equal(db.plansDue("2026-10-21T00:00:00.000Z").length, 1);
  db.upsertPlan(5, { enabled: 0 });
  assert.equal(db.plansDue("2026-10-21T00:00:00.000Z").length, 0);
  const it = db.insertItem({ user: 5, idea: "Идея", propose_at: "2026-10-20T00:00:00.000Z" });
  assert.equal(it.status, "pending");
  assert.equal(db.itemsToPropose("2026-10-19T00:00:00.000Z").length, 0);
  assert.equal(db.itemsToPropose("2026-10-21T00:00:00.000Z").length, 1);
  assert.equal(db.claimItem(it.id, ["pending"], "proposed"), true);
  assert.equal(db.claimItem(it.id, ["pending"], "proposed"), false, "a double tap does nothing");
  db.updateItem(it.id, { job: "j1" });
  assert.equal(db.itemByJob("j1")?.id, it.id);
  const key = Buffer.alloc(32, 7);
  const acc = db.upsertAccount({ user: 5, platform: "instagram", label: "@me", external_id: "178", status: "pending", token_enc: sealToken("tok", key) });
  assert.equal(acc.auto_publish, 0);
  db.updateAccount(acc.id, { auto_publish: 1 });
  const again = db.upsertAccount({ user: 5, platform: "instagram", label: "@me2", external_id: "178" });
  assert.deepEqual([again.id, again.label, again.auto_publish, again.status], [acc.id, "@me2", 1, "active"]);
  assert.equal(openToken(db.getAccount(acc.id)!.token_enc!, key), "tok");
  db.logPublish({ item: it.id, account: acc.id, user: 5, platform: "instagram", trigger: "now", status: "ok", url: "u" });
  db.logPublish({ item: it.id, account: acc.id, user: 5, platform: "instagram", trigger: "now", status: "failed", error: "x" });
  assert.equal(db.publishedSince(acc.id, "2000-01-01T00:00:00.000Z"), 1);
  assert.equal(db.publishLogOf(it.id).length, 2);
  db.close();
});

test("publishers: Instagram / YouTube / TikTok / VK are stubs (not_configured), post links only for public channels", async () => {
  for (const p of ["instagram", "youtube", "tiktok", "vk"] as const) {
    await assert.rejects(() => stubPublisher(p).publish({} as never), (e: unknown) => e instanceof PublishError && e.code === "not_configured");
  }
  assert.equal(postUrl("@mychan", 15), "https://t.me/mychan/15");
  assert.equal(postUrl("Мой канал", 15), "");
});

// ── the bot ────────────────────────────────────────────────────────────────────

test("i18n + menu: «🗓 Контент-план» in all three languages, /plan, the button opens the niche question", async () => {
  for (const lang of ["ru", "uz", "en"] as const) {
    assert.equal(menuAction(STRINGS[lang].menu.plan), "plan");
    assert.ok(Object.keys(STRINGS[lang].cp).length === Object.keys(C).length);
  }
  const b = await boot();
  await b.bot.handleUpdate(b.tg.text(OWNER, "/start"));
  assert.ok(b.tg.buttons(b.tg.keyboardOf(b.tg.sent(OWNER, L.menuText))).includes("🗓 Контент-план=H:plan"));
  await b.bot.handleUpdate(b.tg.text(OWNER, "/plan"));
  assert.equal(b.tg.texts(OWNER).at(-1), C.askNiche);
  b.bot.close();
});

test("plan → ideas on schedule: the niche starts a batch, the first card comes at once (✅ / ✏️ / ❌), the rest later; ✏️ edits, ❌ skips; no flood", async () => {
  const b = await boot();
  const { tg, bot } = b;
  await withPlan(b);
  assert.ok(tg.texts(OWNER).includes(C.nicheSaved));
  const card = tg.sent(OWNER, "🗓 Контент-план · включён")!;
  assert.match(String(card.params.text), /Ниша: венчурный рынок Узбекистана/);
  assert.ok(tg.buttons(tg.keyboardOf(card)).includes("✓ 3/нед=CP:w:3"));
  // the idea source got the niche and the language; its cost is recorded
  assert.deepEqual(b.queries.map((q) => [q.niche, q.n, q.lang]), [["венчурный рынок Узбекистана", 3, "ru"]]);
  assert.ok(bot.db.getPlan(OWNER)!.next_ideas_at! > new Date(b.clock.now + 6 * 86_400_000).toISOString(), "next batch in a week");
  const first = tg.sent(OWNER, "💡 Идея для ролика")!;
  assert.equal(first.params.text, C.ideaCard("Почему инвесторы заходят в узбекский финтех", "Объём сделок вырос вдвое", "Деньги идут туда, где их не ждали", "spot.uz"));
  const id = itemIdOf(tg, first);
  assert.deepEqual(tg.buttons(tg.keyboardOf(first)), [`✅ Сделать=CP:ok:${id}`, `✏️ Изменить=CP:ed:${id}`, `❌ Пропустить=CP:sk:${id}`]);
  assert.deepEqual(bot.db.itemsOf(OWNER).map((i) => i.status), ["proposed", "pending", "pending"], "the other two wait for their day");
  // two days later the second card comes on the next tick
  b.clock.now += 2 * 86_400_000 + 10 * 3_600_000;
  await bot.contentPlanTick();
  assert.equal(tg.texts(OWNER).filter((t) => t.startsWith("💡 Идея для ролика")).length, 2);
  // ✏️ → text → the updated idea as a new card
  const second = bot.db.itemsOf(OWNER)[1];
  await bot.handleUpdate(tg.press(OWNER, `CP:ed:${second.id}`, 1));
  assert.equal(tg.texts(OWNER).at(-1), C.askEditIdea);
  await bot.handleUpdate(tg.text(OWNER, "Как получить первый чек от бизнес-ангела в Ташкенте"));
  assert.equal(bot.db.getItem(second.id)!.idea, "Как получить первый чек от бизнес-ангела в Ташкенте");
  assert.equal(tg.texts(OWNER).at(-1), C.ideaCard("Как получить первый чек от бизнес-ангела в Ташкенте", "", "", ""));
  // ❌ → skipped; a second tap does nothing
  await bot.handleUpdate(tg.press(OWNER, `CP:sk:${second.id}`, 5));
  assert.equal(bot.db.getItem(second.id)!.status, "skipped");
  await bot.handleUpdate(tg.press(OWNER, `CP:sk:${second.id}`, 5));
  assert.equal(tg.lastToast(), C.ideaGone);
  // 💡 now: more batches while fewer than 2 × per week ideas are unanswered (2 → 5 → 8 open), then no more research
  await bot.handleUpdate(tg.press(OWNER, "CP:now", 1));
  await bot.idle();
  assert.equal(tg.texts(OWNER).filter((t) => t === C.ideasStarted).length, 1);
  await bot.handleUpdate(tg.press(OWNER, "CP:now", 1));
  await bot.idle();
  assert.equal(b.queries.length, 3);
  await bot.handleUpdate(tg.press(OWNER, "CP:now", 1));
  await bot.idle();
  assert.equal(b.queries.length, 3, "8 open ideas: no new research");
  assert.equal(tg.texts(OWNER).at(-1), C.ideasBusy);
  // ⏸ pause: due plans are not researched
  await bot.handleUpdate(tg.press(OWNER, "CP:off", 1));
  assert.equal(bot.db.getPlan(OWNER)!.enabled, 0);
  b.clock.now += 8 * 86_400_000;
  await bot.contentPlanTick();
  await bot.idle();
  assert.equal(b.queries.length, 3);
  bot.close();
});

test("✅ → a make job with the brand profile → the ready card; nothing is posted without a tap; /connect_channel checks; 📢 → confirm → the channel", async () => {
  const b = await boot();
  const { tg, bot } = b;
  await withPlan(b);
  // the brand profile: CTA, hashtags
  await bot.handleUpdate(tg.press(OWNER, "CP:cta", 1));
  await bot.handleUpdate(tg.text(OWNER, "Подписывайтесь — разбираю венчур каждую неделю"));
  await bot.handleUpdate(tg.press(OWNER, "CP:tags", 1));
  await bot.handleUpdate(tg.text(OWNER, "венчур #стартапы"));
  assert.match(tg.texts(OWNER).at(-1)!, /Хэштеги: #венчур #стартапы/);
  const id = itemIdOf(tg, tg.sent(OWNER, "💡 Идея для ролика"));
  await bot.handleUpdate(tg.press(OWNER, `CP:ok:${id}`, 50));
  await bot.idle();
  assert.equal(b.makes.length, 1);
  assert.equal(b.makes[0].topic, "Почему инвесторы заходят в узбекский финтех. Факт: Объём сделок вырос вдвое. Хук: Деньги идут туда, где их не ждали. В конце призыв: Подписывайтесь — разбираю венчур каждую неделю");
  assert.equal(b.makes[0].aspect, "9:16");
  assert.ok(tg.edits(OWNER).some((t) => t.endsWith(C.ideaAccepted)));
  const item = bot.db.getItem(id)!;
  assert.equal(item.status, "ready");
  assert.equal(item.caption, "Венчур в Узбекистане: 3 сделки недели\n\nДеньги идут туда, где их не ждали\n\nПодписывайтесь — разбираю венчур каждую неделю\n\n#венчур #стартапы");
  const ready = tg.sent(OWNER, "готово.")!;
  assert.deepEqual(tg.buttons(tg.keyboardOf(ready)), [`🕒 Запланировать=CP:sch:${id}`, `📥 Для Instagram / TikTok / YouTube=CP:dl:${id}`, `✏️ Подпись=CP:cap:${id}`, `✏️ Поправить видео=CP:fix:${id}`, "🔗 Подключить канал=CP:conn"]);
  // the scheduler never posts a ready video by itself
  await bot.contentPlanTick();
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 0);
  // /connect_channel: bad usage → the how-to; a stranger to the channel is refused
  await bot.handleUpdate(tg.text(OWNER, "/connect_channel"));
  assert.match(tg.texts(OWNER).at(-1)!, /Формат: \/connect_channel/);
  await bot.handleUpdate(tg.text(8, "/connect_channel @mychan"));
  assert.equal(tg.texts(8).at(-1), C.connectUserNotAdmin);
  await bot.handleUpdate(tg.text(OWNER, "/connect_channel https://t.me/mychan"));
  assert.equal(tg.texts(OWNER).find((t) => t === C.connected("@mychan")), C.connected("@mychan"));
  const acc = bot.db.accountsOf(OWNER, "telegram")[0];
  assert.deepEqual([acc.external_id, acc.label, acc.auto_publish], [String(CHANNEL), "@mychan", 0]);
  // the waiting video gets the publish button
  const again = tg.sent(OWNER, "готово.")!;
  const msg = tg.messageIdOf(again)!;
  assert.equal(tg.buttons(tg.keyboardOf(again))[0], `📢 Опубликовать в @mychan=CP:pub:${id}:${acc.id}`);
  // 📢 asks first; ↩️ goes back; ✅ posts
  await bot.handleUpdate(tg.press(OWNER, `CP:pub:${id}:${acc.id}`, msg));
  assert.equal(tg.edits(OWNER).at(-1), C.confirmPublish("@mychan"));
  assert.deepEqual(tg.buttons(tg.markupOf(msg)), [`✅ Да, опубликовать в @mychan=CP:pubok:${id}:${acc.id}`, `↩️ Назад=CP:rd:${id}`]);
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 0);
  await bot.handleUpdate(tg.press(OWNER, `CP:pubok:${id}:${acc.id}`, msg));
  const posts = tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].params.caption, item.caption);
  assert.match(tg.texts(OWNER).at(-1)!, /^✅ Опубликовано в @mychan: https:\/\/t\.me\/mychan\/\d+$/);
  assert.equal(bot.db.getItem(id)!.status, "published");
  assert.deepEqual(bot.db.publishLogOf(id).map((r) => [r.status, r.trigger, r.platform]), [["ok", "now", "telegram"]]);
  // a second confirm (double tap) does not post twice
  await bot.handleUpdate(tg.press(OWNER, `CP:pubok:${id}:${acc.id}`, msg));
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 1);
  assert.equal(tg.lastToast(), C.ideaGone);
  bot.close();
});

test("/connect_channel refusals: not a channel, the bot not an admin, the bot without «post messages»", async () => {
  for (const [o, want] of [
    [{ chatType: "supergroup" }, C.connectNotChannel],
    [{ botStatus: "member" }, C.connectBotNotAdmin],
    [{ canPost: false }, C.connectBotCantPost],
  ] as const) {
    const b = await boot({}, o);
    await b.bot.handleUpdate(b.tg.text(OWNER, "/connect_channel @mychan"));
    assert.equal(b.tg.texts(OWNER).at(-1), want);
    assert.equal(b.bot.db.accountsOf(OWNER).length, 0);
    b.bot.close();
  }
  const b = await boot();
  await b.bot.handleUpdate(b.tg.text(OWNER, "/connect_channel @nochan"));
  assert.equal(b.tg.texts(OWNER).at(-1), C.connectNotFound);
  b.bot.close();
});

test("🕒 schedule: the slots of the brand times → scheduled → the scheduler posts when due; ❌ cancels; no channel → a reminder with the manual pack", async () => {
  const b = await boot();
  const { tg, bot } = b;
  await withPlan(b);
  await bot.handleUpdate(tg.text(OWNER, "/connect_channel @mychan"));
  const id = itemIdOf(tg, tg.sent(OWNER, "💡 Идея для ролика"));
  await bot.handleUpdate(tg.press(OWNER, `CP:ok:${id}`, 50));
  await bot.idle();
  const msg = tg.messageIdOf(tg.sent(OWNER, "готово.")!)!;
  await bot.handleUpdate(tg.press(OWNER, `CP:sch:${id}`, msg));
  assert.equal(tg.edits(OWNER).at(-1), C.scheduleAsk);
  const slots = tg.buttons(tg.markupOf(msg)).filter((x) => x.includes("CP:at:"));
  assert.ok(slots.length >= 2 && slots.length <= 6);
  const minutes = Number(/CP:at:\d+:(\d+)/.exec(slots[0])![1]);
  // a slot from the past (an old card) is refused
  await bot.handleUpdate(tg.press(OWNER, `CP:at:${id}:${Math.round(b.clock.now / 60_000) - 10}`, msg));
  assert.equal(bot.db.getItem(id)!.status, "ready");
  await bot.handleUpdate(tg.press(OWNER, `CP:at:${id}:${minutes}`, msg));
  assert.equal(bot.db.getItem(id)!.status, "scheduled");
  assert.match(tg.edits(OWNER).at(-1)!, /^🕒 Запланировано на .+ → @mychan\.$/);
  // ❌ → back to ready; schedule again
  await bot.handleUpdate(tg.press(OWNER, `CP:uns:${id}`, msg));
  assert.equal(bot.db.getItem(id)!.status, "ready");
  await bot.handleUpdate(tg.press(OWNER, `CP:at:${id}:${minutes}`, msg));
  // not yet due → nothing; due → posted once
  await bot.contentPlanTick();
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 0);
  b.clock.now = minutes * 60_000 + 1000;
  await bot.contentPlanTick();
  await bot.contentPlanTick();
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 1);
  assert.equal(bot.db.getItem(id)!.status, "published");
  assert.deepEqual(bot.db.publishLogOf(id).map((r) => r.trigger), ["schedule"]);
  bot.close();

  // no channel connected: the slot becomes a reminder with the tips, the caption and the file
  const c = await boot();
  await withPlan(c);
  const id2 = itemIdOf(c.tg, c.tg.sent(OWNER, "💡 Идея для ролика"));
  await c.bot.handleUpdate(c.tg.press(OWNER, `CP:ok:${id2}`, 50));
  await c.bot.idle();
  const msg2 = c.tg.messageIdOf(c.tg.sent(OWNER, "готово.")!)!;
  await c.bot.handleUpdate(c.tg.press(OWNER, `CP:sch:${id2}`, msg2));
  const m2 = Number(/CP:at:\d+:(\d+)/.exec(c.tg.buttons(c.tg.markupOf(msg2)).find((x) => x.includes("CP:at:"))!)![1]);
  await c.bot.handleUpdate(c.tg.press(OWNER, `CP:at:${id2}:${m2}`, msg2));
  assert.match(c.tg.edits(OWNER).at(-1)!, /пришлю напоминание/);
  c.clock.now = m2 * 60_000 + 1000;
  await c.bot.contentPlanTick();
  const texts = c.tg.texts(OWNER);
  assert.ok(texts.includes(C.reminderDue("Почему инвесторы заходят в узбекский финтех")));
  assert.ok(texts.includes(C.manualTips));
  assert.ok(texts.includes(c.bot.db.getItem(id2)!.caption!));
  const doc = c.tg.calls.filter((x) => x.method === "sendDocument").at(-1)!;
  assert.equal((doc.params.document as File).name, "Венчур-в-Узбекистане-3-сделки-недели.mp4");
  assert.equal(c.bot.db.getItem(id2)!.status, "ready", "still waiting: the user posts by hand");
  c.bot.close();
});

test("📥 manual pack, ✏️ caption, ✏️ fix (a new version of the same idea), rate limit per channel, a failed video offers 🔁", async () => {
  const b = await boot({ contentPlan: { dailyPosts: 1 } });
  const { tg, bot } = b;
  await withPlan(b);
  await bot.handleUpdate(tg.text(OWNER, "/connect_channel @mychan"));
  const acc = bot.db.accountsOf(OWNER, "telegram")[0];
  const id = itemIdOf(tg, tg.sent(OWNER, "💡 Идея для ролика"));
  await bot.handleUpdate(tg.press(OWNER, `CP:ok:${id}`, 50));
  await bot.idle();
  // 📥
  await bot.handleUpdate(tg.press(OWNER, `CP:dl:${id}`, 1));
  assert.ok(tg.texts(OWNER).includes(C.manualTips));
  assert.ok(tg.calls.some((c) => c.method === "sendDocument"));
  // ✏️ caption
  await bot.handleUpdate(tg.press(OWNER, `CP:cap:${id}`, 1));
  await bot.handleUpdate(tg.text(OWNER, "Своя подпись #venture"));
  assert.equal(bot.db.getItem(id)!.caption, "Своя подпись #venture");
  assert.ok(tg.texts(OWNER).includes(C.readyCard("Почему инвесторы заходят в узбекский финтех", "Своя подпись #venture")));
  // ✏️ fix → a second make with the note
  await bot.handleUpdate(tg.press(OWNER, `CP:fix:${id}`, 1));
  await bot.handleUpdate(tg.text(OWNER, "короче, без цифр"));
  await bot.idle();
  assert.equal(b.makes.length, 2);
  assert.match(b.makes[1].topic, /Учти правку: короче, без цифр$/);
  assert.equal(bot.db.getItem(id)!.status, "ready");
  // the first post goes out, the second hits the daily limit (1)
  await bot.handleUpdate(tg.press(OWNER, `CP:pubok:${id}:${acc.id}`, 1));
  assert.equal(bot.db.getItem(id)!.status, "published");
  const other = bot.db.insertItem({ user: OWNER, idea: "Ещё одна", status: "ready", output_file: b.out, caption: "c" });
  await bot.handleUpdate(tg.press(OWNER, `CP:pubok:${other.id}:${acc.id}`, 1));
  assert.match(tg.texts(OWNER).at(-1)!, /^⏳ Лимит публикаций в @mychan: следующая публикация возможна /);
  assert.equal(bot.db.getItem(other.id)!.status, "ready");
  assert.equal(tg.calls.filter((c) => c.method === "sendVideo" && c.params.chat_id === CHANNEL).length, 1);
  bot.close();

  // a make that fails: the item is failed, the user gets 🔁 (the idea card's ✅ again)
  const f = await boot({ make: async () => { throw new Error("render crashed"); } });
  await withPlan(f);
  const id3 = itemIdOf(f.tg, f.tg.sent(OWNER, "💡 Идея для ролика"));
  await f.bot.handleUpdate(f.tg.press(OWNER, `CP:ok:${id3}`, 50));
  await f.bot.idle();
  assert.equal(f.bot.db.getItem(id3)!.status, "failed");
  const failed = f.tg.sent(OWNER, C.videoFailed("Почему инвесторы заходят в узбекский финтех"))!;
  assert.deepEqual(f.tg.buttons(f.tg.keyboardOf(failed)), [`🔁 Ещё раз=CP:ok:${id3}`]);
  f.bot.close();
});

test("restart: a publish cut in the middle is reported and never repeated; someone else's item buttons do nothing", async () => {
  const ws = await tmp();
  const b = await boot({ workspace: ws });
  await withPlan(b);
  const id = itemIdOf(b.tg, b.tg.sent(OWNER, "💡 Идея для ролика"));
  // another user presses the owner's buttons
  await b.bot.handleUpdate(b.tg.press(8, `CP:ok:${id}`, 1));
  assert.equal(b.tg.lastToast(), C.ideaGone);
  assert.equal(b.makes.length, 0);
  b.bot.db.updateItem(id, { status: "publishing" });
  b.bot.close();
  const again = await boot({ workspace: ws });
  await again.bot.idle();
  assert.ok(again.tg.texts(OWNER).includes(C.interrupted("Почему инвесторы заходят в узбекский финтех")));
  assert.equal(again.bot.db.getItem(id)!.status, "failed");
  await again.bot.contentPlanTick();
  assert.equal(again.tg.calls.filter((c) => c.method === "sendVideo").length, 0);
  again.bot.close();
});
