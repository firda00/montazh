// Retention cleanup (VEDIT_RETENTION_DAYS, default 7): runs daily from the bot. Deletes users' uploads
// (workspace/users/<tg_id>/…) older than the cutoff and the job folders (workspace/<job>) of bot jobs that
// finished before it. Only paths inside the workspace with the expected shape are ever removed.
import fs from "node:fs/promises";
import path from "node:path";
import type { BotDb } from "./db.ts";

export interface RetentionReport {
  files: number;
  bytes: number;
  jobs: number;
  errors: string[];
}

const JOB_DIR = /^\d{8}-[0-9a-f]+$/;

async function sweep(dir: string, cutoffMs: number, r: RetentionReport): Promise<boolean> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  let empty = true;
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) {
        const nowEmpty = await sweep(p, cutoffMs, r);
        if (nowEmpty) await fs.rmdir(p).catch(() => (empty = false));
        else empty = false;
        continue;
      }
      const st = await fs.stat(p);
      if (st.mtimeMs < cutoffMs) {
        await fs.rm(p, { force: true });
        r.files++;
        r.bytes += st.size;
      } else empty = false;
    } catch (err) {
      empty = false;
      r.errors.push(`${p}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return empty;
}

/**
 * @param usersDir  workspace/users
 * @param jobsRoot  the pipeline workspace (WORKSPACE_ROOT), where workspace/<job> folders live
 */
export async function runRetention(o: { db: BotDb; usersDir: string; jobsRoot: string; days: number; now?: number }): Promise<RetentionReport> {
  const now = o.now ?? Date.now();
  const cutoffMs = now - o.days * 86_400_000;
  const r: RetentionReport = { files: 0, bytes: 0, jobs: 0, errors: [] };
  let users: string[] = [];
  try {
    users = (await fs.readdir(o.usersDir)).filter((n) => /^\d+$/.test(n));
  } catch {}
  for (const u of users) await sweep(path.join(o.usersDir, u), cutoffMs, r);
  const root = path.resolve(o.jobsRoot);
  for (const job of o.db.jobsToPurge(new Date(cutoffMs).toISOString())) {
    const cutoffIso = new Date(cutoffMs).toISOString();
    // the folder is shared with later revisions of the same job: keep it while any of them is recent or active
    const shared = job.vedit_job ? o.db.jobsByVedit(job.vedit_job).filter((j) => j.id !== job.id) : [];
    if (shared.some((j) => j.status === "queued" || j.status === "running" || (j.finished_at ?? j.created_at) >= cutoffIso)) continue;
    if (job.vedit_job && JOB_DIR.test(job.vedit_job)) {
      const dir = path.join(root, job.vedit_job);
      if (path.dirname(dir) === root) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
          r.jobs++;
        } catch (err) {
          r.errors.push(`${dir}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
      }
    }
    o.db.updateJob(job.id, { purged: 1 });
  }
  o.db.pruneCallbacks(new Date(now - 30 * 86_400_000).toISOString());
  return r;
}
