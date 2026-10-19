// Bot storage: users, settings, sessions, jobs, usage — SQLite through Node's built-in `node:sqlite`
// (no native dependency: the same code runs on Windows and on ARM Linux). One file: workspace/_bot/vedit.db.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { JobClass, PlanLimits } from "./plans.ts";
import { FREE_PLAN_FIELDS } from "./plans.ts";

export type Lang = "ru" | "uz" | "en";
export const LANGS: Lang[] = ["ru", "uz", "en"];
export const isLang = (s: unknown): s is Lang => s === "ru" || s === "uz" || s === "en";

/** onboarding steps: language → purpose (after the intro) → terms → done */
export type OnboardingStep = "lang" | "purpose" | "terms" | "done";
export type JobKind = "run" | "make" | "revise" | "avatar" | "avatar_import" | "dub";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface UserRow {
  tg_id: number;
  username: string | null;
  first_name: string | null;
  lang: Lang;
  onboarding: OnboardingStep;
  purpose: string | null;
  accepted_terms_at: string | null;
  created_at: string;
  last_seen: string | null;
  status: "active" | "banned";
  role: "user" | "admin";
  credits: number;
  plan: string;
  /** 1 = receives broadcasts (📣); the user turns it off in ⚙️ */
  news: number;
}

export interface JobRow {
  id: string;
  user: number;
  chat_id: number;
  kind: JobKind;
  class: JobClass;
  status: JobStatus;
  stage: string | null;
  percent: number | null;
  status_msg_id: number | null;
  result_msg_id: number | null;
  /** JSON: what the job needs to run (source, instruction, topic…) — a queued job survives a restart */
  payload: string;
  /** the pipeline job (workspace/<id>) */
  vedit_job: string | null;
  paid_credits: number;
  cost_usd: number | null;
  rating: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  /** files deleted by the retention cleanup */
  purged: number;
}

export interface OutputRow {
  job: string;
  output_id: string;
  file: string;
  duration: number | null;
  aspect: string | null;
  created_at: string;
}

/** one record per (job, output, user); output_id "*" = the whole result message (several outputs rated at once) */
export interface FeedbackRow {
  job: string;
  output_id: string;
  user: number;
  stars: number;
  /** JSON array of reason codes (see src/bot/feedback.ts) */
  reasons: string;
  comment: string | null;
  /** text | voice */
  comment_kind: string | null;
  /** montage | highlights | reference | make | revise | avatar */
  kind: string | null;
  preset: string | null;
  voice: string | null;
  aspect: string | null;
  duration: number | null;
  cost_usd: number | null;
  /** the bot already said «Похоже, проблема в …» for this record */
  acked: number;
  created_at: string;
  updated_at: string;
}

export interface SelfReviewRow {
  job: string;
  output_id: string;
  hash: string | null;
  status: "ok" | "skipped" | "failed";
  /** JSON: { hook: { score, reason }, …, overall } */
  scores: string | null;
  overall: number | null;
  /** JSON array of the top fixes */
  fixes: string;
  summary: string | null;
  confidence: number | null;
  model: string | null;
  cost_usd: number;
  error: string | null;
  created_at: string;
}

const MIGRATIONS: string[] = [
  // 1: the whole schema
  `
  CREATE TABLE users (
    tg_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    lang TEXT NOT NULL DEFAULT 'ru' CHECK (lang IN ('ru','uz','en')),
    onboarding TEXT NOT NULL DEFAULT 'lang' CHECK (onboarding IN ('lang','purpose','terms','done')),
    purpose TEXT,
    accepted_terms_at TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','banned')),
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
    credits INTEGER NOT NULL DEFAULT 0,
    plan TEXT NOT NULL DEFAULT 'free',
    news INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX users_username ON users (lower(username));
  CREATE TABLE settings (
    user INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (user, key)
  );
  CREATE TABLE sessions (
    user INTEGER PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    user INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    class TEXT NOT NULL CHECK (class IN ('standard','long','light')),
    status TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
    stage TEXT,
    percent INTEGER,
    status_msg_id INTEGER,
    result_msg_id INTEGER,
    payload TEXT NOT NULL,
    vedit_job TEXT,
    paid_credits INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    rating INTEGER,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    purged INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX jobs_user ON jobs (user, created_at);
  CREATE INDEX jobs_status ON jobs (status);
  CREATE TABLE usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user INTEGER NOT NULL,
    kind TEXT NOT NULL,
    units REAL NOT NULL DEFAULT 1,
    cost_usd REAL NOT NULL DEFAULT 0,
    job_id TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX usage_user ON usage (user, created_at);
  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE callbacks (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, created_at TEXT NOT NULL);
  `,
  // 2: stage 22 — Style DNA of references by Telegram file_unique_id / canonical link (the profile itself lives in workspace/_cache/style/<key>.json)
  `
  CREATE TABLE style_cache (
    alias TEXT PRIMARY KEY,
    key TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL
  );
  `,
  // 3: stage 28 — delivered outputs, the user's feedback (stars + reasons + comment) and the AI critic's self-review
  `
  CREATE TABLE outputs (
    job TEXT NOT NULL,
    output_id TEXT NOT NULL,
    file TEXT NOT NULL,
    duration REAL,
    aspect TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job, output_id)
  );
  CREATE TABLE feedback (
    job TEXT NOT NULL,
    output_id TEXT NOT NULL,
    user INTEGER NOT NULL,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    reasons TEXT NOT NULL DEFAULT '[]',
    comment TEXT,
    comment_kind TEXT,
    kind TEXT,
    preset TEXT,
    voice TEXT,
    aspect TEXT,
    duration REAL,
    cost_usd REAL,
    acked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job, output_id, user)
  );
  CREATE INDEX feedback_created ON feedback (created_at);
  CREATE TABLE self_review (
    job TEXT NOT NULL,
    output_id TEXT NOT NULL,
    hash TEXT,
    status TEXT NOT NULL CHECK (status IN ('ok','skipped','failed')),
    scores TEXT,
    overall INTEGER,
    fixes TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    confidence REAL,
    model TEXT,
    cost_usd REAL NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (job, output_id)
  );
  CREATE INDEX self_review_hash ON self_review (hash);
  -- ratings given before stage 28 (stars only) become feedback records, so the analytics start with them
  INSERT INTO feedback (job, output_id, user, stars, reasons, kind, preset, voice, aspect, cost_usd, created_at, updated_at)
  SELECT id, '*', user, rating, '[]',
    CASE kind WHEN 'run' THEN 'montage' WHEN 'make' THEN 'make' WHEN 'revise' THEN 'revise' ELSE 'avatar' END,
    CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload, '$.preset'), CASE kind WHEN 'make' THEN 'make' END) END,
    CASE WHEN json_valid(payload) THEN json_extract(payload, '$.voice') END,
    CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload, '$.resultAspect'), json_extract(payload, '$.aspect')) END,
    cost_usd, COALESCE(finished_at, created_at), COALESCE(finished_at, created_at)
  FROM jobs WHERE rating BETWEEN 1 AND 5;
  `,
  // 4: testers let in from the bot (on top of TELEGRAM_ALLOWED_USERS): /allow, /vip, «✅ Пустить (VIP)»
  `
  CREATE TABLE allowlist (
    tg_id INTEGER PRIMARY KEY,
    added_by INTEGER,
    created_at TEXT NOT NULL
  );
  `,
  // 5: stage 30 — testers let in automatically (slots) or by a pending @username; rights confirmations for
  // third-party links; the takedown blocklist of URLs; what a platform said about a downloaded video (credit line)
  `
  CREATE TABLE testers (
    tg_id INTEGER PRIMARY KEY,
    via TEXT NOT NULL CHECK (via IN ('auto','pending')),
    username TEXT,
    added_at TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by INTEGER
  );
  CREATE TABLE pending_vip (
    username TEXT PRIMARY KEY,
    added_by INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE rights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user INTEGER NOT NULL,
    url TEXT NOT NULL,
    url_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX rights_user_hash ON rights (user, url_hash);
  CREATE TABLE url_blocklist (
    url_hash TEXT PRIMARY KEY,
    url TEXT,
    job TEXT,
    reason TEXT,
    by INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE TABLE link_meta (
    url_hash TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    title TEXT,
    channel TEXT,
    license TEXT,
    created_at TEXT NOT NULL
  );
  `,
];

export interface TesterRow {
  tg_id: number;
  /** auto: a free slot on /start; pending: an @username the admin made VIP before they wrote */
  via: "auto" | "pending";
  username: string | null;
  added_at: string;
  revoked_at: string | null;
  revoked_by: number | null;
}

export interface LinkMetaRow {
  url_hash: string;
  url: string;
  title: string | null;
  channel: string | null;
  license: string | null;
  created_at: string;
}

export interface BlockedRow {
  url_hash: string;
  url: string | null;
  job: string | null;
  reason: string | null;
  by: number | null;
  created_at: string;
}

type Param = string | number | null;
const nowIso = () => new Date().toISOString();
const clean = (v: unknown): Param => (v === undefined || v === null ? null : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "number" || typeof v === "string" ? v : JSON.stringify(v));

export class BotDb {
  readonly file: string;
  private db: DatabaseSync;

  constructor(file: string) {
    this.file = file;
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  /** applied migration versions, oldest first */
  migrations(): number[] {
    return (this.db.prepare("SELECT version FROM migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(this.migrations());
    MIGRATIONS.forEach((sql, i) => {
      const version = i + 1;
      if (done.has(version)) return;
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO migrations (version, applied_at) VALUES (?, ?)").run(version, nowIso());
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    });
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }

  private get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  private all<T>(sql: string, ...params: Param[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  private run(sql: string, ...params: Param[]) {
    return this.db.prepare(sql).run(...params);
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── users ────────────────────────────────────────────────────────────────────

  getUser(id: number): UserRow | undefined {
    return this.get<UserRow>("SELECT * FROM users WHERE tg_id = ?", id);
  }

  /** the user, created on the first update; username / name / last_seen refreshed every time */
  touchUser(id: number, from: { username?: string; first_name?: string } = {}, init: Partial<UserRow> = {}): UserRow {
    const now = nowIso();
    const existing = this.getUser(id);
    if (!existing) {
      const row: UserRow = { tg_id: id, username: from.username ?? null, first_name: from.first_name ?? null, lang: "ru", onboarding: "lang", purpose: null, accepted_terms_at: null, created_at: now, last_seen: now, status: "active", role: "user", credits: 0, plan: "free", news: 1, ...init };
      const keys = Object.keys(row) as (keyof UserRow)[];
      this.run(`INSERT INTO users (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => clean(row[k])));
      return row;
    }
    this.run("UPDATE users SET username = COALESCE(?, username), first_name = COALESCE(?, first_name), last_seen = ? WHERE tg_id = ?", from.username ?? null, from.first_name ?? null, now, id);
    return { ...existing, username: from.username ?? existing.username, first_name: from.first_name ?? existing.first_name, last_seen: now };
  }

  updateUser(id: number, patch: Partial<Omit<UserRow, "tg_id">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE tg_id = ?`, ...keys.map((k) => clean(patch[k])), id);
  }

  /** adds (or with a negative n takes) credits; never below zero. Returns the new balance. */
  addCredits(id: number, n: number): number {
    this.run("UPDATE users SET credits = MAX(0, credits + ?) WHERE tg_id = ?", Math.round(n), id);
    return this.getUser(id)?.credits ?? 0;
  }

  /** "123", "@name" or "name" */
  findUser(query: string): UserRow | undefined {
    const q = query.trim().replace(/^@/, "");
    if (/^\d+$/.test(q)) return this.getUser(Number(q));
    return this.get<UserRow>("SELECT * FROM users WHERE lower(username) = lower(?)", q);
  }

  /** broadcast audience: active, registered, did not turn off news */
  broadcastAudience(): number[] {
    return this.all<{ tg_id: number }>("SELECT tg_id FROM users WHERE status = 'active' AND onboarding = 'done' AND news = 1 ORDER BY tg_id").map((r) => r.tg_id);
  }

  adminIds(): number[] {
    return this.all<{ tg_id: number }>("SELECT tg_id FROM users WHERE role = 'admin'").map((r) => r.tg_id);
  }

  // ── settings / sessions / kv ─────────────────────────────────────────────────

  getSettings(user: number): Record<string, string> {
    return Object.fromEntries(this.all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE user = ?", user).map((r) => [r.key, r.value]));
  }

  setSetting(user: number, key: string, value: string | undefined) {
    if (value === undefined) this.run("DELETE FROM settings WHERE user = ? AND key = ?", user, key);
    else this.run("INSERT INTO settings (user, key, value) VALUES (?, ?, ?) ON CONFLICT (user, key) DO UPDATE SET value = excluded.value", user, key, value);
  }

  getSession<T>(user: number): T | undefined {
    const r = this.get<{ data: string }>("SELECT data FROM sessions WHERE user = ?", user);
    return r ? (JSON.parse(r.data) as T) : undefined;
  }

  setSession(user: number, data: unknown) {
    this.run("INSERT INTO sessions (user, data, updated_at) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at", user, JSON.stringify(data), nowIso());
  }

  allSessions<T>(): { user: number; data: T }[] {
    return this.all<{ user: number; data: string }>("SELECT user, data FROM sessions").map((r) => ({ user: r.user, data: JSON.parse(r.data) as T }));
  }

  /** sessions changed since the ISO time (restart recovery) */
  sessionsSince<T>(sinceIso: string): { user: number; data: T }[] {
    return this.all<{ user: number; data: string }>("SELECT user, data FROM sessions WHERE updated_at >= ?", sinceIso).map((r) => ({ user: r.user, data: JSON.parse(r.data) as T }));
  }

  getKv(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value;
  }

  setKv(key: string, value: string | undefined) {
    if (value === undefined) this.run("DELETE FROM kv WHERE key = ?", key);
    else this.run("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** the free plan: env/defaults with the admin's live overrides (kv plan.free.<key>) on top */
  planLimits(base: PlanLimits): PlanLimits {
    const out = { ...base };
    for (const f of FREE_PLAN_FIELDS) {
      const v = this.getKv(`plan.free.${f.key}`);
      if (v !== undefined && Number.isFinite(Number(v))) out[f.key] = Number(v);
    }
    return out;
  }

  // ── jobs & usage ─────────────────────────────────────────────────────────────

  insertJob(row: Pick<JobRow, "id" | "user" | "chat_id" | "kind" | "class" | "payload"> & Partial<JobRow>): JobRow {
    const full: JobRow = { status: "queued", stage: null, percent: null, status_msg_id: null, result_msg_id: null, vedit_job: null, paid_credits: 0, cost_usd: null, rating: null, error: null, created_at: nowIso(), started_at: null, finished_at: null, purged: 0, ...row };
    const keys = Object.keys(full) as (keyof JobRow)[];
    this.run(`INSERT INTO jobs (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => clean(full[k])));
    return full;
  }

  getJob(id: string): JobRow | undefined {
    return this.get<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
  }

  updateJob(id: string, patch: Partial<Omit<JobRow, "id">>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.run(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`, ...keys.map((k) => clean(patch[k])), id);
  }

  jobsByStatus(...statuses: JobStatus[]): JobRow[] {
    return this.all<JobRow>(`SELECT * FROM jobs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY created_at, rowid`, ...statuses);
  }

  /** jobs of a user that count against the free daily limit: since `sinceIso`, not refunded (failed/cancelled), not paid with credits */
  countFreeJobs(user: number, cls: JobClass, sinceIso: string): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE user = ? AND class = ? AND created_at >= ? AND paid_credits = 0 AND status IN ('queued','running','done')", user, cls, sinceIso)?.n ?? 0;
  }

  /** jobs a user started since the quota day began (free or paid; failed and cancelled ones do not count) */
  countJobs(user: number, sinceIso: string): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE user = ? AND created_at >= ? AND class != 'light' AND status IN ('queued','running','done')", user, sinceIso)?.n ?? 0;
  }

  /** API spend recorded since (cost.json of finished and failed jobs), $ */
  costSince(sinceIso: string): number {
    return this.get<{ c: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE created_at >= ?", sinceIso)?.c ?? 0;
  }

  lastJob(user: number): JobRow | undefined {
    return this.get<JobRow>("SELECT * FROM jobs WHERE user = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", user);
  }

  /** finished jobs whose files the retention cleanup has not deleted yet */
  jobsToPurge(beforeIso: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE purged = 0 AND status IN ('done','failed','cancelled') AND COALESCE(finished_at, created_at) < ?", beforeIso);
  }

  /** every bot job working on one pipeline job (a montage and its revisions, an avatar bundle and its montage) */
  jobsByVedit(veditJob: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE vedit_job = ?", veditJob);
  }

  addUsage(row: { user: number; kind: string; units: number; cost_usd: number; job_id?: string }) {
    this.run("INSERT INTO usage (user, kind, units, cost_usd, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)", row.user, row.kind, row.units, row.cost_usd, row.job_id ?? null, nowIso());
  }

  userTotals(user: number): { jobs: number; done: number; failed: number; cost: number; credits_spent: number } {
    const j = this.get<{ jobs: number; done: number; failed: number }>("SELECT COUNT(*) AS jobs, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed FROM jobs WHERE user = ?", user)!;
    const u = this.get<{ cost: number; credits: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(SUM(CASE WHEN kind LIKE 'credits%' THEN units ELSE 0 END), 0) AS credits FROM usage WHERE user = ?", user)!;
    return { jobs: j.jobs ?? 0, done: j.done ?? 0, failed: j.failed ?? 0, cost: u.cost ?? 0, credits_spent: u.credits ?? 0 };
  }

  stats(todayIso: string, weekIso: string) {
    const users = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users")!.n;
    const usersToday = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE created_at >= ?", todayIso)!.n;
    const activeToday = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE last_seen >= ?", todayIso)!.n;
    const banned = this.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE status = 'banned'")!.n;
    const byStatus = this.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY status ORDER BY status", weekIso);
    const byKind = this.all<{ kind: string; n: number }>("SELECT kind, COUNT(*) AS n FROM jobs WHERE created_at >= ? GROUP BY kind ORDER BY n DESC", weekIso);
    const cost = (since: string) => this.get<{ c: number }>("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE created_at >= ?", since)!.c;
    const ratings = this.get<{ avg: number | null; n: number }>("SELECT AVG(rating) AS avg, COUNT(rating) AS n FROM jobs WHERE rating IS NOT NULL")!;
    return { users, usersToday, activeToday, banned, byStatus, byKind, costToday: cost(todayIso), cost7d: cost(weekIso), ratingAvg: ratings.avg, ratings: ratings.n };
  }

  // ── long callback payloads ───────────────────────────────────────────────────

  putCallback(data: string): number {
    return Number(this.run("INSERT INTO callbacks (data, created_at) VALUES (?, ?)", data, nowIso()).lastInsertRowid);
  }

  getCallback(id: number): string | undefined {
    return this.get<{ data: string }>("SELECT data FROM callbacks WHERE id = ?", id)?.data;
  }

  pruneCallbacks(beforeIso: string) {
    this.run("DELETE FROM callbacks WHERE created_at < ?", beforeIso);
  }

  // ── reference styles (stage 22) ──────────────────────────────────────────────

  /** content key of a reference known by this alias ("tg:<file_unique_id>", "url:<canonical>") */
  styleKey(alias: string): string | undefined {
    return this.get<{ key: string }>("SELECT key FROM style_cache WHERE alias = ?", alias)?.key;
  }

  putStyleKey(alias: string, key: string, summary?: string) {
    this.run("INSERT INTO style_cache (alias, key, summary, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(alias) DO UPDATE SET key = excluded.key, summary = excluded.summary", alias, key, summary ?? null, nowIso());
  }

  // ── allowlist (closed beta without editing .env) ─────────────────────────────

  allow(id: number, by?: number) {
    this.run("INSERT INTO allowlist (tg_id, added_by, created_at) VALUES (?, ?, ?) ON CONFLICT(tg_id) DO NOTHING", id, by ?? null, nowIso());
  }

  disallow(id: number) {
    this.run("DELETE FROM allowlist WHERE tg_id = ?", id);
  }

  isAllowed(id: number): boolean {
    return !!this.get<{ tg_id: number }>("SELECT tg_id FROM allowlist WHERE tg_id = ?", id);
  }

  allowedIds(): number[] {
    return this.all<{ tg_id: number }>("SELECT tg_id FROM allowlist ORDER BY tg_id").map((r) => r.tg_id);
  }

  // ── stage 30: testers (auto slots, pending @usernames) ───────────────────────

  getTester(id: number): TesterRow | undefined {
    return this.get<TesterRow>("SELECT * FROM testers WHERE tg_id = ?", id);
  }

  addTester(id: number, via: TesterRow["via"], username?: string | null) {
    this.run("INSERT INTO testers (tg_id, via, username, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(tg_id) DO UPDATE SET via = excluded.via, username = excluded.username, added_at = excluded.added_at, revoked_at = NULL, revoked_by = NULL", id, via, username ?? null, nowIso());
  }

  revokeTester(id: number, by?: number) {
    this.run("UPDATE testers SET revoked_at = ?, revoked_by = ? WHERE tg_id = ? AND revoked_at IS NULL", nowIso(), by ?? null, id);
  }

  /** auto slots in use: testers let in by a free slot and not revoked (pending @usernames do not take one) */
  testerSlotsUsed(): number {
    return this.get<{ n: number }>("SELECT COUNT(*) AS n FROM testers WHERE via = 'auto' AND revoked_at IS NULL")?.n ?? 0;
  }

  activeTesters(): TesterRow[] {
    return this.all<TesterRow>("SELECT * FROM testers WHERE revoked_at IS NULL ORDER BY added_at");
  }

  addPendingVip(username: string, by?: number) {
    this.run("INSERT INTO pending_vip (username, added_by, created_at) VALUES (lower(?), ?, ?) ON CONFLICT(username) DO NOTHING", username.replace(/^@/, ""), by ?? null, nowIso());
  }

  /** true when there was such a pending username */
  removePendingVip(username: string): boolean {
    return Number(this.run("DELETE FROM pending_vip WHERE username = lower(?)", username.replace(/^@/, "")).changes) > 0;
  }

  hasPendingVip(username: string): boolean {
    return !!this.get<{ username: string }>("SELECT username FROM pending_vip WHERE username = lower(?)", username.replace(/^@/, ""));
  }

  pendingVips(): string[] {
    return this.all<{ username: string }>("SELECT username FROM pending_vip ORDER BY created_at").map((r) => r.username);
  }

  // ── stage 30: compliance (rights confirmations, takedown blocklist, link credits) ──

  confirmRights(user: number, url: string, urlHash: string) {
    this.run("INSERT INTO rights (user, url, url_hash, created_at) VALUES (?, ?, ?, ?)", user, url, urlHash, nowIso());
  }

  hasRights(user: number, urlHash: string): boolean {
    return !!this.get<{ id: number }>("SELECT id FROM rights WHERE user = ? AND url_hash = ? LIMIT 1", user, urlHash);
  }

  rightsOf(user: number): { url: string; url_hash: string; created_at: string }[] {
    return this.all("SELECT url, url_hash, created_at FROM rights WHERE user = ? ORDER BY id", user);
  }

  blockUrl(row: { url_hash: string; url?: string | null; job?: string | null; reason?: string | null; by?: number | null }) {
    this.run("INSERT INTO url_blocklist (url_hash, url, job, reason, by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url_hash) DO UPDATE SET job = COALESCE(excluded.job, job), reason = COALESCE(excluded.reason, reason)", row.url_hash, row.url ?? null, row.job ?? null, row.reason ?? null, row.by ?? null, nowIso());
  }

  isBlocked(urlHash: string): boolean {
    return !!this.get<{ url_hash: string }>("SELECT url_hash FROM url_blocklist WHERE url_hash = ?", urlHash);
  }

  blockedUrls(): BlockedRow[] {
    return this.all<BlockedRow>("SELECT * FROM url_blocklist ORDER BY created_at DESC");
  }

  putLinkMeta(row: { url_hash: string; url: string; title?: string | null; channel?: string | null; license?: string | null }) {
    this.run("INSERT INTO link_meta (url_hash, url, title, channel, license, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url_hash) DO UPDATE SET title = COALESCE(excluded.title, title), channel = COALESCE(excluded.channel, channel), license = COALESCE(excluded.license, license)", row.url_hash, row.url, row.title ?? null, row.channel ?? null, row.license ?? null, nowIso());
  }

  /** jobs made from a link (its hash is in the payload's `links`) */
  jobsByLink(urlHash: string): JobRow[] {
    return this.all<JobRow>("SELECT * FROM jobs WHERE instr(payload, ?) > 0 ORDER BY created_at", `"hash":"${urlHash}"`);
  }

  linkMeta(urlHash: string): LinkMetaRow | undefined {
    return this.get<LinkMetaRow>("SELECT * FROM link_meta WHERE url_hash = ?", urlHash);
  }

  // ── stage 28: outputs, feedback, self-review ─────────────────────────────────

  putOutputs(job: string, outputs: { id: string; file: string; duration?: number; aspect?: string }[]) {
    for (const o of outputs) this.run("INSERT INTO outputs (job, output_id, file, duration, aspect, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(job, output_id) DO UPDATE SET file = excluded.file, duration = excluded.duration, aspect = excluded.aspect", job, o.id, o.file, o.duration ?? null, o.aspect ?? null, nowIso());
  }

  outputsOf(job: string): OutputRow[] {
    return this.all<OutputRow>("SELECT * FROM outputs WHERE job = ? ORDER BY rowid", job);
  }

  getFeedback(job: string, outputId: string, user: number): FeedbackRow | undefined {
    return this.get<FeedbackRow>("SELECT * FROM feedback WHERE job = ? AND output_id = ? AND user = ?", job, outputId, user);
  }

  /** creates or edits the record; fields not given keep their value */
  upsertFeedback(row: Pick<FeedbackRow, "job" | "output_id" | "user" | "stars"> & Partial<Omit<FeedbackRow, "job" | "output_id" | "user" | "created_at" | "updated_at">>): FeedbackRow {
    const now = nowIso();
    const old = this.getFeedback(row.job, row.output_id, row.user);
    const full: FeedbackRow = { reasons: "[]", comment: null, comment_kind: null, kind: null, preset: null, voice: null, aspect: null, duration: null, cost_usd: null, acked: 0, created_at: now, ...old, ...row, updated_at: now };
    const keys = Object.keys(full) as (keyof FeedbackRow)[];
    this.run(
      `INSERT INTO feedback (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")}) ON CONFLICT(job, output_id, user) DO UPDATE SET ${keys.filter((k) => !["job", "output_id", "user", "created_at"].includes(k)).map((k) => `${k} = excluded.${k}`).join(", ")}`,
      ...keys.map((k) => clean(full[k])),
    );
    return full;
  }

  feedbackOf(job: string): FeedbackRow[] {
    return this.all<FeedbackRow>("SELECT * FROM feedback WHERE job = ? ORDER BY updated_at", job);
  }

  /** feedback updated since (all when undefined), newest first */
  feedbackSince(sinceIso?: string): FeedbackRow[] {
    return sinceIso ? this.all<FeedbackRow>("SELECT * FROM feedback WHERE updated_at >= ? ORDER BY updated_at DESC", sinceIso) : this.all<FeedbackRow>("SELECT * FROM feedback ORDER BY updated_at DESC");
  }

  putSelfReview(row: Pick<SelfReviewRow, "job" | "output_id" | "status"> & Partial<SelfReviewRow>) {
    const full: SelfReviewRow = { hash: null, scores: null, overall: null, fixes: "[]", summary: null, confidence: null, model: null, cost_usd: 0, error: null, created_at: nowIso(), ...row };
    const keys = Object.keys(full) as (keyof SelfReviewRow)[];
    this.run(`INSERT OR REPLACE INTO self_review (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, ...keys.map((k) => clean(full[k])));
  }

  selfReviewsOf(job: string): SelfReviewRow[] {
    return this.all<SelfReviewRow>("SELECT * FROM self_review WHERE job = ? ORDER BY rowid", job);
  }

  /** a finished review of the same file (content hash) from any job */
  selfReviewByHash(hash: string): SelfReviewRow | undefined {
    return this.get<SelfReviewRow>("SELECT * FROM self_review WHERE hash = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 1", hash);
  }

  selfReviewsSince(sinceIso?: string): SelfReviewRow[] {
    return sinceIso ? this.all<SelfReviewRow>("SELECT * FROM self_review WHERE created_at >= ? ORDER BY created_at DESC", sinceIso) : this.all<SelfReviewRow>("SELECT * FROM self_review ORDER BY created_at DESC");
  }
}
