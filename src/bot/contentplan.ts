// Stage 32: «🗓 Контент-план» — the platform-independent half of autoposting.
//   niche + topics + frequency  →  idea cards on a schedule (from the trends research)  →  ✅ Сделать / ✏️ / ❌
//   ✅ → a normal make job (quotas, the shared queue)  →  the video  →  📢 publish to the user's Telegram channel
//   (after a confirmation) / 🕒 schedule / 📥 the manual pack for Instagram, TikTok, YouTube (file + ready caption).
// Nothing is ever published without a tap of the user: a scheduled post is that item's approval, given in advance.
// The scheduler is a persisted in-process loop (`tick`): every state lives in SQLite (content_items), so a restart
// loses nothing; a publish interrupted by a restart is reported, never retried blindly (no double posts).
import fs from "node:fs/promises";
import path from "node:path";
import type { AccountRow, BotDb, ContentItemRow, ContentPlanRow, JobRow, Lang, Platform } from "./db.ts";
import type { Strings } from "./i18n.ts";
import type { BotApi, InlineButton, InlineKeyboard } from "./telegram-api.ts";
import type { PipelineResult } from "./pipelines.ts";
import { checkChannel, PublishError, type Publisher } from "./publishers.ts";

// ── the brand profile and pure helpers ─────────────────────────────────────────

export interface BrandProfile {
  format?: "reel" | "promo";
  aspect?: string;
  /** a voice id, "auto" or "off" */
  voice?: string;
  cta?: string;
  /** "#a #b" — empty: picked from the niche and topics */
  hashtags?: string;
  /** local "HH:MM" posting times (VEDIT_TZ_OFFSET) */
  times?: string[];
}
export const DEFAULT_TIMES = ["10:00", "19:00"];

export interface IdeaDraft {
  idea: string;
  /** a supporting fact (shown as «Факт») */
  angle?: string;
  hook?: string;
  source?: string;
}
export interface IdeasQuery {
  niche: string;
  topics: string[];
  n: number;
  lang: Lang;
}
export type IdeasFn = (q: IdeasQuery) => Promise<{ ideas: IdeaDraft[]; usd?: number }>;

const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};
export const profileOf = (plan: Pick<ContentPlanRow, "profile">): BrandProfile => parseJson<BrandProfile>(plan.profile, {});
export const topicsOf = (plan: Pick<ContentPlanRow, "topics">): string[] => parseJson<string[]>(plan.topics, []);
const targetsOf = (item: ContentItemRow): number[] => parseJson<number[]>(item.targets, []).filter((n) => Number.isSafeInteger(n));

/** the trends research (src/make/trends.ts TrendsSchema) → idea cards: an angle each, with a fact and a hook */
export function ideasFromTrends(t: { facts: { text: string; source: string }[]; angles: string[]; hooks: string[] }, n: number): IdeaDraft[] {
  const out: IdeaDraft[] = [];
  const seen = new Set<string>();
  const push = (idea: string, i: number) => {
    const key = idea.trim().toLowerCase();
    if (!key || seen.has(key) || out.length >= n) return;
    seen.add(key);
    const fact = t.facts[i % Math.max(1, t.facts.length)];
    out.push({ idea: idea.trim(), angle: fact?.text ?? "", hook: t.hooks.length ? t.hooks[i % t.hooks.length] : "", source: fact?.source ?? "" });
  };
  t.angles.forEach((a, i) => push(a, i));
  // fewer angles than wanted: the facts themselves become ideas
  t.facts.forEach((f, i) => push(f.text, i + t.angles.length));
  return out;
}

/** the default idea source: the trends research of the make pipeline (agy or Gemini + Google Search), not modified */
export const defaultIdeas: IdeasFn = async ({ niche, topics, n, lang }) => {
  const { researchTrends } = await import("../make/trends.ts");
  const r = await researchTrends(topics.length ? `${niche} (${topics.join(", ")})` : niche, { language: lang });
  return { ideas: ideasFromTrends(r.trends, n), usd: r.usd };
};

/** the make topic of an idea: the idea, its fact and hook, the brand's call to action */
export function makeTopic(item: Pick<ContentItemRow, "idea" | "angle" | "hook">, profile: BrandProfile, fix?: string): string {
  const parts = [item.idea.replace(/[.\s]+$/, "")];
  if (item.angle) parts.push(`Факт: ${item.angle}`);
  if (item.hook) parts.push(`Хук: ${item.hook}`);
  if (profile.cta) parts.push(`В конце призыв: ${profile.cta}`);
  if (fix) parts.push(`Учти правку: ${fix}`);
  return parts.join(". ");
}

/** #tags from the topics (else the niche's longer words): lower case, letters and digits only, at most 5 */
export function autoTags(niche: string, topics: string[]): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const fromTopics = topics.map(norm).filter((x) => x.length >= 3);
  const words = fromTopics.length ? fromTopics : niche.split(/\s+/).map(norm).filter((w) => w.length > 3);
  return [...new Set(words)].slice(0, 5).map((w) => `#${w}`).join(" ");
}

export const CAPTION_MAX = 1024;

export function buildCaption(o: { title?: string | null; idea: string; hook?: string | null; profile: BrandProfile; niche: string; topics: string[] }): string {
  const tags = (o.profile.hashtags ?? "").trim() || autoTags(o.niche, o.topics);
  const head = (o.title ?? "").trim() || o.idea;
  const body = [head, o.hook ?? "", o.profile.cta ?? ""].map((s) => s.trim()).filter(Boolean);
  const text = [...new Set(body)].join("\n\n");
  const tail = tags ? `\n\n${tags}` : "";
  return text.length + tail.length <= CAPTION_MAX ? text + tail : `${text.slice(0, CAPTION_MAX - tail.length - 1)}…${tail}`;
}

/** "10:00, 19:00" → ["10:00","19:00"] (sorted, unique); undefined when anything does not parse */
export function parseTimes(text: string): string[] | undefined {
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  if (!parts.length || parts.length > 6) return undefined;
  const out: string[] = [];
  for (const p of parts) {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(p);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
    out.push(`${m[1].padStart(2, "0")}:${m[2]}`);
  }
  return [...new Set(out)].sort();
}

const DAY = 86_400_000;
const localMidnight = (ms: number, tz: number) => Math.floor((ms + tz * 3_600_000) / DAY) * DAY - tz * 3_600_000;
const at = (midnight: number, hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return midnight + h * 3_600_000 + m * 60_000;
};

/** the next posting slots (ms, UTC) from the local times, at least 5 minutes ahead, within `maxAheadDays` */
export function nextSlots(nowMs: number, times: string[], tz: number, count: number, maxAheadDays: number): number[] {
  const base = localMidnight(nowMs, tz);
  const out: number[] = [];
  for (let d = 0; d <= maxAheadDays; d++) for (const t of times) out.push(at(base + d * DAY, t));
  return out.filter((ms) => ms >= nowMs + 5 * 60_000 && ms <= nowMs + maxAheadDays * DAY).sort((a, b) => a - b).slice(0, count);
}

/** «сегодня 19:00» / «завтра 10:00» / «23.10 10:00» in the local time */
export function slotLabel(ms: number, nowMs: number, tz: number, L: { today: string; tomorrow: string }): string {
  const local = new Date(ms + tz * 3_600_000);
  const hm = `${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
  const days = Math.round((localMidnight(ms, tz) - localMidnight(nowMs, tz)) / DAY);
  if (days === 0) return `${L.today} ${hm}`;
  if (days === 1) return `${L.tomorrow} ${hm}`;
  return `${String(local.getUTCDate()).padStart(2, "0")}.${String(local.getUTCMonth() + 1).padStart(2, "0")} ${hm}`;
}

/** when the i-th of n weekly ideas is shown: spread over the week, at 09:00 local; the first one right away */
export function proposeTimes(nowMs: number, n: number, tz: number): number[] {
  const base = localMidnight(nowMs, tz);
  return Array.from({ length: n }, (_, i) => {
    if (i === 0) return nowMs;
    const t = at(base + Math.floor((i * 7) / n) * DAY, "09:00");
    return t <= nowMs ? nowMs : t;
  });
}

// ── keyboards ─────────────────────────────────────────────────────────────────

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);
export const PER_WEEK = [1, 2, 3, 5, 7];

export function planKb(L: Strings, plan: ContentPlanRow): InlineKeyboard {
  const c = L.cp;
  const p = profileOf(plan);
  return {
    inline_keyboard: [
      [btn(c.btnNiche, "CP:n"), btn(c.btnTopics, "CP:t")],
      PER_WEEK.map((n) => btn(mark(plan.per_week === n, c.perWeek(n)), `CP:w:${n}`)),
      [btn(mark((p.format ?? "reel") === "reel", c.btnReel), "CP:f:reel"), btn(mark(p.format === "promo", c.btnPromo), "CP:f:promo")],
      [btn(c.btnCta, "CP:cta"), btn(c.btnHashtags, "CP:tags"), btn(c.btnTimes, "CP:times")],
      [btn(c.btnIdeasNow, "CP:now")],
      [btn(c.btnConnectTg, "CP:conn")],
      [btn(c.btnInstagram, "CP:soon:instagram"), btn(c.btnYoutube, "CP:soon:youtube"), btn(c.btnTiktok, "CP:soon:tiktok")],
      [btn(plan.enabled ? c.btnPause : c.btnResume, plan.enabled ? "CP:off" : "CP:on")],
    ],
  };
}

export const ideaKb = (L: Strings, id: number): InlineKeyboard => ({ inline_keyboard: [[btn(L.cp.btnMake, `CP:ok:${id}`), btn(L.cp.btnEditIdea, `CP:ed:${id}`), btn(L.cp.btnSkip, `CP:sk:${id}`)]] });

export function readyKb(L: Strings, id: number, channels: AccountRow[]): InlineKeyboard {
  const c = L.cp;
  const rows: InlineButton[][] = channels.map((a) => [btn(c.btnPublishTo(a.label), `CP:pub:${id}:${a.id}`)]);
  rows.push([btn(c.btnSchedule, `CP:sch:${id}`)]);
  rows.push([btn(c.btnManual, `CP:dl:${id}`)]);
  rows.push([btn(c.btnEditCaption, `CP:cap:${id}`), btn(c.btnFixVideo, `CP:fix:${id}`)]);
  if (!channels.length) rows.push([btn(c.btnConnect, "CP:conn")]);
  return { inline_keyboard: rows };
}

// ── the handlers ──────────────────────────────────────────────────────────────

export interface ContentPlanDeps {
  db: BotDb;
  api: BotApi;
  T: (uid: number) => Strings;
  langOf: (uid: number) => Lang;
  /** sends with the keyboard encoded (long callback data through the DB id map) */
  say: (chatId: number, text: string, kb?: InlineKeyboard) => Promise<number | undefined>;
  edit: (chatId: number, msgId: number, text: string, kb?: InlineKeyboard) => Promise<void>;
  editMarkup: (chatId: number, msgId: number, kb?: InlineKeyboard) => Promise<void>;
  setAwaiting: (uid: number, v: string | undefined) => void;
  /** a make job through the bot's normal submit (quotas, budget, the shared queue); undefined when refused */
  submitMake: (uid: number, chatId: number, a: { topic: string; aspect: string; voice?: string; format?: "reel" | "promo"; cpItem: number }) => Promise<JobRow | undefined>;
  publishers: Partial<Record<Platform, Publisher>>;
  ideas: IdeasFn;
  /** VEDIT_TZ_OFFSET, hours */
  tz: number;
  /** how far ahead a post may be scheduled (the file must outlive the retention cleanup) */
  maxAheadDays: number;
  /** per connected account: successful posts in 24 h, and the minimum pause between two posts */
  dailyPosts: number;
  minGapMs: number;
  log: (line: string) => void;
  track: (p: Promise<unknown>) => void;
  now?: () => number;
}

export function contentPlanHandlers(d: ContentPlanDeps) {
  const { db } = d;
  const now = () => (d.now ?? Date.now)();
  const iso = (ms: number) => new Date(ms).toISOString();
  const generating = new Set<number>();
  const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0];

  function planView(uid: number, plan: ContentPlanRow) {
    const L = d.T(uid);
    const p = profileOf(plan);
    const next = plan.next_ideas_at ? slotLabel(Date.parse(plan.next_ideas_at), now(), d.tz, L.cp) : "";
    return L.cp.card({
      niche: plan.niche,
      topics: topicsOf(plan),
      perWeek: plan.per_week,
      enabled: plan.enabled === 1,
      format: p.format ?? "reel",
      aspect: p.aspect ?? (p.format === "promo" ? "16:9" : "9:16"),
      voice: p.voice === "off" ? L.voiceNone : p.voice && p.voice !== "auto" ? p.voice : L.voiceAuto,
      cta: p.cta ?? "",
      hashtags: p.hashtags ?? "",
      times: p.times ?? DEFAULT_TIMES,
      channels: db.accountsOf(uid, "telegram").map((a) => a.label),
      next,
    });
  }

  async function menu(uid: number, chatId: number) {
    const plan = db.getPlan(uid);
    if (!plan) {
      d.setAwaiting(uid, "cp_niche");
      return void (await d.say(chatId, d.T(uid).cp.askNiche));
    }
    await d.say(chatId, planView(uid, plan), planKb(d.T(uid), plan));
  }

  function setProfile(uid: number, patch: Partial<BrandProfile>) {
    const plan = db.getPlan(uid);
    if (!plan) return undefined;
    const p = { ...profileOf(plan), ...patch };
    for (const k of Object.keys(p) as (keyof BrandProfile)[]) if (p[k] === undefined || p[k] === "") delete p[k];
    return db.upsertPlan(uid, { profile: JSON.stringify(p) });
  }

  // ── ideas ──

  async function sendIdea(item: ContentItemRow) {
    const L = d.T(item.user);
    const msgId = await d.say(item.user, L.cp.ideaCard(item.idea, item.angle ?? "", item.hook ?? "", item.source ?? ""), ideaKb(L, item.id));
    db.updateItem(item.id, { status: "proposed", card_msg_id: msgId ?? null });
  }

  /** researches a batch for the plan; `manual` (💡 Идеи сейчас) reports failures to the user */
  async function generate(plan: ContentPlanRow, manual = false) {
    const uid = plan.user;
    if (generating.has(uid)) return;
    // ideas the user has not answered yet: no new batch on top of them (no flood, no spend)
    const open = db.itemsOf(uid, "pending", "proposed").length;
    if (open >= Math.max(3, plan.per_week * 2)) {
      if (manual) await d.say(uid, d.T(uid).cp.ideasBusy);
      return;
    }
    generating.add(uid);
    try {
      const r = await d.ideas({ niche: plan.niche, topics: topicsOf(plan), n: plan.per_week, lang: d.langOf(uid) });
      if (r.usd) db.addUsage({ user: uid, kind: "cp:ideas", units: 0, cost_usd: r.usd });
      if (!r.ideas.length) {
        if (manual) await d.say(uid, d.T(uid).cp.ideasNone);
        return;
      }
      const times = proposeTimes(now(), r.ideas.length, d.tz);
      r.ideas.forEach((x, i) => db.insertItem({ user: uid, idea: x.idea.slice(0, 300), angle: x.angle?.slice(0, 500) || null, hook: x.hook?.slice(0, 300) || null, source: x.source?.slice(0, 300) || null, status: "pending", propose_at: iso(times[i]) }));
      d.log(`[${uid}] контент-план: идей ${r.ideas.length}`);
      await proposeDue();
    } catch (err) {
      d.log(`⚠ [${uid}] контент-план, идеи: ${errText(err)}`);
      // try again in 6 h instead of next week
      if (db.getPlan(uid)?.enabled) db.upsertPlan(uid, { next_ideas_at: iso(now() + 6 * 3_600_000) });
      if (manual) await d.say(uid, d.T(uid).cp.ideasFailed);
    } finally {
      generating.delete(uid);
    }
  }

  async function proposeDue() {
    for (const item of db.itemsToPropose(iso(now()))) {
      if (db.getUser(item.user)?.status === "banned") continue;
      await sendIdea(item);
    }
  }

  // ── after the video ──

  function channelsOf(uid: number) {
    return db.accountsOf(uid, "telegram");
  }

  async function sendReady(item: ContentItemRow) {
    const L = d.T(item.user);
    await d.say(item.user, L.cp.readyCard(item.idea, item.caption ?? ""), readyKb(L, item.id, channelsOf(item.user)));
  }

  /** the bot delivered a job's result: a content-plan job turns its item «ready» with a caption and the publish card */
  async function onDelivered(jobId: string, result: PipelineResult) {
    const item = db.itemByJob(jobId);
    if (!item || item.status !== "accepted") return;
    const out = result.outputs[0];
    if (!out) {
      db.updateItem(item.id, { status: "failed", error: "нет готового видео" });
      return;
    }
    const plan = db.getPlan(item.user);
    const caption = buildCaption({ title: result.title, idea: item.idea, hook: item.hook, profile: plan ? profileOf(plan) : {}, niche: plan?.niche ?? "", topics: plan ? topicsOf(plan) : [] });
    db.updateItem(item.id, { status: "ready", output_file: out.file, title: result.title ?? null, caption });
    await sendReady({ ...item, status: "ready", output_file: out.file, caption });
  }

  /** the make job of an item failed or was cancelled */
  async function onJobEnded(jobId: string) {
    const item = db.itemByJob(jobId);
    if (!item || !db.claimItem(item.id, ["accepted"], "failed", { error: "видео не получилось" })) return;
    const L = d.T(item.user);
    await d.say(item.user, L.cp.videoFailed(item.idea), { inline_keyboard: [[btn(L.cp.btnRetry, `CP:ok:${item.id}`)]] });
  }

  async function accept(uid: number, chatId: number, item: ContentItemRow, fix?: string): Promise<boolean> {
    const plan = db.getPlan(uid);
    const p = plan ? profileOf(plan) : {};
    const format = p.format ?? "reel";
    const aspect = p.aspect ?? (format === "promo" ? "16:9" : "9:16");
    const job = await d.submitMake(uid, chatId, { topic: makeTopic(item, p, fix), aspect, voice: format === "promo" && !p.voice ? "off" : p.voice, format, cpItem: item.id });
    if (!job) return false;
    db.updateItem(item.id, { status: "accepted", job: job.id, error: null, output_file: null });
    return true;
  }

  // ── publishing ──

  async function manualPack(uid: number, chatId: number, item: ContentItemRow) {
    const L = d.T(uid);
    await d.say(chatId, L.cp.manualTips);
    await d.say(chatId, item.caption ?? item.idea);
    if (!item.output_file) return;
    try {
      await fs.stat(item.output_file);
    } catch {
      return void (await d.say(chatId, L.cp.fileGone));
    }
    const name = `${(item.title ?? item.idea).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "video"}${path.extname(item.output_file) || ".mp4"}`;
    try {
      await d.api.sendDocument(chatId, item.output_file, undefined, { fileName: name, disableContentTypeDetection: true });
    } catch (err) {
      d.log(`⚠ [${uid}] контент-план, файл для ручной публикации: ${errText(err)}`);
    }
  }

  /** ms until the account may post again (0 = now) */
  function waitFor(account: AccountRow): number {
    const t = now();
    if (db.publishedSince(account.id, iso(t - DAY)) >= d.dailyPosts) return DAY / 4;
    const last = db.lastPublished(account.id);
    const gap = last ? Date.parse(last.created_at) + d.minGapMs - t : 0;
    return Math.max(0, gap);
  }

  /** publishes an item to its accounts; true when at least one post went out */
  async function publishItem(item: ContentItemRow, accounts: AccountRow[], trigger: "now" | "schedule"): Promise<boolean> {
    const uid = item.user;
    const L = d.T(uid);
    // rate limits first: a scheduled post moves, a «now» is refused
    const blocked = accounts.map((a) => ({ a, wait: waitFor(a) })).filter((x) => x.wait > 0);
    if (blocked.length) {
      const wait = Math.max(...blocked.map((x) => x.wait));
      const label = blocked.map((x) => x.a.label).join(", ");
      const when = slotLabel(now() + wait, now(), d.tz, L.cp);
      if (trigger === "schedule") db.updateItem(item.id, { scheduled_at: iso(now() + wait) });
      for (const x of blocked) db.logPublish({ item: item.id, account: x.a.id, user: uid, platform: x.a.platform, trigger, status: "skipped", error: "rate limit" });
      await d.say(uid, L.cp.rateLimited(label, when));
      return false;
    }
    if (!db.claimItem(item.id, trigger === "now" ? ["ready"] : ["scheduled"], "publishing")) return false;
    let ok = 0;
    let gone = false;
    for (const account of accounts) {
      const pub = d.publishers[account.platform];
      try {
        if (!pub) throw new PublishError(`${account.platform}: не подключено`, "not_configured");
        const r = await pub.publish({ account, file: item.output_file ?? "", caption: item.caption ?? item.idea, title: item.title ?? undefined });
        db.logPublish({ item: item.id, account: account.id, user: uid, platform: account.platform, trigger, status: "ok", external_id: r.externalId ?? null, url: r.url ?? null });
        ok++;
        d.log(`[${uid}] контент-план: опубликовано ${item.id} → ${account.platform} ${account.label}`);
        await d.say(uid, L.cp.published(account.label, r.url ?? ""));
      } catch (err) {
        const reason = errText(err);
        if (err instanceof PublishError && err.code === "gone") gone = true;
        if (err instanceof PublishError && err.code === "rights") db.updateAccount(account.id, { status: "error", error: reason });
        db.logPublish({ item: item.id, account: account.id, user: uid, platform: account.platform, trigger, status: "failed", error: reason.slice(0, 500) });
        d.log(`⚠ [${uid}] контент-план: публикация ${item.id} → ${account.label}: ${reason}`);
        await d.say(uid, gone ? L.cp.fileGone : L.cp.publishFailed(account.label, reason));
      }
    }
    // nothing went out: the video waits for another decision (a gone file cannot be posted any more)
    db.updateItem(item.id, ok ? { status: "published", scheduled_at: null } : { status: gone ? "failed" : "ready", scheduled_at: null, error: gone ? "файл удалён" : null });
    if (!ok && !gone) await sendReady({ ...db.getItem(item.id)! });
    return ok > 0;
  }

  async function publishDue() {
    for (const item of db.itemsToPublish(iso(now()))) {
      const accounts = targetsOf(item)
        .map((id) => db.getAccount(id))
        .filter((a): a is AccountRow => !!a && a.user === item.user && a.status === "active");
      if (!accounts.length) {
        // a reminder slot (or every target got disconnected): the manual pack at the chosen time
        if (!db.claimItem(item.id, ["scheduled"], "ready", { scheduled_at: null })) continue;
        db.logPublish({ item: item.id, account: null, user: item.user, platform: "manual", trigger: "schedule", status: "skipped", error: "reminder" });
        await d.say(item.user, d.T(item.user).cp.reminderDue(item.idea));
        await manualPack(item.user, item.user, item);
        continue;
      }
      await publishItem(item, accounts, "schedule");
    }
  }

  /** items whose make job ended while the bot was down (restart recovery marks running jobs failed) */
  async function reconcile() {
    for (const item of db.itemsByStatus("accepted")) {
      const job = item.job ? db.getJob(item.job) : undefined;
      if (!job || job.status === "failed" || job.status === "cancelled") await onJobEnded(item.job ?? "");
    }
  }

  /** one pass of the scheduler: new idea batches, due idea cards, due posts */
  async function tick() {
    const t = now();
    for (const plan of db.plansDue(iso(t))) {
      db.upsertPlan(plan.user, { next_ideas_at: iso(t + 7 * DAY) });
      d.track(generate(plan));
    }
    await proposeDue();
    await publishDue();
    await reconcile();
  }

  /** after a restart: a publish that was in flight is reported (it may or may not have gone out) — never repeated */
  async function recover() {
    for (const item of db.itemsByStatus("publishing")) {
      db.updateItem(item.id, { status: "failed", error: "прервано перезапуском" });
      await d.say(item.user, d.T(item.user).cp.interrupted(item.idea));
    }
  }

  // ── /connect_channel ──

  async function connectChannel(uid: number, chatId: number, arg: string) {
    const L = d.T(uid).cp;
    const ref = arg.trim().replace(/^https?:\/\/t\.me\//i, "@").split(/\s+/)[0] ?? "";
    if (!/^(@\w{4,}|-100\d+)$/.test(ref)) return void (await d.say(chatId, `${L.connectUsage}\n\n${L.connectHow}`));
    const r = await checkChannel(d.api, uid, ref);
    if (!r.ok) {
      const text = { unsupported: L.connectUnsupported, not_found: L.connectNotFound, not_channel: L.connectNotChannel, bot_not_admin: L.connectBotNotAdmin, bot_cant_post: L.connectBotCantPost, user_not_admin: L.connectUserNotAdmin }[r.reason];
      return void (await d.say(chatId, text));
    }
    db.upsertAccount({ user: uid, platform: "telegram", label: r.label, external_id: String(r.chat.id), status: "active", error: null });
    d.log(`[${uid}] контент-план: подключён канал ${r.label} (${r.chat.id})`);
    await d.say(chatId, L.connected(r.label));
    // videos waiting for a decision get the new button
    for (const item of db.itemsOf(uid, "ready")) await sendReady(item);
  }

  // ── text replies (awaiting cp_*) ──

  async function text(uid: number, chatId: number, awaiting: string, input: string): Promise<void> {
    const L = d.T(uid).cp;
    d.setAwaiting(uid, undefined);
    const clear = input.trim() === "-";
    const [kind, idStr] = awaiting.split(":");
    if (kind === "cp_niche") {
      const niche = input.trim().slice(0, 200);
      const had = db.getPlan(uid);
      const plan = db.upsertPlan(uid, had ? { niche } : { niche, next_ideas_at: iso(now()) });
      if (!had) await d.say(chatId, L.nicheSaved);
      await d.say(chatId, planView(uid, plan), planKb(d.T(uid), plan));
      if (!had) d.track(tick());
      return;
    }
    if (kind === "cp_topics") {
      const topics = clear ? [] : input.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean).slice(0, 10).map((s) => s.slice(0, 60));
      db.upsertPlan(uid, { topics: JSON.stringify(topics) });
    } else if (kind === "cp_cta") setProfile(uid, { cta: clear ? undefined : input.trim().slice(0, 200) });
    else if (kind === "cp_tags") {
      const tags = input.split(/[\s,]+/).filter(Boolean).map((s) => (s.startsWith("#") ? s : `#${s}`)).slice(0, 15).join(" ");
      setProfile(uid, { hashtags: clear ? undefined : tags });
    } else if (kind === "cp_times") {
      const times = parseTimes(input);
      if (!times) {
        d.setAwaiting(uid, awaiting);
        return void (await d.say(chatId, L.timesBad));
      }
      setProfile(uid, { times });
    } else {
      // item replies: cp_edit:<id> (the idea), cp_cap:<id> (the caption), cp_fix:<id> (a note for a new version)
      const item = db.getItem(Number(idStr));
      if (!item || item.user !== uid) return void (await d.say(chatId, L.ideaGone));
      if (kind === "cp_edit" && ["proposed", "failed"].includes(item.status)) {
        db.updateItem(item.id, { idea: input.trim().slice(0, 300), angle: null, hook: null, source: null, status: "proposed" });
        await d.say(chatId, L.ideaUpdated);
        return void (await sendIdea({ ...db.getItem(item.id)! }));
      }
      if (kind === "cp_cap" && item.status === "ready") {
        db.updateItem(item.id, { caption: input.trim().slice(0, CAPTION_MAX) });
        await d.say(chatId, L.captionSaved);
        return void (await sendReady(db.getItem(item.id)!));
      }
      if (kind === "cp_fix" && item.status === "ready") {
        if (await accept(uid, chatId, item, input.trim().slice(0, 500))) await d.say(chatId, L.ideaAccepted);
        return;
      }
      return void (await d.say(chatId, L.ideaGone));
    }
    await d.say(chatId, L.saved);
    const plan = db.getPlan(uid);
    if (plan) await d.say(chatId, planView(uid, plan), planKb(d.T(uid), plan));
  }

  // ── buttons (CP:…) ──

  async function callback(uid: number, chatId: number, msgId: number | undefined, data: string): Promise<string | undefined> {
    const L = d.T(uid);
    const c = L.cp;
    const [, op, a, b] = data.split(":");
    const plan = db.getPlan(uid);
    const refresh = async (p: ContentPlanRow | undefined) => {
      if (p && msgId) await d.edit(chatId, msgId, planView(uid, p), planKb(L, p));
    };
    const ask = async (key: string, prompt: string) => {
      d.setAwaiting(uid, key);
      await d.say(chatId, prompt);
      return undefined;
    };
    switch (op) {
      // the plan card
      case "n":
        return ask("cp_niche", c.askNiche);
      case "t":
        return plan ? ask("cp_topics", c.askTopics) : c.noPlan;
      case "cta":
        return plan ? ask("cp_cta", c.askCta) : c.noPlan;
      case "tags":
        return plan ? ask("cp_tags", c.askHashtags) : c.noPlan;
      case "times":
        return plan ? ask("cp_times", c.askTimes) : c.noPlan;
      case "w": {
        const n = Number(a);
        if (!plan || !PER_WEEK.includes(n)) return c.noPlan;
        await refresh(db.upsertPlan(uid, { per_week: n }));
        return c.saved;
      }
      case "f": {
        if (!plan || (a !== "reel" && a !== "promo")) return c.noPlan;
        await refresh(setProfile(uid, { format: a, aspect: a === "promo" ? "16:9" : "9:16" }));
        return c.saved;
      }
      case "on":
      case "off": {
        if (!plan) return c.noPlan;
        const on = op === "on";
        await refresh(db.upsertPlan(uid, { enabled: on ? 1 : 0, ...(on && (!plan.next_ideas_at || Date.parse(plan.next_ideas_at) < now()) ? { next_ideas_at: iso(now()) } : {}) }));
        return on ? c.resumed : c.paused;
      }
      case "now": {
        if (!plan) return c.noPlan;
        if (generating.has(uid)) return c.ideasBusy;
        await d.say(chatId, c.ideasStarted);
        d.track(generate(plan, true));
        return undefined;
      }
      case "conn":
        await d.say(chatId, c.connectHow);
        return undefined;
      case "soon": {
        const name = { instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok" }[a as "instagram" | "youtube" | "tiktok"];
        if (name) await d.say(chatId, c.platformSoon(name));
        return undefined;
      }
    }
    // the item cards
    const item = db.getItem(Number(a));
    if (!item || item.user !== uid) return c.ideaGone;
    switch (op) {
      case "ok": {
        if (!["proposed", "failed"].includes(item.status)) return c.ideaGone;
        if (!(await accept(uid, chatId, item))) return undefined;
        if (msgId) await d.edit(chatId, msgId, `${c.ideaCard(item.idea, item.angle ?? "", item.hook ?? "", item.source ?? "")}\n\n${c.ideaAccepted}`);
        return undefined;
      }
      case "ed":
        if (!["proposed", "failed"].includes(item.status)) return c.ideaGone;
        return ask(`cp_edit:${item.id}`, c.askEditIdea);
      case "sk":
        if (!db.claimItem(item.id, ["proposed", "failed"], "skipped")) return c.ideaGone;
        if (msgId) await d.edit(chatId, msgId, `${c.ideaCard(item.idea, "", "", "")}\n\n${c.ideaSkipped}`);
        return c.ideaSkipped;
      case "cap":
        if (item.status !== "ready") return c.ideaGone;
        return ask(`cp_cap:${item.id}`, c.askCaption);
      case "fix":
        if (item.status !== "ready") return c.ideaGone;
        return ask(`cp_fix:${item.id}`, c.askFix);
      case "dl":
        if (!["ready", "scheduled", "published"].includes(item.status)) return c.ideaGone;
        await manualPack(uid, chatId, item);
        return undefined;
      case "back":
        if (item.status !== "ready") return c.ideaGone;
        if (msgId) await d.editMarkup(chatId, msgId, readyKb(L, item.id, channelsOf(uid)));
        return undefined;
      case "pub": {
        // step 1: the explicit confirmation (a post cannot be taken back from here)
        const acc = db.getAccount(Number(b));
        if (item.status !== "ready" || !acc || acc.user !== uid || acc.status !== "active") return c.ideaGone;
        if (msgId) await d.edit(chatId, msgId, c.confirmPublish(acc.label), { inline_keyboard: [[btn(c.btnConfirm(acc.label), `CP:pubok:${item.id}:${acc.id}`)], [btn(c.btnBack, `CP:rd:${item.id}`)]] });
        return undefined;
      }
      case "rd":
        if (item.status !== "ready") return c.ideaGone;
        if (msgId) await d.edit(chatId, msgId, c.readyCard(item.idea, item.caption ?? ""), readyKb(L, item.id, channelsOf(uid)));
        return undefined;
      case "pubok": {
        const acc = db.getAccount(Number(b));
        if (item.status !== "ready" || !acc || acc.user !== uid || acc.status !== "active") return c.ideaGone;
        if (msgId) await d.editMarkup(chatId, msgId, undefined);
        await publishItem(item, [acc], "now");
        return undefined;
      }
      case "sch": {
        if (item.status !== "ready") return c.ideaGone;
        const p = plan ? profileOf(plan) : {};
        const slots = nextSlots(now(), p.times ?? DEFAULT_TIMES, d.tz, 6, d.maxAheadDays);
        const rows: InlineButton[][] = [];
        slots.forEach((ms, i) => (i % 2 ? rows[rows.length - 1].push(btn(slotLabel(ms, now(), d.tz, c), `CP:at:${item.id}:${Math.round(ms / 60_000)}`)) : rows.push([btn(slotLabel(ms, now(), d.tz, c), `CP:at:${item.id}:${Math.round(ms / 60_000)}`)])));
        rows.push([btn(c.btnBack, `CP:rd:${item.id}`)]);
        if (msgId) await d.edit(chatId, msgId, c.scheduleAsk, { inline_keyboard: rows });
        return undefined;
      }
      case "at": {
        const ms = Number(b) * 60_000;
        if (item.status !== "ready" || !Number.isFinite(ms) || ms < now() || ms > now() + (d.maxAheadDays + 1) * DAY) return c.ideaGone;
        // the post goes to every connected channel; none → a reminder with the manual pack at that time
        const accounts = channelsOf(uid);
        if (!db.claimItem(item.id, ["ready"], "scheduled", { scheduled_at: iso(ms), targets: JSON.stringify(accounts.map((x) => x.id)) })) return c.ideaGone;
        const text = c.scheduled(slotLabel(ms, now(), d.tz, c), accounts.map((x) => x.label));
        if (msgId) await d.edit(chatId, msgId, text, { inline_keyboard: [[btn(c.btnCancelSchedule, `CP:uns:${item.id}`)]] });
        else await d.say(chatId, text);
        return undefined;
      }
      case "uns": {
        if (!db.claimItem(item.id, ["scheduled"], "ready", { scheduled_at: null })) return c.ideaGone;
        if (msgId) await d.edit(chatId, msgId, `${c.unscheduled}\n\n${c.readyCard(item.idea, item.caption ?? "")}`, readyKb(L, item.id, channelsOf(uid)));
        return c.unscheduled;
      }
    }
    return undefined;
  }

  return { menu, text, callback, connectChannel, onDelivered, onJobEnded, tick, recover, generate };
}

export type ContentPlan = ReturnType<typeof contentPlanHandlers>;
