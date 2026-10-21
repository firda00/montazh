import { z } from "zod";
import type { StructuredFn } from "../../lib/llm.ts";
import { fill, loadPrompt } from "../../lib/prompts.ts";
import { zodToApiSchema } from "../../plan/schema-sanitize.ts";
import { normalizeUz, upperUz, uzApostropheIssues } from "../../design/abror.ts";

/**
 * Stage 33 — the Uzbek venture-news script in Abror Bakhtiyarovich's template (docs/abror-format.md §4, §5.5):
 *   hook («число + кто», ≤ 12 words, the number in the first five) → «Bu — X» → 2–4 facts → «Eng qizigʻi — …» →
 *   the lesson for Uzbek founders → CTA «"WORD" soʻzini yozib qoldiringlar».
 * The model writes it (prompts/make.abror.*); the code normalises the apostrophes (oʻ/gʻ = U+02BB), validates the
 * template, checks every number against the sources, and sends a failing script back once.
 * teleprompterText / shotListText turn it into what he reads from the phone and what the editor will put on screen.
 */

export const VISUAL_KINDS = ["logo", "site", "article", "number", "ui", "photo", "text"] as const;
export const PARTS = ["hook", "intro", "fact", "twist", "lesson", "cta"] as const;
export type Part = (typeof PARTS)[number];

export const VisualSchema = z.object({
  kind: z.enum(VISUAL_KINDS),
  /** company / product / place as written (photo: an English search query; never a person) */
  subject: z.string().default(""),
  /** the number shown («$1,5 MLRD») */
  value: z.string().default(""),
  /** 1–3 words under the number; text cards: lines separated by « | » */
  label: z.string().default(""),
  url: z.string().default(""),
});
export const LineSchema = z.object({
  part: z.enum(PARTS),
  text: z.string().min(1),
  visual: VisualSchema,
  /** index into sources of the fact this line states (-1 = none) */
  source: z.number().int().default(-1),
});
export const SourceSchema = z.object({
  title: z.string(),
  url: z.string(),
  publisher: z.string().default(""),
  date: z.string().default(""),
  /** the text the facts were taken from (RSS summary / research notes), for the number check and the article card */
  text: z.string().default(""),
  image: z.string().optional(),
});
export const AbrorScriptSchema = z.object({
  topic: z.string(),
  language: z.literal("uz").default("uz"),
  title: z.string().default(""),
  hook_title: z.array(z.string()).min(1).max(2),
  lines: z.array(LineSchema).min(5).max(14),
  cta: z.object({ kind: z.enum(["keyword", "question", "phone"]).default("keyword"), keyword: z.string().default(""), phone: z.string().default(""), promise: z.string().default("") }).prefault({}),
  /** the article screenshot: which source and its sentence to highlight (verbatim) */
  article: z.object({ source: z.number().int(), key_line: z.string() }).nullable().default(null),
  sources: z.array(SourceSchema).default([]),
  caption: z.string().default(""),
  hashtags: z.array(z.string()).default([]),
});
export type AbrorScript = z.infer<typeof AbrorScriptSchema>;
export type AbrorLine = z.infer<typeof LineSchema>;
export type AbrorSource = z.infer<typeof SourceSchema>;

/** what the model returns */
const OutSchema = z.object({
  title: z.string(),
  hook_title: z.array(z.string()),
  lines: z.array(z.object({ part: z.enum(PARTS), text: z.string(), visual: z.object({ kind: z.enum(VISUAL_KINDS), subject: z.string(), value: z.string(), label: z.string(), url: z.string() }), source: z.number() })),
  article: z.object({ source: z.number(), key_line: z.string() }),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

// ---------------------------------------------------------------- numbers

export interface NumberMention {
  raw: string;
  value: number;
  /** "money" when a currency or a money word is next to it, "year", "percent", "count" */
  kind: "money" | "year" | "percent" | "count";
}

const SCALE: [RegExp, number][] = [
  [/^(trln|trillion|триллион\w*|trillion\w*|трлн)$/i, 1e12],
  [/^(mlrd|milliard\w*|billion\w*|bn|b|млрд\w*|миллиард\w*)$/i, 1e9],
  [/^(mln|million\w*|millionta|mn|m|млн\w*|миллион\w*)$/i, 1e6],
  [/^(ming\w*|thousand\w*|k|тыс\w*|тысяч\w*)$/i, 1e3],
];
const MONEY = /\$|€|£|dollar|доллар|evro|euro|евро|soʻm|so'm|сум|сўм|usd/i;

/** Numbers in a text with their scale words («1,5 milliard dollar», «$6.2 billion», «838 млн», «26%», «2026-yilda»). */
export function numbersIn(text: string): NumberMention[] {
  const out: NumberMention[] = [];
  const t = text.replace(/ /g, " ");
  const re = /([$€£]\s?)?(\d{1,3}(?:[  ]\d{3})+|\d+(?:[.,]\d+)?)(\s?%|\s?foiz\w*|\s?процент\w*|\s?percent)?(?:-?(yil\w*|йил\w*|год\w*))?(?:\s*([A-Za-zА-Яа-яЁёʻʼ']+))?(?:\s+([A-Za-zА-Яа-яЁёʻʼ']+))?/g;
  for (const m of t.matchAll(re)) {
    const digits = m[2].replace(/[  ]/g, "");
    // «1,5» / «6.2» decimal; «1,500» thousands (three digits after the comma and no scale word)
    let v = /^\d+[.,]\d{3}$/.test(digits) && !(m[5] && SCALE.some(([r]) => r.test(m[5]!))) ? Number(digits.replace(/[.,]/, "")) : Number(digits.replace(",", "."));
    if (!Number.isFinite(v)) continue;
    const scaleWord = [m[5], m[6]].find((w) => w && SCALE.some(([r]) => r.test(w)));
    const scale = scaleWord ? SCALE.find(([r]) => r.test(scaleWord))![1] : 1;
    const around = `${m[1] ?? ""} ${m[5] ?? ""} ${m[6] ?? ""} ${t.slice(Math.max(0, (m.index ?? 0) - 2), m.index ?? 0)}`;
    const percent = !!m[3];
    const year = !!m[4] || (!scaleWord && !percent && !m[1] && /^(19|20)\d{2}$/.test(digits) && v >= 1990 && v <= 2040);
    v *= scale;
    out.push({ raw: m[0].trim(), value: v, kind: percent ? "percent" : year ? "year" : MONEY.test(around) || !!scaleWord ? "money" : "count" });
  }
  return out;
}

const close = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 0.011);

/**
 * Numbers of the spoken lines that the sources do not contain. Small counts (≤ 10: «2 ta», «3 yilda») and the current
 * year are not checked; money, percentages, years and counts above 10 must be in a source (±1 %).
 */
export function verifyNumbers(script: Pick<AbrorScript, "lines" | "sources" | "hook_title">, extraText = "", now = new Date()): { line: number; raw: string }[] {
  const corpus = numbersIn([...script.sources.map((s) => `${s.title}\n${s.text}`), extraText].join("\n"));
  const bad: { line: number; raw: string }[] = [];
  const check = (text: string, line: number) => {
    for (const n of numbersIn(text)) {
      if (n.kind === "count" && n.value <= 10) continue;
      if (n.kind === "year" && (n.value === now.getFullYear() || n.value === now.getFullYear() - 1)) continue;
      if (!corpus.some((c) => close(c.value, n.value))) bad.push({ line, raw: n.raw });
    }
  };
  script.lines.forEach((l, i) => check(l.text, i));
  script.hook_title.forEach((h) => check(h.replace(/\bMLRD\b/gi, "milliard").replace(/\bMLN\b/gi, "million"), -1));
  return bad;
}

// ---------------------------------------------------------------- validation

export interface ScriptIssue {
  rule: string;
  message: string;
  line?: number;
}

const words = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const UZ_NUMBER_WORDS = /^(bir|ikki|ikkita|uch|uchta|toʻrt|besh|olti|yetti|sakkiz|toʻqqiz|oʻn|yigirma|oʻttiz|qirq|ellik|yuz|ming|million|milliard)/i;
export const SIGNATURE_PHRASES = [/gap shundaki/i, /tasavvur qilinglar/i, /\byaʼni\b/i, /\bbu degani\b/i, /\bqaranglar\b/i];
export const CTA_RE = /soʻzini\s+yozib\s+qoldiring/i;

/** The template (order and blocks), the hook, «Bu — X», «Eng qizigʻi», the lesson, the CTA, his phrases, apostrophes, length. */
export function validateAbrorScript(s: AbrorScript, o: { minWords?: number; maxWords?: number } = {}): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const parts = s.lines.map((l) => l.part);
  const seq = parts.join(" ");
  if (!/^hook intro (fact ){2,4}twist (lesson ){1,2}cta$/.test(seq)) issues.push({ rule: "template", message: `block order must be hook → intro → 2–4 fact → twist → 1–2 lesson → cta, got: ${seq}` });
  const hook = s.lines.find((l) => l.part === "hook");
  if (hook) {
    const w = words(hook.text);
    if (w.length > 12) issues.push({ rule: "hook_long", message: `the hook has ${w.length} words, at most 12`, line: 0 });
    if (!w.slice(0, 5).some((x) => /\d/.test(x) || UZ_NUMBER_WORDS.test(x))) issues.push({ rule: "hook_number", message: "the hook must say its number within the first five words", line: 0 });
  }
  const ht = s.hook_title.join(" ");
  if (words(ht).length > 6) issues.push({ rule: "hook_title_long", message: `the hook plate has ${words(ht).length} words, at most 6` });
  if (s.hook_title.some((l) => l !== upperUz(l))) issues.push({ rule: "hook_title_caps", message: "the hook plate must be in CAPS" });
  if (!/\d/.test(ht)) issues.push({ rule: "hook_title_number", message: "the hook plate must carry the number" });
  const intro = s.lines.find((l) => l.part === "intro");
  if (intro && !/^Bu\s*[—–-]\s*\S/.test(intro.text.trim())) issues.push({ rule: "intro", message: "the intro line must start with «Bu — X»", line: s.lines.indexOf(intro) });
  const twist = s.lines.find((l) => l.part === "twist");
  if (twist && !/^Eng qizigʻi\b/i.test(twist.text.trim())) issues.push({ rule: "twist", message: "the twist line must start with «Eng qizigʻi —»", line: s.lines.indexOf(twist) });
  const lesson = s.lines.filter((l) => l.part === "lesson").map((l) => l.text).join(" ");
  if (lesson && !/startap|startup|founder|asoschi|tadbirkor|oʻzbek|Oʻzbekiston|biznes/i.test(lesson)) issues.push({ rule: "lesson", message: "the lesson must speak to Uzbek founders (startup / tadbirkor / Oʻzbekiston)" });
  const cta = s.lines.at(-1);
  if (s.cta.kind === "keyword") {
    if (!cta || cta.part !== "cta" || !CTA_RE.test(cta.text)) issues.push({ rule: "cta", message: "the last line must be the CTA «… soʻzini yozib qoldiringlar»", line: s.lines.length - 1 });
    else if (s.cta.keyword && !upperUz(cta.text).includes(upperUz(s.cta.keyword))) issues.push({ rule: "cta_word", message: `the CTA must name the comment word «${s.cta.keyword}»`, line: s.lines.length - 1 });
  }
  const all = s.lines.map((l) => l.text).join(" ");
  const sig = SIGNATURE_PHRASES.filter((r) => r.test(all)).length;
  if (sig < 2) issues.push({ rule: "phrases", message: `use at least two of his phrases («Gap shundaki», «Tasavvur qilinglar», «Yaʼni», «bu degani»), found ${sig}` });
  for (const [i, l] of s.lines.entries()) {
    const ap = uzApostropheIssues(l.text);
    if (ap.length) issues.push({ rule: "apostrophe", message: `oʻ/gʻ must be U+02BB (and the glottal stop U+02BC): ${ap.map((a) => `«${a.word}» ${a.found}→${a.want}`).join(", ")}`, line: i });
    if (/[$%]|\b(mln|mlrd)\b/i.test(l.text)) issues.push({ rule: "speakable", message: "spoken lines say units in words (dollar, foiz, million, milliard), no $ % mln mlrd", line: i });
  }
  for (const t of [...s.hook_title, s.caption]) {
    const ap = uzApostropheIssues(t);
    if (ap.length) issues.push({ rule: "apostrophe", message: `on-screen text: ${ap.map((a) => `«${a.word}» ${a.found}→${a.want}`).join(", ")}` });
  }
  const n = words(all).length;
  const min = o.minWords ?? 80;
  const max = o.maxWords ?? 210;
  if (n < min || n > max) issues.push({ rule: "length", message: `${n} words, expected ${min}–${max}` });
  return issues;
}

// ---------------------------------------------------------------- normalisation

/** Model answer → script: apostrophes normalised everywhere, caps on the plate, the keyword set, sources attached. */
export function normalizeAbrorScript(raw: unknown, ctx: { topic: string; sources: AbrorSource[]; keyword: string; promise?: string }): AbrorScript {
  const out = OutSchema.parse(raw);
  const clean = (t: string) => normalizeUz(t.replace(/\s+/g, " ").trim());
  const lines = out.lines
    .map((l) => ({
      part: l.part,
      text: clean(l.text),
      visual: { kind: l.visual.kind, subject: l.visual.subject.trim(), value: normalizeUz(l.visual.value.trim()), label: normalizeUz(l.visual.label.trim()), url: l.visual.url.trim() },
      source: Number.isInteger(l.source) && l.source >= 0 && l.source < ctx.sources.length ? l.source : -1,
    }))
    .filter((l) => l.text);
  const art = out.article && out.article.source >= 0 && out.article.source < ctx.sources.length && out.article.key_line.trim() ? { source: out.article.source, key_line: out.article.key_line.replace(/\s+/g, " ").trim() } : null;
  return AbrorScriptSchema.parse({
    topic: ctx.topic,
    language: "uz",
    title: clean(out.title).slice(0, 80),
    hook_title: out.hook_title.map((h) => upperUz(h.replace(/\s+/g, " ").trim())).filter(Boolean).slice(0, 2),
    lines,
    cta: { kind: "keyword", keyword: upperUz(ctx.keyword), promise: ctx.promise ?? "" },
    article: art,
    sources: ctx.sources,
    caption: normalizeUz(out.caption.trim()),
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).slice(0, 6),
  });
}

/** The NEWS block of the prompt. */
export function newsBlock(sources: AbrorSource[]): string {
  return sources.map((s, i) => `[${i}] ${s.publisher}${s.date ? `, ${s.date}` : ""} — ${s.url}\nTITLE: ${s.title}\nTEXT: ${s.text.slice(0, 1800)}`).join("\n\n");
}

export interface WriteAbrorOptions {
  seconds?: number;
  keyword?: string;
  /** what the viewer gets for commenting («manbalar roʻyxatini yuboraman») */
  promise?: string;
  /** extra facts with sources from web research */
  factsText?: string;
  model?: string;
}

export interface WriteAbrorResult {
  script: AbrorScript;
  issues: ScriptIssue[];
  /** issues of the first draft (fixed by the rewrite) */
  firstIssues: ScriptIssue[];
  unverified: { line: number; raw: string }[];
  usd: number;
  model: string;
  provider: string;
  calls: number;
}

export const SPEAK_WPM = 125;
export const targetWords = (seconds: number) => Math.round((seconds * SPEAK_WPM) / 60);

export async function writeAbrorScript(topic: string, sources: AbrorSource[], llm: StructuredFn, o: WriteAbrorOptions = {}): Promise<WriteAbrorResult> {
  const seconds = o.seconds ?? 60;
  const keyword = (o.keyword ?? "MAN").trim();
  const words = targetWords(seconds);
  const maxWords = Math.round(words * 1.2);
  const news = newsBlock(sources);
  const facts = o.factsText ? `\nFACTS (web research, with sources):\n${o.factsText}\n` : "";
  const promise = o.promise ? `\nWHAT THEY GET FOR THE WORD: ${o.promise}` : "";
  const system = loadPrompt("make.abror.system");
  const schema = zodToApiSchema(OutSchema);
  const prompt = fill(loadPrompt("make.abror.user"), { topic, seconds, words, max_words: maxWords, keyword, promise, news, facts });
  const res = await llm({ system, prompt, schema, model: o.model, effort: "medium", maxTokens: 6000 });
  const ctx = { topic, sources, keyword, promise: o.promise };
  let script = normalizeAbrorScript(res.data, ctx);
  const lim = { minWords: Math.round(words * 0.6), maxWords: Math.round(words * 1.45) };
  const extra = o.factsText ?? "";
  const problems = (s: AbrorScript) => [...validateAbrorScript(s, lim), ...verifyNumbers(s, extra).map((b) => ({ rule: "unverified_number", message: `«${b.raw}» is not in the sources`, line: b.line }))];
  const firstIssues = problems(script);
  let issues = firstIssues;
  let usd = res.usd;
  let calls = 1;
  if (issues.length) {
    const fix = fill(loadPrompt("make.abror.rewrite"), { topic, keyword, news, facts, problems: issues.map((x) => `- ${x.rule}${x.line !== undefined && x.line >= 0 ? ` (line ${x.line})` : ""}: ${x.message}`).join("\n"), script: JSON.stringify({ title: script.title, hook_title: script.hook_title, lines: script.lines, article: script.article ?? { source: -1, key_line: "" }, caption: script.caption, hashtags: script.hashtags }, null, 1) });
    try {
      const again = await llm({ system, prompt: fix, schema, model: o.model, effort: "medium", maxTokens: 6000 });
      usd += again.usd;
      calls++;
      const s2 = normalizeAbrorScript(again.data, ctx);
      const left = problems(s2);
      if (left.length <= issues.length) {
        script = s2;
        issues = left;
      }
    } catch {
      /* the first draft stands, its issues are reported */
    }
  }
  return { script, issues, firstIssues, unverified: verifyNumbers(script, extra), usd, model: res.model, provider: res.provider, calls };
}

// ---------------------------------------------------------------- teleprompter + shot list

const PART_LABEL: Record<Part, string> = { hook: "HOOK", intro: "BU — X", fact: "FAKT", twist: "ENG QIZIGʻI", lesson: "XULOSA", cta: "CTA" };
const PART_NOTE: Record<Part, string> = {
  hook: "kameraga tik qarab, energiya bilan, birinchi soniyadan",
  intro: "oddiy soʻz bilan, oʻxshatish bilan",
  fact: "tez, raqamni urgʻu bilan",
  twist: "toʻxtab, qiziqtirib",
  lesson: "samimiy, «aka» ohangida",
  cta: "kameraga barmoq bilan koʻrsatib",
};

/** Seconds a line takes at his pace (≈125 words a minute) plus a breath. */
export function lineSeconds(text: string): number {
  return Math.round((words(text).length / (SPEAK_WPM / 60) + 0.35) * 10) / 10;
}

/** A spoken sentence → short teleprompter lines (≤ maxWords), broken after commas and dashes first. */
export function breakLine(text: string, maxWords = 6): string[] {
  const chunks = text.replace(/\s+/g, " ").trim().split(/(?<=[,;:])\s+|\s+(?=[—–]\s)/);
  const out: string[] = [];
  for (const c of chunks) {
    const w = c.split(" ").filter(Boolean);
    if (w.length <= maxWords) {
      out.push(w.join(" "));
      continue;
    }
    // even pieces of ≤ maxWords
    const n = Math.ceil(w.length / maxWords);
    const size = Math.ceil(w.length / n);
    for (let i = 0; i < w.length; i += size) out.push(w.slice(i, i + size).join(" "));
  }
  return out.filter(Boolean);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Where each line starts when read at his pace, and where the full-frame part (last ~25 %) begins. */
export function lineTimes(s: Pick<AbrorScript, "lines">, fullFrom = 0.75): { start: number; end: number; full: boolean }[] {
  let t = 0;
  const raw = s.lines.map((l) => {
    const d = lineSeconds(l.text);
    const r = { start: t, end: t + d };
    t += d;
    return r;
  });
  const total = t;
  // the switch lands on the first line that starts after fullFrom of the runtime, and never later than the lesson
  const firstLesson = s.lines.findIndex((l) => l.part === "lesson");
  let k = raw.findIndex((r) => r.start >= fullFrom * total - 0.01);
  if (k < 0 || (firstLesson >= 0 && k > firstLesson)) k = firstLesson >= 0 ? firstLesson : raw.length - 1;
  return raw.map((r, i) => ({ start: Math.round(r.start * 10) / 10, end: Math.round(r.end * 10) / 10, full: i >= k }));
}

/** The clean read-aloud text: short lines, a pause mark between blocks, block labels and delivery notes in brackets. */
export function teleprompterText(s: AbrorScript, o: { fullFrom?: number } = {}): string {
  const times = lineTimes(s, o.fullFrom);
  const total = times.at(-1)?.end ?? 0;
  const nWords = words(s.lines.map((l) => l.text).join(" ")).length;
  const out: string[] = [];
  out.push(`TELEPROMPTER · ${s.title || s.topic}`);
  out.push(`≈${Math.round(total)} s · ${nWords} soʻz · 125 soʻz/daqiqa · format abror_split`);
  out.push("");
  let prev: Part | null = null;
  s.lines.forEach((l, i) => {
    if (l.part !== prev) {
      if (prev) out.push("", "   ⏸", "");
      out.push(`[${mmss(times[i].start)} · ${PART_LABEL[l.part]} — ${PART_NOTE[l.part]}${times[i].full && (i === 0 || !times[i - 1].full) ? " · BU YERDAN BOSH BUTUN KADRDA" : ""}]`);
      prev = l.part;
    }
    for (const b of breakLine(l.text)) out.push(b);
  });
  out.push("", "   ■ OXIRI");
  return out.join("\n");
}

const VISUAL_TEXT: Record<AbrorLine["visual"]["kind"], string> = {
  logo: "логотип",
  site: "сайт компании (прокрутка)",
  article: "скрин статьи, ключевая строка под розовым маркером",
  number: "карточка числа",
  ui: "интерфейс продукта в телефоне",
  photo: "фото",
  text: "текстовая карточка",
};

/** What the editor will put where (for him: which line goes over which picture, and where he fills the frame). */
export function shotListText(s: AbrorScript, o: { fullFrom?: number } = {}): string {
  const times = lineTimes(s, o.fullFrom);
  const out: string[] = [];
  out.push(`SHOT LIST · ${s.title || s.topic}`);
  out.push("Съёмка: селфи на фронтальную камеру с вытянутой руки, вертикально 9:16, петличка, одна локация, свет на лицо; голова в верхней трети кадра (в сплите она окажется в нижней панели).");
  out.push("Монтаж (пресет abror_split): сплит — сверху вставка на всю ширину, шов на 0.42, снизу вы; последние ~25 % — вы на весь кадр; хук-плашка 0–4 с; субтитры строчными на шве.");
  out.push(`Хук-плашка: ${s.hook_title.join(" / ")}`);
  out.push("");
  s.lines.forEach((l, i) => {
    const v = l.visual;
    const what = times[i].full ? "ВЫ НА ВЕСЬ КАДР" : `верх: ${VISUAL_TEXT[v.kind]}${v.subject ? ` «${v.subject}»` : ""}${v.value ? ` ${v.value}` : ""}${v.label ? ` (${v.label})` : ""}`;
    const extra = l.part === "cta" && s.cta.keyword ? ` + карточка «"${s.cta.keyword}"» над субтитрами` : "";
    const src = l.source >= 0 && s.sources[l.source] ? ` [источник ${l.source + 1}]` : "";
    out.push(`${String(i + 1).padStart(2)}. ${mmss(times[i].start)}–${mmss(times[i].end)} ${PART_LABEL[l.part].padEnd(11)} ${what}${extra}${src}`);
    out.push(`    «${l.text}»`);
  });
  if (s.article) out.push("", `Скрин статьи: [${s.article.source + 1}] ${s.sources[s.article.source]?.publisher ?? ""} — «${s.article.key_line}»`);
  return out.join("\n");
}

/** The post description: his caption + the sources the facts came from (+ credits added by the caller). */
export function descriptionText(s: AbrorScript, credits: string[] = []): string {
  const out = [s.caption.trim()];
  if (s.hashtags.length) out.push("", s.hashtags.map((h) => `#${h}`).join(" "));
  if (s.sources.length) {
    out.push("", "Manbalar:");
    s.sources.forEach((x, i) => out.push(`${i + 1}. ${x.publisher ? `${x.publisher} — ` : ""}${x.title}${x.date ? ` (${x.date})` : ""}\n   ${x.url}`));
  }
  if (credits.length) out.push("", ...credits);
  return out.join("\n");
}
