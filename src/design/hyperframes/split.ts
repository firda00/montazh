import type { DesignSpec } from "../../schemas/index.ts";
import type { Card, Panels } from "../panels.ts";
import { graphicsCss, isLightHex, renderGraphic } from "../panel-graphics.ts";
import { fullSpeakerFrom, hookPlateLayer, hookPlateLines, paneBackground, paneCss, renderPane, type Pane, type Section } from "../abror.ts";

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
  /** stage 33: per-section layout (split → full-frame speaker for the moral and CTA, full-frame inserts) */
  sections?: Section[];
  /** stage 33: insert-pane files (absolute) → project-relative src */
  paneRel?: Record<string, string>;
  /** stage 33: text advance width of the composition font (hook plate sizing) */
  measure?: (text: string, size: number) => number;
}

export interface SplitLayer {
  css: string;
  /** replaces the default full-frame #a-roll rule */
  videoCss: string;
  sections: string[];
  tweens: string[];
  /**
   * stage 33: one video element per section instead of the single #a-roll (the same rough cut, offset with
   * data-media-start): the bottom box during the split, the whole frame afterwards; none during a full-frame insert
   */
  videos?: { id: string; start: number; end: number; css: string }[];
}

/** stage 33: the abror hook (blue plate) instead of the three magazine lines */
const usesPlate = (D: DesignSpec) => D.split.hook === "plate" && D.hook_plate.enabled;

/** stage 33: the pane of a panel, when it carries a valid one */
export function panelPane(p: { pane?: Record<string, unknown> }): Pane | null {
  const k = p.pane?.kind;
  return typeof k === "string" && ["article", "site", "ui", "logo", "number", "text", "photo"].includes(k) ? (p.pane as unknown as Pane) : null;
}

/** stage 33: files the panes show (absolute), for the project's assets */
export function paneFiles(panels: Panels): string[] {
  const out = new Set<string>();
  for (const p of panels.panels) {
    const pane = panelPane(p);
    if (!pane) continue;
    if ((pane.kind === "site" || pane.kind === "ui" || pane.kind === "photo") && pane.image) out.add(pane.image);
    if (pane.kind === "article" && pane.image) out.add(pane.image);
  }
  return [...out];
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

/** Splits a short panel title into 2 balanced lines (line 1 in dark ink, line 2 in terracotta/accent). */
function twoLineHeader(raw: string): [string, string] {
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean) return ["", ""];
  const slash = clean.split(/\s*\/\s*|\n+/);
  if (slash.length >= 2) return [slash[0]!.trim(), slash.slice(1).join(" ").trim()];
  const words = clean.split(" ");
  if (words.length === 1) return [words[0]!, ""];
  if (words.length === 2) return [words[0]!, words[1]!];
  const half = clean.length / 2;
  let best = 1;
  let bestDiff = Infinity;
  let acc = 0;
  for (let i = 0; i < words.length - 1; i++) {
    acc += (i ? 1 : 0) + words[i]!.length;
    const diff = Math.abs(acc - half);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i + 1;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

/** Where the hook title sits on the seam and for how long (fractions of the frame) — an obstacle for the captions. */
export function hookExtent(W: number, H: number, design: DesignSpec, panels: Panels, duration: number, sections?: Section[]): { start: number; end: number; lo: number; hi: number } | null {
  const hook = panels.hook_title;
  if (!hook.length) return null;
  if (isLightHex(design.split.panel_bg) && design.split.panel_frame !== "edge") return null;
  if (usesPlate(design)) {
    const p = plateFor(W, H, design, panels, duration, sections);
    return { start: p.timing.start, end: p.timing.end, lo: p.extent.lo, hi: p.extent.hi };
  }
  const seam = Math.round(design.split.seam * H);
  const total = hook.reduce((n, l) => n + Math.min(118, (W - 140) / Math.max(1, l.text.length * (l.style === "serif" ? 0.5 : 0.66))), 0);
  const top = Math.round(seam - total * 0.55);
  return { start: 0, end: Math.min(4.5, panels.panels[0]?.end ?? 4.5, duration), lo: top / H, hi: (top + total * 0.98 + 12) / H };
}

/** stage 33: the hook plate of a split reel (lines from the panels' hook title, placed over the seam or under the face) */
export function plateFor(W: number, H: number, D: DesignSpec, panels: Panels, duration: number, sections?: Section[], font = "'Montserrat', sans-serif", measure?: (t: string, size: number) => number) {
  const hl = panels.hook_title.map((l) => l.text.trim()).filter(Boolean);
  const lines = hookPlateLines(hl.length === 2 ? hl.join(" / ") : hl.join(" "), D.hook_plate.max_words);
  const first = sections?.[0]?.layout ?? "split";
  const anchorY = first === "split" ? D.hook_plate.anchor_y : D.hook_plate.anchor_y_full;
  return hookPlateLayer({ W, H, spec: D.hook_plate, lines, anchorY, start: 0, duration, font, ...(measure ? { measure } : {}), id: "sp-plate", trackIndex: 6 });
}

export function buildSplitLayer(s: SplitInput): SplitLayer {
  const D = s.design;
  const SP = D.split;
  const seam = Math.round(SP.seam * s.H);
  const C = D.colors;
  const accent = SP.accent;
  const sections: string[] = [];
  const tweens: string[] = [];
  // stage 33: "edge" — the top panel is the whole top box (his editors: cover crop, no frame)
  const edge = SP.panel_frame === "edge";
  // explainer studio mode: warm cream full-screen background (#F5F1E9), top 2-line headers + step pills, avatar slides down during middle scenes
  const explainer = isLightHex(SP.panel_bg) && !edge;
  const cardX = edge ? 0 : 54;
  const cardY = edge ? 0 : explainer ? 280 : 150;
  const cardW = s.W - 2 * cardX;
  const cardH = edge ? seam : explainer ? Math.max(460, seam - cardY - 150) : seam - cardY - 60;
  const k = s.W / 1080;
  // stage 33: the split part ends where the speaker takes the whole frame
  const tSplit = Math.min(s.duration, fullSpeakerFrom(s.sections) ?? s.duration);
  const abror = edge || usesPlate(D) || !!s.sections?.length;
  let paneUsed = false;
  const totalPanels = s.panels.panels.length;
  const hasMidSteps = explainer && totalPanels >= 3;

  // background of the top half (or full studio canvas in explainer mode)
  sections.push(`      <section id="sp-bg" class="clip sp-bg" data-start="0" data-duration="${fmt(tSplit)}" data-track-index="4"></section>`);

  s.panels.panels.forEach((p, i) => {
    const id = `sp${i}`;
    const end = Math.min(p.end, tSplit);
    const dur = Math.max(0.1, end - p.start);
    if (end - p.start < 0.1) return;
    const isMidStep = hasMidSteps && i >= 1 && i < totalPanels - 1;
    const pCardY = explainer ? (isMidStep ? Math.round(290 * k) : cardY) : cardY;
    const pCardH = explainer ? (isMidStep ? Math.round(900 * k) : cardH) : cardH;
    const pane = panelPane(p);
    if (pane) {
      // stage 33 insert pane: article / site / UI / logo / number / text / photo, a hard cut like his top panel
      paneUsed = true;
      const full = p.layout === "full";
      const box = full ? { x: 0, y: 0, w: s.W, h: s.H } : { x: cardX, y: pCardY, w: cardW, h: pCardH };
      const content = full
        ? { x: 0.07 * s.W, y: 0.1 * s.H, w: 0.86 * s.W, h: 0.52 * s.H }
        : edge
          ? { x: 0.07 * s.W, y: 0.085 * s.H, w: 0.86 * s.W, h: Math.max(200, seam - 0.085 * s.H - 44 * k) }
          : { x: cardX + 24, y: pCardY + 24, w: cardW - 48, h: pCardH - 48 };
      const r = renderPane(pane, { id: `${id}-pn`, start: p.start, end, box, content, rel: (f) => s.paneRel?.[f] ?? f, font: s.displayFamily, k });
      sections.push(`      <section id="${id}" class="clip sp-panel${full ? " sp-full" : ""}" data-start="${fmt(p.start)}" data-duration="${fmt(dur)}" data-track-index="${full ? 9 : 5}">\n        <span class="ab-pane ${paneBackground(pane)}${edge || full ? "" : " sp-rounded"}" id="${id}-frame" style="left:${r1(box.x)}px;top:${r1(box.y)}px;width:${r1(box.w)}px;height:${r1(box.h)}px">${r.html}</span>\n      </section>`);
      tweens.push(`tl.fromTo("#${id}-frame", { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, ${fmt(p.start)});`);
      tweens.push(...r.tweens);
      return;
    }
    const img = s.images[i];
    const rawHeader =
      explainer && i === 0 && s.panels.hook_title.length >= 2
        ? `${s.panels.hook_title[0]!.text} / ${s.panels.hook_title[1]!.text}`
        : explainer && i === 0 && s.panels.hook_title.length === 1
          ? s.panels.hook_title[0]!.text
          : p.graphic?.title || p.cards[0]?.title || p.cards[0]?.lines[0] || p.photo_query || "";
    const [hdr1, hdr2] = explainer ? twoLineHeader(rawHeader) : ["", ""];
    const stepBadge =
      isMidStep
        ? `<span class="sp-step" id="${id}-step">Шаг ${i} из ${totalPanels - 2}</span>`
        : explainer && totalPanels === 2 && i === 1
          ? `<span class="sp-step" id="${id}-step">Шаг 1 из 1</span>`
          : "";
    const headerHtml =
      explainer && (hdr1 || hdr2)
        ? `${stepBadge}<span class="sp-hdr" id="${id}-hdr"><span class="sp-hdr1">${esc(hdr1)}</span>${hdr2 ? `<span class="sp-hdr2">${esc(hdr2)}</span>` : ""}</span>`
        : "";
    // in explainer mode the title sits above the card as the 2-line header, so clear the inner graphic title to avoid duplication
    const gfxSpec = p.graphic && explainer && (hdr1 || hdr2) ? { ...p.graphic, title: "" } : p.graphic;
    // a graphic panel (or a photo/AI panel whose picture is missing) shows its code-rendered graphic
    const gfx = !img && gfxSpec ? renderGraphic(gfxSpec, { id, w: cardW, h: pCardH, start: p.start, duration: dur, accent, bg: SP.panel_bg, displayFamily: s.displayFamily, serifFamily: s.serifFamily, monoFamily: s.monoFamily }) : null;
    const cards = (gfx ? [] : p.cards).map((c, k) => cardHtml(c, `${id}-c${k}`, s.monoFamily, s.serifFamily)).join("");
    const credit = img && s.credits?.[i] ? `<span class="sp-credit" id="${id}-cr">${esc(s.credits[i])}</span>` : "";
    const inner = img ? `<img class="sp-img" id="${id}-img" src="${img}" alt="" />${credit}` : gfx ? gfx.html : `<span class="sp-noimg"></span>`;
    const frameStyle = explainer ? ` style="top:${pCardY}px;height:${pCardH}px"` : "";
    sections.push(
      `      <section id="${id}" class="clip sp-panel" data-start="${fmt(p.start)}" data-duration="${fmt(dur)}" data-track-index="5">\n        ${headerHtml}<span class="sp-glow" id="${id}-glow"></span>\n        <span class="sp-frame" id="${id}-frame"${frameStyle}>${inner}</span>\n        ${cards}\n      </section>`,
    );
    if (explainer && (hdr1 || hdr2)) {
      tweens.push(`tl.fromTo("#${id}-hdr", { opacity: 0, y: 26 }, { opacity: 1, y: 0, duration: 0.42, ease: "power3.out" }, ${fmt(p.start)});`);
      if (stepBadge) tweens.push(`tl.fromTo("#${id}-step", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(1.8)" }, ${fmt(p.start + 0.06)});`);
    }
    // panel change: the new card pushes in from below with a slight scale (a cut, not a fade); edge panels just cut
    if (edge) tweens.push(`tl.fromTo("#${id}-frame", { opacity: 0 }, { opacity: 1, duration: 0.1, ease: "none" }, ${fmt(p.start)});`);
    else tweens.push(`tl.fromTo("#${id}-frame", { opacity: 0, y: 70, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "expo.out" }, ${fmt(p.start)});`);
    if (img) {
      // Ken Burns with a drift direction that alternates per panel
      const dir = i % 2 ? -1 : 1;
      tweens.push(`tl.fromTo("#${id}-img", { scale: 1.04, xPercent: ${-2 * dir} }, { scale: 1.14, xPercent: ${2 * dir}, duration: ${fmt(dur)}, ease: "none" }, ${fmt(p.start)});`);
    }
    if (gfx) tweens.push(...gfx.tweens);
    const hookEnd = !explainer && s.panels.hook_title.length ? Math.min(4.5, s.panels.panels[0]?.end ?? 4.5, s.duration) : 0;
    (gfx ? [] : p.cards).forEach((c, k) => {
      // bottom-corner cards of the first panel wait for the hook title on the seam to leave
      const lower = c.corner === "bl" || c.corner === "br";
      const at = Math.max(p.start + 0.45 + k * 0.35, lower && p.start < hookEnd ? hookEnd + 0.1 : 0);
      if (at < end - 0.3) tweens.push(`tl.fromTo("#${id}-c${k}", { opacity: 0, y: 24, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.7)" }, ${fmt(at)});`);
      else tweens.push(`tl.set("#${id}-c${k}", { opacity: 0 }, ${fmt(p.start)});`);
    });
  });

  // Explainer avatar choreography: slide speaker down out of frame after the hook panel, and bring speaker back up for the final conclusion/CTA panel
  if (hasMidSteps) {
    const tHide = s.panels.panels[1]!.start;
    const tShow = s.panels.panels[totalPanels - 1]!.start;
    const hideY = Math.round(s.H - seam + 240 * k);
    const avSel = s.cutout?.popHeight ? "#a-roll, #a-pop" : "#a-roll";
    if (tHide < tSplit) {
      tweens.push(`tl.fromTo("${avSel}", { y: 0 }, { y: ${hideY}, duration: 0.55, ease: "power3.inOut", immediateRender: false }, ${fmt(Math.max(0, tHide - 0.15))});`);
    }
    if (tShow < tSplit && tShow > tHide + 0.4) {
      tweens.push(`tl.fromTo("${avSel}", { y: ${hideY} }, { y: 0, duration: 0.55, ease: "power3.out", immediateRender: false }, ${fmt(Math.max(0, tShow - 0.2))});`);
    }
  }

  const hook = s.panels.hook_title;
  let plateCss = "";
  if (hook.length && usesPlate(D)) {
    // stage 33: the blue plate over the seam, 3–5 s, out to the left with a blur
    const plate = plateFor(s.W, s.H, D, s.panels, s.duration, s.sections, s.displayFamily, s.measure);
    sections.push(plate.html);
    tweens.push(...plate.tweens);
    plateCss = plate.css;
  } else if (hook.length && !explainer) {
    // hook title on the seam during the first panel (max 4.5 s)
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
    : explainer
      ? `
      .sp-bg { z-index: 0; } #a-roll { z-index: 1; } .sp-panel { z-index: 2; } .cap, .shade { z-index: 4; } .outro { z-index: 6; }`
      : "";
  const bgCss = explainer
    ? `.sp-bg { position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${s.H}px; display: block; background-color: ${SP.panel_bg}; background-image: radial-gradient(85% 65% at 50% 35%, #FFFFFF, ${SP.panel_bg}); }`
    : `.sp-bg { position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${seam + 40}px; display: block; background-color: ${SP.panel_bg}; background-image: linear-gradient(rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.045) 1px, transparent 1px), radial-gradient(70% 60% at 50% 40%, ${accent}33, transparent 70%); background-size: 60px 60px, 60px 60px, 100% 100%; }`;
  const frameCss = explainer
    ? `.sp-glow { display: none; }
      .sp-frame { position: absolute; left: ${cardX}px; top: ${cardY}px; width: ${cardW}px; height: ${cardH}px; display: block; overflow: hidden; border-radius: 38px; border: 1.5px solid rgba(24,23,21,0.08); box-shadow: 0 24px 70px rgba(24,23,21,0.10), 0 4px 16px rgba(24,23,21,0.05); background: #FFFFFF; }
      .sp-step { position: absolute; left: ${cardX}px; top: ${Math.round(92 * k)}px; display: inline-block; padding: 10px 26px; border-radius: 999px; background: #181715; color: #FFFFFF; font-family: ${s.displayFamily}; font-weight: 800; font-size: ${Math.round(28 * k)}px; letter-spacing: 0.01em; box-shadow: 0 8px 20px rgba(24,23,21,0.18); z-index: 3; }
      .sp-hdr { position: absolute; left: ${cardX}px; right: ${cardX}px; top: ${Math.round(142 * k)}px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 4px; font-family: ${s.displayFamily}; font-weight: 900; font-size: ${Math.round(54 * k)}px; line-height: 1.06; letter-spacing: -0.02em; z-index: 2; }
      .sp-hdr1 { display: block; color: #181715; }
      .sp-hdr2 { display: block; color: ${accent}; }`
    : `.sp-glow { position: absolute; left: ${cardX - 30}px; top: ${cardY - 20}px; width: ${cardW + 60}px; height: ${cardH + 40}px; display: block; border-radius: 48px; background: radial-gradient(closest-side, ${accent}66, transparent); }
      .sp-frame { position: absolute; left: ${cardX}px; top: ${cardY}px; width: ${cardW}px; height: ${cardH}px; display: block; overflow: hidden; border-radius: 30px; border: 2px solid rgba(255,255,255,0.18); box-shadow: 0 0 0 1px ${accent}55, 0 30px 90px rgba(0,0,0,0.6); background: #000; }`;
  const scCardBg = explainer ? "rgba(255,255,255,0.95)" : "rgba(14,11,28,0.86)";
  const scCardBorder = explainer ? "rgba(24,23,21,0.10)" : "rgba(255,255,255,0.16)";
  const scCardColor = explainer ? "#181715" : "#FFFFFF";
  const scChipBg = explainer ? "#FFFFFF" : "rgba(20,16,40,0.9)";
  const css = `
      ${bgCss}
      .sp-panel { position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${explainer ? s.H : seam}px; overflow: visible; }
      ${frameCss}
      .sp-img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .sp-credit { position: absolute; right: 16px; bottom: 14px; display: block; max-width: 70%; padding: 6px 12px; border-radius: 10px; background: rgba(0,0,0,0.55); font-family: ${s.monoFamily}; font-size: 17px; line-height: 1.3; color: rgba(255,255,255,0.78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      ${graphicsCss({ w: cardW, h: explainer ? Math.round(900 * k) : cardH, accent, bg: SP.panel_bg, displayFamily: s.displayFamily, monoFamily: s.monoFamily })}
      .sp-noimg { display: block; width: 100%; height: 100%; background: linear-gradient(140deg, ${accent}55, ${SP.panel_bg}); }
      .sc-card { position: absolute; display: flex; flex-direction: column; gap: 10px; max-width: 470px; padding: 22px 26px; border-radius: 22px; background: ${scCardBg}; border: 1px solid ${scCardBorder}; box-shadow: 0 20px 60px rgba(0,0,0,${explainer ? "0.14" : "0.55"}); color: ${scCardColor}; }
      .sc-tl { ${corner("tl")} } .sc-tr { ${corner("tr")} } .sc-bl { ${corner("bl")} } .sc-br { ${corner("br")} }
      .sc-q { display: block; font-size: 30px; line-height: 1.3; font-style: italic; }
      .sc-by { display: block; font-family: ${s.monoFamily}; font-size: 20px; letter-spacing: 0.06em; color: ${accent}; }
      .sc-tags { gap: 12px; padding: 18px; background: transparent; border: 0; box-shadow: none; }
      .sc-chip { display: flex; align-items: center; gap: 12px; padding: 14px 22px; border-radius: 16px; background: ${scChipBg}; border: 1px solid ${scCardBorder}; color: ${scCardColor}; font-weight: 700; font-size: 28px; white-space: nowrap; box-shadow: 0 10px 26px rgba(0,0,0,0.10); }
      .sc-dot { display: block; width: 12px; height: 12px; border-radius: 50%; background: ${accent}; }
      .sc-code { font-size: 22px; line-height: 1.45; white-space: pre; color: #C9D1E9; background: #14171F; }
      .sc-cl { display: block; }
      .sc-code b.k { color: ${accent}; font-weight: 700; }
      .sc-code i.s { color: #7EE0A2; font-style: normal; }
      .sc-code i.n { color: #FFB86B; font-style: normal; }
      .sc-num { display: block; font-family: ${s.displayFamily}; font-weight: 900; font-size: 76px; line-height: 1; color: ${accent}; }
      .sc-lab { display: block; font-size: 24px; font-weight: 600; color: ${explainer ? "rgba(24,23,21,0.75)" : "rgba(255,255,255,0.8)"}; }
      .sp-hook { position: absolute; inset: 0; pointer-events: none; }
      .sp-hookin { position: absolute; left: 60px; right: 60px; display: flex; flex-direction: column; align-items: center; text-align: center; gap: 0; }
      .sp-hl { display: block; white-space: nowrap; line-height: 0.98; letter-spacing: -0.02em; text-shadow: 0 6px 30px rgba(0,0,0,0.85), 0 2px 6px rgba(0,0,0,0.9); }
      .sp-seam { position: absolute; left: 0; top: ${seam - 1}px; width: ${s.W}px; height: 2px; display: block; background: linear-gradient(90deg, transparent, ${accent}, transparent); }${cutCss}${
        abror
          ? `
      .sp-full { height: ${s.H}px; }
      .sp-rounded { border-radius: 30px; }${edge ? `
      .sp-frame { border-radius: 0; border: 0; box-shadow: none; } .sp-glow { display: none; }` : ""}
      .cap, .shade { z-index: 4; } .sp-full { z-index: 3; } .hp { z-index: 5; } .outro, .cta { z-index: 6; }${plateCss}${paneUsed ? paneCss({ font: s.displayFamily, k }) : ""}`
          : ""
      }`;
  // with a cutout the a-roll is the plate, already cut to the bottom box. No CSS filter on the videos: a
  // drop-shadow rim drew a purple halo around the hair and cost ~70 ms a frame
  const splitVideo = `position: absolute; left: 0; top: ${seam}px; width: ${s.W}px; height: ${s.H - seam}px; object-fit: cover; object-position: 50% ${videoOffset(s.faceY, s.H, seam)}%;`;
  const videoCss = cut ? `#a-roll { position: absolute; left: 0; top: ${seam}px; width: ${s.W}px; height: ${cut.plateHeight}px; object-fit: fill; z-index: 2; }` : `#a-roll { ${splitVideo} }`;
  // stage 33: sections → one video element each (no cutout: the plate is cut to the bottom box only)
  let videos: SplitLayer["videos"];
  const secs = s.sections ?? [];
  if (!cut && secs.length && (secs.length > 1 || secs[0].layout !== "split")) {
    videos = secs
      .filter((x) => x.layout !== "full_insert" && x.end - x.start > 0.05)
      .map((x, n) => ({ id: n === 0 ? "a-roll" : `a-roll-${n}`, start: x.start, end: x.end, css: x.layout === "split" ? splitVideo : `position: absolute; left: 0; top: 0; width: ${s.W}px; height: ${s.H}px; object-fit: cover; object-position: 50% 40%;` }));
  }
  if (!edge && !explainer) sections.push(`      <section id="sp-seam" class="clip sp-seam" data-start="0" data-duration="${fmt(tSplit)}" data-track-index="7"></section>`);
  return { css, videoCss: videos ? videos.map((v) => `#${v.id} { ${v.css} }`).join("\n      ") : videoCss, sections, tweens, ...(videos ? { videos } : {}) };
}
