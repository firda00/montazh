import { FONTS, fontStack, type FontId } from "./fonts.ts";
import { contrast, LAYOUTS_3D, type Design, type Scene } from "./design.ts";
import type { Script } from "./script.ts";
import type { SfxCue } from "../audio/sfx.ts";
import { FRAMES, type Frame } from "../lib/aspect.ts";

/**
 * Design + script (+ photos) → one HyperFrames composition. Every scene is a section on track 1 holding its
 * own layout; a background section on track 0 carries the palette and texture (and, only when the director
 * asks for it, a header with the brand and a progress line). Text boxes carry class "fit" with
 * data-maxw/data-maxh so fit.ts can shrink them in a real browser; `sizes` feeds the measured sizes back in.
 *
 * Anti-template rules live here too: photo-led layouts fill the whole frame (Ken Burns on the one timeline),
 * the text block is anchored top / centre / bottom as the director varies it, scenes arrive by hard cuts with
 * an occasional whip or zoom-through, and with a narrator the headline words appear when they are spoken
 * (word times from the voiceover, see alignWords). Every layout exists for 9:16, 16:9 (two columns: text
 * left, visual right) and 1:1. Pure and deterministic for the same inputs; all motion is on one paused GSAP
 * timeline and tweened nodes never carry a CSS transform.
 */

export const W = 1080;
export const H = 1920;
export const FPS = 30;
/** Reels/Shorts UI: keep text out of the top 150 px and the bottom ~330 px (the 9:16 frame) */
export const SAFE = FRAMES["9:16"].safe;

export interface SceneTiming {
  beat: number;
  start: number;
  duration: number;
}

/** A spoken word on the video timeline (seconds). */
export interface SpeechWord {
  text: string;
  start: number;
  end: number;
}
/** What the narrator says during one beat. */
export interface BeatSpeech {
  start: number;
  end: number;
  words: SpeechWord[];
}

export interface ComposeScenesOptions {
  /** beat → image path relative to the project (assets/img/scene_N.jpg) */
  images: Record<number, string>;
  fontFaces: string;
  gsapRel: string;
  /** measured font sizes by fit id (px); missing ids use the defaults */
  sizes?: Record<string, number>;
  /** voiceover captions (make --voice --voice-captions): short cues on their own track above the scenes */
  captions?: { start: number; end: number; text: string }[];
  /** the frame (default 9:16, 1080×1920) */
  frame?: Frame;
  /** per beat: the narration's word times — headline words appear as they are spoken */
  speech?: (BeatSpeech | null | undefined)[];
  /** stage 25: a talking presenter (circle with alpha, src relative to the project) in the bottom corner over every scene */
  presenter?: { src: string; box: { size: number; right: number; bottom: number } };
}

export interface ComposedScenes {
  html: string;
  duration: number;
  timings: SceneTiming[];
  fonts: FontId[];
  /** sound-effect cues matching the motion (src/audio/mix.ts plays them) */
  cues: SfxCue[];
}

/** a number short enough to roll as an odometer (1–9 digits) */
export const odoDigits = (v: string) => {
  const n = (v.match(/\d/g) ?? []).length;
  return n >= 1 && n <= 9;
};
/** number text → static characters + 0-9-0-9 digit strips (rolled by rollNumber in composeScenes) */
export function odoHtml(v: string, id: string): string {
  if (!odoDigits(v)) return esc(v);
  const strip = Array.from({ length: 20 }, (_, k) => `<span class="odd">${k % 10}</span>`).join("");
  return [...v].map((ch, q) => (/\d/.test(ch) ? `<span class="od"><span class="ods" id="${id}-od${q}">${strip}</span></span>` : `<span class="odc">${ch === " " ? "&nbsp;" : esc(ch)}</span>`)).join("");
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

// ---- speech → word times ----

const normWord = (w: string) => w.toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "");

/** Same word modulo inflection: equal, or a shared stem (Russian endings), digits must match exactly. */
function sameWord(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const n = Math.min(a.length, b.length);
  if (n < 3) return false;
  const stem = Math.min(5, Math.max(3, n - 2));
  return a.slice(0, stem) === b.slice(0, stem) && Math.abs(a.length - b.length) <= 4;
}

/**
 * When each on-screen word should appear: the time the narrator says it (greedy in-order match with stems),
 * words the narration does not contain are interpolated between their matched neighbours; with no match at
 * all the words spread over the first 70% of the speech. Monotonic, at least 50 ms apart.
 */
export function alignWords(words: string[], sp: BeatSpeech): { times: number[]; matched: boolean[] } {
  const sw = sp.words.map((w) => ({ n: normWord(w.text), t: w.start }));
  const raw: (number | null)[] = [];
  const matched: boolean[] = [];
  let j = 0;
  for (const w of words) {
    const n = normWord(w);
    let hit = -1;
    if (n.length >= 3 || /\d/.test(n)) {
      for (let q = j; q < sw.length && q < j + 14; q++) {
        if (sameWord(n, sw[q].n)) {
          hit = q;
          break;
        }
      }
    }
    if (hit >= 0) {
      raw.push(sw[hit].t);
      matched.push(true);
      j = hit + 1;
    } else {
      raw.push(null);
      matched.push(false);
    }
  }
  const s0 = sp.start;
  const s1 = Math.max(sp.start + 0.3, sp.end);
  const n = words.length;
  const times: number[] = new Array(n).fill(0);
  if (!matched.some(Boolean)) {
    for (let i = 0; i < n; i++) times[i] = s0 + ((s1 - s0) * 0.7 * i) / Math.max(1, n);
  } else {
    for (let i = 0; i < n; i++) {
      if (raw[i] !== null) {
        times[i] = raw[i]!;
        continue;
      }
      let p = i - 1;
      while (p >= 0 && raw[p] === null) p--;
      let q = i + 1;
      while (q < n && raw[q] === null) q++;
      const pt = p >= 0 ? raw[p]! : s0;
      const pi = p >= 0 ? p : -1;
      // after the last match: keep a speaking pace (~0.3 s a word) inside the speech
      const qt = q < n ? raw[q]! : Math.min(s1, pt + 0.3 * (n - pi));
      const qi = q < n ? q : n;
      times[i] = pt + ((qt - pt) * (i - pi)) / Math.max(1, qi - pi);
    }
  }
  for (let i = 1; i < n; i++) times[i] = Math.max(times[i], times[i - 1] + 0.05);
  return { times: times.map(r3), matched };
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

/**
 * A big number over a headline that repeats it ("$7500 за тонну" above "Арабика: $7500 за тонну") says the
 * same thing twice: the headline keeps only the rest ("Арабика").
 */
export function dropRepeatedNumber(scene: Scene): Scene {
  if (!scene.number || !["hero_number", "media_number", "tunnel_number"].includes(scene.layout)) return scene;
  const v = scene.number.value.trim();
  const h = scene.headline;
  const at = v ? h.indexOf(v) : -1;
  if (at < 0) return scene;
  let end = at + v.length;
  const unit = scene.number.unit.trim().toLowerCase();
  const rest = h.slice(end);
  if (unit && rest.trimStart().toLowerCase().startsWith(unit)) end = h.length - rest.trimStart().length + unit.length;
  const before = h.slice(0, at).replace(/[\s:—–-]+$/, "");
  // the unit may be spelled out in the headline ("₽" ↔ "рублей", "%" ↔ "процентов")
  const after = h
    .slice(end)
    .replace(/^\s*(рубл\p{L}*|руб\.?|доллар\p{L}*|евро|цент\p{L}*|процент\p{L}*|dollars?|cents?|percent|euros?)(?![\p{L}])/iu, "")
    .replace(/^[\s,:—–-]+/, "");
  const out = `${before} ${after}`.replace(/\s+/g, " ").replace(/[\s:—–,-]+$/, "").trim();
  if (!/\p{L}{2,}/u.test(out)) return scene;
  return { ...scene, headline: out };
}

/** per-word motion for each entrance: from → to, duration, ease */
const ENTER: Record<Scene["entrance"], { from: string; to: string; d: number; ease: string }> = {
  rise: { from: "opacity: 0, y: 34", to: "opacity: 1, y: 0", d: 0.34, ease: "power3.out" },
  mask: { from: "yPercent: 110", to: "yPercent: 0", d: 0.38, ease: "power4.out" },
  pop: { from: "opacity: 0, scale: 0.5", to: "opacity: 1, scale: 1", d: 0.32, ease: "back.out(2)" },
  type: { from: "opacity: 0", to: "opacity: 1", d: 0.06, ease: "none" },
  slide: { from: "opacity: 0, x: -40", to: "opacity: 1, x: 0", d: 0.32, ease: "power3.out" },
};

export function composeScenes(script: Script, design: Design, o: ComposeScenesOptions): ComposedScenes {
  const F = o.frame ?? FRAMES["9:16"];
  // with a presenter in the bottom corner every text block lives above it (photos still fill the frame)
  const S = o.presenter ? { ...F.safe, bottom: Math.min(F.safe.bottom, F.h - o.presenter.box.bottom - o.presenter.box.size - Math.round(Math.min(F.w, F.h) * 0.03)) } : F.safe;
  const LS = F.w > F.h;
  const SQ = F.w === F.h;
  const k = Math.min(F.w, F.h) / 1080;
  const px = (n: number) => Math.round(n * k);
  const CY = Math.round((S.top + S.bottom) / 2);
  const textW = F.w - 2 * S.x;
  /** landscape two-column grid: text column on the left, visual column on the right */
  const colW = Math.round(textW * 0.48);
  const visX = S.x + colW + 64;
  const visW = F.w - S.x - visX;
  const bandTop = S.top + 30;
  const bandH = S.bottom - bandTop;

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
  const header = I.chrome === "header";
  const tw: string[] = [];
  const sections: string[] = [];
  const cues: SfxCue[] = [];
  const size = (id: string, def: number) => r1(sizes[id] ?? px(def));
  const fitAttrs = (id: string, maxw: number, maxh: number, min: number) => `data-fit="${id}" data-maxw="${Math.round(maxw)}" data-maxh="${Math.round(maxh)}" data-min="${px(min)}"`;

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

  /** clamps a time into a scene (words must be on screen a little before the cut) */
  const inScene = (t: SceneTiming, x: number) => Math.min(Math.max(x, t.start + 0.04), t.start + Math.max(0.3, t.duration - 0.45));

  /**
   * Entrance tweens for the words of a headline. With a narrator each word appears when it is spoken;
   * otherwise the words follow each other with a short stagger. Returns when the last word lands.
   */
  const enter = (scene: Scene, id: string, at: number, i: number): number => {
    const toks = tokenize(scene);
    const n = toks.length;
    const t = timings[i];
    const e = ENTER[scene.entrance] ?? ENTER.rise;
    const sp = o.speech?.[i];
    let wordAt: number[];
    if (sp && sp.words.length) {
      wordAt = capTimes(alignWords(toks.map((x) => x.word), sp).times.map((x) => r3(inScene(t, Math.max(at - 0.1, x - 0.06)))), t.start + Math.min(2.2, 0.45 * t.duration), at);
      // never an empty frame after the cut: the first word lands on the cut even if it is said later
      if (wordAt.length && wordAt[0] > at + 0.25) wordAt[0] = r3(at + 0.1);
      toks.forEach((_, w) => tw.push(`tl.fromTo("#${id}-w${w}", { ${e.from} }, { ${e.to}, duration: ${e.d}, ease: "${e.ease}" }, ${fmt(wordAt[w])});`));
    } else {
      const stagger = scene.entrance === "type" ? Math.min(0.14, 1.4 / Math.max(1, n)) : Math.min(0.06, 0.6 / Math.max(1, n));
      const sel = Array.from({ length: n }, (_, w) => `#${id}-w${w}`).join(", ");
      tw.push(`tl.fromTo("${sel}", { ${e.from} }, { ${e.to}, duration: ${scene.entrance === "type" ? 0.08 : e.d + 0.16}, ease: "${e.ease}", stagger: ${r3(stagger)} }, ${fmt(at)});`);
      wordAt = toks.map((_, w) => r3(at + w * stagger));
    }
    // accents land with their words: marker swipe
    scene.accents.forEach((a, ai) => {
      if (a.style !== "marker") return;
      const first = toks.findIndex((x) => x.accent === ai);
      const ta = r3((first >= 0 ? wordAt[first] : at) + 0.22);
      cues.push({ t: ta, kind: "swipe" });
      tw.push(`tl.fromTo("#${id}-a${ai}", { backgroundSize: "0% 78%" }, { backgroundSize: "100% 78%", duration: 0.4, ease: "power2.inOut" }, ${fmt(ta)});`);
    });
    return wordAt.length ? wordAt[wordAt.length - 1] + 0.3 : at;
  };

  /** item k of n appears: with a narrator when its first words are spoken (after the headline), else on a beat grid */
  const itemTimes = (i: number, items: string[], from: number, step: number): number[] => {
    const t = timings[i];
    const sp = o.speech?.[i];
    if (!sp || !sp.words.length) return items.map((_, k) => r3(from + k * step));
    const after = sp.words.filter((w) => w.start >= from - 0.2);
    const pool: BeatSpeech = { start: Math.max(from, sp.start), end: Math.max(from + 0.5, sp.end), words: after };
    const lo = Math.max(from, sp.start);
    const hi = Math.max(lo + 0.4, Math.min(sp.end, t.start + t.duration - 0.6));
    const times = items.map((it, k) => {
      const al = alignWords(it.split(/\s+/).filter(Boolean), pool);
      const hit = al.matched.findIndex(Boolean);
      const even = lo + ((hi - lo) * k) / Math.max(1, items.length);
      return r3(inScene(t, hit >= 0 ? Math.max(even - 0.3, al.times[hit] - 0.08) : even));
    });
    for (let k = 1; k < times.length; k++) if (times[k] < times[k - 1] + 0.25) times[k] = r3(times[k - 1] + 0.25);
    return capTimes(times, t.start + Math.max(0.45 * t.duration, Math.min(t.duration - 0.8, from - t.start + 1.0)), from);
  };

  /**
   * Readability over strict sync: when the narrator says the last words late in the beat, the reveal is
   * compressed so the whole line is on screen by `deadline` (a viewer needs time to read it complete).
   */
  function capTimes(times: number[], deadline: number, lo = 0): number[] {
    if (!times.length) return times;
    const first = times[0];
    const last = times[times.length - 1];
    if (last <= deadline) return times;
    // the reveal may start earlier than the speech says when even its first word comes too late
    const f2 = Math.min(first, Math.max(lo, deadline - 0.6));
    if (last - first < 1e-6) return times.map((_, k) => r3(f2 + ((deadline - f2) * k) / Math.max(1, times.length - 1)));
    return times.map((x) => r3(f2 + ((x - first) * (deadline - f2)) / (last - first)));
  }

  const kicker = (text: string, id: string, extraCls = "") => (text ? `<span class="kick${extraCls}" id="${id}">${esc(text)}</span>` : "");
  const counter = (i: number) => (header ? `<span class="ctr" id="sc${i}-ctr">${String(i + 1).padStart(2, "0")} / ${String(script.beats.length).padStart(2, "0")}</span>` : "");
  /** an anchored text block: top / centre / bottom of the band [top, bottom] */
  const block = (anchor: Scene["anchor"], x: number, w: number, align: "left" | "center", inner: string[], b: { top?: number; bottom?: number; gap?: number; cls?: string } = {}) =>
    `<div class="blk a-${anchor} al-${align}${b.cls ? ` ${b.cls}` : ""}" style="left:${Math.round(x)}px;width:${Math.round(w)}px;top:${Math.round(b.top ?? bandTop)}px;bottom:${Math.round(F.h - (b.bottom ?? S.bottom))}px${b.gap !== undefined ? `;gap:${b.gap}px` : ""}">${inner.filter(Boolean).join("")}</div>`;
  /** headline group + a dense part (items, chat, cards): anchored together, or spread top/bottom for a "top" anchor on tall frames */
  const split2 = (anchor: Scene["anchor"], head: string[], tail: string) =>
    anchor === "top" && !SQ && !LS
      ? `<div class="blk spread al-left" style="left:${S.x}px;width:${textW}px;top:${bandTop}px;bottom:${F.h - S.bottom}px"><div class="grp">${head.filter(Boolean).join("")}</div><div class="grp">${tail}</div></div>`
      : block(anchor, S.x, textW, "left", [...head, tail]);
  const numEl = (id: string, n: { value: string; unit: string }, def: number, maxw: number, maxh: number, cls = "") =>
    `<div class="num${cls}" id="${id}-num" style="font-size:${size(`${id}-num`, def)}px" ${fitAttrs(`${id}-num`, maxw, maxh, 110)}><span class="num-v${odoDigits(n.value) ? " odo" : ""}">${odoHtml(n.value, `${id}-num`)}</span>${n.unit ? `<span class="num-u">${esc(n.unit)}</span>` : ""}</div>`;
  /** the digit strips of a number roll in, right-most digits spinning longest; returns when the number lands */
  const rollNumber = (id: string, value: string, at: number): number => {
    const ds = [...value].map((ch, q) => ({ ch, q })).filter((x) => /\d/.test(x.ch));
    if (!odoDigits(value)) return at;
    let land = at;
    ds.forEach((d, k) => {
      const dur = r3(0.75 + (ds.length - k) * 0.11);
      land = Math.max(land, at + k * 0.04 + dur);
      tw.push(`tl.fromTo("#${id}-num-od${d.q}", { yPercent: 0 }, { yPercent: ${-(10 + Number(d.ch)) * 5}, duration: ${dur}, ease: "power3.out" }, ${fmt(at + k * 0.04)});`);
    });
    for (let q = 0; q < Math.min(4, ds.length + 1); q++) cues.push({ t: r3(at + 0.08 + q * 0.12), kind: "tick", gain: -6 });
    return r3(land);
  };
  const subEl = (scene: Scene, id: string, cls = "") => (scene.sub ? `<span class="sub${cls}" id="${id}-sub">${esc(scene.sub)}</span>` : "");
  /** a scrim that makes text legible over a photo, dark where the text sits */
  const scrim = (id: string, anchor: Scene["anchor"], side: "v" | "left", dim = 0) => {
    const g =
      side === "left"
        ? `linear-gradient(to right, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.55) 38%, rgba(0,0,0,0) 72%)`
        : anchor === "top"
          ? `linear-gradient(to bottom, rgba(0,0,0,0.74) 0%, rgba(0,0,0,0.42) 34%, rgba(0,0,0,0) 62%)`
          : anchor === "bottom"
            ? `linear-gradient(to top, rgba(0,0,0,0.8) 0%, rgba(0,0,0,0.5) ${SQ || LS ? 40 : 30}%, rgba(0,0,0,0) ${SQ || LS ? 70 : 58}%)`
            : `radial-gradient(90% 60% at 50% 50%, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.2) 100%)`;
    return `<span class="scrim" id="${id}-scrim" style="background:${dim ? `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), ` : ""}${g}"></span>`;
  };

  design.scenes.forEach((given, i) => {
    const scene = dropRepeatedNumber(given);
    const t = timings[i];
    const id = `sc${i}`;
    const hook = i === 0;
    const img = o.images[i];
    const body: string[] = [];
    const at = r3(t.start + 0.1);
    let layout = scene.layout;
    if (layout === "media_number" && !img) layout = scene.number ? "hero_number" : "headline";
    if (layout.startsWith("media_") && !img) layout = "headline";
    // the presenter sits in the bottom corner: text blocks that would sit there move to the top
    const anchor = o.presenter && scene.anchor === "bottom" ? "top" : scene.anchor;
    const photo = `<span class="ph full" id="${id}-ph"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`;

    const headline = (cls: string, def: number, maxw: number, maxh: number, min: number, align: "left" | "center") =>
      `<div class="hl ${cls}" style="font-size:${size(`${id}-hl`, def)}px;width:${Math.round(maxw)}px;text-align:${align}" ${fitAttrs(`${id}-hl`, maxw, maxh, min)} id="${id}-hl">${words(scene, `${id}-hl`, scene.entrance)}</div>`;

    switch (layout) {
      case "statement": {
        // one line set huge on a full accent field: the turn or the conclusion
        const w = LS ? Math.min(1560, textW) : textW;
        body.push(`<span class="fill" id="${id}-fill"></span>`);
        // a soft light band sweeps over the colour field: a held statement is never a flat card
        body.push(`<span class="sweep" id="${id}-sweep"></span>`);
        tw.push(`tl.fromTo("#${id}-sweep", { backgroundPosition: "130% 0%" }, { backgroundPosition: "-30% 0%", duration: ${fmt(Math.max(1, t.duration))}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        body.push(block(anchor, S.x, w, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-stmt", LS ? 156 : SQ ? 128 : hook ? 168 : 150, w, LS ? 700 : SQ ? 760 : bandH * 0.8, 60, "left"), subEl(scene, id)]));
        tw.push(`tl.fromTo("#${id}-fill", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.32, ease: "power3.inOut" }, ${fmt(t.start)});`);
        cues.push({ t: t.start, kind: "swipe", gain: -2 });
        enter(scene, `${id}-hl`, at + 0.2, i);
        break;
      }
      case "hero_number": {
        const n = scene.number!;
        if (LS) {
          const w = Math.min(1500, textW);
          body.push(block(anchor, S.x, w, "left", [kicker(scene.kicker, `${id}-k`), numEl(id, n, 400, w, 420), headline("hl-hero", 92, Math.min(1300, w), 300, 44, "left"), subEl(scene, id)]));
        } else if (anchor === "top" && !SQ) {
          // the number holds the top of the frame, the statement the bottom: the whole height is composed
          body.push(block("top", S.x, textW, "left", [kicker(scene.kicker, `${id}-k`), numEl(id, n, 420, textW, 480)]));
          body.push(block("bottom", S.x, textW, "left", [headline("hl-hero", 104, textW, 560, 44, "left"), subEl(scene, id)], { top: bandTop + 560 }));
        } else {
          const al = anchor === "center" ? "center" : "left";
          body.push(block(anchor, S.x, textW, al, [kicker(scene.kicker, `${id}-k`), numEl(id, n, SQ ? 300 : 400, textW, SQ ? 340 : 480), headline("hl-hero", SQ ? 80 : 100, textW, SQ ? 360 : 520, 44, al), subEl(scene, id)]));
        }
        body.unshift(`<span class="ghost" id="${id}-ghost" style="font-size:${px(LS ? 760 : SQ ? 640 : 820)}px;top:${Math.round(anchor === "top" ? CY : bandTop - px(60))}px">${esc(n.value)}${esc(n.unit)}</span>`);
        tw.push(`tl.fromTo("#${id}-ghost", { x: ${px(160)}, opacity: 0 }, { x: ${-px(340)}, opacity: 1, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        // visible on the cut frame already (no empty frame after a hard cut), the digits are still spinning
        tw.push(`tl.fromTo("#${id}-num", { opacity: 0.35, scale: 0.7 }, { opacity: 1, scale: 1, duration: 0.6, ease: "expo.out" }, ${fmt(t.start)});`);
        const landed = rollNumber(id, n.value, t.start + 0.08);
        if (landed > t.start + 0.6) tw.push(`tl.fromTo("#${id}-num", { scale: 1.07 }, { scale: 1, duration: 0.3, ease: "back.out(3)", immediateRender: false }, ${fmt(landed - 0.05)});`);
        cues.push({ t: t.start + 0.04, kind: "impact" });
        enter(scene, `${id}-hl`, t.start + 0.4, i);
        break;
      }
      case "media_full": {
        body.push(photo);
        if (LS) {
          body.push(scrim(id, anchor, "left"));
          const w = Math.min(1080, Math.round(textW * 0.62));
          body.push(block(anchor, S.x, w, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-media", hook ? 112 : 96, w, 560, 46, "left"), subEl(scene, id)], { cls: "onphoto" }));
        } else {
          body.push(scrim(id, anchor, "v"));
          body.push(block(anchor, S.x, textW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-media", hook ? 122 : 104, textW, SQ ? 420 : 640, 46, "left"), subEl(scene, id)], { cls: "onphoto" }));
        }
        enter(scene, `${id}-hl`, at + 0.12, i);
        break;
      }
      case "media_number": {
        const n = scene.number!;
        body.push(photo);
        body.push(scrim(id, anchor, LS ? "left" : "v", 0.22));
        const w = LS ? Math.min(1100, Math.round(textW * 0.64)) : textW;
        body.push(block(anchor, S.x, w, "left", [kicker(scene.kicker, `${id}-k`), numEl(id, n, LS ? 280 : SQ ? 260 : 330, w, LS ? 380 : SQ ? 300 : 420), headline("hl-mnum", LS ? 84 : SQ ? 76 : 92, w, LS ? 340 : SQ ? 300 : 460, 42, "left"), subEl(scene, id)], { cls: "onphoto" }));
        tw.push(`tl.fromTo("#${id}-num", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.55, ease: "expo.out" }, ${fmt(t.start + 0.08)});`);
        rollNumber(id, n.value, t.start + 0.12);
        cues.push({ t: t.start + 0.08, kind: "impact", gain: -2 });
        enter(scene, `${id}-hl`, t.start + 0.4, i);
        break;
      }
      case "media_card": {
        if (LS) {
          body.push(`<span class="ph card" id="${id}-ph" style="left:${visX}px;top:${S.top}px;width:${visW}px;height:${S.bottom - S.top}px"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
          body.push(block(anchor, S.x, colW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-card", hook ? 104 : 92, colW, 640, 44, "left"), subEl(scene, id)]));
        } else {
          const cardH = SQ ? 520 : 900;
          const textTop = anchor === "top";
          const cardTop = textTop ? (SQ ? 440 : 660) : SQ ? S.top : 200;
          body.push(`<span class="ph card" id="${id}-ph" style="left:${S.x + (SQ ? 0 : 38)}px;top:${cardTop}px;width:${textW - (SQ ? 0 : 76)}px;height:${cardH}px"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
          const band = textTop ? { top: bandTop, bottom: cardTop - 40 } : { top: cardTop + cardH + 50, bottom: S.bottom };
          body.push(block(textTop ? "bottom" : "top", S.x, textW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-card", hook ? 104 : 92, textW, band.bottom - band.top - 10, 42, "left")], band));
        }
        tw.push(`tl.fromTo("#${id}-ph", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.6, ease: "expo.out" }, ${fmt(t.start)});`);
        enter(scene, `${id}-hl`, at + 0.25, i);
        break;
      }
      case "media_split": {
        if (LS) {
          const x0 = Math.round(F.w * 0.5);
          body.push(`<span class="ph" id="${id}-ph" style="left:${x0}px;top:0;width:${F.w - x0}px;height:${F.h}px"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
          body.push(`<span class="splitline v" id="${id}-line" style="left:${x0 - 4}px;top:0;width:8px;height:${F.h}px"></span>`);
          body.push(block(anchor, S.x, x0 - S.x - 70, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-split", 92, x0 - S.x - 70, 640, 42, "left"), subEl(scene, id)]));
          tw.push(`tl.fromTo("#${id}-ph", { clipPath: "inset(0% 0% 0% 100%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.6, ease: "power4.out" }, ${fmt(t.start)});`);
          tw.push(`tl.fromTo("#${id}-line", { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: "power3.inOut" }, ${fmt(t.start + 0.2)});`);
        } else {
          // text on top → the photo fills the lower part (under the phone UI too); otherwise the photo is on top
          const textTop = anchor === "top";
          const splitY = Math.round(F.h * (textTop ? (SQ ? 0.5 : 0.44) : SQ ? 0.5 : 0.54));
          const ph = textTop ? `left:0;top:${splitY}px;width:${F.w}px;height:${F.h - splitY}px` : `left:0;top:0;width:${F.w}px;height:${splitY}px`;
          body.push(`<span class="ph" id="${id}-ph" style="${ph}"><img class="img" id="${id}-img" src="${img}" alt="" /></span>`);
          body.push(`<span class="splitline" id="${id}-line" style="left:0;top:${splitY - 4}px;width:${F.w}px;height:8px"></span>`);
          const band = textTop ? { top: bandTop, bottom: splitY - 40 } : { top: splitY + 44, bottom: S.bottom };
          body.push(block(textTop ? "bottom" : anchor === "bottom" ? "bottom" : "center", S.x, textW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-split", SQ ? 80 : 96, textW, band.bottom - band.top - 10, 42, "left")], band));
          tw.push(`tl.fromTo("#${id}-ph", { clipPath: "${textTop ? "inset(100% 0% 0% 0%)" : "inset(0% 0% 100% 0%)"}" }, { clipPath: "inset(0% 0% 0% 0%)", duration: 0.6, ease: "power4.out" }, ${fmt(t.start)});`);
          tw.push(`tl.fromTo("#${id}-line", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power3.inOut" }, ${fmt(t.start + 0.2)});`);
        }
        enter(scene, `${id}-hl`, at + 0.3, i);
        break;
      }
      case "list": {
        const itemW = LS ? visW : textW;
        const its = scene.items.map((it, k2) => `<div class="item" id="${id}-it${k2}"><span class="badge">${String(k2 + 1).padStart(2, "0")}</span><span class="itext" style="font-size:${size(`${id}-it${k2}`, LS ? 72 : 64)}px" ${fitAttrs(`${id}-it${k2}`, itemW - px(150), SQ ? 110 : 170, 32)}>${esc(it)}</span></div>`);
        if (LS) {
          body.push(block("center", S.x, colW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-list", 100, colW, 640, 44, "left")]));
          body.push(block("center", visX, visW, "left", [`<div class="items" id="${id}-items">${its.join("")}</div>`]));
        } else {
          body.push(split2(anchor, [kicker(scene.kicker, `${id}-k`), headline("hl-list", SQ ? 80 : 104, textW, SQ ? 260 : 420, 44, "left")], `<div class="items" id="${id}-items">${its.join("")}</div>`));
        }
        const hlEnd = enter(scene, `${id}-hl`, at, i);
        const times = itemTimes(i, scene.items, Math.max(at + 0.6, hlEnd), Math.min(0.55, (t.duration - 1.6) / Math.max(1, scene.items.length)));
        times.forEach((x, k2) => {
          tw.push(`tl.fromTo("#${id}-it${k2}", { opacity: 0, x: -50 }, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }, ${fmt(x)});`);
          cues.push({ t: x, kind: "tick" });
        });
        break;
      }
      case "chat": {
        const bw = LS ? Math.round(visW * 0.86) : px(780);
        const bubs = scene.items.map((m, k2) => `<div class="bub ${k2 % 2 ? "r" : "l"}" id="${id}-b${k2}" style="max-width:${bw + 70}px"><span class="btext" style="font-size:${size(`${id}-b${k2}`, LS ? 62 : 58)}px" ${fitAttrs(`${id}-b${k2}`, bw, SQ ? 200 : 280, 30)}>${esc(m)}</span></div>`);
        if (LS) {
          body.push(block("center", S.x, colW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-chat", 100, colW, 640, 44, "left")]));
          body.push(block("center", visX, visW, "left", [`<div class="chat" id="${id}-chat">${bubs.join("")}</div>`]));
        } else {
          body.push(split2(anchor, [kicker(scene.kicker, `${id}-k`), headline("hl-chat", SQ ? 80 : 104, textW, SQ ? 240 : 400, 44, "left")], `<div class="chat" id="${id}-chat">${bubs.join("")}</div>`));
        }
        const hlEnd = enter(scene, `${id}-hl`, at, i);
        const times = itemTimes(i, scene.items, Math.max(at + 0.5, hlEnd), Math.min(0.75, (t.duration - 1.6) / Math.max(1, scene.items.length)));
        times.forEach((x, k2) => {
          tw.push(`tl.fromTo("#${id}-b${k2}", { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, ${fmt(x)});`);
          cues.push({ t: x, kind: "pop" });
        });
        break;
      }
      case "timeline": {
        const pts = scene.items;
        const y = 150;
        const x0 = 40;
        const x1 = textW - 40;
        const marks: string[] = [`<span class="track" id="${id}-track" style="top:${y}px;left:${x0}px;width:${x1 - x0}px"></span>`];
        pts.forEach((label, k2) => {
          const x = x0 + ((x1 - x0) * k2) / Math.max(1, pts.length - 1);
          const above = k2 % 2 === 0;
          marks.push(`<span class="dot" id="${id}-d${k2}" style="left:${r1(x - 16)}px;top:${y - 14}px"></span>`);
          marks.push(`<span class="tlab ${above ? "up" : "down"}" id="${id}-l${k2}" style="left:${r1(x - 110)}px;top:${above ? y - 120 : y + 52}px">${esc(label)}</span>`);
        });
        body.push(split2(anchor, [kicker(scene.kicker, `${id}-k`), headline("hl-tl", LS ? 100 : SQ ? 84 : 112, LS ? Math.min(1500, textW) : textW, LS || SQ ? 300 : 460, 44, "left")], `<div class="tlwrap" id="${id}-tlw">${marks.join("")}</div>`));
        const hlEnd = enter(scene, `${id}-hl`, at, i);
        const times = itemTimes(i, pts, Math.max(at + 0.7, hlEnd), Math.min(0.45, (t.duration - 1.8) / Math.max(1, pts.length)));
        times.forEach((x, k2) => {
          tw.push(`tl.fromTo("#${id}-d${k2}, #${id}-l${k2}", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.35, ease: "back.out(2)" }, ${fmt(x)});`);
          cues.push({ t: x, kind: "tick" });
        });
        tw.push(`tl.fromTo("#${id}-track", { scaleX: 0 }, { scaleX: 1, duration: ${fmt(Math.max(0.6, Math.min(1.6, (times.at(-1) ?? at + 1) - (at + 0.5) + 0.3)))}, ease: "power2.inOut" }, ${fmt(at + 0.5)});`);
        break;
      }
      case "compare": {
        const [la, va, lb, vb] = scene.items;
        const cmpW = LS ? visW : textW;
        const cw = (cmpW - 40) / 2;
        const cmp = `<div class="cmp" id="${id}-cmp"><div class="cc a" id="${id}-ca" style="width:${r1(cw)}px"><span class="cl">${esc(la)}</span><span class="cv" style="font-size:${size(`${id}-va`, 120)}px" ${fitAttrs(`${id}-va`, cw - 60, 200, 44)}>${esc(va)}</span></div><div class="cc b" id="${id}-cb" style="width:${r1(cw)}px"><span class="cl">${esc(lb)}</span><span class="cv" style="font-size:${size(`${id}-vb`, 120)}px" ${fitAttrs(`${id}-vb`, cw - 60, 200, 44)}>${esc(vb)}</span></div></div>`;
        if (LS) {
          body.push(block("center", S.x, colW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-cmp", 100, colW, 640, 44, "left")]));
          body.push(block("center", visX, visW, "left", [cmp]));
        } else {
          body.push(split2(anchor, [kicker(scene.kicker, `${id}-k`), headline("hl-cmp", SQ ? 80 : 104, textW, SQ ? 260 : 440, 44, "left")], cmp));
        }
        const hlEnd = enter(scene, `${id}-hl`, at, i);
        const times = itemTimes(i, [`${la} ${va}`, `${lb} ${vb}`], Math.max(at + 0.5, hlEnd), 0.35);
        tw.push(`tl.fromTo("#${id}-ca", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(times[0])});`);
        tw.push(`tl.fromTo("#${id}-cb", { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(times[1])});`);
        cues.push({ t: times[0], kind: "pop" }, { t: times[1], kind: "pop", gain: 2 });
        break;
      }
      case "quote": {
        const w = LS ? Math.min(1400, textW) : SQ ? textW : 920;
        body.push(block(anchor === "top" ? "top" : "center", (F.w - w) / 2, w, "center", [`<span class="qmark" id="${id}-q">“</span>`, headline("hl-quote", LS ? 96 : SQ ? 88 : 108, w, LS ? 560 : SQ ? 560 : 820, 46, "center"), `<span class="rule" id="${id}-rule"></span>`, subEl(scene, id, " mono")]));
        tw.push(`tl.fromTo("#${id}-q", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fmt(t.start)});`);
        const end = enter(scene, `${id}-hl`, at + 0.15, i);
        tw.push(`tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.5, ease: "power2.inOut" }, ${fmt(Math.min(end, t.start + t.duration - 0.6))});`);
        break;
      }
      case "orbit_title": {
        // a giant title on a plane at z = 0 inside one preserve-3d world; a tilted ring of cubes spins around it,
        // so the browser depth-sorts the cubes in front of / behind the letters. Geometry is fixed here (seeded).
        const rnd = seeded(`orbit:${i}:${scene.headline}`);
        const colors = [P.accent, P.accent, P.accent2, mixHex(P.accent, P.accent2, 0.5), hueShift(P.accent, 22), hueShift(P.accent2, -18), mixHex(P.accent, "#FFFFFF", 0.55), mixHex(P.accent, P.bg, 0.45)];
        const N = 32;
        const cubes: string[] = [];
        const order = Array.from({ length: N }, (_, q) => q).sort((a, b) => ((a * 7) % N) - ((b * 7) % N));
        const R0 = LS || SQ ? 430 : 455;
        for (let q = 0; q < N; q++) {
          const th = (2 * Math.PI * q) / N + (rnd() - 0.5) * 0.12;
          const R = R0 + (rnd() - 0.5) * 50;
          const s = Math.round(30 + rnd() * 34);
          const lift = r1((rnd() - 0.5) * 70);
          const c = colors[Math.floor(rnd() * colors.length)];
          const [ax, ay] = [Math.round(rnd() * 360), Math.round(rnd() * 360)];
          const [dx, dy] = [Math.round(80 + rnd() * 140) * (rnd() < 0.5 ? -1 : 1), Math.round(90 + rnd() * 160)];
          cubes.push(`<span class="bk" style="left:${-s / 2}px;top:${-s / 2}px;width:${s}px;height:${s}px;transform:translate3d(${r1(R * Math.cos(th))}px, ${r1(R * Math.sin(th))}px, ${lift}px)"><span class="cube" id="${id}-cb${q}"><span class="cube" id="${id}-cr${q}">${cubeFaces(s, c)}</span></span></span>`);
          const inAt = t.start + 0.05 + order.indexOf(q) * 0.022;
          tw.push(`tl.fromTo("#${id}-cb${q}", { scale: 0 }, { scale: 1, duration: 0.55, ease: "back.out(2.2)" }, ${fmt(inAt)});`);
          tw.push(`tl.fromTo("#${id}-cr${q}", { rotationX: ${ax}, rotationY: ${ay} }, { rotationX: ${ax + dx}, rotationY: ${ay + dy}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        }
        const cap = scene.kicker || scene.sub;
        body.push(`<span class="otglow" id="${id}-glow"></span>`);
        body.push(`<div class="st3" id="${id}-st"><div class="w3" id="${id}-w3">`);
        body.push(`<div class="otcol" id="${id}-col">`);
        // the title fits inside the ring (inner diameter ≈ 840 px) so side cubes never cover the outer letters
        body.push(headline("hl-orbit", hook ? 176 : 160, LS ? 860 : 840, LS || SQ ? 420 : 560, 60, "center"));
        body.push(`</div>`);
        body.push(`<div class="ring"><div class="spin" id="${id}-spin"><div class="spin" id="${id}-spin2">${cubes.join("")}</div></div></div>`);
        body.push(`</div></div>`);
        // rule + caption sit flat below the ring's front arc, never hidden by a passing cube
        body.push(`<div class="col center" style="top:${CY + Math.min(400, S.bottom - CY - 70)}px;gap:26px"><span class="rule" id="${id}-rule"></span>${cap ? `<span class="otcap" id="${id}-cap">${esc(cap)}</span>` : ""}</div>`);
        tw.push(`tl.fromTo("#${id}-spin2", { rotation: -150 }, { rotation: 0, duration: 1.5, ease: "expo.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-spin", { rotation: 0 }, { rotation: ${fmt(Math.min(70, 16 * t.duration))}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-w3", { rotationY: -10, rotationX: 3, z: -140 }, { rotationY: 8, rotationX: -4, z: 0, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-glow", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 1.2, ease: "power2.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-rule", { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.inOut" }, ${fmt(at + 0.9)});`);
        if (cap) tw.push(`tl.fromTo("#${id}-cap", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" }, ${fmt(at + 1.05)});`);
        enter(scene, `${id}-hl`, at + 0.3, i);
        cues.push({ t: t.start, kind: "riser", gain: -2 }, { t: t.start + 1.2, kind: "impact", gain: -4 });
        break;
      }
      case "depth_cards": {
        // 3–4 cards hang at different depths; the camera dollies and tilts through them and each card in turn
        // comes forward (z), lights up in the accent and dims back when the next one takes over.
        const n = scene.items.length;
        const cardH = LS ? (n >= 4 ? 150 : 176) : SQ ? (n >= 4 ? 118 : 140) : n >= 4 ? 176 : 206;
        const gapY = LS ? 28 : SQ ? 22 : n >= 4 ? 34 : 46;
        const total = n * cardH + (n - 1) * gapY;
        const cw = LS ? visW - 40 : SQ ? textW - 60 : 800;
        const cx = LS ? visX + 20 : (F.w - cw) / 2;
        const Y0 = LS ? S.top : SQ ? S.top + 300 : 700;
        const top0 = Y0 + Math.max(0, (S.bottom - 30 - Y0 - total) / 2);
        const depth = [0, -130, -50, -170];
        if (LS) body.push(block(anchor, S.x, colW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-dc", 92, colW, 640, 44, "left")]));
        else body.push(block("top", S.x, textW, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-dc", SQ ? 76 : 96, textW, SQ ? 220 : 340, 44, "left")], { top: S.top + (SQ ? 10 : 90), bottom: Y0 - 20 }));
        body.push(`<div class="st3 dcst" id="${id}-st" style="perspective-origin:${Math.round(cx + cw / 2)}px ${Math.round(top0 + total / 2)}px"><div class="w3 dccam" id="${id}-cam" style="transform-origin:${Math.round(cx + cw / 2)}px ${Math.round(top0 + total / 2 + 100)}px">`);
        const step = Math.min(0.95, (t.duration - 1.7) / Math.max(1, n));
        const hlEnd = enter(scene, `${id}-hl`, at, i);
        const onTimes = itemTimes(i, scene.items, Math.max(at + 0.95, hlEnd), step);
        scene.items.forEach((it, q) => {
          const left = r1(cx + (q % 2 ? 46 : -46) * (LS ? 0.6 : 1));
          const top = r1(top0 + q * (cardH + gapY));
          const ry = q % 2 ? -8 : 8;
          const rz = q % 2 ? 1.2 : -1.2;
          body.push(
            `<div class="dc" style="left:${left}px;top:${top}px;width:${cw}px;height:${cardH}px;transform:translate3d(0px, 0px, ${depth[q]}px) rotateY(${ry}deg) rotateZ(${rz}deg)"><div class="dcb" id="${id}-c${q}"><span class="dcs" id="${id}-cs${q}"></span><div class="dcrow" id="${id}-ct${q}"><span class="dcn">${String(q + 1).padStart(2, "0")}</span><span class="dct" style="font-size:${size(`${id}-c${q}t`, SQ ? 46 : 58)}px" ${fitAttrs(`${id}-c${q}t`, cw - 230, cardH - 44, 28)}>${esc(it)}</span></div></div></div>`,
          );
          const inAt = t.start + 0.12 + q * 0.12;
          tw.push(`tl.fromTo("#${id}-c${q}", { z: -1400, opacity: 0 }, { z: 0, opacity: 0.5, duration: 0.85, ease: "expo.out" }, ${fmt(inAt)});`);
          const onAt = onTimes[q];
          const nextAt = q < n - 1 ? onTimes[q + 1] : 0;
          tw.push(`tl.fromTo("#${id}-c${q}", { z: 0, opacity: 0.5, backgroundColor: "${P.bg2}" }, { z: 170, opacity: 1, backgroundColor: "${P.accent}", duration: 0.45, ease: "back.out(1.5)", immediateRender: false }, ${fmt(onAt)});`);
          // text colour snaps (never interpolates against the changing fill): on once the fill is accent, off at once
          tw.push(`tl.fromTo("#${id}-ct${q}", { color: "${P.text}" }, { color: "${accentText}", duration: 0.08, ease: "none", immediateRender: false }, ${fmt(onAt + 0.28)});`);
          tw.push(`tl.fromTo("#${id}-cs${q}", { scaleY: 0 }, { scaleY: 1, duration: 0.4, ease: "power3.out" }, ${fmt(onAt)});`);
          if (q < n - 1) tw.push(`tl.fromTo("#${id}-c${q}", { z: 170, opacity: 1, backgroundColor: "${P.accent}" }, { z: 30, opacity: 0.85, backgroundColor: "${P.bg2}", duration: 0.45, ease: "power2.inOut", immediateRender: false }, ${fmt(Math.max(onAt + 0.5, nextAt))});`);
          if (q < n - 1) tw.push(`tl.fromTo("#${id}-ct${q}", { color: "${accentText}" }, { color: "${P.text}", duration: 0.08, ease: "none", immediateRender: false }, ${fmt(Math.max(onAt + 0.5, nextAt))});`);
          cues.push({ t: onAt, kind: "tick" });
        });
        body.push(`</div></div>`);
        tw.push(`tl.fromTo("#${id}-cam", { z: -240, rotationX: 20, rotationY: -12 }, { z: 30, rotationX: 7, rotationY: 7, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        cues.push({ t: t.start + 0.12, kind: "whoosh", gain: -3 });
        break;
      }
      case "tunnel_number": {
        // a big number flies out of a perspective grid tunnel: four grid walls recede to the vanishing point,
        // the tunnel moves towards the camera (fast, then a slow drift) and the number lands at z = 0.
        const n = scene.number!;
        const L = 2600;
        const [hwL, hwR, hT, hB] = [F.w / 2, F.w / 2, CY, F.h - CY];
        body.push(`<span class="tnglow" id="${id}-glow"></span>`);
        body.push(`<div class="st3 tnst" id="${id}-st"><div class="w3" id="${id}-w3">`);
        body.push(`<div class="tn" id="${id}-tn"><div class="spin" id="${id}-tn2">`);
        body.push(`<i class="tw tw-f" style="left:${-hwL}px;top:${hB}px;width:${hwL + hwR}px;height:${L}px"></i>`);
        body.push(`<i class="tw tw-c" style="left:${-hwL}px;top:${-hT - L}px;width:${hwL + hwR}px;height:${L}px"></i>`);
        body.push(`<i class="tw tw-l" style="left:${-hwL - L}px;top:${-hT}px;width:${L}px;height:${hT + hB}px"></i>`);
        body.push(`<i class="tw tw-r" style="left:${hwR}px;top:${-hT}px;width:${L}px;height:${hT + hB}px"></i>`);
        body.push(`</div></div>`);
        const numH = LS || SQ ? 320 : 400;
        body.push(`<div class="tncol" style="top:${CY - (LS || SQ ? 250 : 300)}px;height:${numH + 60}px">${numEl(id, n, LS || SQ ? 280 : 340, Math.min(textW - 80, 1400), numH, " tnum")}</div>`);
        body.push(`</div></div>`);
        const hlTop = CY + (LS || SQ ? 170 : 230);
        const hw = LS ? Math.min(1400, textW) : textW;
        body.push(`<div class="col center" style="top:${hlTop}px;left:${Math.round((F.w - hw) / 2)}px;right:auto;width:${hw}px">`);
        body.push(headline("hl-tn", LS || SQ ? 76 : 92, hw, Math.max(140, Math.min(420, S.bottom - hlTop - 10)), 40, "center"));
        if (scene.sub && !(LS || SQ)) body.push(subEl(scene, id));
        body.push(`</div>`);
        if (scene.kicker) body.push(`<div class="col center" style="top:${LS || SQ ? S.top : CY - 400}px">${kicker(scene.kicker, `${id}-k`)}</div>`);
        tw.push(`tl.fromTo("#${id}-tn", { z: -200 }, { z: 420, duration: 1.1, ease: "expo.out" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-tn2", { z: 0 }, { z: ${fmt(Math.min(380, 60 * t.duration))}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-w3", { rotationZ: -4, rotationY: 5 }, { rotationZ: 2, rotationY: -4, duration: ${fmt(t.duration)}, ease: "sine.inOut" }, ${fmt(t.start)});`);
        tw.push(`tl.fromTo("#${id}-num", { z: -2400, opacity: 0 }, { z: 0, opacity: 1, duration: 0.9, ease: "expo.out" }, ${fmt(t.start + 0.15)});`);
        tw.push(`tl.fromTo("#${id}-glow", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 1, ease: "power2.out" }, ${fmt(t.start)});`);
        cues.push({ t: t.start, kind: "whoosh", gain: -1 }, { t: t.start + 0.7, kind: "impact" });
        enter(scene, `${id}-hl`, at + 0.6, i);
        break;
      }
      default: {
        // headline: big type anchored where the director put it (no decorative rule under every headline)
        const w = LS ? Math.min(1400, textW) : textW;
        body.push(block(anchor, S.x, w, "left", [kicker(scene.kicker, `${id}-k`), headline("hl-main", LS ? (hook ? 124 : 108) : SQ ? (hook ? 118 : 104) : hook ? 140 : 120, w, LS ? 600 : SQ ? 640 : bandH * 0.72, 54, "left"), subEl(scene, id)]));
        enter(scene, `${id}-hl`, at, i);
      }
    }
    // shared: kicker / sub entrance, Ken Burns on photos
    if (scene.kicker && layout !== "orbit_title") tw.push(`tl.fromTo("#${id}-k", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, ${fmt(t.start + 0.05)});`);
    if (scene.sub && body.some((b) => b.includes(`id="${id}-sub"`))) tw.push(`tl.fromTo("#${id}-sub", { opacity: 0 }, { opacity: 1, duration: 0.5 }, ${fmt(Math.min(at + 0.9, t.start + t.duration - 0.6))});`);
    if (layout.startsWith("media_") && scene.image) {
      const m = scene.image.motion;
      const [from, to] = m === "zoom_out" ? ["scale: 1.16", "scale: 1"] : m === "pan_left" ? ["scale: 1.14, xPercent: 3", "scale: 1.14, xPercent: -3"] : m === "pan_right" ? ["scale: 1.14, xPercent: -3", "scale: 1.14, xPercent: 3"] : ["scale: 1", "scale: 1.14"];
      tw.push(`tl.fromTo("#${id}-img", { ${from} }, { ${to}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
      // parallax: the text layer drifts the other way, slower than the photo
      if (body.some((b) => b.includes(`id="${id}-hl"`))) tw.push(`tl.fromTo("#${id}-hl", { y: ${px(18)} }, { y: ${-px(26)}, duration: ${fmt(t.duration)}, ease: "none" }, ${fmt(t.start)});`);
    }
    if (!(LAYOUTS_3D as readonly string[]).includes(layout) && !layout.startsWith("media_") && t.duration > 1.5) {
      // a slow push-in after the entrance: a held typographic frame is never a still frame
      tw.push(`tl.fromTo("#${id}-in", { scale: 1 }, { scale: 1.045, duration: ${fmt(t.duration - 0.4)}, ease: "sine.inOut", immediateRender: false }, ${fmt(t.start + 0.36)});`);
    }
    body.push(counter(i));
    // transitions: how this scene arrives (entry on .in), how the previous one leaves (exit on its .out)
    const tr = i === 0 ? "cut" : scene.transition;
    if (i > 0) {
      const prev = `#sc${i - 1}-out`;
      const pt = timings[i - 1];
      if (tr === "whip") {
        tw.push(`tl.fromTo("${prev}", { x: 0, filter: "blur(0px)" }, { x: ${-Math.round(F.w * 0.45)}, filter: "blur(18px)", duration: 0.14, ease: "power2.in", immediateRender: false }, ${fmt(Math.max(pt.start, t.start - 0.14))});`);
        tw.push(`tl.fromTo("#${id}-in", { x: ${Math.round(F.w * 0.45)}, filter: "blur(18px)" }, { x: 0, filter: "blur(0px)", duration: 0.26, ease: "power3.out" }, ${fmt(t.start)});`);
        cues.push({ t: Math.max(0, t.start - 0.12), kind: "whoosh" });
      } else if (tr === "zoom") {
        tw.push(`tl.fromTo("${prev}", { scale: 1, opacity: 1 }, { scale: 1.3, opacity: 0, duration: 0.16, ease: "power2.in", immediateRender: false }, ${fmt(Math.max(pt.start, t.start - 0.16))});`);
        tw.push(`tl.fromTo("#${id}-in", { scale: 1.18, filter: "blur(10px)" }, { scale: 1, filter: "blur(0px)", duration: 0.32, ease: "power3.out" }, ${fmt(t.start)});`);
        cues.push({ t: Math.max(0, t.start - 0.14), kind: "whoosh", gain: -2 });
      } else if (tr === "fade") {
        tw.push(`tl.fromTo("${prev}", { opacity: 1 }, { opacity: 0, duration: 0.2, ease: "power1.in", immediateRender: false }, ${fmt(Math.max(pt.start, t.start - 0.2))});`);
        tw.push(`tl.fromTo("#${id}-in", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "power1.out" }, ${fmt(t.start)});`);
      }
      // a hard cut has no motion and no whoosh: the next frame simply is there, on the beat
    }
    // stage 25: the hook punches in (camera from 118 % with blur, a white flash on frame 1); the second scene is the
    // pattern interrupt around the third second (an accent flash on top of its whip/zoom)
    if (hook) {
      body.push(`<span class="flash" id="${id}-flash"></span>`);
      tw.push(`tl.fromTo("#${id}-out", { scale: 1.18, filter: "blur(10px)" }, { scale: 1, filter: "blur(0px)", duration: 0.5, ease: "expo.out" }, 0);`);
      tw.push(`tl.fromTo("#${id}-flash", { opacity: 0.85 }, { opacity: 0, duration: 0.28, ease: "power2.out" }, 0);`);
    } else if (i === 1) {
      body.push(`<span class="flash acc" id="${id}-flash"></span>`);
      tw.push(`tl.fromTo("#${id}-flash", { opacity: 0.55 }, { opacity: 0, duration: 0.22, ease: "power2.out", immediateRender: false }, ${fmt(t.start)});`);
    }
    if (i === design.scenes.length - 1) cues.push({ t: t.start + 0.5, kind: "ding", gain: -4 });
    if (hook && !["hero_number", "media_number", "orbit_title", "tunnel_number"].includes(layout)) cues.push({ t: 0.05, kind: "impact", gain: -3 });
    const is3d = (LAYOUTS_3D as readonly string[]).includes(layout);
    sections.push(
      `      <section id="${id}" class="clip scene L-${layout}${hook ? " hook" : ""}" data-start="${fmt(t.start)}" data-duration="${fmt(t.duration)}" data-track-index="1">\n        <div class="out" id="${id}-out"><div class="in${is3d ? "" : ` a-${anchor}`}" id="${id}-in">\n          ${body.filter(Boolean).join("\n          ")}\n        </div></div>\n      </section>`,
    );
  });

  // voiceover captions: one track-2 layer, each cue switched on/off on the timeline
  const caps = (o.captions ?? []).filter((c) => c.end > c.start && c.start < DUR && c.text.trim());
  if (caps.length) {
    const spans = caps.map((c, q) => `<span class="cap" id="cap${q}"><span class="capt">${esc(c.text)}</span></span>`);
    sections.push(`      <section id="capl" class="clip caps" data-start="0" data-duration="${fmt(DUR)}" data-track-index="2">\n        ${spans.join("\n        ")}\n      </section>`);
    caps.forEach((c, q) => {
      tw.push(`tl.fromTo("#cap${q}", { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.12, ease: "power2.out", immediateRender: false }, ${fmt(c.start)});`);
      tw.push(`tl.fromTo("#cap${q}", { opacity: 1 }, { opacity: 0, duration: 0.08, ease: "none", immediateRender: false }, ${fmt(Math.min(c.end, DUR - 0.05))});`);
    });
  }

  const D = FONTS[display];
  const A = FONTS[accentFont];
  const K = FONTS[kickerFont];
  const texture =
    I.texture === "grid"
      ? `background-image: linear-gradient(${light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)"} 1px, transparent 1px), linear-gradient(90deg, ${light ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)"} 1px, transparent 1px); background-size: 72px 72px;`
      : I.texture === "grain"
        ? `background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)' opacity='${light ? 0.05 : 0.09}'/></svg>");`
        : "";
  const glow = I.texture === "glow";
  // stage 25: the background is never a still: two soft colour fields drift across the frame for the whole video and
  // breathe on every cut, the grid crawls upward, the grain flickers at 12 fps (all on the one paused timeline)
  const blobSize = px(LS ? 1500 : 1400);
  const blobA = `left:${-Math.round(blobSize * 0.35)}px;top:${-Math.round(blobSize * 0.3)}px;width:${blobSize}px;height:${blobSize}px;background:radial-gradient(closest-side, ${P.accent}${light ? "26" : "2E"}, ${P.accent}00)`;
  const blobB = `left:${Math.round(F.w - blobSize * 0.6)}px;top:${Math.round(F.h - blobSize * 0.65)}px;width:${blobSize}px;height:${blobSize}px;background:radial-gradient(closest-side, ${P.accent2}${light ? "22" : "2A"}, ${P.accent2}00)`;
  const bgMotion: string[] = [
    `tl.fromTo("#bg-a", { x: 0, y: 0 }, { x: ${px(LS ? 700 : 420)}, y: ${px(LS ? 260 : 620)}, duration: ${fmt(DUR)}, ease: "sine.inOut" }, 0);`,
    `tl.fromTo("#bg-b", { x: 0, y: 0 }, { x: ${-px(LS ? 640 : 380)}, y: ${-px(LS ? 220 : 560)}, duration: ${fmt(DUR)}, ease: "sine.inOut" }, 0);`,
  ];
  timings.forEach((t, q) => {
    if (q === 0) return;
    bgMotion.push(`tl.fromTo("#bg-a", { opacity: 0.55 }, { opacity: 1, duration: 0.6, ease: "power2.out", immediateRender: false }, ${fmt(t.start)});`);
  });
  if (I.texture === "grid") bgMotion.push(`tl.fromTo("#bg-tex", { backgroundPosition: "0px 0px" }, { backgroundPosition: "0px ${-Math.round(72 * Math.max(4, DUR / 2))}px", duration: ${fmt(DUR)}, ease: "none" }, 0);`);
  if (I.texture === "grain") bgMotion.push(`tl.fromTo("#bg-tex", { backgroundPosition: "0px 0px" }, { backgroundPosition: "${Math.round(DUR * 12) * 37}px ${Math.round(DUR * 12) * 53}px", duration: ${fmt(DUR)}, ease: "steps(${Math.max(1, Math.round(DUR * 12))})" }, 0);`);
  // the presenter: a VP9-alpha circle on its own track above the scenes, an accent ring that pops in with the hook
  const pb = o.presenter?.box;
  const presenterCss = pb
    ? `\n      #presenter { position: absolute; right: ${pb.right}px; bottom: ${pb.bottom}px; width: ${pb.size}px; height: ${pb.size}px; z-index: 6; }\n      .pres-ring { position: absolute; right: ${pb.right - px(7)}px; bottom: ${pb.bottom - px(7)}px; width: ${pb.size + px(14)}px; height: ${pb.size + px(14)}px; box-sizing: border-box; display: block; border-radius: 50%; border: ${px(7)}px solid ${P.accent}; box-shadow: 0 ${px(18)}px ${px(60)}px rgba(0,0,0,0.45); z-index: 7; }`
    : "";
  const presenterHtml = pb
    ? `\n      <video id="presenter" src="${esc(o.presenter!.src)}" data-start="0" data-duration="${fmt(DUR)}" data-track-index="3" muted playsinline></video>\n      <section id="presl" class="clip pres" data-start="0" data-duration="${fmt(DUR)}" data-track-index="4">\n        <span class="pres-ring" id="pres-ring"></span>\n      </section>`
    : "";
  if (pb) tw.push(`tl.fromTo("#pres-ring", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: "back.out(2)" }, 0.15);`);
  const resolution = F.w > F.h ? "landscape" : F.w === F.h ? "square" : "portrait";
  const statementText = onColor(P.accent);

  const html = `<!doctype html>
<html lang="${esc(script.language)}" data-resolution="${resolution}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${F.w}, height=${F.h}" />
    <!-- generated by vedit make-director/2 · ${F.aspect} · ${esc(script.title)} -->
    <script src="${o.gsapRel}"></script>
    <style>
      ${o.fontFaces}
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { margin: 0; width: ${F.w}px; height: ${F.h}px; overflow: hidden; background: ${P.bg}; }
      #root { position: relative; width: 100%; height: 100%; overflow: hidden; color: ${P.text}; font-family: ${fontStack(display)}; }
      .bg { position: absolute; inset: 0; display: block; background: radial-gradient(140% 90% at 25% 0%, ${P.bg2} 0%, ${P.bg} 68%); }
      .tex { position: absolute; inset: 0; display: block; ${texture} }
      .glow { position: absolute; left: ${-px(300)}px; top: ${px(200)}px; width: ${px(1200)}px; height: ${px(1200)}px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}33, transparent); }
      .brand { position: absolute; left: ${S.x}px; top: ${S.top - 20}px; display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(26)}px; letter-spacing: 0.16em; color: ${P.muted}; text-transform: uppercase; }
      .bar { position: absolute; left: ${S.x}px; right: ${S.x}px; top: ${S.top + 28}px; height: 4px; display: block; border-radius: 2px; background: ${light ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.14)"}; overflow: hidden; }
      .barf { display: block; width: 100%; height: 100%; background: ${P.accent}; transform-origin: left center; }
      .scene { position: absolute; inset: 0; overflow: hidden; }
      .out, .in { position: absolute; inset: 0; transform-origin: 50% 50%; }
      .ctr { position: absolute; right: ${S.x}px; top: ${S.top - 20}px; display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(26)}px; letter-spacing: 0.12em; color: ${P.muted}; }
      .blk { position: absolute; display: flex; flex-direction: column; gap: ${px(30)}px; }
      .blk.a-top { justify-content: flex-start; }
      .blk.a-center { justify-content: center; }
      .blk.a-bottom { justify-content: flex-end; }
      .blk.al-left { align-items: flex-start; text-align: left; }
      .blk.al-center { align-items: center; text-align: center; }
      .blk.spread { justify-content: space-between; }
      .grp { display: flex; flex-direction: column; gap: ${px(30)}px; width: 100%; align-items: flex-start; }
      .col { position: absolute; left: ${S.x}px; right: ${S.x}px; display: flex; flex-direction: column; gap: ${px(30)}px; }
      .col.center { align-items: center; text-align: center; }
      .col.left { align-items: flex-start; }
      .tlwrap { position: relative; display: block; width: 100%; height: ${px(300)}px; margin-top: ${px(30)}px; }
      .kick { display: block; font-family: ${fontStack(kickerFont)}; font-weight: ${K.weight}; font-size: ${px(32)}px; letter-spacing: 0.1em; text-transform: uppercase; color: ${P.accent}; }
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
      .sub { display: block; font-size: ${px(42)}px; font-weight: 600; line-height: 1.25; color: ${P.muted}; max-width: ${px(900)}px; }
      .sub.mono { font-family: ${fontStack("mono")}; font-size: ${px(30)}px; letter-spacing: 0.08em; text-transform: uppercase; }
      .rule { display: block; width: ${px(180)}px; height: 6px; border-radius: 3px; background: ${P.accent}; transform-origin: center; }
      .num { display: block; white-space: nowrap; font-family: ${fontStack(display)}; font-weight: ${D.weight}; line-height: 0.95; letter-spacing: -0.04em; }
      .num-v { background-image: linear-gradient(170deg, ${P.accent2} 0%, ${P.accent} 70%); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .num-v.odo { background-image: none; color: ${P.accent}; }
      .od { display: inline-block; height: 1em; overflow: hidden; vertical-align: top; font-variant-numeric: tabular-nums; }
      .ods { display: block; }
      .odd { display: block; height: 1em; line-height: 1; }
      .odc { display: inline-block; height: 1em; line-height: 1; vertical-align: top; }
      .num:has(.odo) { line-height: 1; }
      .ghost { position: absolute; left: ${-px(40)}px; display: block; white-space: nowrap; font-family: ${fontStack(display)}; font-weight: ${D.weight}; line-height: 0.9; letter-spacing: -0.05em; color: transparent; -webkit-text-stroke: ${px(4)}px ${P.accent}38; }
      .num-u { font-size: 0.34em; margin-left: 0.12em; color: ${P.accent}; letter-spacing: -0.01em; }
      .hl-hero { line-height: 1.08; }
      .ph { position: absolute; display: block; overflow: hidden; }
      .ph.full { inset: 0; }
      .ph.card { border-radius: ${px(40)}px; box-shadow: 0 30px 90px rgba(0,0,0,0.45); }
      .img { display: block; width: 100%; height: 100%; object-fit: cover; }
      .scrim { position: absolute; inset: 0; display: block; }
      .onphoto .hl, .onphoto .sub { color: #FFFFFF; text-shadow: 0 2px 28px rgba(0,0,0,0.45); }
      .onphoto .num-v { background-image: none; color: #FFFFFF; text-shadow: 0 4px 40px rgba(0,0,0,0.4); }
      .onphoto .num-u { color: #FFFFFF; }
      .onphoto .kick { color: ${P.accent}; text-shadow: 0 1px 12px rgba(0,0,0,0.5); }
      .fill { position: absolute; inset: 0; display: block; background: ${P.accent}; }
      .sweep { position: absolute; inset: 0; display: block; background-image: linear-gradient(100deg, rgba(255,255,255,0) 35%, rgba(255,255,255,0.16) 50%, rgba(255,255,255,0) 65%); background-size: 300% 100%; background-repeat: no-repeat; pointer-events: none; }
      .flash { position: absolute; inset: 0; display: block; background: #FFFFFF; opacity: 0; pointer-events: none; z-index: 5; }
      .flash.acc { background: ${P.accent}; }
      .blob { position: absolute; display: block; border-radius: 50%; }
      .L-statement .hl, .L-statement .sub, .L-statement .kick { color: ${statementText}; }
      .L-statement .acc-w-color, .L-statement .acc-w-serif, .L-statement .acc-w-gradient, .L-statement .acc-w-outline { color: ${statementText}; background: none; -webkit-text-stroke: 0; }
      .L-statement .acc-w-outline { color: transparent; -webkit-text-stroke: 3px ${statementText}; }
      .L-statement .acc-marker { background-image: linear-gradient(${statementText}, ${statementText}); color: ${P.accent}; }
      .splitline { position: absolute; display: block; background: ${P.accent}; transform-origin: left center; }
      .splitline.v { transform-origin: center top; }
      .items { display: flex; flex-direction: column; gap: ${px(36)}px; margin-top: ${px(16)}px; width: 100%; }
      .item { display: flex; align-items: center; gap: ${px(30)}px; }
      .badge { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; width: ${px(104)}px; height: ${px(104)}px; border-radius: ${px(30)}px; background: ${P.accent}; color: ${accentText}; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(34)}px; }
      .itext { display: block; font-weight: 700; line-height: 1.12; color: ${P.text}; }
      .chat { display: flex; flex-direction: column; gap: ${px(26)}px; width: 100%; margin-top: ${px(16)}px; }
      .bub { display: block; padding: ${px(26)}px ${px(34)}px; border-radius: ${px(40)}px; }
      .bub.l { align-self: flex-start; background: ${light ? "#FFFFFF" : P.bg2}; border-bottom-left-radius: 10px; color: ${P.text}; box-shadow: 0 10px 40px rgba(0,0,0,${light ? 0.08 : 0.3}); }
      .bub.r { align-self: flex-end; background: ${P.accent}; border-bottom-right-radius: 10px; color: ${accentText}; }
      .btext { display: block; font-family: ${fontStack("inter")}; font-weight: 600; line-height: 1.25; }
      .track { position: absolute; display: block; height: 8px; border-radius: 4px; background: ${P.accent}; transform-origin: left center; }
      .dot { position: absolute; display: block; width: 36px; height: 36px; border-radius: 50%; background: ${P.bg}; border: 8px solid ${P.accent}; }
      .tlab { position: absolute; display: block; width: 220px; text-align: center; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(LS ? 50 : 42)}px; line-height: 1.15; color: ${P.text}; }
      .cmp { display: flex; gap: 40px; width: 100%; margin-top: ${px(24)}px; }
      .cc { display: flex; flex-direction: column; gap: ${px(22)}px; padding: ${px(44)}px ${px(30)}px; border-radius: ${px(36)}px; min-height: ${px(SQ ? 260 : 360)}px; justify-content: center; }
      .cc.a { background: ${light ? "#FFFFFF" : P.bg2}; color: ${P.text}; }
      .cc.b { background: ${P.accent}; color: ${accentText}; }
      .cl { display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(30)}px; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.8; }
      .cv { display: block; white-space: nowrap; font-weight: ${D.weight}; line-height: 1; letter-spacing: -0.03em; }
      .qmark { display: block; font-family: ${fontStack(accentFont)}; font-weight: ${A.weight}; font-size: ${px(300)}px; line-height: 0.6; height: ${px(150)}px; color: ${P.accent}; }
      /* 3D layouts: one perspective stage per scene, one preserve-3d world inside it */
      .st3 { position: absolute; inset: 0; perspective: 1500px; perspective-origin: 50% ${CY}px; }
      .w3 { position: absolute; inset: 0; transform-style: preserve-3d; transform-origin: ${F.w / 2}px ${CY}px; }
      .otglow { position: absolute; left: ${Math.round(F.w / 2 - 650)}px; top: ${CY - 650}px; width: 1300px; height: 1300px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}2E, ${P.accent2}10 55%, transparent); }
      .otcol { position: absolute; left: ${S.x}px; right: ${S.x}px; top: ${CY - (LS || SQ ? 300 : 380)}px; height: ${LS || SQ ? 480 : 600}px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 34px; text-align: center; }
      .hl-orbit { line-height: 0.98; letter-spacing: -0.035em; text-shadow: 0 6px 40px rgba(0,0,0,${light ? 0.08 : 0.35}); }
      .otcap { display: block; font-family: ${fontStack("mono")}; font-weight: 700; font-size: ${px(30)}px; letter-spacing: 0.18em; text-transform: uppercase; color: ${P.muted}; }
      .ring { position: absolute; left: ${F.w / 2}px; top: ${CY - 55}px; width: 0; height: 0; transform-style: preserve-3d; transform: rotateZ(-11deg) rotateX(58deg); }
      .spin { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-style: preserve-3d; }
      .bk { position: absolute; display: block; transform-style: preserve-3d; }
      .cube { position: absolute; inset: 0; display: block; transform-style: preserve-3d; }
      .fc { position: absolute; inset: 0; display: block; backface-visibility: hidden; border-radius: 3px; }
      .dcst { perspective: 1300px; }
      .dc { position: absolute; display: block; transform-style: preserve-3d; }
      .dcb { position: absolute; inset: 0; display: flex; align-items: center; gap: 30px; padding: 0 40px 0 50px; border-radius: 34px; overflow: hidden; background: ${P.bg2}; color: ${P.text}; border: 2px solid ${light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.1)"}; box-shadow: 0 30px 70px rgba(0,0,0,${light ? 0.14 : 0.45}); }
      .dcrow { display: flex; align-items: center; gap: 30px; color: ${P.text}; }
      .dcs { position: absolute; left: 0; top: 0; bottom: 0; width: 12px; display: block; background: ${P.accent2}; transform-origin: center top; }
      .dcn { display: flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 96px; height: 96px; border-radius: 28px; border: 3px solid currentColor; font-family: ${fontStack("mono")}; font-weight: 700; font-size: 34px; }
      .dct { display: block; font-weight: 700; line-height: 1.1; }
      .tnst { perspective: 900px; }
      .tn { position: absolute; left: ${F.w / 2}px; top: ${CY}px; width: 0; height: 0; transform-style: preserve-3d; }
      .tw { position: absolute; display: block; background-image: linear-gradient(${P.accent}55 3px, transparent 3px), linear-gradient(90deg, ${P.accent}55 3px, transparent 3px); background-size: 180px 180px; }
      .tw-f { transform-origin: 50% 0; transform: rotateX(-90deg); -webkit-mask-image: linear-gradient(to bottom, #000 0%, transparent 92%); mask-image: linear-gradient(to bottom, #000 0%, transparent 92%); }
      .tw-c { transform-origin: 50% 100%; transform: rotateX(90deg); -webkit-mask-image: linear-gradient(to top, #000 0%, transparent 92%); mask-image: linear-gradient(to top, #000 0%, transparent 92%); }
      .tw-l { transform-origin: 100% 50%; transform: rotateY(-90deg); -webkit-mask-image: linear-gradient(to left, #000 0%, transparent 92%); mask-image: linear-gradient(to left, #000 0%, transparent 92%); }
      .tw-r { transform-origin: 0 50%; transform: rotateY(90deg); -webkit-mask-image: linear-gradient(to right, #000 0%, transparent 92%); mask-image: linear-gradient(to right, #000 0%, transparent 92%); }
      .tnglow { position: absolute; left: ${Math.round(F.w / 2 - 400)}px; top: ${CY - 400}px; width: 800px; height: 800px; display: block; border-radius: 50%; background: radial-gradient(closest-side, ${P.accent}44, transparent); }
      .tncol { position: absolute; left: ${S.x}px; right: ${S.x}px; display: flex; align-items: center; justify-content: center; }
      .tnum { text-align: center; }
      .caps { position: absolute; inset: 0; pointer-events: none; }
      .cap { position: absolute; left: ${S.x}px; right: ${S.x}px; bottom: ${F.h - S.bottom + 6}px; display: flex; justify-content: center; opacity: 0; }
      .capt { display: block; max-width: ${textW}px; padding: 14px 28px; border-radius: 22px; background: rgba(0,0,0,0.62); color: #FFFFFF; font-family: ${fontStack("inter")}; font-weight: 700; font-size: ${px(50)}px; line-height: 1.18; text-align: center; text-wrap: balance; }${presenterCss}
      .hl-quote { font-family: ${fontStack(accentFont === "mono" ? display : accentFont)}; font-weight: ${(accentFont === "mono" ? D : A).weight}; font-style: ${(accentFont === "mono" ? D : A).style}; line-height: 1.12; }
    </style>
  </head>
  <body>
    <div
      id="root"
      data-composition-id="main"
      data-start="0"
      data-width="${F.w}"
      data-height="${F.h}"
      data-duration="${fmt(DUR)}"
      data-fps="${FPS}"
    >
      <section id="bgl" class="clip bg" data-start="0" data-duration="${fmt(DUR)}" data-track-index="0">
        <span class="blob" id="bg-a" style="${blobA}"></span>
        <span class="blob" id="bg-b" style="${blobB}"></span>
        <span class="tex" id="bg-tex"></span>${glow ? `\n        <span class="glow" id="bg-glow"></span>` : ""}${header ? `\n        <span class="brand" id="bg-brand">${esc(I.brand)}</span>\n        <span class="bar" id="bg-bar"><span class="barf" id="bg-barf"></span></span>` : ""}
      </section>
${sections.join("\n")}${presenterHtml}
    </div>
    <script>
      const tl = gsap.timeline({ paused: true });
      ${bgMotion.join("\n      ")}${glow ? `\n      tl.fromTo("#bg-glow", { x: 0, y: 0 }, { x: ${px(420)}, y: ${px(380)}, duration: ${fmt(DUR)}, ease: "sine.inOut" }, 0);` : ""}${header ? `\n      tl.fromTo("#bg-barf", { scaleX: 0 }, { scaleX: 1, duration: ${fmt(DUR)}, ease: "none" }, 0);` : ""}
      ${tw.join("\n      ")}
      window.__timelines["main"] = tl;
    </script>
  </body>
</html>
`;
  return { html, duration: DUR, timings, fonts, cues };
}
