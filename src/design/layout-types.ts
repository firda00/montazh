// Contract between the layout engine (src/design/layout.ts) and the composition generators.
// All sizes are CSS pixels at the output frame size; all times are output seconds.

export interface FontMetrics {
  family: string;
  file: string;
  /** "opentype" when advance widths come from the TTF, "heuristic" when estimated */
  source: "opentype" | "heuristic";
  /** advance width of `text` at `fontSizePx` (letter-spacing not included) */
  measure(text: string, fontSizePx: number): number;
  /** width of one space at `fontSizePx` */
  spaceWidth(fontSizePx: number): number;
}

export interface LayoutWord {
  /** display text (already uppercased / punctuation-stripped as the spec says) */
  text: string;
  /** original transcript token */
  raw: string;
  start: number;
  end: number;
  /** measured advance width at the page font size */
  width: number;
  /** scale the pop animation may reach without touching neighbours (≤ design.captions.pop_scale) */
  popScale: number;
}

export interface LayoutLine {
  words: LayoutWord[];
  /** total width incl. gaps at the page font size */
  width: number;
}

export interface LayoutPage {
  index: number;
  /** speech window of the page */
  start: number;
  end: number;
  /** display window: start, and end extended through short pauses (never past the next page's start) */
  dispStart: number;
  dispEnd: number;
  /** true when the page should fade out at dispEnd (long pause follows) instead of hard-cutting to the next page */
  exitFade: boolean;
  fontSize: number;
  /** gap between words at this font size (px) */
  wordGap: number;
  lines: LayoutLine[];
  /** widest line (px) */
  width: number;
}

export interface LayoutTitle {
  index: number;
  at: number;
  duration: number;
  text: string;
  style: string;
  fontSize: number;
  lines: string[];
  width: number;
}

export interface Layout {
  frame: { width: number; height: number; fps: number; duration: number };
  captions: { anchorY: number; maxWidth: number; baseFontSize: number; strokeWidth: number; uppercase: boolean; language: string };
  titles: { anchorY: number; maxWidth: number; baseFontSize: number };
  pages: LayoutPage[];
  titlesOut: LayoutTitle[];
  font: { family: string; file: string; weight: number; source: FontMetrics["source"] };
  /** engine version, for cache keys */
  version: string;
}

export interface LayoutOptions {
  /** pauses up to this long are bridged by holding the previous page (s) */
  holdGap?: number;
  /** a page followed by a longer pause stays this long after its last word, then fades (s) */
  tailHold?: number;
  /** max growth of a popped word per side (px, at 1080 width; scaled by width/1080) */
  popGrowPx?: number;
  /** words a caption line/page must not end on, per language code */
  functionWords?: Record<string, string[]>;
}
