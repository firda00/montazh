import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { WORKSPACE_ROOT } from "../lib/workspace.ts";
import type { Script } from "./script.ts";
import type { BeatSpeech } from "./scenes.ts";

/**
 * Stage 26: on-topic pictures. The owner's verdict on v4 («говоришь про NASDAQ, про Claude Code, а картинки другие»):
 * every photo came from generic stock keywords («data center server racks», «business meeting») while the narration named
 * OpenAI, Anthropic, Claude Code and Nasdaq — the Nasdaq beat even showed the NYSE facade.
 *
 * This module is the pure core of the entity-aware visual resolver:
 *   1. entities: a dictionary of companies / products / people / places / exchanges with Russian and English forms
 *      (inflected Cyrillic included), matched on what the narrator says; unknown names come from one cheap Gemini call
 *      (src/make/visual-resolve.ts) and are matched the same way;
 *   2. numbers: «1,4 триллиона долларов», «полтора триллиона», a bare «852» after «122 миллиарда» (same scale), with the
 *      word that says them;
 *   3. timing: each mention gets the time the narrator says it (word times of the voiceover);
 *   4. scheduling: sub-shots inside a beat — the picture changes when the next entity or number is said, every
 *      ~1.5–2.5 s, long shots are split on word starts with variants (a punch-in detail of the photo, the brand mark,
 *      a number card, the product UI), cuts snap to a music beat when one is within reach.
 * Network parts (Wikimedia Commons, Simple Icons, the vision relevance check) live in commons.ts, brandmarks.ts,
 * relevance.ts; the glue in visual-resolve.ts; the panes are drawn by shots.ts.
 */

export const VISUALS_CACHE = path.join(WORKSPACE_ROOT, "_cache", "visuals");

export type EntityKind = "company" | "product" | "person" | "place" | "exchange" | "org";
/** product UI drawn in code (src/design/panel-graphics.ts) */
export type UiKind = "terminal" | "chat" | "ticker" | "line" | "round" | "bars";

export interface EntityDef {
  id: string;
  /** how it is written on screen */
  name: string;
  kind: EntityKind;
  /** the forms a narrator's text uses (Latin and Cyrillic, inflected); matched on word boundaries */
  match: RegExp;
  /** Simple Icons slug (data/simple-icons.json); none = a typeset wordmark */
  icon?: string;
  /** brand colour for a wordmark when there is no icon */
  color?: string;
  /** Wikimedia Commons searches for a real photo OF the entity, best first */
  commons?: string[];
  /** words one of which a Commons file title must contain (default: the name) */
  titleWords?: string[];
  /** what the vision check must see, English */
  subject?: string;
  /** product UI that shows it */
  ui?: UiKind;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const rx = (body: string) => new RegExp(`${B}(?:${body})${E}`, "iu");

/**
 * Names the reels of this project keep mentioning (AI, tech, money). Cyrillic forms carry \p{L}* for case endings
 * («Насдаке», «Альтмана»). A real person is only ever shown by a licensed real photo (never generated).
 */
export const KNOWN_ENTITIES: EntityDef[] = [
  { id: "claude-code", name: "Claude Code", kind: "product", match: rx("claude\\s+code|клод\\s+код\\p{L}*"), icon: "claude", ui: "terminal", subject: "the Claude Code command-line tool or its logo" },
  { id: "chatgpt", name: "ChatGPT", kind: "product", match: rx("chat\\s?gpt|чат\\s?(?:gpt|джи-?пи-?ти)\\p{L}*|чатгпт\\p{L}*"), ui: "chat", color: "#10A37F", commons: ["ChatGPT"], subject: "ChatGPT (its interface or logo)" },
  { id: "codex", name: "Codex", kind: "product", match: rx("codex|кодекс\\p{L}*(?=\\s+(?:от\\s+)?(?:openai|оупен))"), ui: "terminal", color: "#10A37F" },
  { id: "openai", name: "OpenAI", kind: "company", match: rx("open\\s?ai|оупен\\s?эй-?ай\\p{L}*|опен\\s?ай\\p{L}*|опенаи"), color: "#10A37F", commons: ["OpenAI headquarters", "OpenAI"], titleWords: ["openai"], subject: "OpenAI (its logo, signage, office or an OpenAI event)" },
  { id: "claude", name: "Claude", kind: "product", match: rx("claude|клод(?!\\s+код)\\p{L}*"), icon: "claude", ui: "chat", subject: "Claude, the AI assistant by Anthropic (its logo or interface)" },
  { id: "anthropic", name: "Anthropic", kind: "company", match: rx("anthropic|антропик\\p{L}*|энтропик\\p{L}*"), icon: "anthropic", commons: ["Anthropic San Francisco", "Anthropic"], titleWords: ["anthropic"], subject: "Anthropic (its logo, office or people at Anthropic)" },
  { id: "gemini", name: "Gemini", kind: "product", match: rx("gemini|джемин\\p{L}*"), icon: "googlegemini", ui: "chat" },
  { id: "google", name: "Google", kind: "company", match: rx("google|гугл\\p{L}*|alphabet"), icon: "google", commons: ["Googleplex", "Google headquarters"], titleWords: ["google"], subject: "Google (its logo, campus or signage)" },
  { id: "microsoft", name: "Microsoft", kind: "company", match: rx("microsoft|майкрософт\\p{L}*"), color: "#00A4EF", commons: ["Microsoft Redmond campus", "Microsoft headquarters"], titleWords: ["microsoft"], subject: "Microsoft (its logo, campus or signage)" },
  { id: "nvidia", name: "Nvidia", kind: "company", match: rx("nvidia|нвидиа\\p{L}*|энвидиа\\p{L}*|нвидия\\p{L}*"), icon: "nvidia", commons: ["Nvidia headquarters", "Nvidia GPU"], titleWords: ["nvidia"], subject: "Nvidia (its logo, headquarters or GPUs)" },
  { id: "meta", name: "Meta", kind: "company", match: rx("meta(?=\\s|,|\\.|$)|мета(?=\\s+(?:platforms|платформ))"), icon: "meta" },
  { id: "apple", name: "Apple", kind: "company", match: rx("apple|эппл\\p{L}*"), icon: "apple", commons: ["Apple Park"], titleWords: ["apple"] },
  { id: "amazon", name: "Amazon", kind: "company", match: rx("amazon|амазон\\p{L}*|aws"), color: "#FF9900", commons: ["Amazon Spheres", "Amazon headquarters"], titleWords: ["amazon"] },
  { id: "xai", name: "xAI", kind: "company", match: rx("xai|икс\\s?эй-?ай|grok|грок\\p{L}*"), icon: "x" },
  { id: "deepseek", name: "DeepSeek", kind: "company", match: rx("deepseek|дипсик\\p{L}*"), icon: "deepseek", ui: "chat" },
  { id: "mistral", name: "Mistral AI", kind: "company", match: rx("mistral|мистрал\\p{L}*"), icon: "mistralai" },
  { id: "perplexity", name: "Perplexity", kind: "company", match: rx("perplexity|перплексит\\p{L}*"), icon: "perplexity", ui: "chat" },
  { id: "cursor", name: "Cursor", kind: "product", match: rx("cursor|курсор(?=\\s|,|\\.)"), icon: "cursor", ui: "terminal" },
  { id: "copilot", name: "GitHub Copilot", kind: "product", match: rx("copilot|копилот\\p{L}*"), icon: "githubcopilot", ui: "terminal" },
  { id: "tesla", name: "Tesla", kind: "company", match: rx("tesla|тесл\\p{L}*"), icon: "tesla" },
  { id: "spacex", name: "SpaceX", kind: "company", match: rx("spacex|спейс\\s?икс\\p{L}*"), icon: "spacex" },
  { id: "softbank", name: "SoftBank", kind: "org", match: rx("softbank|софтбанк\\p{L}*"), color: "#C0C0C0", commons: ["SoftBank"], titleWords: ["softbank"] },
  { id: "thrive", name: "Thrive Capital", kind: "org", match: rx("thrive(?:\\s+capital)?|трайв\\p{L}*"), color: "#2E5BFF" },
  { id: "nasdaq", name: "Nasdaq", kind: "exchange", match: rx("nasdaq|насдак\\p{L}*"), color: "#0996C7", ui: "ticker", commons: ["Nasdaq MarketSite", "Nasdaq Times Square", "Nasdaq Tower"], titleWords: ["nasdaq"], subject: "the Nasdaq exchange (Nasdaq MarketSite, its tower or Nasdaq signage)" },
  { id: "nyse", name: "NYSE", kind: "exchange", match: rx("nyse|нью-?йоркск\\p{L}*\\s+(?:фондов\\p{L}*\\s+)?бирж\\p{L}*"), color: "#1F2A44", ui: "ticker", commons: ["New York Stock Exchange"], titleWords: ["stock exchange", "nyse"], subject: "the New York Stock Exchange building or trading floor" },
  { id: "wall-street", name: "Wall Street", kind: "place", match: rx("wall\\s+street|уолл[\\s-]?стрит\\p{L}*"), commons: ["Wall Street sign", "Wall Street"], titleWords: ["wall street"], subject: "Wall Street in New York" },
  { id: "times-square", name: "Times Square", kind: "place", match: rx("times\\s+square|таймс[\\s-]?сквер\\p{L}*"), commons: ["Times Square"], titleWords: ["times square"] },
  { id: "silicon-valley", name: "Silicon Valley", kind: "place", match: rx("silicon\\s+valley|кремниев\\p{L}*\\s+долин\\p{L}*"), commons: ["Silicon Valley aerial"], titleWords: ["silicon valley"] },
  { id: "san-francisco", name: "San Francisco", kind: "place", match: rx("san\\s+francisco|сан-?франциско"), commons: ["San Francisco skyline"], titleWords: ["san francisco"] },
  { id: "sam-altman", name: "Сэм Альтман", kind: "person", match: rx("sam\\s+altman|altman|(?:сэм\\p{L}*\\s+)?альтман\\p{L}*"), commons: ["Sam Altman"], titleWords: ["altman"], subject: "a real photograph of a person (Sam Altman according to the file title)" },
  { id: "dario-amodei", name: "Дарио Амодеи", kind: "person", match: rx("dario\\s+amodei|amodei|(?:дарио\\s+)?амодеи"), commons: ["Dario Amodei"], titleWords: ["amodei"], subject: "a real photograph of a person (Dario Amodei according to the file title)" },
  { id: "elon-musk", name: "Илон Маск", kind: "person", match: rx("elon\\s+musk|musk|илон\\p{L}*\\s+маск\\p{L}*"), commons: ["Elon Musk"], titleWords: ["musk"], subject: "a real photograph of a person (Elon Musk according to the file title)" },
  { id: "jensen-huang", name: "Дженсен Хуанг", kind: "person", match: rx("jensen\\s+huang|(?:дженсен\\p{L}*\\s+)?хуанг\\p{L}*"), commons: ["Jensen Huang"], titleWords: ["huang"], subject: "a real photograph of a person (Jensen Huang according to the file title)" },
  { id: "satya-nadella", name: "Сатья Наделла", kind: "person", match: rx("satya\\s+nadella|nadella|(?:сатья\\s+)?наделл\\p{L}*"), commons: ["Satya Nadella"], titleWords: ["nadella"], subject: "a real photograph of a person (Satya Nadella according to the file title)" },
];

// ---- words of a beat ----

export interface TimedToken {
  text: string;
  start: number;
  end: number;
}

/** A word list with start offsets in the joined text (one space between words). */
function joinWords(words: { text: string }[]): { text: string; at: number[] } {
  const at: number[] = [];
  let s = "";
  for (const w of words) {
    if (s) s += " ";
    at.push(s.length);
    s += w.text;
  }
  return { text: s, at };
}

const wordAtOffset = (at: number[], off: number) => {
  let k = 0;
  while (k + 1 < at.length && at[k + 1] <= off) k++;
  return k;
};

/** Words of a beat on the timeline: the narration's word times, or (no voice) the on-screen text spread over the beat. */
export function beatWords(script: Script, beat: number, speech: BeatSpeech | null | undefined, sceneStart = 0, sceneDur = script.beats[beat]?.seconds ?? 4): TimedToken[] {
  if (speech?.words.length) return speech.words.map((w) => ({ text: w.text, start: w.start, end: w.end }));
  const words = (script.beats[beat]?.voiceover?.trim() || script.beats[beat]?.text || "").split(/\s+/).filter(Boolean);
  const span = sceneDur * 0.8;
  return words.map((text, k) => ({ text, start: sceneStart + 0.1 + (span * k) / Math.max(1, words.length), end: sceneStart + 0.1 + (span * (k + 1)) / Math.max(1, words.length) }));
}

// ---- entities ----

export interface EntityMention {
  entity: string;
  /** index of the first word in the beat's word list */
  word: number;
  t: number;
  text: string;
}

/** Entity mentions in a beat's words (longest/first match wins; «Claude Code» is not also «Claude»). */
export function findMentions(words: TimedToken[], entities: EntityDef[] = KNOWN_ENTITIES): EntityMention[] {
  const { text, at } = joinWords(words);
  const taken: [number, number][] = [];
  const out: EntityMention[] = [];
  for (const e of entities) {
    const re = new RegExp(e.match.source, e.match.flags.includes("g") ? e.match.flags : `${e.match.flags}g`);
    for (const m of text.matchAll(re)) {
      const s = m.index ?? 0;
      const end = s + m[0].length;
      if (taken.some(([a, b]) => s < b && end > a)) continue;
      taken.push([s, end]);
      const w = wordAtOffset(at, s);
      out.push({ entity: e.id, word: w, t: words[w]?.start ?? 0, text: m[0] });
    }
  }
  return out.sort((a, b) => a.t - b.t || a.word - b.word);
}

/** An entity the cheap LLM pass found that the dictionary does not know: matched by its spoken forms. */
export function entityFromLlm(x: { name: string; kind: string; forms: string[]; commons_query?: string; subject?: string }): EntityDef | null {
  const name = x.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) return null;
  const forms = [...new Set([name, ...x.forms].map((f) => f.replace(/\s+/g, " ").trim()).filter((f) => f.length >= 2 && f.length <= 40))];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
  // a Cyrillic form keeps its stem and takes any ending («Мистраля»)
  const body = forms.map((f) => (/[а-яё]/i.test(f) && f.length > 4 ? `${esc(f.slice(0, -1))}\\p{L}*` : esc(f))).join("|");
  const kind = (["company", "product", "person", "place", "exchange", "org"] as const).find((k) => k === x.kind) ?? "org";
  const id = `x-${name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "")}`;
  return {
    id,
    name,
    kind,
    match: rx(body),
    commons: x.commons_query?.trim() ? [x.commons_query.trim()] : kind === "product" ? [] : [name],
    titleWords: [name.split(/\s+/).sort((a, b) => b.length - a.length)[0].toLowerCase()],
    subject: x.subject?.trim() || (kind === "person" ? `a real photograph of a person (${name} according to the file title)` : `${name} (its logo, building, signage, product or event)`),
  };
}

// ---- numbers ----

export interface NumberMention {
  /** value in units (1.4e12) */
  value: number;
  /** as shown: «$1,4» */
  shown: string;
  /** «трлн», «млрд», «%», «» */
  unit: string;
  word: number;
  t: number;
  /** the words that said it */
  text: string;
}

const SCALES: { re: RegExp; unit: string; mul: number }[] = [
  { re: /^(трлн|триллион\p{L}*|trillion\w*)/iu, unit: "трлн", mul: 1e12 },
  { re: /^(млрд|миллиард\p{L}*|billion\w*|bn)/iu, unit: "млрд", mul: 1e9 },
  { re: /^(млн|миллион\p{L}*|million\w*|mln)/iu, unit: "млн", mul: 1e6 },
  { re: /^(тыс\.?|тысяч\p{L}*|thousand\w*)/iu, unit: "тыс", mul: 1e3 },
];
const clean = (w: string) => w.replace(/^[«"(“]+|[»"),.:;!?…”]+$/g, "");

/**
 * Money and counts in a beat's words: digits (with a decimal comma) or «полтора»/«полторы», the scale word after them,
 * «доллар…»/«$» for the currency, «%»/«процент…». A bare number right after a scaled one in the same beat takes its
 * scale («122 миллиарда при оценке в 852» → 852 млрд). Years («2024», «в 2025-м») are skipped.
 */
export function findNumbers(words: TimedToken[], o: { dollars?: boolean } = {}): NumberMention[] {
  const out: NumberMention[] = [];
  let last: { unit: string; mul: number; cur: boolean } | null = null;
  for (let k = 0; k < words.length; k++) {
    const raw = clean(words[k].text);
    let value: number | null = null;
    let decimals = "";
    let cur = /^\$/.test(raw);
    let pct = /%$/.test(raw);
    const m = /^\$?(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?)(%)?(?:-\p{L}+)?$/u.exec(raw);
    if (m) {
      const d = m[1].replace(/[  ]/g, "");
      value = Number(d.replace(",", "."));
      decimals = d.includes(",") || d.includes(".") ? d.split(/[.,]/)[1] : "";
      if (m[2]) pct = true;
    } else if (/^полтор(а|ы|у|ой)$/iu.test(raw)) {
      value = 1.5;
      decimals = "5";
    }
    if (value === null || !Number.isFinite(value)) continue;
    const next = clean(words[k + 1]?.text ?? "");
    const next2 = clean(words[k + 2]?.text ?? "");
    // a year: 1900–2099 without a scale, said as «в 2025», «2024-го», «2024 году»
    if (!decimals && value >= 1900 && value <= 2099 && !SCALES.some((s) => s.re.test(next)) && (/-/.test(words[k].text) || /^год/i.test(next) || /^(в|с|до|к|от|по)$/i.test(clean(words[k - 1]?.text ?? "")) || /^(году|года|год)$/i.test(next))) continue;
    if (/^процент/i.test(next)) pct = true;
    const scale = SCALES.find((s) => s.re.test(next));
    let unit = "";
    let mul = 1;
    let used = 1;
    if (pct) unit = "%";
    else if (scale) {
      unit = scale.unit;
      mul = scale.mul;
      used = 2;
      if (/^доллар/i.test(next2)) cur = true;
    } else if (/^доллар/i.test(next)) cur = true;
    else if (last && value < 1000) {
      unit = last.unit;
      mul = last.mul;
      cur = last.cur;
    }
    if (cur || o.dollars) cur = cur || (!!o.dollars && mul >= 1e6);
    const shownNum = decimals ? `${Math.trunc(value)},${decimals}` : String(value);
    out.push({ value: value * mul, shown: `${cur ? "$" : ""}${shownNum}`, unit, word: k, t: words[k].start, text: words.slice(k, k + used).map((w) => w.text).join(" ") });
    if (unit && unit !== "%") last = { unit, mul, cur };
    k += used - 1;
  }
  return out;
}

/** Whether a script is about dollars (then «965 миллиардов» is shown as «$965 млрд»). */
export function scriptInDollars(script: Script): boolean {
  const t = script.beats.map((b) => `${b.text} ${b.voiceover ?? ""}`).join(" ");
  return /\$|доллар|dollar|usd/i.test(t) && !/рубл|₽|сум\b|евро|€/i.test(t);
}

// ---- visual options and the sub-shot schedule ----

export type VisualKind = "photo" | "logo" | "wordmark" | "ui" | "number" | "layout";

export interface PhotoCreditInfo {
  title: string;
  creator: string;
  license: string;
  license_version: string;
  license_url: string;
  url: string;
  source: string;
}

export interface VisualOption {
  /** stable id inside the video: «b3.p0», «b3.l», «b3.n1» */
  id: string;
  beat: number;
  kind: VisualKind;
  /** the entity it shows (photos, marks, UI of a named product) */
  entity?: string;
  /** what it is, for the director and the log: «real photo: Nasdaq MarketSite (Commons, CC BY 2.0, 9/10)» */
  label: string;
  /** photo: the frame-cropped file; focus of the subject (0..1) for punch-ins */
  file?: string;
  focus?: { x: number; y: number };
  credit?: PhotoCreditInfo;
  /** vision relevance score 0..10 (photos) */
  score?: number;
  /** logo: Simple Icons path data (24×24 viewBox) and colour; wordmark: colour */
  path?: string;
  hex?: string;
  slug?: string;
  name?: string;
  /** a number shown with the mark or on its own card */
  number?: { value: string; unit: string };
  /** ui: the graphic spec (panel-graphics kinds + terminal / ticker / round) */
  graphic?: { kind: string; title: string; items: { label: string; value: string }[]; note: string };
  /** the number mention a number card belongs to */
  numberIndex?: number;
}

export interface BeatVisuals {
  beat: number;
  mentions: EntityMention[];
  numbers: NumberMention[];
  options: VisualOption[];
}

export interface PlannedShot {
  start: number;
  end: number;
  /** option id; «<id>~detail» = a punch-in on the same photo */
  option: string;
  /** what triggered the cut: an entity id, «#<number index>», «fill» */
  anchor: string;
}

export interface ShotAnchor {
  t: number;
  key: string;
  /** candidate option ids, best first */
  options: string[];
}

export interface ScheduleInput {
  start: number;
  end: number;
  anchors: ShotAnchor[];
  /** fallbacks for a first shot before the first anchor, and for splitting long shots */
  fill: string[];
  /** alternatives of an option for a split («photo» → its detail, the entity's mark…) */
  variants?: (option: string) => string[];
  /** word starts inside the scene: split points snap to them */
  wordStarts?: number[];
  musicBeats?: number[];
  /** shortest / longest shot (s), the cut leads the word by `lead` */
  min?: number;
  max?: number;
  lead?: number;
  fps?: number;
}

export const SHOT_MIN = 1.5;
export const SHOT_MAX = 2.5;

/**
 * Sub-shots of one scene. The first shot shows the first anchor when it is said early (else a fill); every later anchor
 * cuts in when it is said (minus `lead`, snapped to a music beat within 0.12 s) if the shot before it had at least `min`
 * and the scene has at least 0.8·min left; then every shot longer than `max` is split on word starts into variants.
 * No two neighbouring shots show the same option. Pure and deterministic.
 */
export function scheduleShots(inp: ScheduleInput): PlannedShot[] {
  const min = inp.min ?? SHOT_MIN;
  const max = inp.max ?? SHOT_MAX;
  const lead = inp.lead ?? 0.08;
  const fps = inp.fps ?? 30;
  const grid = (x: number) => Math.round((Math.round(x * fps) / fps) * 1000) / 1000;
  const { start, end } = inp;
  if (end - start < 0.5) return [];
  const anchors = [...inp.anchors].filter((a) => a.options.length).sort((a, b) => a.t - b.t);
  const firstAnchor = anchors[0];
  const shots: PlannedShot[] = [];
  const usedHere = new Set<string>();
  const pick = (opts: string[], prev?: string) => opts.find((o) => !usedHere.has(o) && o !== prev) ?? opts.find((o) => o !== prev);
  let rest = anchors;
  // the beat's first named thing opens the scene unless it is said late (then a fill holds until it is said)
  if (firstAnchor && (firstAnchor.t - start <= Math.max(min, 0.6 * (end - start)) || !inp.fill.length)) {
    const o = pick(firstAnchor.options)!;
    shots.push({ start, end, option: o, anchor: firstAnchor.key });
    usedHere.add(o);
    rest = anchors.slice(1);
  } else if (inp.fill.length) {
    shots.push({ start, end, option: inp.fill[0], anchor: "fill" });
    usedHere.add(inp.fill[0]);
  } else return [];
  const snap = (x: number) => {
    const near = (inp.musicBeats ?? []).filter((b) => Math.abs(b - x) <= 0.12).sort((a, b) => Math.abs(a - x) - Math.abs(b - x))[0];
    return grid(near ?? x);
  };
  for (const a of rest) {
    const cur = shots[shots.length - 1];
    const at = snap(a.t - lead);
    if (at - cur.start < min || end - at < min * 0.8) continue;
    const o = pick(a.options, cur.option);
    if (!o || o === cur.option) continue;
    cur.end = at;
    shots.push({ start: at, end, option: o, anchor: a.key });
    usedHere.add(o);
  }
  // split long shots on word starts with variants
  const out: PlannedShot[] = [];
  for (const [si, s] of shots.entries()) {
    const dur = s.end - s.start;
    // options a later anchor of this scene shows are kept for it (a chart lands on its number, not before)
    const reserved = new Set(shots.slice(si + 1).map((x) => x.option));
    if (dur <= max + 0.25) {
      out.push(s);
      continue;
    }
    const n = Math.ceil(dur / max);
    const cuts: number[] = [];
    for (let k = 1; k < n; k++) {
      const ideal = s.start + (dur * k) / n;
      const lo = (cuts.at(-1) ?? s.start) + min * 0.9;
      const hi = s.end - min * 0.9;
      const w = (inp.wordStarts ?? []).map((x) => x - lead).filter((x) => x >= lo && x <= hi && Math.abs(x - ideal) <= 0.4).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
      const c = w ?? ideal;
      if (c >= lo && c <= hi) cuts.push(snap(c));
    }
    let prev = s.option;
    let from = s.start;
    out.push({ ...s, end: cuts[0] ?? s.end });
    for (let k = 0; k < cuts.length; k++) {
      from = cuts[k];
      const to = cuts[k + 1] ?? s.end;
      // variants of the piece before, of the original shot, then the scene's fills
      const pool = [...new Set([...(inp.variants?.(prev) ?? []), ...(inp.variants?.(s.option) ?? []), ...inp.fill])].filter((x) => !reserved.has(x));
      const o = pool.find((x) => x !== prev && !usedHere.has(x)) ?? pool.find((x) => x !== prev && x !== s.option) ?? pool.find((x) => x !== prev);
      if (!o) {
        out[out.length - 1].end = to;
        continue;
      }
      usedHere.add(o);
      out.push({ start: from, end: to, option: o, anchor: "fill" });
      prev = o;
    }
  }
  // merge neighbours that ended up equal
  const merged: PlannedShot[] = [];
  for (const s of out) {
    const p = merged[merged.length - 1];
    if (p && p.option === s.option) p.end = s.end;
    else merged.push({ ...s, start: grid(s.start), end: grid(s.end) });
  }
  if (merged.length) {
    merged[0].start = grid(start);
    merged[merged.length - 1].end = grid(end);
  }
  return merged;
}

/** Shot statistics for the report: count, mean length, how many cuts sit on an entity/number mention. */
export function shotStats(shots: PlannedShot[][]): { shots: number; mean: number; anchored: number } {
  const all = shots.flat();
  const total = all.reduce((n, s) => n + (s.end - s.start), 0);
  return { shots: all.length, mean: all.length ? Math.round((total / all.length) * 100) / 100 : 0, anchored: all.filter((s) => s.anchor !== "fill").length };
}

/** A content hash (cache keys). */
export const hashOf = (x: unknown) => createHash("sha256").update(typeof x === "string" ? x : JSON.stringify(x)).digest("hex").slice(0, 24);

export async function readCache<T>(dir: string, key: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), "utf8")) as T;
  } catch {
    return null;
  }
}

export async function writeCache(dir: string, key: string, value: unknown) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${key}.json`), JSON.stringify(value, null, 1));
}
