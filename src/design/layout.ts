// Stage 4 caption/title LAYOUT ENGINE: DesignJob + measured font → Layout (layout-types.ts).
// Pure and deterministic (same job + same metrics → deep-equal Layout); every renderer consumes the
// result instead of letting the browser wrap text, so line breaks, sizes and pop budgets are decided once.
//
// Rules (see docs/stage4-prototypes.json → judge.design_fixes):
//  a. Word text: NFC, whitespace collapsed; surrounding double quotes/guillemets stripped (single quotes only
//     as a matched pair, so Uzbek togʻ/o‘zbek keep theirs); trailing , . ; : … stripped (? and ! kept);
//     words that end up empty (lone punctuation) are dropped. Uppercased with toLocaleUpperCase(lang),
//     lang = job.captions_language ?? phrase.lang (Uzbek: plain 'uz', Latin script). `raw` keeps the token.
//  b. Pages are re-paginated from job.timeline.phrases (job.pages is ignored) and never span phrases.
//     Per phrase a small DP picks the breaks: Σ(max_chars − chars)² (balanced, few pages), soft caps on
//     max_words / max_chars (heavy penalty, only paid when the orphan rule forces it), a bonus for breaking
//     at punctuation or a pause, and an ORPHAN penalty that dominates everything: a page never ends on a
//     function word (DEFAULT_FUNCTION_WORDS, per language) unless the phrase ends there — i.e. the word
//     moves to the next page even if that page then exceeds max_words/max_chars.
//     Captions disabled on the output (timeline.captions.enabled === false) → no pages.
//  c. Font size per page: base = captions.font_size·W/1080, shrunk in 2 px steps down to 0.6·base until
//     the page fits in ≤ 2 lines of maxWidth = min(W − 2·safe.x·W, 0.8·W), using measured widths + wordGap.
//     If it never fits, 0.6·base with the least-overflowing break is used.
//  d. Lines: one line when it fits, else the two-line break with the smallest width difference whose
//     lines both fit; breaks after a function word are only used when no other break fits. A break after
//     clause punctuation (the comma that rule a hides) gets a 0.15·maxWidth balance bonus, so near-ties
//     split at the clause boundary ("ДИВЗИРА / ЕГО ПРИВОЗЯТ" rather than "ДИВЗИРА ЕГО / ПРИВОЗЯТ").
//  e. Pop budget (word_animation "pop" only, else popScale 1): popScale = min(pop_scale, 1 + 2·grow/width),
//     grow = popGrowPx·W/1080 (default 18) ⇒ a popped word grows ≤ grow px per side; page wordGap =
//     spaceWidth + the largest per-side growth on the page, so a popped word never touches a neighbour.
//  f. Display windows: dispStart = start; next page within holdGap (0.6 s) → dispEnd = next.start (seamless);
//     otherwise dispEnd = min(end + tailHold (0.3 s), next.start) with exitFade. Last page: held to the end of
//     the video when ≤ holdGap remains, else tailHold + fade. Every page lasts ≥ 1 frame; pages never overlap.
//  g. Titles: text as-is (never uppercased); fit into ≤ titles.max_lines lines of
//     min(W − 2·safe.x·W − 2·(padding + 12)·W/1080, 0.8·W) by shrinking (≥ 0.6·base); a break right after a
//     dash (— or a spaced –) is preferred, then no line ending on a function word, then the most balanced.
//     at/duration clamped to frame.duration.
//  h. frame.duration = ceil(timeline.duration·fps − 1e-6)/fps; version = LAYOUT_VERSION.
//  Sizes are CSS px at the output frame, scaled by min(W,H)/1080 (strokeWidth too); times are output seconds.
//
// opentype.js 2.0.0 API actually used (no bundled .d.ts → loaded via createRequire + the minimal types below):
//   opentype.parse(ArrayBuffer) → Font; font.unitsPerEm; font.charToGlyphIndex(ch) (0 = not in cmap);
//   font.charToGlyph(ch).advanceWidth; font.tables.fvar.axes; font.variation.getTransform(glyph, coords)
//   (applies the HVAR advance deltas, so wght 800 really measures as ExtraBold); font.getEnglishName().
//   Width = Σ per-code-point advances × size/unitsPerEm. Deliberately NOT used: font.getAdvanceWidth /
//   stringToGlyphs — they throw on Inter 4's GSUB ccmp lookup (chained-context format 2 is unsupported) —
//   and GPOS kerning, which opentype.js resolves to 0 for Inter (extension lookups). Without kerning the
//   widths are slightly conservative (Inter's caps kerning mostly tightens), which is the safe direction.
//   Variable fonts: wght = the requested weight; opsz = the font size clamped to the axis ("auto", like CSS
//   font-optical-sizing: auto — Inter renders its Display cut at ≥ 32 px); other axes at their defaults.
//   Without opts.weight the default instance is measured. Characters missing from the font are estimated
//   with the heuristic em widths (the browser would fall back to another face).
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { DesignSpecSchema, type DesignSpec } from "../schemas/index.ts";
import type { DesignJob } from "./export.ts";
import type { OutPhrase, OutWord } from "./timeline.ts";
import type { FontMetrics, Layout, LayoutLine, LayoutOptions, LayoutPage, LayoutTitle, LayoutWord } from "./layout-types.ts";
import { hookExtent } from "./hyperframes/split.ts";
import { isLightHex } from "./panel-graphics.ts";
import { hookPlateTiming, sectionAt } from "./abror.ts";
import type { FaceTrack } from "./faces.ts";
import { placeBlock, placeSequence, safeAreaFor, type BlockRequest, type Obstacle, type PlaceOptions } from "./placement.ts";

export const LAYOUT_VERSION = "layout/2";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const DEFAULT_HOLD_GAP = 0.6;
export const DEFAULT_TAIL_HOLD = 0.3;
export const DEFAULT_POP_GROW_PX = 18;
const SIZE_STEP = 2;
/** a caption line break after clause punctuation counts as this fraction of maxWidth more balanced */
const PUNCT_LINE_BONUS = 0.15;
const MIN_SIZE_RATIO = 0.6;
const TITLE_EXTRA_PAD = 12;
/** Splits a short text into ≤ maxLines lines of similar length at word boundaries (CTA cards; no font measuring needed). */
export function splitBalanced(text: string, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4 || maxLines < 2) return [words.join(" ")];
  let best = words.length;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length;
    const b = words.slice(i).join(" ").length;
    const diff = Math.abs(a - b);
    if (diff <= bestDiff) (bestDiff = diff), (best = i); // ties → longer first line
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}


/** The outro CTA text as the composition draws it: balanced lines and a conservative size (0.62 em per character). */
export function outroText(D: DesignSpec, lang: string, W: number, H: number): { lines: string[]; fontSize: number } | null {
  const text = (D.outro.text_by_lang[lang] ?? D.outro.text).trim();
  if (!text) return null;
  const scale = Math.min(W, H) / 1080;
  const safeX = Math.round(D.safe_area.x * W);
  const lines = splitBalanced(text, 2);
  const maxLineChars = Math.max(...lines.map((l) => l.length));
  return { lines, fontSize: Math.round(Math.min(D.outro.font_size * scale, (W - 2 * safeX) / (0.62 * maxLineChars)) * 1000) / 1000 };
}

/** vertical centre of "callout" titles (highlights accents), fraction of the height: above the zoomed hoop */
export const CALLOUT_ANCHOR_Y = 0.3;

/** Words a caption page/line must not end on (lower-case; apostrophes are normalised to ʻ when matching). */
export const DEFAULT_FUNCTION_WORDS: Record<string, string[]> = {
  ru: ["в", "во", "и", "не", "на", "с", "со", "к", "ко", "у", "о", "об", "обо", "от", "до", "а", "но", "за", "по", "из", "изо", "что", "как", "же", "ли", "бы", "для", "без", "под", "над", "при", "про", "через", "или", "ни", "чтобы", "если"],
  uz: ["va", "bilan", "ham", "hamda", "uchun", "yoki", "lekin", "ammo", "biroq", "esa", "deb", "agar", "chunki", "bu", "shu", "har", "eng", "ва", "билан", "ҳам", "учун", "ёки", "лекин", "аммо", "эса"],
  en: ["a", "an", "the", "and", "or", "nor", "of", "to", "in", "on", "at", "for", "with", "by", "from", "into", "as", "than", "but", "so", "if", "my", "your", "our", "their", "its"],
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const chars = (s: string) => Array.from(s).length;

// ---------------------------------------------------------------- font metrics

const H_LOWER = 0.62;
const H_UPPER = 0.7;
const H_SPACE = 0.28;

function heuristicEm(ch: string): number {
  if (/\s/u.test(ch)) return H_SPACE;
  if (/\p{M}/u.test(ch)) return 0;
  return ch !== ch.toLowerCase() ? H_UPPER : H_LOWER;
}

/** Estimated metrics (0.62 em lower-case / other, 0.70 em upper-case, 0.28 em space) for when no font file is available. */
export function heuristicFontMetrics(family = "sans-serif", file = ""): FontMetrics {
  return {
    family,
    file,
    source: "heuristic",
    measure(text, size) {
      let em = 0;
      for (const ch of text.normalize("NFC")) em += heuristicEm(ch);
      return em * size;
    },
    spaceWidth: (size) => H_SPACE * size,
  };
}

interface OtGlyph {
  index: number;
  advanceWidth?: number;
  _advanceWidth?: number;
}
interface OtAxis {
  tag: string;
  minValue: number;
  defaultValue: number;
  maxValue: number;
}
interface OtFont {
  unitsPerEm: number;
  tables: { fvar?: { axes?: OtAxis[] } };
  variation?: { getTransform(glyph: OtGlyph, coords: Record<string, number>): OtGlyph };
  charToGlyphIndex(ch: string): number;
  charToGlyph(ch: string): OtGlyph;
  getEnglishName(name: string): string | undefined;
}
interface OpentypeModule {
  parse(buffer: ArrayBuffer): OtFont;
}

let opentypeModule: OpentypeModule | null = null;
function opentype(): OpentypeModule {
  opentypeModule ??= createRequire(import.meta.url)("opentype.js") as OpentypeModule;
  return opentypeModule;
}

export interface LoadFontOptions {
  /** CSS family name to report (default: the font's English family name) */
  family?: string;
  /** wght axis value for variable fonts (default: the font's default instance) */
  weight?: number;
  /** opsz axis value; "auto" (default) = the font size clamped to the axis, like CSS font-optical-sizing: auto */
  opticalSize?: number | "auto";
}

/** FontMetrics plus what was measured (extra fields; the contract shape is unchanged). */
export interface LoadedFontMetrics extends FontMetrics {
  weight?: number;
  axes?: Record<string, number | "auto">;
}

/**
 * Loads advance-width metrics from a TTF/OTF (relative paths resolve against the repo root).
 * A missing file falls back to heuristicFontMetrics() (source "heuristic"); a corrupt file throws.
 */
export async function loadFontMetrics(file: string, opts: LoadFontOptions = {}): Promise<LoadedFontMetrics> {
  const abs = path.isAbsolute(file) ? file : path.resolve(ROOT, file);
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return heuristicFontMetrics(opts.family ?? "sans-serif", abs);
    throw err;
  }
  const ab = new ArrayBuffer(data.byteLength);
  new Uint8Array(ab).set(data);
  const font = opentype().parse(ab);
  const upem = font.unitsPerEm || 1000;

  const axes = font.tables.fvar?.axes ?? [];
  const variation = axes.length > 0 ? font.variation : undefined;
  const fixed: Record<string, number> = {};
  for (const a of axes) fixed[a.tag] = a.defaultValue;
  const wght = axes.find((a) => a.tag === "wght");
  if (wght && opts.weight !== undefined) fixed.wght = clamp(opts.weight, wght.minValue, wght.maxValue);
  const opsz = axes.find((a) => a.tag === "opsz");
  const optical = opts.opticalSize ?? "auto";
  const opszFor = (size: number) => (opsz ? clamp(optical === "auto" ? size : optical, opsz.minValue, opsz.maxValue) : 0);

  // advance (font units) per opsz value per code point
  const cache = new Map<number, Map<string, number>>();
  const advance = (ch: string, size: number): number => {
    const key = opszFor(size);
    let table = cache.get(key);
    if (!table) cache.set(key, (table = new Map()));
    const hit = table.get(ch);
    if (hit !== undefined) return hit;
    let units: number;
    if (!font.charToGlyphIndex(ch)) {
      units = heuristicEm(ch) * upem;
    } else {
      const glyph = font.charToGlyph(ch);
      const base = glyph._advanceWidth ?? glyph.advanceWidth ?? 0;
      units = base;
      if (variation) {
        try {
          units = variation.getTransform(glyph, opsz ? { ...fixed, opsz: key } : fixed).advanceWidth ?? base;
        } catch {
          units = base;
        }
      }
    }
    table.set(ch, units);
    return units;
  };
  const measure = (text: string, size: number) => {
    let units = 0;
    for (const ch of text.normalize("NFC")) units += advance(ch, size);
    return (units * size) / upem;
  };

  const axesOut: Record<string, number | "auto"> = { ...fixed };
  if (opsz) axesOut.opsz = optical === "auto" ? "auto" : opszFor(0);
  return {
    family: opts.family ?? font.getEnglishName("preferredFamily") ?? font.getEnglishName("fontFamily") ?? path.basename(abs, path.extname(abs)),
    file: abs,
    source: "opentype",
    measure,
    spaceWidth: (size) => measure(" ", size),
    weight: wght ? fixed.wght : opts.weight,
    axes: axesOut,
  };
}

// ---------------------------------------------------------------- words

const EDGE_DQUOTES_START = /^["«»„“”‟‹›]+/u;
const EDGE_DQUOTES_END = /["«»„“”‟‹›]+$/u;
const SINGLE_QUOTES = "'‘’‚`";
const TRAILING_PUNCT = /[,.;:…]+$/u;
/** a token whose last visible char closes a clause — never treated as a dangling function word */
const CLAUSE_END = /[,.;:!?…—–-]["»”’)]*$/u;

function upper(text: string, lang: string): string {
  if (!lang) return text.toUpperCase();
  try {
    return text.toLocaleUpperCase(lang);
  } catch {
    return text.toUpperCase();
  }
}

function lower(text: string, lang: string): string {
  if (!lang) return text.toLowerCase();
  try {
    return text.toLocaleLowerCase(lang);
  } catch {
    return text.toLowerCase();
  }
}

/** stage 27: the caption letter case of a design (letter_case wins; else uppercase → "upper", otherwise as spoken). */
export function captionCase(D: Pick<DesignSpec, "captions">): "as_spoken" | "upper" | "lower" {
  return D.captions.letter_case ?? (D.captions.uppercase ? "upper" : "as_spoken");
}

/** A caption word in the design's letter case (rule a + stage 27 letter_case). */
export function casedWord(raw: string, lang: string, mode: "as_spoken" | "upper" | "lower"): string {
  const t = displayWord(raw, lang, mode === "upper");
  return mode === "lower" ? lower(t, lang) : t;
}

/** Caption display text of one transcript token (rule a). Empty when the token is only punctuation. */
export function displayWord(raw: string, lang: string, uppercase: boolean): string {
  let t = raw.normalize("NFC").replace(/\s+/gu, " ").trim();
  for (let prev = ""; prev !== t; ) {
    prev = t;
    t = t.replace(EDGE_DQUOTES_START, "").replace(EDGE_DQUOTES_END, "").replace(TRAILING_PUNCT, "").trim();
    if (chars(t) >= 2 && SINGLE_QUOTES.includes(t[0]) && SINGLE_QUOTES.includes(t[t.length - 1])) t = t.slice(1, -1).trim();
  }
  return uppercase ? upper(t, lang) : t;
}

const normApostrophes = (s: string) => s.replace(/['‘’ʼ`]/gu, "ʻ");

type FunctionWordSets = Map<string, Set<string>>;

function functionWordSets(overrides?: Record<string, string[]>): FunctionWordSets {
  const merged = { ...DEFAULT_FUNCTION_WORDS, ...(overrides ?? {}) };
  const out: FunctionWordSets = new Map();
  for (const [lang, words] of Object.entries(merged)) out.set(lang.toLowerCase(), new Set(words.map((w) => normApostrophes(lower(w, lang)))));
  return out;
}

function setFor(sets: FunctionWordSets, lang: string): Set<string> | undefined {
  const l = lang.toLowerCase();
  return sets.get(l) ?? sets.get(l.split(/[-_]/)[0]);
}

/** True when `raw` is a function word of `lang` that would dangle at the end of a page/line. */
export function isFunctionWord(raw: string, lang: string, functionWords?: Record<string, string[]>): boolean {
  return isFw(raw, lang, functionWordSets(functionWords));
}

function isFw(raw: string, lang: string | null, sets: FunctionWordSets): boolean {
  const t = raw.trim();
  if (!t || CLAUSE_END.test(t)) return false;
  const key = normApostrophes(lower(displayWord(t, lang ?? "", false), lang ?? ""));
  if (lang === null) {
    for (const s of sets.values()) if (s.has(key)) return true;
    return false;
  }
  return setFor(sets, lang)?.has(key) ?? false;
}

// ---------------------------------------------------------------- pagination (rule b)

export interface PaginateOptions {
  maxWords: number;
  maxChars: number;
  functionWords?: Record<string, string[]>;
}

export interface CaptionPageDraft {
  phrase: number;
  clip: number;
  /** language of the words (the phrase's) */
  lang: string;
  start: number;
  end: number;
  words: OutWord[];
}

const ORPHAN_PENALTY = 1e6;
const OVER_WORD_PENALTY = 5000;
const OVER_CHAR_PENALTY = 1000;
const PUNCT_BONUS = 40;
const PAUSE_BONUS = 60;
const PAUSE_FULL = 0.5;

/** Orphan-aware pagination: splits each phrase into caption pages (never across phrases). */
export function paginatePhrases(phrases: OutPhrase[], opts: PaginateOptions): CaptionPageDraft[] {
  const sets = functionWordSets(opts.functionWords);
  const maxWords = Math.max(1, Math.floor(opts.maxWords));
  const maxChars = Math.max(1, Math.floor(opts.maxChars));
  const out: CaptionPageDraft[] = [];
  for (const p of phrases) {
    const words = p.words.filter((w) => displayWord(w.w, p.lang, false) !== "");
    if (words.length === 0) continue;
    for (const ws of splitPhrase(words, p.lang, maxWords, maxChars, sets)) {
      out.push({ phrase: p.phrase, clip: p.clip, lang: p.lang, start: ws[0].start, end: ws[ws.length - 1].end, words: ws });
    }
  }
  // stable: ties keep phrase order
  return out.map((d, i) => ({ d, i })).sort((a, b) => a.d.start - b.d.start || a.i - b.i).map((x) => x.d);
}

function splitPhrase(words: OutWord[], lang: string, maxWords: number, maxChars: number, sets: FunctionWordSets): OutWord[][] {
  const n = words.length;
  const len = words.map((w) => chars(displayWord(w.w, lang, false)));
  const orphan = words.map((w, i) => i < n - 1 && isFw(w.w, lang, sets));
  const bonus = words.map((w, i) => {
    if (i === n - 1) return 0;
    let b = CLAUSE_END.test(w.w.trim()) ? PUNCT_BONUS : 0;
    const gap = words[i + 1].start - w.end;
    if (gap > 0) b += (PAUSE_BONUS * Math.min(gap, PAUSE_FULL)) / PAUSE_FULL;
    return b;
  });
  const maxSpan = maxWords + 2;
  const best = new Array<number>(n + 1).fill(Infinity);
  const from = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    let c = -1;
    for (let i = j - 1; i >= 0 && j - i <= maxSpan; i--) {
      c += len[i] + 1;
      const k = j - i;
      let cost = Math.max(0, maxChars - c) ** 2;
      if (k > 1 && c > maxChars) cost += OVER_CHAR_PENALTY * (c - maxChars);
      if (k > maxWords) cost += OVER_WORD_PENALTY * (k - maxWords);
      if (j < n) cost += (orphan[j - 1] ? ORPHAN_PENALTY : 0) - bonus[j - 1];
      const total = best[i] + cost;
      if (total < best[j]) {
        best[j] = total;
        from[j] = i;
      }
    }
  }
  const pages: OutWord[][] = [];
  for (let j = n; j > 0; j = from[j]) pages.unshift(words.slice(from[j], j));
  return pages;
}

// ---------------------------------------------------------------- fitting (rules c, d, e)

function sizeSteps(base: number): number[] {
  const min = base * MIN_SIZE_RATIO;
  const out: number[] = [];
  for (let s = base; s >= min - 1e-9; s -= SIZE_STEP) out.push(s);
  if (out.length === 0 || out[out.length - 1] - min > 1e-9) out.push(min);
  return out;
}

/** width of items [a, b) with `gap` between them */
function spanWidth(widths: number[], gap: number, a: number, b: number): number {
  let w = 0;
  for (let i = a; i < b; i++) w += widths[i];
  return w + Math.max(0, b - a - 1) * gap;
}

interface Arrangement {
  /** break indices (exclusive line ends, last = n) */
  ends: number[];
  fits: boolean;
}

/**
 * One line if it fits, else the most balanced 2-line break that fits; a break after a function word is used only
 * when no other break fits. A break after clause punctuation (stripped from the display text) counts as
 * PUNCT_LINE_BONUS·maxWidth more balanced, so near-ties fall on the clause boundary.
 */
function arrangeCaption(widths: number[], gap: number, maxWidth: number, fwEnd: boolean[], punctEnd: boolean[], force: boolean): Arrangement | null {
  const n = widths.length;
  if (spanWidth(widths, gap, 0, n) <= maxWidth) return { ends: [n], fits: true };
  if (n === 1) return force ? { ends: [1], fits: false } : null;
  let bestK = -1;
  let bestScore = Infinity;
  let bestFw = true;
  for (let k = 1; k < n; k++) {
    const a = spanWidth(widths, gap, 0, k);
    const b = spanWidth(widths, gap, k, n);
    if (a > maxWidth || b > maxWidth) continue;
    const fw = fwEnd[k - 1];
    const score = Math.abs(a - b) - (punctEnd[k - 1] ? PUNCT_LINE_BONUS * maxWidth : 0);
    if ((bestFw && !fw) || (fw === bestFw && score < bestScore)) {
      bestK = k;
      bestScore = score;
      bestFw = fw;
    }
  }
  if (bestK > 0) return { ends: [bestK, n], fits: true };
  if (!force) return null;
  // nothing fits even at the smallest size: least overflow, still avoiding function-word endings when possible
  let k0 = 1;
  let worst = Infinity;
  let worstFw = true;
  for (let k = 1; k < n; k++) {
    const m = Math.max(spanWidth(widths, gap, 0, k), spanWidth(widths, gap, k, n));
    const fw = fwEnd[k - 1];
    if ((worstFw && !fw) || (fw === worstFw && m < worst)) {
      k0 = k;
      worst = m;
      worstFw = fw;
    }
  }
  return { ends: [k0, n], fits: false };
}

interface FittedPage {
  fontSize: number;
  wordGap: number;
  widths: number[];
  popScales: number[];
  ends: number[];
}

function fitPage(texts: string[], fwEnd: boolean[], punctEnd: boolean[], metrics: FontMetrics, base: number, maxWidth: number, popMax: number, popGrow: number): FittedPage {
  const steps = sizeSteps(base);
  for (let si = 0; si < steps.length; si++) {
    const size = steps[si];
    const widths = texts.map((t) => metrics.measure(t, size));
    const popScales = widths.map((w) => (popMax > 1 && w > 0 ? Math.min(popMax, 1 + (2 * popGrow) / w) : Math.min(popMax, 1)));
    const growth = widths.length > 1 ? Math.max(...widths.map((w, i) => Math.max(0, (w * (popScales[i] - 1)) / 2))) : 0;
    // rounded up once here so the reported line widths are exactly what a renderer gets with margin = wordGap
    const wordGap = Math.ceil((metrics.spaceWidth(size) + growth) * 100) / 100;
    const arr = arrangeCaption(widths, wordGap, maxWidth, fwEnd, punctEnd, si === steps.length - 1);
    if (arr) return { fontSize: size, wordGap, widths, popScales, ends: arr.ends };
  }
  throw new Error("unreachable: the last size step always yields an arrangement");
}

/**
 * A smaller block for a page that finds no free spot off the faces: one line at a smaller size if it fits down to
 * 0.6·base, else the same lines at 0.6·base. null when that would not be smaller.
 */
function fitCompact(texts: string[], metrics: FontMetrics, current: FittedPage, base: number, maxWidth: number, popMax: number, popGrow: number): FittedPage | null {
  const n = texts.length;
  for (const size of sizeSteps(base)) {
    if (size > current.fontSize + 1e-9) continue;
    const widths = texts.map((t) => metrics.measure(t, size));
    const popScales = widths.map((w) => (popMax > 1 && w > 0 ? Math.min(popMax, 1 + (2 * popGrow) / w) : Math.min(popMax, 1)));
    const growth = n > 1 ? Math.max(...widths.map((w, i) => Math.max(0, (w * (popScales[i] - 1)) / 2))) : 0;
    const wordGap = Math.ceil((metrics.spaceWidth(size) + growth) * 100) / 100;
    if (current.ends.length > 1 && spanWidth(widths, wordGap, 0, n) <= maxWidth) return { fontSize: size, wordGap, widths, popScales, ends: [n] };
  }
  const min = base * MIN_SIZE_RATIO;
  if (current.fontSize - min < 1) return null;
  const widths = texts.map((t) => metrics.measure(t, min));
  const popScales = widths.map((w) => (popMax > 1 && w > 0 ? Math.min(popMax, 1 + (2 * popGrow) / w) : Math.min(popMax, 1)));
  const growth = n > 1 ? Math.max(...widths.map((w, i) => Math.max(0, (w * (popScales[i] - 1)) / 2))) : 0;
  const wordGap = Math.ceil((metrics.spaceWidth(min) + growth) * 100) / 100;
  return { fontSize: min, wordGap, widths, popScales, ends: current.ends.map((e) => e) };
}

// ---------------------------------------------------------------- display windows (rule f)

interface Window {
  dispStart: number;
  dispEnd: number;
  exitFade: boolean;
}

function displayWindows(pages: { start: number; end: number }[], duration: number, fps: number, holdGap: number, tailHold: number): Window[] {
  const frame = 1 / fps;
  const out: Window[] = [];
  let prevEnd = 0;
  pages.forEach((p, i) => {
    const next = pages[i + 1];
    let dispStart = Math.max(p.start, prevEnd);
    let dispEnd: number;
    let exitFade: boolean;
    const limit = next ? next.start : duration;
    if (limit - p.end <= holdGap + 1e-9) {
      dispEnd = limit;
      exitFade = false;
    } else {
      dispEnd = Math.min(p.end + tailHold, limit);
      exitFade = true;
    }
    // ≥ 1 frame on screen; a later page whose start this pushes past is shifted (dispStart = max(start, prevEnd))
    dispStart = Math.max(prevEnd, Math.min(dispStart, duration - frame));
    dispEnd = Math.max(dispEnd, dispStart + frame);
    out.push({ dispStart: r6(dispStart), dispEnd: r6(dispEnd), exitFade });
    prevEnd = dispEnd;
  });
  return out;
}

// ---------------------------------------------------------------- titles (rule g)

const isDashToken = (t: string) => /^[—–]$/u.test(t) || /—$/u.test(t);

function* partitions(n: number, lines: number, start = 1): Generator<number[]> {
  if (lines === 1) {
    yield [n];
    return;
  }
  for (let k = start; k <= n - lines + 1; k++) for (const rest of partitions(n, lines - 1, k + 1)) yield [k, ...rest];
}

interface TitleFit {
  fontSize: number;
  ends: number[];
  widths: number[];
  gap: number;
}

function fitTitle(tokens: string[], metrics: FontMetrics, base: number, maxWidth: number, maxLines: number, sets: FunctionWordSets): TitleFit {
  const n = tokens.length;
  const dashAt = new Set(tokens.map((t, i) => (i < n - 1 && isDashToken(t) ? i + 1 : -1)).filter((i) => i > 0));
  const fwEnd = tokens.map((t, i) => i < n - 1 && isFw(t, null, sets));
  const lineCap = Math.max(1, Math.min(maxLines, n));
  const steps = sizeSteps(base);
  let fallback: TitleFit | null = null;
  for (const size of steps) {
    const widths = tokens.map((t) => metrics.measure(t, size));
    const gap = metrics.spaceWidth(size);
    for (let L = 1; L <= lineCap; L++) {
      let best: { ends: number[]; key: number[] } | null = null;
      for (const ends of partitions(n, L)) {
        let a = 0;
        let maxW = 0;
        let minW = Infinity;
        for (const e of ends) {
          const w = spanWidth(widths, gap, a, e);
          maxW = Math.max(maxW, w);
          minW = Math.min(minW, w);
          a = e;
        }
        if (maxW > maxWidth) continue;
        const breaks = ends.slice(0, -1);
        const key = [dashAt.size && !breaks.some((b) => dashAt.has(b)) ? 1 : 0, breaks.filter((b) => fwEnd[b - 1]).length, maxW - minW];
        if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && (key[1] < best.key[1] || (key[1] === best.key[1] && key[2] < best.key[2])))) best = { ends, key };
      }
      if (best) return { fontSize: size, ends: best.ends, widths, gap };
    }
    if (size === steps[steps.length - 1]) {
      // never fits: the max_lines split with the narrowest widest line
      let bestEnds = [n];
      let bestMax = Infinity;
      for (const ends of partitions(n, lineCap)) {
        let a = 0;
        let maxW = 0;
        for (const e of ends) {
          maxW = Math.max(maxW, spanWidth(widths, gap, a, e));
          a = e;
        }
        if (maxW < bestMax) {
          bestMax = maxW;
          bestEnds = ends;
        }
      }
      fallback = { fontSize: size, ends: bestEnds, widths, gap };
    }
  }
  return fallback!;
}

// ---------------------------------------------------------------- layout

function dominantLang(phrases: OutPhrase[]): string | null {
  const count = new Map<string, number>();
  for (const p of phrases) count.set(p.lang, (count.get(p.lang) ?? 0) + p.words.length);
  let best: string | null = null;
  let bestN = -1;
  for (const [lang, n] of count) if (n > bestN) [best, bestN] = [lang, n];
  return best;
}

/**
 * Where the title sits. Normally at titles.anchor_y (top). When the vision step located the face
 * high in the frame (its centre above titles.face_zone), a top title would cover the forehead, so
 * it moves to the band between the face and the captions.
 */
export function titleAnchor(D: DesignSpec, faceY?: number): number {
  if (!D.titles.avoid_face || faceY === undefined || !(faceY < D.titles.face_zone)) return D.titles.anchor_y;
  return r2(clamp(D.captions.anchor_y - 0.17, 0.5, Math.max(0.5, D.captions.anchor_y - 0.1)));
}

/**
 * The box a caption page covers (fractions of the frame): its lines at the page size and line height, the backing
 * pill (padding + margins) when enabled, the stroke, a little for the pop of the active word.
 */
export function captionBlock(D: DesignSpec, p: Pick<LayoutPage, "lines" | "fontSize" | "width">, W: number, H: number): { height: number; width: number } {
  const scale = Math.min(W, H) / 1080;
  const back = D.captions.backing;
  const strokePx = D.captions.stroke_width * scale;
  const lineH = p.fontSize * D.captions.line_height + (back.enabled ? 2 * back.padding * scale + 6 * scale : 0);
  const h = p.lines.length * lineH + 2 * strokePx + 0.06 * p.fontSize + 8 * scale;
  const w = p.width + (back.enabled ? 2 * (back.padding + 8) * scale : 0) + 2 * strokePx;
  return { height: h / H, width: Math.min(1, w / W) };
}

/** The box a title covers (fractions of the frame), by style: a card / hero title, a "lower" line, a callout label. */
export function titleBlock(D: DesignSpec, t: Pick<LayoutTitle, "style" | "lines" | "fontSize" | "width">, W: number, H: number, measure: FontMetrics["measure"]): { height: number; width: number } {
  const scale = Math.min(W, H) / 1080;
  const strokePx = D.captions.stroke_width * scale;
  if (t.style === "lower") {
    const fs = D.captions.font_size * scale * 0.72;
    const textW = measure(t.lines.join(" "), fs) + 1.2 * fs;
    const n = Math.max(1, Math.ceil(textW / (W - 2 * D.safe_area.x * W)));
    return { height: (n * fs * 1.2 + 0.56 * fs) / H, width: Math.min(1, Math.min(W - 2 * D.safe_area.x * W, textW) / W) };
  }
  if (t.style === "callout") {
    const fs = Math.min(t.fontSize, D.titles.font_size * scale) * 0.6;
    return { height: (fs * 1.25 + 12 * scale) / H, width: Math.min(1, (measure(t.lines.join(" "), fs) + 0.84 * fs) / W) };
  }
  const card = t.style === "card";
  return {
    height: (t.lines.length * t.fontSize * 1.08 + (card ? 2 * D.titles.padding * scale : 2 * strokePx) + 8 * scale) / H,
    width: Math.min(1, (t.width + (card ? 2 * (D.titles.padding + 12) * scale : 2 * strokePx)) / W),
  };
}

const normTok = (s: string, lang: string) => lower(displayWord(s, lang, false), lang).replace(/[^\p{L}\p{N}]/gu, "");

/**
 * stage 27: when each line of a two-line hook title appears — line 1 at the title start, a later line on the word that
 * opens it when the speaker says it inside the title window (reel #14: «ОТ ИЛОНА МАСКА» pops in on «от»), else 0.35 s
 * after the line before it.
 */
export function titleLineTimes(lines: string[], at: number, dur: number, words: { w: string; start: number }[], lang: string): number[] {
  const out = [at];
  for (let k = 1; k < lines.length; k++) {
    const first = normTok(lines[k].split(" ")[0] ?? "", lang);
    const prev = out[k - 1];
    const hit = first ? words.find((w) => w.start > prev + 0.15 && w.start < at + dur - 0.4 && normTok(w.w, lang) === first) : undefined;
    out.push(r6(hit ? hit.start : Math.min(prev + 0.35, at + Math.max(0, dur - 0.5))));
  }
  return out;
}

/** A stand-in face for a vertical reel without any face data: where a talking head usually is. */
export function typicalFaceTrack(split: boolean, duration: number): FaceTrack {
  const box: [number, number, number, number] = split ? [0.3, 0.6, 0.7, 0.8] : [0.2, 0.22, 0.8, 0.64];
  return { source: "none", fps: 1, samples: Array.from({ length: Math.ceil(duration) + 2 }, (_, t) => ({ t, boxes: [box] })) };
}

export function buildLayout(job: DesignJob, metrics: FontMetrics, opts: LayoutOptions = {}): Layout {
  const D = DesignSpecSchema.parse(job.design ?? {});
  const t = job.timeline;
  const W = t.width;
  const H = t.height;
  const fps = t.fps > 0 ? t.fps : 30;
  const scale = Math.min(W, H) / 1080; // spec sizes are px on a 1080-wide portrait frame; landscape scales by its height
  const duration = r6(Math.ceil(t.duration * fps - 1e-6) / fps);
  const holdGap = opts.holdGap ?? DEFAULT_HOLD_GAP;
  const tailHold = opts.tailHold ?? DEFAULT_TAIL_HOLD;
  const popGrow = (opts.popGrowPx ?? DEFAULT_POP_GROW_PX) * scale;
  const sets = functionWordSets(opts.functionWords);
  const captionsLang = job.captions_language ?? null;
  const language = captionsLang ?? dominantLang(t.phrases) ?? "";

  // captions
  const capMax = Math.min(W - 2 * D.safe_area.x * W, 0.8 * W);
  const capBase = D.captions.font_size * scale;
  const popMax = D.captions.word_animation === "pop" ? D.captions.pop_scale : 1;
  const letterCase = captionCase(D);
  const drafts = t.captions?.enabled === false ? [] : paginatePhrases(t.phrases, { maxWords: D.captions.max_words, maxChars: D.captions.max_chars, functionWords: opts.functionWords });
  const windows = displayWindows(drafts, duration, fps, holdGap, tailHold);
  const fitted = drafts.map((d) => {
    const caseLang = captionsLang ?? d.lang;
    const texts = d.words.map((w) => casedWord(w.w, caseLang, letterCase));
    const fwEnd = d.words.map((w) => isFw(w.w, d.lang, sets));
    const punctEnd = d.words.map((w) => CLAUSE_END.test(w.w.trim()));
    return { texts, fit: fitPage(texts, fwEnd, punctEnd, metrics, capBase, capMax, popMax, popGrow) };
  });
  const makePage = (index: number, fit: FittedPage): LayoutPage => {
    const d = drafts[index];
    const texts = fitted[index].texts;
    const words: LayoutWord[] = d.words.map((w, i) => ({
      text: texts[i],
      raw: w.w,
      start: w.start,
      end: w.end,
      width: r2(fit.widths[i]),
      popScale: Math.floor(fit.popScales[i] * 1e4) / 1e4,
    }));
    const lines: LayoutLine[] = [];
    let a = 0;
    for (const e of fit.ends) {
      lines.push({ words: words.slice(a, e), width: r2(spanWidth(fit.widths, fit.wordGap, a, e)) });
      a = e;
    }
    return {
      index,
      start: d.start,
      end: d.end,
      ...windows[index],
      fontSize: r2(fit.fontSize),
      wordGap: fit.wordGap,
      lines,
      width: Math.max(...lines.map((l) => l.width)),
    };
  };
  const pages: LayoutPage[] = drafts.map((_, index) => makePage(index, fitted[index].fit));

  // stage 23: pages (and titles below) placed off the faces, inside the Reels safe area
  const avoid = D.captions.avoid_face;
  const faces = job.faces;
  const safe = safeAreaFor(W, H, D.safe_area.y);
  const strokePx = D.captions.stroke_width * scale;
  const capBlock = (p: Pick<LayoutPage, "lines" | "fontSize" | "width">) => captionBlock(D, p, W, H);
  const extra: Obstacle[] = [];
  if (D.layout === "split" && job.panels) {
    const hk = hookExtent(W, H, D, job.panels, duration, job.sections);
    if (hk) extra.push({ ...hk, lo: hk.lo - 0.01, hi: hk.hi + 0.01 });
  }
  // a split speaker's face fills the bottom box: the hair above the face box sits higher than in a full frame
  const placeOpts: PlaceOptions = { safe, extra, ...(D.layout === "split" ? { padAbove: 0.08 } : {}) };
  let moved = 0;
  let compact = 0;
  let leastOverlap = 0;
  if (avoid && pages.length) {
    const reqs: BlockRequest[] = pages.map((p, i) => ({ start: p.dispStart, end: p.dispEnd, ...capBlock(p), preferred: D.captions.anchor_y, clip: drafts[i].clip }));
    const compacts = new Map<number, LayoutPage>();
    const alternatives = (i: number): BlockRequest | null => {
      const c = fitCompact(fitted[i].texts, metrics, fitted[i].fit, capBase, capMax, popMax, popGrow);
      if (!c) return null;
      const page = makePage(i, c);
      compacts.set(i, page);
      return { ...reqs[i], ...capBlock(page) };
    };
    // no face information at all on a vertical reel: assume the usual talking-head face (upper middle; the bottom
    // box in split) for the captions, so a centred anchor still lands under the chin; titles keep their slots
    const capFaces = faces && faces.source !== "none" ? faces : H > W ? typicalFaceTrack(D.layout === "split", duration) : faces;
    const placed = placeSequence(reqs, capFaces, placeOpts, alternatives);
    placed.forEach((pl, i) => {
      if (pl.alt && compacts.has(i)) {
        pages[i] = compacts.get(i)!;
        compact++;
      }
      pages[i].anchorY = pl.y;
      pages[i].place = pl.rule;
      if (pl.rule !== "preferred") moved++;
      if (pl.rule === "least_overlap") leastOverlap++;
    });
  }

  // titles
  const ttlBase = D.titles.font_size * scale;
  const ttlMax = Math.min(W - 2 * D.safe_area.x * W - 2 * (D.titles.padding + TITLE_EXTRA_PAD) * scale, 0.8 * W);
  const titlesOut: LayoutTitle[] = [];
  const allWords = t.phrases.flatMap((p) => p.words);
  for (const title of t.titles) {
    const plain = title.style === "plain";
    const raw = title.text.normalize("NFC").replace(/\s+/gu, " ").trim();
    // stage 27 "plain" hook: caps (in the caption language), measured as drawn; heavier than the caption weight → 10 % margin
    const text = plain && D.titles.plain_uppercase ? upper(raw, language) : raw;
    const at = r6(clamp(title.at, 0, duration));
    const dur = r6(Math.min(title.duration, duration - at));
    if (!text || dur <= 0) continue;
    const tokens = text.split(" ");
    const fit = fitTitle(tokens, metrics, ttlBase, plain ? ttlMax * 0.9 : ttlMax, D.titles.max_lines, sets);
    const lines: string[] = [];
    let width = 0;
    let a = 0;
    for (const e of fit.ends) {
      lines.push(tokens.slice(a, e).join(" "));
      width = Math.max(width, spanWidth(fit.widths, fit.gap, a, e));
      a = e;
    }
    const accent = (title.accent_words ?? []).map((w) => (plain && D.titles.plain_uppercase ? upper(w, language) : w)).filter((w) => w.trim());
    const lineAt = plain && lines.length > 1 ? titleLineTimes(lines, at, dur, allWords, language) : undefined;
    titlesOut.push({ index: titlesOut.length, at, duration: dur, text, style: title.style, fontSize: r2(fit.fontSize), lines, width: r2(width), ...(accent.length ? { accent } : {}), ...(lineAt ? { lineAt } : {}) });
  }
  const tracked = !!faces && faces.source !== "none";
  let outroAnchorY: number | undefined;
  if (avoid && D.layout !== "split") {
    // captions already placed are obstacles for a title on screen at the same time
    const capObs: Obstacle[] = pages.map((p) => {
      const b = capBlock(p);
      const y = p.anchorY ?? D.captions.anchor_y;
      return { lo: y - b.height / 2 - 0.01, hi: y + b.height / 2 + 0.01, x0: 0.5 - b.width / 2, x1: 0.5 + b.width / 2, start: p.dispStart, end: p.dispEnd };
    });
    for (const t of titlesOut) {
      const { height, width } = titleBlock(D, t, W, H, metrics.measure);
      const preferred = t.style === "lower" ? D.captions.anchor_y : t.style === "callout" ? CALLOUT_ANCHOR_Y : t.style === "plain" ? D.titles.plain_anchor_y : tracked ? D.titles.anchor_y : titleAnchor(D, job.face_y);
      const pl = placeBlock({ start: t.at, end: t.at + t.duration, height, width, preferred }, faces, { ...placeOpts, extra: [...extra, ...capObs] });
      t.anchorY = pl.y;
      t.place = pl.rule;
    }
    // the outro CTA (centred over the last seconds): off the faces too, the captions under it are obstacles
    const ot = D.outro.enabled && duration > D.outro.duration + 1 ? outroText(D, language || "ru", W, H) : null;
    if (ot && tracked) {
      const start = duration - D.outro.duration;
      const width = Math.min(1, (Math.max(...ot.lines.map((l) => metrics.measure(l, ot.fontSize))) + 2 * strokePx) / W);
      const pl = placeBlock({ start, end: duration, height: (ot.lines.length * ot.fontSize * 1.1 + 8 * scale) / H, width, preferred: 0.5 }, faces, { ...placeOpts, extra: [...extra, ...capObs] });
      if (pl.rule !== "preferred") outroAnchorY = pl.y;
    }
  }

  // stage 33 (format A): over the full-frame parts the captions move from the seam to the chest
  if (job.sections?.length && D.captions.anchor_y_full !== undefined) {
    for (const p of pages) if (sectionAt(job.sections, p.dispStart + 0.01) !== "split") p.anchorY = D.captions.anchor_y_full;
  } else if (D.layout === "split" && isLightHex(D.split.panel_bg) && D.split.panel_frame !== "edge" && D.captions.anchor_y_full !== undefined && job.panels && job.panels.panels.length >= 3) {
    // explainer studio mode: during middle panels (1 .. N-2) the speaker slides down and captions sit at anchor_y_full (0.74) below the large card
    const tHide = job.panels.panels[1]!.start;
    const tShow = job.panels.panels[job.panels.panels.length - 1]!.start;
    for (const p of pages) {
      const mid = (p.dispStart + p.dispEnd) / 2;
      if (mid >= tHide && mid < tShow) p.anchorY = D.captions.anchor_y_full;
    }
  }
  // stage 33: the hook plate carries the hook's words — captions start when it leaves (his editors: plate, then captions)
  const plate = hookPlateWindow(D, job, duration);
  let shown = pages;
  if (plate) {
    shown = pages.filter((p) => p.dispEnd > plate.end + 0.05);
    for (const p of shown) if (p.dispStart < plate.end) p.dispStart = r6(plate.end);
  }

  return {
    frame: { width: W, height: H, fps, duration },
    captions: { anchorY: D.captions.anchor_y, maxWidth: r2(capMax), baseFontSize: r2(capBase), strokeWidth: r2(D.captions.stroke_width * scale), uppercase: D.captions.uppercase, language },
    titles: { anchorY: titleAnchor(D, job.face_y), maxWidth: r2(ttlMax), baseFontSize: r2(ttlBase) },
    ...(avoid ? { faces: { source: faces?.source ?? "none", avoid, moved, compact, least_overlap: leastOverlap, safe: { top: r2(safe.top), bottom: r2(safe.bottom) } } } : {}),
    pages: shown,
    titlesOut,
    ...(outroAnchorY !== undefined ? { outroAnchorY } : {}),
    font: { family: metrics.family, file: metrics.file, weight: D.font.weight, source: metrics.source },
    version: LAYOUT_VERSION,
  };
}

/**
 * stage 33: when the blue hook plate is on screen (start → end of its exit), or null: a split reel with
 * design.split.hook "plate" and a hook title, or a full-frame reel whose first title (at the start) becomes the plate.
 */
export function hookPlateWindow(D: DesignSpec, job: Pick<DesignJob, "panels" | "timeline">, duration: number): { start: number; end: number } | null {
  if (!D.hook_plate.enabled) return null;
  if (D.layout === "split") {
    if (D.split.hook !== "plate" || !job.panels?.hook_title.length) return null;
    const t = hookPlateTiming(D.hook_plate.hold, duration, 0);
    return { start: t.start, end: t.end };
  }
  const first = job.timeline.titles.find((t) => t.at < 0.5 && t.style !== "lower" && t.style !== "callout");
  if (!first) return null;
  const t = hookPlateTiming(D.hook_plate.hold, duration, first.at);
  return { start: t.start, end: t.end };
}
