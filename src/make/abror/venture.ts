import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "../../lib/workspace.ts";

/**
 * Fresh venture news for the Uzbek venture-news reels (stage 33). A TypeScript port of the collector and the ranking of
 * «Venchur Radari» (C:/Users/firda/прототип агнет: src/collect.mjs, src/rank.mjs, src/lib/{rss,signals}.mjs — not
 * modified, its config/sources.json is read when VENCHUR_RADARI_DIR points at it): 21 RSS feeds (TechCrunch, Crunchbase
 * News, Sifted, Tech.eu, vc.ru, Spot.uz, Gazeta.uz, Kursiv…), venture vocabulary filter, deal size / stage / investors,
 * one story per cluster of outlets, «hotness» with a bonus for Uzbekistan and Central Asia.
 */

export interface VentureSource {
  id: string;
  name: string;
  url: string;
  weight: number;
  lang: string;
  region: string;
  strict?: boolean;
}

/** config/sources.json of venchur-radari (2026-09-12) */
export const VENTURE_SOURCES: VentureSource[] = [
  { id: "techcrunch-venture", name: "TechCrunch Venture", url: "https://techcrunch.com/category/venture/feed/", weight: 3, lang: "en", region: "global" },
  { id: "crunchbase-news", name: "Crunchbase News", url: "https://news.crunchbase.com/feed/", weight: 3, lang: "en", region: "global" },
  { id: "techcrunch-startups", name: "TechCrunch Startups", url: "https://techcrunch.com/category/startups/feed/", weight: 2, lang: "en", region: "global" },
  { id: "techcrunch", name: "TechCrunch", url: "https://techcrunch.com/feed/", weight: 2, lang: "en", region: "global" },
  { id: "axios-prorata", name: "Axios", url: "https://api.axios.com/feed/", weight: 2, lang: "en", region: "global" },
  { id: "techstartups", name: "TechStartups", url: "https://techstartups.com/feed/", weight: 2, lang: "en", region: "global" },
  { id: "fortune", name: "Fortune", url: "https://fortune.com/feed/", weight: 1, lang: "en", region: "global", strict: true },
  { id: "restofworld", name: "Rest of World", url: "https://restofworld.org/feed/latest/", weight: 2, lang: "en", region: "emerging", strict: true },
  { id: "sifted", name: "Sifted", url: "https://sifted.eu/feed", weight: 2, lang: "en", region: "europe" },
  { id: "tech-eu", name: "Tech.eu", url: "https://tech.eu/feed/", weight: 2, lang: "en", region: "europe" },
  { id: "eu-startups", name: "EU-Startups", url: "https://www.eu-startups.com/feed/", weight: 2, lang: "en", region: "europe" },
  { id: "hn-frontpage", name: "Hacker News", url: "https://hnrss.org/frontpage?points=100", weight: 2, lang: "en", region: "social" },
  { id: "reddit-vc", name: "r/venturecapital", url: "https://www.reddit.com/r/venturecapital/.rss", weight: 1, lang: "en", region: "social" },
  { id: "reddit-startups", name: "r/startups", url: "https://www.reddit.com/r/startups/.rss", weight: 1, lang: "en", region: "social" },
  { id: "vcru", name: "vc.ru", url: "https://vc.ru/rss/all", weight: 2, lang: "ru", region: "cis" },
  { id: "rb-ru", name: "Rusbase", url: "https://rb.ru/feeds/all/", weight: 1, lang: "ru", region: "cis" },
  { id: "spot-uz", name: "Spot.uz", url: "https://www.spot.uz/ru/rss/", weight: 3, lang: "ru", region: "uz", strict: true },
  { id: "gazeta-uz", name: "Gazeta.uz", url: "https://www.gazeta.uz/uz/rss/", weight: 2, lang: "uz", region: "uz", strict: true },
  { id: "uzdaily", name: "UzDaily", url: "https://www.uzdaily.uz/ru/rss", weight: 2, lang: "ru", region: "uz", strict: true },
  { id: "kursiv", name: "Kursiv", url: "https://kz.kursiv.media/feed/", weight: 2, lang: "ru", region: "central-asia", strict: true },
  { id: "digitalbusiness-kz", name: "Digital Business KZ", url: "https://digitalbusiness.kz/feed/", weight: 2, lang: "ru", region: "central-asia", strict: true },
];

/** The source list: venchur-radari's own config when VENCHUR_RADARI_DIR is set and readable, else the copy above. */
export async function ventureSources(env: NodeJS.ProcessEnv = process.env): Promise<VentureSource[]> {
  const dir = env.VENCHUR_RADARI_DIR?.trim();
  if (!dir) return VENTURE_SOURCES;
  try {
    const cfg = JSON.parse(await fs.readFile(path.join(dir, "config", "sources.json"), "utf8")) as { sources?: VentureSource[] };
    return cfg.sources?.length ? cfg.sources.filter((s) => (s as { enabled?: boolean }).enabled !== false) : VENTURE_SOURCES;
  } catch {
    return VENTURE_SOURCES;
  }
}

// ---- RSS (src/lib/rss.mjs)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”" };

export function decodeEntities(input = ""): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

const stripCdata = (v: string) => v.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
export const stripTags = (v = "") => decodeEntities(stripCdata(v).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function tagText(block: string, ...names: string[]): string {
  for (const name of names) {
    const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
    if (m) {
      const t = stripTags(m[1]);
      if (t) return t;
    }
  }
  return "";
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const withRel = (rel: string) => links.find((a) => new RegExp(`rel=["']${rel}["']`, "i").test(a));
  const chosen = withRel("alternate") ?? links.find((a) => !/rel=["'](self|hub|replies|edit)["']/i.test(a));
  const href = chosen?.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]) : "";
}

export interface FeedItem {
  title: string;
  link: string;
  published: string;
  summary: string;
  /** the article's lead picture from the feed (media:content / enclosure), when there is one */
  image?: string;
}

export function parseFeed(xml: string): FeedItem[] {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi), ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]);
  return blocks.map((block) => {
    const image = /<(?:media:content|media:thumbnail|enclosure)\b[^>]*\burl=["']([^"']+)["'][^>]*>/i.exec(block)?.[1];
    return {
      title: tagText(block, "title"),
      link: tagText(block, "link") || atomLink(block) || tagText(block, "guid"),
      published: tagText(block, "pubDate", "published", "updated", "dc:date", "date") || "",
      summary: tagText(block, "description", "summary", "content:encoded", "content"),
      ...(image && /^https?:/i.test(image) && !/\.(mp4|mp3|webm)(\?|$)/i.test(image) ? { image: decodeEntities(image) } : {}),
    };
  });
}

const parseDate = (v: string) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ---- signals (src/lib/signals.mjs)

export const BIG_INVESTORS = ["a16z", "Andreessen Horowitz", "Sequoia", "Accel", "Benchmark", "Index Ventures", "Lightspeed", "General Catalyst", "Founders Fund", "Khosla", "Insight Partners", "Bessemer", "Tiger Global", "SoftBank", "Y Combinator", "Kleiner Perkins", "Greylock", "Thrive Capital", "Coatue", "ICONIQ", "Battery Ventures", "NEA", "Balderton", "Atomico", "Northzone", "Point Nine", "Speedinvest", "Antler", "Sturgeon Capital", "Quest Ventures", "AloqaVentures", "UzVC"];
const FUNDING_TERMS = ["raises", "raised", "funding", "fundraise", "secures", "closes round", "led by", "investment", "backed by", "valuation", "oversubscribed", "term sheet", "привлек", "привлёк", "инвестиц", "раунд", "оценка в", "вложил", "финансирован", "sarmoya", "investitsiya", "mablag"];
const EXIT_TERMS = ["acquires", "acquisition", "acquired by", "merger", "merges with", "ipo", "goes public", "direct listing", "buyout", "takeover", "exit", "поглощ", "слияни", "купил", "приобрел", "приобрёл", "выход на биржу"];
const FUND_TERMS = ["launches fund", "new fund", "closes fund", "first close", "limited partners", "запустил фонд", "новый фонд", "закрыл фонд", "фонд объемом", "фонд объёмом"];
const FUND_RE = /\bfunds?\s+(?:[IVX]{1,4}|\d{1,2})\b|\b(?:launch|launches|launched|close|closes|closed|raise|raises|raised)\b[^.]{0,45}\bfund\b/i;
const VENTURE_TERMS = ["startup", "startups", "venture capital", "venture fund", "vc firm", "vc fund", "unicorn", "accelerator", "incubator", "seed round", "pre-seed", "series a", "series b", "series c", "series d", "y combinator", "angel investor", "pitch deck", "term sheet", "cap table", "portfolio company", "funding round", "raises $", "raises €", "oversubscribed", "limited partners", "ipo", "acquires", "acquisition", "стартап", "венчур", "акселератор", "посевной раунд", "посевные инвестиц", "посевных инвестиц", "бизнес-ангел", "единорог", "раунд", "привлекла инвестиции", "привлёк инвестиции", "привлек инвестиции", "поглощ", "слияни", "выход на биржу", "startap", "venchur", "sarmoyador", "tezkorlashtiruvchi"];
const INVEST_TERMS = ["investor", "investment", "equity", "valuation", "fundraise", "backed by", "инвестор", "инвестиц", "финансирован", "капитал", "сделка", "доля в", "investitsiya", "sarmoya"];
const WEAK_TERMS = ["founder", "saas", "fintech", "artificial intelligence", "ai model", "revenue", "tech company", "platform", "бизнес", "компания", "рынок", "финтех", "технолог", "платформа", "выручк", "biznes", "kompaniya", "texnolog"];
const STAGE_RE = /\b(pre-?seed|seed|series\s+[a-k]\b|round\s+[a-k]\b|angel|bridge|growth\s+round|pre-?ipo|ipo)\b/i;

const includesAny = (hay: string, terms: string[]) => terms.filter((t) => hay.includes(t.toLowerCase()));

function toMillions(raw: string, unit?: string): number | null {
  const v = Number.parseFloat(raw.replace(/,/g, "."));
  if (!Number.isFinite(v)) return null;
  switch ((unit ?? "").toLowerCase()) {
    case "trillion":
      return v * 1_000_000;
    case "billion":
    case "bn":
    case "b":
      return v * 1000;
    case "million":
    case "mn":
    case "m":
      return v;
    case "k":
      return v / 1000;
    default:
      return null;
  }
}

function amountsIn(text: string): number | null {
  const c: (number | null)[] = [];
  for (const m of text.matchAll(/[$€£]\s?(\d+(?:[.,]\d+)?)\s*(trillion|billion|bn|b|million|mn|m|k)?\b/gi)) c.push(toMillions(m[1], m[2]));
  for (const m of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(million|billion|trillion)\b/gi)) c.push(toMillions(m[1], m[2]));
  for (const m of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(млрд|млн)/gi)) c.push(toMillions(m[1], m[2].toLowerCase() === "млрд" ? "billion" : "million"));
  const ok = c.filter((n): n is number => typeof n === "number" && n > 0);
  return ok.length ? Math.max(...ok) : null;
}

/** Deal size in USD millions (the headline first; a summary-only figure above $50B is a market size, dropped). */
export function extractAmount(title: string, summary = ""): number | null {
  const t = amountsIn(title);
  if (t) return t;
  const s = amountsIn(summary);
  return s && s <= 50_000 ? s : null;
}

export interface Signals {
  type: "funding" | "exit" | "fund" | "ecosystem";
  amountUsdM: number | null;
  stage: string | null;
  investors: string[];
  ventureHits: number;
  investHits: number;
  weakHits: number;
  isRoundup: boolean;
}

export function extractSignals(item: { title: string; summary: string }): Signals {
  const original = `${item.title} ${item.summary}`;
  const text = original.toLowerCase();
  const classify = (scope: string): Signals["type"] | null => {
    if (FUND_RE.test(scope)) return "fund";
    const l = scope.toLowerCase();
    if (includesAny(l, EXIT_TERMS).length) return "exit";
    if (includesAny(l, FUND_TERMS).length) return "fund";
    if (includesAny(l, FUNDING_TERMS).length) return "funding";
    return null;
  };
  return {
    type: classify(item.title) ?? classify(original) ?? "ecosystem",
    amountUsdM: extractAmount(item.title, item.summary),
    stage: (item.title.match(STAGE_RE) ?? original.match(STAGE_RE))?.[0].replace(/\s+/g, " ").trim() ?? null,
    investors: BIG_INVESTORS.filter((n) => text.includes(n.toLowerCase())),
    ventureHits: includesAny(text, VENTURE_TERMS).length,
    investHits: includesAny(text, INVEST_TERMS).length,
    weakHits: includesAny(text, WEAK_TERMS).length,
    isRoundup: /\b(the week|weekly|roundup|round-up|digest|briefing|дайджест|итоги недели)\b/i.test(item.title),
  };
}

// ---- collect + rank (src/collect.mjs, src/rank.mjs)

export interface NewsItem {
  sourceId: string;
  source: string;
  weight: number;
  lang: string;
  region: string;
  strict: boolean;
  title: string;
  url: string;
  published: string | null;
  summary: string;
  image?: string;
}

export interface RankedItem extends NewsItem {
  signals: Signals;
  score: number;
  clusterSize: number;
  alsoIn: { source: string; url: string }[];
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref|source$)/i.test(k)) u.searchParams.delete(k);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

const titleKey = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim().slice(0, 70);

export interface CollectOptions {
  windowHours?: number;
  maxPerSource?: number;
  fetchFn?: typeof fetch;
  sources?: VentureSource[];
  now?: number;
  timeoutMs?: number;
}

export async function collectVentureNews(o: CollectOptions = {}): Promise<{ items: NewsItem[]; report: { id: string; ok: boolean; kept: number; error?: string }[] }> {
  const sources = o.sources ?? (await ventureSources());
  const doFetch = o.fetchFn ?? fetch;
  const cutoff = (o.now ?? Date.now()) - (o.windowHours ?? 36) * 3600_000;
  const results = await Promise.all(
    sources.map(async (s) => {
      try {
        const res = await doFetch(s.url, { redirect: "follow", headers: { "user-agent": UA, accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
        if (!res.ok) return { s, error: `HTTP ${res.status}` };
        const items = parseFeed(await res.text());
        return items.length ? { s, items } : { s, error: "no items parsed" };
      } catch (err) {
        return { s, error: err instanceof Error ? err.name === "TimeoutError" ? "timeout" : err.message : String(err) };
      }
    }),
  );
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();
  const items: NewsItem[] = [];
  const report: { id: string; ok: boolean; kept: number; error?: string }[] = [];
  for (const r of results) {
    if (!("items" in r) || !r.items) {
      report.push({ id: r.s.id, ok: false, kept: 0, error: (r as { error?: string }).error });
      continue;
    }
    let kept = 0;
    for (const raw of r.items.slice(0, o.maxPerSource ?? 40)) {
      if (!raw.title || !raw.link) continue;
      const pub = parseDate(raw.published);
      if (pub && pub.getTime() < cutoff) continue;
      const url = normalizeUrl(raw.link);
      const key = titleKey(raw.title);
      if (seenUrls.has(url) || seenTitles.has(key)) continue;
      seenUrls.add(url);
      seenTitles.add(key);
      items.push({ sourceId: r.s.id, source: r.s.name, weight: r.s.weight, lang: r.s.lang, region: r.s.region, strict: r.s.strict === true, title: raw.title, url, published: pub ? pub.toISOString() : null, summary: raw.summary.slice(0, 900), ...(raw.image ? { image: raw.image } : {}) });
      kept++;
    }
    report.push({ id: r.s.id, ok: true, kept });
  }
  items.sort((a, b) => (b.published ?? "").localeCompare(a.published ?? ""));
  return { items, report };
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "says", "new", "its", "has", "after", "into", "about", "more", "than", "will", "their", "what", "been", "were", "для", "как", "что", "это", "все", "при", "над", "под", "или", "его", "ещё", "уже"]);
const tokens = (t: string) => new Set(t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w)));
function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const u = a.size + b.size - shared;
  return u === 0 ? 0 : shared / u;
}
function amountScore(m: number | null): number {
  if (!m) return 0;
  return m >= 1000 ? 28 : m >= 300 ? 22 : m >= 100 ? 18 : m >= 30 ? 13 : m >= 5 ? 9 : 5;
}
const hoursSince = (iso: string | null, now: number) => (iso ? Math.max(0, (now - new Date(iso).getTime()) / 3_600_000) : 18);

export function scoreItem(item: NewsItem & { signals: Signals }, now: number): number {
  const s = item.signals;
  let score = item.weight * 6;
  score += Math.max(0, 24 - hoursSince(item.published, now)) * 0.8;
  score += amountScore(s.amountUsdM);
  if (s.type === "funding") score += 12;
  if (s.type === "exit") score += 14;
  if (s.type === "fund") score += 10;
  if (s.stage) score += 4;
  score += Math.min(12, s.investors.length * 6);
  score += Math.min(8, s.ventureHits * 2);
  if (s.isRoundup) score -= 14;
  if (item.region === "uz") score += 14;
  if (item.region === "central-asia") score += 8;
  if (item.region === "social") score -= 2;
  return score;
}

/** Filter → cluster the same story across outlets → keep the best item of each → sort by score. */
export function rankVentureNews(items: NewsItem[], now = Date.now(), top = 40): RankedItem[] {
  const enriched = items
    .map((it) => ({ ...it, signals: extractSignals(it) }))
    .filter((it) => (it.strict ? it.signals.ventureHits > 0 : it.signals.ventureHits > 0 || it.signals.investHits > 0 || it.signals.weakHits > 0));
  const sets = enriched.map((it) => tokens(it.title));
  const clusterOf = new Array<number>(enriched.length).fill(-1);
  const clusters: number[][] = [];
  for (let i = 0; i < enriched.length; i++) {
    if (clusterOf[i] !== -1) continue;
    const members = [i];
    clusterOf[i] = clusters.length;
    for (let j = i + 1; j < enriched.length; j++) {
      if (clusterOf[j] !== -1) continue;
      const ov = jaccard(sets[i], sets[j]);
      const same = enriched[i].signals.amountUsdM && enriched[i].signals.amountUsdM === enriched[j].signals.amountUsdM;
      if (ov >= 0.42 || (same && ov >= 0.2)) {
        clusterOf[j] = clusters.length;
        members.push(j);
      }
    }
    clusters.push(members);
  }
  const scored = enriched.map((it, i) => {
    const m = clusters[clusterOf[i]];
    const distinct = new Set(m.map((x) => enriched[x].sourceId)).size;
    return { ...it, clusterSize: m.length, alsoIn: m.filter((x) => x !== i).map((x) => ({ source: enriched[x].source, url: enriched[x].url })), score: Math.round(scoreItem(it, now) + (distinct - 1) * 9) };
  });
  const best = new Map<number, RankedItem>();
  scored.forEach((it, i) => {
    const cur = best.get(clusterOf[i]);
    if (!cur || it.score > cur.score) best.set(clusterOf[i], it);
  });
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, top);
}

// ---- picking reel topics

const AI_RE = /\b(AI|A\.I\.|artificial intelligence|LLMs?|GPT|agentic|AI agents?|machine learning|genai|generative|foundation models?|inference)\b|\bИИ\b|искусственн\w+ интеллект|нейросет/i;
export const isAiItem = (it: Pick<NewsItem, "title" | "summary">) => AI_RE.test(`${it.title} ${it.summary.slice(0, 400)}`);
export const isCentralAsia = (it: Pick<NewsItem, "region" | "title" | "summary">) =>
  it.region === "uz" || it.region === "central-asia" || /uzbekistan|o[ʻ'‘’]?zbekiston|узбекистан|ташкент|tashkent|kazakhstan|казахстан|central asia|центральн\w+ ази/i.test(`${it.title} ${it.summary.slice(0, 400)}`);

/** A recent AI startup round (a funding item with a deal size) and a Central Asia / Uzbekistan venture item. */
export function pickDemoTopics(ranked: RankedItem[]): { aiRound: RankedItem | null; centralAsia: RankedItem | null } {
  const aiRound = ranked.find((it) => it.signals.type === "funding" && !!it.signals.amountUsdM && isAiItem(it) && it.region !== "social") ?? ranked.find((it) => it.signals.type === "funding" && isAiItem(it)) ?? null;
  const centralAsia = ranked.find((it) => isCentralAsia(it) && it.signals.ventureHits > 0 && it !== aiRound) ?? ranked.find((it) => isCentralAsia(it) && it !== aiRound) ?? null;
  return { aiRound, centralAsia };
}

export const VENTURE_CACHE = path.join(WORKSPACE_ROOT, "_cache", "venture");

/** Collect + rank, cached per hour (a re-run within the hour reads the cache). */
export async function freshVentureNews(o: CollectOptions & { cacheDir?: string; onLog?: (l: string) => void } = {}): Promise<{ ranked: RankedItem[]; collected: number; failed: string[]; cached: boolean }> {
  const dir = o.cacheDir ?? VENTURE_CACHE;
  const stamp = new Date(o.now ?? Date.now()).toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const file = path.join(dir, `ranked-${o.windowHours ?? 36}h-${stamp}.json`);
  if (!o.fetchFn) {
    try {
      const c = JSON.parse(await fs.readFile(file, "utf8")) as { ranked: RankedItem[]; collected: number; failed: string[] };
      return { ...c, cached: true };
    } catch {}
  }
  const { items, report } = await collectVentureNews(o);
  const ranked = rankVentureNews(items, o.now ?? Date.now());
  const failed = report.filter((r) => !r.ok).map((r) => `${r.id} (${r.error})`);
  o.onLog?.(`новости: ${items.length} за ${o.windowHours ?? 36} ч из ${report.length - failed.length}/${report.length} лент → ${ranked.length} историй`);
  if (!o.fetchFn) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, JSON.stringify({ ranked, collected: items.length, failed }, null, 1));
  }
  return { ranked, collected: items.length, failed, cached: false };
}
