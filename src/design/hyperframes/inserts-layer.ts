import type { Layout } from "../layout-types.ts";
import type { InsertsTrack } from "../inserts.ts";
import { paneCss, renderPane, type PaneContext } from "../../make/shots.ts";

/**
 * Stage 27: the insert track of the montage overlay (src/design/inserts.ts decides what and when). Sections sit in the
 * DOM after the a-roll and BEFORE the captions, without z-index, so the captions stay on top and in place:
 *   cutaway — a full-frame pane (stage-26 panes: photo with Ken Burns, brand mark, product UI, number) + a soft shade
 *             at the bottom for the captions + the photo credit;
 *   pip     — the cut-out person (PNG with alpha, soft bottom edge) or a rounded photo card on the chest;
 *   site    — a phone-like card with the domain bar and the tall screenshot scrolling under it;
 *   chips   — a white logo card and white pills that pop in on their numbers, the last one inverted.
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Absolute files the track shows (copied into the project's assets/inserts). */
export function insertFiles(track: InsertsTrack): string[] {
  const out = new Set<string>();
  for (const it of track.items) {
    if (it.image) out.add(it.image);
    if (it.pane?.kind === "photo" && it.pane.file) out.add(it.pane.file);
  }
  return [...out];
}

/** Top of the highest caption block (fraction of the height): what a site card must stay above. */
export function captionTopOf(layout: Pick<Layout, "pages" | "captions" | "frame">): number {
  if (!layout.pages.length) return 0.9;
  const ys = layout.pages.map((p) => (p.anchorY ?? layout.captions.anchorY) - ((p.lines.length * p.fontSize * 1.25) / layout.frame.height) / 2);
  return Math.min(...ys);
}

function seeded(id: string): () => number {
  let h = 2166136261;
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface InsertsLayerInput {
  W: number;
  H: number;
  duration: number;
  /** absolute file → project-relative src */
  rel: Record<string, string>;
  /** CSS font stacks (single quotes only: they go into style attributes) */
  display: string;
  mono: string;
  captionTop: number;
  accent?: string;
}

export function insertsLayer(track: InsertsTrack, s: InsertsLayerInput): { css: string; sections: string[]; tweens: string[] } {
  const { W, H } = s;
  const k = Math.min(W, H) / 1080;
  const px = (n: number) => r1(n * k);
  const accent = s.accent ?? "#E5C158";
  const palette: PaneContext["palette"] = { bg: "#0E0E12", bg2: "#26262E", text: "#FFFFFF", accent, accent2: "#8B6CFF", muted: "#A0A0AA" };
  const sections: string[] = [];
  const tweens: string[] = [];
  let panes = false;
  for (const it of track.items) {
    const id = `ins-${it.id}`;
    const dur = Math.max(0.1, Math.min(it.end, s.duration) - it.start);
    if (dur <= 0.05) continue;
    const head = `      <section id="${id}" class="clip ins ins-k-${it.kind}" data-start="${fmt(it.start)}" data-duration="${fmt(dur)}" data-track-index="9">`;
    const credit = it.credit ? `<span class="ins-credit">${esc(it.credit)}</span>` : "";
    if (it.kind === "cutaway" && it.pane) {
      panes = true;
      const content = { x: 0.08 * W, y: 0.12 * H, w: 0.84 * W, h: 0.56 * H };
      const src = it.pane.file ? s.rel[it.pane.file] : undefined;
      const out = renderPane(it.pane, false, { id: `${id}-p`, start: it.start, end: it.start + dur, w: W, h: H, content, palette, fonts: { display: s.display, displayWeight: 800, mono: s.mono, serif: s.display }, ...(src ? { src } : {}), rnd: seeded(id), numberAt: it.t, k });
      sections.push(`${head}\n        ${out.html}\n        <span class="ins-shade"></span>${credit}\n      </section>`);
      tweens.push(...out.tw);
    } else if (it.kind === "pip" && it.image && it.box) {
      const b = it.box;
      const style = `left:${r1(b.x * W)}px;top:${r1(b.y * H)}px;width:${r1(b.w * W)}px;height:${r1(b.h * H)}px`;
      sections.push(`${head}\n        <img class="ins-pip-img${it.cutout ? " cut" : " card"}" id="${id}-img" src="${esc(s.rel[it.image] ?? "")}" alt="" style="${style}" />${credit}\n      </section>`);
      tweens.push(`tl.fromTo("#${id}-img", { opacity: 0, scale: 0.86, y: ${px(26)} }, { opacity: 1, scale: 1, y: 0, duration: 0.32, ease: "back.out(1.6)", immediateRender: false }, ${fmt(it.start)});`);
      tweens.push(`tl.fromTo("#${id}-img", { scale: 1 }, { scale: 1.04, duration: ${fmt(Math.max(0.3, dur - 0.6))}, ease: "sine.inOut", immediateRender: false }, ${fmt(it.start + 0.32)});`);
      if (dur > 1) tweens.push(`tl.fromTo("#${id}-img", { opacity: 1 }, { opacity: 0, duration: 0.22, ease: "power1.in", immediateRender: false }, ${fmt(it.start + dur - 0.24)});`);
    } else if (it.kind === "site" && it.image && it.box && it.site) {
      const b = it.box;
      const cw = b.w * W;
      const bottom = Math.min(b.y + b.h, Math.max(b.y + 0.4, s.captionTop - 0.015));
      const ch = (bottom - b.y) * H;
      const bar = px(70);
      const imgH = cw * (it.site.height / Math.max(1, it.site.width));
      const travel = Math.max(0, imgH - (ch - bar));
      sections.push(
        `${head}\n        <span class="ins-site" id="${id}-card" style="left:${r1(b.x * W)}px;top:${r1(b.y * H)}px;width:${r1(cw)}px;height:${r1(ch)}px"><span class="ins-view" style="top:${bar}px"><img class="ins-shot" id="${id}-shot" src="${esc(s.rel[it.image] ?? "")}" alt="" style="width:${r1(cw)}px;height:${r1(imgH)}px" /></span><span class="ins-bar" style="height:${bar}px"><span class="ins-lock"></span><span class="ins-dom">${esc(it.site.domain)}</span></span></span>\n      </section>`,
      );
      tweens.push(`tl.fromTo("#${id}-card", { opacity: 0, y: ${px(80)}, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.38, ease: "expo.out", immediateRender: false }, ${fmt(it.start)});`);
      // the scroll: a short hold on the hero, then down at reading pace, easing out before the end
      if (travel > 4) tweens.push(`tl.fromTo("#${id}-shot", { y: 0 }, { y: ${r1(-Math.min(travel, (dur - 1) * 0.55 * H))}, duration: ${fmt(Math.max(0.5, dur - 1.1))}, ease: "power1.inOut", immediateRender: false }, ${fmt(it.start + 0.7)});`);
    } else if (it.kind === "chips" && it.chips && it.box) {
      const b = it.box;
      const sc = it.chips.scale;
      const logo = it.chips.logo;
      const logoHtml = logo
        ? `<span class="ins-logo" id="${id}-logo" style="font-size:${px(48 * sc)}px">${logo.path ? `<svg viewBox="0 0 24 24" width="${px(56 * sc)}" height="${px(56 * sc)}"><path d="${esc(logo.path)}" fill="${/^#[0-9A-F]{6}$/i.test(logo.hex ?? "") && logo.hex!.toUpperCase() !== "#FFFFFF" ? logo.hex : "#111111"}"/></svg>` : ""}<span>${esc(logo.name)}</span></span>`
        : "";
      const chips = it.chips.items.map((c, j) => `<span class="ins-chip${c.invert ? " inv" : ""}" id="${id}-c${j}" style="font-size:${px(38 * sc)}px">${esc(c.text)}</span>`).join("");
      sections.push(`${head}\n        <span class="ins-chips" style="left:${r1(b.x * W)}px;top:${r1(b.y * H)}px;width:${r1(b.w * W)}px;height:${r1(b.h * H)}px;gap:${px(14 * sc)}px">${logoHtml}${chips}</span>\n      </section>`);
      if (logo) tweens.push(`tl.fromTo("#${id}-logo", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(1.8)", immediateRender: false }, ${fmt(it.start)});`);
      it.chips.items.forEach((c, j) => tweens.push(`tl.fromTo("#${id}-c${j}", { opacity: 0, scale: 0.7, y: ${px(14)} }, { opacity: 1, scale: 1, y: 0, duration: 0.26, ease: "back.out(2)", immediateRender: false }, ${fmt(Math.max(it.start + (logo ? 0.15 : 0), c.at - 0.04))});`));
    }
  }
  const css = `
      .ins { position: absolute; inset: 0; display: block; overflow: hidden; pointer-events: none; }
      .ins-shade { position: absolute; left: 0; right: 0; bottom: 0; height: 38%; display: block; background: linear-gradient(to bottom, rgba(0,0,0,0), rgba(0,0,0,0.5)); }
      .ins-credit { position: absolute; right: ${px(40)}px; top: ${r1(0.085 * H)}px; display: block; max-width: 70%; padding: ${px(5)}px ${px(11)}px; border-radius: ${px(9)}px; background: rgba(0,0,0,0.45); font-family: ${s.mono}; font-size: ${px(16)}px; line-height: 1.3; color: rgba(255,255,255,0.78); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ins-pip-img { position: absolute; display: block; }
      .ins-pip-img.cut { object-fit: contain; object-position: 50% 100%; -webkit-mask-image: linear-gradient(to bottom, #000 82%, rgba(0,0,0,0) 100%); mask-image: linear-gradient(to bottom, #000 82%, rgba(0,0,0,0) 100%); filter: drop-shadow(0 ${px(10)}px ${px(22)}px rgba(0,0,0,0.45)); }
      .ins-pip-img.card { object-fit: cover; border-radius: ${px(28)}px; border: ${px(5)}px solid #FFFFFF; box-shadow: 0 ${px(14)}px ${px(40)}px rgba(0,0,0,0.5); }
      .ins-site { position: absolute; display: block; overflow: hidden; border-radius: ${px(34)}px; background: #FFFFFF; box-shadow: 0 ${px(24)}px ${px(70)}px rgba(0,0,0,0.55), 0 0 0 ${px(2)}px rgba(255,255,255,0.6); }
      .ins-bar { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: center; gap: ${px(10)}px; background: #F2F2F4; border-bottom: 1px solid rgba(0,0,0,0.08); }
      .ins-lock { display: block; width: ${px(16)}px; height: ${px(18)}px; border-radius: ${px(4)}px; background: #8A8A92; }
      .ins-dom { display: block; font-family: ${s.display}; font-weight: 600; font-size: ${px(28)}px; color: #222228; letter-spacing: 0; }
      .ins-view { position: absolute; left: 0; right: 0; bottom: 0; display: block; overflow: hidden; }
      .ins-shot { position: absolute; left: 0; top: 0; display: block; }
      .ins-chips { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: flex-start; }
      .ins-logo { display: flex; align-items: center; gap: 0.35em; padding: 0.32em 0.62em; border-radius: 0.32em; background: #FFFFFF; color: #111111; font-family: ${s.display}; font-weight: 800; letter-spacing: -0.02em; line-height: 1; box-shadow: 0 ${px(10)}px ${px(30)}px rgba(0,0,0,0.35); opacity: 0; }
      .ins-chip { display: block; padding: 0.34em 0.72em; border-radius: 0.55em; background: #FFFFFF; color: #111111; font-family: ${s.display}; font-weight: 600; line-height: 1.1; white-space: nowrap; box-shadow: 0 ${px(8)}px ${px(26)}px rgba(0,0,0,0.3); opacity: 0; }
      .ins-chip.inv { background: #111111; color: #FFFFFF; }${panes ? paneCss({ w: W, h: H, accent, bg: palette.bg, display: s.display, displayWeight: 800, mono: s.mono, text: palette.text, muted: palette.muted, k }) : ""}`;
  return { css, sections, tweens };
}
