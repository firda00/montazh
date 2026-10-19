import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";

/**
 * Brand marks from Simple Icons (stage 26): the npm package `simple-icons` is CC0-1.0 (the SVG path data); the marks
 * themselves are trademarks of their owners — used here nominatively, to show which company the narrator is talking
 * about (editorial use), never as our own branding. Some icons carry their own licence or brand guidelines in the data
 * file (`license`, `guidelines`): both are recorded with the credits. Brands that asked Simple Icons to remove their mark
 * (OpenAI, Microsoft, Nasdaq… — absent from the data file) get a typeset wordmark instead, never a copied logo.
 *
 * Nothing is vendored in git: the data file (~450 KB) and the few SVGs a video needs are fetched once from the jsDelivr
 * CDN for a pinned version and cached in workspace/_cache/simple-icons/<version>/.
 */

export const SIMPLE_ICONS_VERSION = "16.30.0";
export const SIMPLE_ICONS_CDN = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}`;
export const SIMPLE_ICONS_CACHE = path.join(WORKSPACE_ROOT, "_cache", "simple-icons", SIMPLE_ICONS_VERSION);

export interface IconData {
  title: string;
  slug: string;
  hex: string;
  source?: string;
  guidelines?: string;
  license?: { type: string; url?: string };
  aliases?: { aka?: string[] };
}

export interface BrandMark {
  slug: string;
  title: string;
  hex: string;
  /** path data of the 24×24 icon */
  path: string;
  license: string;
  guidelines?: string;
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");

/** Finds an icon by slug, title or alias (case and punctuation ignored). */
export function findIcon(data: IconData[], name: string): IconData | null {
  const n = norm(name);
  if (!n) return null;
  return data.find((d) => d.slug === n) ?? data.find((d) => norm(d.title) === n) ?? data.find((d) => (d.aliases?.aka ?? []).some((a) => norm(a) === n)) ?? null;
}

/** The single path of a Simple Icons SVG (they are all one <path d> on a 24×24 viewBox). */
export function iconPath(svg: string): string | null {
  const m = /<path[^>]*\sd="([^"]+)"/.exec(svg);
  return m ? m[1] : null;
}

export interface BrandOptions {
  fetchFn?: typeof fetch;
  cacheDir?: string;
}

async function cachedFetch(url: string, file: string, o: BrandOptions): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {}
  const f = o.fetchFn ?? fetch;
  const res = await f(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`simple-icons HTTP ${res.status} (${url})`);
  const text = await res.text();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
  return text;
}

let dataMemo: IconData[] | null = null;

/** The icon index (title, slug, hex, licence, guidelines) of the pinned version. */
export async function loadIconData(o: BrandOptions = {}): Promise<IconData[]> {
  if (dataMemo && !o.fetchFn) return dataMemo;
  const dir = o.cacheDir ?? SIMPLE_ICONS_CACHE;
  const text = await cachedFetch(`${SIMPLE_ICONS_CDN}/data/simple-icons.json`, path.join(dir, "simple-icons.json"), o);
  const json = JSON.parse(text) as IconData[] | { icons: IconData[] };
  const data = Array.isArray(json) ? json : json.icons;
  if (!o.fetchFn) dataMemo = data;
  return data;
}

/** A brand mark by slug or name, or null when Simple Icons does not carry it. */
export async function brandMark(name: string, o: BrandOptions = {}): Promise<BrandMark | null> {
  const data = await loadIconData(o);
  const icon = findIcon(data, name);
  if (!icon) return null;
  const dir = o.cacheDir ?? SIMPLE_ICONS_CACHE;
  const svg = await cachedFetch(`${SIMPLE_ICONS_CDN}/icons/${icon.slug}.svg`, path.join(dir, "icons", `${icon.slug}.svg`), o);
  const d = iconPath(svg);
  if (!d) return null;
  return { slug: icon.slug, title: icon.title, hex: `#${icon.hex.toUpperCase()}`, path: d, license: icon.license?.type ?? "CC0-1.0", guidelines: icon.guidelines };
}

/** A credit line for a mark (licence of the path data + the trademark note). */
export function brandCreditLine(m: Pick<BrandMark, "title" | "license" | "guidelines">): string {
  return `Знак ${m.title}: Simple Icons ${SIMPLE_ICONS_VERSION} (${m.license}); товарный знак принадлежит владельцу, показан для обозначения компании${m.guidelines ? `; правила бренда: ${m.guidelines}` : ""}`;
}
