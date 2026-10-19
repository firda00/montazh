import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpeg } from "../lib/ffmpeg.ts";
import type { Frame } from "../lib/aspect.ts";
import { findHeadlessChrome } from "../lib/chrome.ts";

/**
 * A contact sheet of sub-shots (stage 26): one frame per shot (late enough that its transition and entrance are done)
 * with the time range, what the shot shows and the narrator's words said during it, so a reviewer sees at a glance
 * whether the picture matches what is being said. Rendered as HTML in headless Chrome (ffmpeg drawtext needs
 * fontconfig, which Windows builds often lack).
 */

export interface SheetEntry {
  start: number;
  end: number;
  label: string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function shotSheet(video: string, entries: SheetEntry[], words: { text: string; start: number }[], out: string, frame: Frame, o: { cols?: number; chrome?: string } = {}): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-sheet-"));
  try {
    const [tw, th] = frame.w > frame.h ? [400, 225] : frame.w === frame.h ? [300, 300] : [240, 427];
    const cells: string[] = [];
    for (const [k, e] of entries.entries()) {
      const at = Math.min(e.end - 0.12, e.start + Math.max(0.45, 0.62 * (e.end - e.start)));
      const png = `f${String(k).padStart(3, "0")}.png`;
      await ffmpeg(["-ss", Math.max(0, at).toFixed(3), "-i", video, "-frames:v", "1", "-vf", `scale=${tw}:${th}`, path.join(dir, png)]);
      const said = words.filter((w) => w.start >= e.start - 0.05 && w.start < e.end - 0.05).map((w) => w.text).join(" ");
      cells.push(`<div class="c"><img src="${png}" width="${tw}" height="${th}"/><div class="t">${e.start.toFixed(1)}–${e.end.toFixed(1)} s · ${esc(e.label)}</div><div class="w">${esc(said) || "—"}</div></div>`);
    }
    const cols = o.cols ?? (frame.w > frame.h ? 4 : 7);
    const width = cols * (tw + 10) + 10;
    const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#0b0c10;font-family:Arial,Helvetica,sans-serif;color:#f4f4f0}.g{display:grid;grid-template-columns:repeat(${cols},${tw}px);gap:10px;padding:10px}.c{display:flex;flex-direction:column;gap:4px}.c img{display:block;border-radius:6px}.t{font-size:12px;color:#ffd23f;font-weight:700}.w{font-size:13px;line-height:1.25}</style><div class="g">${cells.join("")}</div>`;
    const page = path.join(dir, "sheet.html");
    await fs.writeFile(page, html);
    const exe = o.chrome ?? (await findHeadlessChrome());
    if (!exe) throw new Error("headless Chrome не найден");
    const puppeteer = (await import("puppeteer-core")).default;
    const browser = await puppeteer.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-gpu", "--allow-file-access-from-files"] });
    try {
      const p = await browser.newPage();
      await p.setViewport({ width, height: 800, deviceScaleFactor: 1 });
      await p.goto(pathToFileURL(page).href, { waitUntil: "load", timeout: 60_000 });
      await fs.mkdir(path.dirname(out), { recursive: true });
      await p.screenshot({ path: out as `${string}.jpeg`, type: "jpeg", quality: 82, fullPage: true });
    } finally {
      await browser.close();
    }
    return out;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
