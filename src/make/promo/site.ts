import { captureSite, domainOf, normalizeSiteUrl } from "../../design/site-capture.ts";
import { ffmpeg } from "../../lib/ffmpeg.ts";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Stage 31: what a product's website gives a promo — its own copy (title, description, headings, first paragraphs:
 * the writer takes real wording and features from it instead of inventing them) and its brand colour (theme-color,
 * else the most frequent saturated colour of a screenshot made by the stage-27 capture). Public pages only, no login.
 */

export interface SiteBrief {
  url: string;
  domain: string;
  /** og:site_name or the <title> before its separator */
  name: string;
  title: string;
  description: string;
  /** headings and leading paragraphs, plain text, ≤ 3000 chars */
  text: string;
  /** brand colour (#RRGGBB) or null */
  accent: string | null;
  accentFrom: "theme-color" | "screenshot" | null;
  screenshot: string | null;
}

const decode = (s: string) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

const meta = (html: string, key: string) => {
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, "i");
  const tag = re.exec(html)?.[0];
  return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1] ?? "") : "";
};

/** Copy of a page: title, description, headings (h1–h3) and paragraphs, scripts and styles dropped. */
export function pageCopy(html: string): { title: string; name: string; description: string; text: string; themeColor: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "");
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const parts: string[] = [];
  const re = /<(h1|h2|h3|p|li)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = re.exec(body)) && parts.join("\n").length < 3000) {
    const t = decode(m[2].replace(/<[^>]+>/g, " "));
    if (t.length < 3 || t.length > 400 || seen.has(t)) continue;
    seen.add(t);
    parts.push(`${m[1].toLowerCase().startsWith("h") ? "# " : ""}${t}`);
  }
  const siteName = meta(html, "og:site_name") || title.split(/\s[|–—-]\s/)[0] || "";
  return { title, name: siteName.trim(), description: meta(html, "description") || meta(html, "og:description"), text: parts.join("\n").slice(0, 3000), themeColor: meta(html, "theme-color") };
}

const HEX = /^#[0-9a-f]{6}$/i;
/** A brand-worthy colour: not near white, black or grey. */
export function usableAccent(hex: string): boolean {
  if (!HEX.test(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min > 50 && max > 60 && min < 235;
}

/** The most frequent saturated colour of RGB pixels (hue buckets weighted by saturation), or null. */
export function dominantColor(rgb: Uint8Array): string | null {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const [r, g, b] = [rgb[i], rgb[i + 1], rgb[i + 2]];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const sat = max ? (max - min) / max : 0;
    if (sat < 0.35 || max < 70) continue;
    let h = 0;
    if (max === r) h = ((g - b) / (max - min)) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    const key = Math.round(((h * 60 + 360) % 360) / 15);
    const x = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    x.n += sat;
    x.r += r;
    x.g += g;
    x.b += b;
    buckets.set(key, x);
  }
  const best = [...buckets.values()].sort((a, b) => b.n - a.n)[0];
  if (!best || best.n < 20) return null;
  return bucketHex(best);
}

function bucketHex(b: { n: number; r: number; g: number; b: number }): string {
  // r/g/b are pixel sums of the bucket: their ratio is its hue; the brightest channel is lifted to a brand-like level
  const m = Math.max(b.r, b.g, b.b) || 1;
  const scale = 225 / m;
  const ch = [b.r, b.g, b.b].map((v) => Math.max(0, Math.min(255, Math.round(v * scale))));
  return `#${ch.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export async function siteBrief(rawUrl: string, o: { fetchFn?: typeof fetch; capture?: boolean; onLog?: (l: string) => void } = {}): Promise<SiteBrief> {
  const url = normalizeSiteUrl(rawUrl) ?? rawUrl;
  const f = o.fetchFn ?? fetch;
  let copy = { title: "", name: "", description: "", text: "", themeColor: "" };
  try {
    const res = await f(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "en-US,en;q=0.9,ru;q=0.8" } });
    if (res.ok) copy = pageCopy(await res.text());
    else o.onLog?.(`сайт ${domainOf(url)}: HTTP ${res.status}`);
  } catch (err) {
    o.onLog?.(`сайт ${domainOf(url)} не открылся: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
  }
  let accent: string | null = usableAccent(copy.themeColor) ? copy.themeColor.toUpperCase() : null;
  let accentFrom: SiteBrief["accentFrom"] = accent ? "theme-color" : null;
  let screenshot: string | null = null;
  if (o.capture !== false) {
    try {
      const cap = await captureSite(url, { screens: 2, onLog: o.onLog });
      screenshot = cap.file;
      if (!copy.title) copy = { ...copy, title: cap.title, name: copy.name || cap.title.split(/\s[|–—-]\s/)[0] };
      if (!accent) {
        const tmp = path.join(os.tmpdir(), `vedit-accent-${process.pid}-${Date.now()}.rgb`);
        await ffmpeg(["-i", cap.file, "-vf", "scale=64:-1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", tmp]);
        const rgb = new Uint8Array(await fs.readFile(tmp));
        await fs.rm(tmp, { force: true });
        const c = dominantColor(rgb);
        if (c && usableAccent(c)) {
          accent = c;
          accentFrom = "screenshot";
        }
      }
    } catch (err) {
      o.onLog?.(`снимок сайта не сделан: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    }
  }
  return { url, domain: domainOf(url), name: copy.name, title: copy.title, description: copy.description, text: copy.text, accent, accentFrom, screenshot };
}

/** The SITE block for the writer's prompt. */
export function briefText(b: SiteBrief): string {
  return [`SITE (${b.domain}) — use its real product name, wording and features; do not invent features it does not mention:`, b.name && `name: ${b.name}`, b.title && `title: ${b.title}`, b.description && `description: ${b.description}`, b.text && `page copy:\n${b.text}`].filter(Boolean).join("\n");
}
