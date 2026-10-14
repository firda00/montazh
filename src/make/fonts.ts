import path from "node:path";
import { fileURLToPath } from "node:url";
import { linkOrCopy } from "../design/hyperframes/project.ts";

/**
 * Typefaces the art director can pick from. All OFL-1.1, all with Cyrillic. Inter is the
 * variable TTF we already ship; the others come from @fontsource packages as WOFF, split into
 * Latin and Cyrillic subsets joined back with unicode-range.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FS = path.join(ROOT, "node_modules", "@fontsource");

const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const CYRILLIC = "U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116";

export type FontId = "inter" | "unbounded" | "playfair" | "playfair-italic" | "mono";

interface Face {
  file: string;
  weight: number;
  style: "normal" | "italic";
  range?: string;
}

export interface FontDef {
  id: FontId;
  /** CSS family name used in the composition */
  family: string;
  /** fallback stack after the family */
  fallback: string;
  faces: Face[];
  /** the weight headlines use with this face */
  weight: number;
  style: "normal" | "italic";
  /** letter-spacing that looks right at display sizes */
  tracking: string;
}

const fs = (pkg: string, base: string, w: number, style: "normal" | "italic"): Face[] => [
  { file: path.join(FS, pkg, "files", `${base}-latin-${w}-${style}.woff`), weight: w, style, range: LATIN },
  { file: path.join(FS, pkg, "files", `${base}-cyrillic-${w}-${style}.woff`), weight: w, style, range: CYRILLIC },
];

export const FONTS: Record<FontId, FontDef> = {
  inter: { id: "inter", family: "VInter", fallback: "sans-serif", faces: [{ file: path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf"), weight: 800, style: "normal" }], weight: 800, style: "normal", tracking: "-0.025em" },
  unbounded: { id: "unbounded", family: "VUnbounded", fallback: "sans-serif", faces: fs("unbounded", "unbounded", 800, "normal"), weight: 800, style: "normal", tracking: "-0.01em" },
  playfair: { id: "playfair", family: "VPlayfair", fallback: "serif", faces: fs("playfair-display", "playfair-display", 800, "normal"), weight: 800, style: "normal", tracking: "-0.01em" },
  "playfair-italic": { id: "playfair-italic", family: "VPlayfairItalic", fallback: "serif", faces: fs("playfair-display", "playfair-display", 700, "italic"), weight: 700, style: "italic", tracking: "-0.005em" },
  mono: { id: "mono", family: "VMono", fallback: "monospace", faces: [...fs("jetbrains-mono", "jetbrains-mono", 500, "normal"), ...fs("jetbrains-mono", "jetbrains-mono", 700, "normal")], weight: 700, style: "normal", tracking: "0.06em" },
};

/** Copies the faces into <project>/assets/fonts and returns the @font-face block. */
export async function installFonts(projectDir: string, ids: FontId[]): Promise<string> {
  const css: string[] = [];
  for (const id of [...new Set(ids)]) {
    const def = FONTS[id];
    for (const f of def.faces) {
      const rel = `assets/fonts/${path.basename(f.file)}`;
      await linkOrCopy(f.file, path.join(projectDir, rel));
      const isTtf = f.file.endsWith(".ttf");
      css.push(`@font-face { font-family: "${def.family}"; src: url("${rel}") format("${isTtf ? "truetype" : "woff"}"); font-weight: ${isTtf ? "100 900" : f.weight}; font-style: ${f.style}; font-display: block;${f.range ? ` unicode-range: ${f.range};` : ""} }`);
    }
  }
  return css.join("\n      ");
}

export const fontStack = (id: FontId) => `"${FONTS[id].family}", ${FONTS[id].fallback}`;
