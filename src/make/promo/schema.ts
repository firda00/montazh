import { z } from "zod";

/**
 * Stage 31 — the "promo" make format: a product promo / explainer in the clean Apple-style UI family
 * (reference #16: a 16:9 SaaS launch made with Claude; #17: its vertical sibling). The structure is fixed and comes
 * from the reference: hook (object + negation) → 2–4 pains on dark → reveal (logo tile + typed name) → "built for"
 * word rotation → one-line summary → 3–5 features (a text card, then the UI drawn in code with a camera move and a
 * cursor) → proof numbers → integrations → tagline → CTA.
 *
 * The writer (LLM) fills a flat, schema-friendly shape; `normalizePromo` turns any answer into a renderable script
 * (lengths clamped, every UI component given the data it needs, colours checked).
 */

export const UI_KINDS = ["table", "form", "kanban", "tiles", "metrics", "chart", "flow", "list", "chat", "invoice", "calendar", "search", "folders", "prompt"] as const;
export type UiKind = (typeof UI_KINDS)[number];

export const UiItemSchema = z.object({
  label: z.string().default(""),
  value: z.string().default(""),
  sub: z.string().default(""),
  icon: z.string().default(""),
});
export type UiItem = z.infer<typeof UiItemSchema>;

/**
 * One UI screen, flat on purpose (structured output handles it everywhere). Per kind:
 *  table    columns + rows (cells); `action` = the status a row changes to on click; rows[0] is the row that slides in
 *  form     items = fields (label, value typed in); action = the button; result = toast after the click
 *  kanban   columns = stages; rows = cards [title, value, stage]; result = title of the card dragged to the next stage
 *  tiles    items = counters (label, value "23", sub "/ 30 today", icon); counts up with progress bars
 *  metrics  items = KPI chips (label, value "$2,000" / "75%", sub); counts up
 *  chart    title + items = points (label = x, value = y); result = headline value
 *  flow     items = sources; title = what they are; action = hub label; result = target label; result_sub = toast
 *  list     items = rows (label, sub = meta, value = chip); action = row button ("Mark sent"); result = notification
 *  chat     items = messages (label "user" | "ai", value = text)
 *  invoice  title = sender; items = lines (label, value = amount); result = client; action = button
 *  calendar title = month; items = events (label, value = day number); action = the day clicked
 *  search   title = wordmark; action = the query typed; items = results (label, sub)
 *  folders  title = drive name; items = folders (label, value = size); result = the folder picked
 *  prompt   action = the prompt typed into an AI prompt bar; title = what comes out: "table" (columns + rows),
 *           "slides" (items = slides: label title, sub one line), "files" (items = files: label, value meta; result =
 *           the file found), "text" (result = the answer)
 */
export const UiSchema = z.object({
  kind: z.enum(UI_KINDS),
  title: z.string().default(""),
  columns: z.array(z.string()).default([]),
  rows: z.array(z.array(z.string())).default([]),
  items: z.array(UiItemSchema).default([]),
  action: z.string().default(""),
  result: z.string().default(""),
  result_sub: z.string().default(""),
});
export type Ui = z.infer<typeof UiSchema>;

/** Two-line kinetic card: `a` regular, `b` bold; words of `dim` (inside b) are set in grey. `say` = narration (--voice). */
export const LineSchema = z.object({
  a: z.string().default(""),
  b: z.string().default(""),
  dim: z.string().default(""),
  say: z.string().default(""),
});
export type Line = z.infer<typeof LineSchema>;

export const PROPS = ["sticky", "tabs", "swap", "strike", "none"] as const;
/**
 * Visual tropes the promo never draws (they read as cheap / AI-generated; owner feedback): a red strike-through or an X
 * over a logo, emoji, a generic neon glow, sparkle-emoji confetti, fake star ratings, stock "3D blob" shapes. "strike"
 * survives only as an alias of "swap" in old promo.json files — it renders the flip, never a slash.
 */
export const BANNED_VISUAL_TROPES = ["red strike-through or X over a logo", "emoji", "generic neon glow", "sparkle-emoji confetti", "fake star ratings", "stock 3D blobs"] as const;
export const PainSchema = LineSchema.extend({
  /**
   * a small prop next to the words: a sticky note, a few spreadsheet tabs, an old app's tile that flips over into the
   * product's own tile («Google Sheets? Now with Gemini.»; labels[0] = the app/brand name), nothing
   */
  prop: z.enum(PROPS).default("none"),
  labels: z.array(z.string()).default([]),
});
export const FeatureSchema = LineSchema.extend({
  theme: z.enum(["light", "dark"]).default("light"),
  prop: z.enum(PROPS).default("none"),
  labels: z.array(z.string()).default([]),
  ui: UiSchema,
});
export type Feature = z.infer<typeof FeatureSchema>;

const HEX = /^#[0-9a-f]{6}$/i;

export const PromoSchema = z.object({
  mode: z.enum(["product", "explainer"]).default("product"),
  title: z.string().min(1).max(80),
  language: z.string().default("en"),
  product: z.object({
    name: z.string().min(1).max(40),
    /** the letter(s) on the logo tile */
    mark: z.string().min(1).max(2),
    tagline: z.string().default(""),
    /** "A product by …" under the CTA logo */
    maker: z.string().default(""),
    accent: z.string().regex(HEX).default("#2563EB"),
    url: z.string().default(""),
    /** the logo tile: the mark letters, or a four-point gradient sparkle (AI products) */
    logo: z.enum(["mark", "sparkle"]).default("mark"),
    /** the product belongs to another company (a review / explainer of it): the description says it is not an ad */
    third_party: z.boolean().default(false),
  }),
  hook: z.object({
    /**
     * toss: the old tool's tile is thrown into a bin; object: a glossy 3D tile spins in next to the words;
     * stack: the old tools' tiles (items: brand names) fan in around a question
     */
    kind: z.enum(["toss", "object", "stack"]).default("toss"),
    items: z.array(z.string()).default([]),
    old_label: z.string().default("Sheets"),
    /** Lucide icon name */
    old_icon: z.string().default("sheet"),
    old_color: z.string().regex(HEX).default("#21A366"),
    a: z.string().min(1),
    b: z.string().default(""),
    say: z.string().default(""),
  }),
  pains: z.array(PainSchema).max(4),
  /** show: the logo + typed name card (off when the film reveals the product at the end) */
  reveal: z.object({ intro: z.string().default("Introducing"), show: z.boolean().default(true), say: z.string().default("") }),
  /** fewer than two items: no «Built for» rotation */
  audience: z.object({ lead: z.string().default("Built for"), items: z.array(z.string()).max(5), say: z.string().default("") }),
  summary: LineSchema.extend({ chips: z.array(z.string()).default([]) }),
  features: z.array(FeatureSchema).min(2).max(6),
  proof: LineSchema.extend({ ui: UiSchema }).nullable().default(null),
  /** tools it connects to / replaces (brand names): shown as a cloud of marks that collapses into the logo */
  integrations: z.array(z.string()).default([]),
  outro: z.object({ a: z.string().min(1), b: z.string().default(""), cta: z.string().default(""), say: z.string().default("") }),
  hashtags: z.array(z.string()).default([]),
  /** voice-over, one spoken line per scene group (written by writeNarration when a voice is asked for) */
  narration: z.array(z.string()).default([]),
});
export type Promo = z.infer<typeof PromoSchema>;

/**
 * What the writer returns, in two structured calls (Anthropic's strict grammar refuses the whole promo in one schema):
 * the story — every line, and per feature the UI kind plus a one-line brief — then the screens, one UI object per
 * feature in order and the proof's last. Kinds and enums are plain strings here; normalizePromo validates them.
 */
const S = z.string();
const UiOut = z.object({ kind: S, title: S, columns: z.array(S), rows: z.array(z.array(S)), items: z.array(z.object({ label: S, value: S, sub: S, icon: S })), action: S, result: S, result_sub: S });
export const PromoStoryOutSchema = z.object({
  mode: S,
  title: S,
  language: S,
  product: z.object({ name: S, mark: S, tagline: S, maker: S, accent: S, logo: S, third_party: z.boolean() }),
  hook: z.object({ kind: S, items: z.array(S), old_label: S, old_icon: S, old_color: S, a: S, b: S }),
  pains: z.array(z.object({ a: S, b: S, dim: S, prop: S, labels: z.array(S) })),
  reveal: z.object({ intro: S, show: z.boolean() }),
  audience: z.object({ lead: S, items: z.array(S) }),
  summary: z.object({ a: S, b: S, dim: S, chips: z.array(S) }),
  features: z.array(z.object({ a: S, b: S, dim: S, theme: S, prop: S, labels: z.array(S), ui_kind: S, ui_brief: S })),
  proof: z.object({ a: S, b: S, dim: S, ui_kind: S, ui_brief: S }),
  integrations: z.array(S),
  outro: z.object({ a: S, b: S, cta: S }),
  hashtags: z.array(S),
});
export type PromoStoryOut = z.infer<typeof PromoStoryOutSchema>;
export const PromoScreensOutSchema = z.object({ screens: z.array(UiOut) });

/** Story + screens → the raw promo normalizePromo reads (a screen of another kind than planned keeps the plan's kind when empty). */
export function mergeStory(story: PromoStoryOut, screens: z.infer<typeof PromoScreensOutSchema>["screens"]): Record<string, unknown> {
  const ui = (k: number, kind: string) => {
    const sc = screens[k];
    return sc ? { ...sc, kind: (UI_KINDS as readonly string[]).includes(sc.kind) ? sc.kind : kind } : { kind };
  };
  return {
    ...story,
    features: story.features.map((f, k) => ({ ...f, ui: ui(k, f.ui_kind) })),
    proof: story.proof && (story.proof.a || story.proof.b) ? { ...story.proof, ui: ui(story.features.length, story.proof.ui_kind) } : null,
  };
}

// ---- numbers that count up ----

export interface CountValue {
  prefix: string;
  value: number;
  decimals: number;
  suffix: string;
  /** thousands separator as written ("," "." " " or "") */
  group: string;
  /** decimal mark as written */
  point: string;
}

/**
 * "$2,000" → {prefix "$", 2000, suffix ""}; "75%"; "€1.2M"; "1 500 ₽"; "12,5 млрд" (ru decimal comma). Null when the
 * text has no number (it is shown as is, no count-up).
 */
export function parseCount(text: string): CountValue | null {
  const m = /^(\D*?)(\d[\d\s  ,.]*\d|\d)(.*)$/su.exec(text.trim());
  if (!m) return null;
  const [, prefix, raw, suffix] = m;
  // «2 и 20», «24/7», «1:1»: two numbers in one value are shown as written, not counted
  if (/\d/.test(suffix) || /\d/.test(prefix)) return null;
  let digits = raw.replace(/[  ]/g, " ");
  let group = "";
  let point = ".";
  let decimals = 0;
  // "2,000" / "1 500" / "1.000.000": groups of three only; "1,234.5": the last mark is the decimal one
  const grouped = /^\d{1,3}([,. ])\d{3}(\1\d{3})*$/.exec(digits);
  const mixed = /^(\d{1,3}(?:([,. ])\d{3})*)([.,])(\d+)$/.exec(digits);
  if (grouped) {
    group = grouped[1];
    digits = digits.split(group).join("");
  } else if (mixed && (!mixed[2] || mixed[2] !== mixed[3])) {
    group = mixed[2] ?? "";
    point = mixed[3];
    decimals = mixed[4].length;
    digits = `${group ? mixed[1].split(group).join("") : mixed[1]}.${mixed[4]}`;
  } else if (/[\s,.]/.test(digits)) return null;
  // a sign right before the digits belongs to the number («-20», «−5%», «$-3»), not to the prefix
  const neg = /[-−]\s*$/.test(prefix);
  const value = Number(digits) * (neg ? -1 : 1);
  if (!Number.isFinite(value)) return null;
  return { prefix: neg ? prefix.replace(/[-−]\s*$/, "") : prefix, value, decimals, suffix, group, point };
}

/** The display text of a count value at `v` (same grouping and decimal mark as the source). */
export function formatCount(c: CountValue, v: number): string {
  const fixed = Math.abs(v).toFixed(c.decimals);
  const [int, frac] = fixed.split(".");
  const g = c.group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, c.group) : int;
  return `${c.prefix}${v < 0 ? "-" : ""}${g}${frac ? c.point + frac : ""}${c.suffix}`;
}

// ---- normalisation ----

const clean = (s: unknown, max = 200) =>
  String(s ?? "")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const words = (s: string) => s.split(/\s+/).filter(Boolean);
/** a kinetic line keeps at most n words (the card is read in ~2 s) */
const clampWords = (s: string, n: number) => words(clean(s)).slice(0, n).join(" ");
const hex = (s: unknown, def: string) => (HEX.test(clean(s)) ? clean(s).toUpperCase() : def);
const item = (x: Partial<UiItem> | undefined): UiItem => ({ label: clean(x?.label, 60), value: clean(x?.value, 60), sub: clean(x?.sub, 60), icon: clean(x?.icon, 40).toLowerCase() });

/** Fills a UI screen so the component has what it animates (the writer may leave fields empty). */
export function normalizeUi(raw: Partial<Ui> & { kind: UiKind }, lang = "en"): Ui {
  const ru = lang === "ru";
  const u: Ui = {
    kind: raw.kind,
    title: clean(raw.title, 50),
    columns: (raw.columns ?? []).map((c) => clean(c, 28)).filter(Boolean).slice(0, 5),
    rows: (raw.rows ?? []).map((r) => (r ?? []).map((c) => clean(c, 40))).filter((r) => r.some(Boolean)).slice(0, 7),
    items: (raw.items ?? []).map(item).filter((x) => x.label || x.value).slice(0, 8),
    action: clean(raw.action, 40),
    result: clean(raw.result, raw.kind === "prompt" ? 160 : 70),
    result_sub: clean(raw.result_sub, 90),
  };
  const need = (n: number, make: (k: number) => UiItem) => {
    while (u.items.length < n) u.items.push(make(u.items.length));
  };
  switch (u.kind) {
    case "table": {
      if (u.columns.length < 3) u.columns = ru ? ["Имя", "Компания", "Статус", "Канал"] : ["Name", "Company", "Status", "Channel"];
      u.columns = u.columns.slice(0, 4);
      const nc = u.columns.length;
      if (u.rows.length < 3) u.rows = ru ? [["Анна К.", "Nord Studio", "Новый", "Email"], ["Илья П.", "Bright Lab", "Контакт", "Instagram"], ["Мария С.", "Oak Legal", "Ответил", "LinkedIn"], ["Олег Д.", "Ember Coffee", "Контакт", "Email"]] : [["Sahil S.", "Brightpath", "New", "Instagram"], ["Tidewater Legal", "Law firm", "Contacted", "Email"], ["Pinecrest", "Pediatrics", "Replied", "LinkedIn"], ["Ember Coffee", "Roasters", "Contacted", "Email"]];
      u.rows = u.rows.slice(0, 6).map((r) => Array.from({ length: nc }, (_, k) => r[k] ?? ""));
      if (!u.action) u.action = ru ? "Ответил" : "Replied";
      if (!u.title) u.title = ru ? "Лиды" : "Leads";
      break;
    }
    case "form":
      need(3, (k) => ({ label: (ru ? ["Компания", "Сайт", "Канал"] : ["Company", "Website", "Channel"])[k] ?? "Field", value: (ru ? ["Nord Studio", "nord.studio", "Instagram"] : ["Brightpath Coaching", "brightpath.co", "Instagram"])[k] ?? "", sub: "", icon: "" }));
      u.items = u.items.slice(0, 4);
      if (!u.action) u.action = ru ? "Сохранить" : "Save";
      if (!u.title) u.title = ru ? "Новая запись" : "New entry";
      break;
    case "kanban": {
      if (u.columns.length < 3) u.columns = ru ? ["Новые", "Квалиф.", "Созвон", "Сделка"] : ["New", "Qualified", "Call booked", "Proposal"];
      u.columns = u.columns.slice(0, 4);
      if (u.rows.length < 3) u.rows = u.columns.flatMap((c, k) => (k < 3 ? [[`${ru ? "Клиент" : "Client"} ${k + 1}`, `$${(k + 1) * 1800}`, c]] : []));
      u.rows = u.rows.slice(0, 7).map((r) => [r[0] || "—", r[1] ?? "", u.columns.includes(r[2] ?? "") ? r[2] : u.columns[0]]);
      if (!u.rows.some((r) => r[0] === u.result)) u.result = u.rows.find((r) => r[2] !== u.columns.at(-1))?.[0] ?? u.rows[0][0];
      break;
    }
    case "tiles":
      need(3, (k) => ({ label: ["Email", "Instagram", "LinkedIn"][k] ?? "Channel", value: String([23, 10, 12][k] ?? 8), sub: `/ ${[30, 15, 20][k] ?? 10} ${ru ? "сегодня" : "today"}`, icon: ["mail", "instagram", "linkedin"][k] ?? "circle" }));
      u.items = u.items.slice(0, 4);
      break;
    case "metrics":
      need(3, (k) => ({ label: (ru ? ["Доход в месяц", "Конверсия", "Средний чек"] : ["Monthly income", "Win rate", "Avg deal size"])[k] ?? "Metric", value: ["$2,000", "75%", "$7,700"][k] ?? "10", sub: "", icon: "" }));
      u.items = u.items.slice(0, 4);
      break;
    case "chart":
      u.items = u.items.filter((x) => parseCount(x.value));
      if (u.items.length < 4) u.items = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"].map((m, k) => ({ label: m, value: String([12, 18, 15, 26, 31, 44][k]), sub: "", icon: "" }));
      u.items = u.items.slice(0, 8);
      if (!u.result || !parseCount(u.result)) u.result = u.items.at(-1)!.value;
      break;
    case "flow":
      need(3, (k) => ({ label: ["Leads FINAL", "Deals v2", "Contacts"][k] ?? "Source", value: "", sub: "", icon: "file-spreadsheet" }));
      u.items = u.items.slice(0, 5);
      if (!u.action) u.action = "AI";
      if (!u.result) u.result = ru ? "Готово" : "Done";
      break;
    case "list":
      need(3, (k) => ({ label: (ru ? ["Oak Legal", "Pinecrest", "Fernhill Fitness"] : ["Tidewater Legal", "Pinecrest Pediatrics", "Fernhill Fitness"])[k] ?? "Item", value: "Email", sub: ru ? `Напоминание ${k + 1}` : `Follow-up ${k + 1}`, icon: "" }));
      u.items = u.items.slice(0, 5);
      if (!u.action) u.action = ru ? "Отправлено" : "Mark sent";
      if (!u.title) u.title = ru ? "На сегодня" : "Due today";
      break;
    case "chat":
      u.items = u.items.filter((x) => x.value).map((x) => ({ ...x, label: /^(ai|bot|assistant|ии|бот)$/i.test(x.label) ? "ai" : "user" }));
      if (u.items.length < 2) u.items = [{ label: "user", value: ru ? "Сколько я заработал в октябре?" : "How much did I make in October?", sub: "", icon: "" }, { label: "ai", value: ru ? "$7,700 — на 18% больше, чем в сентябре." : "$7,700 — up 18% from September.", sub: "", icon: "" }];
      u.items = u.items.slice(0, 4);
      break;
    case "invoice":
      u.items = u.items.filter((x) => x.label);
      if (!u.items.length) u.items = [{ label: ru ? "Ретейнер, октябрь" : "SEO retainer, October", value: "$800.00", sub: "1", icon: "" }];
      u.items = u.items.slice(0, 4);
      if (!u.title) u.title = "Northwind Studio";
      if (!u.result) u.result = "Oakline Legal";
      if (!u.action) u.action = ru ? "Сохранить счёт" : "Save invoice";
      break;
    case "calendar":
      u.items = u.items.filter((x) => /^\d{1,2}$/.test(x.value) && Number(x.value) >= 1 && Number(x.value) <= 30);
      if (u.items.length < 2) u.items = [{ label: ru ? "Созвон" : "Call", value: "8", sub: "", icon: "" }, { label: ru ? "Демо" : "Demo", value: "14", sub: "", icon: "" }, { label: ru ? "Счёт" : "Invoice", value: "21", sub: "", icon: "" }];
      u.items = u.items.slice(0, 5);
      if (!/^\d{1,2}$/.test(u.action)) u.action = String(Math.min(28, Number(u.items[0].value) + 2));
      if (!u.title) u.title = ru ? "Октябрь" : "October";
      break;
    case "search":
      if (!u.action) u.action = ru ? "как найти клиентов" : "how to find clients";
      need(3, (k) => ({ label: `${ru ? "Результат" : "Result"} ${k + 1}`, value: "", sub: "", icon: "" }));
      u.items = u.items.slice(0, 3);
      break;
    case "prompt": {
      const kinds = ["table", "slides", "files", "text"];
      if (!kinds.includes(u.title)) u.title = u.columns.length >= 2 && u.rows.length ? "table" : u.items.length >= 2 ? (u.items.some((x) => /\.(pdf|docx?|xlsx?|pptx?|png|jpe?g)$/i.test(x.label)) ? "files" : "slides") : "text";
      if (!u.action) u.action = ru ? "Сделай таблицу расходов за октябрь" : "Make a table of October expenses";
      if (u.title === "table") {
        if (u.columns.length < 2) u.columns = ru ? ["Дата", "Статья", "Сумма"] : ["Date", "Item", "Amount"];
        u.columns = u.columns.slice(0, 4);
        if (u.rows.length < 2) u.rows = [["01.10", ru ? "Аренда" : "Rent", "$1,200"], ["05.10", ru ? "Реклама" : "Ads", "$340"], ["12.10", ru ? "Софт" : "Software", "$89"]];
        u.rows = u.rows.slice(0, 6).map((r) => Array.from({ length: u.columns.length }, (_, k) => r[k] ?? ""));
      } else if (u.title === "slides") need(3, (k) => ({ label: `${ru ? "Слайд" : "Slide"} ${k + 1}`, value: "", sub: "", icon: "" }));
      else if (u.title === "files") {
        need(4, (k) => ({ label: ["report_q3.pdf", "budget_2026.xlsx", "contract_v2.docx", "photos_october"][k] ?? `file_${k}.pdf`, value: "", sub: "", icon: "" }));
        if (!u.items.some((x) => x.label === u.result)) u.result = u.items[0].label;
      } else if (!u.result) u.result = ru ? "Готово." : "Done.";
      u.items = u.items.slice(0, 5);
      break;
    }
    case "folders":
      need(5, (k) => ({ label: ["Whoosh", "Riser", "Impact", "Pop", "Click", "Gear"][k] ?? `Folder ${k + 1}`, value: ["124MB", "84MB", "54MB", "43MB", "27MB", "36MB"][k] ?? "10MB", sub: "", icon: "" }));
      u.items = u.items.slice(0, 6);
      if (!u.items.some((x) => x.label === u.result)) u.result = u.items[0].label;
      if (!u.title) u.title = "Drive";
      break;
  }
  return u;
}

/** "Russian" / "русский" / "ru-RU" → "ru" (writers sometimes name the language instead of its code). */
export function langCode(raw: string, fallback = "en"): string {
  const t = raw.trim().toLowerCase();
  if (!t) return fallback;
  if (/^(ru|rus|russian|рус)/.test(t)) return "ru";
  if (/^(uz|uzb|uzbek|ўзб|узб|o.zbek)/.test(t)) return "uz";
  if (/^(en|eng|english|англ)/.test(t)) return "en";
  if (/^(kk|kaz|kazakh|қаз|каз)/.test(t)) return "kk";
  if (/^(tr|tur|turkish)/.test(t)) return "tr";
  return /^[a-z]{2}$/.test(t) ? t : fallback;
}

/** Any writer answer (or a hand-written promo.json) → a renderable promo. */
export function normalizePromo(raw: unknown, o: { language?: string; name?: string; url?: string } = {}): Promo {
  const r = (raw ?? {}) as Record<string, any>;
  const lang = langCode(clean(r.language), o.language ?? "en");
  const ru = lang === "ru";
  const p = r.product ?? {};
  const name = clean(p.name, 40) || o.name || "Product";
  const mark = (clean(p.mark, 2) || name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1) || "•").toUpperCase();
  const line = (x: any, na = 6, nb = 6) => ({ a: clampWords(x?.a ?? "", na), b: clampWords(x?.b ?? "", nb), dim: clean(x?.dim, 40), say: clean(x?.say, 300) });
  const h = r.hook ?? {};
  // "strike" (a red slash over a logo) is a banned trope: it is drawn as the swap flip
  const propOf = (x: any) => (x?.prop === "strike" ? "swap" : (PROPS as readonly string[]).includes(x?.prop) ? x.prop : "none");
  const labelsOf = (x: any) => (x?.labels ?? []).map((l: unknown) => clean(l, 22)).filter(Boolean).slice(0, 3);
  const pains = (Array.isArray(r.pains) ? r.pains : []).map((x: any) => ({ ...line(x), prop: propOf(x), labels: labelsOf(x) })).filter((x: Line) => x.a || x.b).slice(0, 4);
  const features = (Array.isArray(r.features) ? r.features : [])
    .filter((f: any) => f?.ui && (UI_KINDS as readonly string[]).includes(f.ui.kind))
    .map((f: any) => ({ ...line(f), theme: f.theme === "dark" ? "dark" : "light", prop: propOf(f), labels: labelsOf(f), ui: normalizeUi(f.ui, lang) }))
    .filter((f: Line) => f.a || f.b)
    .slice(0, 6);
  const proofRaw = r.proof;
  const proof = proofRaw?.ui && (UI_KINDS as readonly string[]).includes(proofRaw.ui.kind) && (clean(proofRaw.a) || clean(proofRaw.b)) ? { ...line(proofRaw), ui: normalizeUi(proofRaw.ui, lang) } : null;
  const audience = (r.audience?.items ?? []).map((s: unknown) => clampWords(String(s ?? ""), 4)).filter(Boolean).slice(0, 5);
  const promo = {
    mode: r.mode === "explainer" ? "explainer" : "product",
    title: clean(r.title, 80) || name,
    language: lang,
    product: { name, mark, tagline: clean(p.tagline, 90), maker: clean(p.maker, 40), accent: hex(p.accent, "#2563EB"), url: o.url ?? clean(p.url, 200), logo: p.logo === "sparkle" ? "sparkle" : "mark", third_party: p.third_party === true },
    hook: { kind: h.kind === "object" || h.kind === "stack" ? h.kind : "toss", items: (h.items ?? []).map((x: unknown) => clean(x, 30)).filter(Boolean).slice(0, 6), old_label: clean(h.old_label, 18) || "Sheets", old_icon: clean(h.old_icon, 40).toLowerCase() || "sheet", old_color: hex(h.old_color, "#21A366"), a: clampWords(h.a, 4) || (ru ? "Хватит" : "Stop"), b: clampWords(h.b ?? "", 5), say: clean(h.say, 300) },
    // an explicit empty list means "no pains" / "no rotation"; a missing one gets the defaults
    pains: pains.length || Array.isArray(r.pains) ? pains : [{ a: ru ? "Таблицы" : "Spreadsheets", b: ru ? "всё забывают." : "forget follow-ups.", dim: "", say: "", prop: "none", labels: [] }],
    reveal: { intro: clampWords(r.reveal?.intro ?? "", 3) || (ru ? "Встречайте" : "Introducing"), show: r.reveal?.show !== false, say: clean(r.reveal?.say, 300) },
    audience: { lead: clampWords(r.audience?.lead ?? "", 4) || (ru ? "Для" : "Built for"), items: audience.length >= 2 ? audience : Array.isArray(r.audience?.items) ? [] : ru ? ["фрилансеров", "агентств", "всех, кто продаёт"] : ["freelancers", "agency owners", "anyone doing outreach"], say: clean(r.audience?.say, 300) },
    summary: { ...line(r.summary ?? {}, 8, 5), chips: (r.summary?.chips ?? []).map((c: unknown) => clean(c, 22)).filter(Boolean).slice(0, 4) },
    features: features.length >= 2 ? features : [...features, ...fallbackFeatures(lang)].slice(0, Math.max(2, features.length)),
    proof,
    integrations: (r.integrations ?? []).map((s: unknown) => clean(s, 30)).filter(Boolean).slice(0, 8),
    outro: { a: clampWords(r.outro?.a ?? "", 7) || name, b: clampWords(r.outro?.b ?? "", 6), cta: clean(r.outro?.cta, 32) || (ru ? `Попробовать ${name}` : `Start using ${name}`), say: clean(r.outro?.say, 300) },
    hashtags: (r.hashtags ?? []).map((t: unknown) => clean(t, 40).replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).slice(0, 6),
    narration: (Array.isArray(r.narration) ? r.narration : []).map((x: unknown) => clean(x, 290)).slice(0, 10),
  };
  // no summary given at all → the tagline; an explicitly empty one stays empty (no card)
  if (!promo.summary.a && !promo.summary.b && !r.summary) promo.summary = { a: promo.product.tagline || name, b: "", dim: "", say: "", chips: [] };
  // the dim words must be inside b, otherwise nothing is greyed
  for (const l of [promo.summary, ...promo.features, ...(promo.proof ? [promo.proof] : []), ...promo.pains]) if (l.dim && !l.b.toLowerCase().includes(l.dim.toLowerCase())) l.dim = "";
  return PromoSchema.parse(promo);
}

function fallbackFeatures(lang: string): Feature[] {
  const ru = lang === "ru";
  return [
    { a: ru ? "Всё в одном" : "Everything", b: ru ? "списке." : "in one list.", dim: "", say: "", theme: "light", prop: "none", labels: [], ui: normalizeUi({ kind: "table" }, lang) },
    { a: ru ? "Цифры" : "Numbers", b: ru ? "без таблиц." : "without spreadsheets.", dim: "", say: "", theme: "light", prop: "none", labels: [], ui: normalizeUi({ kind: "metrics" }, lang) },
  ];
}

/**
 * A complete promo without a model (tests, `--no-llm`, a writer that failed): the structure of the reference with
 * the product's own name and description in the lines.
 */
export function fallbackPromo(name: string, description = "", lang = "en"): Promo {
  const ru = lang === "ru";
  return normalizePromo(
    {
      mode: "product",
      title: name,
      language: lang,
      product: { name, mark: name.slice(0, 1), tagline: description.split(/[.!?]/)[0] ?? "", maker: "", accent: "#2563EB" },
      hook: { kind: "toss", old_label: ru ? "Таблицы" : "Sheets", old_icon: "sheet", old_color: "#21A366", a: ru ? "Хватит" : "Stop", b: ru ? "так работать." : "using this." },
      pains: ru
        ? [{ a: "Таблицы", b: "забывают напоминания.", prop: "sticky", labels: ["Позвонить!"] }, { a: "Клиенты теряются", b: "между вкладками.", prop: "tabs", labels: ["Лиды ФИНАЛ", "Лиды v2", "Лист 2"] }, { a: "Непонятно,", b: "сколько вы зарабатываете." }]
        : [{ a: "Spreadsheets forget", b: "follow-ups.", prop: "sticky", labels: ["Call back!"] }, { a: "Lose leads", b: "between tabs.", prop: "tabs", labels: ["Leads FINAL", "Leads v2", "Sheet 2"] }, { a: "Can't tell", b: "what you earn." }],
      reveal: { intro: ru ? "Встречайте" : "Introducing" },
      audience: { lead: ru ? "Для" : "Built for", items: ru ? ["фрилансеров", "агентств", "сервисного бизнеса", "всех, кто продаёт"] : ["freelancers", "agency owners", "service businesses", "anyone doing outreach"] },
      summary: { a: description.split(/[.!?]/)[0] || (ru ? "Лиды, рассылки, CRM и счета." : "Leads, outreach, CRM and invoices."), b: ru ? "Одно приложение." : "One app.", dim: ru ? "приложение." : "app.", chips: ru ? ["Новый лид", "Письмо отправлено"] : ["New Lead", "Email Sent"] },
      features: [
        { a: ru ? "Сохраняйте лиды" : "Save any lead", b: ru ? "в один клик." : "in one click.", dim: ru ? "клик." : "click.", theme: "light", ui: { kind: "form" } },
        { a: ru ? "Никаких дублей." : "No duplicates.", b: ru ? "Никогда." : "Ever.", theme: "dark", ui: { kind: "table" } },
        { a: ru ? "Не пропускайте" : "Never miss a", b: ru ? "ни одного ответа." : "follow-up.", theme: "dark", ui: { kind: "list" } },
        { a: ru ? "Ведите каждую" : "Track every", b: ru ? "сделку." : "deal.", theme: "light", ui: { kind: "kanban" } },
      ],
      proof: { a: ru ? "Выполняйте" : "Hit your", b: ru ? "план на день." : "daily targets.", dim: "", ui: { kind: "tiles" } },
      integrations: ["Gmail", "Instagram", "LinkedIn", "HubSpot", "Google Sheets"],
      outro: { a: ru ? "Хватит вести продажи" : "Stop running your outreach", b: ru ? "в таблице." : "from a spreadsheet.", cta: ru ? `Попробовать ${name}` : `Start using ${name}` },
    },
    { language: lang, name },
  );
}

/** «Not an ad · not affiliated with …» for a promo about another company's product (the video description). */
export function disclaimer(p: Promo): string {
  if (!p.product.third_party) return "";
  const who = p.product.maker || p.product.name;
  return p.language === "ru" ? `Не реклама · не аффилировано с ${who}` : p.language === "uz" ? `Reklama emas · ${who} bilan bog‘liq emas` : `Not an ad · not affiliated with ${who}`;
}

/** Plain text of every on-screen line (slop checks, the bot description). */
export function promoLines(p: Promo): string[] {
  const j = (l: { a: string; b: string }) => [l.a, l.b].filter(Boolean).join(" ");
  return [j(p.hook), ...p.pains.map(j), `${p.reveal.intro} ${p.product.name}.`, `${p.audience.lead} ${p.audience.items.join(" / ")}`, j(p.summary), ...p.features.map(j), ...(p.proof ? [j(p.proof)] : []), j(p.outro), p.outro.cta].filter(Boolean);
}
