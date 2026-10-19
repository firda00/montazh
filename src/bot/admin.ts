// /admin: statistics, user lookup (credits, ban, admin role), broadcast (≤ 20 msg/s, opt-out respected),
// live free-plan limits, ratings with the AI self-review (stage 28), VIP testers and the DB allowlist (strangers of the
// closed beta are announced to the admins once, with «✅ Пустить (VIP)»). Admins = TELEGRAM_ADMIN_IDS (or the first TELEGRAM_ALLOWED_USERS id) + users given
// the admin role here. Every admin callback re-checks the role.
import type { BotApi, InlineKeyboard } from "./telegram-api.ts";
import type { BotDb } from "./db.ts";
import { t, type Strings } from "./i18n.ts";
import { adminKb, broadcastKb, feedbackAdminKb, feedbackJobKb, feedbackJobsKb, limitsKb, limitStep, strangerKb, userCardKb } from "./keyboards.ts";
import { formatDisagree, formatFeedbackSummary, formatJobFeedback, formatLowList, summarizeFeedback } from "./feedback.ts";
import { exists } from "../lib/workspace.ts";
import { FREE_PLAN_FIELDS, type PlanLimits } from "./plans.ts";

export interface AdminCtx {
  db: BotDb;
  api: BotApi;
  /** env admins: always admins, cannot be banned or demoted from the bot */
  envAdmins: Set<number>;
  isAdmin(uid: number): boolean;
  T(uid: number): Strings;
  say(chatId: number, text: string, markup?: InlineKeyboard): Promise<number | undefined>;
  edit(chatId: number, msgId: number, text: string, markup?: InlineKeyboard): Promise<void>;
  getAwaiting(uid: number): string | undefined;
  setAwaiting(uid: number, v: string | undefined): void;
  getBroadcast(uid: number): string | undefined;
  setBroadcast(uid: number, text: string | undefined): void;
  /** the effective free plan (env + live overrides) */
  plan(): PlanLimits;
  queueCounts(): { running: number; waiting: number; max: number };
  dayStart(): string;
  /** background work the bot waits for in idle() */
  track(p: Promise<void>): void;
  broadcastDelayMs: number;
  log(line: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** to someone let in before they chose a language */
export const INVITE = "✅ Доступ открыт · Ruxsat berildi · Access granted — /start";

export function adminHandlers(ctx: AdminCtx) {
  const { db } = ctx;

  function card(uid: number, viewer: number) {
    const u = db.getUser(uid)!;
    const tot = db.userTotals(uid);
    const since = ctx.dayStart();
    const L = ctx.T(viewer);
    const text = L.userCard({
      id: u.tg_id,
      username: u.username,
      name: u.first_name,
      lang: u.lang,
      purpose: u.purpose,
      status: u.status,
      role: ctx.isAdmin(uid) ? "admin" : u.role,
      credits: u.credits,
      plan: u.plan,
      created: u.created_at,
      lastSeen: u.last_seen,
      jobs: tot.jobs,
      done: tot.done,
      failed: tot.failed,
      cost: tot.cost,
      todayStd: db.countFreeJobs(uid, "standard", since),
      todayLong: db.countFreeJobs(uid, "long", since),
    });
    return { text, kb: userCardKb(L, { tg_id: u.tg_id, status: u.status, role: ctx.isAdmin(uid) ? "admin" : u.role, plan: u.plan }) };
  }

  function limitsText(viewer: number) {
    const p = ctx.plan();
    return ctx.T(viewer).limitsCard(FREE_PLAN_FIELDS.map((f) => ({ what: f.what, value: p[f.key] })));
  }

  async function broadcast(admin: number, chatId: number, text: string) {
    const ids = db.broadcastAudience();
    await ctx.say(chatId, ctx.T(admin).broadcastStarted(ids.length));
    let ok = 0;
    let fail = 0;
    for (const id of ids) {
      const L = t(db.getUser(id)?.lang);
      try {
        await ctx.api.sendMessage(id, `${text}\n\n${L.broadcastFooter}`);
        ok++;
      } catch (err) {
        fail++;
        const desc = err instanceof Error ? err.message : String(err);
        // the user blocked the bot: stop writing to them
        if (/blocked|deactivated|chat not found|403/i.test(desc)) db.updateUser(id, { news: 0 });
        ctx.log(`рассылка → ${id}: ${desc}`);
      }
      await sleep(ctx.broadcastDelayMs);
    }
    ctx.log(`рассылка: доставлено ${ok}, ошибок ${fail}`);
    await ctx.say(chatId, ctx.T(admin).broadcastDone(ok, fail));
  }

  const allAdmins = () => [...new Set([...ctx.envAdmins, ...db.adminIds()])];

  /** VIP on/off: no daily limits, no credit charges; on also lets the user in (closed beta) */
  function setVip(target: number, on: boolean, by: number) {
    if (!db.getUser(target)) db.touchUser(target, {}, { plan: on ? "vip" : "free" });
    else db.updateUser(target, { plan: on ? "vip" : "free" });
    if (on) db.allow(target, by);
    ctx.log(`админ ${by}: VIP ${on ? "вкл." : "выкл."} для ${target}`);
  }

  async function tellVip(target: number) {
    const u = db.getUser(target);
    // a user who never finished registration gets the trilingual invitation instead
    await ctx.say(target, u?.onboarding === "done" ? t(u.lang).vipUserOn : INVITE).catch(() => undefined);
  }

  /** "123" | "@name" → a tg id (a bare number does not need to be a known user) */
  const targetOf = (q: string): number | undefined => {
    const s = q.trim();
    if (/^\d+$/.test(s)) return Number(s);
    return db.findUser(s)?.tg_id;
  };

  return {
    /** a message or a button from someone outside the closed beta: the admins hear about it once */
    async stranger(from: { id: number; username?: string; first_name?: string; last_name?: string }) {
      const key = `stranger.${from.id}`;
      if (db.getKv(key) !== undefined || db.isAllowed(from.id)) return;
      db.setKv(key, JSON.stringify({ username: from.username ?? null, first_name: from.first_name ?? null, at: new Date().toISOString(), state: "new" }));
      const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || "—";
      for (const a of allAdmins()) await ctx.say(a, ctx.T(a).strangerNotice(from.id, name, from.username ?? ""), strangerKb(ctx.T(a), from.id));
    },

    /** /vip <id|@username> on|off */
    async vipCommand(uid: number, chatId: number, arg: string) {
      const L = ctx.T(uid);
      const m = /^(\S+)\s+(on|off|вкл|выкл)$/i.exec(arg.trim());
      const target = m ? targetOf(m[1]) : undefined;
      if (!m || target === undefined) return void (await ctx.say(chatId, m ? L.userNotFound(m[1]) : L.vipUsage));
      const on = /^(on|вкл)$/i.test(m[2]);
      setVip(target, on, uid);
      await ctx.say(chatId, L.vipSet(target, on));
      if (on && target !== uid) await tellVip(target);
    },

    /** /allow <id> [off] */
    async allowCommand(uid: number, chatId: number, arg: string) {
      const L = ctx.T(uid);
      const m = /^(\S+)(?:\s+(off|выкл))?$/i.exec(arg.trim());
      const target = m ? targetOf(m[1]) : undefined;
      if (!m || target === undefined) return void (await ctx.say(chatId, m ? L.userNotFound(m[1]) : L.allowUsage));
      if (m[2]) db.disallow(target);
      else db.allow(target, uid);
      ctx.log(`админ ${uid}: допуск ${m[2] ? "снят" : "дан"} ${target}`);
      await ctx.say(chatId, L.allowSet(target, !m[2]));
    },

    async menu(uid: number, chatId: number) {
      await ctx.say(chatId, ctx.T(uid).adminMenu, adminKb(ctx.T(uid)));
    },

    /** returns a toast text for answerCallbackQuery */
    async callback(uid: number, chatId: number, msgId: number | undefined, data: string): Promise<string | undefined> {
      const L = ctx.T(uid);
      const [, op, a, b] = data.split(":");
      switch (op) {
        case "st": {
          const s = db.stats(ctx.dayStart(), new Date(Date.now() - 7 * 86_400_000).toISOString());
          const q = ctx.queueCounts();
          await ctx.say(chatId, L.stats({ ...s, running: q.running, queued: q.waiting, maxJobs: q.max }));
          return;
        }
        case "f":
          ctx.setAwaiting(uid, "admin_find");
          await ctx.say(chatId, L.askUser);
          return;
        case "c": {
          const target = Number(a);
          const n = Number(b);
          if (!db.getUser(target) || !(n > 0)) return L.userNotFound(a);
          const balance = db.addCredits(target, n);
          db.addUsage({ user: target, kind: "credits:grant", units: -n, cost_usd: 0 });
          ctx.log(`админ ${uid}: +${n} кр. пользователю ${target} → ${balance}`);
          if (msgId) {
            const c = card(target, uid);
            await ctx.edit(chatId, msgId, c.text, c.kb);
          }
          if (target !== uid) await ctx.say(target, t(db.getUser(target)?.lang).creditsGrantedUser(n, balance)).catch(() => undefined);
          return L.creditsGranted(n, target, balance);
        }
        case "ban": {
          const target = Number(a);
          const u = db.getUser(target);
          if (!u) return L.userNotFound(a);
          if (ctx.envAdmins.has(target) || target === uid) return "✖";
          db.updateUser(target, { status: u.status === "banned" ? "active" : "banned" });
          if (msgId) {
            const c = card(target, uid);
            await ctx.edit(chatId, msgId, c.text, c.kb);
          }
          return L.saved;
        }
        case "vip": {
          const target = Number(a);
          const u = db.getUser(target);
          if (!u) return L.userNotFound(a);
          const on = u.plan !== "vip";
          setVip(target, on, uid);
          if (msgId) {
            const c = card(target, uid);
            await ctx.edit(chatId, msgId, c.text, c.kb);
          }
          if (on && target !== uid) await tellVip(target);
          return L.vipSet(target, on);
        }
        case "let":
        case "ign": {
          const target = Number(a);
          if (!Number.isSafeInteger(target) || target <= 0) return;
          const key = `stranger.${target}`;
          const seen = (() => {
            try {
              return JSON.parse(db.getKv(key) ?? "{}") as { username?: string | null; first_name?: string | null };
            } catch {
              return {};
            }
          })();
          db.setKv(key, JSON.stringify({ ...seen, state: op === "let" ? "let" : "ignored", by: uid }));
          if (op === "ign") {
            if (msgId) await ctx.edit(chatId, msgId, L.strangerIgnored(target));
            return;
          }
          if (!db.getUser(target)) db.touchUser(target, { username: seen.username ?? undefined, first_name: seen.first_name ?? undefined }, { plan: "vip" });
          setVip(target, true, uid);
          if (msgId) await ctx.edit(chatId, msgId, L.strangerLet(target));
          await tellVip(target);
          return;
        }
        case "adm": {
          const target = Number(a);
          const u = db.getUser(target);
          if (!u) return L.userNotFound(a);
          if (ctx.envAdmins.has(target) || target === uid) return "✖";
          db.updateUser(target, { role: u.role === "admin" ? "user" : "admin" });
          if (msgId) {
            const c = card(target, uid);
            await ctx.edit(chatId, msgId, c.text, c.kb);
          }
          return L.saved;
        }
        case "b":
          ctx.setAwaiting(uid, "admin_broadcast");
          await ctx.say(chatId, L.askBroadcast);
          return;
        case "bs": {
          const text = ctx.getBroadcast(uid);
          ctx.setBroadcast(uid, undefined);
          if (!text) return L.broadcastCancelled;
          if (msgId) await ctx.edit(chatId, msgId, L.broadcastConfirm(db.broadcastAudience().length, text));
          ctx.track(broadcast(uid, chatId, text).catch((err) => ctx.log(`⚠ рассылка: ${err instanceof Error ? err.message : err}`)));
          return;
        }
        case "bx":
          ctx.setBroadcast(uid, undefined);
          if (msgId) await ctx.edit(chatId, msgId, L.broadcastCancelled);
          return;
        case "l":
          await ctx.say(chatId, limitsText(uid), limitsKb());
          return;
        // ── stage 28: «📊 Оценки» ──
        case "fb":
        case "fl":
        case "fd": {
          const days = [7, 30, 0].includes(Number(a)) ? Number(a) : 30;
          const s = summarizeFeedback(db.feedbackSince(), db.selfReviewsSince(), { days });
          if (op === "fb") {
            const text = formatFeedbackSummary(L, s);
            // from the admin menu ("a:fb:30:n") a new card; switching the window edits the card in place
            if (msgId && b !== "n") await ctx.edit(chatId, msgId, text, feedbackAdminKb(L, days));
            else await ctx.say(chatId, text, feedbackAdminKb(L, days));
            return;
          }
          const jobs = op === "fl" ? s.low.map((x) => x.f.job) : s.disagree.map((x) => x.f.job);
          await ctx.say(chatId, op === "fl" ? formatLowList(L, s) : formatDisagree(L, s), jobs.length ? feedbackJobsKb(jobs) : undefined);
          return;
        }
        case "fo": {
          if (!a) return;
          const text = formatJobFeedback(L, db.getJob(a), a, db.outputsOf(a), db.feedbackOf(a), db.selfReviewsOf(a));
          await ctx.say(chatId, text, db.outputsOf(a).length ? feedbackJobKb(L, a) : undefined);
          return;
        }
        case "fv": {
          if (!a) return;
          for (const o of db.outputsOf(a)) {
            if (!(await exists(o.file))) {
              await ctx.say(chatId, `${o.output_id}: ${L.fbAdmin.videoGone}`);
              continue;
            }
            try {
              await ctx.api.sendDocument(chatId, o.file, `${a} · ${o.output_id}`);
            } catch (err) {
              await ctx.say(chatId, `✖ ${o.output_id}: ${err instanceof Error ? err.message : err}`);
            }
          }
          return;
        }
        case "lv": {
          const f = FREE_PLAN_FIELDS[Number(a)];
          if (!f) return;
          const cur = ctx.plan()[f.key];
          const next = Math.min(f.max, Math.max(f.min, cur + (b === "+" ? 1 : -1) * limitStep(f.key)));
          db.setKv(`plan.free.${f.key}`, String(next));
          ctx.log(`админ ${uid}: ${f.key} ${cur} → ${next}`);
          if (msgId) await ctx.edit(chatId, msgId, limitsText(uid), limitsKb());
          return `${f.key}: ${next}`;
        }
      }
      return;
    },

    /** text while an admin prompt is pending; true = consumed */
    async text(uid: number, chatId: number, text: string): Promise<boolean> {
      const w = ctx.getAwaiting(uid);
      const L = ctx.T(uid);
      if (w === "admin_find") {
        ctx.setAwaiting(uid, undefined);
        const u = db.findUser(text);
        if (!u) {
          await ctx.say(chatId, L.userNotFound(text.trim()));
          return true;
        }
        const c = card(u.tg_id, uid);
        await ctx.say(chatId, c.text, c.kb);
        return true;
      }
      if (w === "admin_broadcast") {
        ctx.setAwaiting(uid, undefined);
        ctx.setBroadcast(uid, text);
        await ctx.say(chatId, L.broadcastConfirm(db.broadcastAudience().length, text), broadcastKb(L));
        return true;
      }
      return false;
    },
  };
}
