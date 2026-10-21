import type { SfxCue } from "../../audio/sfx.ts";
import type { BedCue } from "./sfxbed.ts";
import type { Frame } from "../../lib/aspect.ts";
import type { Promo, Ui } from "./schema.ts";
import { buildUi, cursor, esc, hashStr, guessIcon, MONOGRAMS, monogramSvg, uiCss, uiSeconds, type CamKey, type UiCtx } from "./ui.ts";

/**
 * Stage 31: a promo → one HyperFrames composition. Scenes follow the reference (#16, 16:9; #17, 9:16): every 2–3 s a
 * new card — kinetic type that blurs in word by word on a light (off-white) or dark (bokeh) field, or a product UI
 * drawn in code under a camera that dollies and tilts over it while a cursor works. Consecutive scenes overlap by
 * OVERLAP seconds so the incoming one blurs/zooms/irises in over the outgoing one (a real crossfade, not a dip).
 * Every scene is a section (clip) on alternating tracks 1/2; all motion is on one paused GSAP timeline; tweened nodes
 * never carry a CSS transform; nothing is measured at render time (text fit happens before, in Chrome).
 */

export const FPS = 30;
/** crossfade length between scenes (s) */
export const OVERLAP = 0.4;

export type SceneKind = "hook" | "text" | "logo" | "rotate" | "ui" | "cloud" | "tagline" | "cta";
export type Transition = "blur" | "zoom" | "iris" | "cut";
export type Theme = "light" | "dark";

export interface PromoScene {
  kind: SceneKind;
  /** narration group (voice): hook, pains, reveal…, each feature, proof, ending */
  group: number;
  theme: Theme;
  dur: number;
  /** how this scene enters over the previous one */
  trans: Transition;
  /** kinetic text */
  text?: { a: string; b: string; dim: string };
  /** stack (two centred lines) or stream (one line, the camera follows the words — 9:16) */
  style?: "stack" | "stream";
  prop?: { kind: "sticky" | "tabs" | "chips" | "swap" | "strike"; labels: string[] };
  ui?: Ui;
  /** minimum length when the cuts move onto the music */
  min: number;
}

export interface SceneTiming {
  start: number;
  duration: number;
  kind: SceneKind;
  group: number;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const f = (n: number) => String(r3(n));
const onFrame = (s: number) => Math.max(1, Math.round(s * FPS)) / FPS;
const wordsOf = (s: string) => s.split(/\s+/).filter(Boolean);

/** The scene list of a promo (pure): structure of the reference, lengths from the content. */
export function planPromo(p: Promo, o: { frame: Frame }): PromoScene[] {
  const portrait = o.frame.h > o.frame.w;
  // 9:16: one line word by word (reference #17) only when it fits the frame at full size; a longer line would run off
  // the edge while the camera follows it, so it is set as two centred lines instead
  const lineFits = (t: { a: string; b: string }) => {
    const fs = 128 * (Math.min(o.frame.w, o.frame.h) / 1080);
    const ws = [...wordsOf(t.a).map((w) => textWidthEm(w, 420)), ...wordsOf(t.b).map((w) => textWidthEm(w, 720) * 1.18)];
    return ws.reduce((n, w) => n + w * fs, 0) + 0.24 * fs * Math.max(0, ws.length - 1) <= o.frame.w * 0.88;
  };
  const style = (t: { a: string; b: string }): "stack" | "stream" => (portrait && wordsOf(`${t.a} ${t.b}`).length <= 4 && lineFits(t) ? "stream" : "stack");
  const readS = (t: { a: string; b: string }, base: number) => Math.max(base, Math.min(3.2, 1.1 + wordsOf(`${t.a} ${t.b}`).length * 0.22));
  const out: PromoScene[] = [];
  let g = 0;
  out.push({ kind: "hook", group: g, theme: "light", dur: p.hook.kind === "toss" ? 3.4 : p.hook.kind === "stack" ? 3.2 : 3.0, trans: "cut", text: { a: p.hook.a, b: p.hook.b, dim: "" }, min: 2.6 });
  g++;
  for (const pain of p.pains) {
    const prop = pain.prop !== "none" && pain.labels.length ? { kind: pain.prop, labels: pain.labels } : pain.prop === "sticky" ? { kind: "sticky" as const, labels: [""] } : undefined;
    out.push({ kind: "text", group: g, theme: "dark", dur: readS(pain, 2.1), trans: "blur", text: pain, style: style(pain), prop, min: 1.7 });
  }
  if (p.pains.length) g++;
  if (p.reveal.show) out.push({ kind: "logo", group: g, theme: "light", dur: 2.6 + Math.min(1.4, [...`${p.reveal.intro} ${p.product.name}.`].length * 0.05), trans: "blur", min: 2.6 });
  if (p.audience.items.length >= 2) out.push({ kind: "rotate", group: g, theme: "light", dur: 0.8 + p.audience.items.length * 0.95 + 0.4, trans: "blur", min: 2.4 });
  if (p.summary.a || p.summary.b) out.push({ kind: "text", group: g, theme: "light", dur: readS(p.summary, 2.4) + (p.summary.chips.length ? 0.3 : 0), trans: "blur", text: p.summary, style: style(p.summary), prop: p.summary.chips.length ? { kind: "chips", labels: p.summary.chips } : undefined, min: 1.9 });
  if (out.at(-1)!.group === g) g++;
  p.features.forEach((ft, k) => {
    const prop = ft.prop !== "none" && (ft.labels.length || ft.prop === "sticky") ? { kind: ft.prop, labels: ft.labels.length ? ft.labels : [""] } : undefined;
    const swap = prop?.kind === "swap" || prop?.kind === "strike";
    out.push({ kind: "text", group: g, theme: ft.theme, dur: readS(ft, 2.0) + (swap ? 0.6 : 0), trans: k % 3 === 2 ? "cut" : "blur", text: ft, style: swap ? "stack" : style(ft), prop, min: 1.6 });
    // no iris: its light circle grew right over the words of the dark card before it (owner feedback, both frames)
    out.push({ kind: "ui", group: g, theme: "light", dur: uiSeconds(ft.ui), trans: "zoom", ui: ft.ui, min: 3.0 });
    g++;
  });
  if (p.proof) {
    out.push({ kind: "text", group: g, theme: "light", dur: readS(p.proof, 2.0), trans: "blur", text: p.proof, style: style(p.proof), min: 1.6 });
    out.push({ kind: "ui", group: g, theme: "light", dur: uiSeconds(p.proof.ui), trans: "zoom", ui: p.proof.ui, min: 3.0 });
    g++;
  }
  if (p.integrations.length >= 3) out.push({ kind: "cloud", group: g, theme: "light", dur: 2.4, trans: "blur", min: 2.0 });
  out.push({ kind: "tagline", group: g, theme: "dark", dur: readS(p.outro, 2.6) + 0.3, trans: "cut", text: { a: p.outro.a, b: p.outro.b, dim: "" }, style: style(p.outro), min: 2.2 });
  // no iris over the tagline's words (the circle read as a blob covering the text)
  out.push({ kind: "cta", group: g, theme: "light", dur: 3.0, trans: "blur", min: 2.6 });
  // voice groups stay ≤ 10 (the narration script's limit): merge trailing features into one group if needed
  const groups = new Set(out.map((s) => s.group)).size;
  if (groups > 10) {
    const over = groups - 10;
    for (const s of out) if (s.group > 3) s.group = Math.max(3, s.group - over);
  }
  for (const s of out) s.dur = onFrame(s.dur);
  return out;
}

export function timeScenes(scenes: PromoScene[]): { timings: SceneTiming[]; duration: number } {
  let t = 0;
  const timings = scenes.map((s) => {
    const x = { start: r3(t), duration: r3(s.dur), kind: s.kind, group: s.group };
    t += s.dur;
    return x;
  });
  return { timings, duration: r3(t) };
}

/**
 * Moves the scene cuts onto the music's beats (beats: seconds on the video timeline). Each cut goes to the nearest
 * beat within ±maxShift as long as the scene keeps its minimum length; later cuts keep their own lengths. Returns the
 * new scenes and how many cuts landed on a beat.
 */
export function snapScenesToBeats(scenes: PromoScene[], beats: number[], o: { maxShift?: number; growOnly?: boolean } = {}): { scenes: PromoScene[]; snapped: number } {
  const max = o.maxShift ?? 0.3;
  if (beats.length < 4) return { scenes, snapped: 0 };
  const out = scenes.map((s) => ({ ...s }));
  let start = 0;
  let snapped = 0;
  for (let i = 0; i < out.length - 1; i++) {
    const want = start + out[i].dur;
    let best: number | null = null;
    for (const b of beats) {
      if (Math.abs(b - want) > max) continue;
      if (b - start < out[i].min) continue;
      // with a narrator a scene never gets shorter than its speech needs
      if (o.growOnly && b < want - 1e-6) continue;
      if (best === null || Math.abs(b - want) < Math.abs(best - want)) best = b;
    }
    const end = best ?? want;
    if (best !== null) snapped++;
    out[i].dur = onFrame(end - start);
    start += out[i].dur;
  }
  return { scenes: out, snapped };
}

export interface ComposeOptions {
  frame: Frame;
  fontFaces: string;
  gsapRel: string;
  icons: Record<string, string>;
  brands: Record<string, { path: string; hex: string }>;
  /** measured font sizes (fit ids → px) */
  sizes?: Record<string, number>;
}

export interface ComposedPromo {
  html: string;
  duration: number;
  timings: SceneTiming[];
  cues: BedCue[];
  /** count-up elements and their final text (tests) */
  counts: Record<string, string>;
}

/** Estimated advance widths (em) of Inter for laying out a one-line word stream before the browser measures it. */
export function textWidthEm(s: string, weight = 400): number {
  let w = 0;
  for (const ch of s) {
    if (/[iljtfI.,'!:;|]/.test(ch)) w += 0.28;
    else if (/[mwMWшщжюыМШЩЖЮЫ@%]/.test(ch)) w += 0.84;
    else if (/\s/.test(ch)) w += 0.27;
    else if (/[A-ZА-ЯЁ]/.test(ch)) w += 0.68;
    else if (/\d/.test(ch)) w += 0.6;
    else w += 0.53;
  }
  return w * (1 + (weight - 400) / 2500);
}

const BIN = (id: string) => `<svg viewBox="0 0 320 400" width="100%" height="100%"><defs><linearGradient id="${id}-bg" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#2B2E33"/><stop offset="0.2" stop-color="#4C5058"/><stop offset="0.42" stop-color="#62676F"/><stop offset="0.72" stop-color="#3C3F45"/><stop offset="1" stop-color="#222428"/></linearGradient><linearGradient id="${id}-rg" x1="0" x2="1"><stop offset="0" stop-color="#26282C"/><stop offset="0.4" stop-color="#4A4D53"/><stop offset="1" stop-color="#1F2124"/></linearGradient><radialGradient id="${id}-sh"><stop offset="0" stop-color="rgba(0,0,0,0.28)"/><stop offset="1" stop-color="rgba(0,0,0,0)"/></radialGradient></defs><ellipse cx="166" cy="380" rx="150" ry="18" fill="url(#${id}-sh)"/><path d="M50 98 L270 98 L247 356 Q245 370 231 370 L89 370 Q75 370 73 356 Z" fill="url(#${id}-bg)"/>${[0, 1, 2, 3, 4, 5].map((k) => { const xt = 82 + k * 31; const xb = 100 + k * 24; return `<path d="M${xt} 118 L${xb} 346" stroke="rgba(255,255,255,0.07)" stroke-width="7" stroke-linecap="round"/><path d="M${xt + 6} 118 L${xb + 5} 346" stroke="rgba(0,0,0,0.22)" stroke-width="2"/>`; }).join("")}<path d="M42 86 L278 86 L274 106 L46 106 Z" fill="url(#${id}-rg)"/><path d="M46 88 L274 88" stroke="rgba(255,255,255,0.18)" stroke-width="2"/><circle cx="236" cy="360" r="30" fill="#18191C"/><circle cx="236" cy="360" r="12" fill="#3A3C41"/><circle cx="236" cy="360" r="4" fill="#111"/></svg>`;
const LID = (id: string) => `<svg viewBox="0 0 320 400" width="100%" height="100%"><defs><linearGradient id="${id}-lg" x1="0" x2="1"><stop offset="0" stop-color="#34373C"/><stop offset="0.35" stop-color="#5A5E66"/><stop offset="1" stop-color="#2A2C30"/></linearGradient></defs><path d="M46 60 L274 60 L292 80 L28 80 Z" fill="url(#${id}-lg)"/><path d="M28 80 L292 80 L288 92 L32 92 Z" fill="#202226"/><rect x="132" y="48" width="56" height="12" rx="6" fill="#26282C"/></svg>`;

/** A four-point gradient sparkle (a generic AI mark, drawn here — no brand logo). */
export const sparkleSvg = (id: string) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4F8DF7"/><stop offset="0.55" stop-color="#9B72CB"/><stop offset="1" stop-color="#D96570"/></linearGradient></defs><path d="M12 1.5 C12.9 7.6 16.4 11.1 22.5 12 C16.4 12.9 12.9 16.4 12 22.5 C11.1 16.4 7.6 12.9 1.5 12 C7.6 11.1 11.1 7.6 12 1.5Z" fill="url(#${id})"/></svg>`;

/** The page-level helpers every count-up and typed field uses (deterministic: values derive from the timeline). */
const HELPERS = `const __fc = (el, c, v) => { const s = Math.abs(v).toFixed(c[2]); const p = s.split("."); const g = c[3] ? p[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g, c[3]) : p[0]; el.textContent = c[0] + (v < 0 ? "-" : "") + g + (p[1] ? c[4] + p[1] : "") + c[1]; };
      const __cnt = (sel, c, a, b, at, d) => { const el = document.querySelector(sel); if (!el) return; const o = { v: a }; tl.fromTo(o, { v: a }, { v: b, duration: d, ease: "power2.out", immediateRender: false, onUpdate: () => __fc(el, c, o.v) }, at); };
      const __type = (sel, text, at, d) => { const el = document.querySelector(sel); if (!el) return; const chars = Array.from(text); const o = { n: 0 }; tl.fromTo(o, { n: 0 }, { n: chars.length, duration: d, ease: "none", immediateRender: false, onUpdate: () => { el.textContent = chars.slice(0, Math.round(o.n)).join(""); } }, at); };`;

export function composePromo(p: Promo, scenes: PromoScene[], o: ComposeOptions): ComposedPromo {
  const F = o.frame;
  const W = F.w;
  const H = F.h;
  const portrait = H > W;
  const k = Math.min(W, H) / 1080;
  const px = (n: number) => Math.round(n * k);
  const sizes = o.sizes ?? {};
  const { timings, duration: DUR } = timeScenes(scenes);
  const tw: string[] = [];
  const cues: BedCue[] = [];
  const counts: Record<string, string> = {};
  const sections: string[] = [];
  const accent = p.product.accent;
  const icon = (name: string) => o.icons[name] ?? o.icons[guessIcon(name)] ?? o.icons["circle-dot"] ?? "";
  const brand = (name: string) => o.brands[name.trim().toLowerCase()] ?? null;
  /** the mark of a named tool: its Simple Icons path, a monogram for a mark-less brand, or a Lucide guess */
  const markOf = (name: string) => {
    const b = brand(name);
    if (b) return `<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="${b.path}" fill="${b.hex}"/></svg>`;
    const m = MONOGRAMS[name.trim().toLowerCase()];
    return m ? monogramSvg(m[0], m[1]) : icon(guessIcon(name));
  };
  /** a sound on the timeline; pan −1…1 follows the motion, rate < 1 = slower and lower (a big move), > 1 = quick */
  const cue = (t: number, kind: SfxCue["kind"], gain?: number, x: { pan?: number; rate?: number } = {}) => cues.push({ t: r3(t), kind, ...(gain !== undefined ? { gain } : {}), ...x });
  const fitAttrs = (id: string, maxw: number, maxh: number, min: number) => `data-fit="${id}" data-maxw="${Math.round(maxw)}" data-maxh="${Math.round(maxh)}" data-min="${px(min)}"`;
  const size = (id: string, def: number) => Math.round((sizes[id] ?? px(def)) * 10) / 10;
  const logoTile = (id: string, sz: number) =>
    p.product.logo === "sparkle"
      ? `<div class="logo spark" id="${id}" style="left:${Math.round(W / 2 - sz / 2)}px;top:0px;width:${sz}px;height:${sz}px;border-radius:${Math.round(sz * 0.24)}px"><span class="lshine" id="${id}-sh"></span><span class="lsp">${sparkleSvg(`${id}-g`)}</span></div>`
      : `<div class="logo" id="${id}" style="left:${Math.round(W / 2 - sz / 2)}px;top:0px;width:${sz}px;height:${sz}px;border-radius:${Math.round(sz * 0.24)}px;font-size:${Math.round(sz * 0.52)}px"><span class="lshine" id="${id}-sh"></span><b>${esc(p.product.mark)}</b></div>`;

  /** words as spans; `dim` words greyed; returns html and the word count */
  const wordSpans = (text: string, dim: string, cls: string) => {
    const dimW = new Set(wordsOf(dim.toLowerCase()));
    return wordsOf(text)
      .map((w) => `<span class="w ${cls}${dimW.has(w.toLowerCase()) ? " dim" : ""}">${esc(w)}</span>`)
      .join(" ");
  };

  /** two centred lines (regular + bold), blurring in word by word */
  const stackText = (id: string, t: { a: string; b: string; dim: string }, t0: number, cy: number, theme: "light" | "dark", maxwF = 0.8) => {
    const maxw = W * (portrait ? 0.88 : maxwF);
    const maxh = H * (portrait ? 0.4 : 0.42);
    const fs = size(id, portrait ? 132 : 122);
    const nA = wordsOf(t.a).length;
    const html = `<div class="tx ${theme}" ${fitAttrs(id, maxw, maxh, 40)} id="${id}" style="left:${Math.round((W - maxw) / 2)}px;top:${Math.round(cy - maxh / 2)}px;width:${Math.round(maxw)}px;height:${Math.round(maxh)}px;font-size:${fs}px"><div class="tin" id="${id}-in">${t.a ? `<div class="la">${wordSpans(t.a, "", "wa")}</div>` : ""}${t.b ? `<div class="lb">${wordSpans(t.b, t.dim, "wb")}</div>` : ""}</div></div>`;
    tw.push(`tl.fromTo("#${id} .wa", { opacity: 0, filter: "blur(16px)", y: ${px(34)} }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.6, ease: "power3.out", stagger: 0.07 }, ${f(t0)});`);
    tw.push(`tl.fromTo("#${id} .wb", { opacity: 0, filter: "blur(18px)", y: ${px(40)}, scale: 1.06 }, { opacity: 1, filter: "blur(0px)", y: 0, scale: 1, duration: 0.65, ease: "power3.out", stagger: 0.08 }, ${f(t0 + 0.12 + nA * 0.07)});`);
    cue(t0, "swish", -10);
    if (t.b) cue(t0 + 0.12 + nA * 0.07, "pop", -10);
    return html;
  };

  /** one line, word by word, the strip slides so the newest word sits in the middle (reference #17) */
  const streamText = (id: string, t: { a: string; b: string; dim: string }, t0: number, dur: number, cy: number, theme: "light" | "dark") => {
    const fs = px(portrait ? 128 : 110);
    const ws = [...wordsOf(t.a).map((w) => ({ w, b: false })), ...wordsOf(t.b).map((w) => ({ w, b: true }))];
    const dimW = new Set(wordsOf(t.dim.toLowerCase()));
    const gap = 0.24 * fs;
    let x = 0;
    const pos = ws.map((x0) => {
      const sc = x0.b ? 1.18 : 1;
      const w = textWidthEm(x0.w, x0.b ? 720 : 420) * fs * sc;
      const at = x;
      x += w + gap;
      return { at, w, sc };
    });
    const total = x - gap;
    const step = Math.min(0.32, Math.max(0.18, (dur - 1.1) / Math.max(1, ws.length)));
    const spans = ws
      .map((x0, i) => `<span class="sw ${x0.b ? "wb" : "wa"}${dimW.has(x0.w.toLowerCase()) ? " dim" : ""}" id="${id}-w${i}" style="left:${Math.round(pos[i].at)}px;font-size:${Math.round(fs * pos[i].sc)}px">${esc(x0.w)}</span>`)
      .join("");
    const html = `<div class="strip ${theme}" id="${id}" style="left:0px;top:${Math.round(cy - fs * 0.7)}px;height:${Math.round(fs * 1.4)}px;width:${Math.round(total)}px">${spans}</div>`;
    const tint = theme === "light" ? accent : "#9CC3FF";
    const color = theme === "light" ? "#111114" : "#FFFFFF";
    const fits = total <= W * 0.88;
    ws.forEach((x0, i) => {
      const at = t0 + 0.08 + i * step;
      const center = pos[i].at + pos[i].w / 2;
      tw.push(`tl.fromTo("#${id}-w${i}", { opacity: 0, filter: "blur(14px)", x: ${px(40)}, color: "${tint}" }, { opacity: 1, filter: "blur(0px)", x: 0, color: "${x0.b || !dimW.has(x0.w.toLowerCase()) ? color : "#8E8E93"}", duration: 0.5, ease: "power3.out" }, ${f(at)});`);
      if (!fits) tw.push(`tl.to("#${id}", { x: ${Math.round(W / 2 - center)}, duration: ${f(step - 0.01)}, ease: "power3.out" }, ${f(at)});`);
      cue(at, i % 3 === 0 ? "swish" : "tick", i % 3 === 0 ? -12 : -8);
    });
    if (fits) {
      // the line fits: it is set in place and the words arrive one by one — nothing runs off the edge
      tw.push(`tl.set("#${id}", { x: ${Math.round(W / 2 - total / 2)} }, ${f(t0)});`);
      return html;
    }
    // a longer line follows the newest word, then settles into the frame (shrunk to fit)
    const s = Math.min(1, (W * 0.86) / total);
    const end = t0 + 0.08 + ws.length * step + 0.15;
    tw.push(`tl.set("#${id}", { x: ${Math.round(W / 2 - pos[0].w / 2 - pos[0].at)} }, ${f(t0)});`);
    tw.push(`tl.to("#${id}", { x: ${Math.round(W / 2 - (s * total) / 2)}, scale: ${f(s)}, duration: 0.6, ease: "power3.inOut" }, ${f(end)});`);
    return html;
  };

  const props = (id: string, prop: NonNullable<PromoScene["prop"]>, t0: number, cy: number, theme: "light" | "dark") => {
    const out: string[] = [];
    if (prop.kind === "sticky") {
      const sz = px(150);
      out.push(`<div class="sticky" id="${id}-st" style="left:${Math.round(W / 2 + W * (portrait ? 0.18 : 0.2))}px;top:${Math.round(cy + px(40))}px;width:${sz}px;height:${sz}px"><span>${esc(prop.labels[0] ?? "")}</span></div>`);
      tw.push(`tl.fromTo("#${id}-st", { opacity: 0, scale: 0.4, rotation: -30 }, { opacity: 1, scale: 1, rotation: 8, duration: 0.5, ease: "back.out(2)" }, ${f(t0 + 0.75)});`);
      tw.push(`tl.to("#${id}-st", { y: ${px(60)}, rotation: 18, opacity: 0.0, duration: 0.7, ease: "power2.in" }, ${f(t0 + 1.6)});`);
      cue(t0 + 0.75, "pop", -4);
    } else if (prop.kind === "swap" || prop.kind === "strike") {
      // the old app's tile turns over (3D, on a wrapper) and the product's own tile is on its back — no slash, no red
      const sz = px(portrait ? 210 : 180);
      const x = Math.round(W / 2 - sz / 2);
      const y = Math.round(cy - H * (portrait ? 0.21 : 0.29) - sz / 2);
      const nm = prop.labels[0] ?? "";
      const r = Math.round(sz * 0.26);
      const back =
        p.product.logo === "sparkle"
          ? `<div class="swface back light" style="border-radius:${r}px"><span class="simg">${sparkleSvg(`${id}-swg`)}</span></div>`
          : `<div class="swface back dark" style="border-radius:${r}px;font-size:${Math.round(sz * 0.5)}px"><b>${esc(p.product.mark)}</b></div>`;
      out.push(`<div class="swap" id="${id}-sw" style="left:${x}px;top:${y}px;width:${sz}px;height:${sz}px"><span class="swhalo" id="${id}-sh"></span><div class="swflip" id="${id}-sf"><div class="swface front" style="border-radius:${r}px"><span class="simg">${markOf(nm)}</span></div>${back}</div></div>`);
      tw.push(`tl.fromTo("#${id}-sw", { opacity: 0, scale: 0.5, y: ${px(30)}, filter: "blur(10px)" }, { opacity: 1, scale: 1, y: 0, filter: "blur(0px)", duration: 0.45, ease: "back.out(1.8)" }, ${f(t0 + 0.05)});`);
      tw.push(`tl.fromTo("#${id}-sf", { rotationY: 0 }, { rotationY: 180, duration: 0.7, ease: "power2.inOut" }, ${f(t0 + 0.95)});`);
      tw.push(`tl.to("#${id}-sw", { scale: 1.08, duration: 0.35, ease: "sine.inOut", yoyo: true, repeat: 1 }, ${f(t0 + 0.95)});`);
      tw.push(`tl.fromTo("#${id}-sh", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.6, ease: "power2.out" }, ${f(t0 + 1.3)});`);
      cue(t0 + 0.05, "pop", -6);
      cue(t0 + 0.95, "whoosh", -12, { rate: 1.15 });
      cue(t0 + 1.55, "chime", -11);
    } else if (prop.kind === "tabs") {
      prop.labels.forEach((l, i) => {
        const x = W / 2 + (i - (prop.labels.length - 1) / 2) * px(portrait ? 300 : 330) - px(130);
        const y = cy - px(portrait ? 260 : 230) + (i % 2) * px(26);
        out.push(`<div class="tab ${theme}" id="${id}-tb${i}" style="left:${Math.round(x)}px;top:${Math.round(y)}px"><b></b>${esc(l)}</div>`);
        tw.push(`tl.fromTo("#${id}-tb${i}", { opacity: 0, y: ${px(30)}, rotation: ${(i - 1) * 6} }, { opacity: 1, y: 0, rotation: ${(i - 1) * -4}, duration: 0.5, ease: "back.out(1.8)" }, ${f(t0 + 0.4 + i * 0.12)});`);
        tw.push(`tl.to("#${id}-tb${i}", { x: ${(i - 1) * px(70)}, y: ${-px(30) - i * px(8)}, opacity: 0.35, duration: 1.4, ease: "sine.inOut" }, ${f(t0 + 1.0 + i * 0.1)});`);
        cue(t0 + 0.4 + i * 0.12, "pop", -8);
      });
    } else {
      prop.labels.forEach((l, i) => {
        const left = i % 2 === 0;
        const x = left ? W * 0.12 + (i >> 1) * px(60) : W * (portrait ? 0.5 : 0.7) - (i >> 1) * px(40);
        const y = (portrait ? H * 0.26 : H * 0.18) + (i >> 1) * px(120) + (left ? 0 : px(30));
        out.push(`<div class="nchip" id="${id}-nc${i}" style="left:${Math.round(x)}px;top:${Math.round(y)}px"><span class="nci" style="background:${["#EC4899", "#EA4335", "#0A66C2", "#16A34A"][i % 4]}">${icon(["user-plus", "mail", "send", "check"][i % 4])}</span>${esc(l)}</div>`);
        tw.push(`tl.fromTo("#${id}-nc${i}", { opacity: 0, y: ${px(24)}, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.8)" }, ${f(t0 + 0.2 + i * 0.25)});`);
        tw.push(`tl.to("#${id}-nc${i}", { y: ${-px(26)}, duration: 2.2, ease: "sine.inOut" }, ${f(t0 + 0.7 + i * 0.25)});`);
        cue(t0 + 0.2 + i * 0.25, "chime", -10);
      });
    }
    return out.join("");
  };

  const bgHtml = (id: string, theme: Theme, seed: number) => {
    const blobs = theme === "dark" ? [0, 1, 2] : [0, 1];
    const b = blobs
      .map((i) => {
        const h = hashStr(`${seed}-${i}`);
        const s = Math.round(Math.max(W, H) * (0.55 + ((h % 30) / 100)));
        const x = Math.round((((h >> 3) % 100) / 100) * W - s / 2);
        const y = Math.round((((h >> 9) % 100) / 100) * H - s / 2);
        return `<span class="blob ${theme}${i}" id="${id}-bg${i}" style="left:${x}px;top:${y}px;width:${s}px;height:${s}px"></span>`;
      })
      .join("");
    return `<div class="bg ${theme}">${b}</div>`;
  };

  scenes.forEach((sc, i) => {
    const t = timings[i];
    const t0 = t.start;
    const D = t.duration;
    const id = `s${i}`;
    const body: string[] = [];
    const theme = sc.theme;
    const cy = portrait ? H * 0.5 : H * 0.53;
    body.push(bgHtml(id, sc.kind === "ui" ? "light" : theme, i));
    // background drift (life on a held card)
    const blobN = (sc.kind === "ui" ? "light" : theme) === "dark" ? 3 : 2;
    for (let b = 0; b < blobN; b++) tw.push(`tl.fromTo("#${id}-bg${b}", { x: 0, y: 0 }, { x: ${px((b % 2 ? -1 : 1) * 160)}, y: ${px((b % 2 ? 1 : -1) * 90)}, duration: ${f(D + OVERLAP)}, ease: "sine.inOut" }, ${f(t0)});`);

    switch (sc.kind) {
      case "hook": {
        const toss = p.hook.kind === "toss";
        const bh = Math.round(portrait ? H * 0.36 : H * 0.62);
        const bw = Math.round((bh * 320) / 400);
        const bx = Math.round(portrait ? W / 2 - bw / 2 : W * 0.63 - bw / 2);
        const by = Math.round(portrait ? H * 0.17 : H * 0.53 - bh / 2);
        const u = bw / 320;
        const tile = Math.round(96 * u);
        const tx0 = bx - Math.round(150 * u);
        const ty0 = by + Math.round(290 * u);
        if (toss) {
          body.push(`<div class="bin" id="${id}-bin" style="left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px"><div class="oldt" id="${id}-old" style="left:${tx0 - bx}px;top:${ty0 - by}px;width:${tile}px;height:${tile}px;border-radius:${Math.round(tile * 0.24)}px;background:linear-gradient(145deg, ${p.hook.old_color}, ${shade(p.hook.old_color, -0.25)})"><span class="oldi">${icon(p.hook.old_icon)}</span></div><div class="binb">${BIN(id)}</div><div class="lid" id="${id}-lid">${LID(id)}</div></div>`);
          tw.push(`tl.fromTo("#${id}-bin", { opacity: 0, y: ${px(40)}, scale: 0.94, filter: "blur(14px)" }, { opacity: 1, y: 0, scale: 1, filter: "blur(0px)", duration: 0.55, ease: "power3.out" }, ${f(t0)});`);
          const ox = 290 * u;
          const oy = 80 * u;
          tw.push(`tl.fromTo("#${id}-lid", { rotation: 0 }, { rotation: 34, duration: 0.3, ease: "power2.out", transformOrigin: "${Math.round(ox)}px ${Math.round(oy)}px" }, ${f(t0 + 0.45)});`);
          const dx = Math.round(150 * u + 150 * u + 40 * u);
          tw.push(`tl.to("#${id}-old", { x: ${dx}, rotation: 250, scale: 0.86, duration: 0.8, ease: "power1.inOut" }, ${f(t0 + 0.55)});`);
          tw.push(`tl.to("#${id}-old", { y: ${-Math.round(360 * u)}, duration: 0.42, ease: "power2.out" }, ${f(t0 + 0.55)});`);
          tw.push(`tl.to("#${id}-old", { y: ${-Math.round(150 * u)}, duration: 0.38, ease: "power2.in" }, ${f(t0 + 0.97)});`);
          tw.push(`tl.to("#${id}-old", { opacity: 0, duration: 0.05 }, ${f(t0 + 1.36)});`);
          tw.push(`tl.to("#${id}-lid", { rotation: 0, duration: 0.28, ease: "bounce.out", transformOrigin: "${Math.round(ox)}px ${Math.round(oy)}px" }, ${f(t0 + 1.3)});`);
          tw.push(`tl.to("#${id}-bin", { scaleY: 0.965, duration: 0.08, yoyo: true, repeat: 1, ease: "power2.out", transformOrigin: "50% 100%" }, ${f(t0 + 1.36)});`);
          cue(t0 + 0.45, "click", -2);
          cue(t0 + 0.58, "whoosh", -4, { pan: portrait ? 0 : 0.35, rate: 0.95 });
          cue(t0 + 1.32, "impact", -9);
        } else if (p.hook.kind === "stack") {
          // the old tools fan in around the question
          const items = p.hook.items.length ? p.hook.items : [p.hook.old_label];
          const sz = px(portrait ? 170 : 150);
          items.forEach((nm, j) => {
            const a = -Math.PI / 2 + ((j + 0.5) / items.length) * Math.PI * 2;
            const rx = portrait ? W * 0.34 : W * 0.33;
            const ry = portrait ? H * 0.27 : H * 0.33;
            // 9:16: a row above the question and a row below it (a ring put tiles over the words)
            const top = Math.ceil(items.length / 2);
            const row = j < top ? 0 : 1;
            const inRow = row ? items.length - top : top;
            const col = row ? j - top : j;
            const x = Math.round(portrait ? W / 2 + (col - (inRow - 1) / 2) * W * 0.27 - sz / 2 : W / 2 + Math.cos(a) * rx - sz / 2);
            const y = Math.round(portrait ? cy + (row ? 1 : -1) * H * 0.25 + (col % 2 ? 1 : -1) * px(26) - sz / 2 : cy + Math.sin(a) * ry - sz / 2);
            const b = brand(nm);
            const sid = `${id}-hs${j}`;
            body.push(`<div class="stile" id="${sid}" style="left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;border-radius:${Math.round(sz * 0.26)}px"><span class="simg">${markOf(nm)}</span></div>`);
            const at = t0 + 0.1 + j * 0.14;
            tw.push(`tl.fromTo("#${sid}", { opacity: 0, scale: 0.3, x: ${Math.round((W / 2 - x - sz / 2) * 0.6)}, y: ${Math.round((cy - y - sz / 2) * 0.6)}, rotation: ${(j % 2 ? 1 : -1) * 20} }, { opacity: 1, scale: 1, x: 0, y: 0, rotation: ${(j % 2 ? 1 : -1) * 6}, duration: 0.55, ease: "back.out(1.6)" }, ${f(at)});`);
            tw.push(`tl.to("#${sid}", { y: ${(j % 2 ? 1 : -1) * px(18)}, rotation: ${(j % 2 ? -1 : 1) * 4}, duration: ${f(Math.max(0.5, D - (at - t0) - 0.6))}, ease: "sine.inOut" }, ${f(at + 0.58)});`);
            cue(at, "pop", -5);
          });
        } else {
          const sz = Math.round(portrait ? W * 0.42 : H * 0.42);
          body.push(`<div class="obj3" id="${id}-o3" style="left:${Math.round(portrait ? W / 2 - sz / 2 : W * 0.63 - sz / 2)}px;top:${Math.round(portrait ? H * 0.2 : H * 0.53 - sz / 2)}px;width:${sz}px;height:${sz}px"><div class="obj" id="${id}-obj" style="border-radius:${Math.round(sz * 0.24)}px;background:linear-gradient(145deg, ${shade(p.hook.old_color, 0.18)}, ${p.hook.old_color} 55%, ${shade(p.hook.old_color, -0.3)})"><span class="oglare"></span><span class="oldi big">${icon(p.hook.old_icon)}</span></div><span class="oshadow" id="${id}-osh"></span></div>`);
          tw.push(`tl.fromTo("#${id}-obj", { rotationY: 70, rotationX: 12, scale: 0.6, opacity: 0, filter: "blur(16px)" }, { rotationY: -14, rotationX: 6, scale: 1, opacity: 1, filter: "blur(0px)", duration: 1.0, ease: "power3.out" }, ${f(t0 + 0.05)});`);
          tw.push(`tl.to("#${id}-obj", { rotationY: 8, y: ${-px(18)}, duration: ${f(D - 1.0)}, ease: "sine.inOut" }, ${f(t0 + 1.05)});`);
          cue(t0 + 0.05, "whoosh", -4);
          cue(t0 + 0.7, "pop", -4);
        }
        // «Stop / using this.»: left of the bin (16:9), under it (9:16); the stack hook keeps it in the middle
        const mid = p.hook.kind === "stack";
        const fsA = size(`${id}-t`, mid ? (portrait ? 140 : 120) : portrait ? 150 : 132);
        const tx = mid ? (portrait ? W * 0.12 : W * 0.25) : W * 0.1;
        const tWidth = mid ? (portrait ? W * 0.8 : W * 0.5) : portrait ? W * 0.86 : W * 0.36;
        const ty = mid ? cy - H * (portrait ? 0.12 : 0.17) : portrait ? H * 0.6 : H * 0.36;
        body.push(`<div class="htx" ${fitAttrs(`${id}-t`, tWidth, portrait ? H * 0.28 : H * 0.34, 50)} id="${id}-t" style="left:${Math.round(tx)}px;top:${Math.round(ty)}px;width:${Math.round(tWidth)}px;height:${Math.round(portrait ? H * 0.28 : H * 0.34)}px;font-size:${fsA}px;text-align:${portrait || mid ? "center" : "left"}"><div class="lb">${wordSpans(p.hook.a, "", "wb")}</div>${p.hook.b ? `<div class="la small">${wordSpans(p.hook.b, "", "wa")}</div>` : ""}</div>`);
        const ta = t0 + (toss ? 1.45 : mid ? 0.35 : 0.9);
        tw.push(`tl.fromTo("#${id}-t .wb", { opacity: 0, filter: "blur(18px)", x: ${-px(40)} }, { opacity: 1, filter: "blur(0px)", x: 0, duration: 0.55, ease: "power3.out", stagger: 0.08 }, ${f(ta)});`);
        tw.push(`tl.fromTo("#${id}-t .wa", { opacity: 0, filter: "blur(14px)", y: ${px(20)} }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.55, ease: "power3.out", stagger: 0.07 }, ${f(ta + 0.25)});`);
        cue(ta, "swish", -8);
        tw.push(`tl.fromTo("#${id}-cam", { scale: 1 }, { scale: 1.05, duration: ${f(D + OVERLAP)}, ease: "none" }, ${f(t0)});`);
        break;
      }
      case "text": {
        const t = sc.text!;
        body.push(sc.style === "stream" ? streamText(`${id}-tx`, t, t0, D, cy, theme) : stackText(`${id}-tx`, t, t0, cy, theme));
        if (sc.prop) body.push(props(id, sc.prop, t0, cy, theme));
        if (sc.style !== "stream") tw.push(`tl.fromTo("#${id}-cam", { scale: 1 }, { scale: 1.04, duration: ${f(D + OVERLAP)}, ease: "none" }, ${f(t0)});`);
        break;
      }
      case "logo": {
        const sz = px(portrait ? 230 : 210);
        const ly = Math.round(H * (portrait ? 0.38 : 0.36) - sz / 2);
        body.push(`<div class="lwrap" id="${id}-lw" style="top:${ly}px;height:${sz}px">${logoTile(`${id}-logo`, sz)}</div>`);
        tw.push(`tl.fromTo("#${id}-logo", { scale: 0.45, opacity: 0, filter: "blur(22px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.7, ease: "back.out(1.5)" }, ${f(t0 + 0.05)});`);
        tw.push(`tl.fromTo("#${id}-logo-sh", { x: 0 }, { x: ${Math.round(sz * 1.9)}, duration: 0.7, ease: "power2.inOut" }, ${f(t0 + 0.6)});`);
        tw.push(`tl.to("#${id}-logo", { scale: 0.92, duration: 0.12, yoyo: true, repeat: 1, ease: "power2.inOut" }, ${f(t0 + 1.0)});`);
        cue(t0 - 1.15, "riser", -9);
        cue(t0 + 0.05, "impact", -7, { rate: 0.9 });
        cue(t0 + 0.6, "swish", -12, { pan: 0.3 });
        // «Introducing Tracker.» typed with a caret
        const intro = `${p.reveal.intro} `;
        const name = `${p.product.name}.`;
        const fs = size(`${id}-ty`, portrait ? 84 : 92);
        const maxw = W * 0.84;
        const tyTop = Math.round(ly + sz + px(70));
        body.push(`<div class="tyl" ${fitAttrs(`${id}-ty`, maxw, fs * 1.4, 40)} id="${id}-ty" style="left:${Math.round((W - maxw) / 2)}px;top:${tyTop}px;width:${Math.round(maxw)}px;font-size:${fs}px"><span class="tybox"><span class="tyghost"><span class="w">${esc(intro)}</span><b class="w">${esc(name)}</b></span><span class="tytyped"><span class="tyi" id="${id}-ti"></span><b class="tyn" id="${id}-tn"></b><i class="caret" id="${id}-cr"></i></span></span></div>`);
        const ta = t0 + 1.05;
        const ci = [...intro].length;
        const cn = [...name].length;
        const per = Math.min(0.075, (D - 1.9) / (ci + cn));
        tw.push(`__type("#${id}-ti", ${JSON.stringify(intro)}, ${f(ta)}, ${f(per * ci)});`);
        tw.push(`__type("#${id}-tn", ${JSON.stringify(name)}, ${f(ta + per * ci + 0.08)}, ${f(per * cn)});`);
        tw.push(`tl.fromTo("#${id}-cr", { opacity: 0 }, { opacity: 1, duration: 0.01 }, ${f(ta - 0.25)});`);
        const blinkFrom = ta + per * (ci + cn) + 0.15;
        for (let b = 0; blinkFrom + b * 0.5 < t0 + D; b++) tw.push(`tl.set("#${id}-cr", { opacity: ${b % 2 ? 1 : 0} }, ${f(blinkFrom + b * 0.5)});`);
        for (let c = 0; c < ci + cn; c += 2) cue(ta + c * per + (c >= ci ? 0.08 : 0), "key");
        break;
      }
      case "rotate": {
        const fs = size(`${id}-lead`, portrait ? 80 : 92);
        const maxw = W * 0.86;
        const ly = Math.round(cy - fs * 1.15);
        body.push(`<div class="rlead" ${fitAttrs(`${id}-lead`, maxw, fs * 1.4, 40)} id="${id}-lead" style="left:${Math.round((W - maxw) / 2)}px;top:${ly}px;width:${Math.round(maxw)}px;font-size:${fs}px"><span class="w">${esc(p.audience.lead)}</span></div>`);
        tw.push(`tl.fromTo("#${id}-lead", { opacity: 0, filter: "blur(16px)", y: ${px(30)} }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.55, ease: "power3.out" }, ${f(t0 + 0.05)});`);
        cue(t0 + 0.05, "swish", -10);
        const items = p.audience.items;
        const ifs = Math.min(...items.map((_, j) => size(`${id}-it${j}`, portrait ? 96 : 112)));
        const slot = 0.95;
        items.forEach((it, j) => {
          const iid = `${id}-it${j}`;
          body.push(`<div class="ritem" ${fitAttrs(iid, maxw, ifs * 1.35, 36)} id="${iid}" style="left:${Math.round((W - maxw) / 2)}px;top:${Math.round(ly + fs * 1.25)}px;width:${Math.round(maxw)}px;font-size:${ifs}px"><span class="w">${esc(it)}</span></div>`);
          const at = t0 + 0.55 + j * slot;
          tw.push(`tl.fromTo("#${iid}", { opacity: 0, filter: "blur(18px)", y: ${px(46)} }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.42, ease: "power3.out" }, ${f(at)});`);
          if (j < items.length - 1) tw.push(`tl.to("#${iid}", { opacity: 0, filter: "blur(14px)", y: ${-px(40)}, duration: 0.3, ease: "power2.in" }, ${f(at + slot - 0.22)});`);
          cue(at, "swipe", -9, { pan: j % 2 ? 0.2 : -0.2, rate: 1 + (j % 3) * 0.04 });
          // two little app marks pop beside each word
          const marks = p.integrations.length ? p.integrations : ["mail", "instagram", "linkedin"];
          for (let m = 0; m < 2; m++) {
            const nm = marks[(j * 2 + m) % marks.length];
            const b = brand(nm);
            const mx = W / 2 + (m ? 1 : -1) * W * (portrait ? 0.3 : 0.24) + ((hashStr(`${j}${m}`) % 60) - 30) * k;
            const my = ly + fs * 1.25 + (m ? -px(20) : ifs * 0.9) ;
            const mid = `${id}-mk${j}${m}`;
            body.push(`<span class="rmark" id="${mid}" style="left:${Math.round(mx - px(26))}px;top:${Math.round(my)}px;width:${px(52)}px;height:${px(52)}px">${brand(nm) || MONOGRAMS[nm.toLowerCase()] ? markOf(nm) : icon(nm)}</span>`);
            tw.push(`tl.fromTo("#${mid}", { opacity: 0, scale: 0.3 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2.4)" }, ${f(at + 0.12 + m * 0.08)});`);
            tw.push(`tl.to("#${mid}", { opacity: 0, scale: 0.6, y: ${-px(20)}, duration: 0.25 }, ${f(at + slot - 0.2)});`);
          }
        });
        break;
      }
      case "ui": {
        const ctx: UiCtx = { id, t0, dur: D, accent, lang: p.language, icon, brand, product: { name: p.product.name, mark: p.product.mark }, portrait };
        const ui = buildUi(ctx, sc.ui!);
        Object.assign(counts, ui.counts);
        cues.push(...ui.cues);
        body.push(`<div class="persp"><div class="tilt" id="${id}-tilt"><div class="u-cv" id="${id}-cv" style="width:${ui.w}px;height:${ui.h}px">${ui.html}</div></div></div>`);
        tw.push(...ui.tl);
        tw.push(...cameraTweens(id, ui.cam, { W, H, t0, D, cw: ui.w, ch: ui.h, fitsPortrait: ui.fitsPortrait }));
        break;
      }
      case "cloud": {
        const names = p.integrations.slice(0, 8);
        const sz = px(portrait ? 150 : 140);
        const r = Math.min(W, H) * (portrait ? 0.34 : 0.36);
        names.forEach((nm, j) => {
          const a = (j / names.length) * Math.PI * 2 + 0.4;
          const jitter = ((hashStr(nm) % 40) - 20) * k;
          const x = W / 2 + Math.cos(a) * r * (portrait ? 0.9 : 1.6) + jitter - sz / 2;
          const y = H / 2 + Math.sin(a) * r * (portrait ? 1.4 : 0.85) - sz / 2;
          const b = brand(nm);
          const cid = `${id}-c${j}`;
          body.push(`<span class="ctile" id="${cid}" style="left:${Math.round(x)}px;top:${Math.round(y)}px;width:${sz}px;height:${sz}px"><span class="cimg">${markOf(nm)}</span></span>`);
          tw.push(`tl.fromTo("#${cid}", { opacity: 0, scale: 0.4, y: ${px(40)} }, { opacity: 1, scale: 1, y: 0, duration: 0.4, ease: "back.out(2)" }, ${f(t0 + 0.05 + j * 0.07)});`);
          tw.push(`tl.to("#${cid}", { y: ${-px(16) + (j % 2) * px(30)}, rotation: ${((j % 3) - 1) * 4}, duration: ${f(Math.max(0.2, D * 0.58 + j * 0.03 - 0.47 - j * 0.07 - 0.02))}, ease: "sine.inOut" }, ${f(t0 + 0.45 + j * 0.07)});`);
          tw.push(`tl.to("#${cid}", { x: ${Math.round(W / 2 - sz / 2 - x)}, y: ${Math.round(H / 2 - sz / 2 - y)}, scale: 0.3, opacity: 0, duration: 0.45, ease: "power3.in" }, ${f(t0 + D * 0.58 + j * 0.03)});`);
          cue(t0 + 0.05 + j * 0.07, "pop", -10);
        });
        const ls = px(200);
        body.push(`<div class="lwrap" style="top:${Math.round(H / 2 - ls / 2)}px;height:${ls}px">${logoTile(`${id}-logo`, ls)}</div>`);
        tw.push(`tl.fromTo("#${id}-logo", { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(2)" }, ${f(t0 + D * 0.58 + 0.38)});`);
        cue(t0 + D * 0.58 - 0.9, "riser", -11);
        cue(t0 + D * 0.58, "whoosh", -6, { rate: 0.85 });
        cue(t0 + D * 0.58 + 0.4, "impact", -8, { rate: 0.9 });
        break;
      }
      case "tagline": {
        const ls = px(portrait ? 170 : 150);
        const ly = Math.round(H * (portrait ? 0.3 : 0.24) - ls / 2);
        body.push(`<span class="halo" id="${id}-halo" style="left:${Math.round(W / 2 - ls * 1.6)}px;top:${Math.round(ly + ls / 2 - ls * 1.6)}px;width:${Math.round(ls * 3.2)}px;height:${Math.round(ls * 3.2)}px"></span><div class="lwrap" style="top:${ly}px;height:${ls}px">${logoTile(`${id}-logo`, ls)}</div>`);
        tw.push(`tl.fromTo("#${id}-halo", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.8, ease: "power2.out" }, ${f(t0)});`);
        tw.push(`tl.fromTo("#${id}-logo", { scale: 0.7, opacity: 0, filter: "blur(14px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out" }, ${f(t0 + 0.05)});`);
        const t = sc.text!;
        const tcy = portrait ? H * 0.58 : H * 0.62;
        body.push(sc.style === "stream" ? streamText(`${id}-tx`, t, t0 + 0.35, D - 0.35, tcy, "dark") : stackText(`${id}-tx`, t, t0 + 0.35, tcy, "dark", 0.7));
        cue(t0, "impact", -12);
        break;
      }
      case "cta": {
        const ls = px(portrait ? 260 : 190);
        const ly = Math.round(H * (portrait ? 0.34 : 0.28) - ls / 2);
        body.push(`<div class="lwrap" style="top:${ly}px;height:${ls}px">${logoTile(`${id}-logo`, ls)}</div>`);
        tw.push(`tl.fromTo("#${id}-logo", { scale: 0.6, opacity: 0, filter: "blur(16px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "back.out(1.6)" }, ${f(t0 + 0.05)});`);
        const maker = p.product.maker ? (p.language === "ru" ? `Продукт ${p.product.maker}` : p.language === "uz" ? `${p.product.maker} mahsuloti` : `A product by ${p.product.maker}`) : p.product.tagline || p.product.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (maker) {
          body.push(`<div class="maker" id="${id}-mk" style="top:${Math.round(ly + ls + px(40))}px;font-size:${px(portrait ? 40 : 34)}px">${esc(maker)}</div>`);
          tw.push(`tl.fromTo("#${id}-mk", { opacity: 0, filter: "blur(8px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.5 }, ${f(t0 + 0.4)});`);
        }
        const cfs = px(portrait ? 58 : 50);
        const bw = Math.round(Math.min(W * 0.9, Math.max(px(560), textWidthEm(p.outro.cta, 650) * cfs + px(160))));
        const bh = px(portrait ? 150 : 124);
        const btY = Math.round(ly + ls + px(portrait ? 170 : 150));
        body.push(`<div class="ctab" id="${id}-btn" style="left:${Math.round(W / 2 - bw / 2)}px;top:${btY}px;width:${bw}px;height:${bh}px;border-radius:${Math.round(bh / 2)}px;font-size:${cfs}px"><span class="ctaf" id="${id}-bf"></span><span class="ctal">${esc(p.outro.cta)}</span></div>`);
        tw.push(`tl.fromTo("#${id}-btn", { opacity: 0, y: ${px(30)} }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${f(t0 + 0.5)});`);
        tw.push(`tl.fromTo("#${id}-bf", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "power2.inOut" }, ${f(t0 + 0.75)});`);
        cue(t0 - 1.15, "riser", -11);
        cue(t0 + 0.5, "swish", -10);
        // the cursor presses it (the click is the last beat)
        const ctx: UiCtx = { id: `${id}x`, t0, dur: D, accent, lang: p.language, icon, brand, product: p.product };
        const cur = cursor(ctx, [{ t: Math.min(D - 0.6, 1.9), x: W / 2 + bw * 0.12, y: btY + bh / 2, click: true, press: [`#${id}-btn`] }], { size: px(56), from: { x: W / 2 + px(300), y: btY + px(300) } });
        body.push(`<div class="ccv">${cur.html}</div>`);
        tw.push(...cur.tl);
        cues.push(...cur.cues);
        cue(t0 + Math.min(D - 0.6, 1.9) + 0.06, "ding", -6);
        break;
      }
    }

    // transitions: the incoming scene over the outgoing one (the outgoing clip runs OVERLAP s longer)
    const next = scenes[i + 1];
    const tail = next && next.trans !== "cut" ? OVERLAP : 0;
    if (i > 0) {
      if (sc.trans === "blur") {
        tw.push(`tl.fromTo("#${id}", { opacity: 0, filter: "blur(18px)", scale: 1.04 }, { opacity: 1, filter: "blur(0px)", scale: 1, duration: ${OVERLAP}, ease: "power2.out" }, ${f(t0)});`);
        cue(t0, "whoosh", -15, { pan: i % 2 ? 0.25 : -0.25, rate: 1.12 });
      } else if (sc.trans === "zoom") {
        tw.push(`tl.fromTo("#${id}", { opacity: 0, scale: 1.14, filter: "blur(14px)" }, { opacity: 1, scale: 1, filter: "blur(0px)", duration: ${OVERLAP + 0.1}, ease: "power3.out" }, ${f(t0)});`);
        cue(t0, "whoosh", -8, { rate: 0.88 });
      } else if (sc.trans === "iris") {
        const ox = sc.kind === "logo" || sc.kind === "cta" ? "50%" : "62%";
        const oy = sc.kind === "logo" ? `${Math.round((H * 0.36 * 100) / H)}%` : "55%";
        tw.push(`tl.fromTo("#${id}", { clipPath: "circle(0% at ${ox} ${oy})" }, { clipPath: "circle(150% at ${ox} ${oy})", duration: ${OVERLAP + 0.15}, ease: "power2.in" }, ${f(t0)});`);
        cue(t0, "swish", -4);
      } else {
        tw.push(`tl.fromTo("#${id}", { scale: 1.04 }, { scale: 1, duration: 0.3, ease: "power2.out", immediateRender: false }, ${f(t0)});`);
        cue(t0, "tick", -2);
      }
    }
    if (tail) {
      const nt = next.trans;
      if (nt === "zoom") tw.push(`tl.to("#${id}", { scale: 1.18, filter: "blur(12px)", duration: ${OVERLAP}, ease: "power2.in" }, ${f(t0 + D)});`);
      else tw.push(`tl.to("#${id}", { filter: "blur(${nt === "iris" ? 4 : 14}px)", scale: ${nt === "iris" ? 1.02 : 0.97}, duration: ${OVERLAP}, ease: "power2.in" }, ${f(t0 + D)});`);
    }
    const clipDur = Math.min(DUR - t0, D + tail);
    sections.push(`      <section class="clip scene" id="${id}-clip" data-start="${f(t0)}" data-duration="${f(clipDur)}" data-track-index="${1 + (i % 2)}">\n        <div class="sc" id="${id}"><div class="cam" id="${id}-cam">\n          ${body.join("\n          ")}\n        </div></div>\n      </section>`);
  });

  const resolution = W > H ? "landscape" : W === H ? "square" : "portrait";
  const html = `<!doctype html>
<html lang="${esc(p.language)}" data-resolution="${resolution}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${W}, height=${H}" />
    <!-- generated by vedit make promo/1 · ${F.aspect} · ${esc(p.title)} -->
    <script src="${o.gsapRel}"></script>
    <style>
      ${o.fontFaces}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; background: #F3F2EF; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; background: #F3F2EF; font-family: "VInter", sans-serif; -webkit-font-smoothing: antialiased; }
      .scene { position: absolute; inset: 0; overflow: hidden; }
      .sc, .cam { position: absolute; inset: 0; transform-origin: 50% 50%; overflow: hidden; }
      .bg { position: absolute; inset: 0; display: block; }
      .bg.light { background: radial-gradient(120% 90% at 50% 40%, #FBFAF8 0%, #F1EFEC 62%, #E6E4E0 100%); }
      .bg.dark { background: radial-gradient(120% 90% at 50% 45%, #18181B 0%, #0B0B0D 70%, #050506 100%); }
      .blob { position: absolute; display: block; border-radius: 50%; }
      .blob.light0 { background: radial-gradient(closest-side, rgba(255,255,255,0.95), rgba(255,255,255,0)); }
      .blob.light1 { background: radial-gradient(closest-side, rgba(205,201,195,0.55), rgba(205,201,195,0)); }
      .blob.dark0 { background: radial-gradient(closest-side, rgba(255,255,255,0.16), rgba(255,255,255,0)); }
      .blob.dark1 { background: radial-gradient(closest-side, rgba(190,190,200,0.12), rgba(190,190,200,0)); }
      .blob.dark2 { background: radial-gradient(closest-side, rgba(255,250,240,0.09), rgba(255,250,240,0)); }
      .tx { position: absolute; display: flex; align-items: center; justify-content: center; text-align: center; letter-spacing: -0.035em; line-height: 1.08; }
      .tin { display: block; width: 100%; }
      .la { display: block; font-weight: 420; }
      .lb { display: block; font-weight: 720; }
      .tx.light .la { color: #2A2A2F; } .tx.light .lb { color: #0E0E11; }
      .tx.dark .la { color: #E9E9EC; } .tx.dark .lb { color: #FFFFFF; }
      .w { display: inline-block; }
      .dim { color: #8E8E93 !important; }
      .tx.dark .dim { color: #8D8D96 !important; }
      .strip { position: absolute; display: block; transform-origin: 0 50%; }
      .sw { position: absolute; top: 50%; margin-top: -0.6em; line-height: 1.2; white-space: nowrap; letter-spacing: -0.03em; display: block; }
      .sw.wa { font-weight: 430; } .sw.wb { font-weight: 720; }
      .htx { position: absolute; display: flex; flex-direction: column; justify-content: center; letter-spacing: -0.04em; line-height: 1.0; }
      .htx .lb { color: #0E0E11; font-weight: 760; }
      .htx .la.small { font-size: 0.56em; color: #4A4A50; font-weight: 420; letter-spacing: -0.02em; margin-top: 0.12em; }
      .bin { position: absolute; display: block; transform-origin: 50% 100%; }
      .binb, .lid { position: absolute; inset: 0; display: block; }
      .oldt { position: absolute; display: flex; align-items: center; justify-content: center; box-shadow: 0 14px 30px rgba(0,0,0,0.25), inset 0 2px 0 rgba(255,255,255,0.35); }
      .oldi { display: block; width: 58%; height: 58%; color: #FFFFFF; }
      .oldi svg, .cimg svg, .rmark svg, .nci svg { width: 100%; height: 100%; display: block; }
      .obj3 { position: absolute; display: block; perspective: 1200px; }
      .obj { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; box-shadow: 0 50px 90px rgba(0,0,0,0.28), inset 0 3px 0 rgba(255,255,255,0.4); overflow: hidden; }
      .oglare { position: absolute; left: -20%; top: -40%; width: 90%; height: 90%; display: block; border-radius: 50%; background: radial-gradient(closest-side, rgba(255,255,255,0.45), rgba(255,255,255,0)); }
      .oldi.big { width: 50%; height: 50%; position: relative; }
      .oshadow { position: absolute; left: 10%; right: 10%; bottom: -14%; height: 10%; display: block; border-radius: 50%; background: radial-gradient(closest-side, rgba(0,0,0,0.22), rgba(0,0,0,0)); }
      .lwrap { position: absolute; left: 0; right: 0; display: block; }
      .logo { position: absolute; display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #2A2A2E, #0E0E10 70%); color: #FFFFFF; box-shadow: 0 30px 70px rgba(0,0,0,0.28), inset 0 2px 0 rgba(255,255,255,0.14); overflow: hidden; }
      .logo b { position: relative; font-weight: 800; letter-spacing: -0.03em; }
      .logo.spark { background: #FFFFFF; box-shadow: 0 30px 70px rgba(66,103,210,0.25), 0 0 0 1px rgba(0,0,0,0.04); }
      .lsp { position: relative; display: block; width: 62%; height: 62%; }
      .stile { position: absolute; display: block; background: #FFFFFF; box-shadow: 0 24px 50px rgba(0,0,0,0.13), 0 0 0 1px rgba(0,0,0,0.04); }
      .simg { position: absolute; left: 22%; top: 22%; width: 56%; height: 56%; display: block; color: #444; }
      .simg svg { width: 100%; height: 100%; display: block; }
      .swap { position: absolute; display: block; perspective: 900px; }
      .swflip { position: absolute; inset: 0; display: block; transform-style: preserve-3d; }
      .swface { position: absolute; inset: 0; display: block; backface-visibility: hidden; -webkit-backface-visibility: hidden; background: #FFFFFF; box-shadow: 0 24px 50px rgba(0,0,0,0.13), 0 0 0 1px rgba(0,0,0,0.04); }
      .swface.back { transform: rotateY(180deg); }
      .swface.back.dark { display: flex; align-items: center; justify-content: center; background: linear-gradient(160deg, #2A2A2E, #0E0E10 70%); color: #FFFFFF; }
      .swface.back.dark b { font-weight: 800; letter-spacing: -0.03em; }
      .swhalo { position: absolute; left: -45%; top: -45%; width: 190%; height: 190%; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${accent}33, ${accent}10 55%, transparent); opacity: 0; }
      .lshine { position: absolute; top: -20%; bottom: -20%; left: -60%; width: 45%; display: block; background: linear-gradient(100deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.45) 50%, rgba(255,255,255,0) 100%); }
      .tyl { position: absolute; display: block; text-align: center; white-space: nowrap; letter-spacing: -0.035em; color: #1A1A1E; }
      .tybox { position: relative; display: inline-block; }
      .tyghost { visibility: hidden; white-space: pre; }
      .tyghost .w { font-weight: 400; } .tyghost b.w { font-weight: 720; }
      .tytyped { position: absolute; left: 0; top: 0; white-space: pre; display: block; }
      .tyi { font-weight: 400; color: #3A3A40; }
      .tyn { font-weight: 720; }
      .caret { display: inline-block; width: 0.06em; height: 0.95em; margin-left: 0.04em; vertical-align: -0.1em; background: #1A1A1E; opacity: 0; }
      .rlead { position: absolute; display: block; text-align: center; font-weight: 420; color: #2A2A2F; letter-spacing: -0.035em; white-space: nowrap; }
      .ritem { position: absolute; display: block; text-align: center; font-weight: 720; color: #0E0E11; letter-spacing: -0.04em; white-space: nowrap; }
      .rmark { position: absolute; display: block; padding: 8px; border-radius: 14px; background: #FFFFFF; box-shadow: 0 10px 24px rgba(0,0,0,0.12); color: #444; }
      .sticky { position: absolute; display: flex; align-items: center; justify-content: center; padding: 12px; background: linear-gradient(160deg, #FFE97A, #F7D348); box-shadow: 0 18px 30px rgba(0,0,0,0.35); font-size: ${px(26)}px; font-weight: 600; color: #4A3B00; text-align: center; }
      .tab { position: absolute; display: flex; align-items: center; gap: 10px; padding: ${px(10)}px ${px(18)}px; border-radius: ${px(12)}px; font-size: ${px(24)}px; font-weight: 600; white-space: nowrap; }
      .tab.dark { background: rgba(255,255,255,0.1); color: #E6E6EA; border: 1px solid rgba(255,255,255,0.14); }
      .tab.light { background: #FFFFFF; color: #3A3A40; box-shadow: 0 10px 24px rgba(0,0,0,0.1); }
      .tab b { display: block; width: ${px(14)}px; height: ${px(14)}px; border-radius: 3px; background: #22C55E; }
      .nchip { position: absolute; display: flex; align-items: center; gap: ${px(14)}px; padding: ${px(16)}px ${px(26)}px; border-radius: ${px(22)}px; background: #FFFFFF; box-shadow: 0 18px 40px rgba(0,0,0,0.1); font-size: ${px(32)}px; font-weight: 600; color: #3A3A40; white-space: nowrap; }
      .nci { display: block; width: ${px(44)}px; height: ${px(44)}px; padding: ${px(8)}px; border-radius: ${px(12)}px; color: #FFFFFF; }
      .persp { position: absolute; inset: 0; perspective: ${Math.round(Math.max(W, H) * 1.6)}px; }
      .tilt { position: absolute; inset: 0; transform-origin: 50% 50%; transform-style: preserve-3d; }
      .ctile { position: absolute; display: block; padding: ${px(24)}px; border-radius: ${px(30)}px; background: #FFFFFF; box-shadow: 0 18px 40px rgba(0,0,0,0.12); color: #333; }
      .cimg { position: relative; display: block; width: 100%; height: 100%; }
      .halo { position: absolute; display: block; border-radius: 50%; background: radial-gradient(closest-side, rgba(255,255,255,0.32), rgba(255,255,255,0.08) 45%, rgba(255,255,255,0)); }
      .maker { position: absolute; left: 0; right: 0; text-align: center; color: #8A8A93; display: block; }
      .ctab { position: absolute; display: flex; align-items: center; justify-content: center; overflow: hidden; background: #DADADF; color: #FFFFFF; font-weight: 650; letter-spacing: -0.01em; box-shadow: 0 18px 40px rgba(0,0,0,0.18); }
      .ctaf { position: absolute; inset: 0; display: block; background: #141416; transform-origin: 0 50%; }
      .ctal { position: relative; display: block; }
      .ccv { position: absolute; inset: 0; display: block; }
      .ccv [style*="left:"] { position: absolute; }
      ${uiCss(accent)}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-width="${W}" data-height="${H}" data-duration="${f(DUR)}" data-fps="${FPS}">
${sections.join("\n")}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${HELPERS}
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration: DUR, timings, cues: cues.sort((a, b) => a.t - b.t), counts };
}

/** Camera keys → tweens of the canvas (x, y, scale; origin top-left) and of the tilt wrapper (3D rotation). */
export function cameraTweens(id: string, keys: CamKey[], o: { W: number; H: number; t0: number; D: number; cw: number; ch: number; fitsPortrait?: boolean }): string[] {
  const out: string[] = [];
  const pose = (key: CamKey, last = false) => {
    // a tall frame shows less of a wide UI: the camera goes closer and pans more (reference #17); the last key still
    // pulls back to the whole screen so the result is readable
    const zw = o.H > o.W && !last && !o.fitsPortrait ? key.zw * 0.72 : key.zw;
    const s = Math.min(3.2, Math.max(0.35, (o.W * 0.94) / zw));
    return { s: r3(s), x: Math.round(o.W / 2 - s * key.cx), y: Math.round(o.H / 2 - s * key.cy) };
  };
  const ks = [...keys].sort((a, b) => a.t - b.t);
  const first = pose(ks[0]);
  out.push(`tl.set("#${id}-cv", { x: ${first.x}, y: ${first.y}, scale: ${first.s} }, ${f(o.t0)});`);
  out.push(`tl.set("#${id}-tilt", { rotationX: ${ks[0].rx ?? 0}, rotationY: ${ks[0].ry ?? 0} }, ${f(o.t0)});`);
  // the tilt flattens out over the first move (the reference's "laptop at an angle" settling)
  if (ks[0].rx || ks[0].ry) out.push(`tl.to("#${id}-tilt", { rotationX: 0, rotationY: 0, duration: ${f(Math.min(1.6, o.D * 0.45))}, ease: "power2.inOut" }, ${f(o.t0 + 0.05)});`);
  for (let i = 1; i < ks.length; i++) {
    const a = ks[i - 1];
    const b = ks[i];
    const pb = pose(b, i === ks.length - 1);
    const dur = Math.max(0.2, Math.min(o.D, b.t) - a.t - 0.02);
    out.push(`tl.to("#${id}-cv", { x: ${pb.x}, y: ${pb.y}, scale: ${pb.s}, duration: ${f(dur)}, ease: "${b.ease ?? "power2.inOut"}" }, ${f(o.t0 + a.t)});`);
  }
  // keep drifting through the crossfade into the next scene
  const last = pose(ks.at(-1)!, ks.length > 1);
  out.push(`tl.to("#${id}-cv", { scale: ${r3(last.s * 1.03)}, x: ${Math.round(last.x - (o.W / 2 - last.x) * 0.03)}, y: ${Math.round(last.y - (o.H / 2 - last.y) * 0.03)}, duration: ${OVERLAP + 0.2}, ease: "none" }, ${f(o.t0 + o.D)});`);
  return out;
}

/** lighten (+) / darken (−) a hex colour */
export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amt >= 0 ? c + (255 - c) * amt : c * (1 + amt)));
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** Icons the composition may use (preloaded): UI icons + the hook's object + guesses for integrations. */
export function iconsNeeded(p: Promo): string[] {
  const s = new Set<string>(["user-plus", "mail", "send", "check", "circle-dot", "instagram", "linkedin"]);
  s.add(p.hook.old_icon);
  for (const n of p.integrations) s.add(guessIcon(n));
  for (const ft of [...p.features.map((x) => x.ui), ...(p.proof ? [p.proof.ui] : [])]) for (const it of ft.items) if (it.icon) s.add(it.icon);
  return [...s];
}
