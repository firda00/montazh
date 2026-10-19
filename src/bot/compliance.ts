// Stage 30 — compliance, not evasion. What the bot does about other people's content:
//   • a link to a platform (YouTube, TikTok, Instagram, VK…) is processed only after the user confirms they have the
//     rights or use it for review / quotation / learning; the confirmation is stored (user, url, time);
//   • results made from such a link carry a visible credit line (title / channel / link);
//   • dubbing is labelled «Неофициальный перевод»; no cloning of a third party's voice;
//   • yt-dlp fetches public content only (no cookies, no login) — see src/ingest/links.ts;
//   • /takedown <job|url> (admins) deletes the files of a job and blocks the URL: it is never downloaded again.
// Nothing here removes watermarks or bypasses DRM, and nothing should.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalUrl } from "../style/cache.ts";
import { classifyLink } from "../ingest/links.ts";
import type { BotDb, JobRow, LinkMetaRow } from "./db.ts";

/** canonical form of a link (the same video by any of its URLs → one hash) */
export function canonicalLink(url: string): string {
  const c = canonicalUrl(url) ?? url.trim();
  // youtube.com/shorts/<id> and youtube.com/watch?v=<id> are the same video
  return c.replace(/^youtube:shorts:/, "youtube:");
}

export const urlHash = (url: string) => createHash("sha1").update(canonicalLink(url)).digest("hex").slice(0, 20);

/**
 * A link that is not obviously the user's own: a video platform. Cloud storage (Google Drive, Yandex Disk, Dropbox)
 * and direct file links are where people keep their own footage.
 */
export const needsRights = (url: string) => classifyLink(url)?.kind === "platform";

/** "📎 Источник: «title» — channel · url" (the url alone when the platform said nothing) */
export function creditLine(meta: Pick<LinkMetaRow, "url"> & Partial<Pick<LinkMetaRow, "title" | "channel" | "license">>, prefix: string): string {
  const parts = [meta.title ? `«${meta.title}»` : null, meta.channel ?? null].filter(Boolean).join(" — ");
  return `📎 ${prefix}: ${parts ? `${parts} · ` : ""}${meta.url}${meta.license ? ` (${meta.license})` : ""}`;
}

export interface TakedownReport {
  /** bot jobs found for the target */
  jobs: string[];
  /** files and folders removed */
  removed: string[];
  /** URL hashes blocked */
  blocked: string[];
  errors: string[];
}

const JOB_DIR = /^\d{8}-[0-9a-f]+$/;

/**
 * /takedown: a bot job id (j…), a pipeline job id (20261019-abcdef) or a URL. Deletes the pipeline job folder, the
 * user's uploads the job was made from, the delivered outputs; marks the jobs purged; blocks every source URL.
 * Only paths inside the workspace with the expected shape are removed.
 */
export async function takedown(o: { db: BotDb; target: string; jobsRoot: string; usersDir: string; by: number; reason?: string }): Promise<TakedownReport> {
  const r: TakedownReport = { jobs: [], removed: [], blocked: [], errors: [] };
  const target = o.target.trim();
  const isUrl = /^https?:\/\//i.test(target);
  const jobs: JobRow[] = [];
  if (isUrl) {
    const h = urlHash(target);
    o.db.blockUrl({ url_hash: h, url: target, reason: o.reason ?? "takedown", by: o.by });
    r.blocked.push(h);
    for (const j of o.db.jobsByLink(h)) jobs.push(j);
  } else {
    const bot = o.db.getJob(target);
    if (bot) jobs.push(bot);
    for (const j of o.db.jobsByVedit(target)) if (!jobs.some((x) => x.id === j.id)) jobs.push(j);
    // the revisions and dubs of the same pipeline job go too
    for (const j of [...jobs]) if (j.vedit_job) for (const k of o.db.jobsByVedit(j.vedit_job)) if (!jobs.some((x) => x.id === k.id)) jobs.push(k);
  }
  const root = path.resolve(o.jobsRoot);
  const users = path.resolve(o.usersDir);
  const rm = async (p: string, inside: string) => {
    const abs = path.resolve(p);
    if (!abs.startsWith(inside + path.sep)) return;
    try {
      await fs.rm(abs, { recursive: true, force: true });
      r.removed.push(abs);
    } catch (err) {
      r.errors.push(`${abs}: ${err instanceof Error ? err.message : err}`);
    }
  };
  const veditJobs = new Set<string>();
  if (!isUrl && JOB_DIR.test(target)) veditJobs.add(target);
  for (const j of jobs) {
    r.jobs.push(j.id);
    if (j.vedit_job && JOB_DIR.test(j.vedit_job)) veditJobs.add(j.vedit_job);
    let p: Record<string, unknown> = {};
    try {
      p = JSON.parse(j.payload) as Record<string, unknown>;
    } catch {}
    // the user's source files (uploads, downloaded links) and the links behind them
    const files = [p.source, ...(Array.isArray(p.sources) ? p.sources : [])].filter((x): x is string => typeof x === "string");
    for (const f of files) await rm(f, users);
    for (const l of Array.isArray(p.links) ? (p.links as { url?: string; hash?: string }[]) : []) {
      const h = l.hash ?? (l.url ? urlHash(l.url) : undefined);
      if (!h || r.blocked.includes(h)) continue;
      o.db.blockUrl({ url_hash: h, url: l.url ?? null, job: j.id, reason: o.reason ?? "takedown", by: o.by });
      r.blocked.push(h);
    }
    o.db.updateJob(j.id, { purged: 1 });
  }
  for (const v of veditJobs) await rm(path.join(root, v), root);
  return r;
}
