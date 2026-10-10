import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLayout, displayWord, heuristicFontMetrics, isFunctionWord, loadFontMetrics, paginatePhrases, LAYOUT_VERSION } from "../src/design/layout.ts";
import type { FontMetrics, Layout } from "../src/design/layout-types.ts";
import type { DesignJob } from "../src/design/export.ts";
import type { OutPhrase, OutTitle } from "../src/design/timeline.ts";
import { DesignSpecSchema } from "../src/schemas/index.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FONT = path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf");
const near = (a: number, b: number, eps = 1e-6, msg?: string) => assert.ok(Math.abs(a - b) <= eps, msg ?? `${a} ≈ ${b}`);

const inter = loadFontMetrics(FONT, { family: "Inter", weight: 800 });

/** fixed-pitch test metrics: every char `em` wide, space `spaceEm` */
const mono = (em = 0.6, spaceEm = 0.25): FontMetrics => ({
  family: "Mono",
  file: "",
  source: "heuristic",
  measure: (t, s) => Array.from(t).length * em * s,
  spaceWidth: (s) => spaceEm * s,
});

/** phrase whose words are `step` s long, back to back from `start` */
function phrase(index: number, lang: string, text: string, start: number, step = 0.3, clip = 0): OutPhrase {
  const words = text.split(" ").map((w, i) => ({ w, start: Math.round((start + i * step) * 1000) / 1000, end: Math.round((start + (i + 1) * step) * 1000) / 1000, clip, phrase: index }));
  return { phrase: index, clip, start: words[0].start, end: words[words.length - 1].end, lang, text, words };
}

function makeJob(phrases: OutPhrase[], o: { duration?: number; titles?: OutTitle[]; captionsLanguage?: string | null; design?: Record<string, unknown>; enabled?: boolean } = {}): DesignJob {
  const duration = o.duration ?? Math.max(1, ...phrases.map((p) => p.end));
  return {
    job_id: "test",
    rough_path: "",
    timeline: { output_id: "reel_1", aspect: "9:16", width: 1080, height: 1920, fps: 30, duration, clips: [], phrases, titles: o.titles ?? [], captions: { enabled: o.enabled ?? true } },
    pages: [],
    design: DesignSpecSchema.parse(o.design ?? {}),
    preset: "bold_pop",
    captions_language: o.captionsLanguage ?? null,
    translated: false,
  };
}

const lineTexts = (l: Layout) => l.pages.map((p) => p.lines.map((line) => line.words.map((w) => w.text)));

test("metrics from the real Inter variable TTF: Cyrillic, Latin, Uzbek apostrophes, digits, punctuation", async () => {
  const m = await inter;
  assert.equal(m.source, "opentype");
  assert.equal(m.family, "Inter");
  const plov = m.measure("ПЛОВ", 72);
  assert.ok(plov > 0 && plov > m.measure("I", 72), `ПЛОВ ${plov}`);
  assert.ok(m.measure("oʻ", 72) > m.measure("o", 72), "ʻ (U+02BB) has an advance");
  for (const s of ["Oʻzbekiston", "gʻ", "o’", "o'", "0123456789", "?!,.—", "Ўзбек", "Hello"]) assert.ok(m.measure(s, 72) > 0, s);
  near(m.measure("ПЛОВ", 144), 2 * plov, 1e-6, "linear in size above the opsz range");
  const space = m.spaceWidth(72);
  assert.ok(space > 0 && space < m.measure("Н", 72));
  // the HVAR deltas are applied: ExtraBold measures wider than the default (Regular) instance
  const regular = await loadFontMetrics(FONT, { weight: 400 });
  assert.ok(m.measure("СПРАШИВАЮТ", 72) > regular.measure("СПРАШИВАЮТ", 72));
  // regression pin: equals headless Chrome's unkerned width of the same text (565.28 px)
  near(m.measure("СПРАШИВАЮТ,", 72), 565.28, 0.5);
});

test("a missing font file falls back to heuristic metrics", async () => {
  const h = await loadFontMetrics(path.join(ROOT, "assets", "fonts", "does-not-exist.ttf"), { family: "Inter" });
  assert.equal(h.source, "heuristic");
  assert.equal(h.family, "Inter");
  near(h.measure("ab", 100), 124);
  near(h.measure("AB", 100), 140);
  near(h.measure("a b", 100), 152);
  near(h.spaceWidth(100), 28);
  assert.equal(heuristicFontMetrics().source, "heuristic");
});

test("display text: trailing , . ; : stripped, ? and ! kept, quotes stripped, locale uppercase", () => {
  assert.equal(displayWord("спрашивают,", "ru", true), "СПРАШИВАЮТ");
  assert.equal(displayWord("секрет?", "ru", true), "СЕКРЕТ?");
  assert.equal(displayWord("Правда!", "ru", true), "ПРАВДА!");
  assert.equal(displayWord("«плов».", "ru", true), "ПЛОВ");
  assert.equal(displayWord('"yes",', "en", false), "yes");
  assert.equal(displayWord("'quoted'", "en", false), "quoted");
  assert.equal(displayWord("minut:", "uz", true), "MINUT");
  assert.equal(displayWord("togʻ", "uz", true), "TOGʻ", "Uzbek gʻ keeps its apostrophe");
  assert.equal(displayWord("o‘zbek", "uz", true), "O‘ZBEK");
  assert.equal(displayWord("...", "ru", true), "");
});

test("orphan rule: pages never end on a function word unless the phrase does", () => {
  const p = phrase(0, "ru", "Плов не любит спешки", 0);
  const greedyWouldEndOnNe = paginatePhrases([p], { maxWords: 2, maxChars: 22 });
  assert.deepEqual(greedyWouldEndOnNe.map((d) => d.words.map((w) => w.w)), [["Плов"], ["не", "любит"], ["спешки"]]);

  const q = phrase(1, "ru", "Многие спрашивают, в чем секрет.", 0);
  assert.deepEqual(paginatePhrases([q], { maxWords: 4, maxChars: 22 }).map((d) => d.words.map((w) => w.w)), [["Многие", "спрашивают,"], ["в", "чем", "секрет."]]);

  const uz = phrase(2, "uz", "Biz palov va somsa tayyorlaymiz", 0);
  const pages = paginatePhrases([uz], { maxWords: 2, maxChars: 22 });
  assert.deepEqual(pages.flatMap((d) => d.words.map((w) => w.w)), uz.words.map((w) => w.w), "no word lost");
  for (const d of pages.slice(0, -1)) assert.ok(!isFunctionWord(d.words[d.words.length - 1].w, "uz"), d.words.map((w) => w.w).join(" "));

  // the moved function word may push the next page over max_chars rather than dangle
  const long = phrase(3, "ru", "и достопримечательность", 0);
  assert.equal(paginatePhrases([long], { maxWords: 4, maxChars: 22 }).length, 1);

  assert.ok(isFunctionWord("НЕ", "ru"));
  assert.ok(!isFunctionWord("не,", "ru"), "punctuation closes the clause");
  assert.ok(isFunctionWord("Va", "uz"));
});

test("orphan rule on lines: 'ПЛОВ НЕ ЛЮБИТ СПЕШКИ' never breaks after НЕ", async () => {
  const job = makeJob([phrase(0, "ru", "Плов не любит спешки", 0)]);
  // with the rule off the most balanced break is right after НЕ …
  const off = buildLayout(job, mono(0.7), { functionWords: { ru: [] } });
  assert.deepEqual(lineTexts(off), [[["ПЛОВ", "НЕ"], ["ЛЮБИТ", "СПЕШКИ"]]]);
  // … with it, the break moves
  const on = buildLayout(job, mono(0.7));
  assert.deepEqual(lineTexts(on), [[["ПЛОВ", "НЕ", "ЛЮБИТ"], ["СПЕШКИ"]]]);
  for (const metrics of [mono(0.7), await inter]) {
    for (const page of buildLayout(job, metrics).pages) for (const line of page.lines) assert.notEqual(line.words[line.words.length - 1].text, "НЕ");
  }
});

test("caption words drop trailing commas but keep '?' in the layout", async () => {
  const job = makeJob([phrase(0, "ru", "Спрашивают, в чем секрет?", 0)]);
  const texts = buildLayout(job, await inter).pages.flatMap((p) => p.lines.flatMap((l) => l.words.map((w) => [w.text, w.raw])));
  assert.deepEqual(texts, [["СПРАШИВАЮТ", "Спрашивают,"], ["В", "в"], ["ЧЕМ", "чем"], ["СЕКРЕТ?", "секрет?"]]);
});

test("two-line breaks are balanced", () => {
  const job = makeJob([phrase(0, "en", "Wonderful Days Wonderful Days", 0)], { design: { captions: { max_chars: 40, word_animation: "none" } } });
  const [page] = buildLayout(job, mono(0.6)).pages;
  assert.equal(page.fontSize, 72);
  assert.deepEqual(page.lines.map((l) => l.words.length), [2, 2]);
  near(page.lines[0].width, page.lines[1].width);
  near(page.wordGap, 18, 0.01, "no pop → gap is the space");
});

test("font shrinks in 2 px steps for a long word, never below 0.6×base", async () => {
  const m = await inter;
  const L = buildLayout(makeJob([phrase(0, "ru", "Достопримечательность", 0)]), m);
  const [page] = L.pages;
  assert.ok(m.measure("ДОСТОПРИМЕЧАТЕЛЬНОСТЬ", 72) > L.captions.maxWidth, "precondition: too wide at base");
  assert.ok(page.fontSize < 72 && page.fontSize >= 0.6 * 72, `${page.fontSize}`);
  assert.equal((72 - page.fontSize) % 2, 0);
  assert.ok(page.width <= L.captions.maxWidth);
  assert.ok(m.measure("ДОСТОПРИМЕЧАТЕЛЬНОСТЬ", page.fontSize + 2) > L.captions.maxWidth, "the largest size that fits");

  const huge = buildLayout(makeJob([phrase(0, "ru", "Ааааааааааааааааааааааааааааааааааааааааа", 0)], { design: { captions: { max_chars: 60 } } }), m);
  near(huge.pages[0].fontSize, 43.2, 1e-9, "floor at 0.6×base even when it still overflows");
});

test("pop budget: long words get less than pop_scale, short words the full pop; gap covers the growth", async () => {
  const m = await inter;
  const L = buildLayout(makeJob([phrase(0, "ru", "Плов ферганский", 0)]), m);
  const words = L.pages.flatMap((p) => p.lines.flatMap((l) => l.words));
  const [plov, fergana] = words;
  assert.equal(plov.popScale, 1.12);
  assert.ok(fergana.popScale < 1.12, `${fergana.popScale}`);
  near(fergana.popScale, 1 + 36 / fergana.width, 1e-3);
  for (const page of L.pages) {
    const space = m.spaceWidth(page.fontSize);
    const growth = Math.max(...page.lines.flatMap((l) => l.words.map((w) => (w.width * (w.popScale - 1)) / 2)));
    assert.ok(page.wordGap >= space, "wordGap ≥ spaceWidth");
    assert.ok(page.wordGap >= space + growth - 0.01, "a popped word never reaches its neighbour");
    assert.ok(growth <= 18 + 1e-6, "≤ 18 px per side at 1080");
  }
  const calm = buildLayout(makeJob([phrase(0, "ru", "Плов ферганский", 0)], { design: { captions: { word_animation: "fill" } } }), m);
  assert.ok(calm.pages.every((p) => p.lines.every((l) => l.words.every((w) => w.popScale === 1))));
});

test("display windows: short pauses bridged, long pauses fade, last page, no overlap", () => {
  const phrases = [phrase(0, "ru", "Один два", 0, 0.5), phrase(1, "ru", "Три четыре", 1.3, 0.35), phrase(2, "ru", "Пять", 4.0, 0.5)];
  const L = buildLayout(makeJob(phrases, { duration: 4.7 }), mono());
  const w = L.pages.map((p) => [p.dispStart, p.dispEnd, p.exitFade]);
  assert.deepEqual(w, [
    [0, 1.3, false], // 0.3 s pause → held until the next page
    [1.3, 2.3, true], // 2 s pause → end + 0.3 s, then fade
    [4, 4.7, false], // 0.2 s left → held to the end of the video
  ]);
  near(L.frame.duration, 4.7);

  const longTail = buildLayout(makeJob(phrases, { duration: 8 }), mono());
  assert.deepEqual([longTail.pages[2].dispEnd, longTail.pages[2].exitFade], [4.8, true]);

  // exactly holdGap is still bridged; pages squeezed into one frame still last a frame and never overlap
  const edge = [phrase(0, "ru", "Раз", 0, 1), phrase(1, "ru", "Два", 1.6, 0.4), phrase(2, "ru", "Три", 2.0, 0.01), phrase(3, "ru", "Четыре", 2.01, 0.5)];
  const E = buildLayout(makeJob(edge, { duration: 3 }), mono());
  assert.equal(E.pages[0].dispEnd, 1.6);
  E.pages.forEach((p, i) => {
    assert.ok(p.dispEnd - p.dispStart >= 1 / 30 - 1e-6, `page ${i} lasts ≥ 1 frame`);
    if (i > 0) assert.ok(E.pages[i - 1].dispEnd <= p.dispStart + 1e-9, `page ${i - 1} overlaps page ${i}`);
    assert.ok(p.dispEnd <= E.frame.duration + 1e-9);
  });
});

test("titles: break after the em dash, never uppercased, clamped to the video", async () => {
  const m = await inter;
  const titles: OutTitle[] = [
    { at: 0.3, duration: 2.5, text: "Секрет плова — не торопиться", style: "hero" },
    { at: 4.0, duration: 2.5, text: "Лучший плов в городе Ташкент", style: "hero" },
  ];
  const L = buildLayout(makeJob([phrase(0, "ru", "Плов", 0)], { duration: 4.7, titles }), m);
  const [a, b] = L.titlesOut;
  assert.deepEqual(a.lines, ["Секрет плова —", "не торопиться"]);
  assert.equal(a.fontSize, 88);
  assert.equal(b.lines.length, 2);
  assert.ok(!/ в$/.test(b.lines[0]), "no line ends on a function word");
  near(b.duration, 0.7, 1e-6);
  for (const t of L.titlesOut) {
    assert.ok(t.width <= L.titles.maxWidth);
    assert.equal(t.lines.join(" "), t.text, "text as-is");
  }
});

test("captions disabled on the output → no caption pages", async () => {
  assert.equal(buildLayout(makeJob([phrase(0, "ru", "Плов", 0)], { enabled: false }), mono()).pages.length, 0);
});

test("Uzbek captions are uppercased with the captions language", () => {
  const L = buildLayout(makeJob([phrase(0, "uz", "oʻzbek togʻ", 0)], { captionsLanguage: "uz" }), mono());
  assert.deepEqual(lineTexts(L), [[["OʻZBEK", "TOGʻ"]]]);
  assert.equal(L.captions.language, "uz");
});

test("deterministic: same input → deep-equal layout", async () => {
  const job = JSON.parse(fs.readFileSync(path.join(ROOT, "workspace", "_proto", "reel_1.design.json"), "utf8")) as DesignJob;
  const a = buildLayout(job, await inter);
  const b = buildLayout(structuredClone(job), await loadFontMetrics(FONT, { family: "Inter", weight: 800 }));
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("real job reel_1: ≥ 15 pages, all within maxWidth, every word kept, no orphans", async () => {
  const job = JSON.parse(fs.readFileSync(path.join(ROOT, "workspace", "_proto", "reel_1.design.json"), "utf8")) as DesignJob;
  const L = buildLayout(job, await inter);
  assert.equal(L.version, LAYOUT_VERSION);
  assert.equal(L.font.source, "opentype");
  near(L.frame.duration, 19.9);
  assert.equal(L.captions.maxWidth, 864);
  assert.ok(L.pages.length >= 15, `${L.pages.length} pages`);

  const phraseEnds = new Set(job.timeline.phrases.map((p) => `${p.words[p.words.length - 1].start}|${p.words[p.words.length - 1].w}`));
  const words = L.pages.flatMap((p) => p.lines.flatMap((l) => l.words));
  assert.deepEqual(words.map((w) => w.raw), job.timeline.phrases.flatMap((p) => p.words.map((w) => w.w)), "every word, in order");
  for (const page of L.pages) {
    assert.ok(page.lines.length >= 1 && page.lines.length <= 2);
    assert.ok(page.fontSize <= L.captions.baseFontSize && page.fontSize >= 0.6 * L.captions.baseFontSize);
    assert.ok(page.width <= L.captions.maxWidth, `page ${page.index} ${page.width}px`);
    page.lines.forEach((line, li) => {
      assert.ok(line.width <= L.captions.maxWidth);
      const last = line.words[line.words.length - 1];
      const pageEnd = li === page.lines.length - 1;
      if (!(pageEnd && phraseEnds.has(`${last.start}|${last.raw}`))) assert.ok(!isFunctionWord(last.raw, "ru"), `page ${page.index} line ${li} ends on ${last.text}`);
      for (const w of line.words) {
        assert.ok(!/[,.;:]$/.test(w.text), w.text);
        assert.equal(w.text, w.text.toLocaleUpperCase("ru"));
        assert.ok(w.popScale > 1 && w.popScale <= 1.12);
      }
    });
  }
  L.pages.forEach((p, i) => {
    if (i > 0) assert.ok(L.pages[i - 1].dispEnd <= p.dispStart + 1e-9);
    assert.ok(p.dispEnd - p.dispStart >= 1 / 30 - 1e-6);
  });
  assert.equal(L.titlesOut.length, 1);
  assert.ok(L.titlesOut[0].lines[0].endsWith("—"));
});
