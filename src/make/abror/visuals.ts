import fs from "node:fs/promises";
import path from "node:path";
import { articleLines, normalizeUz, type Pane } from "../../design/abror.ts";
import { captureSite, domainOf, OFFICIAL_SITES, officialSite } from "../../design/site-capture.ts";
import { brandCreditLine, brandMark } from "../brandmarks.ts";
import { commonsCreditLine, downloadCommons, searchCommons } from "../commons.ts";
import type { AbrorLine, AbrorScript, AbrorSource } from "./script.ts";

/**
 * Stage 33: what the screen shows for each line of an Abror script — real, licensable material only
 * (docs/abror-format.md §5.3): the article screenshot (its real text, the key sentence sharp under a pink marker, the
 * rest blurred, the publisher and domain visible), the company's own website (headless Chrome), its mark (Simple Icons,
 * nominative), a number card, a text card, a licensed Commons photo of a place or object. Never an AI image of a
 * person, never a person's likeness at all unless a licensed photo.
 */

export interface PaneResult {
  panes: (Pane | null)[];
  /** credit lines for the description (marks, screenshots, photos) */
  credits: string[];
  notes: string[];
}

export interface PaneOptions {
  /** where downloaded pictures go */
  dir: string;
  /** no network (tests): marks without paths, no captures, no photos */
  offline?: boolean;
  fetchFn?: typeof fetch;
  capture?: typeof captureSite;
  onLog?: (l: string) => void;
}

/** RSS boilerplate off the article text («The post … first appeared on …», «[…]»). */
export function cleanArticleText(t: string): string {
  return t
    .replace(/\s*The post .*? first appeared on .*$/i, "")
    .replace(/\s*\[(…|\.\.\.)\]\s*/g, " ")
    .replace(/\s*(Read more|Continue reading).*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const dateUz = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${d.getUTCFullYear()}`;
};

/** The sentence of the source that carries the main number, when the script did not pick one verbatim. */
export function keySentence(text: string, want = ""): string {
  const t = cleanArticleText(text);
  if (want && t.toLowerCase().includes(want.toLowerCase())) return want;
  const sentences = t.split(/(?<=[.!?])\s+/).filter((s) => s.length > 20);
  return sentences.find((s) => /[$€£]\s?\d|\d+(?:[.,]\d+)?\s*(billion|million|млрд|млн)/i.test(s)) ?? sentences[0] ?? t.slice(0, 140);
}

/** The article pane of a source (its picture downloaded next to the job when the feed had one). */
export async function articlePane(src: AbrorSource, keyLine: string, o: PaneOptions): Promise<Pane> {
  const text = cleanArticleText(src.text);
  const key = keySentence(text, keyLine);
  const { lines, key: keys } = articleLines(text, key, 32);
  let image: string | undefined;
  if (src.image && !o.offline) {
    try {
      const f = o.fetchFn ?? fetch;
      const res = await f(src.image, { signal: AbortSignal.timeout(30_000), headers: { "user-agent": "Mozilla/5.0 vedit" } });
      if (res.ok && /image\/(jpe?g|png|webp)/i.test(res.headers.get("content-type") ?? "")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 8000) {
          await fs.mkdir(o.dir, { recursive: true });
          image = path.join(o.dir, `article_${domainOf(src.url).replace(/[^a-z0-9]/gi, "_")}.jpg`);
          await fs.writeFile(image, buf);
        }
      }
    } catch {}
  }
  return { kind: "article", publisher: src.publisher || domainOf(src.url), domain: domainOf(src.url), ...(src.date ? { date: dateUz(src.date) } : {}), title: src.title, lines: lines.slice(0, 9), key: keys.filter((k) => k < 9), ...(image ? { image } : {}) };
}

const memo = new Map<string, Promise<Pane | null>>();

async function sitePane(kind: "site" | "ui", subject: string, url: string, o: PaneOptions, notes: string[]): Promise<Pane | null> {
  if (o.offline) return null;
  let target = url.trim();
  if (!target) {
    const id = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    target = OFFICIAL_SITES[id] ?? (await officialSite({ id, name: subject }, { fetchFn: o.fetchFn }).catch(() => null))?.url ?? "";
  }
  if (!target) {
    notes.push(`сайт «${subject}» не найден (словарь, Wikidata P856)`);
    return null;
  }
  try {
    const cap = await (o.capture ?? captureSite)(target, { screens: kind === "ui" ? 1 : 3, onLog: o.onLog });
    return { kind, domain: cap.domain, image: cap.file, width: cap.width, height: cap.height };
  } catch (err) {
    notes.push(`сайт ${target} не снят: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return null;
  }
}

async function logoPane(v: AbrorLine["visual"], o: PaneOptions, credits: string[]): Promise<Pane> {
  const name = v.subject.trim() || v.value;
  let mark = null;
  if (!o.offline && name) mark = await brandMark(name, { fetchFn: o.fetchFn }).catch(() => null);
  if (mark) credits.push(brandCreditLine(mark));
  return { kind: "logo", name: mark?.title ?? name, ...(mark ? { path: mark.path, hex: mark.hex } : {}), ...(v.value ? { value: v.value } : {}), ...(v.label ? { label: v.label } : {}) };
}

async function photoPane(v: AbrorLine["visual"], o: PaneOptions, credits: string[], notes: string[]): Promise<Pane | null> {
  if (o.offline || !v.subject.trim()) return null;
  try {
    const files = await searchCommons(v.subject, { fetchFn: o.fetchFn, limit: 10 });
    // places and objects only: anything that looks like a portrait is skipped (no person's likeness from a query)
    const ok = files.find((f) => ["cc0", "pdm", "by", "by-sa"].includes(f.license) && f.width >= 900 && !/portrait|headshot|\bface\b|selfie/i.test(f.title));
    if (!ok) {
      notes.push(`фото «${v.subject}»: подходящего в Commons нет`);
      return null;
    }
    const file = await downloadCommons(ok, { aspect: "9:16", w: 1080, h: 1920 } as never, { fetchFn: o.fetchFn });
    if (!file) return null;
    credits.push(`Фото: ${commonsCreditLine(ok)}`);
    return { kind: "photo", image: file, credit: `foto: ${ok.artist?.slice(0, 30) || "Wikimedia"} · ${ok.license_short}` };
  } catch (err) {
    notes.push(`фото «${v.subject}»: ${err instanceof Error ? err.message.split("\n")[0] : err}`);
    return null;
  }
}

/** One pane per line (null = nothing to show: the caller keeps the previous picture or draws a text card). */
export async function resolveLinePanes(script: AbrorScript, o: PaneOptions): Promise<PaneResult> {
  const credits: string[] = [];
  const notes: string[] = [];
  const panes: (Pane | null)[] = [];
  let articleDone = false;
  for (const [i, l] of script.lines.entries()) {
    const v = l.visual;
    let pane: Pane | null = null;
    if (v.kind === "article" && !articleDone) {
      const srcIdx = script.article?.source ?? l.source;
      const src = script.sources[srcIdx] ?? script.sources[0];
      if (src) {
        pane = await articlePane(src, script.article?.key_line ?? "", o);
        credits.push(`Скриншот статьи (цитирование с указанием источника): ${src.publisher || domainOf(src.url)} — ${src.url}`);
        articleDone = true;
      }
    } else if (v.kind === "site" || v.kind === "ui") {
      const key = `${v.kind}:${v.subject}:${v.url}`;
      if (!memo.has(key)) memo.set(key, sitePane(v.kind, v.subject, v.url, o, notes));
      pane = await memo.get(key)!;
      if (pane && (pane.kind === "site" || pane.kind === "ui")) credits.push(`Скриншот сайта ${pane.domain} (публичная главная страница, номинативное использование)`);
      // a site that could not be captured: the company's mark instead
      if (!pane) pane = await logoPane(v, o, credits);
    } else if (v.kind === "logo") pane = await logoPane(v, o, credits);
    else if (v.kind === "number" || (v.kind === "article" && articleDone)) {
      pane = v.value ? { kind: "number", value: normalizeUz(v.value), label: normalizeUz(v.label) } : null;
    } else if (v.kind === "photo") pane = (await photoPane(v, o, credits, notes)) ?? (v.label ? { kind: "text", lines: v.label.split("|").map((x) => x.trim()).filter(Boolean) } : null);
    else if (v.kind === "text") {
      const lines = (v.label || v.value || "").split("|").map((x) => normalizeUz(x.trim())).filter(Boolean);
      pane = lines.length ? { kind: "text", lines: lines.slice(0, 4), accent: lines.length > 1 ? lines.length - 1 : undefined } : null;
    }
    panes.push(pane);
    o.onLog?.(`  ${i}: ${v.kind}${v.subject ? ` «${v.subject}»` : ""} → ${pane ? pane.kind : "—"}`);
  }
  return { panes, credits: [...new Set(credits)], notes };
}
