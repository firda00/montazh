import type { DesignSpec } from "../schemas/index.ts";

/**
 * Stage 33 — the look of Abror Bakhtiyarovich's reels (docs/abror-format.md), shared by the montage of his selfie
 * (`abror_split`, format A: split → full-frame head for the last quarter) and the faceless demo reels (`abror_full`
 * without the head: full-frame inserts). Everything here is pure: text in, HTML/CSS/GSAP tweens out.
 *
 *   normalizeUz / uzApostropheIssues — Uzbek Latin oʻ/gʻ with U+02BB, the glottal stop with U+02BC
 *   splitSections                    — per-section layout (split | full_speaker | full_insert)
 *   hookPlateLines / hookPlateTiming / hookPlateLayer — the blue hook plate (H1): 2 caps lines, exits left with a blur
 *   ctaLayer                         — «"MAN"» comment-word card / phone (Telegram) card
 *   renderPane / paneCss             — insert panes: article (key line sharp under a pink marker), site scroll,
 *                                      product UI in a phone, logo, number, text card, photo
 */

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- Uzbek Latin

/** U+02BB MODIFIER LETTER TURNED COMMA — the oʻ / gʻ sign of the official Uzbek Latin alphabet */
export const OKINA = "ʻ";
/** U+02BC MODIFIER LETTER APOSTROPHE — the tutuq belgisi (glottal stop: maʼno, eʼlon) */
export const TUTUQ = "ʼ";
/** every apostrophe-like character people type instead */
const APOS = "'‘’ʻʼ`´ʹ";
const APOS_RE = new RegExp(`[${APOS}]`);

/**
 * Uzbek Latin apostrophes as the alphabet wants them: o/g + any apostrophe → oʻ/gʻ (U+02BB), a letter + apostrophe +
 * letter elsewhere → the glottal stop U+02BC. Quotes around words (no letter on one side) are left alone.
 */
export function normalizeUz(text: string): string {
  let out = "";
  const chars = [...text.normalize("NFC")];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const prev = chars[i - 1] ?? "";
    const next = chars[i + 1] ?? "";
    if (!APOS_RE.test(c) || !/\p{L}/u.test(prev) || !/\p{L}/u.test(next)) {
      // not an apostrophe, or a quote around a word (no letter on one side): as is
      out += c;
      continue;
    }
    // bo'ldi, O'ZBEKISTON, g'oya → U+02BB; ma'no, e'lon, Qur'on → U+02BC
    out += /[oOgG]/.test(prev) ? OKINA : TUTUQ;
  }
  return out;
}

export interface ApostropheIssue {
  at: number;
  word: string;
  found: string;
  want: string;
}

/** Places where the Uzbek apostrophes are not the right code points (empty = clean). */
export function uzApostropheIssues(text: string): ApostropheIssue[] {
  const issues: ApostropheIssue[] = [];
  const t = text.normalize("NFC");
  const fixed = normalizeUz(t);
  const a = [...t];
  const b = [...fixed];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    // the word around it, for the report
    let s = i;
    while (s > 0 && /[\p{L}\p{N}]/u.test(a[s - 1])) s--;
    let e = i + 1;
    while (e < a.length && /[\p{L}\p{N}]/u.test(a[e])) e++;
    issues.push({ at: i, word: a.slice(s, e).join(""), found: `U+${a[i].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`, want: `U+${b[i].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` });
  }
  return issues;
}

/** Caps for Uzbek Latin (the apostrophes stay; «i» stays «I», not the Turkish dotted İ). */
export const upperUz = (s: string) => normalizeUz(s).toUpperCase();

// ---------------------------------------------------------------- per-section layout

export type SectionLayout = "split" | "full_speaker" | "full_insert";
export interface Section {
  start: number;
  end: number;
  layout: SectionLayout;
}

/**
 * The layout of the reel over time (format A): split until `fullFrom` × duration, snapped to the nearest phrase start
 * within ±3 s (the moral starts a sentence), then the speaker on the whole frame to the end. `fullInserts` are windows
 * inside the split where the top panel takes the whole frame (a striking clip). fullFrom ≥ 1 → one split section.
 */
export function splitSections(duration: number, fullFrom: number, phraseStarts: number[] = [], fullInserts: { start: number; end: number }[] = []): Section[] {
  const D = Math.max(0, duration);
  if (D <= 0) return [];
  let T = fullFrom >= 1 ? D : Math.max(0, fullFrom * D);
  if (T < D) {
    const near = phraseStarts.filter((s) => s > 1 && s < D - 2 && Math.abs(s - T) <= 3).sort((a, b) => Math.abs(a - T) - Math.abs(b - T))[0];
    if (near !== undefined) T = near;
    // the full part must be long enough to matter, the split part too
    if (D - T < 2) T = D;
    if (T < 3) T = Math.min(D, 3);
  }
  T = r3(T);
  const out: Section[] = [];
  let at = 0;
  const ins = fullInserts
    .map((w) => ({ start: r3(Math.max(0, w.start)), end: r3(Math.min(T, w.end)) }))
    .filter((w) => w.end - w.start >= 0.4)
    .sort((a, b) => a.start - b.start);
  for (const w of ins) {
    if (w.start < at) continue;
    if (w.start > at) out.push({ start: at, end: w.start, layout: "split" });
    out.push({ start: w.start, end: w.end, layout: "full_insert" });
    at = w.end;
  }
  if (T > at) out.push({ start: at, end: T, layout: "split" });
  if (T < D) out.push({ start: T, end: r3(D), layout: "full_speaker" });
  return out;
}

/** The layout at time t (the last section covers the end). */
export function sectionAt(sections: Section[], t: number): SectionLayout {
  for (const s of sections) if (t >= s.start - 1e-6 && t < s.end - 1e-6) return s.layout;
  return sections.at(-1)?.layout ?? "split";
}

/** Start of the full-frame speaker part, or null when the reel stays split. */
export function fullSpeakerFrom(sections: Section[] | undefined): number | null {
  const s = sections?.find((x) => x.layout === "full_speaker");
  return s ? s.start : null;
}

// ---------------------------------------------------------------- hook plate (H1)

/** Two caps lines, ≤ maxWords words, the first line the shorter, punchier one when it can be ("21 MLN $ / IKKI HINDISTONLIK…"). */
export function hookPlateLines(text: string, maxWords = 6): string[] {
  const explicit = text.split(/\s*(?:\n|\s\/\s|\|)\s*/).map((s) => s.trim()).filter(Boolean);
  const caps = (s: string) => upperUz(s.replace(/\s+/g, " ").trim());
  if (explicit.length >= 2) {
    const words = explicit.slice(0, 2).map((l) => l.split(" "));
    // keep the word cap across both lines
    const a = words[0].slice(0, Math.max(1, maxWords - 1));
    const b = words[1].slice(0, Math.max(1, maxWords - a.length));
    return [caps(a.join(" ")), caps(b.join(" "))];
  }
  const words = caps(text).split(" ").filter(Boolean).slice(0, maxWords);
  if (words.length <= 2) return [words.join(" ")];
  // balanced split by characters, the first line not longer than the second by more than one word
  let best = 1;
  let bestCost = Infinity;
  for (let k = 1; k < words.length; k++) {
    const l1 = words.slice(0, k).join(" ").length;
    const l2 = words.slice(k).join(" ").length;
    // the first line is drawn 1/0.8 larger: balance the drawn widths
    const cost = Math.abs(l1 * 1.25 - l2);
    if (cost < bestCost) {
      bestCost = cost;
      best = k;
    }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

/** When the plate is on screen: in at `start`, holds `hold` s (3–5), slides out over EXIT s; never past the end. */
export const HOOK_EXIT = 0.28;
export function hookPlateTiming(hold: number, duration: number, start = 0): { start: number; exitAt: number; end: number } {
  const h = Math.min(5, Math.max(3, hold));
  const end = Math.min(duration, start + h + HOOK_EXIT);
  const exitAt = Math.max(start + 0.5, end - HOOK_EXIT);
  return { start: r3(start), exitAt: r3(exitAt), end: r3(end) };
}

export interface HookPlateInput {
  W: number;
  H: number;
  spec: DesignSpec["hook_plate"];
  lines: string[];
  /** vertical centre, fraction of the height */
  anchorY: number;
  start: number;
  duration: number;
  /** CSS font stack, single quotes only */
  font: string;
  /** advance width of text at a size (Montserrat metrics); default: a caps heuristic */
  measure?: (text: string, size: number) => number;
  id?: string;
  trackIndex?: number;
}

export interface Layer {
  css: string;
  html: string;
  tweens: string[];
}

/** Sizes of the two lines so the widest fits the plate (first line font_size, second line2_scale of it). */
export function hookPlateSizes(i: Pick<HookPlateInput, "W" | "spec" | "lines" | "measure">): { size1: number; size2: number; boxW: number } {
  const k = i.W / 1080;
  const measure = i.measure ?? ((t: string, s: number) => t.length * s * 0.74);
  const inner = i.spec.width * i.W - 2 * (i.spec.padding + 12) * k - 2 * i.spec.border * k;
  let size1 = i.spec.font_size * k;
  const ratio = i.spec.line2_scale;
  for (let n = 0; n < 40; n++) {
    const w1 = measure(i.lines[0] ?? "", size1);
    const w2 = i.lines[1] ? measure(i.lines[1], size1 * ratio) : 0;
    if (Math.max(w1, w2) <= inner || size1 < 24 * k) break;
    size1 *= 0.95;
  }
  const size2 = size1 * ratio;
  const textW = Math.max(measure(i.lines[0] ?? "", size1), i.lines[1] ? measure(i.lines[1], size2) : 0);
  return { size1: r1(size1), size2: r1(size2), boxW: r1(Math.min(i.spec.width * i.W, textW + 2 * (i.spec.padding + 12) * k + 2 * i.spec.border * k)) };
}

/** Vertical centring without CSS transforms: pad a full-frame box so its content sits at anchorY·H. */
export function anchorPad(anchorY: number, H: number): { top: number; bottom: number } {
  const cy = anchorY * H;
  return cy >= H / 2 ? { top: r3(2 * cy - H), bottom: 0 } : { top: 0, bottom: r3(H - 2 * cy) };
}

/** The blue hook plate as one timed section: pops in, holds, then slides out to the left with a motion blur. */
export function hookPlateLayer(i: HookPlateInput): Layer & { timing: ReturnType<typeof hookPlateTiming>; extent: { lo: number; hi: number } } {
  const id = i.id ?? "hook-plate";
  const S = i.spec;
  const k = i.W / 1080;
  const timing = hookPlateTiming(S.hold, i.duration, i.start);
  const { size1, size2 } = hookPlateSizes(i);
  const pad = anchorPad(i.anchorY, i.H);
  const lines = i.lines.map((l, n) => `<span class="hp-line" id="${id}-l${n}" style="font-size:${n === 0 ? size1 : size2}px">${esc(l)}</span>`).join("");
  const html = `      <section id="${id}" class="clip hp" data-start="${fmt(timing.start)}" data-duration="${fmt(timing.end - timing.start)}" data-track-index="${i.trackIndex ?? 11}" style="padding:${pad.top}px 0 ${pad.bottom}px">\n        <span class="hp-box" id="${id}-box">${lines}</span>\n      </section>`;
  const css = `
      .hp { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
      .hp-box { display: flex; flex-direction: column; align-items: center; max-width: ${r1(S.width * i.W)}px; padding: ${r1(S.padding * k * 0.7)}px ${r1((S.padding + 12) * k)}px ${r1(S.padding * k * 0.8)}px; border-radius: ${r1(S.radius * k)}px; background: ${S.background}; border: ${r1(S.border * k)}px solid ${S.border_color}; border-bottom-width: ${r1(S.border_bottom * k)}px; box-shadow: 0 ${r1(10 * k)}px ${r1(30 * k)}px rgba(0,0,0,0.35); }
      .hp-line { display: block; white-space: nowrap; font-family: ${i.font}; font-weight: ${S.weight}; color: ${S.color}; line-height: 1.12; letter-spacing: -0.01em; text-align: center; }`;
  const box = `#${id}-box`;
  const tweens = [
    `tl.fromTo("${box}", { opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(1.6)" }, ${fmt(timing.start)});`,
    // the exit of his editors: a fast slide to the left with a horizontal smear
    `tl.fromTo("${box}", { x: 0, opacity: 1, filter: "blur(0px)" }, { x: ${r1(-1.15 * i.W)}, opacity: 0.4, filter: "blur(${r1(16 * k)}px)", duration: ${HOOK_EXIT}, ease: "power3.in", immediateRender: false }, ${fmt(timing.exitAt)});`,
  ];
  const h = (size1 + (i.lines[1] ? size2 : 0)) * 1.12 + 2 * S.padding * k + (S.border + S.border_bottom) * k;
  return { css, html, tweens, timing, extent: { lo: i.anchorY - h / 2 / i.H, hi: i.anchorY + h / 2 / i.H } };
}

// ---------------------------------------------------------------- CTA overlays

export interface CtaInput {
  W: number;
  H: number;
  kind: "keyword" | "phone";
  /** keyword: the comment word ("MAN"); phone: "+998 90 123 45 67" or "@foundershub" */
  value: string;
  /** the small line ("so'zini yozib qoldiring", "Telegram") */
  label: string;
  start: number;
  end: number;
  anchorY: number;
  font: string;
  id?: string;
  trackIndex?: number;
}

/** The CTA card over the last seconds: a huge quoted comment word, or a Telegram card with the number. */
export function ctaLayer(c: CtaInput): Layer {
  const id = c.id ?? "cta";
  const k = c.W / 1080;
  const dur = Math.max(0.2, c.end - c.start);
  const pad = anchorPad(c.anchorY, c.H);
  const tweens: string[] = [];
  let inner: string;
  if (c.kind === "keyword") {
    const word = upperUz(c.value.replace(/["“”«»]/g, "").trim());
    const shown = `“${word}”`;
    const size = r1(Math.min(0.095 * c.H, (0.86 * c.W) / Math.max(1, shown.length * 0.74)));
    inner = `<span class="cta-word" id="${id}-word" style="font-size:${size}px">${esc(shown)}</span>${c.label ? `<span class="cta-label" id="${id}-label">${esc(upperUz(c.label))}</span>` : ""}`;
    tweens.push(`tl.fromTo("#${id}-word", { opacity: 0, scale: 0.55 }, { opacity: 1, scale: 1, duration: 0.34, ease: "back.out(2.2)" }, ${fmt(c.start)});`);
    if (dur > 1.4) tweens.push(`tl.fromTo("#${id}-word", { scale: 1 }, { scale: 1.06, duration: 0.5, ease: "sine.inOut", yoyo: true, repeat: ${Math.max(0, Math.floor((dur - 0.9) / 0.5) - 1)}, immediateRender: false }, ${fmt(c.start + 0.4)});`);
    if (c.label) tweens.push(`tl.fromTo("#${id}-label", { opacity: 0, y: ${r1(20 * k)} }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, ${fmt(c.start + 0.25)});`);
  } else {
    inner = `<span class="cta-phone" id="${id}-card"><span class="cta-tg"><svg viewBox="0 0 24 24" width="${r1(64 * k)}" height="${r1(64 * k)}"><circle cx="12" cy="12" r="12" fill="#2AABEE"/><path d="M5.4 11.7l11.1-4.3c.5-.2 1 .1.8.9l-1.9 8.9c-.1.6-.5.8-1 .5l-2.9-2.1-1.4 1.3c-.2.2-.3.3-.6.3l.2-3 5.4-4.9c.2-.2 0-.3-.3-.1l-6.7 4.2-2.9-.9c-.6-.2-.6-.6.2-.8z" fill="#FFFFFF"/></svg></span><span class="cta-ptext">${c.label ? `<span class="cta-plabel">${esc(c.label)}</span>` : ""}<span class="cta-num">${esc(c.value)}</span></span></span>`;
    tweens.push(`tl.fromTo("#${id}-card", { opacity: 0, y: ${r1(60 * k)}, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "expo.out" }, ${fmt(c.start)});`);
  }
  const html = `      <section id="${id}" class="clip cta" data-start="${fmt(c.start)}" data-duration="${fmt(dur)}" data-track-index="${c.trackIndex ?? 12}" style="padding:${pad.top}px ${r1(0.06 * c.W)}px ${pad.bottom}px">\n        <span class="cta-in">${inner}</span>\n      </section>`;
  const css = `
      .cta { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
      .cta-in { display: flex; flex-direction: column; align-items: center; gap: ${r1(10 * k)}px; }
      .cta-word { display: block; white-space: nowrap; font-family: ${c.font}; font-weight: 800; color: #FFFFFF; line-height: 1; letter-spacing: -0.01em; text-shadow: 0 ${r1(6 * k)}px ${r1(26 * k)}px rgba(0,0,0,0.55), 0 ${r1(2 * k)}px ${r1(4 * k)}px rgba(0,0,0,0.5); }
      .cta-label { display: block; white-space: nowrap; font-family: ${c.font}; font-weight: 700; font-size: ${r1(40 * k)}px; color: #FFFFFF; letter-spacing: 0.04em; padding: ${r1(8 * k)}px ${r1(18 * k)}px; border-radius: ${r1(10 * k)}px; background: rgba(29,61,184,0.92); }
      .cta-phone { display: flex; align-items: center; gap: ${r1(22 * k)}px; padding: ${r1(22 * k)}px ${r1(34 * k)}px; border-radius: ${r1(30 * k)}px; background: rgba(10,14,30,0.82); border: ${r1(3 * k)}px solid rgba(255,255,255,0.9); box-shadow: 0 ${r1(16 * k)}px ${r1(44 * k)}px rgba(0,0,0,0.45); }
      .cta-tg { display: block; }
      .cta-ptext { display: flex; flex-direction: column; }
      .cta-plabel { display: block; font-family: ${c.font}; font-weight: 600; font-size: ${r1(30 * k)}px; color: rgba(255,255,255,0.75); }
      .cta-num { display: block; white-space: nowrap; font-family: ${c.font}; font-weight: 800; font-size: ${r1(70 * k)}px; color: #FFFFFF; letter-spacing: -0.02em; line-height: 1.05; text-shadow: 0 ${r1(4 * k)}px ${r1(14 * k)}px rgba(0,0,0,0.5); }`;
  return { css, html, tweens };
}

// ---------------------------------------------------------------- insert panes

export type Pane =
  | { kind: "article"; publisher: string; domain: string; date?: string; title: string; lines: string[]; key: number[]; image?: string; credit?: string }
  | { kind: "site"; domain: string; image: string; width: number; height: number }
  | { kind: "ui"; domain: string; image: string; width: number; height: number }
  | { kind: "logo"; name: string; path?: string; hex?: string; value?: string; label?: string }
  | { kind: "number"; value: string; label: string; sub?: string }
  | { kind: "text"; lines: string[]; accent?: number }
  | { kind: "photo"; image: string; credit?: string };

export interface PaneBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PaneContext {
  id: string;
  start: number;
  end: number;
  /** the area the pane fills (top panel / whole frame) and where its content must sit inside it */
  box: PaneBox;
  content: PaneBox;
  /** absolute file → project-relative src */
  rel: (file: string) => string;
  font: string;
  k: number;
}

/** Breaks a paragraph into card lines of ≤ maxChars (the key sentence kept on its own lines). */
export function articleLines(paragraph: string, keyText: string, maxChars = 34): { lines: string[]; key: number[] } {
  const wrap = (s: string) => {
    const out: string[] = [];
    let cur = "";
    for (const w of s.split(/\s+/).filter(Boolean)) {
      if (cur && (cur + " " + w).length > maxChars) {
        out.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) out.push(cur);
    return out;
  };
  const p = paragraph.replace(/\s+/g, " ").trim();
  const kt = keyText.replace(/\s+/g, " ").trim();
  const at = kt ? p.toLowerCase().indexOf(kt.toLowerCase()) : -1;
  if (at < 0) {
    const lines = [...wrap(p).slice(0, 6), ...(kt ? wrap(kt) : [])];
    const kl = kt ? wrap(kt).length : 0;
    return { lines, key: Array.from({ length: kl }, (_, i) => lines.length - kl + i) };
  }
  const before = wrap(p.slice(0, at)).slice(-3);
  const keyL = wrap(kt);
  const after = wrap(p.slice(at + kt.length)).slice(0, 3);
  return { lines: [...before, ...keyL, ...after], key: keyL.map((_, i) => before.length + i) };
}

/** One insert pane: absolutely positioned inside ctx.box (the section element is the box). */
export function renderPane(p: Pane, ctx: PaneContext): { html: string; tweens: string[] } {
  const { id, k, content: c } = ctx;
  const t0 = ctx.start;
  const dur = Math.max(0.3, ctx.end - ctx.start);
  const px = (n: number) => r1(n * k);
  const tw: string[] = [];
  const at = (x: number) => fmt(t0 + x);
  // the content rectangle relative to the box
  const cx = r1(c.x - ctx.box.x);
  const cy = r1(c.y - ctx.box.y);
  const rect = (x: number, y: number, w: number, h: number) => `left:${r1(x)}px;top:${r1(y)}px;width:${r1(w)}px;height:${r1(h)}px`;
  switch (p.kind) {
    case "article": {
      const w = Math.min(c.w, px(920));
      const x = cx + (c.w - w) / 2;
      const lineSize = px(40);
      const titleSize = px(46);
      const img = p.image ? `<img class="ab-art-img" src="${esc(ctx.rel(p.image))}" alt="" />` : "";
      const keys = new Set(p.key);
      let kn = 0;
      const body = p.lines
        .map((l, n) =>
          keys.has(n)
            ? `<span class="ab-art-l key"><span class="ab-mark" id="${id}-mk${kn++}"></span><span class="ab-kt">${esc(l)}</span></span>`
            : `<span class="ab-art-l blur">${esc(l)}</span>`,
        )
        .join("");
      const html = `<span class="ab-art-glow" style="${rect(x + w * 0.1, cy + c.h * 0.55, w * 0.8, c.h * 0.45)}"></span><span class="ab-art" id="${id}-card" style="left:${r1(x)}px;top:${r1(cy)}px;width:${r1(w)}px;max-height:${r1(c.h)}px"><span class="ab-art-head"><span class="ab-art-pub">${esc(p.publisher)}</span>${p.date ? `<span class="ab-art-date">${esc(p.date)}</span>` : ""}</span><span class="ab-art-title blur" style="font-size:${titleSize}px">${esc(p.title)}</span>${img}<span class="ab-art-body" style="font-size:${lineSize}px">${body}</span><span class="ab-art-src">${esc(p.domain)}</span></span>`;
      tw.push(`tl.fromTo("#${id}-card", { opacity: 0, y: ${px(70)}, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 0.42, ease: "expo.out" }, ${at(0)});`);
      // the marker draws under the key line, then the card leans in on it
      const mkDur = Math.min(0.5, (dur * 0.3) / Math.max(1, kn));
      for (let m = 0; m < kn; m++) tw.push(`tl.fromTo("#${id}-mk${m}", { width: "0%" }, { width: "100%", duration: ${fmt(mkDur)}, ease: "power2.inOut" }, ${at(Math.min(0.55, dur * 0.2) + m * mkDur)});`);
      tw.push(`tl.fromTo("#${id}-card", { scale: 1 }, { scale: 1.06, duration: ${fmt(Math.max(0.4, dur - 0.6))}, ease: "sine.inOut", immediateRender: false }, ${at(0.45)});`);
      return { html, tweens: tw };
    }
    case "site":
    case "ui": {
      const phone = p.kind === "ui";
      const w = phone ? Math.min(c.w * 0.62, (c.h * 0.96 * 390) / 760) : Math.min(c.w, px(900));
      const h = phone ? Math.min(c.h, (w * 760) / 390) : c.h;
      const x = cx + (c.w - w) / 2;
      const y = cy + (c.h - h) / 2;
      const bar = phone ? px(26) : px(64);
      const imgH = (w * p.height) / Math.max(1, p.width);
      const view = h - bar;
      const travel = Math.max(0, imgH - view);
      const html = `<span class="ab-site${phone ? " phone" : ""}" id="${id}-card" style="${rect(x, y, w, h)}"><span class="ab-view" style="top:${r1(bar)}px"><img class="ab-shot" id="${id}-shot" src="${esc(ctx.rel(p.image))}" alt="" style="width:${r1(w)}px;height:${r1(imgH)}px" /></span><span class="ab-bar" style="height:${r1(bar)}px">${phone ? `<span class="ab-notch"></span>` : `<span class="ab-lock"></span><span class="ab-dom">${esc(p.domain)}</span>`}</span></span>${phone ? `<span class="ab-dom-tag" style="left:${r1(x)}px;top:${r1(y + h + px(14))}px;width:${r1(w)}px">${esc(p.domain)}</span>` : ""}`;
      tw.push(`tl.fromTo("#${id}-card", { opacity: 0, y: ${px(80)}, scale: 0.95 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "expo.out" }, ${at(0)});`);
      if (!phone && travel > 4) tw.push(`tl.fromTo("#${id}-shot", { y: 0 }, { y: ${r1(-Math.min(travel, (dur - 0.8) * 0.5 * ctx.box.h))}, duration: ${fmt(Math.max(0.5, dur - 1))}, ease: "power1.inOut", immediateRender: false }, ${at(0.6)});`);
      if (phone) tw.push(`tl.fromTo("#${id}-card", { scale: 1 }, { scale: 1.05, duration: ${fmt(Math.max(0.4, dur - 0.5))}, ease: "sine.inOut", immediateRender: false }, ${at(0.4)});`);
      return { html, tweens: tw };
    }
    case "logo": {
      const color = p.hex && /^#[0-9A-F]{6}$/i.test(p.hex) && !/^#(F{6}|FEFEFE|FDFDFD)$/i.test(p.hex) ? p.hex : "#111111";
      const mark = p.path ? `<svg class="ab-logo-svg" id="${id}-mark" viewBox="0 0 24 24" width="${px(230)}" height="${px(230)}"><path d="${esc(p.path)}" fill="${color}"/></svg>` : "";
      const nameSize = px(Math.min(110, 1600 / Math.max(6, p.name.length * 1.1)));
      const html = `<span class="ab-logo" style="${rect(cx, cy, c.w, c.h)}">${mark}<span class="ab-logo-name" id="${id}-name" style="font-size:${nameSize}px">${esc(p.name)}</span>${p.value ? `<span class="ab-chip" id="${id}-val">${esc(p.value)}</span>` : ""}${p.label ? `<span class="ab-logo-lab" id="${id}-lab">${esc(p.label)}</span>` : ""}</span>`;
      if (mark) tw.push(`tl.fromTo("#${id}-mark", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.36, ease: "back.out(2)" }, ${at(0)});`);
      tw.push(`tl.fromTo("#${id}-name", { opacity: 0, y: ${px(30)} }, { opacity: 1, y: 0, duration: 0.32, ease: "power3.out" }, ${at(mark ? 0.12 : 0)});`);
      if (p.value) tw.push(`tl.fromTo("#${id}-val", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${at(Math.min(0.7, dur * 0.35))});`);
      if (p.label) tw.push(`tl.fromTo("#${id}-lab", { opacity: 0 }, { opacity: 1, duration: 0.25, ease: "power1.out" }, ${at(Math.min(0.9, dur * 0.45))});`);
      return { html, tweens: tw };
    }
    case "number": {
      const size = px(Math.min(220, 1500 / Math.max(3, p.value.length * 0.78)));
      const html = `<span class="ab-num" style="${rect(cx, cy, c.w, c.h)}"><span class="ab-num-v" id="${id}-v" style="font-size:${size}px">${esc(p.value)}</span><span class="ab-num-l" id="${id}-l">${esc(p.label)}</span>${p.sub ? `<span class="ab-num-s" id="${id}-s">${esc(p.sub)}</span>` : ""}</span>`;
      tw.push(`tl.fromTo("#${id}-v", { opacity: 0, scale: 1.5 }, { opacity: 1, scale: 1, duration: 0.32, ease: "power4.out" }, ${at(0)});`);
      tw.push(`tl.fromTo("#${id}-l", { opacity: 0, y: ${px(26)} }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, ${at(0.18)});`);
      if (p.sub) tw.push(`tl.fromTo("#${id}-s", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, ${at(0.4)});`);
      tw.push(`tl.fromTo("#${id}-v", { scale: 1 }, { scale: 1.05, duration: ${fmt(Math.max(0.4, dur - 0.5))}, ease: "sine.inOut", immediateRender: false }, ${at(0.35)});`);
      return { html, tweens: tw };
    }
    case "text": {
      const longest = Math.max(...p.lines.map((l) => l.length), 4);
      const size = px(Math.min(96, 1500 / Math.max(5, longest * 0.95)));
      const html = `<span class="ab-text" style="${rect(cx, cy, c.w, c.h)}">${p.lines.map((l, n) => `<span class="ab-text-l${n === p.accent ? " acc" : ""}" id="${id}-t${n}" style="font-size:${n === p.accent ? r1(size * 1.15) : size}px">${esc(l)}</span>`).join("")}</span>`;
      p.lines.forEach((_, n) => tw.push(`tl.fromTo("#${id}-t${n}", { opacity: 0, y: ${px(40)} }, { opacity: 1, y: 0, duration: 0.34, ease: "power3.out" }, ${at(Math.min(dur * 0.5, n * 0.22))});`));
      return { html, tweens: tw };
    }
    case "photo": {
      const html = `<img class="ab-photo" id="${id}-img" src="${esc(ctx.rel(p.image))}" alt="" />${p.credit ? `<span class="ab-credit">${esc(p.credit)}</span>` : ""}`;
      tw.push(`tl.fromTo("#${id}-img", { scale: 1.04 }, { scale: 1.14, duration: ${fmt(dur)}, ease: "none" }, ${at(0)});`);
      return { html, tweens: tw };
    }
  }
}

/** Background of a pane box by kind: light «studio» field for cards, dark for site/UI and photos. */
export function paneBackground(p: Pane): "light" | "dark" {
  return p.kind === "article" || p.kind === "logo" || p.kind === "number" || p.kind === "text" ? "light" : "dark";
}

export function paneCss(o: { font: string; k: number; marker?: string; accent?: string }): string {
  const k = o.k;
  const px = (n: number) => r1(n * k);
  const marker = o.marker ?? "#F8C8CC";
  const accent = o.accent ?? "#2F55D6";
  return `
      .ab-pane { position: absolute; display: block; overflow: hidden; }
      .ab-pane.light { background: radial-gradient(120% 90% at 50% 30%, #FFFFFF 0%, #EEF1F8 70%, #E3E8F4 100%); }
      .ab-pane.dark { background: radial-gradient(120% 90% at 50% 30%, #1B2547 0%, #0C1124 75%); }
      .ab-art-glow { position: absolute; display: block; border-radius: 50%; background: radial-gradient(closest-side, rgba(64,140,255,0.55), rgba(64,140,255,0)); }
      .ab-art { position: absolute; display: flex; flex-direction: column; gap: ${px(16)}px; padding: ${px(34)}px ${px(40)}px; border-radius: ${px(26)}px; background: #FFFFFF; box-shadow: 0 ${px(24)}px ${px(60)}px rgba(20,40,120,0.22), 0 0 0 1px rgba(0,0,0,0.05); overflow: hidden; color: #15181F; font-family: ${o.font}; }
      .ab-art-head { display: flex; align-items: baseline; justify-content: space-between; gap: ${px(20)}px; }
      .ab-art-pub { display: block; font-weight: 800; font-size: ${px(30)}px; letter-spacing: 0.02em; color: ${accent}; text-transform: uppercase; }
      .ab-art-date { display: block; font-weight: 500; font-size: ${px(26)}px; color: #6B7080; }
      .ab-art-title { display: block; font-weight: 800; line-height: 1.16; letter-spacing: -0.01em; }
      .ab-art-img { display: block; width: 100%; height: ${px(230)}px; border-radius: ${px(14)}px; object-fit: cover; filter: blur(${px(2.5)}px); }
      .ab-art-body { display: flex; flex-direction: column; gap: ${px(6)}px; font-weight: 500; line-height: 1.32; }
      .ab-art-l { position: relative; display: block; white-space: nowrap; }
      .blur { filter: blur(${px(4.2)}px); opacity: 0.8; }
      .ab-art-l.key { font-weight: 700; color: #0B0D12; }
      .ab-mark { position: absolute; left: ${px(-6)}px; top: 8%; bottom: 4%; width: 0%; display: block; border-radius: ${px(6)}px; background: ${marker}; }
      .ab-kt { position: relative; display: block; }
      .ab-art-src { display: block; font-weight: 600; font-size: ${px(24)}px; color: #6B7080; }
      .ab-site { position: absolute; display: block; overflow: hidden; border-radius: ${px(30)}px; background: #FFFFFF; box-shadow: 0 ${px(26)}px ${px(70)}px rgba(0,0,0,0.5), 0 0 0 ${px(2)}px rgba(255,255,255,0.65); }
      .ab-site.phone { border-radius: ${px(54)}px; box-shadow: 0 ${px(26)}px ${px(70)}px rgba(0,0,0,0.5), 0 0 0 ${px(12)}px #0B0B0F, 0 0 0 ${px(14)}px rgba(255,255,255,0.35); }
      .ab-bar { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; justify-content: center; gap: ${px(10)}px; background: #F2F2F4; border-bottom: 1px solid rgba(0,0,0,0.08); }
      .ab-site.phone .ab-bar { background: transparent; border: 0; }
      .ab-notch { display: block; width: 32%; height: ${px(18)}px; border-radius: ${px(10)}px; background: #0B0B0F; }
      .ab-lock { display: block; width: ${px(15)}px; height: ${px(17)}px; border-radius: ${px(4)}px; background: #8A8A92; }
      .ab-dom { display: block; font-family: ${o.font}; font-weight: 600; font-size: ${px(27)}px; color: #222228; }
      .ab-dom-tag { position: absolute; display: block; text-align: center; font-family: ${o.font}; font-weight: 700; font-size: ${px(30)}px; color: #FFFFFF; opacity: 0.85; }
      .ab-view { position: absolute; left: 0; right: 0; bottom: 0; display: block; overflow: hidden; }
      .ab-shot { position: absolute; left: 0; top: 0; display: block; }
      .ab-logo, .ab-num, .ab-text { position: absolute; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${px(22)}px; text-align: center; font-family: ${o.font}; color: #1E2A44; }
      .ab-logo-svg { display: block; }
      .ab-logo-name { display: block; font-weight: 800; letter-spacing: -0.02em; line-height: 1.05; }
      .ab-logo-lab { display: block; font-weight: 600; font-size: ${px(36)}px; color: #4A5470; }
      .ab-chip { display: block; padding: ${px(12)}px ${px(30)}px; border-radius: ${px(18)}px; background: ${accent}; color: #FFFFFF; font-weight: 800; font-size: ${px(64)}px; letter-spacing: -0.01em; box-shadow: 0 ${px(12)}px ${px(30)}px rgba(29,61,184,0.35); }
      .ab-num-v { display: block; font-weight: 800; letter-spacing: -0.03em; line-height: 1; color: ${accent}; white-space: nowrap; }
      .ab-num-l { display: block; font-weight: 800; font-size: ${px(56)}px; line-height: 1.1; color: #1E2A44; text-transform: uppercase; letter-spacing: 0.01em; }
      .ab-num-s { display: block; font-weight: 600; font-size: ${px(34)}px; color: #4A5470; }
      .ab-text-l { display: block; font-weight: 800; line-height: 1.08; letter-spacing: -0.015em; text-transform: uppercase; }
      .ab-text-l.acc { color: ${accent}; }
      .ab-photo { position: absolute; left: 0; top: 0; width: 100%; height: 100%; display: block; object-fit: cover; }
      .ab-credit { position: absolute; right: ${px(18)}px; bottom: ${px(16)}px; display: block; max-width: 70%; padding: ${px(5)}px ${px(11)}px; border-radius: ${px(9)}px; background: rgba(0,0,0,0.5); font-family: ${o.font}; font-size: ${px(17)}px; color: rgba(255,255,255,0.8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }`;
}
