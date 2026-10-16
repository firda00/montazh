// Global job queue: at most `maxJobs` pipelines at once (VEDIT_MAX_JOBS), per user at most 1 running and
// `perUserQueued` waiting. Fair order: round-robin across users — the k-th waiting job of every user goes
// before anyone's (k+1)-th, and among those the user served least recently goes first, so one user with a
// stack of jobs never blocks the others. The queue only schedules; the bot persists job rows (status in
// SQLite) and re-enqueues waiting jobs after a restart.
import { PER_USER_QUEUED, PER_USER_RUNNING } from "./plans.ts";

export type JobOutcome = "done" | "failed" | "cancelled";

export interface QueueOptions {
  maxJobs: number;
  perUserQueued?: number;
  /** runs a job; must resolve (errors are the runner's business) — rejections count as "failed" */
  run: (jobId: string, signal: AbortSignal) => Promise<JobOutcome>;
  /** positions changed (a job started, finished, was added or cancelled) */
  onChange?: () => void;
  /** a cancelled job that ignores its signal frees the slot after this long, ms (default 60 s) */
  cancelGraceMs?: number;
  log?: (line: string) => void;
}

interface Waiting {
  id: string;
  user: number;
  seq: number;
}
interface Active {
  user: number;
  ac: AbortController;
  done: Promise<JobOutcome>;
}

export class JobQueue {
  maxJobs: number;
  private readonly perUserQueued: number;
  private readonly waiting: Waiting[] = [];
  private readonly active = new Map<string, Active>();
  /** user → turn number of their last start (round-robin) */
  private readonly lastStart = new Map<number, number>();
  private seq = 0;
  private turns = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly o: QueueOptions) {
    this.maxJobs = Math.max(1, o.maxJobs);
    this.perUserQueued = o.perUserQueued ?? PER_USER_QUEUED;
  }

  /** room for one more waiting job of this user */
  canEnqueue(user: number): boolean {
    return this.waiting.filter((w) => w.user === user).length < this.perUserQueued;
  }

  /** adds a job; returns its 1-based position in the queue, or 0 when it started right away */
  enqueue(id: string, user: number): number {
    if (this.has(id)) return this.position(id);
    this.waiting.push({ id, user, seq: ++this.seq });
    this.pump();
    this.o.onChange?.();
    return this.position(id);
  }

  has(id: string): boolean {
    return this.active.has(id) || this.waiting.some((w) => w.id === id);
  }

  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  /** the fair order in which waiting jobs will start */
  order(): Waiting[] {
    const rank = new Map<string, number>();
    const perUser = new Map<number, number>();
    for (const w of [...this.waiting].sort((a, b) => a.seq - b.seq)) {
      const k = perUser.get(w.user) ?? 0;
      rank.set(w.id, k);
      perUser.set(w.user, k + 1);
    }
    // a user with a running job effectively waits behind everyone in the same round
    const turn = (u: number) => (this.runningUsers().has(u) ? Number.MAX_SAFE_INTEGER / 2 + (this.lastStart.get(u) ?? 0) : (this.lastStart.get(u) ?? -1));
    return [...this.waiting].sort((a, b) => rank.get(a.id)! - rank.get(b.id)! || turn(a.user) - turn(b.user) || a.seq - b.seq);
  }

  /** 1-based place among waiting jobs; 0 = running; -1 = unknown */
  position(id: string): number {
    if (this.active.has(id)) return 0;
    const i = this.order().findIndex((w) => w.id === id);
    return i < 0 ? -1 : i + 1;
  }

  /** ids of a user's jobs: running first, then waiting in start order */
  jobsOf(user: number): { running: string[]; waiting: string[] } {
    return {
      running: [...this.active.entries()].filter(([, a]) => a.user === user).map(([id]) => id),
      waiting: this.order().filter((w) => w.user === user).map((w) => w.id),
    };
  }

  counts(): { running: number; waiting: number } {
    return { running: this.active.size, waiting: this.waiting.length };
  }

  /** "queued": removed before it started; "running": abort signalled (the runner reports "cancelled"); null: unknown */
  cancel(id: string): "queued" | "running" | null {
    const i = this.waiting.findIndex((w) => w.id === id);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      this.o.onChange?.();
      this.checkIdle();
      return "queued";
    }
    const a = this.active.get(id);
    if (!a) return null;
    if (!a.ac.signal.aborted) {
      a.ac.abort();
      // a job that ignores the signal still frees its slot after the grace period
      const t = setTimeout(() => {
        if (this.active.get(id) === a) {
          this.o.log?.(`⚠ задача ${id} не остановилась за ${(this.o.cancelGraceMs ?? 60_000) / 1000} с после отмены — освобождаю слот`);
          this.active.delete(id);
          this.pump();
          this.o.onChange?.();
          this.checkIdle();
        }
      }, this.o.cancelGraceMs ?? 60_000);
      t.unref?.();
    }
    return "running";
  }

  isAborted(id: string): boolean {
    return this.active.get(id)?.ac.signal.aborted ?? false;
  }

  /** resolves when nothing is running or waiting */
  idle(): Promise<void> {
    if (!this.active.size && !this.waiting.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private runningUsers(): Set<number> {
    const counts = new Map<number, number>();
    for (const a of this.active.values()) counts.set(a.user, (counts.get(a.user) ?? 0) + 1);
    return new Set([...counts.entries()].filter(([, n]) => n >= PER_USER_RUNNING).map(([u]) => u));
  }

  private pump() {
    while (this.active.size < this.maxJobs) {
      const busy = this.runningUsers();
      const next = this.order().find((w) => !busy.has(w.user));
      if (!next) break;
      this.waiting.splice(this.waiting.indexOf(next), 1);
      this.start(next);
    }
  }

  private start(w: Waiting) {
    const ac = new AbortController();
    this.lastStart.set(w.user, ++this.turns);
    const entry: Active = { user: w.user, ac, done: Promise.resolve<JobOutcome>("failed") };
    this.active.set(w.id, entry);
    entry.done = (async () => {
      try {
        return await this.o.run(w.id, ac.signal);
      } catch (err) {
        this.o.log?.(`⚠ задача ${w.id}: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        return "failed" as const;
      }
    })();
    void entry.done.then(() => {
      if (this.active.get(w.id) === entry) this.active.delete(w.id);
      this.pump();
      this.o.onChange?.();
      this.checkIdle();
    });
  }

  private checkIdle() {
    if (this.active.size || this.waiting.length) return;
    const ws = this.idleWaiters;
    this.idleWaiters = [];
    for (const r of ws) r();
  }
}
