import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import type { Frame } from "../lib/aspect.ts";
import { PHOTO_CACHE } from "./photos.ts";
import { hashOf } from "./visuals.ts";

/**
 * Real photos OF a named entity from Wikimedia Commons (stage 26): the MediaWiki API, files namespace (6) searched with
 * the exact entity name («Nasdaq MarketSite», «Dario Amodei»), imageinfo with extmetadata for the licence and author.
 * Allowed: CC0, public domain, CC BY, CC BY-SA (any version). CC BY-SA asks for attribution AND that the adapted
 * picture (our crop / Ken Burns frames of it) stays under the same licence — fine for showing it with a credit, recorded
 * in credits.json. Not allowed: NC / ND, GFDL-only, fair use, no licence. Only raster photos (JPEG/WebP/TIFF): SVG/PNG
 * logos, PDFs, maps and diagrams are not photos. The file title must name the entity (a search hit on the description
 * alone is usually something else). The download is a standard-width thumbnail just big enough for the frame.
 */

export const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
/** Wikimedia asks API clients to identify themselves */
export const COMMONS_UA = "vedit/1.0 (video maker; https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia)";
/** thumbnail widths Wikimedia serves without re-rendering (2025 standard sizes) */
export const THUMB_WIDTHS = [330, 500, 960, 1280, 1920, 3840] as const;

export interface CommonsFile {
  pageid: number;
  title: string;
  /** search rank (1 = best) */
  index: number;
  url: string;
  descriptionUrl: string;
  width: number;
  height: number;
  mime: string;
  license: "cc0" | "pd" | "by" | "by-sa";
  license_version: string;
  license_short: string;
  license_url: string;
  artist: string;
  description: string;
}

const stripHtml = (s: string) =>
  (s ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The licence of a Commons file from its extmetadata (License / LicenseShortName), or null when it is not allowed.
 * «cc-by-sa-4.0» → by-sa 4.0; «pd» / «Public domain» → pd; «cc0» → cc0. NC, ND, GFDL-only, fair use → null.
 */
export function commonsLicense(meta: Record<string, { value?: unknown } | undefined>): { license: CommonsFile["license"]; version: string; short: string; url: string } | null {
  const lic = String(meta.License?.value ?? "").toLowerCase().trim();
  const short = stripHtml(String(meta.LicenseShortName?.value ?? ""));
  const url = String(meta.LicenseUrl?.value ?? "");
  const s = `${lic} ${short.toLowerCase()}`;
  if (/\bnc\b|-nc-|noncommercial|\bnd\b|-nd-|noderiv|fair use|non-free|all rights reserved/.test(s)) return null;
  if (/^cc0|\bcc0\b|cc-zero/.test(s)) return { license: "cc0", version: "1.0", short: short || "CC0", url };
  const by = /cc[- ]by[- ]sa[- ]?(\d(?:\.\d)?)|cc-by-sa-(\d(?:\.\d)?)/.exec(s);
  if (by) return { license: "by-sa", version: by[1] ?? by[2] ?? "", short: short || `CC BY-SA ${by[1] ?? by[2] ?? ""}`, url };
  const b = /cc[- ]by[- ]?(\d(?:\.\d)?)|cc-by-(\d(?:\.\d)?)/.exec(s);
  if (b) return { license: "by", version: b[1] ?? b[2] ?? "", short: short || `CC BY ${b[1] ?? b[2] ?? ""}`, url };
  if (/^pd\b|^pd-|public domain|\bpdm\b/.test(s)) return { license: "pd", version: "", short: short || "Public domain", url };
  return null;
}

/** Parses an API answer (generator=search + prop=imageinfo) into allowed files, in search order. */
export function parseCommons(json: unknown): CommonsFile[] {
  const pages = (json as { query?: { pages?: Record<string, unknown> } })?.query?.pages ?? {};
  const out: CommonsFile[] = [];
  for (const p of Object.values(pages) as { pageid?: number; title?: string; index?: number; imageinfo?: { url?: string; descriptionurl?: string; width?: number; height?: number; mime?: string; extmetadata?: Record<string, { value?: unknown }> }[] }[]) {
    const ii = p.imageinfo?.[0];
    if (!ii?.url || !p.title) continue;
    const meta = ii.extmetadata ?? {};
    const lic = commonsLicense(meta);
    if (!lic) continue;
    out.push({
      pageid: p.pageid ?? 0,
      title: p.title.replace(/^File:/, ""),
      index: p.index ?? 99,
      url: ii.url,
      descriptionUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title)}`,
      width: ii.width ?? 0,
      height: ii.height ?? 0,
      mime: ii.mime ?? "",
      license: lic.license,
      license_version: lic.version,
      license_short: lic.short,
      license_url: lic.url,
      artist: stripHtml(String(meta.Artist?.value ?? "")).slice(0, 120) || stripHtml(String(meta.Credit?.value ?? "")).slice(0, 120),
      description: stripHtml(String(meta.ImageDescription?.value ?? "")).slice(0, 300),
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

const NOT_PHOTO = /\b(logo|logotype|wordmark|icon|symbol|diagram|chart|graph|map|structure|flowchart|screenshot|screen shot|infographic|poster|flag|coat of arms|seal|signature|drawing|illustration|render|banner)\b/i;

/** Why a Commons file is not a usable photo of the entity (null = usable). */
export function commonsRejectReason(f: CommonsFile, frame: Frame, titleWords: string[]): string | null {
  if (!/^image\/(jpeg|webp|tiff)$/.test(f.mime)) return `type ${f.mime}`;
  if (NOT_PHOTO.test(f.title)) return "not a photo (title)";
  const t = f.title.toLowerCase();
  if (titleWords.length && !titleWords.some((w) => t.includes(w.toLowerCase()))) return "title does not name the entity";
  if (!f.width || !f.height) return "no size";
  const a = f.width / f.height;
  if (a > 2.6 || a < 0.38) return `aspect ${a.toFixed(2)}`;
  // upsampling over 1.6× looks soft on a phone
  if (Math.max(frame.w / f.width, frame.h / f.height) > 1.6) return `too small ${f.width}x${f.height}`;
  return null;
}

/** The smallest standard thumbnail that covers the frame (or the original when it is smaller). */
export function thumbUrl(f: CommonsFile, frame: Frame): string {
  const need = Math.ceil(Math.max(frame.w, (frame.h * f.width) / f.height));
  const w = THUMB_WIDTHS.find((x) => x >= need);
  // the API adds ?utm_… tracking parameters to file URLs; the thumbnail path must not carry them
  const url = f.url.split("?")[0];
  if (!w || w >= f.width) return url;
  // …/commons/a/ab/Name.jpg → …/commons/thumb/a/ab/Name.jpg/<w>px-Name.jpg
  const m = /^(https:\/\/upload\.wikimedia\.org\/wikipedia\/commons)\/([0-9a-f])\/([0-9a-f]{2})\/(.+)$/.exec(url);
  if (!m) return url;
  return `${m[1]}/thumb/${m[2]}/${m[3]}/${m[4]}/${w}px-${m[4]}${/\.tiff?$/i.test(m[4]) ? ".jpg" : ""}`;
}

export interface CommonsOptions {
  fetchFn?: typeof fetch;
  cacheDir?: string;
  limit?: number;
}

/** One search, cached for a week (workspace/_cache/photos/commons-q-*.json). */
export async function searchCommons(query: string, o: CommonsOptions = {}): Promise<CommonsFile[]> {
  const f = o.fetchFn ?? fetch;
  const cacheDir = o.cacheDir ?? PHOTO_CACHE;
  const cached = path.join(cacheDir, `commons-q-${hashOf(query).slice(0, 16)}.json`);
  try {
    const st = await fs.stat(cached);
    if (Date.now() - st.mtimeMs < 7 * 24 * 3600_000) return parseCommons(JSON.parse(await fs.readFile(cached, "utf8")));
  } catch {}
  const params = new URLSearchParams({
    action: "query",
    format: "json",
    generator: "search",
    gsrnamespace: "6",
    gsrsearch: query,
    gsrlimit: String(o.limit ?? 12),
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiextmetadatafilter: "License|LicenseShortName|LicenseUrl|Artist|Credit|ImageDescription",
  });
  const res = await f(`${COMMONS_API}?${params}`, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": COMMONS_UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`commons HTTP ${res.status}`);
  const json = await res.json();
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cached, JSON.stringify(json));
  return parseCommons(json);
}

/** Downloads the frame-sized thumbnail into the photo cache. */
export async function downloadCommons(file: CommonsFile, frame: Frame, o: CommonsOptions = {}): Promise<string | null> {
  const f = o.fetchFn ?? fetch;
  const cacheDir = o.cacheDir ?? PHOTO_CACHE;
  const url = thumbUrl(file, frame);
  const dest = path.join(cacheDir, `commons-${file.pageid}-${hashOf(url).slice(0, 8)}.jpg`);
  try {
    if ((await fs.stat(dest)).size > 0) return dest;
  } catch {}
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await f(url, { signal: AbortSignal.timeout(60_000), redirect: "follow", headers: { "user-agent": COMMONS_UA } });
      if (res.status === 429 && !attempt) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 15_000 || buf.length > 45_000_000) return null;
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(dest, buf);
      return dest;
    } catch {
      if (attempt) return null;
    }
  }
  return null;
}

/**
 * Cover-crops to the frame keeping the subject in view: the crop window is centred on `focus` (0..1 of the source)
 * as far as the image allows.
 */
export async function cropToFrameFocus(src: string, dest: string, frame: Frame, focus: { x: number; y: number } = { x: 0.5, y: 0.45 }) {
  const p = await ffprobe(src);
  const v = p.streams.find((s: { codec_type?: string }) => s.codec_type === "video") as { width?: number; height?: number } | undefined;
  const w = v?.width ?? frame.w;
  const h = v?.height ?? frame.h;
  const scale = Math.max(frame.w / w, frame.h / h);
  const sw = Math.round(w * scale);
  const sh = Math.round(h * scale);
  const x = Math.round(Math.max(0, Math.min(sw - frame.w, focus.x * sw - frame.w / 2)));
  const y = Math.round(Math.max(0, Math.min(sh - frame.h, focus.y * sh - frame.h / 2)));
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await ffmpeg(["-i", src, "-vf", `scale=${sw}:${sh}:flags=lanczos,crop=${frame.w}:${frame.h}:${x}:${y},format=yuvj420p`, "-frames:v", "1", "-q:v", "3", dest]);
}

/** A credit line for a Commons photo. */
export function commonsCreditLine(f: Pick<CommonsFile, "title" | "artist" | "license_short" | "descriptionUrl">): string {
  return `«${f.title.replace(/\.(jpe?g|webp|tiff?)$/i, "").slice(0, 70)}»${f.artist ? ` — ${f.artist}` : ""} (${f.license_short}, Wikimedia Commons) ${f.descriptionUrl}`;
}
