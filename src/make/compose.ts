import { splitBalanced } from "../design/hyperframes/compose.ts";
import type { FontMetrics } from "../design/layout-types.ts";
import type { Script } from "./script.ts";

/**
 * Script → HyperFrames composition: one section per beat (icon + sentence with word reveal),
 * a kicker, a progress bar, a slow background glow. No video, no audio: music is muxed after the
 * render. Pure and deterministic: same inputs → byte-identical HTML.
 */

export interface MakeStyle {
  bg1: string;
  bg2: string;
  glow: string;
  text: string;
  accent: string;
  muted: string;
  fontFamily: string;
  fontWeight: number;
}

export const DEFAULT_STYLE: MakeStyle = {
  bg1: "#0B0F1A",
  bg2: "#1A2242",
  glow: "rgba(255,214,0,0.18)",
  text: "#FFFFFF",
  accent: "#FFD600",
  muted: "rgba(255,255,255,0.55)",
  fontFamily: "Inter",
  fontWeight: 800,
};

export interface ComposeOptions {
  /** icon name → inline <svg> markup */
  icons: Record<string, string>;
  fontRel: string;
  gsapRel: string;
  kicker?: string;
  style?: Partial<MakeStyle>;
  width?: number;
  height?: number;
  fps?: number;
  /** measured glyph widths (opentype); without them line fitting falls back to a character estimate */
  metrics?: FontMetrics;
}

export interface BeatTiming {
  index: number;
  start: number;
  duration: number;
}

export interface ComposeResult {
  html: string;
  duration: number;
  beats: BeatTiming[];
  width: number;
  height: number;
  fps: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MAX_LINES = 3;
const MIN_FONT = 48;

/**
 * Font size and line split for a sentence on a 1080-wide frame (px before scale). With metrics: the
 * largest size (from the base down in steps of 4) at which the sentence fits ≤ MAX_LINES lines of
 * ≤ maxWidthPx each, measured with the real glyph widths; without metrics: a character estimate
 * (bold Cyrillic ≈ 0.64 em per character).
 */
export function fitSentence(text: string, maxWidthPx: number, hook = false, metrics?: FontMetrics): { fontSize: number; lines: string[] } {
  const base = hook ? 100 : 88;
  const words = text.split(/\s+/).filter(Boolean);
  const widest = (lines: string[], size: number) => Math.max(...lines.map((l) => (metrics ? metrics.measure(l, size) : l.length * size * 0.64)));
  for (let size = base; size >= MIN_FONT; size -= 4) {
    // the longest word must fit on its own; then the fewest lines that fit
    if (widest(words, size) > maxWidthPx) continue;
    for (let n = 1; n <= MAX_LINES; n++) {
      const lines = n === 1 ? [words.join(" ")] : splitBalanced(text, n);
      if (lines.length <= n && widest(lines, size) <= maxWidthPx) return { fontSize: size, lines };
    }
  }
  // nothing fits: smallest size, most lines, let it be
  return { fontSize: MIN_FONT, lines: splitBalanced(text, MAX_LINES) };
}

/** Beat start/duration on the output timeline, rounded to the frame grid so sections never overlap or gap. */
export function timeBeats(script: Script, fps: number): { beats: BeatTiming[]; duration: number } {
  const beats: BeatTiming[] = [];
  let frame = 0;
  script.beats.forEach((b, index) => {
    const frames = Math.max(1, Math.round(b.seconds * fps));
    beats.push({ index, start: r3(frame / fps), duration: r3(frames / fps) });
    frame += frames;
  });
  return { beats, duration: r3(frame / fps) };
}

/** The words of one line as spans; the emphasis words get the accent class. */
function wordSpans(line: string, emphasis: string, id: string, lineIndex: number): string {
  const em = new Set(emphasis.toLowerCase().split(/\s+/).filter(Boolean));
  return line
    .split(/\s+/)
    .filter(Boolean)
    .map((w, wi) => {
      const bare = w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      const cls = em.has(bare) ? "w em" : "w";
      return `<span class="${cls}" id="${id}-l${lineIndex}-w${wi}">${esc(w)}</span>`;
    })
    .join(" ");
}

export function composeMake(script: Script, o: ComposeOptions): ComposeResult {
  const S: MakeStyle = { ...DEFAULT_STYLE, ...(o.style ?? {}) };
  const W = o.width ?? 1080;
  const H = o.height ?? 1920;
  const FPS = o.fps ?? 30;
  const scale = Math.min(W, H) / 1080;
  const { beats, duration: DUR } = timeBeats(script, FPS);
  const safeX = Math.round(0.09 * W);
  const maxText = W - 2 * safeX;
  const tw: string[] = [];
  const sections: string[] = [];

  script.beats.forEach((b, i) => {
    const t = beats[i];
    const id = `beat-${i}`;
    const hook = i === 0;
    const fit = fitSentence(b.text, maxText / scale, hook, o.metrics);
    const lines = fit.lines.map((line, li) => `          <span class="line" id="${id}-line${li}">${wordSpans(line, b.emphasis, id, li)}</span>`).join("\n");
    const icon = o.icons[b.icon] ?? "";
    sections.push(
      [
        `      <section id="${id}" class="clip beat${hook ? " hook" : ""}${i === script.beats.length - 1 ? " cta" : ""}" data-start="${fmt(t.start)}" data-duration="${fmt(t.duration)}" data-track-index="1">`,
        `        <span class="ico" id="${id}-ico">${icon}</span>`,
        `        <span class="txt" id="${id}-txt" style="font-size:${r3(fit.fontSize * scale)}px">`,
        lines,
        `        </span>`,
        `        <span class="idx" id="${id}-idx">${i + 1} / ${script.beats.length}</span>`,
        `      </section>`,
      ].join("\n"),
    );
    // entrance: icon pops, lines rise one after another; exit: fade in the last 0.25 s
    tw.push(`tl.fromTo("#${id}-ico", { opacity: 0, scale: 0.6, y: ${r3(30 * scale)} }, { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: "back.out(1.6)" }, ${fmt(t.start)});`);
    fit.lines.forEach((_, li) => {
      tw.push(`tl.fromTo("#${id}-line${li}", { opacity: 0, y: ${r3(48 * scale)} }, { opacity: 1, y: 0, duration: 0.42, ease: "power3.out" }, ${fmt(t.start + 0.12 + li * 0.1)});`);
    });
    if (b.emphasis) {
      const sel = fit.lines.flatMap((line, li) => line.split(/\s+/).filter(Boolean).map((w, wi) => ({ w, li, wi }))).filter(({ w }) => b.emphasis.toLowerCase().split(/\s+/).includes(w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")));
      if (sel.length) tw.push(`tl.fromTo("${sel.map((s) => `#${id}-l${s.li}-w${s.wi}`).join(", ")}", { color: "${S.text}" }, { color: "${S.accent}", duration: 0.3, ease: "power1.out", immediateRender: false }, ${fmt(t.start + 0.12 + fit.lines.length * 0.1 + 0.35)});`);
    }
    if (t.duration >= 2) {
      const outAt = t.start + t.duration - 0.25;
      tw.push(`tl.fromTo("#${id}-ico, #${id}-txt", { opacity: 1 }, { opacity: 0, duration: 0.22, ease: "power1.in", immediateRender: false }, ${fmt(outAt)});`);
    }
  });

  const kicker = (o.kicker ?? script.title).trim();
  const html = `<!doctype html>
<html lang="${esc(script.language)}" data-resolution="${W >= H ? "landscape" : "portrait"}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- generated by vedit make/1 · ${esc(script.title)} -->
    <script src="${o.gsapRel}"></script>
    <style>
      @font-face { font-family: "${esc(S.fontFamily)}"; src: url("${o.fontRel}") format("truetype"); font-weight: 100 900; font-style: normal; font-display: block; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${S.bg1}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: "${esc(S.fontFamily)}", sans-serif; color: ${S.text}; background: linear-gradient(170deg, ${S.bg2} 0%, ${S.bg1} 70%); }
      .bg { position: absolute; inset: 0; display: block; pointer-events: none; }
      .glow { position: absolute; left: ${r3(-0.3 * W)}px; top: ${r3(-0.1 * H)}px; width: ${r3(1.2 * W)}px; height: ${r3(0.7 * H)}px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${S.glow}, rgba(0,0,0,0)); }
      .kick { position: absolute; left: ${safeX}px; right: ${safeX}px; top: ${r3(0.075 * H)}px; display: block; text-align: center; font-size: ${r3(30 * scale)}px; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; color: ${S.muted}; }
      .rail { position: absolute; left: ${safeX}px; right: ${safeX}px; bottom: ${r3(0.07 * H)}px; height: ${r3(8 * scale)}px; display: block; border-radius: ${r3(4 * scale)}px; background: rgba(255,255,255,0.14); overflow: hidden; }
      .bar { display: block; height: 100%; width: 100%; background: ${S.accent}; transform-origin: left center; }
      .beat { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 0 ${safeX}px; pointer-events: none; }
      .ico { display: block; width: ${r3(190 * scale)}px; height: ${r3(190 * scale)}px; margin-bottom: ${r3(56 * scale)}px; color: ${S.accent}; }
      .ico .icon { width: 100%; height: 100%; }
      .txt { display: block; text-align: center; font-weight: ${S.fontWeight}; line-height: 1.12; letter-spacing: -0.015em; }
      .hook .txt { letter-spacing: -0.02em; }
      .line { display: block; white-space: nowrap; }
      .w { display: inline-block; }
      .cta .ico { color: ${S.text}; }
      .idx { position: absolute; left: 0; right: 0; bottom: ${r3(0.095 * H)}px; display: block; text-align: center; font-size: ${r3(26 * scale)}px; font-weight: 600; color: ${S.muted}; letter-spacing: 0.08em; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-width="${W}"
      data-height="${H}"
      data-duration="${fmt(DUR)}"
      data-fps="${FPS}"
    >
      <section id="bg" class="clip bg" data-start="0" data-duration="${fmt(DUR)}" data-track-index="0">
        <span class="glow" id="bg-glow"></span>
        <span class="kick" id="bg-kick">${esc(kicker)}</span>
        <span class="rail" id="bg-rail"><span class="bar" id="bg-bar"></span></span>
      </section>
${sections.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#bg-glow", { x: 0, y: 0 }, { x: ${r3(0.25 * W)}, y: ${r3(0.12 * H)}, duration: ${fmt(DUR)}, ease: "sine.inOut" }, 0);
      tl.fromTo("#bg-bar", { scaleX: 0 }, { scaleX: 1, duration: ${fmt(DUR)}, ease: "none" }, 0);
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration: DUR, beats, width: W, height: H, fps: FPS };
}
