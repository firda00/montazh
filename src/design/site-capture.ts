import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { findHeadlessChrome } from "../lib/chrome.ts";
import { ffmpeg } from "../lib/ffmpeg.ts";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * Stage 27 (P1-6): a company's own website as a montage insert (reel #15 scrolls the mobile site of PayEm while the
 * speaker names it). Two parts:
 *
 *  1. the official URL — the brand dictionary (OFFICIAL_SITES) first, else Wikidata «official website» (P856) of the
 *     entity found by name with wbsearchentities (no key; the hit must look like a company / product / organisation);
 *  2. the capture — headless Chrome (puppeteer-core + the cached chrome-headless-shell, see src/lib/chrome.ts) at an
 *     iPhone viewport 390×844 @2x: load, dismiss a cookie banner (a click on a typical «Accept / Reject / Принять»
 *     button inside a cookie/consent container — only to get a clean picture, never a login), hide what still floats
 *     over the page, scroll once through it so lazy images load, and take ONE tall screenshot of the first ≤ 4 screens.
 *     The composition animates the scroll (a translateY of the tall image in a card) — cheaper and steadier than
 *     recording frames. Cached per URL and day in workspace/_cache/sites/.
 *
 * Editorial nominative use: the public home page of the company being talked about, shown with its domain; no logins,
 * no paywalled or personal pages.
 */

export const SITES_CACHE = path.join(WORKSPACE_ROOT, "_cache", "sites");
export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const UA_API = "vedit/1.0 (video editor; nominative website captures; https://www.wikidata.org/wiki/Wikidata:Data_access)";
export const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2 } as const;
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** Official sites of the dictionary entities (src/make/visuals.ts ids) — the same names the narrators keep using. */
export const OFFICIAL_SITES: Record<string, string> = {
  openai: "https://openai.com",
  anthropic: "https://www.anthropic.com",
  claude: "https://claude.ai",
  "claude-code": "https://www.anthropic.com/claude-code",
  chatgpt: "https://chatgpt.com",
  google: "https://about.google",
  gemini: "https://gemini.google.com",
  microsoft: "https://www.microsoft.com",
  nvidia: "https://www.nvidia.com",
  meta: "https://about.meta.com",
  apple: "https://www.apple.com",
  amazon: "https://www.aboutamazon.com",
  xai: "https://x.ai",
  deepseek: "https://www.deepseek.com",
  mistral: "https://mistral.ai",
  perplexity: "https://www.perplexity.ai",
  cursor: "https://cursor.com",
  tesla: "https://www.tesla.com",
  spacex: "https://www.spacex.com",
  softbank: "https://group.softbank",
  nasdaq: "https://www.nasdaq.com",
  nyse: "https://www.nyse.com",
};

// ---- URLs ----

/** «https://www.tesla.com/ru_ru?x=1» → «tesla.com» */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** An http(s) URL that is a plausible public home page (no IPs, no localhost, no file paths). */
export function normalizeSiteUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost" || host.endsWith(".local") || host.endsWith(".test")) return null;
  u.hash = "";
  if (u.protocol === "http:") u.protocol = "https:";
  return u.toString().replace(/\/$/, "");
}

/** Descriptions of Wikidata items that are things with a website of their own. */
const ORG_DESC = /\b(company|corporation|manufacturer|business|enterprise|startup|organi[sz]ation|developer|brand|bank|exchange|conglomerate|firm|retailer|maker|platform|software|service|website|laboratory|lab|agency|airline|automaker|fund|investment|holding|group|chatbot|model|application|app|product|компания|корпорация|производитель|организация)\b/i;

export interface WikidataHit {
  id: string;
  label: string;
  description: string;
  /** the alias the search matched */
  matched?: string;
}

/** wbsearchentities → hits (label, description). */
export function parseWikidataSearch(json: unknown): WikidataHit[] {
  const s = (json as { search?: { id?: string; label?: string; description?: string; display?: { label?: { value?: string } }; match?: { text?: string } }[] })?.search ?? [];
  return s.filter((x) => x.id && /^Q\d+$/.test(x.id)).map((x) => ({ id: x.id!, label: x.label ?? x.display?.label?.value ?? "", description: x.description ?? "", ...(x.match?.text ? { matched: x.match.text } : {}) }));
}

/**
 * Hits that can be the organisation / product named: an org-like description and the label or the matched alias equal to
 * the name (case-insensitive), or the label starting with it. Several can match («Securities and Exchange Commission» is
 * the US one and the Philippine one): the caller takes the most notable (most Wikipedia sitelinks).
 */
export function wikidataCandidates(hits: WikidataHit[], name: string): WikidataHit[] {
  const n = name.trim().toLowerCase();
  const org = hits.filter((h) => ORG_DESC.test(h.description));
  const exact = org.filter((h) => h.label.toLowerCase() === n || h.matched?.toLowerCase() === n);
  return exact.length ? exact : org.filter((h) => h.label.toLowerCase().startsWith(n)).slice(0, 2);
}

/** Of several items, the one with the most sitelinks (the notable one), with its P856. */
export function pickBySitelinks(json: unknown, ids: string[]): { id: string; url: string } | null {
  const ents = (json as { entities?: Record<string, { sitelinks?: Record<string, unknown> }> })?.entities ?? {};
  const ranked = ids.map((id) => ({ id, links: Object.keys(ents[id]?.sitelinks ?? {}).length, url: parseOfficialWebsite(json, id) })).filter((x) => x.url);
  ranked.sort((a, b) => b.links - a.links);
  return ranked[0] ? { id: ranked[0].id, url: ranked[0].url! } : null;
}

/**
 * P856 (official website) of a wbgetentities answer: preferred-rank statements first, then normal; deprecated ones
 * and statements that ended (P582 end time qualifier) are skipped; English-language variants preferred (P407 = Q1860).
 */
export function parseOfficialWebsite(json: unknown, id: string): string | null {
  const ent = (json as { entities?: Record<string, { claims?: Record<string, unknown[]> }> })?.entities?.[id];
  const claims = (ent?.claims?.P856 ?? []) as { rank?: string; mainsnak?: { datavalue?: { value?: unknown } }; qualifiers?: Record<string, { datavalue?: { value?: { id?: string } } }[]> }[];
  const live = claims.filter((c) => c.rank !== "deprecated" && !c.qualifiers?.P582 && typeof c.mainsnak?.datavalue?.value === "string");
  const score = (c: (typeof live)[number]) => (c.rank === "preferred" ? 0 : 2) + (c.qualifiers?.P407?.some((q) => q.datavalue?.value?.id === "Q1860") ? 0 : c.qualifiers?.P407 ? 1 : 0.5);
  const best = [...live].sort((a, b) => score(a) - score(b))[0];
  return best ? normalizeSiteUrl(String(best.mainsnak!.datavalue!.value)) : null;
}

const hash = (x: string) => createHash("sha256").update(x).digest("hex").slice(0, 16);

async function cachedJson(url: string, file: string, maxAgeMs: number, fetchFn: typeof fetch): Promise<unknown> {
  try {
    const st = await fs.stat(file);
    if (Date.now() - st.mtimeMs < maxAgeMs) return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  const res = await fetchFn(url, { signal: AbortSignal.timeout(20_000), headers: { "user-agent": UA_API, accept: "application/json" } });
  if (!res.ok) throw new Error(`wikidata HTTP ${res.status}`);
  const json = await res.json();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(json));
  return json;
}

/** Official website of a named company / product: the dictionary, else Wikidata P856 (cached for 30 days). */
export async function officialSite(entity: { id: string; name: string }, o: { fetchFn?: typeof fetch; cacheDir?: string; offline?: boolean } = {}): Promise<{ url: string; source: "dictionary" | "wikidata"; qid?: string } | null> {
  const known = OFFICIAL_SITES[entity.id];
  if (known) return { url: known, source: "dictionary" };
  if (o.offline) return null;
  const f = o.fetchFn ?? fetch;
  const dir = path.join(o.cacheDir ?? SITES_CACHE, "wikidata");
  const month = 30 * 24 * 3600_000;
  const q = new URLSearchParams({ action: "wbsearchentities", search: entity.name, language: "en", uselang: "en", type: "item", limit: "7", format: "json" });
  const hits = parseWikidataSearch(await cachedJson(`${WIKIDATA_API}?${q}`, path.join(dir, `s-${hash(entity.name.toLowerCase())}.json`), month, f));
  const cands = wikidataCandidates(hits, entity.name).slice(0, 5).map((h) => h.id);
  if (!cands.length) return null;
  const g = new URLSearchParams({ action: "wbgetentities", ids: cands.join("|"), props: "claims|sitelinks", format: "json" });
  const best = pickBySitelinks(await cachedJson(`${WIKIDATA_API}?${g}`, path.join(dir, `e-${hash(cands.join("|"))}.json`), month, f), cands);
  return best ? { url: best.url, source: "wikidata", qid: best.id } : null;
}

// ---- capture ----

export interface SiteCapture {
  url: string;
  final_url: string;
  domain: string;
  title: string;
  /** the tall screenshot (JPEG, 780 px wide) */
  file: string;
  width: number;
  height: number;
  /** CSS px of the page the screenshot covers */
  page_height: number;
  cached: boolean;
  cookie: string;
}

/** Runs in the page: click one consent button inside a cookie/consent container (text match), report what was clicked. */
const DISMISS_COOKIES = `(() => {
  const TXT = /^(accept( all)?( cookies)?|allow( all)?( cookies)?|agree|i agree|i accept|got it|ok(ay)?|reject( all)?|decline( all)?|only (necessary|essential)( cookies)?|necessary only|принять( все)?|согласен|согласиться|разрешить( все)?|понятно|хорошо|отклонить( все)?|только необходимые|qabul qilish|roziman)$/i;
  const CONT = /cookie|consent|gdpr|privacy|onetrust|cmp|didomi|usercentrics|cookiebot|truste|qc-cmp|osano|termly/i;
  const els = Array.from(document.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]'));
  for (const el of els) {
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
    if (!TXT.test(text)) continue;
    let p = el, inBanner = false;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      const id = (p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : '') + ' ' + (p.getAttribute && (p.getAttribute('aria-label') || '') || '');
      if (CONT.test(id)) { inBanner = true; break; }
    }
    if (!inBanner) continue;
    el.click();
    return text;
  }
  return '';
})()`;

/** Runs in the page: hide what still floats over the content (consent layers, chat bubbles, app banners). */
const HIDE_OVERLAYS = `(() => {
  const CONT = /cookie|consent|gdpr|onetrust|didomi|usercentrics|cookiebot|truste|osano|termly|intercom|drift|chat-widget|smartbanner|app-banner|newsletter|modal|popup/i;
  let n = 0;
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const id = (el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '');
    const r = el.getBoundingClientRect();
    const big = r.width * r.height > 0.25 * innerWidth * innerHeight;
    const headerLike = r.top <= 1 && r.height < 120;
    if (CONT.test(id) || (big && !headerLike)) { el.style.setProperty('display', 'none', 'important'); n++; }
  }
  document.documentElement.style.setProperty('overflow', 'auto', 'important');
  document.body && document.body.style.setProperty('overflow', 'auto', 'important');
  return n;
})()`;

/** Bot walls and error pages are not a picture of the company. */
export function blockedPage(title: string, text: string): string | null {
  const t = `${title}\n${text.slice(0, 2000)}`;
  if (/access denied|attention required|just a moment|verify you are (a )?human|are you a robot|captcha|forbidden|404 not found|page not found|cloudflare|request blocked|unusual traffic/i.test(t)) return "bot wall or error page";
  if (text.trim().length < 40) return "empty page";
  return null;
}

const today = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/**
 * Captures the mobile home page as a tall JPEG (≤ `screens` screens). Cached per URL and day. Throws when Chrome is
 * missing or the page is a bot wall / empty.
 */
export async function captureSite(url: string, o: { cacheDir?: string; screens?: number; chrome?: string; timeoutMs?: number; onLog?: (l: string) => void } = {}): Promise<SiteCapture> {
  const dir = o.cacheDir ?? SITES_CACHE;
  const key = `${hash(url)}-${today()}`;
  const file = path.join(dir, `${key}.jpg`);
  const meta = path.join(dir, `${key}.json`);
  try {
    const m = JSON.parse(await fs.readFile(meta, "utf8")) as SiteCapture;
    if ((await fs.stat(file)).size > 20_000) return { ...m, file, cached: true };
  } catch {}
  const exe = o.chrome ?? (await findHeadlessChrome());
  if (!exe) throw new Error("headless Chrome не найден (~/.cache/puppeteer) — задайте VEDIT_CHROME");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--lang=en-US,en", "--disable-notifications"] });
  const screens = o.screens ?? 4;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(IPHONE_UA);
    await page.setViewport({ ...MOBILE_VIEWPORT, isMobile: true, hasTouch: true });
    await page.setExtraHTTPHeaders({ "accept-language": "en-US,en;q=0.9" });
    const timeout = o.timeoutMs ?? 30_000;
    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout });
    } catch {
      // long-polling pages never go idle: what has loaded by now is enough
      await page.goto(url, { waitUntil: "domcontentloaded", timeout }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1500));
    let cookie = (await page.evaluate(DISMISS_COOKIES).catch(() => "")) as string;
    if (cookie) await new Promise((r) => setTimeout(r, 700));
    else {
      // consent managers in an iframe (OneTrust, Sourcepoint): try the frames too
      for (const fr of page.frames().slice(1, 6)) {
        cookie = (await fr.evaluate(DISMISS_COOKIES).catch(() => "")) as string;
        if (cookie) {
          await new Promise((r) => setTimeout(r, 700));
          break;
        }
      }
    }
    const title = (await page.title().catch(() => "")) || "";
    const text = ((await page.evaluate("document.body ? document.body.innerText : ''").catch(() => "")) as string) || "";
    const why = blockedPage(title, text);
    if (why) throw new Error(`${domainOf(url)}: ${why}`);
    // scroll through once (lazy images), back to the top, then hide floating layers
    const total = Number(await page.evaluate("Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight)")) || MOBILE_VIEWPORT.height;
    const want = Math.min(total, MOBILE_VIEWPORT.height * screens);
    for (let y = 0; y < want; y += 600) {
      await page.evaluate(`window.scrollTo(0, ${y})`);
      await new Promise((r) => setTimeout(r, 250));
    }
    await page.evaluate("window.scrollTo(0, 0)");
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(HIDE_OVERLAYS).catch(() => 0);
    const png = path.join(dir, `${key}.png`);
    await fs.mkdir(dir, { recursive: true });
    await page.screenshot({ path: png as `${string}.png`, clip: { x: 0, y: 0, width: MOBILE_VIEWPORT.width, height: want }, captureBeyondViewport: true });
    await ffmpeg(["-i", png, "-vf", "format=yuvj420p", "-q:v", "4", file]);
    await fs.rm(png, { force: true });
    const st = await fs.stat(file);
    if (st.size < 20_000) throw new Error(`${domainOf(url)}: снимок почти пустой (${st.size} байт)`);
    const final = page.url();
    const out: SiteCapture = { url, final_url: final, domain: domainOf(final) || domainOf(url), title: title.slice(0, 120), file, width: MOBILE_VIEWPORT.width * 2, height: want * 2, page_height: want, cached: false, cookie };
    await fs.writeFile(meta, JSON.stringify(out, null, 1));
    o.onLog?.(`сайт ${out.domain}: ${want} px страницы${cookie ? `, баннер cookies закрыт («${cookie}»)` : ""}`);
    return out;
  } finally {
    await browser.close().catch(() => {});
  }
}
