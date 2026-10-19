// The in-bot guide: 7 short cards in one message (◀️ ▶️ edit it in place, «▶️ Попробовать» opens that flow) and the
// same text as ONE vertical cheat-sheet picture (1080 px wide, dark), rendered by headless Chrome (puppeteer-core):
//   npx tsx src/bot/guide-render.ts            → docs/guide-{ru,uz,en}.png
// The bot sends docs/guide-<lang>.png on «🖼 Шпаргалка» (renders it on the fly into _bot/_guide when missing).
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineButton, InlineKeyboard } from "./telegram-api.ts";
import type { Lang } from "./db.ts";
import type { MenuAction, Strings } from "./i18n.ts";

/** what «Попробовать» on each card opens (the menu action; "menu" = the main menu) */
export const GUIDE_ACTIONS: (MenuAction | "menu")[] = ["montage", "settings", "make", "ref", "highlights", "avatar", "menu"];

export const GUIDE_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));
export const guideImageName = (lang: Lang) => `guide-${lang}.png`;

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

/** card i (0-based, clamped) → its text and buttons */
export function guideCard(L: Strings, i: number): { text: string; kb: InlineKeyboard; index: number } {
  const cards = L.guide.cards;
  const n = Math.min(cards.length - 1, Math.max(0, Math.trunc(Number.isFinite(i) ? i : 0)));
  const c = cards[n];
  const nav: InlineButton[] = [];
  if (n > 0) nav.push(btn("◀️", `G:p:${n - 1}`));
  if (n < cards.length - 1) nav.push(btn("▶️", `G:p:${n + 1}`));
  return {
    index: n,
    text: [L.guide.head(n + 1, cards.length), "", c.title, "", ...c.body.split("\n").map((l) => `• ${l}`)].join("\n"),
    kb: { inline_keyboard: [nav, [btn(L.guide.tryIt, `G:t:${n}`)], [btn(L.guide.sheet, "G:img")]] },
  };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** the cheat sheet as a self-contained page, 1080 px wide (height follows the content, ≈ 2400) */
export function guideHtml(L: Strings, fonts: { latin?: string; cyrillic?: string } = {}): string {
  const fontUrl = fonts.latin ?? fonts.cyrillic;
  const cards = L.guide.cards
    .map((c, i) => {
      const [emoji, ...words] = c.title.split(" ");
      const lines = c.body
        .split("\n")
        .map((l) => `<li>${esc(l)}</li>`)
        .join("");
      return `<section class="card"><div class="num">${i + 1}</div><div class="emoji">${esc(emoji)}</div><h2>${esc(words.join(" "))}</h2><ul>${lines}</ul></section>`;
    })
    .join("");
  // Unbounded 700 for the headings (OFL, @fontsource): Latin and Cyrillic subsets by unicode-range
  const face = [
    fonts.latin ? `@font-face{font-family:"Display";src:url("${fonts.latin}") format("woff2");font-weight:700;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2018-201F;}` : "",
    fonts.cyrillic ? `@font-face{font-family:"Display";src:url("${fonts.cyrillic}") format("woff2");font-weight:700;unicode-range:U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116;}` : "",
  ].join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${face}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#0E0F12;width:1080px}
body{color:#F2F2F0;font-family:"Segoe UI","Inter","Noto Sans","DejaVu Sans",Arial,sans-serif;padding:56px 56px 44px}
header{margin-bottom:26px}
.brand{font:700 26px/1 ${fontUrl ? '"Display",' : ""}sans-serif;letter-spacing:.18em;color:#D4FF00;text-transform:uppercase}
h1{font:700 56px/1.08 ${fontUrl ? '"Display",' : ""}"Segoe UI",sans-serif;margin-top:22px}
.sub{font-size:28px;color:#A9ABB2;margin-top:12px}
.card{position:relative;background:#17191E;border:1px solid #262930;border-radius:28px;padding:24px 32px 24px 120px;margin-top:16px}
.num{position:absolute;left:30px;top:24px;width:64px;height:64px;border-radius:50%;background:#D4FF00;color:#0E0F12;font:800 34px/64px "Segoe UI",sans-serif;text-align:center}
.emoji{position:absolute;left:41px;top:100px;font-size:38px}
h2{font-size:36px;font-weight:700;line-height:1.15}
ul{list-style:none;margin-top:8px}
li{font-size:26px;line-height:1.3;color:#D7D8DC;padding-left:24px;position:relative;margin-top:4px}
li:before{content:"";position:absolute;left:0;top:14px;width:9px;height:9px;border-radius:3px;background:#D4FF00}
footer{margin-top:26px;font-size:26px;color:#8D9098;text-align:center}
</style></head><body>
<header><div class="brand">vedit</div><h1>📘 ${esc(L.guide.imageTitle)}</h1><div class="sub">${esc(L.guide.imageSub)}</div></header>
${cards}
<footer>${esc(L.guide.imageFoot)}</footer>
</body></html>`;
}

/** renders the cheat sheet PNG with headless Chrome (puppeteer-core + the cached chrome-headless-shell) */
export async function renderGuideImage(L: Strings, out: string, o: { chrome?: string } = {}): Promise<string> {
  const { findHeadlessChrome } = await import("../lib/chrome.ts");
  const exe = o.chrome ?? (await findHeadlessChrome());
  if (!exe) throw new Error("headless Chrome не найден (~/.cache/puppeteer) — задайте VEDIT_CHROME");
  const fontData = async (subset: string) => {
    try {
      const f = fileURLToPath(new URL(`../../node_modules/@fontsource/unbounded/files/unbounded-${subset}-700-normal.woff2`, import.meta.url));
      return `data:font/woff2;base64,${(await fs.readFile(f)).toString("base64")}`;
    } catch {
      return undefined;
    }
  };
  const fonts = { latin: await fontData("latin"), cyrillic: await fontData("cyrillic") };
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1600, deviceScaleFactor: 1 });
    await page.setContent(guideHtml(L, fonts), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await fs.mkdir(path.dirname(out), { recursive: true });
    await page.screenshot({ path: out as `${string}.png`, fullPage: true, type: "png" });
    return out;
  } finally {
    await browser.close();
  }
}
