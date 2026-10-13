import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Lucide icons (ISC licence) from the lucide-static package: 2,000+ outline SVGs. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ICONS_DIR = path.join(ROOT, "node_modules", "lucide-static", "icons");

/** The SVG body of an icon, ready to inline: root attributes trimmed to what the composition styles itself. */
export async function loadIconSvg(name: string, dir = ICONS_DIR): Promise<string> {
  const raw = await fs.readFile(path.join(dir, `${name}.svg`), "utf8");
  const open = raw.indexOf("<svg");
  const close = raw.lastIndexOf("</svg>");
  if (open < 0 || close < 0) throw new Error(`icon ${name}: not an svg`);
  const inner = raw.slice(raw.indexOf(">", open) + 1, close).trim();
  // Lucide roots carry width/height/stroke attributes; the composition sets size and colour via CSS
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="icon">${inner}</svg>`;
}
