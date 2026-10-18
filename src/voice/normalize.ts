/**
 * Text → what a TTS engine should read. Pure functions, no dependencies.
 * Russian: numbers to words with noun agreement and the case the preceding preposition asks for
 * («от 400 млн до 4,6 млрд» → «от четырёхсот миллионов до четырёх и шести десятых миллиарда»), years and
 * ordinals with suffixes («в 2026», «2024-го», «1990-х»), ranges («40–50%» → «от сорока до пятидесяти процентов»),
 * quarters («Q3»), dates, times, "$", "%", "×3", common abbreviations; emojis, hashtags and markdown are stripped
 * for every language. Brand names and Latin words are the job of pronounce.ts, which runs before this.
 */

const ONES_M = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["ноль", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];

export type Gender = "m" | "f";
/** grammatical case; "acc" of the (inanimate) numbers here is the nominative except «одна» → «одну» */
export type Case = "nom" | "gen" | "dat" | "prep" | "inst" | "acc";
type Oblique = "gen" | "dat" | "inst" | "prep";

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

const endsInOne = (n: number) => Math.abs(Math.trunc(n)) % 10 === 1 && Math.abs(Math.trunc(n)) % 100 !== 11;

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

interface Scale {
  value: number;
  forms: [string, string, string];
  g: Gender;
  /** oblique cases: [singular (after …1), plural] */
  cases: Record<Oblique, [string, string]>;
}
const masc = (stem: string, gpl = `${stem}ов`): Record<Oblique, [string, string]> => ({
  gen: [`${stem}а`, gpl],
  dat: [`${stem}у`, `${stem}ам`],
  inst: [`${stem}ом`, `${stem}ами`],
  prep: [`${stem}е`, `${stem}ах`],
});
const SCALES: Scale[] = [
  { value: 1e9, forms: ["миллиард", "миллиарда", "миллиардов"], g: "m", cases: masc("миллиард") },
  { value: 1e6, forms: ["миллион", "миллиона", "миллионов"], g: "m", cases: masc("миллион") },
  { value: 1e3, forms: ["тысяча", "тысячи", "тысяч"], g: "f", cases: { gen: ["тысячи", "тысяч"], dat: ["тысяче", "тысячам"], inst: ["тысячей", "тысячами"], prep: ["тысяче", "тысячах"] } },
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

// ---- cardinals in oblique cases ----
const IRREGULAR: Record<string, Record<Oblique, string>> = {
  ноль: { gen: "ноля", dat: "нолю", inst: "нолём", prep: "ноле" },
  один: { gen: "одного", dat: "одному", inst: "одним", prep: "одном" },
  одна: { gen: "одной", dat: "одной", inst: "одной", prep: "одной" },
  два: { gen: "двух", dat: "двум", inst: "двумя", prep: "двух" },
  две: { gen: "двух", dat: "двум", inst: "двумя", prep: "двух" },
  три: { gen: "трёх", dat: "трём", inst: "тремя", prep: "трёх" },
  четыре: { gen: "четырёх", dat: "четырём", inst: "четырьмя", prep: "четырёх" },
  восемь: { gen: "восьми", dat: "восьми", inst: "восемью", prep: "восьми" },
  сорок: { gen: "сорока", dat: "сорока", inst: "сорока", prep: "сорока" },
  девяносто: { gen: "девяноста", dat: "девяноста", inst: "девяноста", prep: "девяноста" },
  сто: { gen: "ста", dat: "ста", inst: "ста", prep: "ста" },
  двести: { gen: "двухсот", dat: "двумстам", inst: "двумястами", prep: "двухстах" },
  триста: { gen: "трёхсот", dat: "трёмстам", inst: "тремястами", prep: "трёхстах" },
  четыреста: { gen: "четырёхсот", dat: "четырёмстам", inst: "четырьмястами", prep: "четырёхстах" },
};

function declineCardinalWord(w: string, c: Oblique): string {
  const irr = IRREGULAR[w];
  if (irr) return irr[c];
  // пятьдесят … восемьдесят: both halves decline
  let m = /^(пять|шесть|семь|восемь)десят$/.exec(w);
  if (m) return c === "inst" ? `${declineCardinalWord(m[1], "inst")}десятью` : `${declineCardinalWord(m[1], "gen")}десяти`;
  // пятьсот … девятьсот
  m = /^(пять|шесть|семь|восемь|девять)сот$/.exec(w);
  if (m) {
    const u = declineCardinalWord(m[1], c === "inst" ? "inst" : "gen");
    return { gen: `${u}сот`, dat: `${u}стам`, inst: `${u}стами`, prep: `${u}стах` }[c];
  }
  // пять … двадцать, тридцать: -ь → -и / -ью
  if (/ь$/.test(w)) return c === "inst" ? `${w}ю` : w.replace(/ь$/, "и");
  return w;
}

/** Cardinal in any case: (3, "gen") → «трёх», (400 000 000, "gen") → «четырёхсот миллионов». */
export function cardinal(n: number, c: Case = "nom", g: Gender = "m"): string {
  n = Math.trunc(n);
  if (c === "nom") return numberToWords(n, g);
  if (c === "acc") return numberToWords(n, g).replace(/одна$/, "одну");
  if (n < 0) return `минус ${cardinal(-n, c, g)}`;
  if (n === 0) return declineCardinalWord("ноль", c);
  if (n >= 1e12) return String(n);
  const out: string[] = [];
  let rest = n;
  for (const s of SCALES) {
    const k = Math.floor(rest / s.value);
    if (k) {
      out.push(...triad(k, s.g).map((w) => declineCardinalWord(w, c)), s.cases[c][endsInOne(k) ? 0 : 1]);
      rest -= k * s.value;
    }
  }
  if (rest) out.push(...triad(rest, g).map((w) => declineCardinalWord(w, c)));
  return out.join(" ");
}

// ---- ordinals (years, dates, «2024-го») ----
const ORD_ONES = ["", "первый", "второй", "третий", "четвёртый", "пятый", "шестой", "седьмой", "восьмой", "девятый"];
const ORD_TEENS = ["десятый", "одиннадцатый", "двенадцатый", "тринадцатый", "четырнадцатый", "пятнадцатый", "шестнадцатый", "семнадцатый", "восемнадцатый", "девятнадцатый"];
const ORD_TENS = ["", "", "двадцатый", "тридцатый", "сороковой", "пятидесятый", "шестидесятый", "семидесятый", "восьмидесятый", "девяностый"];
const ORD_HUNDREDS = ["", "сотый", "двухсотый", "трёхсотый", "четырёхсотый", "пятисотый", "шестисотый", "семисотый", "восьмисотый", "девятисотый"];
const THOUSAND_PREFIX = ["", "", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми", "девяти"];

/** Form of an ordinal: masculine/neuter in a case, feminine nom/acc, neuter nom, plural nom/gen. */
export type OrdForm = Case | "f" | "f_acc" | "n" | "pl" | "pl_gen";

function declineOrdinal(word: string, c: OrdForm): string {
  if (c === "nom" || c === "acc") return word;
  const soft = word === "третий";
  const stem = soft ? "треть" : word.replace(/(ый|ой|ий)$/, "");
  const hard = /[кгх]$/.test(stem);
  const end: Record<Exclude<OrdForm, "nom" | "acc">, string> = soft
    ? { gen: "его", dat: "ему", prep: "ем", inst: "им", f: "я", f_acc: "ю", n: "е", pl: "и", pl_gen: "их" }
    : { gen: "ого", dat: "ому", prep: "ом", inst: hard ? "им" : "ым", f: "ая", f_acc: "ую", n: "ое", pl: hard ? "ие" : "ые", pl_gen: hard ? "их" : "ых" };
  return stem + end[c];
}

/** Ordinal (1 … 9999) in a form: 2026 → «две тысячи двадцать шестой / шестого / шестом». */
export function ordinalToWords(n: number, c: OrdForm = "nom"): string {
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
const DENOM: { sg: Record<Case, string>; pl: Record<Case, string> }[] = ["десят", "сот", "тысячн"].map((s) => ({
  sg: { nom: `${s}ая`, acc: `${s}ую`, gen: `${s}ой`, dat: `${s}ой`, inst: `${s}ой`, prep: `${s}ой` },
  pl: { nom: `${s}ых`, acc: `${s}ых`, gen: `${s}ых`, dat: `${s}ым`, inst: `${s}ыми`, prep: `${s}ых` },
}));

/** «2,5» → «две целых пять десятых» (formal reading). */
export function decimalToWords(intPart: string, frac: string): string {
  const i = Number(intPart);
  const f = frac.slice(0, 3);
  const fn = Number(f);
  const whole = `${numberToWords(i, "f")} ${plural(i, ["целая", "целых", "целых"])}`;
  return `${whole} ${numberToWords(fn, "f")} ${endsInOne(fn) ? DENOM[f.length - 1].sg.nom : DENOM[f.length - 1].pl.nom}`;
}

/** The fraction part read out: «семь десятых», «семи десятых», «одной десятой». */
function fractionWords(frac: string, c: Case): string {
  const f = frac.slice(0, 3);
  const fn = Number(f);
  const d = DENOM[f.length - 1];
  return `${cardinal(fn, c, "f")} ${endsInOne(fn) ? d.sg[c] : d.pl[c]}`;
}

// ---- nouns that agree with a number ----
export interface Noun {
  forms: [string, string, string];
  g: Gender;
  cases?: Record<Oblique, [string, string]>;
  /** accusative singular when it differs from the nominative (feminine: минуту) */
  acc?: string;
}
const fem = (stem: string, gpl: string): Record<Oblique, [string, string]> => ({
  gen: [`${stem}ы`, gpl],
  dat: [`${stem}е`, `${stem}ам`],
  inst: [`${stem}ой`, `${stem}ами`],
  prep: [`${stem}е`, `${stem}ах`],
});
const SCALE_NOUN = (s: Scale): Noun => ({ forms: s.forms, g: s.g, cases: s.cases, acc: s.g === "f" ? "тысячу" : undefined });
const INDECL = (w: string): Noun => ({ forms: [w, w, w], g: "m", cases: { gen: [w, w], dat: [w, w], inst: [w, w], prep: [w, w] } });
const NOUNS: Record<string, Noun> = {
  "%": { forms: ["процент", "процента", "процентов"], g: "m", cases: masc("процент") },
  "$": { forms: ["доллар", "доллара", "долларов"], g: "m", cases: masc("доллар") },
  "€": INDECL("евро"),
  "₽": { forms: ["рубль", "рубля", "рублей"], g: "m", cases: { gen: ["рубля", "рублей"], dat: ["рублю", "рублям"], inst: ["рублём", "рублями"], prep: ["рубле", "рублях"] } },
  "руб": { forms: ["рубль", "рубля", "рублей"], g: "m", cases: { gen: ["рубля", "рублей"], dat: ["рублю", "рублям"], inst: ["рублём", "рублями"], prep: ["рубле", "рублях"] } },
  "сум": { forms: ["сум", "сума", "сумов"], g: "m", cases: masc("сум") },
  "тыс": SCALE_NOUN(SCALES[2]),
  "млн": SCALE_NOUN(SCALES[1]),
  "млрд": SCALE_NOUN(SCALES[0]),
  "трлн": { forms: ["триллион", "триллиона", "триллионов"], g: "m", cases: masc("триллион") },
  "км": { forms: ["километр", "километра", "километров"], g: "m", cases: masc("километр") },
  "кг": { forms: ["килограмм", "килограмма", "килограммов"], g: "m", cases: masc("килограмм") },
  "мин": { forms: ["минута", "минуты", "минут"], g: "f", cases: fem("минут", "минут"), acc: "минуту" },
  "сек": { forms: ["секунда", "секунды", "секунд"], g: "f", cases: fem("секунд", "секунд"), acc: "секунду" },
  "ч": { forms: ["час", "часа", "часов"], g: "m", cases: masc("час") },
  "раз": { forms: ["раз", "раза", "раз"], g: "m", cases: masc("раз", "раз") },
  "лет": { forms: ["год", "года", "лет"], g: "m", cases: { gen: ["года", "лет"], dat: ["году", "годам"], inst: ["годом", "годами"], prep: ["годе", "годах"] } },
};

/** The noun after an integer in a case: (5, gen) → процентов, (21, dat) → проценту. */
function nounForm(noun: Noun, n: number, c: Case): string {
  if (c === "nom" || c === "acc" || !noun.cases) return c === "acc" && noun.acc && pluralIndex(n) === 0 ? noun.acc : plural(n, noun.forms);
  return noun.cases[c][endsInOne(n) ? 0 : 1];
}

export interface NumberStyle {
  /** «три и семь десятых» (default, how a narrator says it) or «три целых семь десятых» */
  decimals?: "colloquial" | "formal";
}

/** A number (as written: "12", "2,5", "1 000") with an agreeing noun, in a case. */
export function numberWithNoun(num: string, noun?: Noun, c: Case = "nom", style: NumberStyle = {}): string {
  const clean = num.replace(/[\s  ]/g, "");
  const m = /^(\d+)(?:[.,](\d+))?$/.exec(clean);
  if (!m) return num;
  const g = noun?.g ?? "m";
  const tail = (s: string) => (noun ? `${s} ${noun.forms[1]}` : s);
  if (m[2] && /^0+$/.test(m[2])) return numberWithNoun(m[1], noun, c, style);
  if (m[2] && /^50?$/.test(m[2])) {
    const i = Number(m[1]);
    // 1,5 → «полтора процента / полторы тысячи / до полутора миллиардов»
    if (i === 1) return noun ? (c === "nom" || c === "acc" ? `${g === "f" ? "полторы" : "полтора"} ${noun.forms[1]}` : `полутора ${noun.cases ? noun.cases[c as Oblique][1] : noun.forms[2]}`) : c === "nom" || c === "acc" ? "полтора" : "полутора";
    // 0,5 → «половина процента»
    if (i === 0) return tail({ nom: "половина", acc: "половину", gen: "половины", dat: "половине", inst: "половиной", prep: "половине" }[c]);
    // 3,5 → «три с половиной миллиарда» (the noun agrees with the whole part)
    return `${cardinal(i, c, g)} с половиной${noun ? ` ${nounForm(noun, i, c)}` : ""}`;
  }
  if (m[2]) {
    const words = style.decimals === "formal" && (c === "nom" || c === "acc") ? decimalToWords(m[1], m[2]) : `${cardinal(Number(m[1]), c, noun ? g : "f")} и ${fractionWords(m[2], c)}`; // «один и четыре десятых триллиона», «две и три десятых тысячи»
    return tail(words);
  }
  const n = Number(m[1]);
  return `${cardinal(n, c, g)}${noun ? ` ${nounForm(noun, n, c)}` : ""}`;
}

// ---- the case a number takes from the word before it ----
const GEN_PREPS = new Set(["от", "до", "из", "без", "для", "около", "более", "менее", "больше", "меньше", "свыше", "после", "против", "кроме", "среди", "вместо", "порядка", "у", "из-за", "со"]);
const DAT_PREPS = new Set(["к", "ко", "благодаря", "согласно", "навстречу"]);
const PREP_PREPS = new Set(["о", "об", "обо", "при"]);
const INST_PREPS = new Set(["между", "над", "под", "перед", "передо"]);
const ACC_PREPS = new Set(["в", "во", "на", "за", "через", "про", "сквозь"]);
/** adverbs between a preposition and its number: «до почти 4,6 млрд», «с примерно 400 млн» */
const SKIP_WORDS = new Set(["почти", "примерно", "приблизительно", "лишь", "всего", "только", "ещё", "еще", "уже", "целых", "аж", "каких-то", "где-то", "чуть", "ровно"]);

/** Case for a number starting at `at` in `s`, from the preposition right before it (adverbs skipped). */
export function caseBefore(s: string, at: number): Case {
  let rest = s.slice(Math.max(0, at - 80), at);
  for (let i = 0; i < 4; i++) {
    const m = /([\p{L}-]+)\s+$/u.exec(rest);
    if (!m) return "nom";
    const w = m[1].toLowerCase().replace(/ё/g, "е");
    if (SKIP_WORDS.has(w)) {
      rest = rest.slice(0, m.index);
      continue;
    }
    if (GEN_PREPS.has(w)) return "gen";
    if (DAT_PREPS.has(w)) return "dat";
    if (PREP_PREPS.has(w)) return "prep";
    if (INST_PREPS.has(w)) return "inst";
    if (ACC_PREPS.has(w)) return "acc";
    // «с 400 до 600» — from; «с 5 сотрудниками» — with (left as written)
    if (w === "с") return /^[^.!?;]{0,60}?(?<!\p{L})до\s/u.test(s.slice(at)) ? "gen" : "nom";
    return "nom";
  }
  return "nom";
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
const FEMININE_NEXT = /^(тысяч|минут|секунд|недел|чашк|страниц|книг|ошибк|причин|стран|компани|вещ|иде|привычк|минут|модел|верси|сделк|акци|котировк|позици)/i;
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
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

const NUM = String.raw`\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const SCALE = String.raw`(тыс|млн|млрд|трлн)(?!\p{L})\.?`;
const CUR = String.raw`[$€₽]|руб(?:л(?:ей|я|ь))?\.?|сум(?:ов|а)?(?!\p{L})|долл(?:аров|ара|ар)?\.?`;
const UNIT = String.raw`(?:км|кг|мин|сек|ч)(?!\p{L})\.?`;
const END = String.raw`(?=[\s.,!?;:)»"]|$)`;
const MONTHS = "января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря";
const curKey = (c: string) => {
  const k = c.replace(/\.$/, "").toLowerCase();
  return k.startsWith("руб") ? "руб" : k.startsWith("сум") ? "сум" : k.startsWith("долл") ? "$" : k;
};
const unitKey = (u: string) => (/^(км|кг|мин|сек|ч)/i.test(u) ? u.replace(/\.$/, "").toLowerCase() : u === "%" ? "%" : curKey(u));
const isYear = (n: string) => /^(1[89]\d\d|20\d\d)$/.test(n);
const ORD_SUFFIX: Record<string, OrdForm> = { й: "nom", ый: "nom", ой: "nom", ий: "nom", го: "gen", ого: "gen", его: "gen", му: "dat", ому: "dat", ему: "dat", м: "prep", ом: "prep", ем: "prep", ым: "inst", им: "inst", х: "pl_gen", ых: "pl_gen", их: "pl_gen", е: "pl", ые: "pl", я: "f", ая: "f", ю: "f_acc", ую: "f_acc" };
const ORD_CASE: Record<Case, OrdForm> = { nom: "nom", acc: "nom", gen: "gen", dat: "dat", prep: "prep", inst: "inst" };

/** Russian TTS normalisation. */
export function normalizeRu(input: string, style: NumberStyle = {}): string {
  let s = stripMarkup(input);
  for (const [re, to] of ABBREVIATIONS) s = s.replace(re, to);
  const withNoun = (n: string, noun: Noun | undefined, c: Case) => numberWithNoun(n, noun, c, style);

  // minus: «−45%», «-3» at a word start
  s = s.replace(/(^|[\s(])[−-](?=\d)/gu, "$1минус ");

  // ×3 / x3 / х3 → «в три раза»
  const RAZ = NOUNS["раз"];
  s = s.replace(/(^|[\s(])[×xх]\s?(\d+(?:[.,]\d+)?)(?=[\s.,!?;:)]|$)/giu, (_m, pre: string, n: string) => `${pre}в ${withNoun(n, RAZ, "acc")}`);
  s = s.replace(/(^|[\s(])(\d+(?:[.,]\d+)?)\s?[×xх](?=[\s.,!?;:)]|$)/giu, (_m, pre: string, n: string) => `${pre}в ${withNoun(n, RAZ, "acc")}`);

  // quarters: Q3 / Q3 2025 / в Q3 → «третий квартал» / «третий квартал две тысячи двадцать пятого года» / «в третьем квартале»
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(?:(в|во)\s+)?Q([1-4])(?:\s+(1[89]\d\d|20\d\d))?${END}`, "gu"), (_m, pre: string, v: string | undefined, q: string, y: string | undefined) => {
    const year = y ? ` ${ordinalToWords(Number(y), "gen")} года` : "";
    return v ? `${pre}${v} ${ordinalToWords(Number(q), "prep")} квартале${year}` : `${pre}${ordinalToWords(Number(q), "nom")} квартал${year}`;
  });

  // ordinals with a suffix: 2024-го, 2025-м, 1990-х, 90-е, 3-я
  s = s.replace(/(?<![\p{L}\d])(\d{1,4})-(ого|его|ому|ему|ый|ой|ий|ым|им|ых|их|ые|ая|ую|го|му|ом|ем|й|м|х|е|я|ю)(?!\p{L})(\s+году)?/gu, (_m, n: string, suf: string, god?: string) => {
    const form = ORD_SUFFIX[suf] ?? "nom";
    return `${ordinalToWords(Number(n), form)}${god ?? ""}`;
  });

  // years: «в 2026 (году)» → prepositional ordinal; «2026 год» / «2026 года» / «2026 г.»
  const YEAR = String.raw`(1[89]\d\d|20\d\d)`;
  const YEAR_WORD = String.raw`(?:\s*(?:году|г\.|г${END}))?`;
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(в|во)\s+${YEAR}${YEAR_WORD}${END}`, "giu"), (_m, pre: string, v: string, y: string) => `${pre}${v} ${ordinalToWords(Number(y), "prep")} году`);
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(к|ко)\s+${YEAR}${YEAR_WORD}${END}`, "giu"), (_m, pre: string, v: string, y: string) => `${pre}${v} ${ordinalToWords(Number(y), "dat")} году`);
  // «с 2024 до 2026», «до 2030 года» — but not «от 2000 рублей»
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])(с|до|от|после|около)\s+${YEAR}(\s*г\.|\s*г(?!\p{L}))?(?=[.,!?;:)»"]|$|\s+(?:и|по|до|года)(?!\p{L}))`, "giu"), (_m, pre: string, v: string, y: string, _g: string | undefined, at: number, all: string) => `${pre}${v} ${ordinalToWords(Number(y), "gen")}${/^\s+(года|до|по|и)(?!\p{L})/u.test(all.slice(at + _m.length)) ? "" : " года"}`);
  s = s.replace(new RegExp(String.raw`(^|[\s(«"])${YEAR}\s+(год|года|году|годом)${END}`, "giu"), (_m, pre: string, y: string, w: string) => {
    const c = ({ года: "gen", году: "prep", годом: "inst" } as Record<string, OrdForm>)[w.toLowerCase()] ?? "nom";
    return `${pre}${ordinalToWords(Number(y), c)} ${w}`;
  });

  // dates: «18 октября (2026)» → «восемнадцатого октября (две тысячи двадцать шестого года)»
  s = s.replace(new RegExp(String.raw`(?<![\p{L}\d])(\d{1,2})\s+(${MONTHS})(?:\s+${YEAR}(?:\s*(?:года|г\.|г${END}))?)?${END}`, "giu"), (m: string, d: string, month: string, y: string | undefined, at: number, all: string) => {
    const c = caseBefore(all, at);
    const day = ordinalToWords(Number(d), c === "dat" ? "dat" : c === "nom" && /^\s*$/.test(all.slice(0, at)) ? "n" : "gen");
    return `${day} ${month}${y ? ` ${ordinalToWords(Number(y), "gen")} года` : ""}`;
  });

  // times: 10:30 → «десять тридцать», 9:05 → «девять ноль пять»
  s = s.replace(/(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g, (_m, h: string, mm: string) => `${numberToWords(Number(h))} ${mm === "00" ? "ноль ноль" : mm.startsWith("0") ? `ноль ${numberToWords(Number(mm))}` : numberToWords(Number(mm))}`);

  // ranges: «40–50%» → «от сорока до пятидесяти процентов»; «в 2–3 раза» → «в два-три раза»; «2024–2025» → «с … по …»
  s = s.replace(new RegExp(String.raw`(?<![\p{L}\d.,])(${NUM})\s?[–—-]\s?(${NUM})(?![\d])(?:\s?(%|${SCALE}(?:\s?(${CUR}))?|${CUR}|${UNIT}))?`, "giu"), (m: string, a: string, b: string, unit: string | undefined, scale: string | undefined, cur: string | undefined, at: number, all: string) => {
    const c = caseBefore(all, at);
    const after = all.slice(at + m.length);
    if (isYear(a) && isYear(b) && !unit) {
      if (c === "acc" || c === "prep") return `${ordinalToWords(Number(a), "prep")} — ${ordinalToWords(Number(b), "prep")}`;
      return `${c === "gen" ? "" : "с "}${ordinalToWords(Number(a), "gen")} по ${ordinalToWords(Number(b), "nom")}`;
    }
    let noun: Noun | undefined;
    let curNoun: Noun | undefined;
    if (unit) {
      if (scale) {
        noun = NOUNS[scale.toLowerCase()];
        if (cur) curNoun = NOUNS[curKey(cur)];
      } else noun = NOUNS[unitKey(unit)];
    }
    const dot = unit ? keepDot(m, all, at) : "";
    const curWord = curNoun ? ` ${curNoun.forms[2]}` : "";
    // after в/на (or a written noun follows): «два-три раза», «два-три миллиарда»
    if (c === "acc" || (!unit && /^\s+\p{L}/u.test(after))) return `${withNoun(a, undefined, c === "acc" ? "acc" : "nom")}-${withNoun(b, noun, c === "acc" ? "acc" : "nom")}${curWord}${dot}`;
    if (c !== "nom") return `${withNoun(a, undefined, c)} — ${withNoun(b, noun, c)}${curWord}${dot}`;
    return `от ${withNoun(a, undefined, "gen")} до ${withNoun(b, noun, "gen")}${curWord}${dot}`;
  });

  // currency before the number: $5, $5 млн, € 3,5
  s = s.replace(new RegExp(String.raw`([$€₽])\s?(${NUM})(?:\s?${SCALE})?`, "giu"), (m: string, cur: string, n: string, scale: string | undefined, at: number, all: string) => {
    const c = caseBefore(all, at);
    if (scale) return `${withNoun(n, NOUNS[scale.toLowerCase()], c)} ${NOUNS[cur].forms[2]}${keepDot(m, all, at)}`;
    return withNoun(n, NOUNS[cur], c);
  });
  // number + scale (+ currency): 5 млн $, 2,5 млрд рублей
  s = s.replace(new RegExp(String.raw`(${NUM})\s?${SCALE}(?:\s?(${CUR}))?`, "giu"), (m: string, n: string, scale: string, cur: string | undefined, at: number, all: string) => {
    const words = withNoun(n, NOUNS[scale.toLowerCase()], caseBefore(all, at));
    return `${words}${cur ? ` ${NOUNS[curKey(cur)].forms[2]}` : ""}${keepDot(m, all, at)}`;
  });
  // number + unit: 30%, 5 $, 100 ₽, 10 руб., 15 мин, 3 км
  s = s.replace(new RegExp(String.raw`(${NUM})\s?(%|${CUR}|${UNIT})`, "giu"), (m: string, n: string, u: string, at: number, all: string) => `${withNoun(n, NOUNS[unitKey(u)], caseBefore(all, at))}${keepDot(m, all, at)}`);
  // remaining plain numbers (feminine before тысяча/минута/…), in the case of the preposition before them
  s = s.replace(new RegExp(String.raw`(?<![\p{L}\d])(${NUM})(?![\p{L}\d])(\s+\p{L}+)?`, "gu"), (_m, n: string, next: string | undefined, at: number, all: string) => {
    const f = next && FEMININE_NEXT.test(next.trim());
    // a noun follows: its gender rules («одна тысяча», «один и четыре десятых триллиона»); none: a bare decimal reads «одна и четыре десятых»
    return `${withNoun(n, f ? { forms: ["", "", ""], g: "f" } : next && /^\s*\p{L}/u.test(next) ? { forms: ["", "", ""], g: "m" } : undefined, caseBefore(all, at)).trim()}${next ?? ""}`;
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

export function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ([.,!?;:])/g, "$1")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Text normalisation for a language (ru, en; others only lose markup and emojis). */
export function normalizeForTts(text: string, language = "ru", style: NumberStyle = {}): string {
  const l = language.toLowerCase().slice(0, 2);
  if (l === "ru") return normalizeRu(text, style);
  if (l === "en") return normalizeEn(text);
  return tidy(stripMarkup(text));
}

/** Sentences for sentence-by-sentence synthesis; long ones are cut at commas/dashes near `maxChars`. */
export function splitSentences(text: string, maxChars = 220): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [];
  const parts: string[] = [];
  let start = 0;
  for (const m of flat.matchAll(/[.!?…]+[»")]*/g)) {
    const end = m.index + m[0].length;
    const next = flat.slice(end);
    // «3.5», «т.е.» — a dot inside a token is no sentence end, nor is a dot before a lowercase word
    if (next && !/^\s/.test(next)) continue;
    if (m[0] === "." && /^\s+[a-zа-яё]/u.test(next)) continue;
    parts.push(flat.slice(start, end));
    start = end;
  }
  if (start < flat.length) parts.push(flat.slice(start));
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
