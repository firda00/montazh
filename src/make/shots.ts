import { graphicsCss, renderGraphic, type Graphic } from "../design/panel-graphics.ts";
import type { SfxCue } from "../audio/sfx.ts";
import type { VisualOption } from "./visuals.ts";

/**
 * Sub-shot panes of a make scene (stage 26). A scene with a visual plan holds a stack of panes inside its media area;
 * pane k appears at its cut with a transition (hard cut, wipe, zoom-through, whip, iris, slide — never the same one twice
 * in a row), the pane before it is switched off once it is covered. Every pane moves for its whole life: photos get a Ken
 * Burns of varied direction and speed (a «detail» variant punches in on the subject's focus point), brand marks pop in
 * with a pulse ring and drift, wordmarks assemble letter by letter, number cards punch in, product UIs type and tick.
 * Everything is on the one paused GSAP timeline; tweened nodes carry no CSS transform.
 */

export const PANE_TRANSITIONS = ["cut", "wipe", "zoom", "whip", "iris", "slide"] as const;
export type PaneTransition = (typeof PANE_TRANSITIONS)[number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneFonts {
  display: string;
  displayWeight: number;
  mono: string;
  serif: string;
}

export interface PaneContext {
  /** element id of the pane */
  id: string;
  start: number;
  end: number;
  /** the pane's own size (the media area) */
  w: number;
  h: number;
  /** where designed content (marks, numbers, UI) sits inside the pane, clear of the scene's text */
  content: Rect;
  palette: { bg: string; bg2: string; text: string; accent: string; accent2: string; muted: string };
  fonts: PaneFonts;
  /** relative src of the photo (photo panes) */
  src?: string;
  /** seeded 0..1 values for motion variety */
  rnd: () => number;
  /** when the number on this pane is said (s), if known */
  numberAt?: number;
  /** px scale of the frame (short side / 1080) */
  k: number;
}

export interface PaneOut {
  html: string;
  tw: string[];
  cues: SfxCue[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
function lum(h: string): number {
  const c = rgb(h).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const contrastOf = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Ken Burns moves (from → to) for photos: direction and amplitude vary per pane. */
export function kenBurns(rnd: () => number, detail = false): { from: string; to: string; name: string } {
  const amp = 0.7 + rnd() * 0.6;
  if (detail) {
    const s0 = r3(1.5 + 0.15 * rnd());
    return { from: `scale: ${s0}`, to: `scale: ${r3(s0 + 0.14 * amp)}`, name: "detail" };
  }
  const moves = [
    { name: "zoom_in", from: `scale: 1.03`, to: `scale: ${r3(1.03 + 0.14 * amp)}` },
    { name: "zoom_out", from: `scale: ${r3(1.04 + 0.15 * amp)}`, to: `scale: 1.04` },
    { name: "pan_left", from: `scale: 1.16, xPercent: ${r1(3 * amp)}`, to: `scale: 1.16, xPercent: ${r1(-3 * amp)}` },
    { name: "pan_right", from: `scale: 1.16, xPercent: ${r1(-3 * amp)}`, to: `scale: 1.16, xPercent: ${r1(3 * amp)}` },
    { name: "pan_up", from: `scale: 1.16, yPercent: ${r1(2.5 * amp)}`, to: `scale: 1.16, yPercent: ${r1(-2.5 * amp)}` },
    { name: "drift", from: `scale: 1.08, xPercent: ${r1(2 * amp)}, yPercent: 1.5`, to: `scale: ${r3(1.08 + 0.1 * amp)}, xPercent: ${r1(-2 * amp)}, yPercent: -1` },
  ];
  return moves[Math.floor(rnd() * moves.length) % moves.length];
}

/** A transition for pane k given the one before it (never twice in a row; seeded). */
export function pickTransition(rnd: () => number, prev: PaneTransition | null, opts: readonly PaneTransition[] = PANE_TRANSITIONS): PaneTransition {
  const pool = opts.filter((t) => t !== prev);
  return pool[Math.floor(rnd() * pool.length) % pool.length];
}

/** Tweens that bring pane `id` in at `at` with transition `t`; returns them and how long the move takes. */
export function paneIn(id: string, t: PaneTransition, at: number, w: number, h: number, rnd: () => number): { tw: string[]; d: number } {
  const tw: string[] = [`tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0.02, ease: "none", immediateRender: false }, ${fmt(at)});`];
  const dir = rnd() < 0.5 ? 1 : -1;
  let d = 0.02;
  if (t === "wipe") {
    const from = dir > 0 ? "inset(0% 0% 0% 100%)" : rnd() < 0.5 ? "inset(100% 0% 0% 0%)" : "inset(0% 100% 0% 0%)";
    d = 0.34;
    tw.push(`tl.fromTo("#${id}", { clipPath: "${from}" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${d}, ease: "power3.inOut", immediateRender: false }, ${fmt(at)});`);
  } else if (t === "iris") {
    d = 0.38;
    tw.push(`tl.fromTo("#${id}", { clipPath: "circle(0% at 50% 45%)" }, { clipPath: "circle(80% at 50% 45%)", duration: ${d}, ease: "power2.out", immediateRender: false }, ${fmt(at)});`);
  } else if (t === "zoom") {
    d = 0.3;
    tw.push(`tl.fromTo("#${id}", { scale: 1.22, filter: "blur(10px)" }, { scale: 1, filter: "blur(0px)", duration: ${d}, ease: "power3.out", immediateRender: false }, ${fmt(at)});`);
  } else if (t === "whip") {
    d = 0.24;
    tw.push(`tl.fromTo("#${id}", { x: ${Math.round(dir * w * 0.4)}, filter: "blur(16px)" }, { x: 0, filter: "blur(0px)", duration: ${d}, ease: "power3.out", immediateRender: false }, ${fmt(at)});`);
  } else if (t === "slide") {
    d = 0.32;
    tw.push(`tl.fromTo("#${id}", { y: ${Math.round(dir * h * 0.6)} }, { y: 0, duration: ${d}, ease: "expo.out", immediateRender: false }, ${fmt(at)});`);
  }
  return { tw, d };
}

/** The pane switched off once the next one covers it (keeps the stack light for the renderer). */
export const paneOff = (id: string, at: number) => `tl.fromTo("#${id}", { opacity: 1 }, { opacity: 0, duration: 0.02, ease: "none", immediateRender: false }, ${fmt(at)});`;

/** A designed background for non-photo panes: the brand colour (or the palette) with a soft light. */
function field(hex: string | undefined, P: PaneContext["palette"]): { bg: string; ink: string; mark: string } {
  if (hex && /^#[0-9A-F]{6}$/i.test(hex)) {
    const c = contrastOf(hex, "#FFFFFF");
    // mid-tone brand colours fill the field; near-black / near-white brands sit on the palette with the mark in colour or white
    if (c >= 2.2 && c <= 9) return { bg: `radial-gradient(120% 80% at 30% 20%, ${hex} 0%, ${mix(hex, "#000000", 0.45)} 100%)`, ink: "#FFFFFF", mark: "#FFFFFF" };
    const markOn = lum(hex) < 0.05 ? "#FFFFFF" : hex;
    return { bg: `radial-gradient(120% 80% at 30% 15%, ${P.bg2} 0%, ${P.bg} 75%)`, ink: P.text, mark: markOn };
  }
  return { bg: `radial-gradient(120% 80% at 30% 15%, ${P.bg2} 0%, ${P.bg} 75%)`, ink: P.text, mark: P.accent };
}

function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x.map((v, i) => Math.round((v + (y[i] - v) * t) * 255).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

const boxStyle = (r: Rect) => `left:${Math.round(r.x)}px;top:${Math.round(r.y)}px;width:${Math.round(r.w)}px;height:${Math.round(r.h)}px`;

/** One pane: its HTML (absolutely positioned, filling the media area) and its tweens. */
export function renderPane(opt: VisualOption, detail: boolean, c: PaneContext): PaneOut {
  const tw: string[] = [];
  const cues: SfxCue[] = [];
  const P = c.palette;
  const dur = Math.max(0.3, c.end - c.start);
  const id = c.id;
  const px = (n: number) => Math.round(n * c.k);
  const C = c.content;
  switch (opt.kind) {
    case "photo": {
      const kb = kenBurns(c.rnd, detail);
      const fx = Math.round((opt.focus?.x ?? 0.5) * 100);
      const fy = Math.round((opt.focus?.y ?? 0.45) * 100);
      tw.push(`tl.fromTo("#${id}-img", { ${kb.from} }, { ${kb.to}, duration: ${fmt(dur + 0.3)}, ease: "none" }, ${fmt(c.start)});`);
      return { html: `<div class="pane pk-photo" id="${id}"><img class="img" id="${id}-img" src="${esc(c.src ?? "")}" alt="" style="transform-origin:${fx}% ${fy}%" /></div>`, tw, cues };
    }
    case "logo": {
      // a brand named in several beats should not look the same every time: every other pane puts the mark on the
      // accent field (seeded, deterministic)
      const onAccent = detail;
      const f = onAccent ? { bg: `radial-gradient(120% 80% at 30% 20%, ${P.accent} 0%, ${mix(P.accent, "#000000", 0.35)} 100%)`, ink: contrastOf("#111111", P.accent) > 4.5 ? "#111111" : "#FFFFFF", mark: contrastOf("#111111", P.accent) > 4.5 ? "#111111" : "#FFFFFF" } : field(opt.hex, P);
      const size = Math.round(Math.min(C.w * 0.46, C.h * (opt.number ? 0.36 : 0.46)));
      const ring = Math.round(size * 1.7);
      const cx = C.x + C.w / 2;
      const cy = C.y + C.h * (opt.number ? 0.36 : 0.44);
      const nameSize = px(opt.number ? 64 : 78);
      const numHtml = opt.number ? `<span class="lg-num" id="${id}-num" style="font-size:${px(150)}px;color:${onAccent ? f.ink : P.accent}">${esc(opt.number.value)}${opt.number.unit ? `<small>${esc(opt.number.unit)}</small>` : ""}</span>` : "";
      const html = `<div class="pane pk-logo" id="${id}" style="background:${f.bg}"><span class="sweep" id="${id}-sw"></span><span class="lg-ring" id="${id}-ring" style="left:${Math.round(cx - ring / 2)}px;top:${Math.round(cy - ring / 2)}px;width:${ring}px;height:${ring}px;border-color:${f.mark}"></span><div class="lg-col" style="left:${Math.round(C.x)}px;width:${Math.round(C.w)}px;top:${Math.round(cy - size / 2)}px"><svg class="lg-mark" id="${id}-mk" viewBox="0 0 24 24" width="${size}" height="${size}" role="img" aria-label="${esc(opt.name ?? "")}"><path d="${esc(opt.path ?? "")}" fill="${f.mark}"/></svg><span class="lg-name" id="${id}-nm" style="font-size:${nameSize}px;color:${f.ink}">${esc(opt.name ?? "")}</span>${numHtml}</div></div>`;
      tw.push(`tl.fromTo("#${id}-mk", { scale: 0.35, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.55, ease: "back.out(1.8)" }, ${fmt(c.start + 0.04)});`);
      tw.push(`tl.fromTo("#${id}-mk", { scale: 1 }, { scale: 1.07, duration: ${fmt(Math.max(0.3, dur - 0.6))}, ease: "sine.inOut", immediateRender: false }, ${fmt(c.start + 0.6)});`);
      tw.push(`tl.fromTo("#${id}-ring", { scale: 0.45, opacity: 0.75 }, { scale: 1.5, opacity: 0, duration: 1.2, ease: "power2.out" }, ${fmt(c.start + 0.1)});`);
      tw.push(`tl.fromTo("#${id}-nm", { opacity: 0, y: 30 }, { opacity: 1, y: 0, duration: 0.4, ease: "power3.out" }, ${fmt(c.start + 0.3)});`);
      tw.push(`tl.fromTo("#${id}-sw", { backgroundPosition: "130% 0%" }, { backgroundPosition: "-30% 0%", duration: ${fmt(dur)}, ease: "sine.inOut" }, ${fmt(c.start)});`);
      if (opt.number) {
        const at = Math.min(c.end - 0.4, Math.max(c.start + 0.45, (c.numberAt ?? c.start + 0.45) - 0.05));
        tw.push(`tl.fromTo("#${id}-num", { opacity: 0, scale: 1.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: "expo.out" }, ${fmt(at)});`);
        cues.push({ t: r3(at), kind: "pop", gain: -6 });
      }
      return { html, tw, cues };
    }
    case "wordmark": {
      const ink = contrastOf("#111111", P.accent) > 4.5 ? "#111111" : "#FFFFFF";
      const f = detail ? { bg: `radial-gradient(120% 80% at 30% 20%, ${P.accent} 0%, ${mix(P.accent, "#000000", 0.35)} 100%)`, ink, mark: ink } : field(opt.hex, P);
      const name = opt.name ?? "";
      const fs = Math.round(Math.min(px(190), (C.w * 0.92) / Math.max(1, name.length * 0.58)));
      const letters = [...name].map((ch, q) => `<span class="wm-c" id="${id}-c${q}">${ch === " " ? "&nbsp;" : esc(ch)}</span>`).join("");
      const numHtml = opt.number ? `<span class="lg-num" id="${id}-num" style="font-size:${px(140)}px">${esc(opt.number.value)}${opt.number.unit ? `<small>${esc(opt.number.unit)}</small>` : ""}</span>` : "";
      const html = `<div class="pane pk-word" id="${id}" style="background:${f.bg}"><span class="sweep" id="${id}-sw"></span><div class="lg-col" style="left:${Math.round(C.x)}px;width:${Math.round(C.w)}px;top:${Math.round(C.y + C.h * 0.3)}px"><span class="wm-name" style="font-size:${fs}px;color:${f.ink}">${letters}</span><span class="wm-bar" id="${id}-bar" style="background:${f.mark === "#FFFFFF" ? P.accent : f.mark}"></span>${numHtml}</div></div>`;
      [...name].forEach((_, q) => tw.push(`tl.fromTo("#${id}-c${q}", { opacity: 0, yPercent: 60 }, { opacity: 1, yPercent: 0, duration: 0.36, ease: "power3.out" }, ${fmt(c.start + 0.04 + q * 0.035)});`));
      tw.push(`tl.fromTo("#${id}-bar", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power3.inOut" }, ${fmt(c.start + 0.25)});`);
      tw.push(`tl.fromTo("#${id}-sw", { backgroundPosition: "130% 0%" }, { backgroundPosition: "-30% 0%", duration: ${fmt(dur)}, ease: "sine.inOut" }, ${fmt(c.start)});`);
      if (opt.number) {
        const at = Math.min(c.end - 0.4, Math.max(c.start + 0.45, (c.numberAt ?? c.start + 0.45) - 0.05));
        tw.push(`tl.fromTo("#${id}-num", { opacity: 0, scale: 1.6 }, { opacity: 1, scale: 1, duration: 0.35, ease: "expo.out" }, ${fmt(at)});`);
        cues.push({ t: r3(at), kind: "pop", gain: -6 });
      }
      return { html, tw, cues };
    }
    case "number": {
      const n = opt.number ?? { value: "", unit: "" };
      const fs = Math.round(Math.min(px(330), (C.w * 0.9) / Math.max(1, n.value.length * 0.6)));
      // the alternative card: the number in ink on the accent field
      const inv = detail ? { bg: `linear-gradient(160deg, ${P.accent} 0%, ${mix(P.accent, "#000000", 0.3)} 100%)`, ink: contrastOf("#111111", P.accent) > 4.5 ? "#111111" : "#FFFFFF" } : null;
      const html = `<div class="pane pk-num${inv ? " inv" : ""}" id="${id}" style="background:${inv ? inv.bg : `radial-gradient(110% 70% at 50% 40%, ${P.bg2} 0%, ${P.bg} 80%)`}${inv ? `;color:${inv.ink}` : ""}"><span class="nb-ghost" id="${id}-gh" style="font-size:${px(760)}px;top:${Math.round(C.y + C.h * 0.1)}px">${esc(n.value)}</span><div class="lg-col" style="left:${Math.round(C.x)}px;width:${Math.round(C.w)}px;top:${Math.round(C.y + C.h * 0.28)}px"><span class="nb-v" id="${id}-v" style="font-size:${fs}px">${esc(n.value)}</span>${n.unit ? `<span class="nb-u" style="font-size:${px(96)}px">${esc(n.unit)}</span>` : ""}${opt.name ? `<span class="nb-l" style="font-size:${px(54)}px">${esc(opt.name)}</span>` : ""}</div></div>`;
      tw.push(`tl.fromTo("#${id}-v", { scale: 1.9, opacity: 0, filter: "blur(14px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.38, ease: "expo.out" }, ${fmt(c.start + 0.02)});`);
      tw.push(`tl.fromTo("#${id}-v", { scale: 1 }, { scale: 1.06, duration: ${fmt(Math.max(0.3, dur - 0.45))}, ease: "sine.inOut", immediateRender: false }, ${fmt(c.start + 0.42)});`);
      tw.push(`tl.fromTo("#${id}-gh", { x: ${px(200)}, opacity: 0 }, { x: ${-px(260)}, opacity: 1, duration: ${fmt(dur)}, ease: "none" }, ${fmt(c.start)});`);
      cues.push({ t: r3(c.start + 0.03), kind: "impact", gain: -9 });
      return { html, tw, cues };
    }
    case "ui": {
      const g = (opt.graphic ?? { kind: "list", title: "", items: [], note: "" }) as Graphic;
      // the panel graphics are sized for a ~1000 px panel: on a phone frame they are drawn smaller and zoomed up so
      // labels and terminal text stay readable
      const z = c.w < c.h ? 1.32 : 1.1;
      const out = renderGraphic(g, { id, w: Math.round(C.w / z), h: Math.round(C.h / z), start: c.start, duration: dur, accent: P.accent, bg: P.bg, displayFamily: c.fonts.display, serifFamily: c.fonts.serif, monoFamily: c.fonts.mono });
      const html = `<div class="pane pk-ui" id="${id}" style="background:radial-gradient(120% 80% at 70% 10%, ${P.accent}26 0%, transparent 55%), radial-gradient(120% 90% at 30% 20%, ${P.bg2} 0%, ${P.bg} 80%)"><div class="ui-box" id="${id}-box" style="${boxStyle(C)}"><div class="ui-z" style="width:${Math.round(C.w / z)}px;height:${Math.round(C.h / z)}px;transform:scale(${z})">${out.html}</div></div></div>`;
      tw.push(`tl.fromTo("#${id}-box", { y: ${px(40)} }, { y: ${-px(30)}, duration: ${fmt(dur)}, ease: "none" }, ${fmt(c.start)});`);
      tw.push(...out.tweens);
      return { html, tw, cues };
    }
    default:
      return { html: `<div class="pane" id="${id}"></div>`, tw, cues };
  }
}

/** Styles of the panes (added once to the composition). */
export function paneCss(o: { w: number; h: number; accent: string; bg: string; display: string; displayWeight: number; mono: string; text: string; muted: string; k: number }): string {
  const px = (n: number) => Math.round(n * o.k);
  return `
      .pane { position: absolute; inset: 0; display: block; overflow: hidden; }
      .pane.later { opacity: 0; }
      .pane .img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .lg-ring { position: absolute; display: block; border-radius: 50%; border: ${px(6)}px solid #FFFFFF; }
      .lg-col { position: absolute; display: flex; flex-direction: column; align-items: center; gap: ${px(34)}px; text-align: center; }
      .lg-mark { display: block; }
      .lg-name { display: block; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 1; letter-spacing: -0.02em; }
      .lg-num { display: block; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 0.95; letter-spacing: -0.04em; color: ${o.accent}; white-space: nowrap; text-shadow: 0 6px 40px rgba(0,0,0,0.35); }
      .lg-num small { font-size: 0.4em; margin-left: 0.12em; letter-spacing: 0; }
      .wm-name { display: block; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 1; letter-spacing: -0.03em; white-space: nowrap; }
      .wm-c { display: inline-block; }
      .wm-bar { display: block; width: 46%; height: ${px(14)}px; border-radius: ${px(7)}px; transform-origin: 0% 50%; }
      .nb-ghost { position: absolute; left: ${-px(60)}px; display: block; white-space: nowrap; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 0.9; letter-spacing: -0.05em; color: transparent; -webkit-text-stroke: ${px(4)}px ${o.accent}40; }
      .nb-v { display: block; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 0.95; letter-spacing: -0.045em; color: ${o.accent}; white-space: nowrap; }
      .nb-u { display: block; font-family: ${o.display}; font-weight: ${o.displayWeight}; line-height: 1; color: ${o.text}; }
      .pk-num.inv .nb-v, .pk-num.inv .nb-u, .pk-num.inv .nb-l { color: inherit; }
      .pk-num.inv .nb-ghost { -webkit-text-stroke-color: rgba(0,0,0,0.18); }
      .nb-l { display: block; font-family: ${o.mono}; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: ${o.muted}; }
      .ui-box { position: absolute; display: block; }
      .ui-z { position: relative; display: block; transform-origin: 0 0; }
      .pane .gx { background: transparent; }
      .pane .gx-grid { display: none; }${graphicsCss({ w: o.w, h: o.h, accent: o.accent, bg: o.bg, displayFamily: o.display, monoFamily: o.mono })}`;
}
