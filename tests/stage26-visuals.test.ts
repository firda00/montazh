import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Stage 26, offline: entity-aware pictures and sub-shots. Entity and number extraction from the narration, the cheap
 * LLM pass merged with the dictionary, Wikimedia Commons parsing and the licence filter, Openverse's licence filter,
 * Simple Icons lookup (stubbed CDN), the relevance-check decision and batching (stubbed Gemini), the sub-shot schedule
 * on word timings, the plan per scene and the panes in the composition.
 */
process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s26-ws-"));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s26-"));
const { findMentions, findNumbers, entityFromLlm, scheduleShots, scriptInDollars, beatWords, KNOWN_ENTITIES, shotStats } = await import("../src/make/visuals.ts");
const { parseCommons, commonsLicense, commonsRejectReason, thumbUrl, commonsCreditLine } = await import("../src/make/commons.ts");
const { findIcon, iconPath, brandMark, brandCreditLine } = await import("../src/make/brandmarks.ts");
const { relevanceDecision, checkRelevance } = await import("../src/make/relevance.ts");
const { mergeEntities, validSeries, planShots, optionsForDirector } = await import("../src/make/visual-resolve.ts");
const { rejectReason } = await import("../src/make/photos.ts");
const { composeScenes } = await import("../src/make/scenes.ts");
const { normalizeDesign } = await import("../src/make/design.ts");
const { frameFor } = await import("../src/lib/aspect.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");

/** words of a sentence spread 0.3 s apart from t0 */
const W = (text: string, t0 = 0, step = 0.3) => text.split(/\s+/).map((w, k) => ({ text: w, start: Math.round((t0 + k * step) * 1000) / 1000, end: Math.round((t0 + k * step + step - 0.02) * 1000) / 1000 }));

test("entities: Latin and inflected Cyrillic names on word boundaries, Claude Code is not also Claude", () => {
  const m = findMentions(W("К концу года Anthropic собирается на Nasdaq, банки ждут полтора триллиона"));
  assert.deepEqual(m.map((x) => [x.entity, x.word]), [["anthropic", 3], ["nasdaq", 6]]);
  assert.ok(Math.abs(m[1].t - 1.8) < 1e-9, "the time the narrator says it");
  assert.deepEqual(findMentions(W("Деньги приносит Claude Code: компании платят")).map((x) => x.entity), ["claude-code"]);
  assert.deepEqual(findMentions(W("Акции на Насдаке и у Майкрософта, слова Альтмана")).map((x) => x.entity), ["nasdaq", "microsoft", "sam-altman"]);
  assert.deepEqual(findMentions(W("Оупен Эй-Ай и Антропик")).map((x) => x.entity), ["openai", "anthropic"]);
  assert.deepEqual(findMentions(W("маска для лица и метаданные")).map((x) => x.entity), [], "no false friends");
});

test("numbers: scale words, «полтора», currency, a bare number takes the scale before it, years and percents", () => {
  const n = findNumbers(W("Почти полтора триллиона долларов просит OpenAI"));
  assert.deepEqual(n.map((x) => [x.shown, x.unit, x.value]), [["$1,5", "трлн", 1.5e12]]);
  const m = findNumbers(W("В марте OpenAI привлекла 122 миллиарда при оценке в 852."), { dollars: true });
  assert.deepEqual(m.map((x) => `${x.shown} ${x.unit}`), ["$122 млрд", "$852 млрд"]);
  assert.equal(m[1].word, 9);
  const y = findNumbers(W("В 2025 году выручка выросла на 40% и составила 4,6 миллиарда"));
  assert.deepEqual(y.map((x) => `${x.shown}${x.unit}`), ["40%", "4,6млрд"], "the year is not a number to show");
  assert.equal(scriptInDollars({ title: "t", language: "ru", hashtags: [], beats: [{ text: "x", emphasis: "", icon: "a", seconds: 3, voiceover: "полтора триллиона долларов" }] }), true);
});

test("LLM entities: unknown names become matchers, dictionary names are not duplicated; chart series must be said", () => {
  const llm = [{ beat: 0, entities: [{ name: "Anthropic", kind: "company", forms: ["Антропик"], commons_query: "", subject: "" }, { name: "Thinking Machines Lab", kind: "company", forms: ["Thinking Machines"], commons_query: "Thinking Machines Lab office", subject: "" }], series: [], intent: "" }];
  const all = mergeEntities(llm);
  assert.equal(all.length, KNOWN_ENTITIES.length + 1);
  const tm = all.at(-1)!;
  assert.equal(tm.name, "Thinking Machines Lab");
  assert.deepEqual(findMentions(W("стартап Thinking Machines привлёк деньги"), all).map((x) => x.entity), [tm.id]);
  const custom = entityFromLlm({ name: "Мистраль", kind: "company", forms: ["Мистраля"], commons_query: "", subject: "" })!;
  assert.deepEqual(findMentions(W("акции Мистраля растут"), [custom]).map((x) => x.entity), [custom.id], "a Cyrillic stem takes endings");
  const nums = findNumbers(W("13 миллиардов за прошлый год, а сейчас темп почти 50 в год"), { dollars: true });
  assert.deepEqual(validSeries([{ label: "прошлый год", value: "13 миллиардов" }, { label: "сейчас", value: "50 в год" }], nums), [{ label: "прошлый год", value: "$13 млрд" }, { label: "сейчас", value: "$50 млрд" }]);
  assert.deepEqual(validSeries([{ label: "прошлый год", value: "13" }, { label: "сейчас", value: "70" }], nums), [], "70 was never said");
  const q = findNumbers(W("за год 4,6 миллиарда, а за третий квартал 16,8"));
  assert.deepEqual(validSeries([{ label: "прошлый год", value: "4,6" }, { label: "третий квартал", value: "16,8" }], q), [], "a year against a quarter is no chart");
});

const commonsFixture = {
  query: {
    pages: {
      "1": { pageid: 1, index: 2, title: "File:Nasdaq MarketSite (51494550508).jpg", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/c/cb/Nasdaq_MarketSite_%2851494550508%29.jpg?utm_source=commons.wikimedia.org", descriptionurl: "https://commons.wikimedia.org/wiki/File:Nasdaq_MarketSite_(51494550508).jpg", width: 3731, height: 3731, mime: "image/jpeg", extmetadata: { License: { value: "cc-by-2.0" }, LicenseShortName: { value: "CC BY 2.0" }, Artist: { value: '<a href="https://www.flickr.com/people/x">ajay_suresh</a>' } } }] },
      "2": { pageid: 2, index: 1, title: "File:Nasdaq Tower.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Nasdaq_Tower.jpg", width: 4000, height: 6000, mime: "image/jpeg", extmetadata: { License: { value: "cc-by-sa-4.0" }, LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "Someone" } } }] },
      "3": { pageid: 3, index: 3, title: "File:Nasdaq NC.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/x.jpg", width: 4000, height: 3000, mime: "image/jpeg", extmetadata: { License: { value: "cc-by-nc-2.0" }, LicenseShortName: { value: "CC BY-NC 2.0" } } }] },
      "4": { pageid: 4, index: 4, title: "File:Nasdaq GFDL.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/y.jpg", width: 4000, height: 3000, mime: "image/jpeg", extmetadata: { License: { value: "gfdl" }, LicenseShortName: { value: "GFDL" } } }] },
      "5": { pageid: 5, index: 5, title: "File:Nasdaq logo.svg", imageinfo: [{ url: "https://upload.wikimedia.org/z.svg", width: 512, height: 140, mime: "image/svg+xml", extmetadata: { License: { value: "pd" }, LicenseShortName: { value: "Public domain" } } }] },
      "6": { pageid: 6, index: 6, title: "File:Wall Street at night.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/w.jpg", width: 4000, height: 3000, mime: "image/jpeg", extmetadata: { License: { value: "cc0" }, LicenseShortName: { value: "CC0" } } }] },
      "7": { pageid: 7, index: 7, title: "File:Nasdaq sign small.jpg", imageinfo: [{ url: "https://upload.wikimedia.org/s.jpg", width: 480, height: 640, mime: "image/jpeg", extmetadata: { License: { value: "pd" }, LicenseShortName: { value: "Public domain" } } }] },
    },
  },
};

test("Commons: search answer parsed in rank order, licences CC0 / PD / CC BY / CC BY-SA only, photos that name the entity", () => {
  const files = parseCommons(commonsFixture);
  assert.deepEqual(files.map((f) => f.pageid), [2, 1, 5, 6, 7], "NC and GFDL-only are dropped, rank order kept");
  assert.deepEqual(files.map((f) => f.license), ["by-sa", "by", "pd", "cc0", "pd"]);
  assert.equal(files[1].artist, "ajay_suresh", "HTML stripped from the author");
  assert.equal(commonsLicense({ License: { value: "cc-by-nd-4.0" } }), null);
  assert.equal(commonsLicense({ LicenseShortName: { value: "Attribution" } }), null, "an unknown licence is not allowed");
  const f9 = frameFor("9:16");
  const why = Object.fromEntries(files.map((f) => [f.pageid, commonsRejectReason(f, f9, ["nasdaq"])]));
  assert.equal(why[1], null);
  assert.equal(why[2], null);
  assert.match(why[5]!, /type image\/svg/);
  assert.match(why[6]!, /does not name/);
  assert.match(why[7]!, /too small/);
  assert.equal(thumbUrl(files[1], f9), "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cb/Nasdaq_MarketSite_%2851494550508%29.jpg/1920px-Nasdaq_MarketSite_%2851494550508%29.jpg", "tracking query dropped, a standard width that covers 1920 px of height");
  assert.equal(thumbUrl(files[0], f9), "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Nasdaq_Tower.jpg/1280px-Nasdaq_Tower.jpg");
  assert.match(commonsCreditLine(files[0]), /^«Nasdaq Tower» — Someone \(CC BY-SA 4\.0, Wikimedia Commons\)/);
});

test("Openverse fallback keeps its own licence filter (CC0 / PDM / CC BY)", () => {
  const base = { id: "a", title: "coffee farm", creator: "", creator_url: "", license_version: "", license_url: "", url: "u", foreign_landing_url: "", provider: "", source: "", filetype: "jpg", filesize: null, width: 4000, height: 3000, mature: false, tags: [] };
  assert.equal(rejectReason({ ...base, license: "by" }, frameFor("9:16")), null);
  assert.match(rejectReason({ ...base, license: "by-nc" }, frameFor("9:16"))!, /licence/);
  assert.match(rejectReason({ ...base, license: "by-sa" }, frameFor("9:16"))!, /licence/);
});

test("Simple Icons: lookup by slug / title / alias, path data, a removed brand is null (wordmark instead)", async () => {
  const data = [
    { title: "Anthropic", slug: "anthropic", hex: "191919", source: "https://www.anthropic.com" },
    { title: "Claude", slug: "claude", hex: "D97757", source: "https://claude.ai" },
    { title: "GitHub Copilot", slug: "githubcopilot", hex: "000000", source: "x", license: { type: "MIT" }, aliases: { aka: ["Copilot"] } },
  ];
  assert.equal(findIcon(data, "Anthropic")?.slug, "anthropic");
  assert.equal(findIcon(data, "github copilot")?.slug, "githubcopilot");
  assert.equal(findIcon(data, "Copilot")?.slug, "githubcopilot");
  assert.equal(findIcon(data, "OpenAI"), null);
  assert.equal(iconPath('<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>Anthropic</title><path d="M17.3 3.5h-3.7L20.3 20.5h3.7z"/></svg>'), "M17.3 3.5h-3.7L20.3 20.5h3.7z");
  const calls: string[] = [];
  const fetchFn = (async (u: string) => {
    calls.push(String(u));
    if (String(u).endsWith("/data/simple-icons.json")) return new Response(JSON.stringify(data));
    if (String(u).endsWith("/icons/githubcopilot.svg")) return new Response('<svg viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></svg>');
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  const cacheDir = path.join(tmp, "si");
  const m = await brandMark("Copilot", { fetchFn, cacheDir });
  assert.deepEqual([m?.slug, m?.hex, m?.path, m?.license], ["githubcopilot", "#000000", "M1 1h22v22H1z", "MIT"]);
  assert.match(brandCreditLine(m!), /Simple Icons 16\.\d+\.\d+ \(MIT\); товарный знак принадлежит владельцу/);
  assert.equal(await brandMark("OpenAI", { fetchFn, cacheDir }), null);
  const before = calls.length;
  await brandMark("Copilot", { fetchFn, cacheDir });
  assert.equal(calls.length, before, "data and SVG come from the cache the second time");
});

test("relevance check: decision threshold, one batched call for several photos, cached verdicts, no key → unchecked", async () => {
  assert.equal(relevanceDecision({ shows: true, score: 8, checked: true }), true);
  assert.equal(relevanceDecision({ shows: true, score: 5, checked: true }), false, "below the threshold");
  assert.equal(relevanceDecision({ shows: false, score: 9, checked: true }), false);
  assert.equal(relevanceDecision({ shows: false, score: 0, checked: false }), true, "unchecked passes on the title/licence rules");
  assert.equal(relevanceDecision({ shows: false, score: 0, checked: false }, { acceptUnchecked: false }), false);
  const files: string[] = [];
  for (const [k, c] of ["red", "blue", "green"].entries()) {
    const f = path.join(tmp, `c${k}.jpg`);
    await ffmpeg(["-f", "lavfi", "-i", `color=c=${c}:size=640x480`, "-frames:v", "1", f]);
    files.push(f);
  }
  let calls = 0;
  let parts = 0;
  const client = {
    generate: async (_m: string[], body: { parts: unknown[] }) => {
      calls++;
      parts += body.parts.filter((p) => (p as { inlineData?: unknown }).inlineData).length;
      return { data: { results: [{ image: 1, shows: true, score: 9, sees: "Nasdaq tower", focus_x: 0.4, focus_y: 0.3 }, { image: 2, shows: false, score: 2, sees: "an office", focus_x: 0.5, focus_y: 0.5 }, { image: 3, shows: true, score: 6, sees: "Nasdaq sign", focus_x: 120, focus_y: 50 }] }, text: "", model: "gemini-3.5-flash-lite", usage: { promptTokenCount: 900, candidatesTokenCount: 120 }, requests: 1 };
    },
  } as unknown as import("../src/understand/gemini-client.ts").GeminiClient;
  const cands = files.map((file, k) => ({ id: `c${k}`, file, subject: "the Nasdaq exchange" }));
  const cacheDir = path.join(tmp, "rel");
  const r = await checkRelevance(cands, { client, cacheDir });
  assert.equal(calls, 1, "one request for three photos");
  assert.equal(parts, 3);
  assert.deepEqual([...r.verdicts.values()].map((v) => [v.id, relevanceDecision(v)]), [["c0", true], ["c1", false], ["c2", true]]);
  assert.deepEqual(r.verdicts.get("c0")!.focus, { x: 0.4, y: 0.3 });
  assert.deepEqual(r.verdicts.get("c2")!.focus, { x: 1, y: 0.5 }, "percent-style answers are normalised");
  assert.ok(r.usd > 0);
  const again = await checkRelevance(cands, { client, cacheDir });
  assert.equal(calls, 1, "cached by image hash + question");
  assert.ok([...again.verdicts.values()].every((v) => v.cached));
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  const none = await checkRelevance([{ id: "x", file: files[0], subject: "another subject" }], { cacheDir: null });
  assert.equal(none.verdicts.get("x")!.checked, false);
  if (saved) process.env.GEMINI_API_KEY = saved;
});

test("sub-shots: cuts when the next name or number is said, at least 1.5 s apart, long shots split on word starts", () => {
  const words = Array.from({ length: 20 }, (_, k) => 10 + k * 0.3);
  const s = scheduleShots({
    start: 10,
    end: 16,
    anchors: [
      { t: 10.3, key: "anthropic", options: ["b1.anthropic.l"] },
      { t: 11.2, key: "#0", options: ["b1.anthropic.ln0", "b1.n0"] },
      { t: 12.4, key: "openai", options: ["b1.openai.l"] },
    ],
    fill: [],
    variants: (o) => (o === "b1.openai.l" ? ["b1.openai.p0"] : []),
    wordStarts: words,
    musicBeats: [12.25],
  });
  assert.deepEqual(s.map((x) => x.option), ["b1.anthropic.l", "b1.openai.l", "b1.openai.p0"]);
  assert.equal(s[0].start, 10);
  assert.ok(Math.abs(s[1].start - 12.267) < 0.001, `on the word minus the lead, snapped to the music beat 12.25, on the frame grid: ${s[1].start}`);
  assert.equal(s.at(-1)!.end, 16);
  for (const x of s) assert.ok(x.end - x.start >= 1.35, `shot ${x.option} ${x.start}–${x.end} is not too short`);
  for (let k = 1; k < s.length; k++) assert.notEqual(s[k].option, s[k - 1].option);
  assert.ok(s.every((x) => x.end - x.start <= 2.5 + 0.25 + 1e-9) || s.length >= 3);
  // a late first name: a fill holds until it is said
  const late = scheduleShots({ start: 0, end: 5, anchors: [{ t: 3.6, key: "nasdaq", options: ["p"] }], fill: ["gen"], wordStarts: [] });
  assert.deepEqual(late.map((x) => [x.option, x.start]), [["gen", 0], ["p", 3.533]]);
  // nothing to show → no plan
  assert.deepEqual(scheduleShots({ start: 0, end: 4, anchors: [], fill: [] }), []);
  assert.deepEqual(shotStats([s]), { shots: 3, mean: 2, anchored: 2 });
});

test("plan per scene: options of the beat, the typographic layout at its own number, word times of the final timeline", () => {
  const script = { title: "t", language: "ru", hashtags: [], beats: [
    { text: "Anthropic на Nasdaq", emphasis: "", icon: "a", seconds: 7, voiceover: "К концу года Anthropic собирается на Nasdaq, банки ждут полтора триллиона." },
    { text: "Выручка: с 13 до 50", emphasis: "", icon: "a", seconds: 6, voiceover: "Причина в выручке: 13 миллиардов за прошлый год, а сейчас темп почти 50 в год." },
  ] };
  const speech = [{ start: 0.05, end: 6.6, words: W(script.beats[0].voiceover!, 0.05, 0.55) }, { start: 7.3, end: 12.6, words: W(script.beats[1].voiceover!, 7.3) }];
  const beats = [0, 1].map((i) => ({ beat: i, mentions: findMentions(beatWords(script, i, speech[i])), numbers: findNumbers(beatWords(script, i, speech[i]), { dollars: true }), options: [] as import("../src/make/visuals.ts").VisualOption[] }));
  beats[0].options = [
    { id: "b0.anthropic.l", beat: 0, kind: "logo", entity: "anthropic", label: "Anthropic brand mark", path: "M0 0h24v24H0z", hex: "#191919", name: "Anthropic" },
    { id: "b0.nasdaq.p0", beat: 0, kind: "photo", entity: "nasdaq", label: "real photo: Nasdaq MarketSite", file: path.join(tmp, "c0.jpg"), name: "Nasdaq" },
    { id: "b0.nasdaq.u", beat: 0, kind: "ui", entity: "nasdaq", label: "ticker", graphic: { kind: "ticker", title: "NASDAQ", items: [{ label: "Anthropic · IPO", value: "$1,5 трлн" }], note: "" }, name: "Nasdaq" },
    { id: "b0.anthropic.ln0", beat: 0, kind: "logo", entity: "anthropic", label: "mark + number", path: "M0 0h24v24H0z", hex: "#191919", name: "Anthropic", number: { value: "$1,5", unit: "трлн" }, numberIndex: 0 },
  ];
  beats[1].options = [
    { id: "b1.n0", beat: 1, kind: "number", label: "number card", number: { value: "$13", unit: "млрд" }, numberIndex: 0 },
    { id: "b1.chart", beat: 1, kind: "ui", label: "chart", graphic: { kind: "line", title: "Выручка", items: [{ label: "прошлый год", value: "$13 млрд" }, { label: "сейчас", value: "$50 млрд" }], note: "" }, numberIndex: 1 },
  ];
  const visuals = { beats, entities: [{ id: "anthropic", name: "Anthropic", kind: "company", beats: [0], photos: 0, mark: "logo" as const, ui: null }, { id: "nasdaq", name: "Nasdaq", kind: "exchange", beats: [0], photos: 1, mark: "wordmark" as const, ui: "ticker" }], credits: [], brandCredits: [], brandBySlug: {}, decisions: [], llm: null, checks: { candidates: 1, checked: 1, passed: 1, cached: 0, usd: 0, requests: 1, model: "m" }, series: {} };
  assert.match(optionsForDirector(visuals), /^0: b0\.anthropic\.l = Anthropic brand mark · b0\.nasdaq\.p0 = real photo/);
  const raw = { identity: { palette: { bg: "#0B0C10", bg2: "#16181F", text: "#F4F4F0", accent: "#FFD23F", accent2: "#3D7BFF", muted: "#8A8F9C" }, display_font: "inter", accent_font: "playfair-italic", kicker_font: "mono", texture: "grain", image_style: "doc", brand: "X", music: "tech", chrome: "none" }, scenes: [
    { beat: 0, layout: "media_full", headline: "К концу года — на Nasdaq", accents: [], kicker: null, sub: null, number: null, items: null, image: null, entrance: "rise", anchor: "bottom", transition: "cut", shots: ["b0.nasdaq.p0", "b0.anthropic.l", "b9.zzz"] },
    { beat: 1, layout: "hero_number", headline: "Темп выручки OpenAI", accents: [], kicker: null, sub: null, number: { value: "≈$50", unit: "млрд" }, items: null, image: null, entrance: "pop", anchor: "center", transition: "zoom", shots: [] },
  ] };
  const { design, notes } = normalizeDesign(raw, script as never, new Set(beats.flatMap((b) => b.options.map((o) => o.id))));
  assert.equal(design.scenes[0].layout, "media_full", "a media scene with shots needs no searched image");
  assert.deepEqual(design.scenes[0].shots, ["b0.nasdaq.p0", "b0.anthropic.l"], "ids of other beats are dropped");
  assert.ok(notes.some((n) => /неизвестные варианты/.test(n)));
  assert.equal(design.visuals, true);
  const timings = [{ start: 0, duration: 7 }, { start: 7, duration: 6 }];
  const { shots, planned } = planShots(script as never, design, visuals as never, { timings, speech, srcOf: (x) => `assets/img/${path.basename(x.file!)}` });
  assert.deepEqual(planned[0]!.map((s) => s.option), ["b0.anthropic.l", "b0.anthropic.l~detail", "b0.nasdaq.p0", "b0.anthropic.ln0"], "Anthropic (split into its mark and the alternative composition), the Nasdaq photo (not its UI) when said, then the number with the mark");
  assert.equal(shots[0]![2].option !== "layout" && shots[0]![2].src, "assets/img/c0.jpg");
  assert.equal(shots[0]![3].numberAt, speech[0].words[9].start, "the number punches in when «полтора» is said");
  const p1 = planned[1]!;
  assert.equal(p1.at(-1)!.option, "layout", "hero «≈$50» comes in at «50»");
  assert.ok(Math.abs(p1.at(-1)!.start - (speech[1].words[12].start - 0.08)) < 0.05, JSON.stringify(p1));
  assert.deepEqual(p1.slice(0, 2).map((s) => s.option), ["b1.n0", "b1.chart"]);

  // the composition: a pane stack under the headline, later panes hidden inline, varied transitions, spaced shot sounds
  const sc = composeScenes(script as never, design, { images: {}, fontFaces: "", gsapRel: "gsap.js", shots, speech });
  assert.match(sc.html, /<span class="ph full" id="sc0-ph"><div class="pane pk-logo" id="sc0-p0"/);
  assert.match(sc.html, /<div class="pane later pk-photo" id="sc0-p2" style="opacity:0;"><img class="img" id="sc0-p2-img" src="assets\/img\/c0\.jpg"/);
  assert.match(sc.html, /<div class="pane later pk-lay" id="sc1-p2" style="opacity:0;">/, "the hero number is one of the panes of its scene");
  assert.match(sc.html, /tl\.fromTo\("#sc0-p0", \{ opacity: 1 \}, \{ opacity: 0/, "a covered pane is switched off");
  assert.match(sc.html, /\.pane \{ position: absolute; inset: 0;/);
  assert.ok(!/<img[^>]+src="undefined"/.test(sc.html));
  // every tween target exists (a missing one made the renderer stall in the live run)
  const ids = new Set([...sc.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...sc.html.matchAll(/tl\.fromTo\("([^"]*)"/g)].flatMap((m) => m[1].split(",").map((x) => x.trim())).filter((sel) => !sel.startsWith("#") || !ids.has(sel.slice(1)));
  assert.deepEqual(missing, []);
  const shotCues = sc.cues.filter((c) => ["whoosh", "swipe", "tick"].includes(c.kind) && (c.gain ?? 0) <= -8).map((c) => c.t).sort((a, b) => a - b);
  for (let k = 1; k < shotCues.length; k++) assert.ok(shotCues[k] - shotCues[k - 1] >= 1.4, `shot sounds ≥ 1.5 s apart: ${shotCues.join(", ")}`);
});

test("word times: whisper's heard words re-time the written narration; too little heard keeps the estimates", async () => {
  const { refineWordTimes } = await import("../src/voice/align.ts");
  const written = W("Anthropic собирается на Nasdaq в конце года", 10, 0.4);
  const heard = [
    { w: "Антропик", start: 10.2, end: 10.7 },
    { w: "собирается", start: 10.75, end: 11.3 },
    { w: "на", start: 11.32, end: 11.4 },
    { w: "Насдак", start: 11.45, end: 11.9 },
    { w: "в", start: 12.0, end: 12.05 },
    { w: "конце", start: 12.1, end: 12.4 },
    { w: "года", start: 12.45, end: 12.8 },
  ];
  const r = refineWordTimes(written, heard, "ru")!;
  assert.ok(r, "aligned");
  assert.deepEqual(r.map((w) => w.start), [10.2, 10.75, 11.32, 11.45, 12, 12.1, 12.45]);
  assert.ok(r.every((w) => w.end > w.start));
  assert.equal(refineWordTimes(written, [{ w: "совсем", start: 1, end: 2 }, { w: "другое", start: 2, end: 3 }], "ru"), null);
});

test("product UI drawn in code: terminal, ticker board, funding card; every tween has its element", async () => {
  const { renderGraphic } = await import("../src/design/panel-graphics.ts");
  const ctx = { id: "p", w: 900, h: 700, start: 2, duration: 2.5, accent: "#FFD23F", bg: "#0B0C10", displayFamily: "Inter", serifFamily: "serif", monoFamily: "mono" };
  const kinds = [
    { kind: "terminal" as const, title: "claude", items: [{ label: "Read", value: "src/" }, { label: "Run tests", value: "passed" }], note: "add billing" },
    { kind: "ticker" as const, title: "NASDAQ", items: [{ label: "Anthropic · IPO", value: "$1,5 трлн" }, { label: "OPENAI", value: "$1,5 трлн" }], note: "" },
    { kind: "round" as const, title: "Раунд финансирования", items: [{ label: "OpenAI", value: "$122 млрд" }, { label: "оценка", value: "$852 млрд" }], note: "SoftBank, Thrive Capital" },
  ];
  for (const g of kinds) {
    const out = renderGraphic(g, ctx);
    const ids = new Set([...out.html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const targets = out.tweens.map((t) => /tl\.fromTo\("#([^"]+)"/.exec(t)?.[1]).filter(Boolean) as string[];
    assert.deepEqual(targets.filter((x) => !ids.has(x)), [], `${g.kind}: tweens without elements`);
    assert.ok(out.tweens.length >= 3, g.kind);
  }
  assert.match(renderGraphic(kinds[2], ctx).html, /<span class="gx-chip" id="p-g-ch1">Thrive Capital<\/span>/);
});
