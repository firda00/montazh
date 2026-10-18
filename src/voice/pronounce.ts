/**
 * Pronunciation layer: written narration → what a TTS engine should read, applied before every engine
 * (Gemini, Cloud TTS, Piper). Russian:
 *   1. markup/emoji out (normalize.stripMarkup);
 *   2. versions next to Latin names: «GPT-5» → «GPT пять», «Claude 3.5 Sonnet» → «Claude три точка пять Sonnet»,
 *      «A100» → «A сто», «GPT-4o» → «GPT четыре о»;
 *   3. dictionary (data/pronounce.ru.json + VEDIT_PRONOUNCE_DICT): «OpenAI» → «Оупен Эй-Ай», «Nvidia» → «Энвидиа»,
 *      a Russian ending glued with ' or - stays («Google'а» → «Гугла»);
 *   4. unknown Latin: acronyms letter by letter in Russian letter names («SDK» → «Эс-Ди-Кей»), other words —
 *      a rule-based English→Russian transliteration («Thrive» → «Трайв») or kept as written (latin: "keep");
 *   5. numbers, money, percentages, dates, ranges, units with case agreement (normalize.normalizeRu);
 *   6. optional stress marks (combining acute U+0301) on words from the dictionary's "stress" list.
 * Other languages: markup out, numbers for English as before.
 *
 * scoreSpeech() compares an ASR transcript of the spoken result with the intended text on canonical spoken forms
 * (both sides through the same layer), giving a WER and a hit rate for brand names and numbers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeForTts, stripMarkup, tidy, type NumberStyle } from "./normalize.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRONOUNCE_DICT = path.join(ROOT, "data", "pronounce.ru.json");

export interface PronounceDict {
  terms: Record<string, string>;
  stress: Record<string, string>;
}

export interface PronounceOptions {
  /** what to do with Latin words that are not in the dictionary (default "translit") */
  latin?: "translit" | "keep";
  /** put combining acute accents on the "stress" words (default false: only engines that honour it) */
  stress?: boolean;
  /** extra terms (e.g. a user's own names), win over the shipped dictionary */
  extra?: Record<string, string>;
  numbers?: NumberStyle;
  /** spell numbers (default true); false keeps digits for engines that read them better themselves */
  spellNumbers?: boolean;
  /** «ИИ» → «искусственный интеллект» (default true: Piper reads «ИИ» as «и»); Gemini says «И-И» itself */
  expandAcronyms?: boolean;
  dict?: PronounceDict;
}

let cached: PronounceDict | null = null;

function readDict(file: string): Partial<PronounceDict> {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PronounceDict>;
    return { terms: j.terms ?? {}, stress: j.stress ?? {} };
  } catch {
    return {};
  }
}

/** The shipped dictionary plus every file in VEDIT_PRONOUNCE_DICT (comma/semicolon list; later wins). */
export function loadPronounceDict(env: NodeJS.ProcessEnv = process.env): PronounceDict {
  if (cached && env === process.env) return cached;
  const d: PronounceDict = { terms: {}, stress: {} };
  for (const f of [PRONOUNCE_DICT, ...(env.VEDIT_PRONOUNCE_DICT ?? "").split(/[;,]/).map((s) => s.trim()).filter(Boolean)]) {
    const x = readDict(f);
    Object.assign(d.terms, x.terms ?? {});
    Object.assign(d.stress, x.stress ?? {});
  }
  if (env === process.env) cached = d;
  return d;
}

// ---- Latin letters, acronyms, transliteration ----
const LETTERS: Record<string, string> = {
  a: "эй", b: "би", c: "си", d: "ди", e: "и", f: "эф", g: "джи", h: "эйч", i: "ай", j: "джей", k: "кей", l: "эл", m: "эм",
  n: "эн", o: "о", p: "пи", q: "кью", r: "ар", s: "эс", t: "ти", u: "ю", v: "ви", w: "дабл-ю", x: "икс", y: "уай", z: "зед",
};

/** «SDK» → «Эс-Ди-Кей». */
export function spellLetters(word: string): string {
  const parts = [...word.toLowerCase()].filter((c) => LETTERS[c]).map((c) => LETTERS[c]);
  const s = parts.join("-");
  return s ? s[0].toUpperCase() + s.slice(1) : word;
}

// ordered: longer patterns first; applied left to right on a lowercase word
const TRANSLIT: [RegExp, string][] = [
  [/^kn/, "н"], [/^wr/, "р"], [/^ps/, "с"], [/^wh/, "у"],
  [/^x/, "з"], [/^y(?=[aeiou])/, "й"], [/^e/, "э"], [/^u(?=[^aeiou][aeiou])/, "ю"],
  [/tion/, "шн"], [/sion/, "жн"], [/ture/, "чер"], [/ight/, "айт"], [/igh/, "ай"], [/ough/, "оу"],
  [/sch/, "ш"], [/tch/, "ч"], [/dge/, "дж"],
  [/ph/, "ф"], [/sh/, "ш"], [/ch/, "ч"], [/th/, "т"], [/ck/, "к"], [/qu/, "кв"], [/gh/, "г"],
  [/ee/, "и"], [/ea/, "и"], [/oo/, "у"], [/ou/, "ау"], [/ow$/, "оу"], [/ow/, "ау"], [/ai/, "эй"], [/ay/, "эй"], [/ey$/, "и"], [/ey/, "эй"],
  [/oi/, "ой"], [/oy/, "ой"], [/au/, "о"], [/aw/, "о"], [/ew/, "ью"], [/ue$/, "ю"], [/ie$/, "и"],
  // long vowels marked by a magic e (see transliterate)
  [/ā/, "эй"], [/ī/, "ай"], [/ō/, "оу"], [/ū/, "ю"],
  [/le$/, "л"], [/e$/, ""], [/y$/, "и"],
  [/c(?=[eiy])/, "с"], [/g(?=e[^r]|i|y)/, "дж"], [/x/, "кс"], [/j/, "дж"], [/w/, "у"], [/c/, "к"], [/q/, "к"],
  [/h(?=[aeiouy])/, "х"], [/h/, ""], [/y(?=[aeiou])/, "й"], [/y/, "и"],
  [/a/, "а"], [/b/, "б"], [/d/, "д"], [/e/, "е"], [/f/, "ф"], [/g/, "г"], [/i/, "и"], [/k/, "к"], [/l/, "л"], [/m/, "м"],
  [/n/, "н"], [/o/, "о"], [/p/, "п"], [/r/, "р"], [/s/, "с"], [/t/, "т"], [/u/, "а"], [/v/, "в"], [/z/, "з"],
];

/** Rule-based English → Russian transliteration of one word: «Thrive» → «Трайв», «Capital» → «Капитал». */
export function transliterate(word: string): string {
  // magic e: thrive → thrīv, cake → cāk, code → cōd, cube → cūb
  let s = word.toLowerCase().replace(/([aiou])([bcdfgklmnprstvz])e(s?)$/, (_m, v: string, c: string, pl: string) => `${{ a: "ā", i: "ī", o: "ō", u: "ū" }[v]}${c}${pl}`);
  let out = "";
  // greedy left-to-right: at every position try the rules anchored there
  while (s.length) {
    let done = false;
    for (const [re, to] of TRANSLIT) {
      const anchored = new RegExp(`^(?:${re.source.replace(/^\^/, "")})`);
      // end-anchored rules only fire when the rest of the word is exactly the match
      const m = anchored.exec(s);
      if (!m) continue;
      if (re.source.startsWith("^") && out.length) continue;
      if (re.source.endsWith("$") && m[0].length !== s.length) continue;
      out += to.replace(/\$1/g, m[1] ?? "");
      s = s.slice(m[0].length);
      done = true;
      break;
    }
    if (!done) {
      out += /[a-zāīōū]/.test(s[0]) ? "" : s[0];
      s = s.slice(1);
    }
  }
  out = out.replace(/(.)\1{2,}/g, "$1$1");
  return /^[A-Z]/.test(word) && out ? out[0].toUpperCase() + out.slice(1) : out;
}

const VOWELS = /[aeiouy]/i;
/** All caps (≤ 5 letters) or no vowels → letters; else a word. */
const isAcronym = (w: string) => (/^[A-Z]{2,5}s?$/.test(w) && !/^[A-Z][a-z]/.test(w)) || (w.length <= 4 && !VOWELS.test(w));

/** Spoken digits of a version: "3.5" → «три точка пять», "4o" → «четыре о», "16" → «шестнадцать». */
function versionWords(v: string): string {
  const m = /^(\d+(?:\.\d+)*)([a-z]*)$/i.exec(v);
  if (!m) return v;
  const nums = m[1].split(".").map((p) => normalizeForTts(String(Number(p)), "ru"));
  const letters = m[2] ? ` ${m[2].length <= 2 ? spellLetters(m[2]).toLowerCase() : m[2]}` : "";
  return nums.join(" точка ") + letters;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** a Latin "word": letters, digits, & . ' - inside */
const LATIN_TOKEN = /(?<![\p{L}\p{N}])[A-Za-z][A-Za-z0-9&]*(?:[.'’-][A-Za-z0-9&]+)*/gu;

interface Matcher {
  re: RegExp;
  to: Map<string, string>;
}
const matchers = new WeakMap<Record<string, string>, Matcher>();

function termMatcher(terms: Record<string, string>): Matcher {
  const hit = matchers.get(terms);
  if (hit) return hit;
  const keys = Object.keys(terms).sort((a, b) => b.length - a.length);
  const to = new Map<string, string>();
  for (const k of keys) to.set(k.length <= 2 ? k : k.toLowerCase(), terms[k]);
  // long keys match case-insensitively; one- and two-letter keys (X, AI, IT) only as written
  const alts = keys.map((k) => (k.length <= 2 ? `(?-i:${esc(k)})` : esc(k).replace(/ /g, "\\s+")));
  // a Russian ending may be glued with ' or -: Google'а, OpenAI-ю
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${alts.join("|")})(?:['’-]([а-яё]{1,4}))?(?![\\p{L}\\p{N}])`, "giu");
  const m = { re, to };
  matchers.set(terms, m);
  return m;
}

function applyTerms(s: string, terms: Record<string, string>): string {
  if (!Object.keys(terms).length) return s;
  const { re, to } = termMatcher(terms);
  return s.replace(re, (_m, key: string, ending?: string) => {
    const k = key.replace(/\s+/g, " ");
    const spoken = to.get(k) ?? to.get(k.toLowerCase()) ?? key;
    return ending ? `${spoken}${ending}` : spoken;
  });
}

/** Stress marks: «квартал» → «кварта́л» (only whole words from the list, case kept). */
export function applyStress(s: string, stress: Record<string, string>): string {
  const keys = Object.keys(stress);
  if (!keys.length) return s;
  const lower = new Map(keys.map((k) => [k.toLowerCase(), stress[k]]));
  return s.replace(/[\p{L}́]+/gu, (w) => {
    if (w.includes("́")) return w;
    const to = lower.get(w.toLowerCase());
    if (!to) return w;
    return /^\p{Lu}/u.test(w) ? to[0].toUpperCase() + to.slice(1) : to;
  });
}

/** Written Russian narration → what the TTS should say. */
export function pronounceRu(text: string, o: PronounceOptions = {}): string {
  const dict = o.dict ?? loadPronounceDict();
  const terms = o.extra ? { ...dict.terms, ...o.extra } : dict.terms;
  let s = stripMarkup(text);
  // «x3» / «×3» is a multiplier, «Q3» a quarter — normalizeRu reads them; keep them away from the Latin rules
  const guard = (w: string) => /^[xх×]\d/i.test(w) || /^Q[1-4]$/.test(w);
  // versions glued to a Latin name: GPT-5, GPT-4o, COVID-19 → «GPT пять»
  s = s.replace(/(?<![\p{L}\p{N}])([A-Za-z][A-Za-z]*)-(\d+(?:\.\d+)*[a-z]{0,2})(?![\p{L}\p{N}]|\.\d)/gu, (m, name: string, v: string) => (guard(m) ? m : `${name} ${versionWords(v)}`));
  // a dotted version next to a Latin word: «Claude 3.5 Sonnet», «iOS 18.1»
  s = s.replace(/(?<=[A-Za-z]\s)(\d+\.\d+(?:\.\d+)*[a-z]?)(?![\p{L}\p{N}])/gu, (v) => versionWords(v));
  s = s.replace(/(?<![\p{L}\p{N}.,])(\d+\.\d+[a-z]?)(?=\s+[A-Za-z])/gu, (v) => versionWords(v));
  // letters+digits glued: A100, H100, M4, RTX4090 → «A сто»; digits+letters: 5G (dictionary first)
  s = applyTerms(s, terms);
  s = s.replace(/(?<![\p{L}\p{N}])([A-Za-z]{1,4})(\d{1,5})(?![\p{L}\p{N}])/gu, (m, l: string, d: string) => (guard(m) ? m : `${l} ${normalizeForTts(d, "ru")}`));
  s = applyTerms(s, terms);
  s = s.replace(LATIN_TOKEN, (w) => {
    if (guard(w)) return w;
    const parts = w.split(/(?<=[a-z])(?=[A-Z][a-z])/); // CamelCase → words
    return parts
      .map((p) => {
        const base = p.replace(/['’]s$/, "");
        if (isAcronym(base) || /^[A-Z]$/.test(base)) return spellLetters(base);
        return o.latin === "keep" ? p : transliterate(base);
      })
      .join(" ");
  });
  // «ИИ-кодинг» is «И-И кодинг», never «искусственный интеллект-кодинг»
  s = s.replace(/(?<!\p{L})ИИ-(?=\p{L})/gu, "И-И ");
  const keepIi = o.expandAcronyms === false;
  if (keepIi) s = s.replace(/(?<!\p{L})ИИ(?!\p{L})/gu, "");
  s = o.spellNumbers === false ? s : normalizeForTts(s, "ru", o.numbers);
  if (keepIi) s = s.replace(//g, "ИИ");
  if (o.stress) s = applyStress(s, dict.stress);
  return tidy(s);
}

/** Text → spoken form for a language; Russian goes through the full layer, others through normalizeForTts. */
export function pronounce(text: string, language = "ru", o: PronounceOptions = {}): string {
  const l = language.toLowerCase().slice(0, 2);
  // a Russian voice handed a Latin-script line (an English or Uzbek script): Russian rules would mangle it
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const cyr = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  if (l === "ru" && latin > 2 * cyr + 8) return normalizeForTts(text, /[ʻʼ‘’]|\b(va|bu|uchun|bilan)\b/i.test(text) ? "uz" : "en");
  if (l === "ru") return pronounceRu(text, o);
  return normalizeForTts(text, l);
}

// ---- scoring an ASR transcript against the intended narration ----

/** Canonical spoken words: through the layer, lowercase, ё → е, hyphens split, punctuation out. */
export function canonicalWords(text: string, language = "ru"): string[] {
  return pronounce(text, language, { latin: "translit" })
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/́/g, "")
    .replace(/[-‐–—]/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function editDistance<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = (x, y) => x === y): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (eq(a[i - 1], b[j - 1]) ? 0 : 1));
      diag = t;
    }
  }
  return prev[b.length];
}

/** 1 = same string, 0 = nothing in common (normalised Levenshtein over characters). */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1;
  return 1 - editDistance([...a], [...b]) / Math.max(a.length, b.length);
}

export interface TermScore {
  term: string;
  spoken: string;
  hit: boolean;
  heard: string;
}
export interface SpeechScore {
  wer: number;
  errors: number;
  refWords: number;
  terms: TermScore[];
  termHits: number;
}

/** The hard bits of a narration: Latin names (with their versions) and numbers (with their units). */
export function hardTerms(text: string): string[] {
  const out: string[] = [];
  const re = /(?<![\p{L}\p{N}])(?:[A-Za-z][A-Za-z0-9&'’.-]*(?:\s+(?:\d+(?:\.\d+)?|[A-Z][A-Za-z]+))*|[$€₽]?\d+(?:[  ]\d{3})*(?:[.,]\d+)?(?:[–—-]\d+(?:[.,]\d+)?)?(?:-[а-яё]{1,3})?\s?(?:%|млрд|млн|тыс|трлн|миллиард\p{L}*|миллион\p{L}*|тысяч\p{L}*|процент\p{L}*|долл\p{L}*|раз\p{L}*)?)/gu;
  for (const m of text.matchAll(re)) {
    const t = m[0].trim().replace(/[.,]+$/, "");
    if (/[\p{L}\p{N}]/u.test(t)) out.push(t);
  }
  return out;
}

/**
 * Word error rate of `heard` (an ASR transcript) against `meant` (the narration as written), both in canonical
 * spoken form, plus which hard terms came through: a term is heard when the best-matching window of the transcript
 * is ≥ 0.8 similar to the term's spoken form (letters only, spaces ignored).
 */
export function scoreSpeech(meant: string, heard: string, language = "ru"): SpeechScore {
  const ref = canonicalWords(meant, language);
  const hyp = canonicalWords(heard, language);
  const errors = editDistance(ref, hyp, (a, b) => a === b || (a.length > 4 && similarity(a, b) >= 0.8));
  const flat = (ws: string[]) => ws.join("");
  // each term's words in the reference: what is left of the canonical text once the canonical prefix and suffix
  // are taken away (so «3.5» before «Sonnet» and «400 млн» after «от» keep their in-sentence reading)
  let from = 0;
  const terms = hardTerms(meant).map((t) => {
    const at = meant.indexOf(t, from);
    from = at >= 0 ? at + t.length : from;
    let target = canonicalWords(t, language);
    if (at >= 0) {
      const pre = canonicalWords(meant.slice(0, at), language).length;
      const post = canonicalWords(meant.slice(at + t.length), language).length;
      if (ref.length - post > pre) target = ref.slice(pre, ref.length - post);
    }
    let heardBest = { sim: 0, words: [] as string[] };
    for (let n = Math.max(1, target.length - 1); n <= target.length + 2; n++)
      for (let i = 0; i + n <= hyp.length; i++) {
        const sim = similarity(flat(hyp.slice(i, i + n)), flat(target));
        if (sim > heardBest.sim) heardBest = { sim, words: hyp.slice(i, i + n) };
      }
    return { term: t, spoken: target.join(" "), hit: heardBest.sim >= 0.8, heard: heardBest.words.join(" ") };
  });
  return { wer: ref.length ? errors / ref.length : 0, errors, refWords: ref.length, terms, termHits: terms.filter((t) => t.hit).length };
}
