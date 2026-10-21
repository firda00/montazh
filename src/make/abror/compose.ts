import type { DesignSpec } from "../../schemas/index.ts";
import { anchorPad, ctaLayer, esc, hookPlateLayer, hookPlateTiming, paneBackground, paneCss, renderPane, type Pane } from "../../design/abror.ts";

/**
 * Stage 33: the faceless demo reel in Abror's format B without the talking head — every second is a full-frame insert
 * (article / site / logo / number / text / photo) changing on the noun being said, the blue hook plate over the first
 * seconds, Uzbek captions as the light-blue karaoke plate (S2: the plate takes the whole page at once, words appear as
 * they are said), the comment-word CTA over the last line. One deterministic HyperFrames composition.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));

export interface Segment {
  start: number;
  end: number;
  pane: Pane | null;
  /** what the sheet labels it with */
  label: string;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionPage {
  start: number;
  end: number;
  words: CaptionWord[];
}

/** 1–3 words, ≤ maxChars, never across a sentence end; a page holds until the next one (or 0.35 s after its last word). */
export function captionPages(words: CaptionWord[], maxWords = 3, maxChars = 22, hold = 0.35): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length) pages.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const len = [...cur, w].map((x) => x.text).join(" ").length;
    if (cur.length && (cur.length >= maxWords || len > maxChars || w.start - cur[cur.length - 1].end > 0.45)) flush();
    cur.push(w);
    if (/[.!?…:;]$/.test(w.text)) flush();
  }
  flush();
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    pages[i].end = r3(next && next.start - pages[i].end < 0.6 ? next.start : pages[i].end + hold);
  }
  return pages;
}

/** Caption display text: lower-case as spoken (brands too, like his editors), punctuation at the ends dropped. */
export const captionText = (t: string) => t.toLocaleLowerCase("uz").replace(/^[«"“(]+|[»"”),.!?…:;]+$/g, "");

export interface FacelessInput {
  W: number;
  H: number;
  fps: number;
  duration: number;
  design: DesignSpec;
  segments: Segment[];
  words: CaptionWord[];
  hookLines: string[];
  cta: { kind: "keyword" | "phone"; value: string; label: string; start: number } | null;
  /** absolute picture file → project-relative src */
  rel: (file: string) => string;
  fontFamily: string;
  fontRel: string;
  gsapRel: string;
  /** small corner tag («AI ovoz · demo») */
  badge?: string;
  /** job id, for the generator comment */
  id: string;
}

export interface FacelessComposition {
  html: string;
  /** sound cues: a whoosh on every picture change, a pop on the plate, a ding on the CTA */
  cues: { t: number; kind: "whoosh" | "pop" | "ding" | "swipe"; gain: number }[];
  pages: CaptionPage[];
  plate: { start: number; end: number };
}

export function composeFaceless(i: FacelessInput): FacelessComposition {
  const { W, H } = i;
  const D = i.design;
  const k = W / 1080;
  const DUR = r3(i.duration);
  const font = `'${i.fontFamily}', sans-serif`;
  const sections: string[] = [];
  const tw: string[] = [];
  const cues: FacelessComposition["cues"] = [];
  const content = { x: 0.07 * W, y: 0.085 * H, w: 0.86 * W, h: 0.54 * H };
  let usesPanes = false;

  sections.push(`      <section id="bg" class="clip fl-bg" data-start="0" data-duration="${fmt(DUR)}" data-track-index="1"></section>`);
  i.segments.forEach((s, n) => {
    const end = Math.min(DUR, s.end);
    if (end - s.start < 0.05) return;
    const id = `pn${n}`;
    if (!s.pane) {
      sections.push(`      <section id="${id}" class="clip fl-pane" data-start="${fmt(s.start)}" data-duration="${fmt(end - s.start)}" data-track-index="2"><span class="ab-pane dark" style="left:0;top:0;width:${W}px;height:${H}px"></span></section>`);
      return;
    }
    usesPanes = true;
    const r = renderPane(s.pane, { id, start: s.start, end, box: { x: 0, y: 0, w: W, h: H }, content, rel: i.rel, font, k });
    sections.push(`      <section id="${id}" class="clip fl-pane" data-start="${fmt(s.start)}" data-duration="${fmt(end - s.start)}" data-track-index="2">\n        <span class="ab-pane ${paneBackground(s.pane)}" id="${id}-box" style="left:0;top:0;width:${W}px;height:${H}px">${r.html}</span>\n      </section>`);
    tw.push(...r.tweens);
    if (n > 0) cues.push({ t: r3(Math.max(0, s.start - 0.08)), kind: s.pane.kind === "site" || s.pane.kind === "article" ? "swipe" : "whoosh", gain: -12 });
  });

  // the hook plate: under the first picture, 3–5 s, out to the left with a blur
  const plateT = hookPlateTiming(D.hook_plate.hold, DUR, 0);
  let plateCss = "";
  if (i.hookLines.length) {
    const plate = hookPlateLayer({ W, H, spec: D.hook_plate, lines: i.hookLines, anchorY: D.hook_plate.anchor_y_full, start: 0, duration: DUR, font, id: "plate", trackIndex: 6 });
    sections.push(plate.html);
    tw.push(...plate.tweens);
    plateCss = plate.css;
    cues.push({ t: 0.02, kind: "pop", gain: -9 });
    cues.push({ t: r3(plateT.exitAt), kind: "whoosh", gain: -13 });
  }

  // captions: S2 light-blue karaoke, the plate under the whole page at once, words appear as said
  const C = D.captions;
  const allPages = captionPages(i.words.map((w) => ({ ...w, text: captionText(w.text) })).filter((w) => w.text), C.max_words, C.max_chars);
  const pages = i.hookLines.length ? allPages.filter((p) => p.end > plateT.end + 0.05).map((p) => ({ ...p, start: Math.max(p.start, plateT.end) })) : allPages;
  const pad = anchorPad(C.anchor_y, H);
  const size = r1(C.font_size * k);
  pages.forEach((p, n) => {
    const id = `cp${n}`;
    const end = Math.min(DUR, p.end);
    if (end - p.start < 0.05) return;
    const spans = p.words.map((w, m) => `<span class="kc-w" id="${id}-w${m}">${esc(w.text)}</span>`).join(" ");
    sections.push(`      <section id="${id}" class="clip kc" data-start="${fmt(p.start)}" data-duration="${fmt(end - p.start)}" data-track-index="8" style="padding:${pad.top}px ${r1(0.06 * W)}px ${pad.bottom}px"><span class="kc-box" style="font-size:${size}px">${spans}</span></section>`);
    p.words.forEach((w, m) => tw.push(`tl.fromTo("#${id}-w${m}", { opacity: 0, y: ${r1(10 * k)} }, { opacity: 1, y: 0, duration: 0.08, ease: "power2.out" }, ${fmt(Math.max(p.start, w.start))});`));
  });

  // CTA: the comment word over a dark backdrop
  let ctaCss = "";
  if (i.cta && i.cta.value.trim() && i.cta.start < DUR - 0.5) {
    const c = ctaLayer({ W, H, kind: i.cta.kind, value: i.cta.value, label: i.cta.label, start: i.cta.start, end: DUR, anchorY: 0.4, font, id: "cta", trackIndex: 9 });
    sections.push(c.html);
    tw.push(...c.tweens);
    ctaCss = c.css;
    cues.push({ t: r3(i.cta.start), kind: "ding", gain: -10 });
  }
  if (i.badge) sections.push(`      <section id="badge" class="clip fl-badge" data-start="0" data-duration="${fmt(DUR)}" data-track-index="10"><span class="fl-tag">${esc(i.badge)}</span></section>`);

  const html = `<!doctype html>
<html lang="uz" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- generated by vedit stage 33 (abror faceless) · ${esc(i.id)} -->
    <script src="${i.gsapRel}"></script>
    <style>
      @font-face { font-family: "${esc(i.fontFamily)}"; src: url("${i.fontRel}") format("truetype"); font-weight: 100 900; font-style: normal; font-display: block; }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #0C1124; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; font-family: ${font}; }
      .fl-bg { position: absolute; inset: 0; display: block; background: radial-gradient(120% 80% at 50% 20%, #1B2547 0%, #0C1124 70%); }
      .fl-pane { position: absolute; inset: 0; display: block; overflow: hidden; }
      .kc { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 8; }
      .kc-box { display: inline-block; white-space: nowrap; padding: ${r1(C.backing.padding * k)}px ${r1((C.backing.padding + 10) * k)}px; border-radius: ${r1(C.backing.radius * k)}px; background: ${C.backing.color}; color: ${D.colors.text}; font-weight: ${D.font.weight}; line-height: ${C.line_height}; letter-spacing: -0.005em; }
      .kc-w { display: inline-block; opacity: 0; }
      .hp { z-index: 9; } .cta { z-index: 10; }
      .fl-badge { position: absolute; inset: 0; display: block; pointer-events: none; z-index: 11; }
      .fl-tag { position: absolute; right: ${r1(36 * k)}px; top: ${r1(0.045 * H)}px; display: block; padding: ${r1(6 * k)}px ${r1(14 * k)}px; border-radius: ${r1(10 * k)}px; background: rgba(0,0,0,0.45); color: rgba(255,255,255,0.85); font-weight: 600; font-size: ${r1(22 * k)}px; letter-spacing: 0.02em; }${usesPanes ? paneCss({ font, k }) : ""}${plateCss}${ctaCss}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${DUR}" data-fps="${i.fps}">
${sections.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, cues, pages, plate: { start: plateT.start, end: i.hookLines.length ? plateT.end : 0 } };
}
