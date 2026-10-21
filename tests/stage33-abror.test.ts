import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  normalizeUz,
  uzApostropheIssues,
  upperUz,
  splitSections,
  sectionAt,
  fullSpeakerFrom,
  hookPlateLines,
  hookPlateTiming,
  hookPlateLayer,
  ctaLayer,
  articleLines,
  renderPane,
  paneBackground,
  OKINA,
  TUTUQ,
} from "../src/design/abror.ts";
import { PresetSchema } from "../src/schemas/index.ts";
import { loadPreset } from "../src/plan/presets.ts";
import { buildLayout, heuristicFontMetrics, hookPlateWindow } from "../src/design/layout.ts";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import type { DesignJob } from "../src/design/export.ts";
import { tidyTranscript } from "../src/understand/asrfix.ts";
import {
  numbersIn,
  verifyNumbers,
  validateAbrorScript,
  normalizeAbrorScript,
  writeAbrorScript,
  teleprompterText,
  shotListText,
  descriptionText,
  type AbrorSource,
} from "../src/make/abror/script.ts";
import { parseFeed, extractSignals, rankVentureNews, pickDemoTopics, isCentralAsia } from "../src/make/abror/venture.ts";
import { makeAbror, pickNewsItem, planSegments, wordTimes, layLines } from "../src/make/abror/index.ts";
import { composeFaceless } from "../src/make/abror/compose.ts";
import { resolveLinePanes } from "../src/make/abror/visuals.ts";
import { ffmpeg } from "../src/lib/ffmpeg.ts";

test("Uzbek Latin apostrophes: oʻ/gʻ use U+02BB, glottal stop uses U+02BC, quotes stay untouched", () => {
  const raw = `O'zbekiston bo'yicha g'oya va ma'no e'lon qilindi "MAN" 'test'`;
  const issues = uzApostropheIssues(raw);
  assert.equal(issues.length, 5);
  const norm = normalizeUz(raw);
  assert.equal(norm, `O${OKINA}zbekiston bo${OKINA}yicha g${OKINA}oya va ma${TUTUQ}no e${TUTUQ}lon qilindi "MAN" 'test'`);
  assert.equal(uzApostropheIssues(norm).length, 0);
  assert.equal(upperUz("o'zbekiston g'oya"), `O${OKINA}ZBEKISTON G${OKINA}OYA`);

  // tidyTranscript normalises Uzbek segments automatically
  const tidied = tidyTranscript({
    language: "uz",
    segments: [
      {
        start: 0,
        end: 2,
        text: "bo'ldi ma'no",
        lang: "uz",
        words: [
          { w: "bo'ldi", start: 0, end: 1 },
          { w: "ma'no", start: 1, end: 2 },
        ],
      },
    ],
  });
  assert.equal(tidied.segments[0].text, `Bo${OKINA}ldi ma${TUTUQ}no`);
});

test("presets abror_split and abror_full validate against PresetSchema", async () => {
  const split = PresetSchema.parse((await loadPreset("abror_split")).preset);
  const full = PresetSchema.parse((await loadPreset("abror_full")).preset);
  assert.equal(split.design.layout, "split");
  assert.equal(split.design.split.seam, 0.42);
  assert.equal(split.design.split.full_from, 0.75);
  assert.equal(split.design.split.hook, "plate");
  assert.equal(split.design.split.panel_frame, "edge");
  assert.equal(split.asr?.language, "uz");
  assert.equal(split.asr?.engine, "gemini");
  assert.equal(full.design.layout, "full");
  assert.equal(full.design.captions.word_animation, "reveal");
  assert.equal(full.design.hook_plate.enabled, true);
});

test("splitSections: format A switches to full_speaker on nearest phrase start and carves full_insert windows", () => {
  const secs = splitSections(60, 0.75, [0, 12.4, 28.0, 44.2, 52.0], [{ start: 15, end: 19 }]);
  assert.deepEqual(
    secs.map((s) => ({ ...s })),
    [
      { start: 0, end: 15, layout: "split" },
      { start: 15, end: 19, layout: "full_insert" },
      { start: 19, end: 44.2, layout: "split" },
      { start: 44.2, end: 60, layout: "full_speaker" },
    ],
  );
  assert.equal(sectionAt(secs, 5), "split");
  assert.equal(sectionAt(secs, 16), "full_insert");
  assert.equal(sectionAt(secs, 45), "full_speaker");
  assert.equal(fullSpeakerFrom(secs), 44.2);
});

test("hook plate + CTA layer + insert panes: valid HTML/GSAP, no CSS transform on tweened nodes", async () => {
  const split = PresetSchema.parse((await loadPreset("abror_split")).preset);
  const lines = hookPlateLines("21 MLN $ / IKKI HINDISTONLIK STARTAP", 6);
  assert.equal(lines.length, 2);
  assert.equal(lines[0], "21 MLN $");
  const timing = hookPlateTiming(4, 30, 0);
  assert.equal(timing.start, 0);
  assert.equal(timing.exitAt, 4);
  assert.ok(timing.end > 4.2);

  const plate = hookPlateLayer({
    W: 1080,
    H: 1920,
    spec: split.design.hook_plate,
    lines,
    anchorY: 0.4,
    start: 0,
    duration: 30,
    font: "'Montserrat', sans-serif",
  });
  assert.ok(plate.html.includes('id="hook-plate-box"'));
  assert.equal(plate.tweens.length, 2);

  const cta = ctaLayer({
    W: 1080,
    H: 1920,
    kind: "keyword",
    value: "MAN",
    label: "so'zini yozib qoldiring",
    start: 26,
    end: 30,
    anchorY: 0.6,
    font: "'Montserrat', sans-serif",
  });
  assert.ok(cta.html.includes("“MAN”"));
  assert.ok(cta.html.includes(`SO${OKINA}ZINI YOZIB QOLDIRING`));

  const art = articleLines("Startup Tenstorrent raised $1.5 billion in Series D led by Samsung and LG.", "raised $1.5 billion in Series D", 30);
  assert.ok(art.key.length >= 1);
  const pane = renderPane(
    { kind: "article", publisher: "TechCrunch", domain: "techcrunch.com", date: "19.10.2026", title: "Tenstorrent raises $1.5B", lines: art.lines, key: art.key },
    { id: "p0", start: 0, end: 4, box: { x: 0, y: 0, w: 1080, h: 806 }, content: { x: 75, y: 160, w: 930, h: 600 }, rel: (f) => f, font: "'Montserrat', sans-serif", k: 1 },
  );
  assert.equal(paneBackground({ kind: "article", publisher: "TC", domain: "tc.com", title: "T", lines: [], key: [] }), "light");
  assert.ok(pane.html.includes("ab-mark"));
  assert.ok(pane.tweens.some((t) => t.includes("#p0-mk0")));
});

test("abror script: numbers check, template validation, normalisation and one-shot rewrite", async () => {
  const sources: AbrorSource[] = [
    {
      title: "Tenstorrent raises $1.5 billion at $6.2 billion valuation",
      url: "https://techcrunch.com/2026/10/18/tenstorrent/",
      publisher: "TechCrunch",
      date: "2026-10-18",
      text: "AI chip startup Tenstorrent raised $1.5 billion in a round led by Samsung and Jeff Bezos, reaching a $6.2 billion valuation in 2026.",
    },
  ];
  const nums = numbersIn("Tenstorrent 1,5 milliard dollar koʻtardi va 6,2 milliard baholandi.");
  assert.equal(nums.length, 2);
  assert.equal(nums[0].value, 1.5e9);
  assert.equal(nums[1].value, 6.2e9);

  const goodRaw = {
    title: "Tenstorrent 1,5 milliard dollar",
    hook_title: ["$1,5 MLRD INVESTITSIYA", "AI CHIP STARTAPI"],
    lines: [
      { part: "hook", text: "Gap shundaki, Tenstorrent startapi 1,5 milliard dollar investitsiya ko'tardi.", visual: { kind: "number", subject: "Tenstorrent", value: "$1,5 MLRD", label: "investitsiya", url: "" }, source: 0 },
      { part: "intro", text: "Bu — Nvidia bilan raqobatlashadigan yangi avlod AI chiplarini yaratayotgan kompaniya, ya'ni oddiy chiplardan ancha tez ishlaydi.", visual: { kind: "logo", subject: "Tenstorrent", value: "", label: "AI chiplar", url: "" }, source: 0 },
      { part: "fact", text: "Tasavvur qilinglar, kompaniya qiymati 6,2 milliard dollarga yetdi va bu raqam butun bozorni hayratda qoldirdi.", visual: { kind: "article", subject: "TechCrunch", value: "$6,2 MLRD", label: "baholanish", url: "" }, source: 0 },
      { part: "fact", text: "Sarmoyadorlar orasida Samsung hamda Jeff Bezos bor, bu degani yirik gigantlar ham ularga ishonmoqda.", visual: { kind: "logo", subject: "Samsung", value: "", label: "investor", url: "" }, source: 0 },
      { part: "twist", text: "Eng qizig'i — startapni afsonaviy protsessor muhandisi boshqaradi va ular ochiq arxitekturaga tayanadi.", visual: { kind: "text", subject: "", value: "", label: "Ochiq arxitektura | AI chiplar", url: "" }, source: 0 },
      { part: "lesson", text: "Bundan qanday xulosa? O'zbekiston startap asoschilari va tadbirkorlar ham chuqur texnologiyadan qo'rqmasligi kerak, chunki katta sarmoya aynan shu yerda.", visual: { kind: "text", subject: "", value: "", label: "Chuqur texnologiya | Katta bozor", url: "" }, source: -1 },
      { part: "cta", text: "Agar sizga manbalar kerak bo'lsa, izohlarda \"MAN\" so'zini yozib qoldiringlar.", visual: { kind: "text", subject: "", value: "MAN", label: "izohda yozing", url: "" }, source: -1 },
    ],
    article: { source: 0, key_line: "Tenstorrent raised $1.5 billion" },
    caption: "Tenstorrent 1,5 milliard dollar ko'tardi 🤯 Aytgancha, \"MAN\" so'zini yozib qoldiring.",
    hashtags: ["#startap", "#venchur", "#uzbekistan"],
  };

  let calls = 0;
  const badFirst = {
    ...goodRaw,
    lines: goodRaw.lines.map((l, i) => (i === 0 ? { ...l, text: "Gap shundaki, Tenstorrent startapi 99 milliard dollar investitsiya ko'tardi." } : l)),
  };
  const res = await writeAbrorScript("Tenstorrent", sources, async () => {
    calls++;
    return {
      data: calls === 1 ? badFirst : goodRaw,
      usd: 0.01,
      model: "mock",
      provider: "gemini",
      estimate: false,
      usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 },
    };
  });
  assert.equal(calls, 2);
  assert.ok(res.firstIssues.some((x) => x.rule === "unverified_number"));
  assert.equal(res.issues.length, 0);
  assert.equal(res.unverified.length, 0);
  assert.equal(validateAbrorScript(normalizeAbrorScript(goodRaw, { topic: "Tenstorrent", sources, keyword: "MAN" })).length, 0);

  const tp = teleprompterText(res.script);
  assert.ok(tp.includes("BU YERDAN BOSH BUTUN KADRDA"));
  const shots = shotListText(res.script);
  assert.ok(shots.includes("ВЫ НА ВЕСЬ КАДР"));
  const desc = descriptionText(res.script, ["Musiqa: test"]);
  assert.ok(desc.includes("Manbalar:"));
});

test("venture RSS parser and ranking: funding signals, Central Asia bonus and topic picker", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Uzbek startup Uzum raises $50 million in Series B</title>
      <link>https://www.spot.uz/ru/2026/10/19/uzum/?utm_source=rss</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[<p>Tashkent-based startup raised $50 million led by Sequoia.</p>]]></description>
    </item>
    <item>
      <title>AI agent startup Runable raises $21 million seed round</title>
      <link>https://techcrunch.com/2026/10/19/runable/</link>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <description><![CDATA[<p>AI startup Runable secured $21 million in seed funding.</p>]]></description>
    </item>
  </channel></rss>`;
  const parsed = parseFeed(xml);
  assert.equal(parsed.length, 2);
  const sig = extractSignals(parsed[0]);
  assert.equal(sig.type, "funding");
  assert.equal(sig.amountUsdM, 50);

  const ranked = rankVentureNews(
    parsed.map((p, i) => ({
      sourceId: i === 0 ? "spot-uz" : "techcrunch-venture",
      source: i === 0 ? "Spot.uz" : "TechCrunch Venture",
      weight: 3,
      lang: i === 0 ? "ru" : "en",
      region: i === 0 ? "uz" : "global",
      strict: false,
      title: p.title,
      url: p.link,
      published: p.published,
      summary: p.summary,
    })),
  );
  assert.equal(ranked.length, 2);
  assert.ok(isCentralAsia(ranked.find((r) => r.title.includes("Uzum"))!));
  const demo = pickDemoTopics(ranked);
  assert.ok(demo.centralAsia?.title.includes("Uzum"));
  assert.ok(pickNewsItem("Central Asia", ranked)?.title.includes("Uzum"));
});

test("abror_split montage composition + faceless demo end-to-end (fake render, no network)", async () => {
  const splitPreset = PresetSchema.parse((await loadPreset("abror_split")).preset);
  const secs = splitSections(20, 0.75, [0, 5, 10, 15]);
  const job: DesignJob = {
    job_id: "test-abror",
    rough_path: "rough_reel_1.mp4",
    preset: "abror_split",
    captions_language: "uz",
    translated: false,
    warnings: [],
    design: { ...splitPreset.design, outro: { ...splitPreset.design.outro, keyword: "MAN" } },
    sections: secs,
    panels: {
      hook_title: [
        { text: "$21 MLN", style: "display" },
        { text: "AI STARTAP", style: "accent" },
      ],
      panels: [
        { start: 0, end: 10, source: "graphic", photo_query: "", image_prompt: "", graphic: { kind: "counter", title: "RAUND", items: [{ label: "Seed", value: "$21M" }], note: "" }, cards: [], pane: { kind: "number", value: "$21 MLN", label: "seed raund" } },
        { start: 10, end: 20, source: "graphic", photo_query: "", image_prompt: "", graphic: { kind: "quote", title: "", items: [], note: "Runable" }, cards: [] },
      ],
      image_style: "",
      notes: [],
    },
    timeline: {
      output_id: "reel_1",
      aspect: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      duration: 20,
      clips: [{ index: 0, src_start: 0, src_end: 20, out_start: 0, out_end: 20, speed: 1 }],
      captions: { enabled: true, language: "uz", style: "abror_seam_box" },
      titles: [],
      phrases: [
        {
          phrase: 0,
          clip: 0,
          start: 0.2,
          end: 3.0,
          text: "Gap shundaki yigirma bir million",
          lang: "uz",
          words: [
            { w: "Gap", start: 0.2, end: 0.8, clip: 0, phrase: 0 },
            { w: "shundaki", start: 0.8, end: 1.8, clip: 0, phrase: 0 },
            { w: "yigirma", start: 1.8, end: 3.0, clip: 0, phrase: 0 },
          ],
        },
        {
          phrase: 1,
          clip: 0,
          start: 6.0,
          end: 9.0,
          text: "Bu yangi avlod startapi",
          lang: "uz",
          words: [
            { w: "Bu", start: 6.0, end: 6.6, clip: 0, phrase: 1 },
            { w: "yangi", start: 6.6, end: 7.4, clip: 0, phrase: 1 },
            { w: "avlod", start: 7.4, end: 8.2, clip: 0, phrase: 1 },
            { w: "startapi", start: 8.2, end: 9.0, clip: 0, phrase: 1 },
          ],
        },
        {
          phrase: 2,
          clip: 0,
          start: 15.5,
          end: 18.5,
          text: "MAN soʻzini yozib qoldiring",
          lang: "uz",
          words: [
            { w: "MAN", start: 15.5, end: 16.2, clip: 0, phrase: 2 },
            { w: "soʻzini", start: 16.2, end: 17.0, clip: 0, phrase: 2 },
            { w: "yozib", start: 17.0, end: 17.8, clip: 0, phrase: 2 },
            { w: "qoldiring", start: 17.8, end: 18.5, clip: 0, phrase: 2 },
          ],
        },
      ],
    },
    pages: [],
  };

  const pw = hookPlateWindow(job.design, job, 20);
  assert.ok(pw && pw.end > 4);
  const layout = buildLayout(job, heuristicFontMetrics("Montserrat"));
  // phrases during the hook plate (0..4.28s) are hidden; phrase at 6s sits on the seam (0.435); phrase at 15.5s (full_speaker) moves to the chest (0.73)
  assert.ok(layout.pages.every((p) => p.dispStart >= pw!.end));
  const seamPage = layout.pages.find((p) => p.start >= 5 && p.start < 14);
  const fullPage = layout.pages.find((p) => p.start >= 15);
  assert.equal(seamPage?.anchorY ?? layout.captions.anchorY, 0.435);
  assert.equal(fullPage?.anchorY, 0.73);

  const html = composeHyperframes(job, layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "assets/fonts/Montserrat-Variable.ttf", gsapRel: "assets/gsap.min.js" });
  assert.ok(html.includes('id="a-roll"'));
  assert.ok(html.includes('id="a-roll-1"'));
  assert.ok(html.includes('id="sp-plate"'));
  assert.ok(html.includes('id="cta-word"'));

  // faceless composition + makeAbror with fakeRender
  const sources: AbrorSource[] = [
    {
      title: "Tenstorrent raises $1.5 billion at $6.2 billion valuation",
      url: "https://techcrunch.com/2026/10/18/tenstorrent/",
      publisher: "TechCrunch",
      date: "2026-10-18",
      text: "AI chip startup Tenstorrent raised $1.5 billion in a round led by Samsung and Jeff Bezos, reaching a $6.2 billion valuation in 2026.",
    },
  ];
  const mockLlm = async () => ({
    data: {
      title: "Tenstorrent 1,5 milliard dollar",
      hook_title: ["$1,5 MLRD INVESTITSIYA", "AI CHIP STARTAPI"],
      lines: [
        { part: "hook", text: "Gap shundaki, Tenstorrent startapi 1,5 milliard dollar investitsiya koʻtardi.", visual: { kind: "number", subject: "Tenstorrent", value: "$1,5 MLRD", label: "investitsiya", url: "" }, source: 0 },
        { part: "intro", text: "Bu — Nvidia bilan raqobatlashadigan yangi avlod AI chiplarini yaratayotgan kompaniya, yaʼni oddiy chiplardan ancha tez ishlaydi.", visual: { kind: "logo", subject: "Tenstorrent", value: "", label: "AI chiplar", url: "" }, source: 0 },
        { part: "fact", text: "Tasavvur qilinglar, kompaniya qiymati 6,2 milliard dollarga yetdi va bu raqam butun bozorni hayratda qoldirdi.", visual: { kind: "article", subject: "TechCrunch", value: "$6,2 MLRD", label: "baholanish", url: "" }, source: 0 },
        { part: "fact", text: "Sarmoyadorlar orasida Samsung hamda Jeff Bezos bor, bu degani yirik gigantlar ham ularga ishonmoqda.", visual: { kind: "logo", subject: "Samsung", value: "", label: "investor", url: "" }, source: 0 },
        { part: "twist", text: "Eng qizigʻi — startapni afsonaviy protsessor muhandisi boshqaradi va ular ochiq arxitekturaga tayanadi.", visual: { kind: "text", subject: "", value: "", label: "Ochiq arxitektura | AI chiplar", url: "" }, source: 0 },
        { part: "lesson", text: "Bundan qanday xulosa? Oʻzbekiston startap asoschilari va tadbirkorlar ham chuqur texnologiyadan qoʻrqmasligi kerak, chunki katta sarmoya aynan shu yerda.", visual: { kind: "text", subject: "", value: "", label: "Chuqur texnologiya | Katta bozor", url: "" }, source: -1 },
        { part: "cta", text: "Agar sizga manbalar kerak boʻlsa, izohlarda \"MAN\" soʻzini yozib qoldiringlar.", visual: { kind: "text", subject: "", value: "MAN", label: "izohda yozing", url: "" }, source: -1 },
      ],
      article: { source: 0, key_line: "Tenstorrent raised $1.5 billion" },
      caption: "Tenstorrent 1,5 milliard dollar koʻtardi 🤯 Aytgancha, \"MAN\" soʻzini yozib qoldiring.",
      hashtags: ["#startap", "#venchur"],
    },
    usd: 0.01,
    model: "mock",
    provider: "gemini" as const,
    estimate: false,
    usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 },
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-abror-"));
  try {
    const r = await makeAbror("Tenstorrent", {
      sources,
      research: false,
      llm: mockLlm,
      faceless: true,
      voice: "none",
      music: "none",
      fakeRender: async (_projectDir, out) => {
        await fs.mkdir(path.dirname(out), { recursive: true });
        await ffmpeg(["-f", "lavfi", "-i", "color=c=navy:s=1080x1920:r=30:d=6", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
      },
    });
    assert.ok(r.output);
    assert.equal(r.issues.length, 0);
    const panes = await resolveLinePanes(r.script, { dir: tmpDir, offline: true });
    assert.equal(panes.panes.length, r.script.lines.length);
    const wins = layLines(r.script, r.script.lines.map(() => 3));
    const lw = r.script.lines.map((l, i) => wordTimes(l.text, wins[i].start, 3));
    const segs = planSegments(r.script, wins, lw, panes.panes, 25);
    const fl = composeFaceless({
      W: 1080,
      H: 1920,
      fps: 30,
      duration: 25,
      design: PresetSchema.parse((await loadPreset("abror_full")).preset).design,
      segments: segs,
      words: lw.flat(),
      hookLines: r.script.hook_title,
      cta: { kind: "keyword", value: "MAN", label: "soʻzini yozib qoldiring", start: 21 },
      rel: (f) => f,
      fontFamily: "Montserrat",
      fontRel: "assets/fonts/Montserrat-Variable.ttf",
      gsapRel: "assets/gsap.min.js",
      id: "test",
    });
    assert.ok(fl.html.includes('id="plate"'));
    assert.ok(fl.html.includes('class="clip kc"'));
    assert.ok(fl.cues.length >= 3);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});
