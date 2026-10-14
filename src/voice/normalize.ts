/**
 * Text → what a TTS engine should read. Pure functions, no dependencies.
 * Russian: numbers to words with noun agreement (проценты, доллары, рубли, тысячи/миллионы/миллиарды),
 * years after «в» to the prepositional ordinal («в 2026» → «в две тысячи двадцать шестом году»),
 * "$", "%", "×3", common abbreviations; emojis, hashtags and markdown are stripped for every language.
 * Piper (espeak-ng) reads bare digits itself, but without agreement and often with the wrong case.
 */

const ONES_M = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["ноль", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

export type Gender = "m" | "f";

/** Russian plural form index for an integer: 0 = один процент, 1 = два процента, 2 = пять процентов. */
export function pluralIndex(n: number): 0 | 1 | 2 {
  const a = Math.abs(Math.trunc(n));
  const d10 = a % 10;
  const d100 = a % 100;
  if (d10 === 1 && d100 !== 11) return 0;
  if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return 1;
  return 2;
}

/** "один/два/пять" + the right form of the noun. */
export function plural(n: number, forms: readonly [string, string, string]): string {
  return forms[pluralIndex(n)];
}

function triad(n: number, g: Gender): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const t = n % 100;
  if (h) out.push(HUNDREDS[h]);
  if (t >= 10 && t < 20) out.push(TEENS[t - 10]);
  else {
    if (Math.floor(t / 10)) out.push(TENS[Math.floor(t / 10)]);
    if (t % 10) out.push((g === "f" ? ONES_F : ONES_M)[t % 10]);
  }
  return out;
}

const SCALES: { value: number; forms: [string, string, string]; g: Gender }[] = [
  { value: 1e9, forms: ["миллиард", "миллиарда", "миллиардов"], g: "m" },
  { value: 1e6, forms: ["миллион", "миллиона", "миллионов"], g: "m" },
  { value: 1e3, forms: ["тысяча", "тысячи", "тысяч"], g: "f" },
];

/** Cardinal number in words (0 … 999 999 999 999); gender of the last group for 1/2. */
export function numberToWords(n: number, g: Gender = "m"): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `минус ${numberToWords(-n, g)}`;
  n = Math.trunc(n);
  if (n === 0) return "ноль";
  if (n >= 1e12) return String(n);
  const out: string[] = [];
  let rest = n;
  for (const s of SCALES) {
    const k = Math.floor(rest / s.value);
    if (k) {
      out.push(...triad(k, s.g), plural(k, s.forms));
      rest -= k * s.value;
    }
  }
  if (rest) out.push(...triad(rest, g));
  return out.join(" ");
}

// ---- ordinals (years) ----
const ORD_ONES = ["", "первый", "второй", "третий", "четвёртый", "пятый", "шестой", "седьмой", "восьмой", "девятый"];
const ORD_TEENS = ["десятый", "одиннадцатый", "двенадцатый", "тринадцатый", "четырнадцатый", "пятнадцатый", "шестнадцатый", "семнадцатый", "восемнадцатый", "девятнадцатый"];
const ORD_TENS = ["", "", "двадцатый", "тридцатый", "сороковой", "пятидесятый", "шестидесятый", "семидесятый", "восьмидесятый", "девяностый"];
const ORD_HUNDREDS = ["", "сотый", "двухсотый", "трёхсотый", "четырёхсотый", "пятисотый", "шестисотый", "семисотый", "восьмисотый", "девятисотый"];
const THOUSAND_PREFIX = ["", "", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти"];

export type Case = "nom" | "gen" | "dat" | "prep";

function declineOrdinal(word: string, c: Case): string {
  if (c === "nom") return word;
  const end = { gen: "ого", dat: "ому", prep: "ом" }[c];
  if (word === "третий") return `треть${end.replace(/^о/, "е")}`;
  return word.replace(/(ый|ой|ий)$/, end);
}

/** Masculine ordinal (1 … 9999) in a case: 2026 → «две тысячи двадцать шестой / шестого / шестом». */
export function ordinalToWords(n: number, c: Case = "nom"): string {
  n = Math.trunc(n);
  if (n <= 0 || n >= 10000) return String(n);
  const th = Math.floor(n / 1000);
  const below = n % 1000;
  if (!below) return declineOrdinal(th === 1 ? "тысячный" : `${THOUSAND_PREFIX[th]}тысячный`, c);
  // «тысяча девятьсот…», not «одна тысяча девятьсот…»
  const prefix: string[] = th ? [th === 1 ? "тысяча" : numberToWords(th * 1000)] : [];
  const h = Math.floor(below / 100);
  const t = below % 100;
  if (!t) return [...prefix, declineOrdinal(ORD_HUNDREDS[h], c)].join(" ");
  if (h) prefix.push(HUNDREDS[h]);
  let last: string;
  if (t >= 10 && t < 20) last = ORD_TEENS[t - 10];
  else if (t % 10 === 0) last = ORD_TENS[t / 10];
  else {
    if (t >= 20) prefix.push(TENS[Math.floor(t / 10)]);
    last = ORD_ONES[t % 10];
  }
  return [...prefix, declineOrdinal(last, c)].join(" ");
}

// ---- decimals ----
/** «2,5» → «две целых пять десятых»; returns words and whether the noun must take the genitive singular. */
export function decimalToWords(intPart: string, frac: string): string {
  const i = Number(intPart);
  const f = frac.slice(0, 3);
  const fn = Number(f);
  const whole = `${numberToWords(i, "f")} ${plural(i, ["целая", "целых", "целых"])}`;
  const denom: [string, string, string][] = [
    ["десятая", "десятых", "десятых"],
    ["сотая", "сотых", "сотых"],
    ["тысячная", "тысячных", "тысячных"],
  ];
  return `${whole} ${numberToWords(fn, "f")} ${plural(fn, denom[f.length - 1])}`;
}

// ---- nouns that agree with a number ----
interface Noun {
  forms: [string, string, string];
  g: Gender;
}
const NOUNS: Record<string, Noun> = {
  "%": { forms: ["процент", "процента", "процентов"], g: "m" },
  "$": { forms: ["доллар", "доллара", "долларов"], g: "m" },
  "€": { forms: ["евро", "евро", "евро"], g: "m" },
  "₽": { forms: ["рубль", "рубля", "рублей"], g: "m" },
  "руб": { forms: ["рубль", "рубля", "рублей"], g: "m" },
  "сум": { forms: ["сум", "сума", "сумов"], g: "m" },
  "тыс": { forms: ["тысяча", "тысячи", "тысяч"], g: "f" },
  "млн": { forms: ["миллион", "миллиона", "миллионов"], g: "m" },
  "млрд": { forms: ["миллиард", "миллиарда", "миллиардов"], g: "m" },
  "трлн": { forms: ["триллион", "триллиона", "триллионов"], g: "m" },
  "км": { forms: ["километр", "километра", "километров"], g: "m" },
  "кг": { forms: ["килограмм", "килограмма", "килограммов"], g: "m" },
  "мин": { forms: ["минута", "минуты", "минут"], g: "f" },
  "сек": { forms: ["секунда", "секунды", "секунд"], g: "f" },
  "ч": { forms: ["час", "часа", "часов"], g: "m" },
};

/** A number (as written: "12", "2,5", "1 000") with an agreeing noun; decimals take the genitive singular. */
function numberWithNoun(num: string, noun?: Noun): string {
  const clean = num.replace(/[\s ]/g, "");
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(clean);
  if (!m) return num;
  // 1,5 → «полтора процента / полторы тысячи»
  if (m[1] === "1" && /^50?$/.test(m[2] ?? "") && noun) return `${noun.g === "f" ? "полторы" : "полтора"} ${noun.forms[1]}`;
  if (m[2]) return `${decimalToWords(m[1], m[2])}${noun ? ` ${noun.forms[1]}` : ""}`;
  const n = Number(m[1]);
  return `${numberToWords(n, noun?.g ?? "m")}${noun ? ` ${plural(n, noun.forms)}` : ""}`;
}

const ABBREVIATIONS: [RegExp, string][] = [
  // JS \b is ASCII-only: Cyrillic boundaries are lookarounds on \p{L}
  [/(?<!\p{L})т\.\s?е\./giu, "то есть"],
  [/(?<!\p{L})и\s+т\.\s?д\./giu, "и так далее"],
  [/(?<!\p{L})и\s+т\.\s?п\./giu, "и тому подобное"],
  [/(?<!\p{L})и\s+др\./giu, "и другие"],
  [/(?<!\p{L})т\.\s?к\./giu, "так как"],
  [/(?<!\p{L})напр\./giu, "например"],
  [/(?<!\p{L})ул\.\s?/giu, "улица "],
  [/\bAI\b/g, "эй-ай"],
  [/(?<!\p{L})ИИ(?!\p{L})/gu, "искусственный интеллект"],
  [/(?<!\p{L})США(?!\p{L})/gu, "эс-ша-а"],
];

/** feminine nouns that commonly follow a bare number («21 тысяча», «2 минуты») — for один/одна, два/две */
const FEMININE_NEXT = /^(тысяч|минут|секунд|недел|чашк|страниц|книг|ошибк|причин|стран|компани|вещ|иде|привычк|минут)/i;
/** a unit that swallowed a sentence-final dot: put the dot back */
const keepDot = (m: string, s: string, at: number) => (m.endsWith(".") && /^\s+[А-ЯЁA-Z]|^\s*$/.test(s.slice(at + m.length)) ? "." : "");

/** Emojis, pictographs, variation selectors, zero-width joiners, keycaps. */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

/** Markdown, links, hashtags, emojis → plain text (any language). */
export function stripMarkup(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/(^|\s)#([\p{L}\p{N}_]+)/gu, "$1$2")
    .replace(EMOJI, "")
    .replace(/[*_~|<>]/g, " ")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const NUM = String.raw`\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SCALE = String.raw`(тыс|млн|млрд|трлн)(?!\p{L})\.?`;
const CUR = String.raw`[$€₽]|руб(?:л(?:ей|я|ь))?\.?|сум(?:ов|а)?(?!\p{L})|долл(?:аров|ара|ар)?\.?`;
const END = String.raw`(?=[\s.,!?;:)»"]|$)`;
const curKey = (c: string) => {
  const k = c.replace(/\.$/, "").toLowerCase();
  return k.startsWith("руб") ? "руб" : k.startsWith("сум") ? "сум" : k.startsWith("долл") ? "$" : k;
};

/** Russian TTS normalisation. */
export function normalizeRu(input: string): string {
  let s = stripMarkup(input);
  for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);

  // ×3 / x3 / х3 → «в три раза»
  const RAZ: Noun = { forms: ["раз", "раза", "раз"], g: "m" };
  s = s.replace(/(^|[\s(])[×xх]\s?(\d+(?:[.,]\d+)?)(?=[\s.,!?;:)]|$)/giu, (_m, pre: string, n: string) => `${pre}в ${numberWithNoun(n, RAZ)}`);
  s = s.replace(/(^|[\s(])(\d+(?:[.,]\d+)?)\s?[×xх](?=[\s.,!?;:)]|$)/giu, (_m, pre: string, n: string) => `${pre}в ${numberWithNoun(n, RAZ)}`);

  // years: «в 2026 (году)» → prepositional ordinal; «2026 год» / «2026 года» / «2026 г.»
  const YEAR = String.raw`(1[89]\d\d|20\d\d)`;
  const YEAR_WORD = String.raw`(?:\s*(?:году|г\.|г${END}))?`;
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(в|во)\s+${YEAR}${YEAR_WORD}${END}`, "giu"), (_m, pre: string, v: string, y: string) => `${pre}${v} ${ordinalToWords(Number(y), "prep")} году`);
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(к|ко)\s+${YEAR}${YEAR_WORD}${END}`, "giu"), (_m, pre: string, v: string, y: string) => `${pre}${v} ${ordinalToWords(Number(y), "dat")} году`);
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])${YEAR}\s+(год|года|году)${END}`, "giu"), (_m, pre: string, y: string, w: string) => {
    const c: Case = w.toLowerCase() === "года" ? "gen" : w.toLowerCase() === "году" ? "prep" : "nom";
    return `${pre}${ordinalToWords(Number(y), c)} ${w}`;
  });

  // currency before the number: $5, $5 млн, € 3,5
  s = s.replace(new RegExp(String.raw`([$€₽])\s?(${NUM})(?:\s?${SCALE})?`, "giu"), (m: string, cur: string, n: string, scale: string | undefined, at: number, all: string) => {
    if (scale) return `${numberWithNoun(n, NOUNS[scale.toLowerCase()])} ${NOUNS[cur].forms[2]}${keepDot(m, all, at)}`;
    return numberWithNoun(n, NOUNS[cur]);
  });
  // number + scale (+ currency): 5 млн $, 2,5 млрд рублей
  s = s.replace(new RegExp(String.raw`(${NUM})\s?${SCALE}(?:\s?(${CUR}))?`, "giu"), (m: string, n: string, scale: string, cur: string | undefined, at: number, all: string) => {
    const words = numberWithNoun(n, NOUNS[scale.toLowerCase()]);
    return `${words}${cur ? ` ${NOUNS[curKey(cur)].forms[2]}` : ""}${keepDot(m, all, at)}`;
  });
  // number + unit: 30%, 5 $, 100 ₽, 10 руб., 15 мин, 3 км
  s = s.replace(new RegExp(String.raw`(${NUM})\s?(%|${CUR}|(?:км|кг|мин|сек|ч)(?!\p{L})\.?)`, "giu"), (m: string, n: string, u: string, at: number, all: string) => {
    const key = /^(км|кг|мин|сек|ч)/i.test(u) ? u.replace(/\.$/, "").toLowerCase() : u === "%" ? "%" : curKey(u);
    return `${numberWithNoun(n, NOUNS[key])}${keepDot(m, all, at)}`;
  });
  // ranges 10–20 → «от десяти до двадцати» is case work; read as «десять — двадцать»
  s = s.replace(/(\d)\s?[–—-]\s?(\d)/g, "$1 — $2");
  // remaining plain numbers (feminine before тысяча/минута/…)
  s = s.replace(new RegExp(String.raw`(?<![\p{L}\d])(${NUM})(?![\p{L}\d])(\s+\p{L}+)?`, "gu"), (_m, n: string, next?: string) => {
    const f = next && FEMININE_NEXT.test(next.trim());
    return `${numberWithNoun(n, f ? { forms: ["", "", ""], g: "f" } : undefined).trim()}${next ?? ""}`;
  });
  // leftover symbols
  s = s.replace(/\+/g, " плюс ").replace(/&/g, " и ").replace(/=/g, " равно ").replace(/№\s?/g, "номер ");
  return tidy(s);
}

/** English: strip markup, spell the symbols; espeak-ng reads English numbers itself. */
export function normalizeEn(input: string): string {
  let s = stripMarkup(input);
  s = s.replace(/[×x](\d+(?:\.\d+)?)\b/g, "$1 times");
  s = s.replace(/\$\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|bn|b)?\b/gi, (_m, n: string, k?: string) => `${n}${k ? ` ${{ k: "thousand", m: "million", bn: "billion", b: "billion" }[k.toLowerCase()]}` : ""} dollars`);
  s = s.replace(/(\d)\s?%/g, "$1 percent");
  s = s.replace(/&/g, " and ").replace(/\+/g, " plus ");
  return tidy(s);
}

function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,!?;:])/g, "$1")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Text normalisation for a language (ru, en; others only lose markup and emojis). */
export function normalizeForTts(text: string, language = "ru"): string {
  const l = language.toLowerCase().slice(0, 2);
  if (l === "ru") return normalizeRu(text);
  if (l === "en") return normalizeEn(text);
  return tidy(stripMarkup(text));
}

/** Sentences for sentence-by-sentence synthesis; long ones are cut at commas/dashes near `maxChars`. */
export function splitSentences(text: string, maxChars = 220): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const parts = flat.match(/[^.!?…]+(?:[.!?…]+[»")]*|$)/g) ?? [flat];
  const out: string[] = [];
  for (let p of parts.map((x) => x.trim()).filter(Boolean)) {
    while (p.length > maxChars) {
      const window = p.slice(0, maxChars);
      const cut = Math.max(window.lastIndexOf(", "), window.lastIndexOf(" — "), window.lastIndexOf("; "));
      const at = cut > maxChars / 3 ? cut + 1 : window.lastIndexOf(" ") > 0 ? window.lastIndexOf(" ") : maxChars;
      out.push(p.slice(0, at).trim());
      p = p.slice(at).trim();
    }
    if (p) out.push(p);
  }
  // a dangling "word." fragment joins the previous sentence
  return out.filter((x) => /[\p{L}\p{N}]/u.test(x));
}
