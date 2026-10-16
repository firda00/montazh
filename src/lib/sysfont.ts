import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A font file for ffmpeg drawtext (contact sheets of the highlights pipeline). Windows: Arial; Linux/macOS:
 * DejaVu / Noto / Liberation from the distro (the server setup installs fonts-dejavu-core and fonts-noto-core),
 * else the Inter the repo ships — so nothing depends on Windows fonts.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const FONT_CANDIDATES = [
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
];

export function systemFontFile(platform = process.platform, has: (p: string) => boolean = existsSync): string {
  if (process.env.VEDIT_DRAWTEXT_FONT?.trim()) return process.env.VEDIT_DRAWTEXT_FONT.trim();
  if (platform === "win32") return "C:/Windows/Fonts/arial.ttf";
  return FONT_CANDIDATES.find(has) ?? path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf");
}

/** `fontfile='…'` for a drawtext filter (the drive colon escaped for the filter parser). */
export function drawtextFont(file = systemFontFile()): string {
  return `fontfile='${file.replace(/\\/g, "/").replace(/:/g, "\\:")}'`;
}
