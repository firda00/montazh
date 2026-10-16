import type { DesignSpec } from "../../schemas/index.ts";
import type { Card, Panels } from "../panels.ts";
import { graphicsCss, renderGraphic } from "../panel-graphics.ts";

/**
 * Split-screen layer for the montage overlay: the speaker video moves into the bottom half, the top
 * half shows one panel per segment in a framed card — a real photo (Ken Burns + UI cards over its corners),
 * a code-rendered motion graphic (src/design/panel-graphics.ts), or, last resort, a generated image —
 * and a three-line hook title sits on the seam for the first seconds. Returns CSS, sections and
 * GSAP tweens that composeHyperframes() splices into the composition.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface SplitInput {
  W: number;
  H: number;
  duration: number;
  design: DesignSpec;
  panels: Panels;
  /** panel index → image path relative to the project (photo or AI image); a panel without one shows its graphic */
  images: Record<number, string>;
  /** panel index → short credit shown on the photo ("фото: Автор · CC BY 2.0 · Wikimedia") */
  credits?: Record<number, string>;
  /** face height in the rough frame (0 = top), to keep the head in the bottom box */
  faceY?: number;
  /** CSS font stacks; they go into style="" attributes, so single quotes only */
  serifFamily: string;
  monoFamily: string;
  displayFamily: string;
  /**
   * the speaker cut out: `plateHeight` px of plate (opaque, the speaker already over the designed
   * background) from the seam down, and `popHeight` px of alpha strip right above the seam (the head
   * breaking over the top panel; 0 = none)
   */
  cutout?: { plateHeight: number; popHeight: number };
}

export interface SplitLayer {
  css: string;
  /** replaces the default full-frame #a-roll rule */
  videoCss: string;
  sections: string[];
  tweens: string[];
}

/** object-position % that keeps the face at ~42% of the bottom box */
export function videoOffset(faceY: number | undefined, H: number, seam: number): number {
  const box = H - seam;
  const scrollable = H - box; // the 9:16 rough is H tall at width W; the box shows `box` of it
  if (scrollable <= 0) return 50;
  const face = (faceY ?? 0.38) * H;
  // the face sits at ~42% of the box: headroom above, shoulders below
  const top = Math.min(scrollable, Math.max(0, face - 0.42 * box));
  return r1((top / scrollable) * 100);
}

/** conservative font size for a single line: chars × em factor must fit the width */
function lineSize(text: string, width: number, max: number, em: number): number {
  return r1(Math.min(max, width / Math.max(1, text.length * em)));
}

function cardHtml(c: Card, id: string, mono: string, serif: string): string {
  switch (c.kind) {
    case "quote":
      return `<span class="sc-card sc-quote sc-${c.corner}" id="${id}"><span class="sc-q" style="font-family:${serif}">“${esc(c.lines[0] ?? "")}”</span>${c.title ? `<span class="sc-by">— ${esc(c.title)}</span>` : ""}</span>`;
    case "tags":
      return `<span class="sc-card sc-tags sc-${c.corner}" id="${id}">${c.lines.map((l) => `<span class="sc-chip"><span class="sc-dot"></span>${esc(l)}</span>`).join("")}</span>`;
    case "code":
      return `<span class="sc-card sc-code sc-${c.corner}" id="${id}" style="font-family:${mono}">${c.lines.map((l) => `<span class="sc-cl">${highlight(l)}</span>`).join("")}</span>`;
    case "stat":
      return `<span class="sc-card sc-stat sc-${c.corner}" id="${id}"><span class="sc-num">${esc(c.title)}</span>${c.lines[0] ? `<span class="sc-lab">${esc(c.lines[0])}</span>` : ""}</span>`;
  }
}

/** tiny code colouring: keywords, strings, numbers */
function highlight(line: string): string {
  return esc(line)
    .replace(/(&quot;[^&]*&quot;|'[^']*')/g, '<i class="s">$1</i>')
    .replace(/\b(import|from|def|return|const|let|function|class|for|in|if|await|async|print)\b/g, '<b class="k">$1</b>')
    .replace(/\b(\d+(?:\.\d+)?)\b/g, '<i class="n">$1</i>');
}

/** The framed card of the top half: where photos are cropped to and graphics are laid out. */
export function panelFrame(W: number, H: number, seamFrac: number): { x: number; y: number; w: number; h: number } {
  const seam = Math.round(seamFrac * H);
  const x = 54;
  const y = 150;
  return { x, y, w: W - 2 * x, h: seam - y - 60 };
}

/** Where the hook title sits on the seam and for how long (fractions of the frame) — an obstacle for the captions. */
export function hookExtent(W: number, H: number, design: DesignSpec, panels: Panels, duration: number): { start: number; end: number; lo: number; hi: number } | null {
  const hook = panels.hook_title;
  if (!hook.length) return null;
  const seam = Math.round(design.split.seam * H);
  const total = hook.reduce((n, l) => n + Math.min(118, (W - 140) / Math.max(1, l.text.length * (l.style === "serif" ? 0.5 : 0.66))), 0);
  const top = Math.round(seam - total * 0.55);
  return { start: 0, end: Math.min(4.5, panels.panels[0]?.end ?? 4.5, duration), lo: top / H, hi: (top + total * 0.98 + 12) / H };
}

export function buildSplitLayer(s: SplitInput): SplitLayer {
  const D = s.design;
  const SP = D.split;
  const seam = Math.round(SP.seam * s.H);
  const C = D.colors;
  const accent = SP.accent;
  const sections: string[] = [];
  const tweens: string[] = [];
  const cardX = 54;
  const cardY = 150;
  const cardW = s.W - 2 * cardX;
  const cardH = seam - cardY - 60;

  // background of the top half (grid + glow), the whole duration
  sections.push(`      <section id="sp-bg" class="clip sp-bg" data-start="0" data-duration="${fmt(s.duration)}" data-track-index="4"></section>`);

  s.panels.panels.forEach((p, i) => {
    const id = `sp${i}`;
    const dur = Math.max(0.1, p.end - p.start);
    const img = s.images[i];
    // a graphic panel (or a photo/AI panel whose picture is missing) shows its code-rendered graphic
    const gfx = !img && p.graphic ? renderGraphic(p.graphic, { id, w: cardW, h: cardH, start: p.start, duration: dur, accent, bg: SP.panel_bg, displayFamily: s.displayFamily, serifFamily: s.serifFamily, monoFamily: s.monoFamily }) : null;
    const cards = (gfx ? [] : p.cards).map((c, k) => cardHtml(c, `${id}-c${k}`, s.monoFamily, s.serifFamily)).join("");
    const credit = img && s.credits?.[i] ? `<span class="sp-credit" id="${id}-cr">${esc(s.credits[i])}</span>` : "";
    const inner = img ? `<img class="sp-img" id="${id}-img" src="${img}" alt="" />${credit}` : gfx ? gfx.html : `<span class="sp-noimg"></span>`;
    sections.push(
      `      <section id="${id}" class="clip sp-panel" data-start="${fmt(p.start)}" data-duration="${fmt(dur)}" data-track-index="5">\n        <span class="sp-glow" id="${id}-glow"></span>\n        <span class="sp-frame" id="${id}-frame">${inner}</span>\n        ${cards}\n      </section>`,
    );
    // panel change: the new card pushes in from below with a slight scale (a cut, not a fade)
    tweens.push(`tl.fromTo("#${id}-frame", { opacity: 0, y: 70, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "expo.out" }, ${fmt(p.start)});`);
    if (img) {
      // Ken Burns with a drift direction that alternates per panel
      const dir = i % 2 ? -1 : 1;
      tweens.push(`tl.fromTo("#${id}-img", { scale: 1.04, xPercent: ${-2 * dir} }, { scale: 1.14, xPercent: ${2 * dir}, duration: ${fmt(dur)}, ease: "none" }, ${fmt(p.start)});`);
    }
    if (gfx) tweens.push(...gfx.tweens);
    const hookEnd = s.panels.hook_title.length ? Math.min(4.5, s.panels.panels[0]?.end ?? 4.5, s.duration) : 0;
    (gfx ? [] : p.cards).forEach((c, k) => {
      // bottom-corner cards of the first panel wait for the hook title on the seam to leave
      const lower = c.corner === "bl" || c.corner === "br";
      const at = Math.max(p.start + 0.45 + k * 0.35, lower && p.start < hookEnd ? hookEnd + 0.1 : 0);
      if (at < p.end - 0.3) tweens.push(`tl.fromTo("#${id}-c${k}", { opacity: 0, y: 24, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.7)" }, ${fmt(at)});`);
      else tweens.push(`tl.set("#${id}-c${k}", { opacity: 0 }, ${fmt(p.start)});`);
    });
  });

  // hook title on the seam during the first panel (max 4.5 s)
  const hook = s.panels.hook_title;
  if (hook.length) {
    const hookDur = Math.min(4.5, s.panels.panels[0]?.end ?? 4.5, s.duration);
    const lines = hook.map((l, k) => {
      const em = l.style === "serif" ? 0.5 : 0.66;
      const size = lineSize(l.text, s.W - 2 * 70, l.style === "serif" ? 104 : 118, em);
      const font = l.style === "serif" ? `font-family:${s.serifFamily};font-style:italic;font-weight:700;text-transform:none` : `font-family:${s.displayFamily};font-weight:900;text-transform:uppercase`;
      const color = l.style === "accent" ? accent : "#FFFFFF";
      return `<span class="sp-hl" id="sp-h${k}" style="font-size:${size}px;${font};color:${color}">${esc(l.text)}</span>`;
    });
    const total = hook.reduce((n, l) => n + Math.min(118, (s.W - 140) / Math.max(1, l.text.length * (l.style === "serif" ? 0.5 : 0.66))), 0);
    const top = Math.round(seam - total * 0.55);
    sections.push(`      <section id="sp-hook" class="clip sp-hook" data-start="0" data-duration="${fmt(hookDur)}" data-track-index="6">\n        <span class="sp-hookin" id="sp-hookin" style="top:${top}px">${lines.join("")}</span>\n      </section>`);
    hook.forEach((_, k) => tweens.push(`tl.fromTo("#sp-h${k}", { opacity: 0, y: 50 }, { opacity: 1, y: 0, duration: 0.5, ease: "power4.out" }, ${fmt(0.05 + k * 0.12)});`));
    if (hookDur > 1) tweens.push(`tl.fromTo("#sp-hookin", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power1.in", immediateRender: false }, ${fmt(hookDur - 0.3)});`);
  }

  const corner = (c: string) => {
    const inset = 26;
    switch (c) {
      case "tl":
        return `left:${cardX - 18}px; top:${cardY + inset}px;`;
      case "tr":
        return `right:${cardX - 18}px; top:${cardY + inset}px;`;
      case "bl":
        return `left:${cardX - 18}px; top:${cardY + cardH - 250}px;`;
      default:
        return `right:${cardX - 18}px; top:${cardY + cardH - 250}px;`;
    }
  };
  const cut = s.cutout;
  // cutout z-order: top background 0 → panels and the seam line 1 → plate 2 → pop strip 3 (the head over the
  // panel frame and the seam line) → captions 4 → hook 5 → outro 6. The designed background of the bottom box
  // (panel colour, the same 60 px grid, a darker floor, an accent glow behind the head) is baked into the plate.
  const popCss = cut?.popHeight ? `
      #a-pop { position: absolute; left: 0; top: ${r1(seam - cut.popHeight)}px; width: ${s.W}px; height: ${cut.popHeight}px; object-fit: fill; z-index: 3; }` : "";
  const cutCss = cut
    ? `
      .sp-bg { z-index: 0; } .sp-panel { z-index: 1; } .sp-seam { z-index: 1; } .cap, .shade { z-index: 4; } .sp-hook { z-index: 5; } .outro { z-index: 6; }${popCss}`
    : "";
  const css = `
      .sp-bg { position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${seam + 40}px; display: block; background-color: ${SP.panel_bg}; background-image: linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), radial-gradient(70% 60% at 50% 40%, ${accent}33, transparent 70%); background-size: 60px 60px, 60px 60px, 100% 100%; }
      .sp-panel { position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${seam}px; overflow: visible; }
      .sp-glow { position: absolute; left: ${cardX - 30}px; top: ${cardY - 20}px; width: ${cardW + 60}px; height: ${cardH + 40}px; display: block; border-radius: 48px; background: radial-gradient(closest-side, ${accent}66, transparent); }
      .sp-frame { position: absolute; left: ${cardX}px; top: ${cardY}px; width: ${cardW}px; height: ${cardH}px; display: block; overflow: hidden; border-radius: 30px; border: 2px solid rgba(255,255,255,0.18); box-shadow: 0 0 0 1px ${accent}55, 0 30px 90px rgba(0,0,0,0.6); background: #000; }
      .sp-img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .sp-credit { position: absolute; right: 16px; bottom: 14px; display: block; max-width: 70%; padding: 6px 12px; border-radius: 10px; background: rgba(0,0,0,0.55); font-family: ${s.monoFamily}; font-size: 17px; line-height: 1.3; color: rgba(255,255,255,0.78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      ${graphicsCss({ w: cardW, h: cardH, accent, bg: SP.panel_bg, displayFamily: s.displayFamily, monoFamily: s.monoFamily })}
      .sp-noimg { display: block; width: 100%; height: 100%; background: linear-gradient(140deg, ${accent}55, ${SP.panel_bg}); }
      .sc-card { position: absolute; display: flex; flex-direction: column; gap: 10px; max-width: 470px; padding: 22px 26px; border-radius: 22px; background: rgba(14,11,28,0.86); border: 1px solid rgba(255,255,255,0.16); box-shadow: 0 20px 60px rgba(0,0,0,0.55); color: #FFFFFF; }
      .sc-tl { ${corner("tl")} } .sc-tr { ${corner("tr")} } .sc-bl { ${corner("bl")} } .sc-br { ${corner("br")} }
      .sc-q { display: block; font-size: 30px; line-height: 1.3; font-style: italic; }
      .sc-by { display: block; font-family: ${s.monoFamily}; font-size: 20px; letter-spacing: 0.06em; color: ${accent}; }
      .sc-tags { gap: 12px; padding: 18px; background: transparent; border: 0; box-shadow: none; }
      .sc-chip { display: flex; align-items: center; gap: 12px; padding: 14px 22px; border-radius: 16px; background: rgba(20,16,40,0.9); border: 1px solid rgba(255,255,255,0.18); font-weight: 700; font-size: 28px; white-space: nowrap; }
      .sc-dot { display: block; width: 12px; height: 12px; border-radius: 50%; background: ${accent}; }
      .sc-code { font-size: 22px; line-height: 1.45; white-space: pre; color: #C9D1E9; }
      .sc-cl { display: block; }
      .sc-code b.k { color: ${accent}; font-weight: 700; }
      .sc-code i.s { color: #7EE0A2; font-style: normal; }
      .sc-code i.n { color: #FFB86B; font-style: normal; }
      .sc-num { display: block; font-family: ${s.displayFamily}; font-weight: 900; font-size: 76px; line-height: 1; color: ${accent}; }
      .sc-lab { display: block; font-size: 24px; font-weight: 600; color: rgba(255,255,255,0.8); }
      .sp-hook { position: absolute; inset: 0; pointer-events: none; }
      .sp-hookin { position: absolute; left: 60px; right: 60px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0; }
      .sp-hl { display: block; white-space: nowrap; line-height: 0.98; letter-spacing: -0.02em; text-shadow: 0 6px 30px rgba(0,0,0,0.85), 0 2px 6px rgba(0,0,0,0.9); }
      .sp-seam { position: absolute; left: 0; top: ${seam - 1}px; width: ${s.W}px; height: 2px; display: block; background: linear-gradient(90deg, transparent, ${accent}, transparent); }${cutCss}`;
  // with a cutout the a-roll is the plate, already cut to the bottom box. No CSS filter on the videos: a
  // drop-shadow rim drew a purple halo around the hair and cost ~70 ms a frame
  const videoCss = cut
    ? `#a-roll { position: absolute; left: 0; top: ${seam}px; width: ${s.W}px; height: ${cut.plateHeight}px; object-fit: fill; z-index: 2; }`
    : `#a-roll { position: absolute; left: 0; top: ${seam}px; width: ${s.W}px; height: ${s.H - seam}px; object-fit: cover; object-position: 50% ${videoOffset(s.faceY, s.H, seam)}%; }`;
  sections.push(`      <section id="sp-seam" class="clip sp-seam" data-start="0" data-duration="${fmt(s.duration)}" data-track-index="7"></section>`);
  return { css, videoCss, sections, tweens };
}
