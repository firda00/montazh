import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ffmpeg, ffprobe } from "../lib/ffmpeg.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";
import type { Frame } from "../lib/aspect.ts";

/**
 * Real photos instead of generated images: Openverse (api.openverse.org, no key — the same keyless API as
 * the music in src/audio/music.ts) searched with the art director's English keywords per beat, licences
 * CC0 / Public Domain Mark / CC BY only (commercial use allowed; CC0 and PDM preferred), mature off.
 * A result is usable when it covers the frame at a decent resolution, is not a panorama/screenshot/graphic
 * (aspect, size and title heuristics) and was not already used for another beat. The original is cached in
 * workspace/_cache/photos/, then cover-cropped to the frame with ffmpeg. Every photo used gets a credit line
 * (CC BY requires attribution): make writes credits.json and prints the lines with the hashtags.
 */

export const PHOTO_CACHE = path.join(WORKSPACE_ROOT, "_cache", "photos");
export const PHOTO_LICENSES = ["cc0", "pdm", "by"] as const;

const Result = z.object({
  id: z.string(),
  title: z.string().nullable().default(""),
  creator: z.string().nullable().default(""),
  creator_url: z.string().nullable().default(""),
  license: z.string(),
  license_version: z.string().nullable().default(""),
  license_url: z.string().nullable().default(""),
  url: z.string(),
  foreign_landing_url: z.string().nullable().default(""),
  provider: z.string().nullable().default(""),
  source: z.string().nullable().default(""),
  filetype: z.string().nullable().default(null),
  filesize: z.number().nullable().default(null),
  width: z.number().nullable().default(null),
  height: z.number().nullable().default(null),
  mature: z.boolean().nullable().default(false),
  tags: z.array(z.object({ name: z.string() }).passthrough()).nullable().default([]),
});
export type PhotoResult = z.infer<typeof Result>;

export interface PhotoCredit {
  beat: number;
  query: string;
  id: string;
  title: string;
  creator: string;
  creator_url: string;
  license: string;
  license_version: string;
  license_url: string;
  /** the photo's page (Flickr, Wikimedia…) */
  url: string;
  source: string;
  /** the cropped frame in the job */
  file: string;
}

export interface PhotoRequest {
  beat: number;
  /** English keywords: concrete nouns, no style words */
  query: string;
}

export interface PhotoOptions {
  frame: Frame;
  fetchFn?: typeof fetch;
  cacheDir?: string;
  /** VEDIT_PHOTOS_OFFLINE=1: no network (returns nothing) */
  offline?: boolean;
  /** a topic word or two appended to fallback queries ("coffee") */
  topicHint?: string;
  /** result ids not to pick again (stage 26: photos the relevance check refused) */
  exclude?: Iterable<string>;
  onEvent?: (l: string) => void;
}

export interface PhotoSearchResult {
  files: Map<number, string>;
  credits: PhotoCredit[];
  missing: number[];
  requests: number;
}

/** Words in a title/tag that mark a non-photo or a screenshot. */
const NOT_A_PHOTO = /\b(screen ?shots?|screen ?caps?|logos?|icons?|diagrams?|charts?|graphs?|infographics?|maps?|posters?|flyers?|banners?|clip ?art|vectors?|illustrations?|drawings?|cartoons?|renders?|rendering|3d model|ai[- ]generated|midjourney|stable diffusion|dall-?e|watermark|memes?|text|signs?|fonts?|typography|patterns?|textures?|wallpapers?|cans?|labels?|packag\w*|advert\w*|brand\w*|logo\w*|storefront|shop front|front|menu|billboard|book cover|cover art)\b/i;
/** titles of statistics maps and charts (OWID-style "<indicator>, <year>") */
const DATA_GRAPHIC = /,\s*(1[89]|20)\d\d\s*$|\b(production|consumption|exports?|imports?|statistics|per capita|by country|share of|percentage|gdp|population|rate)\b/i;
/**
 * Officials and public figures at events (stage 25: «business meeting investors» returned «Ukrainian President … meets
 * with Italian Prime Minister» for an AI-funding beat). The director never searches for specific real people, so a photo
 * of a politician or a royal is always off-topic and misleading.
 */
const PUBLIC_FIGURES = /\b(president|prime minister|minister|chancellor|senator|congress\w*|parliament\w*|ambassador|embassy|summit|official visit|state visit|meets with|meeting with|king|queen|prince|princess|pope|governor|mayor|zelensk\w*|putin|trump|biden|obama|xi jinping|macron|scholz|erdo[gğ]an|modi|netanyahu|meloni|lukashenk\w*|mirziyoyev)\b/i;
/** exact screen resolutions: a PNG of one of these is almost surely a screenshot */
const SCREEN_SIZES = new Set(["1920x1080", "1366x768", "1280x720", "1440x900", "1536x864", "2560x1440", "1280x800", "1024x768", "3840x2160", "2880x1800"]);

/** How much the frame upsamples this source when cover-cropped (1 = exact, > 1 = blurrier). */
export const coverScale = (w: number, h: number, f: Frame) => Math.max(f.w / w, f.h / h);

/** A photo picked by an earlier run that today's title rules would refuse (re-renders search again). */
export const creditRejected = (c: { title: string; query?: string }) =>
  NOT_A_PHOTO.test(c.title ?? "") || DATA_GRAPHIC.test(c.title ?? "") || PUBLIC_FIGURES.test(c.title ?? "") || (!!c.query && !titleRelevant(c.title ?? "", c.query));

/** At least half of the query words appear in the text (a plural «s» ignored). */
export function titleRelevant(text: string, query: string): boolean {
  const qw = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  if (!qw.length) return true;
  const t = text.toLowerCase();
  return qw.filter((w) => t.includes(w.replace(/s$/, ""))).length >= Math.ceil(qw.length / 2);
}

/** Why a result is not usable (null = usable). Dimensions may be unknown before download. */
export function rejectReason(r: PhotoResult, f: Frame): string | null {
  if (!(PHOTO_LICENSES as readonly string[]).includes(r.license)) return `licence ${r.license}`;
  if (r.mature) return "mature";
  const ft = (r.filetype ?? "").toLowerCase();
  if (ft && !/^(jpe?g|png|webp|tiff?)$/.test(ft)) return `type ${ft}`;
  if (NOT_A_PHOTO.test(r.title ?? "")) return "not a photo (title)";
  // data maps / charts uploaded from Our World in Data & co.: "Green coffee production, 2022", "… per capita"
  if (DATA_GRAPHIC.test(r.title ?? "")) return "not a photo (data graphic)";
  if (PUBLIC_FIGURES.test(r.title ?? "")) return "a public figure / official event";
  if ((r.tags ?? []).filter((t) => NOT_A_PHOTO.test(t.name)).length >= 2) return "not a photo (tags)";
  if (r.width && r.height) {
    const a = r.width / r.height;
    if (a > 2.4 || a < 0.42) return `aspect ${a.toFixed(2)}`;
    if (coverScale(r.width, r.height, f) > 1.45) return `too small ${r.width}x${r.height}`;
    if (ft === "png" && SCREEN_SIZES.has(`${r.width}x${r.height}`)) return "screenshot size";
  }
  return null;
}

/**
 * Ranks usable results: relevance first (the query words in the title/tags, Openverse's own order), then
 * CC0/PDM over CC BY, fit to the frame's aspect and resolution headroom.
 */
export function rankPhotos(rs: PhotoResult[], f: Frame, query = ""): PhotoResult[] {
  const target = f.w / f.h;
  const qw = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const index = new Map(rs.map((r, i) => [r.id, i]));
  const relevance = (r: PhotoResult) => {
    if (!qw.length) return 0;
    const text = `${r.title ?? ""} ${(r.tags ?? []).map((t) => t.name).join(" ")}`.toLowerCase();
    const hits = qw.filter((w) => text.includes(w.replace(/s$/, ""))).length;
    return (3 * hits) / qw.length - 0.06 * (index.get(r.id) ?? 0);
  };
  const score = (r: PhotoResult) => {
    const lic = (r.license === "cc0" || r.license === "pdm" ? 1.5 : 0) + relevance(r);
    if (!r.width || !r.height) return lic - 1.5;
    const a = r.width / r.height;
    const fit = -Math.abs(Math.log(a / target)) * 1.2;
    const res = Math.min(1, Math.log2(1 / coverScale(r.width, r.height, f)) / 1.5);
    const png = (r.filetype ?? "").toLowerCase() === "png" ? -1 : 0;
    // long flowery captions ("skilled barista at work during the morning rush hour") are typical of
    // generated stock that ends up on open repositories: a real photo usually has a short or file-like title
    const flowery = (r.title ?? "").length > 80 ? -1.5 : 0;
    return lic + fit + res + png + flowery;
  };
  // stage 25: at least half of the query words must be in the title/tags («stock trading screens» returned a 1955
  // Karmann Ghia, «tech office open space» a police booth); a narrower query variant asks for fewer words
  const relevant = (r: PhotoResult) => titleRelevant(`${r.title ?? ""} ${(r.tags ?? []).map((t) => t.name).join(" ")}`, query);
  return rs
    .filter((r) => rejectReason(r, f) === null && relevant(r))
    .map((r) => ({ r, s: score(r) }))
    .sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id))
    .map((x) => x.r);
}

export function photoCreditLine(c: Pick<PhotoCredit, "title" | "creator" | "license" | "license_version" | "url" | "source">): string {
  const lic = c.license === "cc0" ? "CC0" : c.license === "pdm" ? "Public Domain" : `CC ${c.license.toUpperCase()} ${c.license_version}`.trim();
  const who = c.creator ? ` — ${c.creator}` : "";
  return `«${(c.title || "без названия").slice(0, 70)}»${who} (${lic}, ${c.source || "openverse"}) ${c.url}`.trim();
}

/** Fallback queries: the director's keywords, then shorter, then with the topic hint. */
export function queryVariants(q: string, topicHint = ""): string[] {
  const words = q.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean).slice(0, 6);
  const out: string[] = [];
  for (let n = words.length; n >= Math.min(2, words.length); n--) out.push(words.slice(0, n).join(" "));
  // then without the leading qualifier ("vietnam coffee farm drought" → "coffee farm drought", "coffee farm")
  if (words.length >= 3) for (let n = words.length; n >= 3; n--) out.push(words.slice(1, n).join(" "));
  const hint = topicHint.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").trim();
  if (hint && words.length && !words.includes(hint)) out.push(`${words[0]} ${hint}`);
  return [...new Set(out.filter(Boolean))];
}

async function searchOpenverse(q: string, f: typeof fetch, cacheDir: string): Promise<PhotoResult[]> {
  const key = createHash("sha1").update(q).digest("hex").slice(0, 16);
  const cached = path.join(cacheDir, `q-${key}.json`);
  try {
    const st = await fs.stat(cached);
    if (Date.now() - st.mtimeMs < 7 * 24 * 3600_000) return (JSON.parse(await fs.readFile(cached, "utf8")) as unknown[]).map((r) => Result.parse(r));
  } catch {}
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&license=${PHOTO_LICENSES.join(",")}&mature=false&size=large&page_size=20`;
  // Openverse is sometimes slow: one retry on a timeout / 5xx before the caller shortens the query
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await f(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/json", "user-agent": "vedit/1.0 (video maker)" } });
      if (res.status < 500) break;
    } catch (err) {
      if (attempt) throw err;
    }
  }
  if (!res || !res.ok) throw new Error(`openverse HTTP ${res?.status ?? "?"}`);
  const json = (await res.json()) as { results?: unknown[] };
  const results = (json.results ?? []).map((r) => Result.safeParse(r)).filter((p) => p.success).map((p) => p.data!);
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(cached, JSON.stringify(results));
  return results;
}

async function download(r: PhotoResult, f: typeof fetch, cacheDir: string): Promise<string | null> {
  const ext = /png/i.test(r.filetype ?? "") ? ".png" : /webp/i.test(r.filetype ?? "") ? ".webp" : ".jpg";
  const file = path.join(cacheDir, `${r.id}${ext}`);
  try {
    if ((await fs.stat(file)).size > 0) return file;
  } catch {}
  try {
    const res = await f(r.url, { signal: AbortSignal.timeout(45_000), redirect: "follow", headers: { "user-agent": "vedit/1.0 (video maker)" } });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (type && !/^image\//i.test(type) && !/octet-stream/i.test(type)) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 20_000 || buf.length > 40_000_000) return null;
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(file, buf);
    return file;
  } catch {
    return null;
  }
}

async function dims(file: string): Promise<{ w: number; h: number } | null> {
  try {
    const p = await ffprobe(file);
    const v = p.streams.find((s: { codec_type?: string }) => s.codec_type === "video") as { width?: number; height?: number } | undefined;
    return v?.width && v?.height ? { w: v.width, h: v.height } : null;
  } catch {
    return null;
  }
}

/** Cover-crops a photo to the frame (JPEG). */
export async function cropToFrame(src: string, dest: string, f: Frame) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await ffmpeg(["-i", src, "-vf", `scale=${f.w}:${f.h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${f.w}:${f.h},format=yuvj420p`, "-frames:v", "1", "-q:v", "3", dest]);
}

/** One photo per request (beat): search, rank, download, verify, crop. Missing beats are reported, not fatal. */
export async function findPhotos(requests: PhotoRequest[], outDir: string, o: PhotoOptions): Promise<PhotoSearchResult> {
  const files = new Map<number, string>();
  const credits: PhotoCredit[] = [];
  const missing: number[] = [];
  const offline = o.offline ?? process.env.VEDIT_PHOTOS_OFFLINE === "1";
  if (offline || !requests.length) return { files, credits, missing: requests.map((r) => r.beat), requests: 0 };
  const f = o.fetchFn ?? fetch;
  const cacheDir = o.cacheDir ?? PHOTO_CACHE;
  const used = new Set<string>();
  /** results already downloaded and rejected (not retried under another query) */
  const tried = new Set<string>(o.exclude ?? []);
  const shrinking = new Set<string>();
  let calls = 0;
  let failures = 0;
  for (const req of requests) {
    let done = false;
    for (const q of queryVariants(req.query, o.topicHint)) {
      if (done || failures >= 3) break;
      let results: PhotoResult[];
      try {
        calls++;
        results = await searchOpenverse(q, f, cacheDir);
      } catch (err) {
        failures++;
        o.onEvent?.(`  фото: поиск «${q}» не удался: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      // sources whose files turned out much smaller than their metadata (StockSnap serves 960 px) go last
      const ranked = rankPhotos(results, o.frame, q).filter((x) => !used.has(x.id) && !tried.has(x.id));
      const order = [...ranked.filter((x) => !shrinking.has(x.source ?? "")), ...ranked.filter((x) => shrinking.has(x.source ?? ""))];
      for (const r of order.slice(0, 5)) {
        tried.add(r.id);
        const src = await download(r, f, cacheDir);
        if (!src) continue;
        const d = await dims(src);
        if (d && r.width && d.w < r.width * 0.6) shrinking.add(r.source ?? "");
        if (!d || rejectReason({ ...r, width: d.w, height: d.h }, o.frame)) continue;
        const dest = path.join(outDir, `scene_${req.beat}.jpg`);
        try {
          await cropToFrame(src, dest, o.frame);
        } catch {
          continue;
        }
        used.add(r.id);
        files.set(req.beat, dest);
        credits.push({ beat: req.beat, query: q, id: r.id, title: r.title ?? "", creator: r.creator ?? "", creator_url: r.creator_url ?? "", license: r.license, license_version: r.license_version ?? "", license_url: r.license_url ?? "", url: r.foreign_landing_url || r.url, source: r.source || r.provider || "", file: dest });
        o.onEvent?.(`  фото ${req.beat}: «${q}» → ${r.license}${r.license_version ? ` ${r.license_version}` : ""} ${r.source ?? ""} ${d.w}×${d.h}`);
        done = true;
        break;
      }
    }
    if (!done) missing.push(req.beat);
  }
  return { files, credits, missing, requests: calls };
}
