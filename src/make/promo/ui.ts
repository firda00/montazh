import type { SfxCue } from "../../audio/sfx.ts";
import { formatCount, parseCount, type CountValue, type Ui, type UiItem } from "./schema.ts";

/**
 * Stage 31: product UI drawn in code. Every component lays itself out on its own fixed canvas (absolute px), so the
 * cursor's targets and the camera's focus points are known in Node — nothing is measured at render time. A component
 * returns its markup, its tweens (absolute times on the one paused timeline), camera keys (focus points on its canvas;
 * compose turns them into a dolly/zoom of the canvas) and SFX cues (≈ one per visual event: click, key, pop, chime).
 * Tweened nodes never carry a CSS transform; positions are left/top, motion is GSAP x/y/scale/rotation.
 */

export interface UiCtx {
  /** id prefix (unique per scene) */
  id: string;
  /** scene start and length on the video timeline (s) */
  t0: number;
  dur: number;
  accent: string;
  lang: string;
  /** Lucide icon markup (preloaded), a neutral dot when unknown */
  icon: (name: string) => string;
  /** a Simple Icons brand mark for a name ("Instagram") or null */
  brand: (name: string) => { path: string; hex: string } | null;
  product: { name: string; mark: string };
  /** 9:16: components that have a vertical layout use it */
  portrait?: boolean;
}

/** Where the camera looks at a moment: a point of the canvas and how much canvas width fits the frame. */
export interface CamKey {
  /** seconds from the scene start */
  t: number;
  cx: number;
  cy: number;
  /** visible canvas width (smaller = closer) */
  zw: number;
  /** a 3D tilt of the whole canvas (deg) */
  rx?: number;
  ry?: number;
  ease?: string;
}

export interface UiBuild {
  w: number;
  h: number;
  html: string;
  tl: string[];
  cam: CamKey[];
  cues: SfxCue[];
  /** elements whose count-up targets are checked by the tests: selector → final text */
  counts: Record<string, string>;
  /** laid out for the vertical frame: the camera keeps the whole width in view (no 9:16 close-up) */
  fitsPortrait?: boolean;
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const f = (n: number) => String(r3(n));
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const box = (x: number, y: number, w?: number, h?: number) => `left:${Math.round(x)}px;top:${Math.round(y)}px;${w !== undefined ? `width:${Math.round(w)}px;` : ""}${h !== undefined ? `height:${Math.round(h)}px;` : ""}`;

/** A deterministic hash of a string (chip colours, avatar tints). */
export function hashStr(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 16777619);
  return h >>> 0;
}

const STATUS_COLORS: [RegExp, string, string][] = [
  [/repl|won|paid|done|sent|active|готов|ответ|оплач|выигр|закрыт|отправ|актив|✓/i, "#16A34A", "#DCFCE7"],
  [/contact|call|meet|demo|созвон|контакт|встреч|демо/i, "#2563EB", "#DBEAFE"],
  [/qualif|review|квалиф|провер|due|сегодня/i, "#7C3AED", "#EDE9FE"],
  [/lost|late|overdue|fail|потер|просроч|отказ/i, "#DC2626", "#FEE2E2"],
  [/propos|offer|invoice|предлож|счёт|счет|оффер/i, "#EA580C", "#FFEDD5"],
];
/** chip colours for a status word: [text, background] */
export function statusColor(s: string): [string, string] {
  for (const [re, fg, bg] of STATUS_COLORS) if (re.test(s)) return [fg, bg];
  return ["#52525B", "#F4F4F5"];
}
const AVATAR_TINTS = ["#F97316", "#0EA5E9", "#8B5CF6", "#10B981", "#EC4899", "#EAB308", "#6366F1"];
const tint = (s: string) => AVATAR_TINTS[hashStr(s) % AVATAR_TINTS.length];
const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => [...w][0] ?? "").join("").toUpperCase() || "•";

/** Brands that have no mark to draw (Simple Icons removed them on the owners' request): a typed monogram instead. */
export const MONOGRAMS: Record<string, [string, string]> = { linkedin: ["in", "#0A66C2"], microsoft: ["M", "#5E5E5E"], openai: ["AI", "#111111"], excel: ["X", "#1D6F42"], "microsoft excel": ["X", "#1D6F42"], twitter: ["X", "#111111"], salesforce: ["SF", "#00A1E0"], nasdaq: ["N", "#0996C7"] };
/** an SVG monogram (two letters on a rounded square of the brand's colour) */
export const monogramSvg = (text: string, hex: string) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><rect x="1" y="1" width="22" height="22" rx="5" fill="${hex}"/><text x="12" y="16.2" text-anchor="middle" font-family="VInter, sans-serif" font-weight="800" font-size="${text.length > 1 ? 10.5 : 13}" fill="#fff">${esc(text)}</text></svg>`;

/** A brand mark when the name is a known brand, a monogram for a mark-less brand, else a Lucide icon. */
function glyph(c: UiCtx, name: string, iconName = "", size = 26, color = "currentColor"): string {
  const b = c.brand(name);
  if (b) return `<span class="u-ic" style="width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="${size}" height="${size}"><path d="${b.path}" fill="${b.hex}"/></svg></span>`;
  const m = MONOGRAMS[name.trim().toLowerCase()];
  if (m) return `<span class="u-ic" style="width:${size}px;height:${size}px">${monogramSvg(m[0], m[1])}</span>`;
  return `<span class="u-ic" style="width:${size}px;height:${size}px;color:${color}">${c.icon(iconName || guessIcon(name))}</span>`;
}
export function guessIcon(name: string): string {
  const n = name.toLowerCase();
  if (/mail|почт|gmail|e-mail/.test(n)) return "mail";
  if (/phone|call|звон|тел/.test(n)) return "phone";
  if (/insta/.test(n)) return "instagram";
  if (/linked/.test(n)) return "linkedin";
  if (/sheet|excel|таблиц|csv/.test(n)) return "file-spreadsheet";
  if (/money|\$|доход|выруч|revenue|деньг|₽|€/.test(n)) return "wallet";
  if (/user|client|клиент|lead|лид|people|люд/.test(n)) return "users";
  if (/chart|growth|рост|график/.test(n)) return "trending-up";
  if (/fund|фонд|bank|банк/.test(n)) return "landmark";
  if (/startup|стартап|rocket/.test(n)) return "rocket";
  return "circle-dot";
}

// ---- shared pieces ----

/** the macOS-style arrow, hotspot at (0,0) */
const ARROW = `<svg viewBox="0 0 20 28" width="100%" height="100%"><path d="M1.5 1.5 L1.5 22.5 L7 17.2 L10.6 25.6 L14.2 24 L10.7 15.8 L18 15.8 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
/** a pointing hand (reference #17), hotspot near the fingertip */
const HAND = `<svg viewBox="0 0 24 28" width="100%" height="100%"><path d="M9 2.2c1.1 0 2 .9 2 2v8.3l.6-.1c1-.2 2 .4 2.3 1.3l.1.4.5-.1c1-.2 2 .4 2.3 1.4l.1.4.4-.1c1.1-.2 2.2.6 2.3 1.7l.4 4.2c.2 2.2-.4 4.3-1.7 6H8.8L4.3 19.7c-.7-.9-.5-2.2.4-2.9.8-.6 1.9-.5 2.6.2L7 17.3V4.2c0-1.1.9-2 2-2z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

export interface CursorStep {
  /** seconds from the scene start */
  t: number;
  x: number;
  y: number;
  /** click when it arrives (press + ripple + SFX); selectors pressed together with the cursor */
  click?: boolean;
  press?: string[];
  /** travel time to this point (default min(0.6, gap)) */
  move?: number;
}

/** A cursor that travels between canvas points and clicks: one node, x/y tweens, press + ripple per click. */
export function cursor(c: UiCtx, steps: CursorStep[], o: { size?: number; hand?: boolean; from?: { x: number; y: number } } = {}): { html: string; tl: string[]; cues: SfxCue[] } {
  const id = `${c.id}-cur`;
  const size = o.size ?? 34;
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  if (!steps.length) return { html: "", tl, cues };
  const start = o.from ?? { x: steps[0].x + 260, y: steps[0].y + 220 };
  const ripples: string[] = [];
  const A = (s: number) => c.t0 + s;
  tl.push(`tl.set("#${id}", { x: ${start.x}, y: ${start.y} }, ${f(A(0))});`);
  tl.push(`tl.fromTo("#${id}", { opacity: 0 }, { opacity: 1, duration: 0.2, ease: "none" }, ${f(A(Math.max(0, steps[0].t - 0.75)))});`);
  let prevT = Math.max(0, steps[0].t - 0.75);
  steps.forEach((s, k) => {
    const move = Math.max(0.18, Math.min(s.move ?? 0.62, s.t - prevT - 0.02));
    tl.push(`tl.to("#${id}", { x: ${Math.round(s.x)}, y: ${Math.round(s.y)}, duration: ${f(move)}, ease: "power2.inOut" }, ${f(A(s.t - move))});`);
    if (s.click) {
      const rid = `${c.id}-rip${k}`;
      // a small, faint ring at the cursor's tip (≤ ~48 px on screen at the usual camera zoom), never a disc over text
      ripples.push(`<span class="u-rip" id="${rid}" style="${box(s.x - 10, s.y - 10, 20, 20)}"></span>`);
      tl.push(`tl.to("#${id}", { scale: 0.84, duration: 0.07, ease: "power2.in", yoyo: true, repeat: 1 }, ${f(A(s.t + 0.04))});`);
      for (const sel of s.press ?? []) tl.push(`tl.to("${sel}", { scale: 0.95, duration: 0.07, ease: "power2.in", yoyo: true, repeat: 1 }, ${f(A(s.t + 0.04))});`);
      tl.push(`tl.fromTo("#${rid}", { scale: 0.4, opacity: 0.45 }, { scale: 1.5, opacity: 0, duration: 0.45, ease: "power2.out", immediateRender: false }, ${f(A(s.t + 0.06))});`);
      cues.push({ t: r3(A(s.t + 0.05)), kind: "click" });
    }
    prevT = s.t;
  });
  const html = `${ripples.join("")}<div class="u-cur${o.hand ? " hand" : ""}" id="${id}" style="width:${size}px;height:${Math.round(size * 1.38)}px">${o.hand ? HAND : ARROW}</div>`;
  return { html, tl, cues };
}

/** A notification card that drops in (icon, title, sub). */
function toast(c: UiCtx, key: string, x: number, y: number, w: number, icon: string, iconBg: string, title: string, sub: string, at: number, tl: string[], cues: SfxCue[]): string {
  const id = `${c.id}-${key}`;
  tl.push(`tl.fromTo("#${id}", { y: -26, opacity: 0, scale: 0.96, filter: "blur(8px)" }, { y: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.5, ease: "power3.out" }, ${f(c.t0 + at)});`);
  cues.push({ t: r3(c.t0 + at + 0.02), kind: "chime" });
  return `<div class="u-toast" id="${id}" style="${box(x, y, w)}"><span class="u-tico" style="background:${iconBg}">${c.icon(icon)}</span><span class="u-tx"><b>${esc(title)}</b>${sub ? `<i>${esc(sub)}</i>` : ""}</span></div>`;
}

/** A number that counts from `from` to its value; the element starts showing `from`. */
function counter(c: UiCtx, key: string, value: string, from: number | null, at: number, dur: number, tl: string[], counts: Record<string, string>, cls = "", cuesOut?: SfxCue[]): string {
  const id = `${c.id}-${key}`;
  const cv = parseCount(value);
  if (!cv) return `<span class="u-num ${cls}" id="${id}">${esc(value)}</span>`;
  const a = from ?? 0;
  tl.push(`__cnt("#${id}", ${cvJson(cv)}, ${a}, ${cv.value}, ${f(c.t0 + at)}, ${f(dur)});`);
  counts[`#${id}`] = formatCount(cv, cv.value);
  // a counter ticks as it rolls, slowing down with the ease (power2.out), pitch rising a little
  if (cuesOut) for (let k = 0; k < 6; k++) cuesOut.push({ t: r3(c.t0 + at + dur * (1 - Math.sqrt(1 - k / 6))), kind: "tick", gain: -13 + k * 0.5, rate: 1 + k * 0.05 } as SfxCue);
  return `<span class="u-num ${cls}" id="${id}">${esc(formatCount(cv, a))}</span>`;
}
export const cvJson = (cv: CountValue) => JSON.stringify([cv.prefix, cv.suffix, cv.decimals, cv.group, cv.point]);

/** Words of a text as spans that blur in one by one. */
function blurWords(c: UiCtx, key: string, text: string, at: number, tl: string[], stagger = 0.06): string {
  const ws = text.split(/\s+/).filter(Boolean);
  tl.push(`tl.fromTo("#${c.id}-${key} .u-bw", { opacity: 0, filter: "blur(6px)", y: 8 }, { opacity: 1, filter: "blur(0px)", y: 0, duration: 0.4, ease: "power2.out", stagger: ${stagger} }, ${f(c.t0 + at)});`);
  return `<span id="${c.id}-${key}">${ws.map((w) => `<span class="u-bw">${esc(w)}</span>`).join(" ")}</span>`;
}

/** Characters typed into a field: the text grows (substring on update), a caret follows; one key SFX per ~2 chars. */
function typed(c: UiCtx, key: string, text: string, at: number, dur: number, tl: string[], cues: SfxCue[]): string {
  const id = `${c.id}-${key}`;
  const n = [...text].length;
  tl.push(`__type("#${id}", ${JSON.stringify(text)}, ${f(c.t0 + at)}, ${f(dur)});`);
  tl.push(`tl.fromTo("#${id}-cr", { opacity: 0 }, { opacity: 1, duration: 0.01 }, ${f(c.t0 + at)});`);
  tl.push(`tl.to("#${id}-cr", { opacity: 0, duration: 0.01 }, ${f(c.t0 + at + dur + 0.5)});`);
  for (let k = 0; k < n; k += 2) cues.push({ t: r3(c.t0 + at + (dur * k) / Math.max(1, n)), kind: "key" });
  return `<span class="u-typed"><span id="${id}"></span><i class="u-caret" id="${id}-cr"></i></span>`;
}

const win = (id: string, x: number, y: number, w: number, h: number, title: string, inner: string, extra = "") =>
  `<div class="u-win" id="${id}" style="${box(x, y, w, h)}"><div class="u-bar"><i></i><i></i><i></i><span>${esc(title)}</span>${extra}</div>${inner}</div>`;

const chip = (text: string, id = "", extraCls = "") => {
  const [fg, bg] = statusColor(text);
  return `<span class="u-chip ${extraCls}"${id ? ` id="${id}"` : ""} style="color:${fg};background:${bg}"><b style="background:${fg}"></b>${esc(text)}</span>`;
};

/**
 * 9:16 camera for a component laid out for the vertical frame: the whole width stays in view (UI ≈ 86–90 % of the
 * frame); a canvas taller than the frame is travelled from top to bottom, a shorter one sits a bit above centre and
 * breathes in.
 */
export function vcam(W: number, H: number, D: number, o: { tilt?: boolean; focusY?: number } = {}): CamKey[] {
  const zw = W + 20;
  const sc = (1080 * 0.94) / zw;
  const visH = 1920 / sc;
  if (H <= visH * 0.92) {
    const cy = Math.min(H / 2 + visH * 0.05, o.focusY ?? H / 2 + visH * 0.05);
    return [
      { t: 0, cx: W / 2, cy: cy + 40, zw: zw + 60, ...(o.tilt === false ? {} : { rx: 6 }) },
      { t: D * 0.55, cx: W / 2, cy, zw, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: cy - 10, zw: zw - 30, ease: "sine.inOut" },
    ];
  }
  const top = visH / 2 - 30;
  const bot = H - visH / 2 + 30;
  return [
    { t: 0, cx: W / 2, cy: top, zw },
    { t: D * 0.85, cx: W / 2, cy: bot, zw, ease: "power2.inOut" },
    { t: D, cx: W / 2, cy: bot, zw: zw - 20, ease: "sine.inOut" },
  ];
}

// ---- the components ----

function table(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  // 9:16: three columns (the name, the status, one more) on a narrow canvas
  if (P && u.columns.length > 3) {
    const st = u.columns.findIndex((x) => /status|статус|stage|этап|state|состоя/i.test(x));
    const keep = [...new Set([0, st > 0 ? st : 2, 1, 2])].filter((k) => k < u.columns.length).slice(0, 3).sort((a, b) => a - b);
    u = { ...u, columns: keep.map((k) => u.columns[k]), rows: u.rows.map((r) => keep.map((k) => r[k] ?? "")) };
  }
  const W = P ? 900 : 1440;
  const H = 860;
  const nc = u.columns.length;
  const statusCol = Math.max(0, u.columns.findIndex((x) => /status|статус|stage|этап|state|состоя/i.test(x)));
  const sc = statusCol > 0 ? statusCol : Math.min(2, nc - 1);
  const wx = 40;
  const wy = 40;
  const ww = W - 80;
  const c0 = P ? 360 : 400;
  const colX = (k: number) => (k === 0 ? 48 : 48 + c0 + ((ww - 96 - c0) / (nc - 1)) * (k - 1));
  const RH = P ? 100 : 88;
  const top = 236;
  const rows = u.rows;
  // the row that changes: the one with the biggest number in it (the deal, the winner), else the third
  const biggest = rows.map((r, i) => ({ i, v: Math.max(-Infinity, ...r.map((c) => parseCount(c)?.value ?? -Infinity)) })).filter((x) => Number.isFinite(x.v)).sort((a, b) => b.v - a.v)[0];
  const clickRow = biggest && rows.some((r) => r.some((c) => /[$€£₽¥%]|млн|млрд|тыс|\d\s?[kmb]\b/i.test(c))) ? biggest.i : Math.min(2, rows.length - 1);
  const rowsHtml = rows
    .map((r, i) => {
      const cells = r
        .map((cell, k) => {
          // an initials avatar only for a name (a date or a number in the first column gets none)
          if (k === 0) return `<span class="u-cell u-c0" style="left:${colX(0)}px">${/^\p{L}/u.test(cell) ? `<span class="u-av" style="background:${tint(cell)}">${esc(initials(cell))}</span>` : ""}<b>${esc(cell)}</b></span>`;
          if (k === sc) {
            const old = chip(cell, `${c.id}-st${i}a`);
            const neu = i === clickRow ? chip(u.action, `${c.id}-st${i}b`, "u-swap") : "";
            return `<span class="u-cell" id="${c.id}-stc${i}" style="left:${colX(k)}px">${old}${neu}</span>`;
          }
          const isChannel = !!c.brand(cell) || /mail|почт/i.test(cell);
          return `<span class="u-cell" style="left:${colX(k)}px">${isChannel ? glyph(c, cell, "", 22) : ""}<span>${esc(cell)}</span></span>`;
        })
        .join("");
      return `<div class="u-row${i === 0 ? " u-new" : ""}" id="${c.id}-r${i}" style="${box(0, top + i * RH, ww, RH)}">${cells}<span class="u-hl" id="${c.id}-hl${i}"></span></div>`;
    })
    .join("");
  const header = u.columns.map((h, k) => `<span class="u-th" style="left:${colX(k)}px">${esc(h)}</span>`).join("");
  const inner = `<div class="u-h1" style="${box(48, 92)}">${esc(u.title)}</div><span class="u-btn dark" style="${box(ww - 220, 92, 170, 52)}">+ ${c.lang === "ru" ? "Добавить" : "New"}</span><div class="u-thead" style="${box(0, 182, ww, 48)}">${header}</div>${rowsHtml}`;
  const html = win(`${c.id}-win${P ? "" : ""}`, wx, wy, ww, Math.max(H - 80, top + rows.length * RH + 40), c.product.name, inner).replace('class="u-win"', `class="u-win${P ? " pt" : ""}"`);
  // rows (except the new one) arrive one row up, the new row slides in at the top and pushes them down
  const tIns = 0.3 * D;
  tl.push(`tl.fromTo("#${c.id}-win .u-row:not(.u-new)", { y: ${-RH + 24}, opacity: 0 }, { y: ${-RH}, opacity: 1, duration: 0.45, ease: "power2.out", stagger: 0.06 }, ${f(c.t0 + 0.12)});`);
  tl.push(`tl.to("#${c.id}-win .u-row:not(.u-new)", { y: 0, duration: 0.45, ease: "power3.inOut" }, ${f(c.t0 + tIns)});`);
  tl.push(`tl.fromTo("#${c.id}-r0", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${f(c.t0 + tIns + 0.1)});`);
  tl.push(`tl.fromTo("#${c.id}-hl0", { opacity: 0.9 }, { opacity: 0, duration: 1.4, ease: "power1.in" }, ${f(c.t0 + tIns + 0.1)});`);
  cues.push({ t: r3(c.t0 + tIns + 0.1), kind: "pop" });
  // a status chip changes on click
  const cx = wx + colX(sc) + 60;
  const cy = wy + top + clickRow * RH + RH / 2;
  const tClick = 0.66 * D;
  const cur = cursor(c, [{ t: tClick, x: cx, y: cy, click: true, press: [`#${c.id}-stc${clickRow}`] }]);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.to("#${c.id}-st${clickRow}a", { opacity: 0, y: -10, duration: 0.2 }, ${f(c.t0 + tClick + 0.08)});`);
  tl.push(`tl.fromTo("#${c.id}-st${clickRow}b", { opacity: 0, y: 12, scale: 0.8 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(2)" }, ${f(c.t0 + tClick + 0.12)});`);
  cues.push({ t: r3(c.t0 + tClick + 0.14), kind: "pop" });
  return {
    w: W,
    h: H,
    html: html + cur.html,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, Math.max(H, top + rows.length * RH + 120), D) : [
      { t: 0, cx: 520, cy: 340, zw: 1000, ry: -10, rx: 6 },
      { t: tIns + 0.2, cx: 720, cy: 420, zw: 1400, ease: "power2.inOut" },
      { t: tClick - 0.05, cx: cx - 80, cy, zw: 980, ease: "power2.inOut" },
      { t: D, cx: cx - 60, cy: cy - 10, zw: 920, ease: "sine.inOut" },
    ],
  };
}

function form(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 760 : 1440;
  const H = P ? 230 + u.items.length * 150 + 60 : 860;
  const name = u.items[0]?.value || c.product.name;
  // the page behind: a profile card with grey copy lines
  const page = `<div class="u-card" id="${c.id}-page" style="${box(40, 90, 760, 680)}"><span class="u-av big" style="${box(56, 70)};background:${tint(name)}">${esc(initials(name))}</span><b class="u-pname" style="${box(220, 82)}">${esc(name)}</b><span class="u-psub" style="${box(220, 132)}">${esc(u.items[1]?.value ?? "")}</span>${[0, 1, 2, 3, 4].map((k) => `<span class="u-line" style="${box(56, 260 + k * 56, 620 - (k % 3) * 120, 18)}"></span>`).join("")}</div>`;
  const px = P ? 40 : 840;
  const py = P ? 100 : 60;
  const pw = P ? W - 80 : 560;
  const fields = u.items
    .map((it, k) => {
      const y = 150 + k * 150;
      return `<span class="u-flab" style="${box(36, y)}">${esc(it.label)}</span><span class="u-input" id="${c.id}-in${k}" style="${box(36, y + 34, pw - 72, 66)}">${typed(c, `ty${k}`, it.value, 0.22 * D + k * ((0.42 * D) / u.items.length), Math.min(0.9, (0.36 * D) / u.items.length), tl, cues)}</span>`;
    })
    .join("");
  const btnX = pw - 230;
  const panel = `<div class="u-card u-panel" id="${c.id}-panel" style="${box(px, py, pw, P ? 180 + u.items.length * 150 : 740)}"><span class="u-mark" style="${box(36, 36, 44, 44)}">${esc(c.product.mark)}</span><b class="u-ptitle" style="${box(96, 44)}">${esc(u.title)}</b><span class="u-btn dark" id="${c.id}-btn" style="${box(btnX, 34, 194, 50)}"><span id="${c.id}-btna">${esc(u.action)}</span><span class="u-swap" id="${c.id}-btnb">✓ ${esc(u.action)}</span></span>${fields}</div>`;
  tl.push(`tl.fromTo("#${c.id}-panel", { x: 90, opacity: 0, filter: "blur(10px)" }, { x: 0, opacity: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out" }, ${f(c.t0 + 0.08 * D)});`);
  cues.push({ t: r3(c.t0 + 0.08 * D), kind: "swipe" });
  const tClick = 0.74 * D;
  const bx = px + btnX + 97;
  const by = py + 34 + 25;
  const cur = cursor(c, [{ t: tClick, x: bx, y: by, click: true, press: [`#${c.id}-btn`] }]);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.to("#${c.id}-btna", { opacity: 0, duration: 0.15 }, ${f(c.t0 + tClick + 0.08)});`);
  tl.push(`tl.fromTo("#${c.id}-btnb", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${f(c.t0 + tClick + 0.1)});`);
  const tt = u.result ? toast(c, "toast", P ? 60 : 420, P ? 0 : 20, P ? W - 120 : 560, "circle-check", "#16A34A", u.result, u.result_sub, tClick + 0.2, tl, cues) : "";
  const lastY = py + 150 + (u.items.length - 1) * 150 + 60;
  return {
    w: W,
    h: H,
    html: (P ? "" : page) + panel + tt + cur.html,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: 640, cy: 430, zw: 1500, ry: 8 },
      { t: 0.24 * D, cx: px + pw / 2, cy: py + 250, zw: 820, ease: "power2.inOut" },
      { t: 0.62 * D, cx: px + pw / 2, cy: lastY - 120, zw: 860, ease: "sine.inOut" },
      { t: tClick, cx: px + pw / 2 - 40, cy: by + 120, zw: 900, ease: "power2.inOut" },
      { t: D, cx: px + pw / 2 - 180, cy: by + 160, zw: 1150, ease: "sine.inOut" },
    ],
  };
}

function kanban(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const W = 1440;
  const H = 860;
  const n = u.columns.length;
  const gap = 24;
  const cw = (W - 80 - gap * (n - 1)) / n;
  const colX = (k: number) => 40 + k * (cw + gap);
  const CH = 150;
  const cTop = 190;
  const byCol = u.columns.map((col) => u.rows.filter((r) => r[2] === col));
  const moving = u.rows.find((r) => r[0] === u.result) ?? u.rows[0];
  const from = u.columns.indexOf(moving[2]);
  const to = Math.min(n - 1, from + 1);
  const mi = byCol[from].indexOf(moving);
  const val = (r: string[]) => parseCount(r[1])?.value ?? 0;
  const sample = u.rows.map((r) => parseCount(r[1])).find(Boolean) ?? null;
  const total = (rows: string[][]) => rows.reduce((s, r) => s + val(r), 0);
  const cards: string[] = [];
  const cols: string[] = [];
  u.columns.forEach((col, k) => {
    const [fg] = statusColor(col);
    const t = total(byCol[k]);
    let totalHtml = "";
    if (sample && (k === from || k === to)) {
      const after = k === from ? t - val(moving) : t + val(moving);
      const tv = formatCount(sample, after);
      const id = `${c.id}-tot${k}`;
      tl.push(`__cnt("#${id}", ${cvJson(sample)}, ${t}, ${after}, ${f(c.t0 + 0.64 * D)}, 0.6);`);
      counts[`#${id}`] = tv;
      totalHtml = `<span class="u-ktot" id="${id}">${esc(formatCount(sample, t))}</span>`;
    } else if (sample) totalHtml = `<span class="u-ktot">${esc(formatCount(sample, t))}</span>`;
    cols.push(`<div class="u-kcol" style="${box(colX(k), 40, cw, H - 80)}"><span class="u-khead"><b style="background:${fg}"></b>${esc(col)}<i>${byCol[k].length}</i></span>${totalHtml}</div>`);
    byCol[k].forEach((r, i) => {
      const id = r === moving ? `${c.id}-mv` : `${c.id}-k${k}-${i}`;
      cards.push(`<div class="u-kcard${r === moving ? " u-moving" : ""}" id="${id}" style="${box(colX(k) + 14, cTop + i * (CH + 14), cw - 28, CH)}"><span class="u-kval">${esc(r[1])}</span><b>${esc(r[0])}</b><span class="u-kmeta"><span class="u-av sm" style="background:${tint(r[0])}">${esc(initials(r[0]))}</span>${esc(col)}</span></div>`);
    });
  });
  tl.push(`tl.fromTo("#${c.id}-ui .u-kcard", { y: 24, opacity: 0, filter: "blur(6px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.45, ease: "power2.out", stagger: 0.05 }, ${f(c.t0 + 0.1)});`);
  const sx = colX(from) + 14 + (cw - 28) / 2;
  const sy = cTop + mi * (CH + 14) + CH / 2;
  const dx = colX(to) - colX(from);
  const dy = -mi * (CH + 14);
  const tGrab = 0.32 * D;
  const tDrop = 0.62 * D;
  const cur = cursor(c, [
    { t: tGrab, x: sx, y: sy, click: true },
    { t: tDrop, x: sx + dx, y: sy + dy, move: tDrop - tGrab - 0.08 },
  ]);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.to("#${c.id}-mv", { scale: 1.05, rotation: 2.5, duration: 0.18, ease: "power2.out" }, ${f(c.t0 + tGrab + 0.06)});`);
  tl.push(`tl.to("#${c.id}-mv", { x: ${dx}, y: ${dy}, duration: ${f(tDrop - tGrab - 0.08 - 0.02)}, ease: "power2.inOut" }, ${f(c.t0 + tGrab + 0.1)});`);
  tl.push(`tl.to("#${c.id}-mv", { scale: 1, rotation: 0, duration: 0.25, ease: "back.out(2)" }, ${f(c.t0 + tDrop)});`);
  cues.push({ t: r3(c.t0 + tGrab + 0.1), kind: "swipe", pan: 0.3, rate: 0.92 } as SfxCue, { t: r3(c.t0 + tDrop + 0.02), kind: "pop", pan: 0.3 } as SfxCue);
  // the destination column makes room, the source column closes the gap
  byCol[to].forEach((_, i) => tl.push(`tl.to("#${c.id}-k${to}-${i}", { y: ${CH + 14}, duration: 0.35, ease: "power2.inOut" }, ${f(c.t0 + tDrop - 0.3)});`));
  byCol[from].forEach((r, i) => {
    if (i > mi) tl.push(`tl.to("#${c.id}-k${from}-${i}", { y: ${-(CH + 14)}, duration: 0.35, ease: "power2.inOut" }, ${f(c.t0 + tGrab + 0.3)});`);
    void r;
  });
  return {
    w: W,
    h: H,
    html: `<div id="${c.id}-ui">${cols.join("")}${cards.join("")}</div>${cur.html}`,
    tl,
    cues,
    counts,
    cam: [
      { t: 0, cx: colX(from) + cw / 2 + 120, cy: 360, zw: 900, ry: -12, rx: 4 },
      { t: tGrab, cx: sx + 60, cy: sy, zw: 820, ease: "power2.inOut" },
      { t: tDrop, cx: sx + dx, cy: sy + dy + 40, zw: 860, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: 420, zw: 1460, ease: "power2.inOut" },
    ],
  };
}

function tiles(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const n = u.items.length;
  const P = !!c.portrait;
  const TW = P ? 740 : 400;
  const TH = P ? 300 : 480;
  const gap = 32;
  const W = P ? 820 : 80 + n * TW + (n - 1) * gap;
  const H = P ? 80 + n * TH + (n - 1) * gap : 560;
  const html = u.items
    .map((it, k) => {
      const x = P ? 40 : 40 + k * (TW + gap);
      const ty = P ? 40 + k * (TH + gap) : 40;
      const cv = parseCount(it.value);
      const target = parseCount(it.sub)?.value ?? null;
      const start = cv ? Math.round(cv.value * 0.55 * 10 ** cv.decimals) / 10 ** cv.decimals : 0;
      const at = 0.18 * D + k * 0.12;
      const num = counter(c, `n${k}`, it.value, cv ? start : null, at, Math.min(1.6, 0.5 * D), tl, counts, "big", k === 0 ? cues : undefined);
      const frac0 = target && cv ? Math.min(1, start / target) : 0.3;
      const frac1 = target && cv ? Math.min(1, cv.value / target) : 0.8;
      tl.push(`tl.fromTo("#${c.id}-pb${k}", { scaleX: ${f(frac0)} }, { scaleX: ${f(frac1)}, duration: ${f(Math.min(1.6, 0.5 * D))}, ease: "power2.out" }, ${f(c.t0 + at)});`);
      cues.push({ t: r3(c.t0 + at), kind: "tick" }, { t: r3(c.t0 + at + Math.min(1.6, 0.5 * D) * 0.6), kind: "tick" });
      return `<div class="u-card u-tile${P ? " pt" : ""}" id="${c.id}-t${k}" style="${box(x, ty, TW, TH)}"><span class="u-tlab">${glyph(c, it.label, it.icon, 30)}${esc(it.label)}</span>${num}<span class="u-tsub">${esc(it.sub)}</span><span class="u-pbar"><span class="u-pfill" id="${c.id}-pb${k}"></span></span></div>`;
    })
    .join("");
  tl.push(`tl.fromTo("#${c.id}-ui .u-tile", { y: 40, opacity: 0, filter: "blur(10px)" }, { y: 0, opacity: 1, filter: "blur(0px)", duration: 0.55, ease: "power3.out", stagger: 0.1 }, ${f(c.t0 + 0.05)});`);
  for (let k = 0; k < n; k++) cues.push({ t: r3(c.t0 + 0.05 + k * 0.1), kind: "pop", gain: -4 });
  const lastX = 40 + (n - 1) * (TW + gap) + TW / 2;
  return {
    w: W,
    h: H,
    html: `<div id="${c.id}-ui">${html}</div>`,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: 40 + TW / 2 + 40, cy: 300, zw: 620, ry: -16 },
      { t: 0.55 * D, cx: lastX - 40, cy: 290, zw: 640, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: H / 2, zw: W + 60, ease: "power2.inOut" },
    ],
  };
}

function metrics(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const n = u.items.length;
  const P = !!c.portrait;
  const TW = P ? 740 : 420;
  const MH = P ? 290 : 316;
  const gap = 30;
  const W = P ? 820 : 80 + n * TW + (n - 1) * gap;
  const H = P ? 80 + n * MH + (n - 1) * gap : 420;
  const html = u.items
    .map((it, k) => {
      const x = 40 + k * (TW + gap);
      const good = k === 0 && /[$€£₽¥]|доход|income|revenue|выруч/i.test(`${it.value} ${it.label}`);
      const at = 0.15 * D + k * 0.14;
      const num = counter(c, `m${k}`, it.value, 0, at, Math.min(1.5, 0.45 * D), tl, counts, `big${good ? " good" : ""}`, k === 0 ? cues : undefined);
      cues.push({ t: r3(c.t0 + at), kind: "tick" });
      return `<div class="u-card u-metric${P ? " pt" : ""}" id="${c.id}-m${k}c" style="${P ? box(40, 40 + k * (MH + gap), TW, MH) : box(x, 40 + (k % 2) * 24, TW, H - 104)}"><span class="u-mlab">${esc(it.label)} <i>⌄</i></span>${num}<span class="u-msub">${esc(it.sub)}</span></div>`;
    })
    .join("");
  tl.push(`tl.fromTo("#${c.id}-ui .u-metric", { y: 50, opacity: 0, scale: 0.94, filter: "blur(10px)" }, { y: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.6, ease: "power3.out", stagger: 0.12 }, ${f(c.t0 + 0.05)});`);
  for (let k = 0; k < n; k++) cues.push({ t: r3(c.t0 + 0.05 + k * 0.12), kind: "pop", gain: -4 });
  return {
    w: W,
    h: H,
    html: `<div id="${c.id}-ui">${html}</div>`,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: 40 + TW / 2 + 60, cy: H / 2, zw: 700, ry: -18, rx: 8 },
      { t: 0.6 * D, cx: W / 2, cy: H / 2, zw: W - 120, ease: "power2.inOut" },
      { t: D, cx: W / 2 + 20, cy: H / 2, zw: W + 40, ease: "sine.inOut" },
    ],
  };
}

/** Smooth path through points (Catmull-Rom → cubic Bézier) and its approximate length. */
export function smoothPath(pts: [number, number][]): { d: string; length: number } {
  if (pts.length < 2) return { d: "", length: 0 };
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  let length = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1: [number, number] = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: [number, number] = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)} ${c1[1].toFixed(1)} ${c2[0].toFixed(1)} ${c2[1].toFixed(1)} ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    // length by sampling the Bézier
    let prev = p1;
    for (let s = 1; s <= 16; s++) {
      const t = s / 16;
      const mt = 1 - t;
      const q: [number, number] = [mt ** 3 * p1[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t ** 3 * p2[0], mt ** 3 * p1[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t ** 3 * p2[1]];
      length += Math.hypot(q[0] - prev[0], q[1] - prev[1]);
      prev = q;
    }
  }
  return { d, length: Math.ceil(length) + 2 };
}

function chart(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 980 : 1440;
  const H = 820;
  const vals = u.items.map((x) => parseCount(x.value)!.value);
  const max = Math.max(...vals);
  const min = Math.min(0, ...vals);
  const gx = 60;
  const gy = 250;
  const gw = W - 80 - 120;
  const gh = 420;
  const pts: [number, number][] = vals.map((v, k) => [gx + (gw * k) / (vals.length - 1), gy + gh - ((v - min) / (max - min || 1)) * gh * 0.86]);
  const { d, length } = smoothPath(pts);
  const area = `${d} L${pts.at(-1)![0].toFixed(1)} ${gy + gh} L${pts[0][0].toFixed(1)} ${gy + gh} Z`;
  const grid = [0, 1, 2, 3].map((k) => `<line x1="${gx}" x2="${gx + gw}" y1="${gy + (gh * k) / 3}" y2="${gy + (gh * k) / 3}" stroke="#ECECEE" stroke-width="2"/>`).join("");
  const labels = u.items.map((x, k) => `<span class="u-xl" style="${box(40 + pts[k][0] - 60, 40 + gy + gh + 18, 120)}">${esc(x.label)}</span>`).join("");
  const tDraw = 0.18 * D;
  const drawDur = 0.5 * D;
  tl.push(`tl.fromTo("#${c.id}-line", { strokeDashoffset: ${length} }, { strokeDashoffset: 0, duration: ${f(drawDur)}, ease: "power2.inOut" }, ${f(c.t0 + tDraw)});`);
  tl.push(`tl.fromTo("#${c.id}-area", { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "power1.out" }, ${f(c.t0 + tDraw + drawDur * 0.6)});`);
  tl.push(`tl.fromTo("#${c.id}-dot", { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(2.5)" }, ${f(c.t0 + tDraw + drawDur)});`);
  tl.push(`tl.fromTo("#${c.id}-tip", { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "power3.out" }, ${f(c.t0 + tDraw + drawDur + 0.08)});`);
  cues.push({ t: r3(c.t0 + tDraw), kind: "whoosh", gain: -8 }, { t: r3(c.t0 + tDraw + drawDur), kind: "pop" });
  const big = counter(c, "big", u.result, 0, 0.12 * D, Math.min(1.8, 0.6 * D), tl, counts, "big");
  const last = pts.at(-1)!;
  const delta = vals.length > 1 && vals[0] ? Math.round(((vals.at(-1)! - vals[0]) / Math.abs(vals[0])) * 100) : 0;
  const card = `<div class="u-card" id="${c.id}-card" style="${box(40, 40, W - 80, H - 80)}"><span class="u-mlab" style="${box(60, 48)}">${esc(u.title)}</span><span style="${box(60, 92)};position:absolute">${big}</span>${delta ? `<span class="u-delta" style="${box(470, 120)}">${delta > 0 ? "▲" : "▼"} ${Math.abs(delta)}%</span>` : ""}<svg class="u-svg" width="${W - 80}" height="${H - 80}" viewBox="0 0 ${W - 80} ${H - 80}"><defs><linearGradient id="${c.id}-ag" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient></defs>${grid}<path id="${c.id}-area" d="${area}" fill="url(#${c.id}-ag)"/><path id="${c.id}-line" d="${d}" fill="none" stroke="${c.accent}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${length}" stroke-dashoffset="${length}"/></svg><span class="u-dot" id="${c.id}-dot" style="${box(last[0] - 14, last[1] - 14, 28, 28)};border-color:${c.accent}"></span><span class="u-tip" id="${c.id}-tip" style="${box(last[0] - 90, last[1] - 86, 180)}">${esc(u.items.at(-1)!.label)} · ${esc(u.items.at(-1)!.value)}</span></div>${labels}`;
  return {
    w: W,
    h: H,
    html: card,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: 380, cy: 300, zw: 860, rx: 6, ry: -8 },
      { t: tDraw + drawDur * 0.5, cx: 40 + pts[Math.floor(pts.length / 2)][0], cy: 40 + pts[Math.floor(pts.length / 2)][1], zw: 980, ease: "sine.inOut" },
      { t: tDraw + drawDur + 0.2, cx: 40 + last[0] - 120, cy: 40 + last[1] + 40, zw: 900, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: H / 2, zw: W + 40, ease: "power2.inOut" },
    ],
  };
}

const SPARKLE = (id: string) => `<svg viewBox="0 0 24 24" width="100%" height="100%"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38BDF8"/><stop offset="0.55" stop-color="#6366F1"/><stop offset="1" stop-color="#A855F7"/></linearGradient></defs><path d="M12 1.5 C12.9 7.6 16.4 11.1 22.5 12 C16.4 12.9 12.9 16.4 12 22.5 C11.1 16.4 7.6 12.9 1.5 12 C7.6 11.1 11.1 7.6 12 1.5Z" fill="url(#${id})"/></svg>`;

function flow(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const W = 1600;
  const H = 760;
  const n = u.items.length;
  const lx = 40;
  const lw = 440;
  const RH = 70;
  const ly = Math.round(H / 2 - (90 + n * RH) / 2);
  const rows = u.items.map((it, k) => `<span class="u-frow" style="${box(24, 84 + k * RH, lw - 48, RH - 14)}">${glyph(c, it.label, it.icon || "file-spreadsheet", 24, "#16A34A")}${esc(it.label)}</span>`).join("");
  const left = `<div class="u-card" id="${c.id}-src" style="${box(lx, ly, lw, 90 + n * RH)}"><b class="u-ftitle" style="${box(28, 26)}">${glyph(c, u.title, "table-2", 28, "#16A34A")} ${esc(u.title || "Sources")}</b>${rows}</div>`;
  const hx = 760;
  const hy = H / 2 - 80;
  const hub = `<div class="u-hub" id="${c.id}-hub" style="${box(hx, hy, 160, 160)}"><span class="u-spark" id="${c.id}-spark">${SPARKLE(`${c.id}-sg`)}</span></div><span class="u-hlab" style="${box(hx - 60, hy + 176, 280)}">${esc(u.action)}</span>`;
  const tx = 1320;
  const ty = H / 2 - 85;
  const target = `<div class="u-tgt" id="${c.id}-tgt" style="${box(tx, ty, 170, 170)}">${esc(c.product.mark)}</div><span class="u-hlab" style="${box(tx - 55, ty + 186, 280)}">${esc(c.product.name)}</span>`;
  const paths: string[] = [];
  const lens: number[] = [];
  u.items.forEach((_, k) => {
    const sy = ly + 84 + k * RH + (RH - 14) / 2;
    const p = `M${lx + lw} ${sy} C${lx + lw + 160} ${sy} ${hx - 160} ${H / 2} ${hx} ${H / 2}`;
    paths.push(p);
    lens.push(Math.round(Math.hypot(hx - lx - lw, H / 2 - sy) * 1.15));
  });
  const fan = [-38, 0, 38];
  fan.forEach((o) => {
    paths.push(`M${hx + 160} ${H / 2} C${hx + 300} ${H / 2 + o * 2.2} ${tx - 160} ${H / 2 + o * 1.6} ${tx} ${H / 2 + o * 0.4}`);
    lens.push(Math.round((tx - hx - 160) * 1.12));
  });
  const svg = `<svg class="u-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${paths.map((p, k) => `<path id="${c.id}-p${k}" d="${p}" fill="none" stroke="#C7C9D1" stroke-width="3" stroke-dasharray="${lens[k]}" stroke-dashoffset="${lens[k]}"/><path id="${c.id}-q${k}" d="${p}" fill="none" stroke="${k < n ? "#22C55E" : c.accent}" stroke-width="4" stroke-linecap="round" stroke-dasharray="6 26" opacity="0"/>`).join("")}</svg>`;
  const tL = 0.14 * D;
  const tHub = 0.36 * D;
  const tR = 0.44 * D;
  const tT = 0.62 * D;
  for (let k = 0; k < paths.length; k++) {
    const at = k < n ? tL + k * 0.06 : tR + (k - n) * 0.05;
    tl.push(`tl.fromTo("#${c.id}-p${k}", { strokeDashoffset: ${lens[k]} }, { strokeDashoffset: 0, duration: 0.55, ease: "power2.inOut" }, ${f(c.t0 + at)});`);
    tl.push(`tl.fromTo("#${c.id}-q${k}", { opacity: 0, strokeDashoffset: 0 }, { opacity: 0.9, strokeDashoffset: -${Math.round(64 * (D - at))}, duration: ${f(D - at - 0.3)}, ease: "none" }, ${f(c.t0 + at + 0.3)});`);
  }
  tl.push(`tl.fromTo("#${c.id}-hub", { scale: 0.4, opacity: 0, filter: "blur(10px)" }, { scale: 1, opacity: 1, filter: "blur(0px)", duration: 0.5, ease: "back.out(1.8)" }, ${f(c.t0 + tHub)});`);
  tl.push(`tl.fromTo("#${c.id}-spark", { rotation: -90, scale: 0.6 }, { rotation: 0, scale: 1, duration: 0.8, ease: "power3.out" }, ${f(c.t0 + tHub)});`);
  tl.push(`tl.to("#${c.id}-spark", { scale: 1.12, duration: 0.35, ease: "sine.inOut", yoyo: true, repeat: 3 }, ${f(c.t0 + tHub + 0.8)});`);
  tl.push(`tl.fromTo("#${c.id}-tgt", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: "back.out(2)" }, ${f(c.t0 + tT)});`);
  cues.push({ t: r3(c.t0 + tL), kind: "whoosh", gain: -8 }, { t: r3(c.t0 + tHub), kind: "chime" }, { t: r3(c.t0 + tR), kind: "whoosh", gain: -8 }, { t: r3(c.t0 + tT), kind: "pop" });
  const tt = u.result_sub || u.result ? toast(c, "toast", W / 2 - 330, H - 120, 660, "circle-check", "#16A34A", u.result, u.result_sub, 0.76 * D, tl, cues) : "";
  return {
    w: W,
    h: H,
    html: svg + left + hub + target + tt,
    tl,
    cues,
    counts,
    cam: [
      { t: 0, cx: lx + lw / 2 + 120, cy: H / 2, zw: 820, ry: 10 },
      { t: tHub + 0.1, cx: hx + 80, cy: H / 2, zw: 900, ease: "power2.inOut" },
      { t: tT + 0.1, cx: tx - 60, cy: H / 2 + 20, zw: 960, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: H / 2 + 30, zw: W, ease: "power2.inOut" },
    ],
  };
}

function list(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 920 : 1440;
  const n = u.items.length;
  const RH = P ? 124 : 104;
  const cy0 = 170;
  const H = cy0 + 110 + n * RH + 60;
  const cw = W - 80;
  const rows = u.items
    .map((it, k) => {
      const y = 100 + k * RH;
      return `<div class="u-lrow" style="${box(0, y, cw, RH)}"><span class="u-check" id="${c.id}-ck${k}" style="${box(36, (RH - 40) / 2, 40, 40)}"><span class="u-ckf" id="${c.id}-ckf${k}">${c.icon("check")}</span></span><b class="u-ltitle" style="${box(100, P ? 18 : 26)}">${esc(it.label)}</b><span class="u-lmeta" style="${P ? box(100, 72) : box(520, 30)}">${it.value ? `${glyph(c, it.value, "", 20)}<span>${esc(it.value)}</span>` : ""}<i>${esc(it.sub)}</i></span><span class="u-btn light" id="${c.id}-lb${k}" style="${box(cw - 236, P ? 34 : 26, 196, 56)}"><span id="${c.id}-lba${k}">${esc(u.action)}</span><span class="u-swap ok" id="${c.id}-lbb${k}">✓ ${esc(u.action)}</span></span></div>`;
    })
    .join("");
  const card = `<div class="u-card${P ? " pt" : ""}" id="${c.id}-card" style="${box(40, cy0, cw, 110 + n * RH)}"><b class="u-h1" style="${box(36, 30)}">${esc(u.title)}</b><span class="u-badge" style="${box(cw - 90, 34)}">${n}</span>${rows}</div>`;
  tl.push(`tl.fromTo("#${c.id}-card .u-lrow", { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: "power2.out", stagger: 0.07 }, ${f(c.t0 + 0.1)});`);
  const tt = u.result ? toast(c, "toast", P ? 60 : W / 2 - 300, 30, P ? W - 120 : 600, "bell", "#F97316", u.result, u.result_sub, 0.08 * D, tl, cues) : "";
  const clicks = Math.min(3, n);
  const steps: CursorStep[] = [];
  for (let k = 0; k < clicks; k++) {
    const t = (0.36 + k * 0.17) * D;
    const bx = 40 + cw - 236 + 98;
    const by = cy0 + 100 + k * RH + (P ? 62 : 52);
    steps.push({ t, x: bx, y: by, click: true, press: [`#${c.id}-lb${k}`] });
    tl.push(`tl.to("#${c.id}-lba${k}", { opacity: 0, duration: 0.12 }, ${f(c.t0 + t + 0.08)});`);
    tl.push(`tl.fromTo("#${c.id}-lbb${k}", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${f(c.t0 + t + 0.1)});`);
    tl.push(`tl.to("#${c.id}-ck${k}", { backgroundColor: "#22C55E", borderColor: "#22C55E", duration: 0.2 }, ${f(c.t0 + t + 0.1)});`);
    tl.push(`tl.fromTo("#${c.id}-ckf${k}", { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: "back.out(2.5)" }, ${f(c.t0 + t + 0.12)});`);
    cues.push({ t: r3(c.t0 + t + 0.14), kind: "pop", gain: -3 });
  }
  const cur = cursor(c, steps);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  const ry = (k: number) => cy0 + 100 + k * RH + 52;
  return {
    w: W,
    h: H,
    html: card + tt + cur.html,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: W / 2, cy: 200, zw: 1100, rx: 8 },
      { t: steps[0].t, cx: W - 520, cy: ry(0) + 40, zw: 1000, ease: "power2.inOut" },
      { t: steps.at(-1)!.t, cx: W - 560, cy: ry(clicks - 1), zw: 1040, ease: "sine.inOut" },
      { t: D, cx: W / 2, cy: H / 2, zw: W + 40, ease: "power2.inOut" },
    ],
  };
}

function chat(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 920 : 1200;
  const bw = P ? 740 : 660;
  const lineH = P ? 52 : 44;
  const charsPerLine = P ? 24 : 30;
  let y = 120;
  const bubbles: string[] = [];
  const n = u.items.length;
  const slot = (0.8 * D) / n;
  const focus: CamKey[] = [];
  u.items.forEach((m, k) => {
    const lines = Math.max(1, Math.ceil([...m.value].length / charsPerLine));
    const h = lines * lineH + 44;
    const ai = m.label === "ai";
    const x = ai ? 80 : W - 80 - bw;
    const at = 0.12 * D + k * slot;
    const id = `${c.id}-b${k}`;
    if (ai) {
      bubbles.push(`<div class="u-typing" id="${id}-dots" style="${box(x, y, 120, 64)}"><i></i><i></i><i></i></div>`);
      tl.push(`tl.fromTo("#${id}-dots", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.2 }, ${f(c.t0 + at)});`);
      tl.push(`tl.fromTo("#${id}-dots i", { y: 0 }, { y: -8, duration: 0.18, ease: "sine.inOut", yoyo: true, repeat: 3, stagger: 0.08 }, ${f(c.t0 + at)});`);
      tl.push(`tl.to("#${id}-dots", { opacity: 0, duration: 0.12 }, ${f(c.t0 + at + 0.55)});`);
    }
    const textAt = ai ? at + 0.6 : at;
    bubbles.push(`<div class="u-bub ${ai ? "ai" : "me"}${P ? " pt" : ""}" id="${id}" style="${box(x, y, bw, h)}${ai ? "" : `;background:${c.accent}`}">${ai ? `<span class="u-bai">${SPARKLE(`${id}-sg`)}</span>` : ""}${blurWords(c, `w${k}`, m.value, textAt + 0.1, tl, 0.035)}</div>`);
    tl.push(`tl.fromTo("#${id}", { opacity: 0, y: 24, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, ${f(c.t0 + textAt)});`);
    cues.push({ t: r3(c.t0 + textAt), kind: ai ? "chime" : "pop" });
    focus.push({ t: textAt + 0.2, cx: W / 2, cy: y + h / 2, zw: 1000, ease: "power2.inOut" });
    y += h + 30;
  });
  const H = Math.max(820, y + 140);
  const frame = `<div class="u-card" style="${box(40, 30, W - 80, H - 60)}"><span class="u-chathead"><span class="u-mark sm">${esc(c.product.mark)}</span>${esc(u.title || c.product.name)}</span></div>`;
  if (P) return { w: W, h: H, html: frame + bubbles.join(""), tl, cues, counts, fitsPortrait: true, cam: vcam(W, H, D) };
  return { w: W, h: H, html: frame + bubbles.join(""), tl, cues, counts, cam: [{ t: 0, cx: W / 2, cy: 240, zw: 1100, ry: 8 }, ...focus, { t: D, cx: W / 2, cy: Math.min(H / 2 + 60, y - 200), zw: 1180, ease: "sine.inOut" }] };
}

function invoice(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 1000 : 1200;
  const H = 1060;
  const pw = W - 160;
  const ru = c.lang === "ru";
  const sum = u.items.reduce((s, it) => s + (parseCount(it.value)?.value ?? 0), 0);
  const cv = u.items.map((x) => parseCount(x.value)).find(Boolean) ?? null;
  const totalText = cv ? formatCount(cv, sum) : u.items[0].value;
  const lines = u.items.map((it, k) => `<div class="u-irow" style="${box(56, 520 + k * 70, pw - 112, 60)}"><span>${k + 1}</span><b>${esc(it.label)}</b><span class="mono">${esc(it.sub || "1")}</span><span class="mono r">${esc(it.value)}</span></div>`).join("");
  const totY = 520 + u.items.length * 70 + 40;
  const btnY = totY + 120;
  const paper = `<div class="u-card u-paper" id="${c.id}-paper" style="${box(80, 40, pw, H - 80)}"><span class="u-mark" style="${box(56, 60, 56, 56)}">${esc((u.title || "N").slice(0, 1).toUpperCase())}</span><b class="u-pname" style="${box(132, 60)}">${esc(u.title)}</b><span class="u-line" style="${box(132, 110, 260, 14)}"></span><span class="u-line" style="${box(132, 136, 200, 14)}"></span><span class="u-inv" style="${box(pw - 260, 60)}">${ru ? "СЧЁТ" : "INVOICE"}</span><b class="u-invno mono" style="${box(pw - 330, 110)}">#INV-0001</b><span class="u-flab" style="${box(56, 300)}">${ru ? "Кому" : "Bill to"}</span><b class="u-pname" style="${box(56, 332)}">${esc(u.result)}</b><span class="u-line" style="${box(56, 384, 240, 14)}"></span><div class="u-thead" style="${box(56, 470, pw - 112, 40)}"><span class="u-th" style="left:0">#</span><span class="u-th" style="left:60px">${ru ? "Описание" : "Description"}</span><span class="u-th" style="right:220px">${ru ? "Кол." : "Qty"}</span><span class="u-th" style="right:0">${ru ? "Сумма" : "Amount"}</span></div>${lines}<span class="u-rule" style="${box(pw - 520, totY - 16, 464, 3)}"></span><span class="u-totl" style="${box(pw - 520, totY + 6)}">${ru ? "Итого:" : "Total:"}</span><span class="u-tot mono" style="${box(pw - 340, totY, 284)}">${cv ? counter(c, "tot", totalText, 0, 0.46 * D, 0.9, tl, counts, "") : esc(totalText)}</span><span class="u-btn dark" id="${c.id}-btn" style="${box(pw / 2 - 130, btnY, 260, 64)}"><span id="${c.id}-btna">${esc(u.action)}</span><span class="u-swap" id="${c.id}-btnb">✓ ${esc(u.action)}</span></span></div>`;
  const tClick = 0.78 * D;
  const bx = 80 + pw / 2;
  const by = 40 + btnY + 32;
  const cur = cursor(c, [{ t: tClick, x: bx, y: by, click: true, press: [`#${c.id}-btn`] }]);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.fromTo("#${c.id}-paper .u-irow", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.4, stagger: 0.08, ease: "power2.out" }, ${f(c.t0 + 0.3 * D)});`);
  tl.push(`tl.to("#${c.id}-btna", { opacity: 0, duration: 0.12 }, ${f(c.t0 + tClick + 0.08)});`);
  tl.push(`tl.fromTo("#${c.id}-btnb", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, ${f(c.t0 + tClick + 0.1)});`);
  cues.push({ t: r3(c.t0 + 0.3 * D), kind: "swipe", gain: -4 }, { t: r3(c.t0 + 0.46 * D), kind: "tick" });
  return {
    w: W,
    h: H,
    html: paper + cur.html,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D) : [
      { t: 0, cx: 380, cy: 200, zw: 760, ry: 12, rx: 4 },
      { t: 0.22 * D, cx: W - 360, cy: 180, zw: 760, ease: "power2.inOut" },
      { t: 0.5 * D, cx: W - 420, cy: 40 + totY, zw: 820, ease: "power2.inOut" },
      { t: tClick, cx: W / 2, cy: by - 60, zw: 860, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: H / 2 + 80, zw: 1220, ease: "power2.inOut" },
    ],
  };
}

function calendar(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const W = 1360;
  const CW = 170;
  const CH = 128;
  const gx = 80;
  const gy = 220;
  const H = gy + 5 * CH + 80;
  const ru = c.lang === "ru";
  const days = ru ? ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"] : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const offset = 2;
  const cell = (d: number) => ({ x: gx + ((d - 1 + offset) % 7) * CW, y: gy + Math.floor((d - 1 + offset) / 7) * CH });
  const clickDay = Number(u.action) || 15;
  const cells: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const p = cell(d);
    if (p.y >= gy + 5 * CH) continue;
    cells.push(`<span class="u-day${d === clickDay ? " sel" : ""}" id="${c.id}-d${d}" style="${box(p.x, p.y, CW - 8, CH - 8)}"><i>${d}</i></span>`);
  }
  const evs = u.items
    .map((e, k) => {
      const p = cell(Number(e.value));
      const [fg, bg] = statusColor(e.label);
      tl.push(`tl.fromTo("#${c.id}-e${k}", { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: "back.out(2)" }, ${f(c.t0 + 0.2 * D + k * 0.12)});`);
      cues.push({ t: r3(c.t0 + 0.2 * D + k * 0.12), kind: "pop", gain: -4 });
      return `<span class="u-ev" id="${c.id}-e${k}" style="${box(p.x + 10, p.y + 56, CW - 28)};color:${fg === "#52525B" ? c.accent : fg};background:${bg === "#F4F4F5" ? `${c.accent}1F` : bg}">${esc(e.label)}</span>`;
    })
    .join("");
  const cp = cell(clickDay);
  const tClick = 0.62 * D;
  const cur = cursor(c, [{ t: tClick, x: cp.x + CW / 2, y: cp.y + 40, click: true, press: [`#${c.id}-d${clickDay}`] }]);
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.to("#${c.id}-d${clickDay}", { backgroundColor: "${c.accent}", color: "#FFFFFF", duration: 0.25 }, ${f(c.t0 + tClick + 0.1)});`);
  tl.push(`tl.fromTo("#${c.id}-enew", { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: "back.out(2)" }, ${f(c.t0 + tClick + 0.2)});`);
  const newEv = `<span class="u-ev" id="${c.id}-enew" style="${box(cp.x + 10, cp.y + 56, CW - 28)};color:#fff;background:rgba(255,255,255,0.22)">${esc(u.result || c.product.name)}</span>`;
  const head = `<b class="u-h1" style="${box(gx, 70)}">${esc(u.title)}</b><span class="u-btn light" style="${box(W - 300, 70, 80, 52)}">‹</span><span class="u-btn light" style="${box(W - 200, 70, 80, 52)}">›</span>${days.map((d, k) => `<span class="u-th" style="${box(gx + k * CW + 12, gy - 44)}">${d}</span>`).join("")}`;
  tl.push(`tl.fromTo("#${c.id}-grid .u-day", { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.3, ease: "power2.out", stagger: { each: 0.012, from: "start" } }, ${f(c.t0 + 0.05)});`);
  return {
    w: W,
    h: H,
    html: `<div class="u-card" style="${box(30, 30, W - 60, H - 60)}"></div><div id="${c.id}-grid">${head}${cells.join("")}${evs}${newEv}</div>${cur.html}`,
    tl,
    cues,
    counts,
    cam: [
      { t: 0, cx: 420, cy: 300, zw: 900, ry: -10, rx: 8 },
      { t: tClick, cx: cp.x + CW / 2, cy: cp.y + 30, zw: 860, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: H / 2, zw: W + 40, ease: "power2.inOut" },
    ],
  };
}

function search(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 900 : 1200;
  const H = 980;
  const word = u.title || c.product.name;
  const bx = P ? 40 : 120;
  const by = 330;
  const bw = W - 2 * bx;
  const tType = 0.2 * D;
  const typeDur = Math.min(1.6, 0.36 * D);
  const results = u.items.map((it, k) => `<div class="u-res" id="${c.id}-res${k}" style="${box(bx, by + 150 + k * 140, bw, 120)}"><b>${esc(it.label)}</b><i>${esc(it.sub || it.value)}</i></div>`).join("");
  const html = `<b class="u-word" id="${c.id}-word" style="${box(0, 120, W)}">${esc(word)}<span style="color:${c.accent}">.</span></b><div class="u-sbar" id="${c.id}-bar" style="${box(bx, by, bw, 100)}"><span class="u-sq">${typed(c, "q", u.action, tType, typeDur, tl, cues)}</span><span class="u-sico" id="${c.id}-sico" style="${box(bw - 84, 22, 56, 56)}">${c.icon("search")}</span></div>${results}`;
  tl.push(`tl.fromTo("#${c.id}-word", { opacity: 0, y: 30, filter: "blur(12px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.6, ease: "power3.out" }, ${f(c.t0 + 0.02)});`);
  tl.push(`tl.fromTo("#${c.id}-bar", { opacity: 0, scaleX: 0.7 }, { opacity: 1, scaleX: 1, duration: 0.5, ease: "power3.out" }, ${f(c.t0 + 0.1)});`);
  const tClick = tType + typeDur + 0.25;
  const cur = cursor(
    c,
    [
      { t: tType - 0.05, x: bx + 120, y: by + 60, click: true },
      { t: tClick, x: bx + bw - 56, y: by + 52, click: true, press: [`#${c.id}-sico`] },
    ],
    { hand: true, size: 44 },
  );
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.fromTo("#${c.id}-ui .u-res", { opacity: 0, y: 30, filter: "blur(8px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.45, ease: "power2.out", stagger: 0.1 }, ${f(c.t0 + tClick + 0.2)});`);
  for (let k = 0; k < u.items.length; k++) cues.push({ t: r3(c.t0 + tClick + 0.2 + k * 0.1), kind: "pop", gain: -6 });
  return {
    w: W,
    h: H,
    html: `<div id="${c.id}-ui">${html}</div>${cur.html}`,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D, { tilt: false }) : [
      { t: 0, cx: W / 2, cy: 260, zw: 1000 },
      { t: tType + 0.1, cx: bx + 260, cy: by + 50, zw: 700, ease: "power2.inOut" },
      { t: tType + typeDur, cx: bx + bw - 260, cy: by + 50, zw: 720, ease: "sine.inOut" },
      { t: D, cx: W / 2, cy: by + 240, zw: 1150, ease: "power2.inOut" },
    ],
  };
}

function folders(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  const P = !!c.portrait;
  const W = P ? 760 : 1400;
  const H = 1000;
  const cx = P ? 60 : 300;
  const cy = 120;
  const cw = 640;
  const RH = 92;
  const n = u.items.length;
  const pick = Math.max(0, u.items.findIndex((x) => x.label === u.result));
  const rows = u.items.map((it, k) => `<div class="u-frow2" id="${c.id}-f${k}" style="${box(30, 150 + k * RH, cw - 60, RH - 8)}"><span class="u-fold">${c.icon("folder")}</span><b>${esc(it.label)}</b><i>${esc(it.value)}</i></div>`).join("");
  const card = `<div class="u-card u-drive" id="${c.id}-card" style="${box(cx, cy, cw, 190 + n * RH)}"><b class="u-dtitle">${esc(u.title)}</b><span class="u-dsico">${c.icon("search")}</span><span class="u-hov" id="${c.id}-hov" style="${box(18, 150, cw - 36, RH - 8)}"></span>${rows}</div>`;
  const pickIt = u.items[pick];
  const ghost = `<div class="u-frow2 u-ghost" id="${c.id}-gh" style="${box(cx + 30, cy + 150 + pick * RH, cw - 60, RH - 8)}"><span class="u-fold">${c.icon("folder")}</span><b>${esc(pickIt.label)}</b><i>${esc(pickIt.value)}</i></div>`;
  tl.push(`tl.fromTo("#${c.id}-card", { y: 60, opacity: 0, scale: 0.94, filter: "blur(10px)" }, { y: 0, opacity: 1, scale: 1, filter: "blur(0px)", duration: 0.55, ease: "power3.out" }, ${f(c.t0 + 0.02)});`);
  tl.push(`tl.fromTo("#${c.id}-card .u-frow2", { x: -20, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: "power2.out", stagger: 0.05 }, ${f(c.t0 + 0.15)});`);
  cues.push({ t: r3(c.t0 + 0.02), kind: "swish" });
  // the hover bar steps down the rows to the picked one
  const tHover = 0.2 * D;
  const stepDur = Math.min(0.28, (0.3 * D) / Math.max(1, pick + 1));
  tl.push(`tl.fromTo("#${c.id}-hov", { opacity: 0, y: 0 }, { opacity: 1, y: 0, duration: 0.15 }, ${f(c.t0 + tHover)});`);
  for (let k = 1; k <= pick; k++) {
    tl.push(`tl.to("#${c.id}-hov", { y: ${k * RH}, duration: ${f(stepDur * 0.8)}, ease: "power2.out" }, ${f(c.t0 + tHover + k * stepDur)});`);
    cues.push({ t: r3(c.t0 + tHover + k * stepDur), kind: "tick", gain: -4 });
  }
  const tPick = tHover + (pick + 1) * stepDur + 0.15;
  const gx = cx + cw / 2;
  const gy = cy + 150 + pick * RH + RH / 2;
  const tDrop = Math.min(D - 0.4, tPick + 0.35 * D);
  const steps: CursorStep[] = [];
  for (let k = 0; k <= pick; k++) steps.push({ t: tHover + k * stepDur + 0.05, x: gx + 40, y: cy + 150 + k * RH + RH / 2, move: k === 0 ? 0.5 : stepDur * 0.8 });
  steps.push({ t: tPick, x: gx + 40, y: gy, click: true });
  steps.push({ t: tDrop, x: gx + 40 + 420, y: gy - 260, move: tDrop - tPick - 0.1 });
  const cur = cursor(c, steps, { hand: true, size: 44 });
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  tl.push(`tl.fromTo("#${c.id}-gh", { opacity: 0, scale: 1 }, { opacity: 1, scale: 1.06, duration: 0.2, ease: "power2.out" }, ${f(c.t0 + tPick + 0.05)});`);
  tl.push(`tl.to("#${c.id}-gh", { x: 420, y: -260, rotation: -3, duration: ${f(tDrop - tPick - 0.12)}, ease: "power2.inOut" }, ${f(c.t0 + tPick + 0.12)});`);
  tl.push(`tl.to("#${c.id}-card", { opacity: 0.55, filter: "blur(3px)", duration: 0.5 }, ${f(c.t0 + tPick + 0.2)});`);
  cues.push({ t: r3(c.t0 + tPick + 0.12), kind: "whoosh", gain: -6, pan: 0.45, rate: 1.05 } as SfxCue);
  return {
    w: W,
    h: H,
    html: card + ghost + cur.html,
    tl,
    cues,
    counts,
    fitsPortrait: P,
    cam: P ? vcam(W, H, D, { tilt: false }) : [
      { t: 0, cx: cx + cw / 2, cy: cy + 260, zw: 900 },
      { t: tPick, cx: gx + 40, cy: gy, zw: 760, ease: "power2.inOut" },
      { t: D, cx: gx + 300, cy: gy - 160, zw: 980, ease: "power2.inOut" },
    ],
  };
}


/** An AI prompt bar: the request is typed, sent, the sparkle thinks, the result builds itself (table/slides/files/text). */
function prompt(c: UiCtx, u: Ui): UiBuild {
  const tl: string[] = [];
  const cues: SfxCue[] = [];
  const counts: Record<string, string> = {};
  const D = c.dur;
  // 9:16: a narrow canvas the camera shows whole (UI ≈ 88% of the frame width), type ≥ 34 px on screen
  const P = !!c.portrait;
  const W = P ? 860 : 1200;
  const ru = c.lang === "ru";
  const bx = P ? 30 : 70;
  const by = P ? 40 : 70;
  const bw = W - 2 * bx;
  const qLines = P && [...u.action].length * 0.53 * 42 > bw - 230 ? 2 : 1;
  const bh = P ? (qLines === 2 ? 190 : 132) : 116;
  const tType = 0.12 * D;
  const typeDur = Math.min(1.5, Math.max(0.7, [...u.action].length * 0.045));
  const tSend = tType + typeDur + 0.22;
  const tRes = tSend + 0.62;
  const ry = by + bh + 50;
  const out: string[] = [];
  let rh = 200;
  let focus = { cx: W / 2, cy: ry + 100 };
  if (u.title === "table") {
    const n = u.rows.length;
    const nc = u.columns.length;
    const colW = (bw - 60) / nc;
    const RH = P ? 112 : 74;
    rh = 80 + n * RH + 30;
    const head = u.columns.map((h, k) => `<span class="u-th" style="left:${Math.round(30 + k * colW)}px">${esc(h)}</span>`).join("");
    const rows = u.rows.map((r, i) => `<div class="u-prow${P ? " big" : ""}" id="${c.id}-pr${i}" style="${box(0, 70 + i * RH, bw, RH)}">${r.map((cell, k) => `<span class="u-pc${k === 0 ? " b" : ""}" style="left:${Math.round(30 + k * colW)}px">${esc(cell)}</span>`).join("")}</div>`).join("");
    out.push(`<div class="u-card" id="${c.id}-res" style="${box(bx, ry, bw, rh)}"><div class="u-thead" style="${box(0, 16, bw, 50)}">${head}</div>${rows}<span class="u-sweep" id="${c.id}-sw"></span></div>`);
    tl.push(`tl.fromTo("#${c.id}-res", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }, ${f(c.t0 + tRes)});`);
    tl.push(`tl.fromTo("#${c.id}-res .u-prow", { opacity: 0, y: 14, filter: "blur(6px)" }, { opacity: 1, y: 0, filter: "blur(0px)", duration: 0.35, ease: "power2.out", stagger: 0.12 }, ${f(c.t0 + tRes + 0.15)});`);
    tl.push(`tl.fromTo("#${c.id}-sw", { x: ${-bw}, opacity: 1 }, { x: ${bw}, opacity: 1, duration: 0.9, ease: "power1.inOut" }, ${f(c.t0 + tRes + 0.1)});`);
    for (let i = 0; i < n; i++) cues.push({ t: r3(c.t0 + tRes + 0.15 + i * 0.12), kind: "tick", gain: -3 });
    focus = { cx: W / 2, cy: ry + rh / 2 - 40 };
  } else if (u.title === "slides") {
    const n = u.items.length;
    const cols = P ? (n >= 4 ? 2 : 1) : 2;
    const sw = (bw - (cols - 1) * 30) / cols;
    const sh = Math.round(sw * (P ? (cols === 2 ? 0.8 : 0.42) : 0.5625));
    rh = Math.ceil(n / cols) * (sh + 30);
    u.items.forEach((it, k) => {
      const x = bx + (k % cols) * (sw + 30);
      const y = ry + Math.floor(k / cols) * (sh + 30);
      const tone = ["#E8F0FE", "#FCE8E6", "#E6F4EA", "#FEF7E0"][k % 4];
      out.push(`<div class="u-slide${P ? (cols === 2 ? " big two" : " big") : ""}" id="${c.id}-sl${k}" style="${box(x, y, sw, sh)}"><span class="u-slbar" style="background:${c.accent}"></span><b class="u-slt">${esc(it.label)}</b><i class="u-sls">${esc(it.sub || it.value)}</i><span class="u-slart" style="background:${tone}"></span><span class="u-slno">${k + 1}</span></div>`);
      tl.push(`tl.fromTo("#${c.id}-sl${k}", { opacity: 0, scale: 0.85, y: 30, filter: "blur(10px)" }, { opacity: 1, scale: 1, y: 0, filter: "blur(0px)", duration: 0.5, ease: "back.out(1.5)" }, ${f(c.t0 + tRes + k * 0.16)});`);
      cues.push({ t: r3(c.t0 + tRes + k * 0.16), kind: "pop", gain: -4 });
    });
    focus = { cx: W / 2, cy: ry + rh / 2 };
  } else if (u.title === "files") {
    const n = u.items.length;
    const FR = P ? 104 : 92;
    rh = 40 + n * FR + (u.result_sub ? (P ? 170 : 120) : 20);
    const pick = Math.max(0, u.items.findIndex((x) => x.label === u.result));
    const ficon = (name: string) => (/\.(xlsx?|csv)$/i.test(name) ? "file-spreadsheet" : /\.(png|jpe?g)$/i.test(name) ? "image" : /\.(pptx?|key)$/i.test(name) ? "presentation" : /\./.test(name) ? "file-text" : "folder");
    const rows = u.items.map((it, k) => `<div class="u-frow2${k === pick ? " u-found" : ""}" id="${c.id}-fl${k}" style="${box(24, 30 + k * FR, bw - 48, FR - 12)}"><span class="u-fold">${c.icon(ficon(it.label))}</span><b>${esc(it.label)}</b><i>${esc(it.value)}</i></div>`).join("");
    const ans = u.result_sub ? `<div class="u-ans${P ? " mid" : ""}" id="${c.id}-ans" style="${box(24, 40 + n * FR, bw - 48, P ? 140 : 84)}"><span class="u-bai">${SPARKLE(`${c.id}-ag`)}</span>${blurWords(c, "aw", u.result_sub, tRes + 0.9, tl, 0.04)}</div>` : "";
    out.push(`<div class="u-card${P ? " pfiles" : ""}" id="${c.id}-res" style="${box(bx, ry, bw, rh)}"><span class="u-hov" id="${c.id}-hl" style="${box(18, 26 + pick * FR, bw - 36, FR - 4)}"></span>${rows}${ans}</div>`);
    tl.push(`tl.fromTo("#${c.id}-res", { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }, ${f(c.t0 + tRes - 0.05)});`);
    tl.push(`tl.fromTo("#${c.id}-res .u-frow2", { opacity: 0, x: -20 }, { opacity: 1, x: 0, duration: 0.3, stagger: 0.06, ease: "power2.out" }, ${f(c.t0 + tRes)});`);
    tl.push(`tl.fromTo("#${c.id}-hl", { opacity: 0, scaleX: 0.6 }, { opacity: 1, scaleX: 1, duration: 0.35, ease: "power3.out" }, ${f(c.t0 + tRes + 0.55)});`);
    tl.push(`tl.to("#${c.id}-fl${pick}", { scale: 1.03, duration: 0.18, yoyo: true, repeat: 1 }, ${f(c.t0 + tRes + 0.6)});`);
    if (ans) tl.push(`tl.fromTo("#${c.id}-ans", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.35 }, ${f(c.t0 + tRes + 0.85)});`);
    cues.push({ t: r3(c.t0 + tRes + 0.55), kind: "chime" });
    focus = { cx: W / 2, cy: ry + 30 + pick * FR + 40 };
  } else {
    rh = P ? Math.max(320, 110 + Math.ceil([...u.result].length / 22) * 66) : 220;
    out.push(`<div class="u-card u-ans big${P ? " tall" : ""}" id="${c.id}-res" style="${box(bx, ry, bw, rh)}"><span class="u-bai">${SPARKLE(`${c.id}-ag`)}</span>${blurWords(c, "aw", u.result, tRes + 0.1, tl, 0.05)}</div>`);
    tl.push(`tl.fromTo("#${c.id}-res", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.4 }, ${f(c.t0 + tRes)});`);
    cues.push({ t: r3(c.t0 + tRes), kind: "chime" });
    focus = { cx: W / 2, cy: ry + rh / 2 };
  }
  const H = ry + rh + 80;
  // the thinking shimmer between the send and the result
  const think = `<div class="u-think" id="${c.id}-th" style="${box(bx + 20, ry + 10, bw - 40, 120)}"><span class="u-tl" style="width:92%"></span><span class="u-tl" style="width:74%;top:44px"></span><span class="u-tl" style="width:56%;top:88px"></span></div>`;
  tl.push(`tl.fromTo("#${c.id}-th", { opacity: 0 }, { opacity: 1, duration: 0.15 }, ${f(c.t0 + tSend + 0.05)});`);
  tl.push(`tl.fromTo("#${c.id}-th .u-tl", { backgroundPosition: "100% 0%" }, { backgroundPosition: "-100% 0%", duration: 0.6, ease: "none" }, ${f(c.t0 + tSend + 0.05)});`);
  tl.push(`tl.to("#${c.id}-th", { opacity: 0, duration: 0.15 }, ${f(c.t0 + tRes - 0.05)});`);
  tl.push(`tl.fromTo("#${c.id}-psp", { rotation: 0 }, { rotation: 180, duration: 0.7, ease: "power2.inOut" }, ${f(c.t0 + tSend)});`);
  cues.push({ t: r3(c.t0 + tSend + 0.08), kind: "riser", gain: -10 });
  const bar = `<div class="u-pbar2${P ? " big" : ""}" id="${c.id}-bar" style="${box(bx, by, bw, bh)}"><span class="u-psp" id="${c.id}-psp">${SPARKLE(`${c.id}-bg`)}</span><span class="u-ph" id="${c.id}-ph">${ru ? "Спросите что угодно" : "Ask anything"}</span><span class="u-sq${qLines === 2 ? " wrap" : ""}" style="font-size:${P ? 42 : Math.round(Math.min(38, (bw - 230) / (Math.max(1, [...u.action].length) * 0.53)))}px">${typed(c, "q", u.action, tType, typeDur, tl, cues)}</span><span class="u-send" id="${c.id}-send" style="${box(bw - 92, 24, 64, 64)}">${c.icon("arrow-up")}</span></div>`;
  tl.push(`tl.fromTo("#${c.id}-bar", { opacity: 0, y: 30, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "power3.out" }, ${f(c.t0 + 0.02)});`);
  tl.push(`tl.to("#${c.id}-ph", { opacity: 0, duration: 0.1 }, ${f(c.t0 + tType)});`);
  const cur = cursor(
    c,
    [
      { t: tType - 0.08, x: bx + 260, y: by + bh / 2 + 20, click: true },
      { t: tSend, x: bx + bw - 60, y: by + bh / 2 + 10, click: true, press: [`#${c.id}-send`] },
    ],
    { hand: true, size: 46 },
  );
  tl.push(...cur.tl);
  cues.push(...cur.cues);
  if (P)
    // the whole width stays in view: the camera only travels down from the bar to the result and breathes in a little
    return {
      w: W,
      h: H,
      html: bar + think + out.join("") + cur.html,
      tl,
      cues,
      counts,
      fitsPortrait: true,
      cam: (() => {
        // canvas → frame: scale ≈ 1080·0.94 / zw; put the bar's centre at frac·1920 (between 30 % and 40 %), so the
        // result fills the frame below it (towards ~80 %)
        const zw = W + 20;
        const sc = (1080 * 0.94) / zw;
        // while typing only the bar is on screen: it sits in the middle (~45 % height); when the result arrives the
        // camera glides so that bar + result are centred together (filling the frame from ~20 % to ~80 %)
        const barCy = by + bh / 2 + (1920 * 0.05) / sc;
        const blockCy = (by + ry + rh) / 2 + (1920 * 0.02) / sc;
        return [
          { t: 0, cx: W / 2, cy: barCy + 20, zw: zw + 40 },
          { t: tType + typeDur, cx: W / 2, cy: barCy, zw: zw - 40, ease: "sine.inOut" },
          { t: tRes + 0.35, cx: W / 2, cy: blockCy, zw, ease: "power2.inOut" },
          { t: D, cx: W / 2, cy: blockCy + 10, zw: zw - 20, ease: "sine.inOut" },
        ];
      })(),
    };
  return {
    w: W,
    h: H,
    html: bar + think + out.join("") + cur.html,
    tl,
    cues,
    counts,
    cam: [
      { t: 0, cx: bx + 380, cy: by + bh / 2 + 40, zw: 820 },
      { t: tType + typeDur, cx: Math.min(bx + bw - 380, bx + 300 + [...u.action].length * 9), cy: by + bh / 2 + 40, zw: 820, ease: "sine.inOut" },
      { t: tRes + 0.2, cx: focus.cx, cy: Math.min(focus.cy, H / 2 + 40), zw: 1120, ease: "power2.inOut" },
      { t: D, cx: W / 2, cy: Math.min(focus.cy, H / 2 + 60) + 20, zw: 1200, ease: "sine.inOut" },
    ],
  };
}

const BUILDERS: Record<Ui["kind"], (c: UiCtx, u: Ui) => UiBuild> = { table, form, kanban, tiles, metrics, chart, flow, list, chat, invoice, calendar, search, folders, prompt };

/** The seconds a UI scene needs to play its story (camera + cursor) at a comfortable pace. */
export function uiSeconds(u: Ui): number {
  const base: Record<Ui["kind"], number> = { table: 4.2, form: 4.6, kanban: 4.4, tiles: 3.8, metrics: 3.6, chart: 4.0, flow: 4.6, list: 4.4, chat: 4.2, invoice: 4.4, calendar: 4.0, search: 4.4, folders: 4.0, prompt: 4.8 };
  let s = base[u.kind];
  if (u.kind === "chat") s += Math.max(0, u.items.length - 2) * 0.9;
  if (u.kind === "form") s += Math.max(0, u.items.length - 3) * 0.5;
  if (u.kind === "prompt") s += Math.max(0, [...u.action].length - 30) * 0.03;
  return Math.round(s * 10) / 10;
}

export function buildUi(c: UiCtx, u: Ui): UiBuild {
  return BUILDERS[u.kind](c, u);
}

/** Icons the components may ask for (preloaded by compose). */
export const UI_ICONS = ["arrow-up", "file-text", "image", "presentation", "check", "circle-check", "bell", "search", "folder", "table-2", "file-spreadsheet", "mail", "phone", "instagram", "linkedin", "wallet", "users", "trending-up", "landmark", "rocket", "circle-dot", "sheet"];

/** Styles of the components (one block per composition). */
export function uiCss(accent: string): string {
  return `
      .u-cv { position: absolute; left: 0; top: 0; transform-origin: 0 0; font-family: "VInter", sans-serif; color: #111114; }
      .u-cv * { box-sizing: border-box; }
      .u-cv [style*="left:"] { position: absolute; }
      .u-win, .u-card { background: #FFFFFF; border-radius: 26px; border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 30px 80px rgba(20,20,30,0.12), 0 4px 14px rgba(20,20,30,0.05); overflow: hidden; display: block; }
      .u-bar { position: absolute; left: 0; right: 0; top: 0; height: 58px; border-bottom: 1px solid #EFEFF2; display: block; background: #FAFAFB; }
      .u-bar > i { position: absolute; top: 22px; width: 14px; height: 14px; border-radius: 50%; background: #E2E2E6; display: block; }
      .u-bar > i:nth-child(1) { left: 22px; } .u-bar > i:nth-child(2) { left: 44px; } .u-bar > i:nth-child(3) { left: 66px; }
      .u-bar > span { position: absolute; left: 100px; top: 17px; font-size: 20px; font-weight: 600; color: #8A8A93; display: block; }
      .u-h1 { font-size: 40px; font-weight: 700; letter-spacing: -0.02em; display: block; white-space: nowrap; }
      .u-btn { display: flex; align-items: center; justify-content: center; border-radius: 16px; font-size: 21px; font-weight: 650; white-space: nowrap; }
      .u-btn.dark { background: #141416; color: #FFFFFF; box-shadow: 0 8px 20px rgba(0,0,0,0.18); }
      .u-btn.light { background: #F2F2F5; color: #3A3A40; }
      .u-btn > span { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
      .u-swap { opacity: 0; }
      .u-swap.ok { color: #16A34A; }
      .u-thead { display: block; border-bottom: 1px solid #EFEFF2; }
      .u-th { position: absolute; top: 10px; font-size: 18px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: #9A9AA3; white-space: nowrap; display: block; }
      .u-row { display: block; border-bottom: 1px solid #F2F2F4; }
      .u-cell { top: 0; height: 100%; display: flex; align-items: center; gap: 12px; font-size: 24px; color: #3A3A40; white-space: nowrap; }
      .u-cell > span, .u-cell > b { position: relative; }
      .u-c0 b { font-weight: 650; color: #111114; }
      .u-hl { position: absolute; inset: 0; display: block; background: ${accent}22; opacity: 0; }
      .u-av { display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: 50%; color: #fff; font-weight: 700; font-size: 18px; position: relative; flex: 0 0 auto; }
      .u-av.big { position: absolute; width: 130px; height: 130px; font-size: 44px; }
      .u-av.sm { width: 34px; height: 34px; font-size: 13px; }
      .u-chip { display: inline-flex; align-items: center; gap: 8px; padding: 7px 16px; border-radius: 999px; font-size: 19px; font-weight: 650; white-space: nowrap; }
      .u-cell .u-chip { position: absolute; left: 0; top: 50%; margin-top: -19px; }
      .u-chip > b { position: relative; width: 9px; height: 9px; border-radius: 50%; display: block; }
      .u-ic { display: inline-flex; position: relative; flex: 0 0 auto; }
      .u-ic svg, .u-tico svg, .u-ckf svg, .u-fold svg, .u-sico svg, .u-dsico svg { width: 100%; height: 100%; display: block; }
      .u-cur { position: absolute; left: 0; top: 0; display: block; z-index: 50; transform-origin: 0 0; opacity: 0; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.25)); }
      .u-cur.hand { transform-origin: 30% 10%; }
      .u-rip { display: block; border-radius: 50%; border: 2px solid ${accent}; background: transparent; opacity: 0; z-index: 49; }
      .u-toast { display: flex; align-items: center; gap: 18px; padding: 18px 24px; border-radius: 22px; background: rgba(255,255,255,0.96); border: 1px solid rgba(0,0,0,0.06); box-shadow: 0 24px 60px rgba(0,0,0,0.16); z-index: 40; }
      .u-tico { position: relative; width: 48px; height: 48px; border-radius: 14px; color: #fff; padding: 10px; flex: 0 0 auto; display: block; }
      .u-tx { position: relative; display: flex; flex-direction: column; gap: 4px; }
      .u-tx b, .u-tx i { position: relative; }
      .u-tx b { font-size: 23px; font-weight: 650; }
      .u-tx i { font-style: normal; font-size: 18px; color: #8A8A93; }
      .u-line { display: block; border-radius: 9px; background: #EEEEF1; }
      .u-pname { font-size: 34px; font-weight: 700; white-space: nowrap; display: block; }
      .u-psub { font-size: 22px; color: #8A8A93; display: block; }
      .u-mark { display: flex; align-items: center; justify-content: center; border-radius: 12px; background: #141416; color: #fff; font-weight: 800; font-size: 24px; }
      .u-mark.sm { position: relative; width: 40px; height: 40px; font-size: 20px; }
      .u-ptitle { font-size: 26px; font-weight: 700; display: block; }
      .u-flab { font-size: 16px; font-weight: 650; letter-spacing: 0.08em; text-transform: uppercase; color: #9A9AA3; display: block; }
      .u-input { display: flex; align-items: center; padding: 0 22px; border-radius: 14px; border: 2px solid #E6E6EA; font-size: 24px; color: #222; background: #FCFCFD; }
      .u-typed { position: relative; display: inline-flex; align-items: center; white-space: pre; }
      .u-caret { display: inline-block; width: 3px; height: 1.1em; margin-left: 2px; background: ${accent}; opacity: 0; }
      .u-kcol { display: block; background: #F4F4F6; border-radius: 22px; }
      .u-khead { position: absolute; left: 22px; top: 22px; display: flex; align-items: center; gap: 10px; font-size: 22px; font-weight: 650; color: #3A3A40; white-space: nowrap; }
      .u-khead > b { position: relative; width: 10px; height: 10px; border-radius: 50%; display: block; }
      .u-khead > i { position: relative; font-style: normal; color: #A0A0A8; }
      .u-ktot { position: absolute; left: 22px; top: 70px; font-size: 40px; font-weight: 750; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; display: block; }
      .u-kcard { display: block; background: #fff; border-radius: 18px; border: 1px solid rgba(0,0,0,0.05); box-shadow: 0 6px 18px rgba(0,0,0,0.06); }
      .u-kcard.u-moving { z-index: 30; box-shadow: 0 24px 50px rgba(0,0,0,0.18); }
      .u-kval { position: absolute; left: 20px; top: 16px; font-size: 30px; font-weight: 750; display: block; }
      .u-kcard > b { position: absolute; left: 20px; top: 62px; font-size: 21px; font-weight: 600; color: #3A3A40; white-space: nowrap; display: block; }
      .u-kmeta { position: absolute; left: 20px; top: 102px; display: flex; align-items: center; gap: 8px; font-size: 16px; color: #9A9AA3; white-space: nowrap; }
      .u-tile { padding: 0; }
      .u-tlab { position: absolute; left: 36px; top: 34px; display: flex; align-items: center; gap: 12px; font-size: 26px; font-weight: 650; color: #3A3A40; white-space: nowrap; }
      .u-num { font-variant-numeric: tabular-nums; white-space: nowrap; display: inline-block; }
      .u-num.big { font-size: 150px; font-weight: 750; letter-spacing: -0.04em; line-height: 1; }
      .u-num.good { color: #16A34A; }
      .u-tile .u-num { position: absolute; left: 32px; top: 110px; }
      .u-tsub { position: absolute; left: 40px; top: 280px; font-size: 24px; color: #9A9AA3; display: block; }
      .u-pbar { position: absolute; left: 40px; right: 40px; bottom: 44px; height: 10px; border-radius: 5px; background: #EFEFF2; display: block; overflow: hidden; }
      .u-pfill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; display: block; background: #141416; border-radius: 5px; transform-origin: 0 50%; }
      .u-metric .u-num { position: absolute; left: 34px; top: 92px; font-size: 104px; }
      .u-mlab { position: absolute; left: 36px; top: 34px; font-size: 22px; font-weight: 600; color: #8A8A93; white-space: nowrap; display: block; }
      .u-mlab i { position: relative; font-style: normal; }
      .u-msub { position: absolute; left: 38px; top: 226px; font-size: 20px; color: #A0A0A8; display: block; white-space: nowrap; }
      .u-delta { font-size: 24px; font-weight: 700; color: #16A34A; background: #DCFCE7; padding: 6px 14px; border-radius: 12px; display: block; }
      .u-svg { position: absolute; left: 0; top: 0; overflow: visible; }
      .u-dot { display: block; border-radius: 50%; background: #fff; border: 7px solid; }
      .u-tip { display: block; text-align: center; padding: 10px 0; border-radius: 14px; background: #141416; color: #fff; font-size: 19px; font-weight: 650; }
      .u-xl { text-align: center; font-size: 18px; color: #9A9AA3; display: block; }
      .u-frow { display: flex; align-items: center; gap: 14px; padding: 0 18px; border-radius: 14px; background: #F0FBF3; font-size: 22px; font-weight: 600; color: #2F5E3E; white-space: nowrap; }
      .u-ftitle { display: flex; align-items: center; gap: 10px; font-size: 26px; font-weight: 700; white-space: nowrap; }
      .u-hub { display: flex; align-items: center; justify-content: center; border-radius: 44px; background: #fff; box-shadow: 0 30px 70px rgba(99,102,241,0.28), 0 0 0 1px rgba(0,0,0,0.04); }
      .u-spark { position: relative; width: 92px; height: 92px; display: block; }
      .u-hlab { text-align: center; font-size: 20px; color: #8A8A93; display: block; }
      .u-tgt { display: flex; align-items: center; justify-content: center; border-radius: 42px; background: #141416; color: #fff; font-size: 84px; font-weight: 800; box-shadow: 0 30px 70px rgba(0,0,0,0.25); }
      .u-lrow { display: block; border-top: 1px solid #F2F2F4; }
      .u-check { display: block; border-radius: 50%; border: 3px solid #D4D4DA; background: #fff; }
      .u-ckf { position: absolute; inset: 5px; color: #fff; opacity: 0; display: block; }
      .u-ltitle { font-size: 27px; font-weight: 650; white-space: nowrap; display: block; }
      .u-lmeta { display: flex; align-items: center; gap: 10px; font-size: 20px; color: #6A6A73; white-space: nowrap; }
      .u-lmeta > span, .u-lmeta > i { position: relative; }
      .u-lmeta > i { font-style: normal; color: #A0A0A8; margin-left: 14px; }
      .u-badge { width: 48px; height: 40px; border-radius: 12px; background: #FFF1E6; color: #EA580C; font-weight: 750; font-size: 21px; display: flex; align-items: center; justify-content: center; }
      .u-bub { display: block; padding: 22px 28px; border-radius: 30px; font-size: 27px; line-height: 44px; }
      .u-bub.me { color: #fff; border-bottom-right-radius: 8px; }
      .u-bub.ai { background: #F2F2F5; color: #18181B; border-bottom-left-radius: 8px; padding-left: 74px; }
      .u-bub > span { position: relative; display: block; }
      .u-bai { position: absolute; left: 22px; top: 24px; width: 36px; height: 36px; display: block; }
      .u-bw { display: inline-block; }
      .u-typing { display: flex; align-items: center; justify-content: center; gap: 10px; border-radius: 30px; background: #F2F2F5; }
      .u-typing i { position: relative; width: 12px; height: 12px; border-radius: 50%; background: #A0A0A8; display: block; }
      .u-chathead { position: absolute; left: 36px; top: 26px; display: flex; align-items: center; gap: 14px; font-size: 26px; font-weight: 700; }
      .u-paper .u-th { position: absolute; }
      .u-inv { padding: 8px 18px; border-radius: 10px; background: #141416; color: #fff; font-weight: 800; font-size: 20px; letter-spacing: 0.1em; display: block; }
      .u-invno { font-size: 40px; font-weight: 700; display: block; }
      .mono { font-family: "VMono", monospace; }
      .u-irow { display: flex; align-items: center; gap: 30px; font-size: 22px; color: #3A3A40; border-bottom: 1px solid #F2F2F4; }
      .u-irow > * { position: relative; }
      .u-irow b { flex: 1 1 auto; font-weight: 600; }
      .u-irow .r { width: 180px; text-align: right; }
      .u-rule { display: block; background: #141416; }
      .u-totl { font-size: 26px; font-weight: 650; display: block; }
      .u-tot { font-size: 46px; font-weight: 700; text-align: right; display: block; }
      .u-tot .u-num { position: relative; }
      .u-day { display: block; border-radius: 18px; background: #F7F7F9; color: #3A3A40; }
      .u-day > i { position: absolute; left: 16px; top: 12px; font-style: normal; font-size: 22px; font-weight: 600; display: block; }
      .u-ev { display: block; padding: 8px 12px; border-radius: 10px; font-size: 17px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .u-word { text-align: center; font-size: 150px; font-weight: 800; letter-spacing: -0.05em; display: block; }
      .u-word span { position: relative; }
      .u-sbar { display: block; border-radius: 50px; background: #fff; box-shadow: 0 18px 50px rgba(0,0,0,0.12), 0 0 0 1px rgba(0,0,0,0.05); transform-origin: 50% 50%; }
      .u-sq { position: absolute; left: 44px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 40px; font-weight: 500; color: #18181B; }
      .u-sico { color: #3A3A40; display: block; }
      .u-res { display: flex; flex-direction: column; justify-content: center; gap: 8px; padding: 0 36px; border-radius: 22px; background: #fff; box-shadow: 0 12px 34px rgba(0,0,0,0.08); }
      .u-res b, .u-res i { position: relative; }
      .u-res b { font-size: 28px; font-weight: 650; color: ${accent}; }
      .u-res i { font-style: normal; font-size: 21px; color: #8A8A93; }
      .u-drive { border-radius: 56px; }
      .u-dtitle { position: absolute; left: 46px; top: 42px; font-size: 64px; font-weight: 500; color: #7A7A84; display: block; }
      .u-dsico { position: absolute; right: 46px; top: 54px; width: 56px; height: 56px; color: #3A3A40; display: block; }
      .u-hov { display: block; border-radius: 16px; background: linear-gradient(90deg, ${accent}55, ${accent}22); opacity: 0; }
      .u-frow2 { display: flex; align-items: center; gap: 18px; padding: 0 22px; font-size: 30px; color: #222; }
      .u-frow2 b { position: relative; font-weight: 500; flex: 1 1 auto; }
      .u-frow2 i { position: relative; font-style: normal; font-size: 22px; color: #A0A0A8; }
      .u-fold { position: relative; width: 38px; height: 38px; color: ${accent}; display: block; }
      .u-pbar2 { display: block; border-radius: 60px; border: 3px solid transparent; background: linear-gradient(#fff, #fff) padding-box, linear-gradient(90deg, #4F8DF7, #9B72CB 55%, #D96570) border-box; box-shadow: 0 20px 50px rgba(66,103,210,0.18); }
      .u-psp { position: absolute; left: 30px; top: 30px; width: 50px; height: 50px; display: block; }
      .u-ph { position: absolute; left: 100px; top: 0; bottom: 0; display: flex; align-items: center; font-size: 38px; color: #9A9AA3; }
      .u-pbar2 .u-sq { left: 100px; font-size: 38px; }
      .u-send { display: block; padding: 14px; border-radius: 50%; background: #141416; color: #fff; }
      .u-send svg { width: 100%; height: 100%; display: block; }
      .u-think { display: block; }
      .u-tl { position: absolute; left: 0; top: 0; height: 26px; display: block; border-radius: 13px; background: linear-gradient(90deg, #E9ECF5 0%, #D6E0FB 40%, #E9DDF7 60%, #E9ECF5 100%); background-size: 200% 100%; }
      .u-prow { display: block; border-top: 1px solid #F0F0F3; }
      .u-pc { position: absolute; top: 0; bottom: 0; display: flex; align-items: center; font-size: 26px; color: #3A3A40; white-space: nowrap; }
      .u-pc.b { font-weight: 650; color: #111114; }
      .u-sweep { position: absolute; left: 0; top: 0; bottom: 0; width: 60%; display: block; background: linear-gradient(90deg, rgba(120,150,255,0), rgba(120,150,255,0.16), rgba(170,120,230,0)); opacity: 0; }
      .u-slide { display: block; border-radius: 20px; background: #fff; box-shadow: 0 16px 40px rgba(0,0,0,0.1); border: 1px solid rgba(0,0,0,0.05); overflow: hidden; }
      .u-slbar { position: absolute; left: 30px; top: 34px; width: 56px; height: 8px; border-radius: 4px; display: block; }
      .u-slt { position: absolute; left: 30px; top: 58px; right: 30px; font-size: 30px; font-weight: 700; line-height: 1.15; display: block; }
      .u-sls { position: absolute; left: 30px; top: 140px; right: 200px; font-style: normal; font-size: 19px; color: #8A8A93; line-height: 1.3; display: block; }
      .u-slart { position: absolute; right: 26px; bottom: 26px; width: 150px; height: 110px; border-radius: 14px; display: block; }
      .u-slno { position: absolute; right: 24px; top: 22px; font-size: 18px; color: #B0B0B8; display: block; }
      .u-found b { color: #111114; font-weight: 650; }
      .u-ans { display: block; padding: 20px 28px 20px 84px; border-radius: 22px; background: #F4F6FC; font-size: 26px; line-height: 1.35; color: #18181B; }
      .u-ans.big { font-size: 34px; padding: 40px 40px 40px 100px; background: #fff; }
      .u-ans > span:not(.u-bai) { position: relative; display: block; }
      .u-pbar2.big .u-ph { font-size: 42px; }
      .u-win.pt .u-cell { font-size: 32px; }
      .u-win.pt .u-th { font-size: 20px; }
      .u-win.pt .u-h1 { font-size: 46px; }
      .u-tile.pt .u-tlab { font-size: 32px; }
      .u-tile.pt .u-num { top: 84px; font-size: 160px; }
      .u-tile.pt .u-tsub { top: 120px; left: auto; right: 44px; font-size: 32px; }
      .u-metric.pt .u-mlab { font-size: 28px; }
      .u-metric.pt .u-num { top: 78px; font-size: 124px; }
      .u-metric.pt .u-msub { top: 226px; font-size: 26px; }
      .u-card.pt .u-ltitle { font-size: 34px; }
      .u-card.pt .u-lmeta { font-size: 24px; }
      .u-card.pt .u-btn { font-size: 24px; }
      .u-bub.pt { font-size: 34px; line-height: 52px; }
      .u-sq.wrap { right: 120px; align-items: center; line-height: 1.22; }
      .u-sq.wrap .u-typed { white-space: pre-wrap; display: inline; }
      .u-slide.big.two .u-slt { font-size: 36px; right: 20px; }
      .u-slide.big.two .u-sls { font-size: 24px; top: 150px; right: 24px; }
      .u-slide.big.two .u-slart { width: 110px; height: 70px; }
      .u-prow.big .u-pc { font-size: 38px; }
      .u-slide.big .u-slt { font-size: 42px; top: 52px; }
      .u-slide.big .u-sls { font-size: 30px; top: 112px; right: 210px; }
      .pfiles .u-frow2 { font-size: 36px; }
      .pfiles .u-frow2 i { font-size: 26px; }
      .u-ans.mid { font-size: 34px; }
      .u-ans.big.tall { font-size: 44px; line-height: 1.38; }
      .u-ghost { border-radius: 18px; background: #fff; box-shadow: 0 24px 60px rgba(0,0,0,0.22); opacity: 0; z-index: 30; }`;
}

export type { UiItem };
