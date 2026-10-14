import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Text fitting in a real browser with the real fonts: every element marked data-fit is shrunk
 * (4 px steps, down to data-min) until it fits data-maxw × data-maxh and no word overflows its box.
 * Uses puppeteer-core (a HyperFrames dependency) with the cached chrome-headless-shell.
 */

export async function findHeadlessChrome(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (env.VEDIT_CHROME?.trim()) return env.VEDIT_CHROME.trim();
  const base = path.join(os.homedir(), ".cache", "puppeteer");
  for (const kind of ["chrome-headless-shell", "chrome"]) {
    const dir = path.join(base, kind);
    const versions = (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse();
    for (const v of versions) {
      for (const sub of await fs.readdir(path.join(dir, v)).catch(() => [] as string[])) {
        const exe = path.join(dir, v, sub, process.platform === "win32" ? `${kind}.exe` : kind);
        try {
          await fs.access(exe);
          return exe;
        } catch {}
      }
    }
  }
  return null;
}

/** Runs in the page: shrink every [data-fit] element (4 px steps) until it fits its box. */
const FIT_IN_PAGE = `(() => {
  const sizes = {};
  const overflow = [];
  for (const el of Array.from(document.querySelectorAll("[data-fit]"))) {
    const id = el.dataset.fit;
    const maxw = Number(el.dataset.maxw);
    const maxh = Number(el.dataset.maxh);
    const min = Number(el.dataset.min) || 24;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    const fits = () => {
      const words = Array.from(el.querySelectorAll(".w"));
      const widest = words.length ? Math.max(...words.map((w) => w.offsetWidth)) : 0;
      return el.scrollWidth <= maxw + 1 && el.scrollHeight <= maxh + 1 && widest <= maxw + 1;
    };
    let guard = 0;
    while (!fits() && fs > min && guard++ < 80) {
      fs = Math.max(min, fs - 4);
      el.style.fontSize = fs + "px";
    }
    sizes[id] = fs;
    if (!fits()) overflow.push(id);
  }
  return { sizes, overflow };
})()`;

export interface FitResult {
  sizes: Record<string, number>;
  /** ids that still do not fit at their minimum size */
  overflow: string[];
}

export async function fitText(htmlFile: string, opts: { chrome?: string; width?: number; height?: number } = {}): Promise<FitResult> {
  const exe = opts.chrome ?? (await findHeadlessChrome());
  if (!exe) throw new Error("fit: headless Chrome не найден (~/.cache/puppeteer) — задайте VEDIT_CHROME");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--font-render-hinting=none"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width ?? 1080, height: opts.height ?? 1920, deviceScaleFactor: 1 });
    // the composition registers its timeline on window.__timelines (normally created by the HyperFrames runtime).
    // In-page code is passed as strings: tsx/esbuild decorate functions with a __name helper the page lacks.
    await page.evaluateOnNewDocument("window.__timelines = {};");
    await page.goto(pathToFileURL(htmlFile).href, { waitUntil: "load", timeout: 60_000 });
    await page.evaluate("document.fonts.ready.then(() => true)");
    return (await page.evaluate(FIT_IN_PAGE)) as FitResult;
  } finally {
    await browser.close();
  }
}
