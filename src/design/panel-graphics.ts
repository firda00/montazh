import { z } from "zod";

/**
 * Code-rendered motion graphics for the top half of split_news (instead of AI images): animated counters
 * (odometer digits), bar and line charts drawn from numbers in the speech, quote cards with masked word
 * reveals, timelines, comparisons and "UI" cards (chat, search, post — no real logos). Everything is HTML/CSS
 * plus GSAP tweens on the one paused timeline: deterministic, seekable, no CSS transform on tweened nodes.
 *
 * Also the anti-slop guard for the director's image prompts: symbolic AI metaphors (gavels, scales, floating
 * apples, brains, light bulbs, chess, puzzles…) are refused in code, whatever the prompt says.
 */

export const GRAPHIC_KINDS = ["counter", "bars", "line", "quote", "timeline", "compare", "chat", "search", "post", "list"] as const;
export type GraphicKind = (typeof GRAPHIC_KINDS)[number];

export const GraphicItemSchema = z.object({ label: z.string().default(""), value: z.string().default("") });
export const GraphicSchema = z.object({
  kind: z.enum(GRAPHIC_KINDS),
  /** heading / search query / post author / quote author */
  title: z.string().default(""),
  /** counter: [{label, value}]; bars/line: [{label, value: number}]; timeline: [{label: date, value: event}];
   *  compare: 2 sides; chat: [{label: "user"|"ai", value: message}]; search: results; list: items */
  items: z.array(GraphicItemSchema).default([]),
  /** quote / post text, or a source line under a chart */
  note: z.string().default(""),
});
export type Graphic = z.infer<typeof GraphicSchema>;

// ---- anti-slop: banned symbolic metaphors ----

/** Stock AI metaphors that read as "нейрослоп". Checked on AI prompts and photo queries. */
const BANNED: { re: RegExp; word: string }[] = [
  { re: /\bgavels?\b|judge'?s? hammer/i, word: "gavel" },
  { re: /\bscales? of justice\b|\bbalance scales?\b|\b(weighing|balanced?) (on )?(a |the )?scales?\b|\bscales?\b(?! model)/i, word: "scales" },
  { re: /\b(float\w*|fall\w*|levitat\w*|frozen|mid-?fall|hovering)\b[^.]{0,40}\bapples?\b|\bapples?\b[^.]{0,40}\b(float\w*|fall\w*|levitat\w*|mid-?fall|hovering)\b|newton'?s apple/i, word: "floating apple" },
  { re: /\bbrains?\b/i, word: "brain" },
  { re: /\blight ?bulbs?\b|\blightbulbs?\b/i, word: "light bulb" },
  { re: /\bchess\w*\b|\bchessboard\b|\bpawns?\b|\bcheckmate\b/i, word: "chess" },
  { re: /\bpuzzles?\b|\bjigsaw\b/i, word: "puzzle" },
  { re: /\bhourglass\w*\b|\bsand ?glass\b/i, word: "hourglass" },
  { re: /\bcrystal ball\b/i, word: "crystal ball" },
  { re: /\bmaze\b|\blabyrinth\b/i, word: "maze" },
  { re: /\bicebergs?\b/i, word: "iceberg" },
  { re: /\bdomino(es)?\b/i, word: "dominoes" },
  { re: /\btightrope\b|\bcrossroads?\b|\bfork in the road\b/i, word: "crossroads" },
  { re: /\bladder to\b|\bstairs? to (the )?(sky|heaven|success)\b|\bmountain (peak|summit) of\b/i, word: "ladder/peak" },
  { re: /\bholograms?\b|\bholographic\b/i, word: "hologram" },
  { re: /\bglowing (nodes?|network|neurons?|circuits?)\b|\bneural network visuali[sz]ation\b|\bnetwork of (glowing )?nodes\b/i, word: "glowing nodes" },
  { re: /\bmirages?\b|\bdissolv\w* into\b|\bshimmering\b/i, word: "mirage" },
  { re: /\brobot(ic)? hand\b|\bhandshake\b/i, word: "robot hand / handshake" },
  { re: /\bmagnifying glass\b|\bcompass\b|\blighthouse\b|\bpadlock\b|\bkey(hole)? (and|to) (a )?lock\b/i, word: "symbol prop" },
  { re: /\bsurreal\w*\b|\bmetaphor\w*\b|\bsymboli[cs]\w*\b|\bdreamlike\b|\bethereal\b/i, word: "surreal/metaphor" },
];

/** The banned metaphor in a prompt/query, or null when it is clean. */
export function bannedMetaphor(text: string): string | null {
  const t = text ?? "";
  for (const b of BANNED) if (b.re.test(t)) return b.word;
  return null;
}

// ---- numbers ----

export interface ParsedNumber {
  prefix: string;
  value: number;
  /** digits after the separator in the source string */
  decimals: number;
  suffix: string;
}

/** "$7,500" / "47%" / "1,5 млрд" / "−3.2 °C" → parts; null when there is no number. */
export function parseNumber(s: string): ParsedNumber | null {
  const m = /^(.*?)(-|−)?(\d[\d\s  ]*(?:[.,]\d+)?)(.*)$/.exec((s ?? "").trim());
  if (!m) return null;
  let digits = m[3].replace(/[\s  ]/g, "");
  // "7,500" is thousands, "1,5" is a decimal comma
  if (/^\d{1,3}(,\d{3})+$/.test(digits)) digits = digits.replace(/,/g, "");
  digits = digits.replace(",", ".");
  const value = Number(digits) * (m[2] ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  const decimals = digits.includes(".") ? digits.split(".")[1].length : 0;
  return { prefix: m[1], value, decimals, suffix: m[4] };
}

/** Normalised digit strings of every number in a text ("7 500" → "7500", "1,5" → "1.5"). */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of (text ?? "").matchAll(/\d[\d\s  ]*(?:[.,]\d+)?/g)) {
    let d = m[0].replace(/[\s  ]+$/, "").replace(/[\s  ]/g, "");
    if (/^\d{1,3}(,\d{3})+$/.test(d)) d = d.replace(/,/g, "");
    d = d.replace(",", ".");
    out.add(String(Number(d)));
  }
  return out;
}

/** Number words a speech uses instead of digits («сорок процентов») are common in ASR: map the small ones. */
const RU_NUMBER_WORDS: Record<string, number> = { "один": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50, "сто": 100, "тысяча": 1000, "миллион": 1e6, "миллиард": 1e9 };

/** Is the number of `value` said in the speech? */
export function saidInSpeech(value: string, speech: string): boolean {
  const p = parseNumber(value);
  if (!p) return false;
  const n = String(Math.abs(p.value));
  const nums = numbersIn(speech);
  if (nums.has(n)) return true;
  const words = (speech ?? "").toLowerCase().split(/[^\p{L}]+/u);
  return words.some((w) => RU_NUMBER_WORDS[w] === Math.abs(p.value));
}

// ---- layout helpers ----

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => String(r3(n));
const clampText = (s: string, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

export interface GraphicContext {
  /** element id prefix (unique per panel) */
  id: string;
  /** the frame the graphic fills */
  w: number;
  h: number;
  /** panel window on the timeline */
  start: number;
  duration: number;
  accent: string;
  bg: string;
  displayFamily: string;
  serifFamily: string;
  monoFamily: string;
}

export interface GraphicOut {
  html: string;
  tweens: string[];
}

/** Masked word reveal: each word rises out of its own clip box. */
function maskedWords(text: string, id: string): { html: string; ids: string[] } {
  const ids: string[] = [];
  const html = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const wid = `${id}-w${i}`;
      ids.push(wid);
      return `<span class="gx-mask"><span class="gx-word" id="${wid}">${esc(w)}</span></span>`;
    })
    .join(" ");
  return { html, ids };
}

const wordsIn = (ids: string[], at: number, step = 0.045, dur = 0.55) => ids.map((w, i) => `tl.fromTo("#${w}", { yPercent: 115 }, { yPercent: 0, duration: ${dur}, ease: "power4.out" }, ${fmt(at + i * step)});`);

/** Odometer: every digit is a 0–9 strip that rolls to its value; other characters stay. */
function odometer(text: string, id: string): { html: string; tweens: (at: number) => string[] } {
  const cols: { id: string; digit: number }[] = [];
  const html = [...text]
    .map((ch, i) => {
      if (/\d/.test(ch)) {
        const cid = `${id}-d${i}`;
        cols.push({ id: cid, digit: Number(ch) });
        return `<span class="gx-odo"><span class="gx-strip" id="${cid}">${Array.from({ length: 10 }, (_, k) => `<span class="gx-dg">${k}</span>`).join("")}</span></span>`;
      }
      return `<span class="gx-ch">${ch === " " ? "&nbsp;" : esc(ch)}</span>`;
    })
    .join("");
  return {
    html,
    // right-most digits spin longest, like a mechanical counter
    tweens: (at) => cols.map((c, k) => `tl.fromTo("#${c.id}", { yPercent: 0 }, { yPercent: ${-c.digit * 10}, duration: ${fmt(0.9 + (cols.length - k) * 0.12)}, ease: "power3.out" }, ${fmt(at + k * 0.05)});`),
  };
}

/** A graphic as HTML inside the panel frame + its tweens. */
export function renderGraphic(g: Graphic, c: GraphicContext): GraphicOut {
  const id = `${c.id}-g`;
  const t0 = c.start + 0.25;
  const tw: string[] = [];
  const items = g.items.filter((x) => x.label.trim() || x.value.trim());
  let body = "";
  const title = g.title.trim() ? `<span class="gx-title" id="${id}-t">${esc(clampText(g.title, 48))}</span>` : "";
  if (title) tw.push(`tl.fromTo("#${id}-t", { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${fmt(t0)});`);
  const note = (txt: string, at: number) => {
    if (!txt.trim()) return "";
    tw.push(`tl.fromTo("#${id}-n", { opacity: 0 }, { opacity: 0.75, duration: 0.5, ease: "power1.out" }, ${fmt(at)});`);
    return `<span class="gx-note" id="${id}-n">${esc(clampText(txt, 70))}</span>`;
  };
  // a slow drift of the background grid: the panel is never a still frame
  tw.push(`tl.fromTo("#${id}-grid", { y: 0 }, { y: -60, duration: ${fmt(Math.max(1, c.duration))}, ease: "none" }, ${fmt(c.start)});`);

  switch (g.kind) {
    case "counter": {
      const it = items[0] ?? { label: g.title, value: g.note };
      const value = clampText(it.value, 14);
      const size = r1(Math.min(250, (c.w - 120) / Math.max(1, value.length * 0.62)));
      const odo = odometer(value, id);
      const label = maskedWords(clampText(it.label, 60), `${id}-l`);
      body = `<span class="gx-center"><span class="gx-big" style="font-size:${size}px">${odo.html}</span><span class="gx-rule" id="${id}-r"></span><span class="gx-label">${label.html}</span></span>`;
      tw.push(...odo.tweens(t0 + 0.1));
      tw.push(`tl.fromTo("#${id}-r", { scaleX: 0 }, { scaleX: 1, duration: 0.8, ease: "expo.out" }, ${fmt(t0 + 0.5)});`);
      tw.push(...wordsIn(label.ids, t0 + 0.7));
      break;
    }
    case "bars": {
      const rows = items.slice(0, 5).map((x) => ({ ...x, n: parseNumber(x.value) }));
      const max = Math.max(...rows.map((r) => Math.abs(r.n?.value ?? 0)), 1e-9);
      const rowH = Math.min(110, (c.h - 260) / Math.max(1, rows.length));
      body = `<span class="gx-bars">${rows
        .map((r, k) => {
          const frac = Math.max(0.04, Math.abs(r.n?.value ?? 0) / max);
          return `<span class="gx-row" style="height:${r1(rowH)}px"><span class="gx-rl" id="${id}-rl${k}">${esc(clampText(r.label, 22))}</span><span class="gx-track"><span class="gx-fill${k === rows.length - 1 || frac === 1 ? " hot" : ""}" id="${id}-b${k}" style="width:${r1(frac * 100)}%"></span></span><span class="gx-rv" id="${id}-v${k}">${esc(clampText(r.value, 12))}</span></span>`;
        })
        .join("")}</span>`;
      rows.forEach((_, k) => {
        const at = t0 + 0.3 + k * 0.18;
        tw.push(`tl.fromTo("#${id}-rl${k}", { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }, ${fmt(at)});`);
        tw.push(`tl.fromTo("#${id}-b${k}", { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "expo.out" }, ${fmt(at + 0.1)});`);
        tw.push(`tl.fromTo("#${id}-v${k}", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.35, ease: "back.out(2)" }, ${fmt(at + 0.6)});`);
      });
      body += note(g.note, t0 + 0.6 + rows.length * 0.18);
      break;
    }
    case "line": {
      const pts = items.slice(0, 8).map((x) => ({ label: x.label, n: parseNumber(x.value), raw: x.value })).filter((p) => p.n);
      const W = c.w - 140;
      const H = c.h - 330;
      const vals = pts.map((p) => p.n!.value);
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const span = hi - lo || Math.abs(hi) || 1;
      const xy = pts.map((p, i) => ({ x: r1(pts.length > 1 ? (i / (pts.length - 1)) * W : W / 2), y: r1(H - ((p.n!.value - lo) / span) * (H * 0.82) - H * 0.09) }));
      const d = xy.map((p, i) => `${i ? "L" : "M"}${p.x} ${p.y}`).join(" ");
      const len = Math.ceil(xy.slice(1).reduce((n, p, i) => n + Math.hypot(p.x - xy[i].x, p.y - xy[i].y), 0)) + 2;
      const area = `${d} L${xy.at(-1)?.x ?? 0} ${H} L${xy[0]?.x ?? 0} ${H} Z`;
      body = `<span class="gx-chart" style="width:${W}px;height:${H + 60}px"><svg class="gx-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs><linearGradient id="${id}-grad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c.accent}" stop-opacity="0.45"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></linearGradient></defs>${[0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${W}" y1="${r1(H * f)}" y2="${r1(H * f)}" stroke="rgba(255,255,255,0.08)" stroke-width="2"/>`).join("")}<path id="${id}-area" d="${area}" fill="url(#${id}-grad)"/><path id="${id}-path" d="${d}" fill="none" stroke="${c.accent}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="${len}" stroke-dashoffset="${len}"/></svg>${xy
        .map((p, i) => `<span class="gx-dot" id="${id}-p${i}" style="left:${r1(p.x - 11)}px;top:${r1(p.y - 11)}px"></span><span class="gx-xl" style="left:${r1(p.x - 80)}px;top:${H + 14}px">${esc(clampText(pts[i].label, 12))}</span>`)
        .join("")}<span class="gx-tip" id="${id}-tip" style="left:${r1(Math.min(W - 230, Math.max(0, (xy.at(-1)?.x ?? 0) - 115)))}px;top:${r1(Math.max(0, (xy.at(-1)?.y ?? 0) - 110))}px">${esc(clampText(pts.at(-1)?.raw ?? "", 12))}</span></span>`;
      tw.push(`tl.fromTo("#${id}-path", { strokeDashoffset: ${len} }, { strokeDashoffset: 0, duration: 1.6, ease: "power2.inOut" }, ${fmt(t0 + 0.3)});`);
      tw.push(`tl.fromTo("#${id}-area", { opacity: 0 }, { opacity: 1, duration: 0.8, ease: "power1.out" }, ${fmt(t0 + 1.2)});`);
      xy.forEach((_, i) => tw.push(`tl.fromTo("#${id}-p${i}", { scale: 0 }, { scale: 1, duration: 0.35, ease: "back.out(3)" }, ${fmt(t0 + 0.3 + (pts.length > 1 ? (1.6 * i) / (pts.length - 1) : 0))});`));
      tw.push(`tl.fromTo("#${id}-tip", { opacity: 0, y: 20, scale: 0.85 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(2)" }, ${fmt(t0 + 1.9)});`);
      body += note(g.note, t0 + 2.1);
      break;
    }
    case "quote": {
      const text = clampText(g.note || items[0]?.value || g.title, 140);
      const size = r1(Math.max(44, Math.min(78, Math.sqrt(((c.w - 160) * (c.h - 300)) / Math.max(1, text.length)) * 0.62)));
      const words = maskedWords(text, `${id}-q`);
      body = `<span class="gx-quote"><span class="gx-qm" id="${id}-qm" style="font-family:${c.serifFamily}">“</span><span class="gx-qt" style="font-size:${size}px;font-family:${c.serifFamily}">${words.html}</span>${g.title.trim() ? `<span class="gx-by" id="${id}-by">— ${esc(clampText(g.title, 40))}</span>` : ""}</span>`;
      tw.push(`tl.fromTo("#${id}-qm", { opacity: 0, scale: 0.4, rotation: -12 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.6, ease: "back.out(2.2)" }, ${fmt(t0)});`);
      tw.push(...wordsIn(words.ids, t0 + 0.25, Math.min(0.08, 1.6 / Math.max(1, words.ids.length))));
      if (g.title.trim()) tw.push(`tl.fromTo("#${id}-by", { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.5, ease: "power3.out" }, ${fmt(t0 + 0.4 + words.ids.length * 0.06)});`);
      // the author goes under the quote, not as a heading
      tw.splice(tw.findIndex((x) => x.includes(`#${id}-t"`)), title ? 1 : 0);
      return wrap(c, id, "", body, tw);
    }
    case "timeline": {
      const ev = items.slice(0, 5);
      const step = (c.w - 160) / Math.max(1, ev.length - 1 || 1);
      body = `<span class="gx-tl"><span class="gx-axis" id="${id}-ax"></span>${ev
        .map((e, k) => {
          const x = ev.length === 1 ? (c.w - 160) / 2 : k * step;
          return `<span class="gx-node" id="${id}-o${k}" style="left:${r1(x - 16)}px"></span><span class="gx-ev${k % 2 ? " low" : ""}" id="${id}-e${k}" style="left:${r1(Math.min(c.w - 160 - 190, Math.max(0, x - 95)))}px"><span class="gx-date">${esc(clampText(e.label, 14))}</span><span class="gx-what">${esc(clampText(e.value, 46))}</span></span>`;
        })
        .join("")}</span>`;
      tw.push(`tl.fromTo("#${id}-ax", { scaleX: 0 }, { scaleX: 1, duration: 1.2, ease: "power2.inOut" }, ${fmt(t0 + 0.2)});`);
      ev.forEach((_, k) => {
        const at = t0 + 0.3 + (ev.length > 1 ? (1.1 * k) / (ev.length - 1) : 0);
        tw.push(`tl.fromTo("#${id}-o${k}", { scale: 0 }, { scale: 1, duration: 0.4, ease: "back.out(3)" }, ${fmt(at)});`);
        tw.push(`tl.fromTo("#${id}-e${k}", { opacity: 0, y: ${k % 2 ? -26 : 26} }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(at + 0.1)});`);
      });
      break;
    }
    case "compare": {
      const [a, b] = [items[0] ?? { label: "", value: "" }, items[1] ?? { label: "", value: "" }];
      const side = (x: { label: string; value: string }, k: number) => `<span class="gx-side${k ? " right" : ""}" id="${id}-s${k}"><span class="gx-sl">${esc(clampText(x.label, 24))}</span><span class="gx-sv" style="font-size:${r1(Math.min(96, 380 / Math.max(1, clampText(x.value, 18).length * 0.6)))}px">${esc(clampText(x.value, 18))}</span></span>`;
      body = `<span class="gx-cmp">${side(a, 0)}<span class="gx-vs" id="${id}-vs">VS</span>${side(b, 1)}</span>`;
      tw.push(`tl.fromTo("#${id}-s0", { opacity: 0, x: -80 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, ${fmt(t0 + 0.2)});`);
      tw.push(`tl.fromTo("#${id}-s1", { opacity: 0, x: 80 }, { opacity: 1, x: 0, duration: 0.6, ease: "expo.out" }, ${fmt(t0 + 0.45)});`);
      tw.push(`tl.fromTo("#${id}-vs", { opacity: 0, scale: 2.4 }, { opacity: 1, scale: 1, duration: 0.45, ease: "back.out(2)" }, ${fmt(t0 + 0.8)});`);
      body += note(g.note, t0 + 1.2);
      break;
    }
    case "chat": {
      const msgs = items.slice(0, 4);
      const isAi = (m: { label: string }) => !/^(user|я|me|q|вопрос|human|пользователь)$/i.test(m.label.trim());
      const spread = Math.max(0.9, Math.min(2.2, (c.duration - 1.6) / Math.max(1, msgs.length)));
      const chars = msgs.reduce((n, m) => n + clampText(m.value, 110).length, 0) + (g.note.trim() ? 40 : 0);
      const fsz = chars > 200 ? 40 : chars > 150 ? 46 : chars > 100 ? 52 : 58;
      body = `<span class="gx-chat" style="font-size:${fsz}px">${msgs
        .map((m, k) => {
          const ai = isAi(m);
          const dots = ai ? `<span class="gx-dots" id="${id}-dt${k}"><span class="gx-d" id="${id}-dt${k}a"></span><span class="gx-d" id="${id}-dt${k}b"></span><span class="gx-d" id="${id}-dt${k}c"></span></span>` : "";
          return `<span class="gx-bub${ai ? " ai" : ""}" id="${id}-m${k}">${ai ? `<span class="gx-who">AI</span>` : ""}<span class="gx-btxt" id="${id}-mt${k}">${esc(clampText(m.value, 110))}</span>${dots}</span>`;
        })
        .join("")}</span>`;
      msgs.forEach((m, k) => {
        const at = t0 + 0.2 + k * spread;
        tw.push(`tl.fromTo("#${id}-m${k}", { opacity: 0, y: 40, scale: 0.85 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.8)" }, ${fmt(at)});`);
        if (isAi(m)) {
          // typing… then the answer
          const think = Math.min(0.9, spread * 0.5);
          tw.push(`tl.fromTo("#${id}-mt${k}", { opacity: 0 }, { opacity: 1, duration: 0.3, ease: "power1.out" }, ${fmt(at + think + 0.12)});`);
          tw.push(`tl.fromTo("#${id}-dt${k}", { opacity: 1 }, { opacity: 0, duration: 0.15, ease: "power1.in", immediateRender: false }, ${fmt(at + think - 0.05)});`);
          ["a", "b", "c"].forEach((d, j) => tw.push(`tl.fromTo("#${id}-dt${k}${d}", { y: 0 }, { y: -12, duration: 0.18, ease: "sine.inOut", repeat: ${Math.max(1, Math.floor(think / 0.18) - 1)}, yoyo: true }, ${fmt(at + j * 0.08)});`));
        }
      });
      if (g.note.trim()) {
        body = body.replace(/<\/span>$/, `<span class="gx-stamp" id="${id}-sp">${esc(clampText(g.note, 54))}</span></span>`);
        tw.push(`tl.fromTo("#${id}-sp", { opacity: 0, scale: 1.8, rotation: -14 }, { opacity: 1, scale: 1, rotation: -4, duration: 0.4, ease: "back.out(2.4)" }, ${fmt(Math.min(c.start + c.duration - 1.2, t0 + 0.4 + msgs.length * spread))});`);
      }
      break;
    }
    case "search": {
      const q = clampText(g.title || items[0]?.label || "", 40);
      const res = (g.title ? items : items.slice(1)).slice(0, 3);
      body = `<span class="gx-search"><span class="gx-bar"><span class="gx-glass"></span><span class="gx-typed" id="${id}-q" style="font-family:${c.monoFamily}">${esc(q)}</span><span class="gx-caret" id="${id}-cr"></span></span>${res
        .map((r, k) => `<span class="gx-res" id="${id}-r${k}"><span class="gx-rt">${esc(clampText(r.label, 52))}</span><span class="gx-rs">${esc(clampText(r.value, 90))}</span></span>`)
        .join("")}</span>`;
      const typeDur = Math.min(1.4, 0.05 * q.length + 0.2);
      tw.push(`tl.fromTo("#${id}-q", { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)", duration: ${fmt(typeDur)}, ease: "steps(${Math.max(4, q.length)})" }, ${fmt(t0 + 0.2)});`);
      tw.push(`tl.fromTo("#${id}-cr", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "steps(1)", repeat: 5, yoyo: true }, ${fmt(t0 + 0.2)});`);
      res.forEach((_, k) => tw.push(`tl.fromTo("#${id}-r${k}", { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, ${fmt(t0 + 0.4 + typeDur + k * 0.2)});`));
      break;
    }
    case "post": {
      const who = clampText(g.title || "автор", 30);
      const initials = who.split(/\s+/).map((w) => w[0] ?? "").join("").slice(0, 2).toUpperCase();
      const words = maskedWords(clampText(g.note || items[0]?.value || "", 160), `${id}-pt`);
      const stats = items.filter((x) => x.label && x.value).slice(0, 3);
      body = `<span class="gx-post" id="${id}-card"><span class="gx-ph"><span class="gx-av">${esc(initials)}</span><span class="gx-name">${esc(who)}</span></span><span class="gx-ptext">${words.html}</span>${stats.length ? `<span class="gx-stats">${stats.map((s, k) => `<span class="gx-st" id="${id}-st${k}"><b>${esc(clampText(s.value, 10))}</b> ${esc(clampText(s.label, 14))}</span>`).join("")}</span>` : ""}</span>`;
      tw.push(`tl.fromTo("#${id}-card", { opacity: 0, y: 60, scale: 0.94 }, { opacity: 1, y: 0, scale: 1, duration: 0.6, ease: "expo.out" }, ${fmt(t0)});`);
      tw.push(...wordsIn(words.ids, t0 + 0.4, Math.min(0.06, 1.5 / Math.max(1, words.ids.length))));
      stats.forEach((_, k) => tw.push(`tl.fromTo("#${id}-st${k}", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.35, ease: "power2.out" }, ${fmt(t0 + 1.2 + k * 0.15)});`));
      tw.splice(tw.findIndex((x) => x.includes(`#${id}-t"`)), title ? 1 : 0);
      return wrap(c, id, "", body, tw);
    }
    case "list":
    default: {
      const li = items.slice(0, 5);
      const spread = Math.max(0.5, Math.min(2.2, (c.duration - 1.4) / Math.max(1, li.length)));
      body = `<span class="gx-list">${li
        .map((x, k) => `<span class="gx-li" id="${id}-i${k}"><span class="gx-num">${String(k + 1).padStart(2, "0")}</span><span class="gx-lt">${esc(clampText(x.label || x.value, 40))}${x.label && x.value ? `<span class="gx-lv">${esc(clampText(x.value, 40))}</span>` : ""}</span></span>`)
        .join("")}</span>`;
      li.forEach((_, k) => {
        const at = t0 + 0.3 + k * spread;
        tw.push(`tl.fromTo("#${id}-i${k}", { opacity: 0, x: -90 }, { opacity: 1, x: 0, duration: 0.55, ease: "expo.out" }, ${fmt(at)});`);
        if (k > 0) tw.push(`tl.fromTo("#${id}-i${k - 1}", { opacity: 1 }, { opacity: 0.45, duration: 0.4, ease: "power1.out", immediateRender: false }, ${fmt(at)});`);
      });
      break;
    }
  }
  return wrap(c, id, title, body, tw);
}

function wrap(c: GraphicContext, id: string, title: string, body: string, tw: string[]): GraphicOut {
  return { html: `<span class="gx" id="${id}"><span class="gx-grid" id="${id}-grid"></span>${title}${body}</span>`, tweens: tw };
}

/** Styles for every graphic kind (scoped under .gx, sized to the panel frame). */
export function graphicsCss(o: { w: number; h: number; accent: string; bg: string; displayFamily: string; monoFamily: string }): string {
  const A = o.accent;
  return `
      .gx { position: absolute; inset: 0; display: block; overflow: hidden; background: radial-gradient(120% 90% at 20% 0%, ${A}40, transparent 60%), linear-gradient(160deg, #17122E, ${o.bg}); color: #FFFFFF; font-family: ${o.displayFamily}; }
      .gx-grid { position: absolute; left: 0; top: 0; width: ${o.w}px; height: ${o.h + 120}px; display: block; background-image: linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px); background-size: 54px 54px; }
      .gx-title { position: absolute; left: 56px; top: 44px; right: 56px; display: block; font-weight: 900; font-size: 50px; line-height: 1.1; letter-spacing: 0.01em; color: rgba(255,255,255,0.92); }
      .gx-note { position: absolute; left: 56px; right: 56px; bottom: 36px; display: block; font-size: 30px; font-weight: 600; color: rgba(255,255,255,0.75); }
      .gx-mask { display: inline-block; overflow: hidden; vertical-align: bottom; padding-bottom: 0.08em; }
      .gx-word { display: inline-block; }
      .gx-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 22px; padding: 0 60px; text-align: center; }
      .gx-big { display: flex; align-items: flex-start; font-weight: 900; line-height: 1; color: #FFFFFF; letter-spacing: -0.03em; }
      .gx-odo { display: block; height: 1em; overflow: hidden; }
      .gx-strip { display: flex; flex-direction: column; }
      .gx-dg { display: block; height: 1em; line-height: 1; }
      .gx-ch { display: block; height: 1em; line-height: 1; color: ${A}; }
      .gx-rule { display: block; width: 46%; height: 8px; border-radius: 4px; background: ${A}; transform-origin: 0% 50%; }
      .gx-label { display: block; font-size: 50px; font-weight: 700; line-height: 1.2; color: rgba(255,255,255,0.88); max-width: ${o.w - 140}px; }
      .gx-bars { position: absolute; left: 60px; right: 60px; top: 130px; bottom: 90px; display: flex; flex-direction: column; justify-content: center; gap: 14px; }
      .gx-row { display: flex; align-items: center; gap: 22px; }
      .gx-rl { display: block; width: 240px; flex: none; font-size: 38px; font-weight: 700; text-align: right; color: rgba(255,255,255,0.88); }
      .gx-track { position: relative; display: block; flex: 1; height: 58%; border-radius: 14px; background: rgba(255,255,255,0.07); overflow: hidden; }
      .gx-fill { position: absolute; left: 0; top: 0; bottom: 0; display: block; border-radius: 14px; background: linear-gradient(90deg, ${A}99, ${A}); transform-origin: 0% 50%; }
      .gx-fill.hot { background: linear-gradient(90deg, ${A}, #FFD166); }
      .gx-rv { display: block; width: 170px; flex: none; font-size: 46px; font-weight: 900; }
      .gx-chart { position: absolute; left: 70px; top: 150px; display: block; }
      .gx-svg { position: absolute; left: 0; top: 0; display: block; overflow: visible; }
      .gx-dot { position: absolute; display: block; width: 22px; height: 22px; border-radius: 50%; background: #FFFFFF; border: 5px solid ${A}; box-sizing: border-box; }
      .gx-xl { position: absolute; display: block; width: 160px; text-align: center; font-size: 32px; font-weight: 600; color: rgba(255,255,255,0.7); }
      .gx-tip { position: absolute; display: block; width: 230px; padding: 14px 0; border-radius: 18px; background: ${A}; text-align: center; font-size: 44px; font-weight: 900; box-shadow: 0 16px 40px rgba(0,0,0,0.45); }
      .gx-quote { position: absolute; left: 70px; right: 70px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; gap: 18px; }
      .gx-qm { display: block; height: 120px; font-size: 220px; line-height: 0.9; color: ${A}; }
      .gx-qt { display: block; line-height: 1.18; font-style: italic; font-weight: 700; }
      .gx-by { display: block; font-family: ${o.monoFamily}; font-size: 32px; letter-spacing: 0.06em; color: ${A}; }
      .gx-tl { position: absolute; left: 80px; right: 80px; top: 50%; height: 0; display: block; }
      .gx-axis { position: absolute; left: 0; right: 0; top: -3px; display: block; height: 6px; border-radius: 3px; background: linear-gradient(90deg, ${A}, #FFFFFF); transform-origin: 0% 50%; }
      .gx-node { position: absolute; top: -16px; display: block; width: 32px; height: 32px; border-radius: 50%; background: ${o.bg}; border: 6px solid ${A}; box-sizing: border-box; }
      .gx-ev { position: absolute; top: 40px; display: flex; flex-direction: column; gap: 6px; width: 190px; text-align: center; }
      .gx-ev.low { top: auto; bottom: 40px; }
      .gx-date { display: block; font-size: 44px; font-weight: 900; color: ${A}; }
      .gx-what { display: block; font-size: 30px; font-weight: 600; line-height: 1.25; color: rgba(255,255,255,0.88); }
      .gx-cmp { position: absolute; left: 50px; right: 50px; top: 120px; bottom: 100px; display: flex; align-items: stretch; gap: 26px; }
      .gx-side { display: flex; flex: 1; flex-direction: column; justify-content: center; gap: 16px; padding: 30px; border-radius: 28px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.14); text-align: center; }
      .gx-side.right { background: ${A}2E; border-color: ${A}; }
      .gx-sl { display: block; font-size: 38px; font-weight: 700; color: rgba(255,255,255,0.85); }
      .gx-sv { display: block; font-weight: 900; line-height: 1.05; }
      .gx-vs { display: flex; align-self: center; align-items: center; justify-content: center; width: 96px; height: 96px; flex: none; border-radius: 50%; background: #FFFFFF; color: ${o.bg}; font-weight: 900; font-size: 34px; }
      .gx-chat { position: absolute; left: 36px; right: 36px; top: 120px; bottom: 32px; display: flex; flex-direction: column; justify-content: space-evenly; gap: 24px; }
      .gx-bub { position: relative; display: block; align-self: flex-end; max-width: 94%; padding: 34px 42px; border-radius: 44px 44px 12px 44px; background: ${A}; font-size: 1em; font-weight: 800; line-height: 1.16; box-shadow: 0 18px 50px rgba(0,0,0,0.4); }
      .gx-bub.ai { align-self: flex-start; border-radius: 36px 36px 36px 10px; background: #F4F2FF; color: #15122A; }
      .gx-btxt { display: block; }
      .gx-who { display: block; margin-bottom: 10px; font-size: 30px; font-weight: 900; letter-spacing: 0.14em; color: ${A}; }
      .gx-dots { position: absolute; left: 42px; top: 50%; margin-top: -12px; display: flex; gap: 16px; }
      .gx-d { display: block; width: 24px; height: 24px; border-radius: 50%; background: ${A}; }
      .gx-stamp { display: block; align-self: flex-end; max-width: 92%; padding: 16px 26px; border-radius: 16px; border: 6px solid #FF4D6D; color: #FF4D6D; background: rgba(13,10,26,0.9); font-size: 0.75em; font-weight: 900; text-transform: uppercase; letter-spacing: 0.02em; line-height: 1.1; }
      .gx-search { position: absolute; left: 60px; right: 60px; top: 70px; bottom: 60px; display: flex; flex-direction: column; gap: 22px; }
      .gx-bar { display: flex; align-items: center; gap: 18px; height: 96px; padding: 0 30px; border-radius: 48px; background: #FFFFFF; color: #15122A; }
      .gx-glass { display: block; width: 30px; height: 30px; flex: none; border-radius: 50%; border: 5px solid #6B6880; box-sizing: border-box; }
      .gx-typed { display: block; font-size: 40px; font-weight: 600; white-space: nowrap; overflow: hidden; }
      .gx-caret { display: block; width: 4px; height: 44px; background: ${A}; }
      .gx-res { display: flex; flex-direction: column; gap: 8px; padding: 22px 28px; border-radius: 22px; background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.12); }
      .gx-rt { display: block; font-size: 38px; font-weight: 800; color: #B9A8FF; }
      .gx-rs { display: block; font-size: 30px; line-height: 1.3; color: rgba(255,255,255,0.8); }
      .gx-post { position: absolute; left: 70px; right: 70px; top: 90px; display: flex; flex-direction: column; gap: 22px; padding: 36px; border-radius: 30px; background: #FFFFFF; color: #15122A; box-shadow: 0 30px 80px rgba(0,0,0,0.5); }
      .gx-ph { display: flex; align-items: center; gap: 18px; }
      .gx-av { display: flex; align-items: center; justify-content: center; width: 76px; height: 76px; border-radius: 50%; background: ${A}; color: #FFFFFF; font-weight: 900; font-size: 30px; }
      .gx-name { display: block; font-size: 38px; font-weight: 800; }
      .gx-ptext { display: block; font-size: 44px; font-weight: 600; line-height: 1.3; }
      .gx-stats { display: flex; gap: 30px; font-size: 30px; color: #5B5870; }
      .gx-st { display: block; }
      .gx-list { position: absolute; left: 36px; right: 36px; top: 124px; bottom: 32px; display: flex; flex-direction: column; justify-content: stretch; gap: 18px; }
      .gx-li { display: flex; flex: 1 1 0; max-height: 220px; align-items: center; gap: 30px; padding: 20px 34px; border-radius: 30px; background: rgba(255,255,255,0.09); border-left: 12px solid ${A}; }
      .gx-num { display: block; font-family: ${o.monoFamily}; font-size: 52px; font-weight: 700; color: ${A}; }
      .gx-lt { display: flex; flex-direction: column; gap: 6px; font-size: 56px; font-weight: 900; line-height: 1.06; }
      .gx-lv { display: block; font-size: 38px; font-weight: 600; color: rgba(255,255,255,0.7); }`;
}
