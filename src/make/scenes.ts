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
    if (scene.kicker && layout !== "media_full") tw.push(`tl.fromTo("#${id}-k", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${fmt(t.start)});`);
    if (scene.sub && ["hero_number", "media_full", "headline", "quote"].includes(layout)) tw.push(`tl.fromTo("#${id}-sub", { opacity: 0 }, { opacity: 1, duration: 0.5 }, ${fmt(at + 0.9)});`);
    if (layout.startsWith("media_") && scene.image) {
      const m = scene.image.motion;
      const [from, to] = m === "zoom_out" ? ["scale: 1.16", "scale: 1"] : m === "pan_left" ? ["scale: 1.14, xPercent: 3", "scale: 1.14, xPercent: -3"] : m === "pan_right" ? ["scale: 1.14, xPercent: -3", "scale: 1.14, xPercent: 3"] : ["scale: 1", "scale: 1.14"];
      tw.push(`tl.fromTo("#${id}-img", { ${from} }, { ${to}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
    }
    body.push(counter(i));
    if (i > 0) cues.push({ t: Math.max(0, t.start - 0.12), kind: layout.startsWith("media_") ? "whoosh" : "whoosh", gain: layout.startsWith("media_") ? 2 : 0 });
    if (i === design.scenes.length - 1) cues.push({ t: t.start + 0.5, kind: "ding" });
    if (hook && layout !== "hero_number") cues.push({ t: 0.05, kind: "impact", gain: -3 });
    // exit: the scene's content fades out in its last 0.2 s (the background stays)
    if (t.duration > 1.2 && i < design.scenes.length - 1) tw.push(`tl.fromTo("#${id}-in", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power1.in", immediateRender: false }, ${fmt(t.start + t.duration - 0.2)});`);
    sections.push(
      `      <section id="${id}" class="clip scene L-${layout}${hook ? " hook" : ""}" data-start="${fmt(t.start)}" data-duration="${fmt(t.duration)}" data-track-index="1">\n        <div class="in" id="${id}-in">\n          ${body.filter(Boolean).join("\n          ")}\n        </div>\n      </section>`,
    );
  });

  const D = FONTS[display];
  const A = FONTS[accentFont];
  const K = FONTS[kickerFont];
  const accentText = onColor(P.accent);
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
