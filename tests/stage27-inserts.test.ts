import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Stage 27, offline: expert caption looks (clean_min letter case, box_reveal karaoke reveal, serif digits), the plain
 * hook title with accent words and line timing, and the B-roll insert track — the schedule rules (start on the word,
 * durations per kind, density, head between full-frame inserts, concentration in the first 40 %), chips stacking,
 * PiP / chips placement off the face, SFX cues, Wikidata / URL parsing, the layer markup under the captions, and the
 * reference-style look match.
 */
process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s27-ws-"));
process.env.VEDIT_VISUAL_LLM = "off";
const { scheduleInserts, scheduleStats, insertDuration, chipGroups, pipBox, chipsBox, insertCues, thingEntity, hinted, faceUnion, DURATIONS, buildInserts } = await import("../src/design/inserts.ts");
const { parseWikidataSearch, wikidataCandidates, parseOfficialWebsite, pickBySitelinks, normalizeSiteUrl, domainOf, blockedPage, officialSite } = await import("../src/design/site-capture.ts");
const { captionCase, casedWord, buildLayout, heuristicFontMetrics, titleLineTimes } = await import("../src/design/layout.ts");
const { composeHyperframes, accentize } = await import("../src/design/hyperframes/compose.ts");
const { insertsLayer, insertFiles } = await import("../src/design/hyperframes/inserts-layer.ts");
const { matchCaptionLook } = await import("../src/style/map.ts");
const { entityFromLlm } = await import("../src/make/visuals.ts");
const { loadPreset } = await import("../src/plan/presets.ts");
const { PresetSchema, EdlSchema } = await import("../src/schemas/index.ts");
const { buildDesignTimeline } = await import("../src/design/timeline.ts");
const { MEDIA, makeTranscript } = await import("./helpers/plan-fixture.ts");
type InsertCandidate = import("../src/design/inserts.ts").InsertCandidate;
type DesignJob = import("../src/design/export.ts").DesignJob;

const cand = (key: string, kind: InsertCandidate["kind"], t: number, phraseEnd = t + 2, priority = 4, lastAt?: number): InsertCandidate => ({ key, kind, t, word: key, phraseEnd, priority, ...(lastAt !== undefined ? { lastAt } : {}) });

// ---------------------------------------------------------------- schedule

test("schedule: an insert starts 0.1 s before its word, never before the hook (1 s), durations per kind", () => {
  const s = scheduleInserts([cand("tesla", "cutaway", 2.3, 4.1), cand("musk", "pip", 9.0, 10.0), cand("payem", "site", 15.2, 16)], { duration: 60, density: "high" });
  const by = Object.fromEntries(s.map((x) => [x.key, x]));
  assert.equal(by.tesla.start, 2.2);
  assert.ok(by.tesla.end - by.tesla.start >= 3 - 1e-6 && by.tesla.end - by.tesla.start <= 4 + 1e-6, "cutaway 3–4 s");
  assert.ok(by.musk.end - by.musk.start >= 2 - 1e-6 && by.musk.end - by.musk.start <= 3 + 1e-6, "pip 2–3 s");
  assert.ok(by.payem.end - by.payem.start >= 4 - 1e-6 && by.payem.end - by.payem.start <= 6 + 1e-6, "site 4–6 s");
  const early = scheduleInserts([cand("x", "cutaway", 0.05, 2)], { duration: 30 });
  assert.equal(early[0].start, 1, "the voice opens the reel");
  assert.equal(insertDuration({ kind: "cutaway", phraseEnd: 20 }, 10), DURATIONS.cutaway.max);
  assert.equal(insertDuration({ kind: "pip", phraseEnd: 10.5 }, 10), DURATIONS.pip.min);
  assert.equal(insertDuration({ kind: "chips", phraseEnd: 0, lastAt: 18 }, 10), 11);
});

test("schedule: ≥ 1.5 s of head between full-frame inserts, no overlaps, a key is not repeated within 10 s", () => {
  const cands = [cand("a", "cutaway", 2, 3), cand("b", "cutaway", 5.5, 7), cand("c", "cutaway", 7.2, 8), cand("a", "cutaway", 9, 10), cand("d", "pip", 5.2, 6)];
  const s = scheduleInserts(cands, { duration: 60, density: "high" });
  for (let i = 1; i < s.length; i++) {
    assert.ok(s[i].start >= s[i - 1].end + 0.3 - 1e-6, "no overlap");
    const full = (k: string) => k === "cutaway" || k === "site";
    if (full(s[i].kind) && full(s[i - 1].kind)) assert.ok(s[i].start - s[i - 1].end >= 1.5 - 1e-6, `head between ${s[i - 1].key} and ${s[i].key}`);
  }
  assert.equal(s.filter((x) => x.key === "a").length, 1, "same key not within 10 s");
});

test("schedule: density budget (≤ 35 %), concentration in the first 40 %, sparser later", () => {
  const many: InsertCandidate[] = [];
  for (let t = 1.5; t < 58; t += 2.5) many.push(cand(`k${t}`, "cutaway", t, t + 3));
  for (const density of ["low", "normal", "high"] as const) {
    const s = scheduleInserts(many, { duration: 60, density });
    const st = scheduleStats(s, 60);
    assert.ok(st.coverage <= { low: 0.18, normal: 0.3, high: 0.35 }[density] + 1e-6, `${density}: ${st.coverage}`);
    assert.ok(st.first40 >= 0.5, `${density}: most insert time in the first 40 % (${st.first40})`);
    const late = s.filter((x) => x.start >= 24);
    for (let i = 1; i < late.length; i++) assert.ok(late[i].start - late[i - 1].end >= 4 - 1e-6, "≥ 4 s of head between later inserts");
  }
  const normal = scheduleStats(scheduleInserts(many, { duration: 60, density: "normal" }), 60);
  assert.ok(normal.coverage >= 0.25, `normal density fills 25–30 % (${normal.coverage})`);
});

test("schedule: a cluster of candidates said together → the higher priority one; chips count half", () => {
  const s = scheduleInserts([cand("musk~cut", "cutaway", 3, 5, 2.5), cand("musk", "pip", 3, 5, 5)], { duration: 40 });
  assert.equal(s.length, 1);
  assert.equal(s[0].kind, "pip");
  const c = scheduleInserts([cand("#0", "chips", 2, 3, 4, 10)], { duration: 40 });
  assert.equal(c[0].end, 13, "chips hold 3 s after the last chip");
  assert.ok(Math.abs(scheduleStats(c, 40).coverage - 11.1 / 2 / 40) < 0.002, "chips count half");
});

test("chips: numbers said close together stack (≤ 4), the last of a group is the inverted punchline", () => {
  const g = chipGroups([
    { t: 12.4, text: "2021 подняли $27M" },
    { t: 15.5, text: "2023 подняли $220M" },
    { t: 21.9, text: "Продали за $500к" },
    { t: 40, text: "6 млн выручки" },
  ]);
  assert.equal(g.length, 2);
  assert.deepEqual(g[0].map((c) => c.invert), [false, false, true]);
  assert.equal(g[1].length, 1);
  assert.equal(g[1][0].invert, false, "a lone chip is not a punchline");
  const cues = insertCues([{ kind: "chips", start: 12.3, chips: { items: g[0], scale: 1 } }, { kind: "cutaway", start: 2 }, { kind: "pip", start: 5 }, { kind: "site", start: 7 }]);
  assert.deepEqual(cues.map((c) => c.kind), ["whoosh", "pop", "swipe", "pop", "pop", "pop"]);
  assert.equal(cues.find((c) => c.t === 21.9)?.gain, -7, "the punchline pops louder");
});

test("schedule: after the hook title; a late insert is dropped, a name said during the hook may wait for it", () => {
  const s = scheduleInserts([cand("google", "site", 0.2, 2.4, 5), cand("late", "cutaway", 0.1, 3)], { duration: 30, minStart: 1.8 });
  assert.equal(s.length, 1);
  assert.equal(s[0].start, 1.8, "the hook first, then the name said during it");
  assert.equal(scheduleInserts([cand("x", "cutaway", 5, 8)], { duration: 30, minStart: 7.5 }).length, 0, "2.6 s after its word: too late even for a hook name");
  assert.equal(scheduleInserts([cand("y", "cutaway", 12, 15)], { duration: 30, minStart: 1, maxDelay: 1.2 })[0].start, 11.9);
});

// ---------------------------------------------------------------- placement

const overlaps = (b: { x: number; y: number; w: number; h: number }, f: number[]) => b.x < f[2] && b.x + b.w > f[0] && b.y < f[3] && b.y + b.h > f[1];

test("PiP: on the chest under the face, above the captions, never over the face; beside it or nothing", () => {
  const face = [0.32, 0.2, 0.68, 0.46];
  const b = pipBox(face as never, 0.78, 1.25, 1080, 1920)!;
  assert.ok(b && !overlaps(b, face), "below the chin");
  assert.ok(b.y >= 0.48 - 1e-6 && b.y + b.h <= 0.78 - 0.012 + 1e-6);
  assert.ok(Math.abs(b.x + b.w / 2 - 0.5) < 0.01, "centred under the face");
  assert.ok(b.w <= 0.3 + 1e-6);
  // a low face: no room on the chest → beside the face
  const low = [0.45, 0.35, 0.8, 0.7];
  const side = pipBox(low as never, 0.78, 1.2, 1080, 1920);
  assert.ok(side && !overlaps(side, low) && side.x + side.w <= 0.45, "left of the face");
  // a face filling the frame: nothing
  assert.equal(pipBox([0.1, 0.1, 0.9, 0.74] as never, 0.78, 1.25, 1080, 1920), null);
});

test("chips box: the largest free band off the face (above it, chest or beside), scaled to fit", () => {
  const face = [0.3, 0.42, 0.7, 0.68];
  const c = chipsBox(face as never, 0.78, 3)!;
  assert.ok(c && !overlaps(c.box, face), "off the face");
  assert.ok(c.box.y + c.box.h <= 0.42, "above a low face (reel #15)");
  assert.ok(c.scale > 0.55 && c.scale <= 1);
  assert.equal(chipsBox([0.05, 0.1, 0.95, 0.76] as never, 0.78, 4), null);
  const u = faceUnion({ source: "mediapipe", fps: 8, samples: [{ t: 1, boxes: [[0.3, 0.2, 0.6, 0.4]] }, { t: 1.5, boxes: [[0.35, 0.25, 0.65, 0.45]] }] }, 1, 2);
  assert.deepEqual(u, [0.3, 0.2, 0.65, 0.45]);
});

// ---------------------------------------------------------------- entities and hints

test("things: the trigger is the noun, not a preposition; planner hints match either way", () => {
  const t = thingEntity({ words: "на телефоне", query: "smartphone in hand", subject: "a smartphone" })!;
  assert.equal(t.name, "телефоне");
  assert.match(t.id, /^t-/);
  assert.equal(t.kind, "place", "no brand mark for a thing");
  assert.ok(t.match.test("работать прямо на телефонах"), "inflected forms");
  assert.equal(thingEntity({ words: "", query: "x", subject: "" }), null);
  assert.equal(thingEntity({ words: "пистолет", query: "pistol", subject: "a handgun" }), null, "no weapons");
  const page = entityFromLlm({ name: "Larry Page", kind: "person", forms: ["Ларри Пейдж"], commons_query: "Larry Page portrait", subject: "Larry Page" })!;
  assert.deepEqual(page.titleWords, ["page"], "a person's Commons file must name the surname");
  assert.equal(page.commons?.[0], "Larry Page", "the plain name finds the portraits");
  assert.ok(hinted(["Tesla"], "Теслу", "Tesla"));
  assert.ok(hinted(["летающий автомобиль"], "автомобиль"));
  assert.ok(!hinted(["SpaceX"], "Tesla"));
});

// ---------------------------------------------------------------- Wikidata / URLs

test("Wikidata: search hits, org-like exact label or alias, P856 by rank, the most notable of namesakes", () => {
  const hits = parseWikidataSearch({ search: [
    { id: "Q7444918", label: "Securities and Exchange Commission", description: "government agency of the Philippines" },
    { id: "Q953944", label: "U.S. Securities and Exchange Commission", description: "agency of the United States federal government", match: { text: "Securities and Exchange Commission" } },
    { id: "Q123", label: "Securities and Exchange Commission", description: "1934 film" },
  ] });
  assert.equal(hits[1].matched, "Securities and Exchange Commission");
  const cands = wikidataCandidates(hits, "Securities and Exchange Commission");
  assert.deepEqual(cands.map((h) => h.id), ["Q7444918", "Q953944"], "the film is not an organisation");
  const ents = {
    entities: {
      Q7444918: { sitelinks: { enwiki: {} }, claims: { P856: [{ rank: "normal", mainsnak: { datavalue: { value: "http://www.sec.gov.ph" } } }] } },
      Q953944: {
        sitelinks: { enwiki: {}, dewiki: {}, frwiki: {}, ruwiki: {} },
        claims: {
          P856: [
            { rank: "deprecated", mainsnak: { datavalue: { value: "http://old.sec.gov" } } },
            { rank: "normal", mainsnak: { datavalue: { value: "https://www.sec.gov/es" } }, qualifiers: { P407: [{ datavalue: { value: { id: "Q1321" } } }] } },
            { rank: "normal", mainsnak: { datavalue: { value: "https://www.sec.gov/" } }, qualifiers: { P407: [{ datavalue: { value: { id: "Q1860" } } }] } },
            { rank: "normal", mainsnak: { datavalue: { value: "https://ended.example.com" } }, qualifiers: { P582: [{ datavalue: { value: { id: "x" } } }] } },
          ],
        },
      },
    },
  };
  assert.equal(parseOfficialWebsite(ents, "Q953944"), "https://www.sec.gov", "English, live, not deprecated");
  assert.equal(parseOfficialWebsite(ents, "Q7444918"), "https://www.sec.gov.ph", "http → https");
  assert.deepEqual(pickBySitelinks(ents, ["Q7444918", "Q953944"]), { id: "Q953944", url: "https://www.sec.gov" });
  assert.equal(parseOfficialWebsite({ entities: { Q1: { claims: {} } } }, "Q1"), null);
});

test("URLs: normalised public https home pages only; domain; bot walls refused; dictionary first", async () => {
  assert.equal(normalizeSiteUrl("tesla.com"), "https://tesla.com");
  assert.equal(normalizeSiteUrl("http://www.payem.com/#top"), "https://www.payem.com");
  assert.equal(normalizeSiteUrl("ftp://x.com"), null);
  assert.equal(normalizeSiteUrl("http://localhost:3000"), null);
  assert.equal(normalizeSiteUrl("http://192.168.0.1"), null);
  assert.equal(domainOf("https://www.tesla.com/ru_ru?x=1"), "tesla.com");
  assert.ok(blockedPage("Just a moment...", "Checking your browser before accessing"));
  assert.ok(blockedPage("Tesla", ""));
  assert.equal(blockedPage("Electric Cars | Tesla", "Model 3 Order Now Learn More Schedule a Drive Today and more text here"), null);
  assert.deepEqual(await officialSite({ id: "tesla", name: "Tesla" }, { offline: true }), { url: "https://www.tesla.com", source: "dictionary" });
  assert.equal(await officialSite({ id: "x-payem", name: "PayEm" }, { offline: true }), null);
  let asked = "";
  const fetchFn = (async (url: string) => {
    asked += `${url}\n`;
    const u = new URL(url);
    if (u.searchParams.get("action") === "wbsearchentities") return new Response(JSON.stringify({ search: [{ id: "Q55", label: "PayEm", description: "Israeli fintech company" }] }));
    return new Response(JSON.stringify({ entities: { Q55: { sitelinks: {}, claims: { P856: [{ rank: "normal", mainsnak: { datavalue: { value: "https://www.payem.com" } } }] } } } }));
  }) as typeof fetch;
  assert.deepEqual(await officialSite({ id: "x-payem", name: "PayEm" }, { fetchFn, cacheDir: path.join(process.env.VEDIT_WORKSPACE!, "sites") }), { url: "https://www.payem.com", source: "wikidata", qid: "Q55" });
  assert.match(asked, /wbsearchentities[\s\S]*wbgetentities/);
});

// ---------------------------------------------------------------- captions and the hook

test("letter_case: lower / upper / as spoken (clean_min speaks in lower case)", async () => {
  const clean = (await loadPreset("clean_min")).preset;
  assert.equal(captionCase(clean.design), "lower");
  assert.equal(captionCase(PresetSchema.parse({ name: "x", pace: "calm", clip_seconds: { min: 1, max: 2 }, caption_style: "x" }).design), "upper", "legacy uppercase: true");
  assert.equal(captionCase({ captions: { uppercase: false } } as never), "as_spoken");
  assert.equal(casedWord("Tesla,", "ru", "lower"), "tesla");
  assert.equal(casedWord("Tesla,", "ru", "upper"), "TESLA");
  assert.equal(casedWord("«Tesla»", "ru", "as_spoken"), "Tesla");
  assert.equal(clean.music, "off", "expert: no music bed");
  assert.equal(clean.design.inserts.enabled, true);
  assert.equal(clean.design.captions.anchor_y, 0.82);
  assert.equal(clean.design.captions.font_size, 38);
  assert.equal(clean.design.font.weight, 500);
  assert.equal(clean.design.captions.stroke_width, 0);
  assert.equal((await loadPreset("bold_pop")).preset.design.inserts.enabled, false, "bold_pop: inserts only when asked");
});

const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }], titles: [{ at: 0, duration: 2.5, text: "Добро пожаловать каждое утро", style: "plain", accent_words: ["утро"] }], captions: { enabled: true, language: "ru" } }], reasoning: "" });
const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);
const designJob = (design: DesignJob["design"]): DesignJob => ({ job_id: "t", rough_path: "C:/x/rough_reel_1.mp4", timeline, pages: [], design, preset: "x", captions_language: "ru", translated: false, warnings: [] });
const ASSETS = { videoRel: "assets/rough_reel_1.mp4", fontRel: "assets/fonts/Inter-Variable.ttf", gsapRel: "assets/gsap.min.js" };

test("box_reveal: the whole line on a dark box, words dim until said, light up and stay lit, no scale; digits in a serif", async () => {
  const design = (await loadPreset("box_reveal")).preset.design;
  const job = designJob(design);
  const layout = buildLayout(job, heuristicFontMetrics("Inter"));
  assert.ok(layout.pages.every((p) => p.lines.every((l) => l.words.every((w) => w.popScale === 1))), "no pop budget in reveal");
  const html = composeHyperframes(job, layout, { ...ASSETS, serifNumFamily: "'VSerifNum', serif" });
  const words = layout.pages.flatMap((p) => p.lines.flatMap((l) => l.words));
  const reveals = html.match(/tl\.fromTo\("#cap-\d+-l\d+-w\d+", \{ color: "rgba\(255,255,255,0\.3\)" \}, \{ color: "#FFFFFF", duration: 0\.06/g) ?? [];
  assert.equal(reveals.length, words.length, "one light-up per word");
  assert.ok(!/scale: 1\.\d+, color/.test(html), "no pop");
  assert.ok(!/\{ scale: [\d.]+, color: "#FFFFFF" \}, \{ scale: 1, color/.test(html), "a lit word never goes back");
  assert.match(html, /\.cap \.w \{ color: rgba\(255,255,255,0\.3\)/);
  assert.match(html, /background: rgba\(0,0,0,0\.8\)/);
  const first = words[0];
  assert.match(html, new RegExp(`\\{ color: "#FFFFFF", duration: 0\\.06, ease: "none", immediateRender: false \\}, ${first.start}\\)`), "lights up on the word onset");
  assert.ok(!/class="w num"/.test(html) || /\.w\.num \{ font-family: 'VSerifNum', serif/.test(html));
  const withDigits = composeHyperframes(job, { ...layout, pages: [{ ...layout.pages[0], lines: [{ ...layout.pages[0].lines[0], words: [{ ...layout.pages[0].lines[0].words[0], text: "247" }] }] }] }, { ...ASSETS, serifNumFamily: "'VSerifNum', serif" });
  assert.match(withDigits, /class="w num"/);
  assert.match(withDigits, /\.w\.num \{ font-family: 'VSerifNum', serif/);
});

test("hook title: plain caps under the face, the accent word coloured, line 2 on its spoken word", async () => {
  const design = (await loadPreset("clean_min")).preset.design;
  const job = designJob(design);
  const layout = buildLayout(job, heuristicFontMetrics("Inter"));
  const t = layout.titlesOut[0];
  assert.equal(t.style, "plain");
  assert.equal(t.text, "ДОБРО ПОЖАЛОВАТЬ КАЖДОЕ УТРО");
  assert.deepEqual(t.accent, ["УТРО"]);
  assert.ok(t.anchorY! > 0.6, `under the face (${t.anchorY})`);
  assert.equal(t.lineAt?.[0], 0);
  const html = composeHyperframes(job, layout, ASSETS);
  assert.match(html, /<span class="acc">УТРО<\/span>/);
  assert.match(html, /\.acc \{ color: #E5C158; \}/);
  assert.match(html, /class="ttl-box plain"/);
  assert.equal(accentize("ЛЕТАЮЩАЯ TESLA", ["tesla"]), 'ЛЕТАЮЩАЯ <span class="acc">TESLA</span>');
  assert.equal(accentize("a < b", []), "a &lt; b");
  const words = [{ w: "Летающая", start: 0 }, { w: "Tesla", start: 0.5 }, { w: "от", start: 1.1 }, { w: "Илона", start: 1.3 }];
  assert.deepEqual(titleLineTimes(["ЛЕТАЮЩАЯ TESLA", "ОТ ИЛОНА МАСКА"], 0, 2.3, words, "ru"), [0, 1.1]);
  assert.deepEqual(titleLineTimes(["ЛЕТАЮЩАЯ TESLA", "НЕ СКАЗАНО"], 0, 2.3, words, "ru"), [0, 0.35], "fallback: 0.35 s after line 1");
});

// ---------------------------------------------------------------- the layer

test("insert layer: under the captions in the DOM, chips with an inverted punchline, the site scrolls, PiP cut-out", () => {
  const track = {
    items: [
      { id: "i0", kind: "site" as const, start: 1, end: 6, t: 1.1, word: "PayEm", label: "PayEm — сайт", image: "C:/c/site.jpg", box: { x: 0.1, y: 0.1, w: 0.8, h: 0.66 }, site: { domain: "payem.com", width: 780, height: 6752 } },
      { id: "i1", kind: "pip" as const, start: 8, end: 10.5, t: 8.1, word: "Маск", label: "", image: "C:/c/musk.png", cutout: true, aspect: 1.3, box: { x: 0.35, y: 0.5, w: 0.3, h: 0.22 } },
      { id: "i2", kind: "chips" as const, start: 12.3, end: 24.9, t: 12.4, word: "27", label: "", box: { x: 0.08, y: 0.09, w: 0.84, h: 0.3 }, chips: { logo: { name: "PayEm" }, items: [{ text: "2021 подняли $27M", at: 12.4, invert: false }, { text: "Продали за $500к", at: 21.9, invert: true }], scale: 1 } },
    ],
    cues: [],
    credits: [],
    stats: {} as never,
  };
  assert.deepEqual(insertFiles(track).sort(), ["C:/c/musk.png", "C:/c/site.jpg"]);
  const rel = { "C:/c/site.jpg": "assets/inserts/site.jpg", "C:/c/musk.png": "assets/inserts/musk.png" };
  const layer = insertsLayer(track, { W: 1080, H: 1920, duration: 30, rel, display: "'Inter', sans-serif", mono: "'VMono', monospace", captionTop: 0.79 });
  assert.equal(layer.sections.length, 3);
  assert.match(layer.sections[0], /class="ins-dom">payem\.com</);
  assert.match(layer.tweens.join("\n"), /tl\.fromTo\("#ins-i0-shot", \{ y: 0 \}, \{ y: -\d/);
  assert.match(layer.sections[1], /class="ins-pip-img cut"/);
  assert.match(layer.sections[2], /class="ins-chip inv"[^>]*>Продали за \$500к/);
  assert.ok(layer.tweens.some((t) => t.startsWith('tl.fromTo("#ins-i2-c1", { opacity: 0, scale: 0.7') && t.endsWith(", 21.86);")), "the punchline pops on its number");
  assert.ok(!layer.tweens.some((t) => /tl\.fromTo\("#ins-i\d+",/.test(t)), "never tween the clip itself");
  const html = composeHyperframes(designJob(PresetSchema.parse({ name: "x", pace: "calm", clip_seconds: { min: 1, max: 2 }, caption_style: "x" }).design), buildLayout(designJob(PresetSchema.parse({ name: "x", pace: "calm", clip_seconds: { min: 1, max: 2 }, caption_style: "x" }).design), heuristicFontMetrics()), { ...ASSETS, inserts: layer });
  assert.ok(html.indexOf('id="ins-i0"') < html.indexOf('id="cap-0"'), "inserts before the captions (captions on top)");
  assert.ok(html.indexOf('id="a-roll"') < html.indexOf('id="ins-i0"'));
  assert.ok(!/\.ins[^{]*\{[^}]*z-index/.test(layer.css), "no z-index lifting inserts over captions");
});

test("buildInserts offline: numbers become chips with the dictionary company's name, placed off the face", async () => {
  const design = (await loadPreset("box_reveal")).preset.design;
  const words = (text: string, t0: number) => text.split(" ").map((w, i) => ({ w, start: t0 + i * 0.35, end: t0 + i * 0.35 + 0.3, clip: 0, phrase: 0 }));
  const p = (text: string, t0: number, phrase: number) => ({ phrase, clip: 0, start: t0, end: t0 + text.split(" ").length * 0.35, lang: "ru", text, words: words(text, t0).map((w) => ({ ...w, phrase })) });
  const phrases = [p("Компания Tesla привлекла 27 миллионов долларов", 0, 0), p("а потом ещё 220 миллионов", 3, 1), p("и продалась за 500 тысяч", 6, 2), p("вот такая история", 9, 3)];
  const faces = { source: "mediapipe" as const, fps: 1, samples: Array.from({ length: 30 }, (_, t) => ({ t, boxes: [[0.32, 0.4, 0.68, 0.66]] as [number, number, number, number][] })) };
  const track = await buildInserts({ jobId: "t", phrases, duration: 30, language: "ru", design, faces, dir: path.join(process.env.VEDIT_WORKSPACE!, "ins"), W: 1080, H: 1920, fps: 30 }, { offline: true });
  const chips = track.items.find((i) => i.kind === "chips");
  assert.ok(chips, JSON.stringify(track.stats));
  assert.equal(chips!.chips!.logo?.name, "Tesla");
  assert.deepEqual(chips!.chips!.items.map((c) => c.invert), [false, false, true]);
  assert.equal(chips!.start, Math.round((chips!.chips!.items[0].at - 0.1) * 30) / 30 >= 1 ? chips!.start : 1);
  assert.ok(!overlaps(chips!.box!, [0.32, 0.4, 0.68, 0.66]), "chips off the face");
  assert.ok(track.cues.filter((c) => c.kind === "pop").length >= 3, "a pop per chip");
});

test("reference style: DNA in the expert looks maps to clean_min / box_reveal (+ inserts)", () => {
  const base = { enabled: true, layout_preset: "minimal_clean_box", max_words_per_screen: 4, max_chars_per_line: 26, font_weight: "400_regular", uppercase: false, position_y_percent: 82, primary_text_color: "#FFFFFF", active_word_color: "#FFFFFF", secondary_accent_color: "#E5C158", stroke_color: "#000000", stroke_width_px: 0, shadow_opacity: 0.4, background_box: "none", word_animation: "none", active_word_scale: 1 } as const;
  assert.equal(matchCaptionLook(base as never), "clean_min");
  assert.equal(matchCaptionLook({ ...base, background_box: "rounded_pill", word_animation: "color_switch_only", position_y_percent: 75 } as never), "box_reveal");
  assert.equal(matchCaptionLook({ ...base, uppercase: true } as never), null, "MrBeast caps are not expert captions");
  assert.equal(matchCaptionLook({ ...base, word_animation: "spring_scale", active_word_color: "#FFD600", active_word_scale: 1.15 } as never), null);
});
