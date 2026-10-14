import { FONTS, fontStack, type FontId } from "./fonts.ts";
import { contrast, type Design, type Scene } from "./design.ts";
import type { Script } from "./script.ts";
import type { SfxCue } from "../audio/sfx.ts";

/**
 * Design + script (+ images) → one HyperFrames composition. Every scene is a section on track 1
 * holding its own layout; a background section on track 0 carries the palette, texture and glow.
 * Text boxes carry class "fit" with data-maxw/data-maxh so fit.ts can shrink them in a real browser;
 * `sizes` feeds the measured font sizes back in. Pure and deterministic for the same inputs.
 */

export const W = 1080;
export const H = 1920;
export const FPS = 30;
/** Reels/Shorts UI: keep text out of the top 150 px and the bottom ~320 px */
export const SAFE = { x: 72, top: 150, bottom: 1590 };

export interface SceneTiming {
  beat: number;
  start: number;
  duration: number;
}

export interface ComposeScenesOptions {
  /** beat → image path relative to the project (assets/img/scene_N.jpg) */
  images: Record<number, string>;
  fontFaces: string;
  gsapRel: string;
  /** measured font sizes by fit id (px); missing ids use the defaults */
  sizes?: Record<string, number>;
}

export interface ComposedScenes {
  html: string;
  duration: number;
  timings: SceneTiming[];
  fonts: FontId[];
  /** sound-effect cues matching the motion (src/audio/mix.ts plays them) */
  cues: SfxCue[];
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function timeScenes(script: Script): { timings: SceneTiming[]; duration: number } {
  const timings: SceneTiming[] = [];
  let frame = 0;
  script.beats.forEach((b, beat) => {
    const frames = Math.max(1, Math.round(b.seconds * FPS));
    timings.push({ beat, start: r3(frame / FPS), duration: r3(frames / FPS) });
    frame += frames;
  });
  return { timings, duration: r3(frame / FPS) };
}

// ---- 3D helpers (compose time, Node only: the page never computes geometry or randomness) ----

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rgbOf = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hexOf = (c: number[]) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
/** a → b by t (0..1) in RGB */
export const mixHex = (a: string, b: string, t: number) => hexOf(rgbOf(a).map((v, i) => v + (rgbOf(b)[i] - v) * t));
/** rotates the hue of a colour by `deg` keeping saturation and lightness */
export function hueShift(h: string, deg: number): string {
  const [r, g, b] = rgbOf(h).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return h.toUpperCase();
  const s = d / (1 - Math.abs(2 * l - 1));
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (((hue * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [rr, gg, bb] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return hexOf([rr + m, gg + m, bb + m].map((v) => v * 255));
}

/** vertical centre of the safe zone: 3D scenes orbit / vanish here */
const CY = Math.round((SAFE.top + SAFE.bottom) / 2);

/** One cube: six faces shaded as if lit from the top left (static shading reads as light while it spins). */
function cubeFaces(s: number, c: string): string {
  const h = r1(s / 2);
  const face = (tf: string, fill: string, hi: string) => `<i class="fc" style="transform:${tf} translateZ(${h}px);background:linear-gradient(135deg, ${hi} 0%, ${fill} 70%)"></i>`;
  return [
    face("", c, mixHex(c, "#FFFFFF", 0.35)),
    face("rotateY(180deg)", mixHex(c, "#000000", 0.3), mixHex(c, "#000000", 0.1)),
    face("rotateY(90deg)", mixHex(c, "#000000", 0.22), c),
    face("rotateY(-90deg)", mixHex(c, "#000000", 0.38), mixHex(c, "#000000", 0.15)),
    face("rotateX(90deg)", mixHex(c, "#FFFFFF", 0.22), mixHex(c, "#FFFFFF", 0.5)),
    face("rotateX(-90deg)", mixHex(c, "#000000", 0.5), mixHex(c, "#000000", 0.3)),
  ].join("");
}

/** Text colour that reads on a given fill (dark on light accents, white on dark). */
function onColor(fill: string): string {
  return contrast("#111111", fill) >= contrast("#FFFFFF", fill) ? "#111111" : "#FFFFFF";
}

interface Token {
  word: string;
  accent: number; // -1 or index into scene.accents
}

/** Headline words with the accent each belongs to (accents are matched case-insensitively at word boundaries). */
export function tokenize(scene: Scene): Token[] {
  const words = scene.headline.split(/\s+/).filter(Boolean);
  const lower = scene.headline.toLowerCase();
  const starts: number[] = [];
  let pos = 0;
  for (const w of words) {
    const i = scene.headline.indexOf(w, pos);
    starts.push(i);
    pos = i + w.length;
  }
  const tokens: Token[] = words.map((word) => ({ word, accent: -1 }));
  scene.accents.forEach((a, ai) => {
    const at = lower.indexOf(a.text.toLowerCase());
    if (at < 0) return;
    const end = at + a.text.length;
    words.forEach((w, wi) => {
      const s = starts[wi];
      const e = s + w.length;
      if (s < end && e > at && tokens[wi].accent < 0) tokens[wi].accent = ai;
    });
  });
  return tokens;
}

export function composeScenes(script: Script, design: Design, o: ComposeScenesOptions): ComposedScenes {
  const I = design.identity;
  const P = I.palette;
  const sizes = o.sizes ?? {};
  const { timings, duration: DUR } = timeScenes(script);
  const display: FontId = I.display_font;
  const accentFont: FontId = I.accent_font;
  const kickerFont: FontId = I.kicker_font === "mono" ? "mono" : display;
  const fonts: FontId[] = [display, accentFont, kickerFont, "mono"];
  const light = contrast("#111111", P.bg) > contrast("#FFFFFF", P.bg);
  const accentText = onColor(P.accent);
  const tw: string[] = [];
  const sections: string[] = [];
  const cues: SfxCue[] = [];
  const size = (id: string, def: number) => r1(sizes[id] ?? def);
  const fitAttrs = (id: string, maxw: number, maxh: number, min: number) => `data-fit="${id}" data-maxw="${maxw}" data-maxh="${maxh}" data-min="${min}"`;

  /** headline markup: words (with accent groups) as maskable spans */
  const words = (scene: Scene, id: string, entrance: Scene["entrance"]) => {
    const toks = tokenize(scene);
    const out: string[] = [];
    let i = 0;
    while (i < toks.length) {
      const a = toks[i].accent;
      if (a < 0) {
        out.push(word(toks[i].word, `${id}-w${i}`, ""));
        i++;
        continue;
      }
      const style = scene.accents[a].style;
      const group: string[] = [];
      while (i < toks.length && toks[i].accent === a) {
        group.push(word(toks[i].word, `${id}-w${i}`, style));
        i++;
      }
      out.push(`<span class="acc acc-${style}" id="${id}-a${a}">${group.join(" ")}</span>`);
    }
    return out.join(" ");
    function word(w: string, wid: string, style: string) {
      const cls = style && style !== "marker" ? ` acc-w-${style}` : "";
      return entrance === "mask" ? `<span class="wm"><span class="w${cls}" id="${wid}">${esc(w)}</span></span>` : `<span class="w${cls}" id="${wid}">${esc(w)}</span>`;
    }
  };

  /** entrance tweens for the words of a headline */
  const enter = (scene: Scene, id: string, at: number) => {
    const n = tokenize(scene).length;
    const sel = Array.from({ length: n }, (_, i) => `#${id}-w${i}`).join(", ");
    const stagger = Math.min(0.06, 0.6 / Math.max(1, n));
    switch (scene.entrance) {
      case "mask":
        tw.push(`tl.fromTo("${sel}", { yPercent: 110 }, { yPercent: 0, duration: 0.55, ease: "power4.out", stagger: ${r3(stagger)} }, ${fmt(at)});`);
        break;
      case "pop":
        tw.push(`tl.fromTo("${sel}", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2)", stagger: ${r3(stagger)} }, ${fmt(at)});`);
        break;
      case "type":
        tw.push(`tl.fromTo("${sel}", { opacity: 0 }, { opacity: 1, duration: 0.08, ease: "none", stagger: ${r3(Math.min(0.14, 1.4 / Math.max(1, n)))} }, ${fmt(at)});`);
        break;
      case "slide":
        tw.push(`tl.fromTo("${sel}", { opacity: 0, x: -60 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out", stagger: ${r3(stagger)} }, ${fmt(at)});`);
        break;
      default:
        tw.push(`tl.fromTo("${sel}", { opacity: 0, y: 46 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out", stagger: ${r3(stagger)} }, ${fmt(at)});`);
    }
    // accents land after the words: marker swipe / colour / gradient shimmer
    scene.accents.forEach((a, ai) => {
      const t = at + 0.35 + n * stagger;
      if (a.style === "marker") cues.push({ t, kind: "swipe" });
      if (a.style === "marker") tw.push(`tl.fromTo("#${id}-a${ai}", { backgroundSize: "0% 78%" }, { backgroundSize: "100% 78%", duration: 0.45, ease: "power2.inOut" }, ${fmt(t)});`);
    });
  };

  const kicker = (text: string, id: string, extraCls = "") => (text ? `<span class="kick${extraCls}" id="${id}">${esc(text)}</span>` : "");
  const counter = (i: number) => `<span class="ctr" id="sc${i}-ctr">${String(i + 1).padStart(2, "0")} / ${String(script.beats.length).padStart(2, "0")}</span>`;

  design.scenes.forEach((scene, i) => {
    const t = timings[i];
    const id = `sc${i}`;
    const hook = i === 0;
    const img = o.images[i];
    const body: string[] = [];
    const at = t.start + 0.12;
    const textW = W - 2 * SAFE.x;
    let layout = scene.layout;
    if (layout.startsWith("media_") && !img) layout = "headline";

    const headline = (cls: string, def: number, maxw: number, maxh: number, min: number, align: "left" | "center") =>
      `<div class="hl ${cls}" style="font-size:${size(`${id}-hl`, def)}px;width:${maxw}px;text-align:${align}" ${fitAttrs(`${id}-hl`, maxw, maxh, min)} id="${id}-hl">${words(scene, `${id}-hl`, scene.entrance)}</div>`;

    switch (layout) {
      case "hero_number": {
        const n = scene.number!;
        body.push(`<div class="stack center">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(`<div class="num" id="${id}-num" style="font-size:${size(`${id}-num`, 360)}px" ${fitAttrs(`${id}-num`, textW, 440, 120)}><span class="num-v">${esc(n.value)}</span>${n.unit ? `<span class="num-u">${esc(n.unit)}</span>` : ""}</div>`);
        body.push(headline("hl-hero", 100, 920, 560, 48, "center"));
        if (scene.sub) body.push(`<span class="sub" id="${id}-sub">${esc(scene.sub)}</span>`);
        body.push(`</div>`);
        tw.push(`tl.fromTo("#${id}-num", { opacity: 0, scale: 0.55 }, { opacity: 1, scale: 1, duration: 0.7, ease: "expo.out" }, ${fmt(t.start + 0.05)});`);
        cues.push({ t: t.start + 0.05, kind: "impact" });
        tw.push(`tl.fromTo("#${id}-glow", { opacity: 0 }, { opacity: 1, duration: 0.9, ease: "power1.out" }, ${fmt(t.start)});`);
        enter(scene, `${id}-hl`, t.start + 0.45);
        body.unshift(`<span class="numglow" id="${id}-glow"></span>`);
        break;
      }
      case "media_full": {
        body.push(`<span class="ph full" id="${id}-ph"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
        body.push(`<span class="shade-b" id="${id}-shade"></span>`);
        body.push(`<div class="col center bottom" style="bottom:${H - SAFE.bottom + 10}px">`);
        body.push(`<span class="brandtag" id="${id}-bt">${esc(I.brand)}</span>`);
        body.push(headline("hl-media", hook ? 104 : 92, textW, 560, 48, "center"));
        if (scene.sub) body.push(`<span class="sub" id="${id}-sub">${esc(scene.sub)}</span>`);
        body.push(`</div>`);
        enter(scene, `${id}-hl`, at + 0.15);
        tw.push(`tl.fromTo("#${id}-bt", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${fmt(at)});`);
        break;
      }
      case "media_card": {
        body.push(`<span class="cardglow" id="${id}-cg"></span>`);
        body.push(`<span class="ph card" id="${id}-ph"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
        body.push(`<div class="col center" style="top:${1170}px">`);
        body.push(headline("hl-card", hook ? 104 : 92, textW, 400, 46, "center"));
        body.push(`</div>`);
        tw.push(`tl.fromTo("#${id}-ph", { opacity: 0, y: 70, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.7, ease: "expo.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-cg", { opacity: 0 }, { opacity: 1, duration: 0.9 }, ${fmt(t.start)});`);
        enter(scene, `${id}-hl`, at + 0.3);
        break;
      }
      case "media_split": {
        body.push(`<span class="ph split" id="${id}-ph"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
        body.push(`<span class="splitline" id="${id}-line"></span>`);
        body.push(`<div class="col left" style="top:${1040}px;bottom:${H - SAFE.bottom}px;justify-content:center">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-split", 96, textW, 440, 46, "left"));
        body.push(`</div>`);
        tw.push(`tl.fromTo("#${id}-ph", { clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0% 0)", duration: 0.7, ease: "power4.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-line", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, ${fmt(t.start + 0.25)});`);
        enter(scene, `${id}-hl`, at + 0.35);
        break;
      }
      case "list": {
        body.push(`<div class="stack left">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-list", 96, textW, 380, 46, "left"));
        body.push(`<div class="items" id="${id}-items">`);
        scene.items.forEach((it, k) => {
          body.push(`<div class="item" id="${id}-it${k}"><span class="badge">${String(k + 1).padStart(2, "0")}</span><span class="itext" style="font-size:${size(`${id}-it${k}`, 66)}px" ${fitAttrs(`${id}-it${k}`, textW - 150, 170, 34)}>${esc(it)}</span></div>`);
          const itAt = at + 0.6 + k * Math.min(0.55, (t.duration - 1.6) / Math.max(1, scene.items.length));
          tw.push(`tl.fromTo("#${id}-it${k}", { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, ${fmt(itAt)});`);
          cues.push({ t: itAt, kind: "tick" });
        });
        body.push(`</div></div>`);
        enter(scene, `${id}-hl`, at);
        break;
      }
      case "chat": {
        body.push(`<div class="stack left">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-chat", 96, textW, 360, 44, "left"));
        body.push(`<div class="chat" id="${id}-chat">`);
        scene.items.forEach((m, k) => {
          const side = k % 2 ? "r" : "l";
          body.push(`<div class="bub ${side}" id="${id}-b${k}"><span class="btext" style="font-size:${size(`${id}-b${k}`, 54)}px" ${fitAttrs(`${id}-b${k}`, 760, 280, 32)}>${esc(m)}</span></div>`);
          const bAt = at + 0.5 + k * Math.min(0.75, (t.duration - 1.6) / Math.max(1, scene.items.length));
          tw.push(`tl.fromTo("#${id}-b${k}", { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, ${fmt(bAt)});`);
          cues.push({ t: bAt, kind: "pop" });
        });
        body.push(`</div></div>`);
        enter(scene, `${id}-hl`, at);
        break;
      }
      case "timeline": {
        const pts = scene.items;
        body.push(`<div class="stack left">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-tl", 104, textW, 460, 46, "left"));
        body.push(`<div class="tlwrap" id="${id}-tlw">`);
        const y = 150;
        const x0 = 40;
        const x1 = textW - 40;
        body.push(`<span class="track" id="${id}-track" style="top:${y}px;left:${x0}px;width:${x1 - x0}px"></span>`);
        pts.forEach((label, k) => {
          const x = x0 + ((x1 - x0) * k) / Math.max(1, pts.length - 1);
          const above = k % 2 === 0;
          body.push(`<span class="dot" id="${id}-d${k}" style="left:${r1(x - 16)}px;top:${y - 14}px"></span>`);
          body.push(`<span class="tlab ${above ? "up" : "down"}" id="${id}-l${k}" style="left:${r1(x - 110)}px;top:${above ? y - 120 : y + 52}px">${esc(label)}</span>`);
          const dAt = at + 0.7 + k * Math.min(0.45, (t.duration - 1.8) / Math.max(1, pts.length));
          tw.push(`tl.fromTo("#${id}-d${k}, #${id}-l${k}", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" }, ${fmt(dAt)});`);
          cues.push({ t: dAt, kind: "tick" });
        });
        body.push(`</div></div>`);
        tw.push(`tl.fromTo("#${id}-track", { scaleX: 0 }, { scaleX: 1, duration: ${fmt(Math.min(1.6, t.duration * 0.5))}, ease: "power2.inOut" }, ${fmt(at + 0.5)});`);
        enter(scene, `${id}-hl`, at);
        break;
      }
      case "compare": {
        const [la, va, lb, vb] = scene.items;
        body.push(`<div class="stack left">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-cmp", 100, textW, 420, 46, "left"));
        const cw = (W - 2 * SAFE.x - 40) / 2;
        body.push(`<div class="cmp" id="${id}-cmp">`);
        body.push(`<div class="cc a" id="${id}-ca" style="width:${r1(cw)}px"><span class="cl">${esc(la)}</span><span class="cv" style="font-size:${size(`${id}-va`, 120)}px" ${fitAttrs(`${id}-va`, cw - 60, 200, 44)}>${esc(va)}</span></div>`);
        body.push(`<div class="cc b" id="${id}-cb" style="width:${r1(cw)}px"><span class="cl">${esc(lb)}</span><span class="cv" style="font-size:${size(`${id}-vb`, 120)}px" ${fitAttrs(`${id}-vb`, cw - 60, 200, 44)}>${esc(vb)}</span></div>`);
        body.push(`</div></div>`);
        tw.push(`tl.fromTo("#${id}-ca", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(at + 0.5)});`);
        tw.push(`tl.fromTo("#${id}-cb", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(at + 0.85)});`);
        cues.push({ t: at + 0.5, kind: "pop" }, { t: at + 0.85, kind: "pop", gain: 2 });
        enter(scene, `${id}-hl`, at);
        break;
      }
      case "quote": {
        body.push(`<div class="stack center">`);
        body.push(`<span class="qmark" id="${id}-q">“</span>`);
        body.push(headline("hl-quote", 108, 920, 820, 50, "center"));
        body.push(`<span class="rule" id="${id}-rule"></span>`);
        if (scene.sub) body.push(`<span class="sub mono" id="${id}-sub">${esc(scene.sub)}</span>`);
        body.push(`</div>`);
        tw.push(`tl.fromTo("#${id}-q", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.inOut" }, ${fmt(at + 0.8)});`);
        enter(scene, `${id}-hl`, at + 0.15);
        break;
      }
      case "orbit_title": {
        // a giant title on a plane at z = 0 inside one preserve-3d world; a tilted ring of cubes spins around it,
        // so the browser depth-sorts the cubes in front of / behind the letters. Geometry is fixed here (seeded).
        const rnd = seeded(`orbit:${i}:${scene.headline}`);
        // palette cubes: both accents, their mix, two neighbouring hues, a pale and a deep tone (weighted to the accent)
        const colors = [P.accent, P.accent, P.accent2, mixHex(P.accent, P.accent2, 0.5), hueShift(P.accent, 22), hueShift(P.accent2, -18), mixHex(P.accent, "#FFFFFF", 0.55), mixHex(P.accent, P.bg, 0.45)];
        const N = 32;
        const cubes: string[] = [];
        const order = Array.from({ length: N }, (_, k) => k).sort((a, b) => ((a * 7) % N) - ((b * 7) % N));
        for (let k = 0; k < N; k++) {
          const th = (2 * Math.PI * k) / N + (rnd() - 0.5) * 0.12;
          const R = 455 + (rnd() - 0.5) * 50;
          const s = Math.round(30 + rnd() * 34);
          const lift = r1((rnd() - 0.5) * 70);
          const c = colors[Math.floor(rnd() * colors.length)];
          const [ax, ay] = [Math.round(rnd() * 360), Math.round(rnd() * 360)];
          const [dx, dy] = [Math.round(80 + rnd() * 140) * (rnd() < 0.5 ? -1 : 1), Math.round(90 + rnd() * 160)];
          cubes.push(`<span class="bk" style="left:${-s / 2}px;top:${-s / 2}px;width:${s}px;height:${s}px;transform:translate3d(${r1(R * Math.cos(th))}px, ${r1(R * Math.sin(th))}px, ${lift}px)"><span class="cube" id="${id}-cb${k}"><span class="cube" id="${id}-cr${k}">${cubeFaces(s, c)}</span></span></span>`);
          const inAt = t.start + 0.05 + order.indexOf(k) * 0.022;
          tw.push(`tl.fromTo("#${id}-cb${k}", { scale: 0 }, { scale: 1, duration: 0.55, ease: "back.out(2.2)" }, ${fmt(inAt)});`);
          tw.push(`tl.fromTo("#${id}-cr${k}", { rotationX: ${ax}, rotationY: ${ay} }, { rotationX: ${ax + dx}, rotationY: ${ay + dy}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        }
        const cap = scene.kicker || scene.sub;
        body.push(`<span class="otglow" id="${id}-glow"></span>`);
        body.push(`<div class="st3" id="${id}-st"><div class="w3" id="${id}-w3">`);
        body.push(`<div class="otcol" id="${id}-col">`);
        // the title fits inside the ring (inner diameter ≈ 840 px) so side cubes never cover the outer letters
        body.push(headline("hl-orbit", hook ? 176 : 160, 840, 560, 60, "center"));
        body.push(`</div>`);
        body.push(`<div class="ring"><div class="spin" id="${id}-spin"><div class="spin" id="${id}-spin2">${cubes.join("")}</div></div></div>`);
        body.push(`</div></div>`);
        // rule + caption sit flat below the ring's front arc, never hidden by a passing cube
        body.push(`<div class="col center" style="top:${CY + 400}px;gap:26px"><span class="rule" id="${id}-rule"></span>${cap ? `<span class="otcap" id="${id}-cap">${esc(cap)}</span>` : ""}</div>`);
        // the ring settles fast (spin2) while a slow constant drift (spin) keeps it alive; the camera sways
        tw.push(`tl.fromTo("#${id}-spin2", { rotation: -150 }, { rotation: 0, duration: 1.5, ease: "expo.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-spin", { rotation: 0 }, { rotation: ${fmt(Math.min(70, 16 * t.duration))}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-w3", { rotationY: -10, rotationX: 3, z: -140 }, { rotationY: 8, rotationX: -4, z: 0, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-glow", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 1.2, ease: "power2.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, ${fmt(at + 0.9)});`);
        if (cap) tw.push(`tl.fromTo("#${id}-cap", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fmt(at + 1.05)});`);
        enter(scene, `${id}-hl`, at + 0.3);
        cues.push({ t: t.start, kind: "riser", gain: -2 }, { t: t.start + 1.2, kind: "impact", gain: -4 });
        break;
      }
      case "depth_cards": {
        // 3–4 cards hang at different depths; the camera dollies and tilts through them and each card in turn
        // comes forward (z), lights up in the accent and dims back when the next one takes over.
        const n = scene.items.length;
        const cardH = n >= 4 ? 176 : 206;
        const gapY = n >= 4 ? 34 : 46;
        const Y0 = 700;
        const total = n * cardH + (n - 1) * gapY;
        const top0 = Y0 + Math.max(0, (SAFE.bottom - 30 - Y0 - total) / 2);
        const cw = 800;
        const depth = [0, -130, -50, -170];
        body.push(`<div class="col left" style="top:${SAFE.top + 90}px">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-dc", 96, textW, 340, 44, "left"));
        body.push(`</div>`);
        body.push(`<div class="st3 dcst" id="${id}-st"><div class="w3 dccam" id="${id}-cam">`);
        const step = Math.min(0.95, (t.duration - 1.7) / Math.max(1, n));
        scene.items.forEach((it, k) => {
          const left = r1((W - cw) / 2 + (k % 2 ? 46 : -46));
          const top = r1(top0 + k * (cardH + gapY));
          const ry = k % 2 ? -8 : 8;
          const rz = k % 2 ? 1.2 : -1.2;
          body.push(
            `<div class="dc" style="left:${left}px;top:${top}px;width:${cw}px;height:${cardH}px;transform:translate3d(0px, 0px, ${depth[k]}px) rotateY(${ry}deg) rotateZ(${rz}deg)"><div class="dcb" id="${id}-c${k}"><span class="dcs" id="${id}-cs${k}"></span><div class="dcrow" id="${id}-ct${k}"><span class="dcn">${String(k + 1).padStart(2, "0")}</span><span class="dct" style="font-size:${size(`${id}-c${k}t`, 58)}px" ${fitAttrs(`${id}-c${k}t`, cw - 230, cardH - 44, 30)}>${esc(it)}</span></div></div></div>`,
          );
          const inAt = t.start + 0.12 + k * 0.12;
          tw.push(`tl.fromTo("#${id}-c${k}", { z: -1400, opacity: 0 }, { z: 0, opacity: 0.5, duration: 0.85, ease: "expo.out" }, ${fmt(inAt)});`);
          const onAt = at + 0.95 + k * step;
          tw.push(`tl.fromTo("#${id}-c${k}", { z: 0, opacity: 0.5, backgroundColor: "${P.bg2}" }, { z: 170, opacity: 1, backgroundColor: "${P.accent}", duration: 0.45, ease: "back.out(1.5)", immediateRender: false }, ${fmt(onAt)});`);
          // text colour snaps (never interpolates against the changing fill): on once the fill is accent, off at once
          tw.push(`tl.fromTo("#${id}-ct${k}", { color: "${P.text}" }, { color: "${accentText}", duration: 0.08, ease: "none", immediateRender: false }, ${fmt(onAt + 0.28)});`);
          tw.push(`tl.fromTo("#${id}-cs${k}", { scaleY: 0 }, { scaleY: 1, duration: 0.4, ease: "power3.out" }, ${fmt(onAt)});`);
          if (k < n - 1) tw.push(`tl.fromTo("#${id}-c${k}", { z: 170, opacity: 1, backgroundColor: "${P.accent}" }, { z: 30, opacity: 0.85, backgroundColor: "${P.bg2}", duration: 0.45, ease: "power2.inOut", immediateRender: false }, ${fmt(onAt + step)});`);
          if (k < n - 1) tw.push(`tl.fromTo("#${id}-ct${k}", { color: "${accentText}" }, { color: "${P.text}", duration: 0.08, ease: "none", immediateRender: false }, ${fmt(onAt + step)});`);
          cues.push({ t: onAt, kind: "tick" });
        });
        body.push(`</div></div>`);
        tw.push(`tl.fromTo("#${id}-cam", { z: -240, rotationX: 20, rotationY: -12 }, { z: 30, rotationX: 7, rotationY: 7, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        cues.push({ t: t.start + 0.12, kind: "whoosh", gain: -3 });
        enter(scene, `${id}-hl`, at);
        break;
      }
      case "tunnel_number": {
        // a big number flies out of a perspective grid tunnel: four grid walls recede to the vanishing point,
        // the tunnel moves towards the camera (fast, then a slow drift) and the number lands at z = 0.
        const n = scene.number!;
        const L = 2600;
        const [hwL, hwR, hT, hB] = [W / 2, W / 2, CY, H - CY];
        body.push(`<span class="tnglow" id="${id}-glow"></span>`);
        body.push(`<div class="st3 tnst" id="${id}-st"><div class="w3" id="${id}-w3">`);
        body.push(`<div class="tn" id="${id}-tn"><div class="spin" id="${id}-tn2">`);
        body.push(`<i class="tw tw-f" style="left:${-hwL}px;top:${hB}px;width:${hwL + hwR}px;height:${L}px"></i>`);
        body.push(`<i class="tw tw-c" style="left:${-hwL}px;top:${-hT - L}px;width:${hwL + hwR}px;height:${L}px"></i>`);
        body.push(`<i class="tw tw-l" style="left:${-hwL - L}px;top:${-hT}px;width:${L}px;height:${hT + hB}px"></i>`);
        body.push(`<i class="tw tw-r" style="left:${hwR}px;top:${-hT}px;width:${L}px;height:${hT + hB}px"></i>`);
        body.push(`</div></div>`);
        body.push(`<div class="tncol"><div class="num tnum" id="${id}-num" style="font-size:${size(`${id}-num`, 340)}px" ${fitAttrs(`${id}-num`, textW - 80, 400, 120)}><span class="num-v">${esc(n.value)}</span>${n.unit ? `<span class="num-u">${esc(n.unit)}</span>` : ""}</div></div>`);
        body.push(`</div></div>`);
        body.push(`<div class="col center" style="top:${CY + 230}px">`);
        body.push(headline("hl-tn", 92, textW, 420, 44, "center"));
        if (scene.sub) body.push(`<span class="sub" id="${id}-sub">${esc(scene.sub)}</span>`);
        body.push(`</div>`);
        if (scene.kicker) body.push(`<div class="col center" style="top:${CY - 400}px">${kicker(scene.kicker, `${id}-k`)}</div>`);
        tw.push(`tl.fromTo("#${id}-tn", { z: -200 }, { z: 420, duration: 1.1, ease: "expo.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-tn2", { z: 0 }, { z: ${fmt(Math.min(380, 60 * t.duration))}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-w3", { rotationZ: -4, rotationY: 5 }, { rotationZ: 2, rotationY: -4, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-num", { z: -2400, opacity: 0 }, { z: 0, opacity: 1, duration: 0.9, ease: "expo.out" }, ${fmt(t.start + 0.15)});`);
        tw.push(`tl.fromTo("#${id}-glow", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 1, ease: "power2.out" }, ${fmt(t.start)});`);
        cues.push({ t: t.start, kind: "whoosh", gain: -1 }, { t: t.start + 0.7, kind: "impact" });
        enter(scene, `${id}-hl`, at + 0.6);
        break;
      }
      default: {
        // headline
        body.push(`<div class="stack left">`);
        body.push(kicker(scene.kicker, `${id}-k`));
        body.push(headline("hl-main", hook ? 132 : 116, textW, 900, 54, "left"));
        body.push(`<span class="rule left" id="${id}-rule"></span>`);
        if (scene.sub) body.push(`<span class="sub" id="${id}-sub">${esc(scene.sub)}</span>`);
        body.push(`</div>`);
        tw.push(`tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, ${fmt(at + 0.5)});`);
        enter(scene, `${id}-hl`, at);
      }
    }
    // shared: kicker / sub entrance, counter, image camera move, exit
    if (scene.kicker && layout !== "media_full" && layout !== "orbit_title") tw.push(`tl.fromTo("#${id}-k", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${fmt(t.start)});`);
    if (scene.sub && ["hero_number", "media_full", "headline", "quote", "tunnel_number"].includes(layout)) tw.push(`tl.fromTo("#${id}-sub", { opacity: 0 }, { opacity: 1, duration: 0.5 }, ${fmt(at + 0.9)});`);
    if (layout.startsWith("media_") && scene.image) {
      const m = scene.image.motion;
      const [from, to] = m === "zoom_out" ? ["scale: 1.16", "scale: 1"] : m === "pan_left" ? ["scale: 1.14, xPercent: 3", "scale: 1.14, xPercent: -3"] : m === "pan_right" ? ["scale: 1.14, xPercent: -3", "scale: 1.14, xPercent: 3"] : ["scale: 1", "scale: 1.14"];
      tw.push(`tl.fromTo("#${id}-img", { ${from} }, { ${to}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
    }
    body.push(counter(i));
    if (i > 0) cues.push({ t: Math.max(0, t.start - 0.12), kind: layout.startsWith("media_") ? "whoosh" : "whoosh", gain: layout.startsWith("media_") ? 2 : 0 });
    if (i === design.scenes.length - 1) cues.push({ t: t.start + 0.5, kind: "ding" });
    if (hook && !["hero_number", "orbit_title", "tunnel_number"].includes(layout)) cues.push({ t: 0.05, kind: "impact", gain: -3 });
    // exit: the scene's content fades out in its last 0.2 s (the background stays)
    if (t.duration > 1.2 && i < design.scenes.length - 1) tw.push(`tl.fromTo("#${id}-in", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power1.in", immediateRender: false }, ${fmt(t.start + t.duration - 0.2)});`);
    sections.push(
      `      <section id="${id}" class="clip scene L-${layout}${hook ? " hook" : ""}" data-start="${fmt(t.start)}" data-duration="${fmt(t.duration)}" data-track-index="1">\n        <div class="in" id="${id}-in">\n          ${body.filter(Boolean).join("\n          ")}\n        </div>\n      </section>`,
    );
  });

  const D = FONTS[display];
  const A = FONTS[accentFont];
  const K = FONTS[kickerFont];
  const texture =
    I.texture === "grid"
      ? `background-image: linear-gradient(${light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)"} 1px, transparent 1px), linear-gradient(90deg, ${light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)"} 1px, transparent 1px); background-size: 72px 72px;`
      : I.texture === "grain"
        ? `background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${light ? 0.05 : 0.09}'/></svg>");`
        : "";

  const html = `<!doctype html>
<html lang="${esc(script.language)}" data-resolution="portrait">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- generated by vedit make-director/1 · ${esc(script.title)} -->
    <script src="${o.gsapRel}"></script>
    <style>
      ${o.fontFaces}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: ${P.bg}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; color: ${P.text}; font-family: ${fontStack(display)}; }
      .bg { position: absolute; inset: 0; display: block; background: radial-gradient(120% 80% at 20% 0%, ${P.bg2} 0%, ${P.bg} 62%); }
      .tex { position: absolute; inset: 0; display: block; ${texture} }
      .glow { position: absolute; left: -300px; top: 200px; width: 1200px; height: 1200px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}${I.texture === "glow" ? "44" : "22"}, transparent); }
      .brand { position: absolute; left: ${SAFE.x}px; top: ${SAFE.top - 20}px; display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 26px; letter-spacing: 0.16em; color: ${P.muted}; text-transform: uppercase; }
      .bar { position: absolute; left: ${SAFE.x}px; right: ${SAFE.x}px; top: ${SAFE.top + 28}px; height: 4px; display: block; border-radius: 2px; background: ${light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.14)"}; overflow: hidden; }
      .barf { display: block; width: 100%; height: 100%; background: ${P.accent}; transform-origin: left center; }
      .scene { position: absolute; inset: 0; overflow: hidden; }
      .in { position: absolute; inset: 0; }
      .ctr { position: absolute; right: ${SAFE.x}px; top: ${SAFE.top - 20}px; display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 26px; letter-spacing: 0.12em; color: ${P.muted}; }
      .col { position: absolute; left: ${SAFE.x}px; right: ${SAFE.x}px; display: flex; flex-direction: column; gap: 30px; }
      .col.center { align-items: center; text-align: center; }
      .col.left { align-items: flex-start; }
      .col.bottom { justify-content: flex-end; }
      .stack { position: absolute; left: ${SAFE.x}px; right: ${SAFE.x}px; top: ${SAFE.top + 90}px; bottom: ${H - SAFE.bottom}px; display: flex; flex-direction: column; justify-content: center; gap: 38px; }
      .stack.center { align-items: center; text-align: center; }
      .stack.left { align-items: flex-start; }
      .tlwrap { position: relative; display: block; width: 100%; height: 300px; margin-top: 40px; }
      .kick { display: block; font-family: ${fontStack(kickerFont)}; font-weight: ${K.weight}; font-size: 34px; letter-spacing: 0.14em; text-transform: uppercase; color: ${P.accent}; }
      .hl { display: block; font-family: ${fontStack(display)}; font-weight: ${D.weight}; font-style: ${D.style}; line-height: 1.04; letter-spacing: ${D.tracking}; color: ${P.text}; text-wrap: balance; }
      .hook .hl { line-height: 1.0; }
      .w { display: inline-block; }
      .wm { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.1em; margin-bottom: -0.1em; }
      .acc { }
      .acc-marker { background-image: linear-gradient(${P.accent}, ${P.accent}); background-repeat: no-repeat; background-position: 0 70%; background-size: 100% 78%; -webkit-box-decoration-break: clone; box-decoration-break: clone; padding: 0 0.08em; color: ${accentText}; }
      .acc-w-color { color: ${P.accent}; }
      .acc-w-serif { font-family: ${fontStack(accentFont)}; font-weight: ${A.weight}; font-style: ${A.style}; letter-spacing: ${A.tracking}; color: ${P.accent}; }
      .acc-w-gradient { background-image: linear-gradient(100deg, ${P.accent} 0%, ${P.accent2} 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .acc-w-outline { color: transparent; -webkit-text-stroke: 3px ${P.accent}; }
      .sub { display: block; font-size: 44px; font-weight: 600; line-height: 1.25; color: ${P.muted}; max-width: 900px; }
      .sub.mono { font-family: ${fontStack("mono")}; font-size: 30px; letter-spacing: 0.08em; text-transform: uppercase; }
      .rule { display: block; width: 180px; height: 6px; border-radius: 3px; background: ${P.accent}; transform-origin: center; }
      .rule.left { transform-origin: left center; }
      .num { display: block; white-space: nowrap; font-family: ${fontStack(display)}; font-weight: ${D.weight}; line-height: 0.95; letter-spacing: -0.04em; }
      .num-v { background-image: linear-gradient(170deg, ${P.accent2} 0%, ${P.accent} 70%); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .num-u { font-size: 0.34em; margin-left: 0.12em; color: ${P.accent}; letter-spacing: -0.01em; }
      .numglow { position: absolute; left: 40px; top: 420px; width: 1000px; height: 900px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}55, transparent); }
      .hl-hero { line-height: 1.08; }
      .ph { position: absolute; display: block; overflow: hidden; }
      .ph.full { inset: 0; }
      .ph.card { left: 110px; top: 210px; width: 860px; height: 900px; border-radius: 48px; box-shadow: 0 30px 120px ${P.accent}55; }
      .ph.split { left: 0; top: 0; width: ${W}px; height: 1000px; }
      .img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .cardglow { position: absolute; left: 40px; top: 160px; width: 1000px; height: 1000px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}40, transparent); }
      .shade-b { position: absolute; inset: 0; display: block; background: linear-gradient(to bottom, rgba(0,0,0,0) 35%, ${P.bg}E6 78%, ${P.bg} 100%); }
      .L-media_full .hl, .L-media_full .sub { color: ${light ? P.text : "#FFFFFF"}; }
      .brandtag { display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 28px; letter-spacing: 0.16em; color: ${P.accent}; }
      .splitline { position: absolute; left: 0; top: 996px; width: ${W}px; height: 8px; display: block; background: ${P.accent}; transform-origin: left center; }
      .items { display: flex; flex-direction: column; gap: 40px; margin-top: 20px; width: 100%; }
      .item { display: flex; align-items: center; gap: 30px; }
      .badge { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 110px; height: 110px; border-radius: 32px; background: ${P.accent}; color: ${accentText}; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 36px; }
      .itext { display: block; font-weight: 700; line-height: 1.12; color: ${P.text}; }
      .chat { display: flex; flex-direction: column; gap: 28px; width: 100%; margin-top: 20px; }
      .bub { display: block; max-width: 800px; padding: 26px 34px; border-radius: 40px; }
      .bub.l { align-self: flex-start; background: ${light ? "#FFFFFF" : P.bg2}; border-bottom-left-radius: 10px; color: ${P.text}; box-shadow: 0 10px 40px rgba(0,0,0,${light ? 0.08 : 0.3}); }
      .bub.r { align-self: flex-end; background: ${P.accent}; border-bottom-right-radius: 10px; color: ${accentText}; }
      .btext { display: block; font-family: ${fontStack("inter")}; font-weight: 600; line-height: 1.25; }
      .track { position: absolute; display: block; height: 8px; border-radius: 4px; background: ${P.accent}; transform-origin: left center; }
      .dot { position: absolute; display: block; width: 36px; height: 36px; border-radius: 50%; background: ${P.bg}; border: 8px solid ${P.accent}; }
      .tlab { position: absolute; display: block; width: 220px; text-align: center; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 40px; line-height: 1.15; color: ${P.text}; }
      .cmp { display: flex; gap: 40px; width: 100%; margin-top: 30px; }
      .cc { display: flex; flex-direction: column; gap: 22px; padding: 44px 30px; border-radius: 36px; min-height: 360px; justify-content: center; }
      .cc.a { background: ${light ? "#FFFFFF" : P.bg2}; color: ${P.text}; }
      .cc.b { background: ${P.accent}; color: ${accentText}; }
      .cl { display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 30px; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.8; }
      .cv { display: block; white-space: nowrap; font-weight: ${D.weight}; line-height: 1; letter-spacing: -0.03em; }
      .qmark { display: block; font-family: ${fontStack(accentFont)}; font-weight: ${A.weight}; font-size: 300px; line-height: 0.6; height: 150px; color: ${P.accent}; }
      /* 3D layouts: one perspective stage per scene, one preserve-3d world inside it */
      .st3 { position: absolute; inset: 0; perspective: 1500px; perspective-origin: 50% ${CY}px; }
      .w3 { position: absolute; inset: 0; transform-style: preserve-3d; transform-origin: ${W / 2}px ${CY}px; }
      .otglow { position: absolute; left: -110px; top: ${CY - 650}px; width: 1300px; height: 1300px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}3A, ${P.accent2}14 55%, transparent); }
      .otcol { position: absolute; left: ${SAFE.x}px; right: ${SAFE.x}px; top: ${CY - 380}px; height: 600px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; text-align: center; }
      .hl-orbit { line-height: 0.98; letter-spacing: -0.035em; text-shadow: 0 6px 40px rgba(0,0,0,${light ? 0.08 : 0.35}); }
      .otcap { display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 30px; letter-spacing: 0.18em; text-transform: uppercase; color: ${P.muted}; }
      .ring { position: absolute; left: ${W / 2}px; top: ${CY - 55}px; width: 0; height: 0; transform-style: preserve-3d; transform: rotateZ(-11deg) rotateX(58deg); }
      .spin { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-style: preserve-3d; }
      .bk { position: absolute; display: block; transform-style: preserve-3d; }
      .cube { position: absolute; inset: 0; display: block; transform-style: preserve-3d; }
      .fc { position: absolute; inset: 0; display: block; backface-visibility: hidden; border-radius: 3px; }
      .dcst { perspective: 1300px; perspective-origin: 50% 1000px; }
      .dccam { transform-origin: ${W / 2}px 1100px; }
      .dc { position: absolute; display: block; transform-style: preserve-3d; }
      .dcb { position: absolute; inset: 0; display: flex; align-items: center; gap: 30px; padding: 0 40px 0 50px; border-radius: 34px; overflow: hidden; background: ${P.bg2}; color: ${P.text}; border: 2px solid ${light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.1)"}; box-shadow: 0 30px 70px rgba(0,0,0,${light ? 0.14 : 0.45}); }
      .dcrow { display: flex; align-items: center; gap: 30px; color: ${P.text}; }
      .dcs { position: absolute; left: 0; top: 0; bottom: 0; width: 12px; display: block; background: ${P.accent2}; transform-origin: center top; }
      .dcn { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 96px; height: 96px; border-radius: 28px; border: 3px solid currentColor; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 34px; }
      .dct { display: block; font-weight: 700; line-height: 1.1; }
      .tnst { perspective: 900px; }
      .tn { position: absolute; left: ${W / 2}px; top: ${CY}px; width: 0; height: 0; transform-style: preserve-3d; }
      .tw { position: absolute; display: block; background-image: linear-gradient(${P.accent}55 3px, transparent 3px), linear-gradient(90deg, ${P.accent}55 3px, transparent 3px); background-size: 180px 180px; }
      .tw-f { transform-origin: 50% 0; transform: rotateX(-90deg); -webkit-mask-image: linear-gradient(to bottom, #000 0%, transparent 92%); mask-image: linear-gradient(to bottom, #000 0%, transparent 92%); }
      .tw-c { transform-origin: 50% 100%; transform: rotateX(90deg); -webkit-mask-image: linear-gradient(to top, #000 0%, transparent 92%); mask-image: linear-gradient(to top, #000 0%, transparent 92%); }
      .tw-l { transform-origin: 100% 50%; transform: rotateY(-90deg); -webkit-mask-image: linear-gradient(to left, #000 0%, transparent 92%); mask-image: linear-gradient(to left, #000 0%, transparent 92%); }
      .tw-r { transform-origin: 0 50%; transform: rotateY(90deg); -webkit-mask-image: linear-gradient(to right, #000 0%, transparent 92%); mask-image: linear-gradient(to right, #000 0%, transparent 92%); }
      .tnglow { position: absolute; left: 140px; top: ${CY - 400}px; width: 800px; height: 800px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}55, transparent); }
      .tncol { position: absolute; left: ${SAFE.x}px; right: ${SAFE.x}px; top: ${CY - 300}px; height: 460px; display: flex; align-items: center; justify-content: center; }
      .tnum { text-align: center; }
      .hl-quote { font-family: ${fontStack(accentFont === "mono" ? display : accentFont)}; font-weight: ${(accentFont === "mono" ? D : A).weight}; font-style: ${(accentFont === "mono" ? D : A).style}; line-height: 1.12; }
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
      <section id="bgl" class="clip bg" data-start="0" data-duration="${fmt(DUR)}" data-track-index="0">
        <span class="tex" id="bg-tex"></span>
        <span class="glow" id="bg-glow"></span>
        <span class="brand" id="bg-brand">${esc(I.brand)}</span>
        <span class="bar" id="bg-bar"><span class="barf" id="bg-barf"></span></span>
      </section>
${sections.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      tl.fromTo("#bg-glow", { x: 0, y: 0 }, { x: 420, y: 380, duration: ${fmt(DUR)}, ease: "sine.inOut" }, 0);
      tl.fromTo("#bg-barf", { scaleX: 0 }, { scaleX: 1, duration: ${fmt(DUR)}, ease: "none" }, 0);
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration: DUR, timings, fonts, cues };
}
