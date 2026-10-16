import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { exists, readJson, WORKSPACE_ROOT, writeJson } from "../lib/workspace.ts";
import { StyleProfileSchema, type StyleProfile } from "./profile.ts";

/**
 * Style DNA cache (stage 22): one analysis per reference, ever. The content key is sha256 over the file size and
 * its first and last 512 KB (fast on big files, robust to re-uploads); aliases point at it from a Telegram
 * file_unique_id ("tg:<id>") or a canonical link ("instagram:reel:<id>", "tiktok:<id>", "youtube:shorts:<id>"),
 * so a repeated link or forwarded file is a hit without downloading anything. A hit costs $0 and is instant.
 *   workspace/_cache/style/<key>.json   the profile (DNA + measurements + provenance)
 *   workspace/_cache/style/aliases.json alias → key
 */

export const STYLE_CACHE_DIR = path.join(WORKSPACE_ROOT, "_cache", "style");
const EDGE = 512 * 1024;

/** sha256(size ‖ first 512 KB ‖ last 512 KB), hex */
export async function contentKey(file: string): Promise<string> {
  const fh = await fs.open(file, "r");
  try {
    const { size } = await fh.stat();
    const h = createHash("sha256").update(`${size}\0`);
    const head = Buffer.alloc(Math.min(EDGE, size));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (size > EDGE) {
      const n = Math.min(EDGE, size - EDGE);
      const tail = Buffer.alloc(n);
      await fh.read(tail, 0, n, size - n);
      h.update(tail);
    }
    return h.digest("hex");
  } finally {
    await fh.close();
  }
}

/** query parameters that only track the click (dropped from canonical URLs) */
const TRACKING = /^(utm_\w+|igsh|igshid|si|feature|fbclid|gclid|ref|ref_src|ref_url|_r|_t|is_from_webapp|sender_device|share_\w+|s|t|pp|lang|app|ab_channel)$/i;

/**
 * A stable id for a reel link: instagram:reel:<code>, tiktok:<id> (tiktok:short:<code> for vm./vt. short links,
 * which cannot be expanded offline), youtube:shorts:<id> / youtube:<id>; anything else: host + path + the
 * non-tracking query, lower-case host, no "www.", no fragment, no trailing slash. null if it is not a URL.
 */
export function canonicalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
  const parts = u.pathname.split("/").filter(Boolean);
  if (host === "instagram.com" || host === "instagr.am") {
    const i = parts.findIndex((p) => p === "reel" || p === "reels" || p === "p" || p === "tv");
    if (i >= 0 && parts[i + 1]) return `instagram:reel:${parts[i + 1]}`;
  }
  if (host.endsWith("tiktok.com")) {
    const i = parts.indexOf("video");
    if (i >= 0 && /^\d+$/.test(parts[i + 1] ?? "")) return `tiktok:${parts[i + 1]}`;
    if ((host === "vm.tiktok.com" || host === "vt.tiktok.com") && parts[0]) return `tiktok:short:${parts[0]}`;
    if (parts[0] === "t" && parts[1]) return `tiktok:short:${parts[1]}`;
  }
  if (host === "youtube.com" || host === "music.youtube.com") {
    if (parts[0] === "shorts" && parts[1]) return `youtube:shorts:${parts[1]}`;
    const v = u.searchParams.get("v");
    if (v) return `youtube:${v}`;
  }
  if (host === "youtu.be" && parts[0]) return `youtube:${parts[0]}`;
  const q = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const qs = q.length ? `?${q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&")}` : "";
  return `${host}/${parts.join("/")}${qs}`;
}

/** The first http(s) link in a message, or null. */
export function findUrl(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/i.exec(text);
  return m ? m[0].replace(/[).,!?»"']+$/, "") : null;
}

export const tgAlias = (fileUniqueId: string) => `tg:${fileUniqueId}`;

export class StyleCache {
  constructor(readonly dir = STYLE_CACHE_DIR) {}

  private get aliasFile() {
    return path.join(this.dir, "aliases.json");
  }
  file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }

  async aliases(): Promise<Record<string, string>> {
    try {
      return JSON.parse(await fs.readFile(this.aliasFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async get(key: string): Promise<StyleProfile | null> {
    const f = this.file(key);
    if (!(await exists(f))) return null;
    try {
      return await readJson(f, StyleProfileSchema);
    } catch {
      return null; // a broken cache entry is a miss, not an error
    }
  }

  async byAlias(alias: string): Promise<StyleProfile | null> {
    const key = (await this.aliases())[alias];
    return key ? this.get(key) : null;
  }

  async put(profile: StyleProfile, aliases: string[] = []): Promise<string> {
    await fs.mkdir(this.dir, { recursive: true });
    await writeJson(this.file(profile.key), StyleProfileSchema, profile);
    if (aliases.length) await this.alias(profile.key, aliases);
    return this.file(profile.key);
  }

  async alias(key: string, aliases: string[]): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const all = await this.aliases();
    for (const a of aliases) all[a] = key;
    const tmp = `${this.aliasFile}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(all, null, 1));
    await fs.rename(tmp, this.aliasFile);
  }
}
