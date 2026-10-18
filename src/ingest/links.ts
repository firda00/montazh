// A video by link instead of a Telegram file (stage 24): the cloud Bot API lets a bot download only 20 MB, phone
// videos are bigger. Supported: Google Drive (incl. the "can't scan for viruses" confirm page of large files),
// Yandex Disk public links (a file or a folder of videos), Dropbox (?dl=1), direct http(s) links to a video file,
// and YouTube / Shorts / Instagram / TikTok / VK / Rutube… through the optional yt-dlp (VEDIT_YTDLP, as in the
// reference mode). Size cap VEDIT_LINK_MAX_MB (default 2048), idle and total timeouts, cancellation by signal,
// every file checked with ffprobe (a web page or an archive is refused, not passed on to the pipeline).
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { withJobSignal } from "../lib/abort.ts";
import { ffprobe, isVideoStream, runProcess } from "../lib/ffmpeg.ts";

const MB = 1024 * 1024;

export type LinkKind = "gdrive" | "gdrive_folder" | "yadisk" | "dropbox" | "platform" | "direct";
export interface LinkInfo {
  kind: LinkKind;
  url: string;
  /** Google Drive file id */
  id?: string;
}

export type LinkErrorCode = "too_big" | "not_video" | "private" | "folder" | "no_ytdlp" | "http" | "timeout" | "cancelled" | "empty";
export class LinkError extends Error {
  constructor(
    readonly code: LinkErrorCode,
    message: string,
    /** too_big: the size, when known */
    readonly bytes?: number,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

/** sites only yt-dlp can download from (the page is not the file) */
const PLATFORM_HOSTS = [
  "youtube.com", "youtu.be", "youtube-nocookie.com", "instagram.com", "instagr.am", "tiktok.com", "vk.com", "vk.ru", "vkvideo.ru",
  "rutube.ru", "ok.ru", "dzen.ru", "facebook.com", "fb.watch", "x.com", "twitter.com", "vimeo.com", "likee.video", "threads.net", "pinterest.com", "pin.it", "twitch.tv",
];
const YADISK_HOSTS = /^(disk\.yandex\.(ru|com|kz|by|uz|com\.tr|az|com\.am|co\.il|kg|lt|lv|md|tj|tm|ee|fr)|yadi\.sk|disk\.360\.yandex\.(ru|com))$/;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|3gp|3g2|mts|m2ts|ts|mpg|mpeg|wmv|flv|hevc|qt)$/i;

const hostOf = (u: URL) => u.hostname.toLowerCase().replace(/^(www\.|m\.|mobile\.)/, "");
const isHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** every http(s) link in a message, trailing punctuation trimmed, duplicates dropped */
export function findLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'«»]+/gi)) {
    const u = m[0].replace(/[).,!?;:»"']+$/, "");
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** the message is (mostly) links: what is left after removing them, trimmed */
export const textWithoutLinks = (text: string) =>
  text
    .replace(/https?:\/\/[^\s<>"'«»]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export function classifyLink(raw: string): LinkInfo | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = hostOf(u);
  if (host === "drive.google.com" || host === "docs.google.com" || host === "drive.usercontent.google.com") {
    if (/\/folders\//.test(u.pathname)) return { kind: "gdrive_folder", url: raw };
    const id = /\/(?:file\/)?d\/([\w-]{10,})/.exec(u.pathname)?.[1] ?? u.searchParams.get("id") ?? undefined;
    return id ? { kind: "gdrive", url: raw, id } : { kind: "direct", url: raw };
  }
  if (YADISK_HOSTS.test(host)) return { kind: "yadisk", url: raw };
  if (host === "dropbox.com" || host === "dl.dropboxusercontent.com" || host === "dl.dropbox.com") return { kind: "dropbox", url: raw };
  if (isHost(host, PLATFORM_HOSTS)) return { kind: "platform", url: raw };
  return { kind: "direct", url: raw };
}

/** VEDIT_LINK_MAX_MB: the biggest video accepted by link, MB (default 2048) */
export function linkMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VEDIT_LINK_MAX_MB?.trim();
  const n = raw ? Number(raw) : 2048;
  return (Number.isFinite(n) && n >= 1 ? Math.min(n, 100_000) : 2048) * MB;
}

/** stable file name base of a link (the same link twice is downloaded once) */
export const linkKey = (url: string) => `link_${createHash("sha1").update(url.trim()).digest("hex").slice(0, 16)}`;

export interface LinkFile {
  file: string;
  bytes: number;
  /** the name the server or the folder gave it */
  name?: string;
}

export interface DownloadLinkOptions {
  /** files bigger than this are refused (LinkError too_big) */
  maxBytes: number;
  signal?: AbortSignal;
  /** no byte for this long → timeout (default 60 s) */
  idleMs?: number;
  /** the whole download (default VEDIT_LINK_TIMEOUT_MIN, 30 min) */
  totalMs?: number;
  /** bytes so far (and the total when known), at most every progressMs */
  onProgress?: (bytes: number, total?: number) => void;
  progressMs?: number;
  /** folder links: at most this many videos (default 10) */
  maxFiles?: number;
  // ── test hooks ──
  fetch?: typeof fetch;
  /** yt-dlp → the downloaded files (default: the VEDIT_YTDLP / yt-dlp binary) */
  ytdlp?: (url: string, dir: string, maxBytes: number, signal: AbortSignal) => Promise<string[]>;
  /** does the file hold a video stream (default ffprobe) */
  probe?: (file: string) => Promise<boolean>;
  log?: (line: string) => void;
}

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/**
 * Downloads the video(s) behind a link into `dir` as `<base>.<ext>` (`<base>_<n>.<ext>` for a folder).
 * Throws LinkError with a code the bot turns into a clear message.
 */
export async function downloadLink(url: string, dir: string, base: string, o: DownloadLinkOptions): Promise<LinkFile[]> {
  const info = classifyLink(url);
  if (!info) throw new LinkError("http", "это не ссылка http(s)");
  await fs.mkdir(dir, { recursive: true });
  const totalMs = o.totalMs ?? Number(process.env.VEDIT_LINK_TIMEOUT_MIN || 30) * 60_000;
  const timeout = AbortSignal.timeout(totalMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  const ctx: Ctx = { ...o, signal, fetchFn: o.fetch ?? fetch, dir, base };
  try {
    let files: LinkFile[];
    switch (info.kind) {
      case "gdrive":
        files = [await gdrive(info.id!, ctx)];
        break;
      case "gdrive_folder":
        throw new LinkError("folder", "ссылка на папку Google Диска — нужна ссылка на файл");
      case "yadisk":
        files = await yadisk(info.url, ctx);
        break;
      case "dropbox":
        files = [await dropbox(info.url, ctx)];
        break;
      case "platform":
        files = await viaYtDlp(info.url, ctx);
        break;
      default:
        files = [await direct(info.url, ctx)];
    }
    const probe = o.probe ?? hasVideo;
    for (const f of files) {
      if (!(await probe(f.file))) {
        await Promise.all(files.map((x) => fs.rm(x.file, { force: true })));
        throw new LinkError("not_video", `по ссылке не видео${f.name ? ` (${f.name})` : ""}`);
      }
    }
    return files;
  } catch (err) {
    if (err instanceof LinkError) throw err;
    if (o.signal?.aborted) throw new LinkError("cancelled", "загрузка отменена");
    if (timeout.aborted || (err instanceof Error && err.name === "TimeoutError")) throw new LinkError("timeout", "ссылка не скачалась за отведённое время");
    throw new LinkError("http", `не удалось скачать: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

interface Ctx extends DownloadLinkOptions {
  signal: AbortSignal;
  fetchFn: typeof fetch;
  dir: string;
  base: string;
}

export async function hasVideo(file: string): Promise<boolean> {
  try {
    const p = await ffprobe(file);
    return p.streams.some(isVideoStream) && Number(p.format.duration ?? 1) > 0;
  } catch {
    return false;
  }
}

const EXT_BY_TYPE: Record<string, string> = { "video/mp4": ".mp4", "video/quicktime": ".mov", "video/webm": ".webm", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi", "video/3gpp": ".3gp", "video/mpeg": ".mpg", "video/mp2t": ".ts" };

function nameFromDisposition(h: string | null): string | undefined {
  if (!h) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(h)?.[1];
  if (star) {
    try {
      return decodeURIComponent(star.trim().replace(/^"|"$/g, ""));
    } catch {}
  }
  return /filename\s*=\s*"?([^";]+)"?/.exec(h)?.[1]?.trim();
}

type Fetched = { kind: "file"; file: LinkFile } | { kind: "html"; html: string; url: string };

/** GET → a file in ctx.dir (streamed, size-capped, idle timeout), or the HTML of a web page */
async function fetchToFile(url: string, ctx: Ctx, fileName: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const idleMs = ctx.idleMs ?? 60_000;
  const idle = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(new LinkError("timeout", `по ссылке нет данных ${Math.round(idleMs / 1000)} с`)), idleMs);
  };
  kick();
  const signal = AbortSignal.any([ctx.signal, idle.signal]);
  try {
    const res = await ctx.fetchFn(url, { redirect: "follow", signal, headers: { "user-agent": UA, ...headers } });
    if (res.status === 401 || res.status === 403) throw new LinkError("private", `доступ закрыт (HTTP ${res.status})`);
    if (res.status === 404 || res.status === 410) throw new LinkError("http", `файл не найден (HTTP ${res.status})`);
    if (!res.ok || !res.body) throw new LinkError("http", `HTTP ${res.status}`);
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const len = Number(res.headers.get("content-length") ?? NaN);
    if (type === "text/html" || type === "application/xhtml+xml") {
      const text = (await res.text()).slice(0, 4 * MB);
      return { kind: "html", html: text, url: res.url || url };
    }
    if (Number.isFinite(len) && len > ctx.maxBytes) {
      await res.body.cancel().catch(() => {});
      throw new LinkError("too_big", `файл ${Math.round(len / MB)} МБ`, len);
    }
    const name = nameFromDisposition(res.headers.get("content-disposition")) ?? safeDecode(path.basename(new URL(res.url || url).pathname));
    const ext = (name && VIDEO_EXT.exec(name)?.[0]?.toLowerCase()) || EXT_BY_TYPE[type] || ".mp4";
    const dest = path.join(ctx.dir, `${fileName}${ext}`);
    const tmp = `${dest}.part`;
    const out = createWriteStream(tmp);
    let bytes = 0;
    let lastReport = 0;
    const every = ctx.progressMs ?? 2000;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        bytes += chunk.byteLength;
        if (bytes > ctx.maxBytes) throw new LinkError("too_big", `файл больше ${Math.round(ctx.maxBytes / MB)} МБ`, Number.isFinite(len) ? len : bytes);
        if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
        const now = Date.now();
        if (ctx.onProgress && now - lastReport >= every) {
          lastReport = now;
          ctx.onProgress(bytes, Number.isFinite(len) ? len : undefined);
        }
      }
      await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    if (!bytes) {
      await fs.rm(tmp, { force: true });
      throw new LinkError("empty", "по ссылке пустой файл");
    }
    await fs.rename(tmp, dest);
    return { kind: "file", file: { file: dest, bytes, name: name || undefined } };
  } catch (err) {
    if (idle.signal.aborted && idle.signal.reason instanceof LinkError) throw idle.signal.reason;
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const decodeHtml = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

/** the "Google Drive can't scan this file for viruses" page → the URL of its "Download anyway" form (null: not that page) */
export function parseDriveConfirm(html: string, pageUrl = "https://drive.google.com/"): string | null {
  const form = /<form[^>]*id="download-form"[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (form) {
    const u = new URL(decodeHtml(form[1]), pageUrl);
    for (const m of form[2].matchAll(/<input[^>]*type="hidden"[^>]*>/gi)) {
      const name = /name="([^"]+)"/.exec(m[0])?.[1];
      const value = /value="([^"]*)"/.exec(m[0])?.[1] ?? "";
      if (name) u.searchParams.set(name, decodeHtml(value));
    }
    return u.toString();
  }
  // the older page: a plain link with confirm=<token>
  const href = /href="(\/uc\?export=download[^"]*confirm=[^"]+)"/.exec(html)?.[1];
  return href ? new URL(decodeHtml(href), pageUrl).toString() : null;
}

const looksLikeLogin = (html: string) => /accounts\.google\.com\/(ServiceLogin|v3\/signin|AccountChooser)|<title>[^<]*(Sign-in|Вход|Google Drive: Sign)/i.test(html);

async function gdrive(id: string, ctx: Ctx): Promise<LinkFile> {
  let url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  for (let step = 0; step < 3; step++) {
    const r = await fetchToFile(url, ctx, ctx.base);
    if (r.kind === "file") return r.file;
    const next = parseDriveConfirm(r.html, r.url);
    if (next && next !== url) {
      url = next;
      continue;
    }
    if (looksLikeLogin(r.html)) throw new LinkError("private", "файл Google Диска закрыт");
    if (/quota|Too many users have viewed or downloaded|превышен/i.test(r.html)) throw new LinkError("http", "Google Диск: лимит скачиваний файла исчерпан, попробуйте позже");
    break;
  }
  // last resort: the direct download host
  const r = await fetchToFile(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t`, ctx, ctx.base);
  if (r.kind === "file") return r.file;
  throw new LinkError(looksLikeLogin(r.html) ? "private" : "not_video", "Google Диск отдал страницу вместо файла");
}

interface YaResource {
  type?: "file" | "dir";
  name?: string;
  path?: string;
  size?: number;
  media_type?: string;
  mime_type?: string;
  _embedded?: { items?: YaResource[] };
  href?: string;
  error?: string;
  description?: string;
}

async function yaJson(url: string, ctx: Ctx): Promise<YaResource> {
  const res = await ctx.fetchFn(url, { signal: ctx.signal, headers: { accept: "application/json", "user-agent": UA } });
  const data = (await res.json().catch(() => ({}))) as YaResource;
  if (res.status === 404) throw new LinkError("private", "Яндекс Диск: ресурс не найден или закрыт");
  if (res.status === 403 || res.status === 401) throw new LinkError("private", `Яндекс Диск: доступ закрыт (${data.error ?? res.status})`);
  if (!res.ok) throw new LinkError("http", `Яндекс Диск: ${data.description ?? data.error ?? `HTTP ${res.status}`}`);
  return data;
}

const YA_API = "https://cloud-api.yandex.net/v1/disk/public/resources";

async function yadisk(publicUrl: string, ctx: Ctx): Promise<LinkFile[]> {
  const key = encodeURIComponent(publicUrl);
  const meta = await yaJson(`${YA_API}?public_key=${key}&limit=100`, ctx);
  const isVid = (r: YaResource) => r.media_type === "video" || (r.mime_type ?? "").startsWith("video/") || VIDEO_EXT.test(r.name ?? "");
  const one = async (r: YaResource, pathParam: string | undefined, name: string, c: Ctx = ctx) => {
    if (r.size !== undefined && r.size > ctx.maxBytes) throw new LinkError("too_big", `файл ${Math.round(r.size / MB)} МБ`, r.size);
    const link = await yaJson(`${YA_API}/download?public_key=${key}${pathParam ? `&path=${encodeURIComponent(pathParam)}` : ""}`, ctx);
    if (!link.href) throw new LinkError("http", "Яндекс Диск не дал ссылку на скачивание");
    const got = await fetchToFile(link.href, c, name);
    if (got.kind !== "file") throw new LinkError("not_video", "Яндекс Диск отдал страницу вместо файла");
    return { ...got.file, name: r.name ?? got.file.name };
  };
  if (meta.type !== "dir") {
    if (meta.name && !isVid(meta) && meta.media_type && meta.media_type !== "video") throw new LinkError("not_video", `на Яндекс Диске не видео: ${meta.name}`);
    return [await one(meta, undefined, ctx.base)];
  }
  // a shared folder: every video in it (sorted by name), up to maxFiles
  const items = (meta._embedded?.items ?? []).filter((r) => r.type === "file" && isVid(r)).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", undefined, { numeric: true }));
  if (!items.length) throw new LinkError("not_video", "в папке Яндекс Диска нет видео");
  const max = ctx.maxFiles ?? 10;
  const total = items.slice(0, max).reduce((s, r) => s + (r.size ?? 0), 0);
  if (total > ctx.maxBytes) throw new LinkError("too_big", `видео в папке на ${Math.round(total / MB)} МБ`, total);
  const out: LinkFile[] = [];
  let done = 0;
  const onProgress = ctx.onProgress;
  for (const [i, r] of items.slice(0, max).entries()) {
    const sub: Ctx = { ...ctx, onProgress: onProgress ? (b) => onProgress(done + b, total || undefined) : undefined };
    const f = await one(r, r.path, `${ctx.base}_${i + 1}`, sub);
    done += f.bytes;
    out.push(f);
  }
  return out;
}

async function dropbox(raw: string, ctx: Ctx): Promise<LinkFile> {
  const u = new URL(raw);
  if (/^\/(sh|scl\/fo)\//.test(u.pathname)) throw new LinkError("folder", "ссылка на папку Dropbox — нужна ссылка на файл");
  u.searchParams.delete("raw");
  u.searchParams.set("dl", "1");
  const r = await fetchToFile(u.toString(), ctx, ctx.base);
  if (r.kind === "file") return r.file;
  throw new LinkError(/login|sign in/i.test(r.html) ? "private" : "not_video", "Dropbox отдал страницу вместо файла");
}

async function direct(url: string, ctx: Ctx): Promise<LinkFile> {
  const r = await fetchToFile(url, ctx, ctx.base);
  if (r.kind === "file") return r.file;
  // a web page with a player (VK, a news site…): yt-dlp knows many of them
  try {
    return (await viaYtDlp(url, ctx))[0];
  } catch (err) {
    if (err instanceof LinkError && err.code === "no_ytdlp") throw new LinkError("not_video", "по ссылке веб-страница, а не видеофайл");
    throw err;
  }
}

async function dirBytes(dir: string): Promise<number> {
  let n = 0;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) n += (await fs.stat(path.join(dir, f)).catch(() => ({ size: 0 }))).size;
  return n;
}

async function viaYtDlp(url: string, ctx: Ctx): Promise<LinkFile[]> {
  const work = path.join(ctx.dir, `.${ctx.base}.ytdlp`);
  await fs.rm(work, { recursive: true, force: true });
  await fs.mkdir(work, { recursive: true });
  const timer = ctx.onProgress ? setInterval(() => void dirBytes(work).then((b) => b && ctx.onProgress!(b)), ctx.progressMs ?? 2000) : undefined;
  try {
    const got = await (ctx.ytdlp ?? ytDlp)(url, work, ctx.maxBytes, ctx.signal);
    if (!got.length) throw new LinkError("empty", "yt-dlp ничего не скачал");
    const out: LinkFile[] = [];
    for (const [i, f] of got.entries()) {
      const bytes = (await fs.stat(f)).size;
      if (bytes > ctx.maxBytes) throw new LinkError("too_big", `видео ${Math.round(bytes / MB)} МБ`, bytes);
      const dest = path.join(ctx.dir, `${got.length > 1 ? `${ctx.base}_${i + 1}` : ctx.base}${path.extname(f) || ".mp4"}`);
      await fs.rename(f, dest);
      out.push({ file: dest, bytes, name: path.basename(f) });
    }
    return out;
  } finally {
    if (timer) clearInterval(timer);
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/** the yt-dlp binary: VEDIT_YTDLP or `yt-dlp` in PATH (optional; Unlicense) */
export const ytdlpBin = (env: NodeJS.ProcessEnv = process.env) => env.VEDIT_YTDLP?.trim() || "yt-dlp";

/** yt-dlp → files in `dir`: best ≤ 1920 px video + audio merged into MP4, one video (no playlists), size-capped */
export async function ytDlp(url: string, dir: string, maxBytes: number, signal: AbortSignal): Promise<string[]> {
  const bin = ytdlpBin();
  let out: { stdout: string; stderr: string };
  try {
    out = await withJobSignal(signal, () =>
      runProcess(bin, [
        "--no-playlist", "--no-progress", "--no-warnings", "--restrict-filenames", "--no-part",
        "-f", "bv*[height<=1920]+ba/b[height<=1920]/bv*+ba/b",
        "--merge-output-format", "mp4",
        "--max-filesize", `${Math.ceil(maxBytes / MB)}M`,
        "--socket-timeout", "30",
        "-o", path.join(dir, "%(id).60s.%(ext)s"),
        "--print", "after_move:filepath",
        url,
      ]),
    );
  } catch (err) {
    if (signal.aborted) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/failed to start/i.test(msg)) throw new LinkError("no_ytdlp", `yt-dlp не найден (${bin})`);
    if (/login|sign in|private|cookies|rate-limit|confirm you.?re not a bot/i.test(msg)) throw new LinkError("private", `сайт требует вход: ${msg.split("\n").slice(-1)[0].slice(0, 200)}`);
    if (/Unsupported URL/i.test(msg)) throw new LinkError("not_video", "на странице нет видео, которое можно скачать");
    throw new LinkError("http", `yt-dlp: ${msg.split("\n").slice(-2).join(" ").slice(0, 300)}`);
  }
  if (/larger than max-filesize|File is larger/i.test(out.stdout + out.stderr)) throw new LinkError("too_big", `видео больше ${Math.round(maxBytes / MB)} МБ`);
  const files = out.stdout.trim().split(/\r?\n/).filter(Boolean);
  const real: string[] = [];
  for (const f of files) if (await fs.stat(f).then(() => true, () => false)) real.push(f);
  return real;
}

/** is yt-dlp callable (for messages: links to platforms work or not) */
export async function ytdlpAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    await runProcess(ytdlpBin(env), ["--version"]);
    return true;
  } catch {
    return false;
  }
}
