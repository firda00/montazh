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
export type JobKind = "run" | "make" | "revise" | "avatar" | "avatar_import";
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
];

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
}
