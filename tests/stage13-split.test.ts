import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePanels, fallbackPanels, directPanels } from "../src/design/panels.ts";
import { buildSplitLayer, videoOffset } from "../src/design/hyperframes/split.ts";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import { buildDesignTimeline } from "../src/design/timeline.ts";
import { styleFromText, STYLES } from "../src/bot/index.ts";
import { DesignSpecSchema, EdlSchema } from "../src/schemas/index.ts";
import type { DesignJob } from "../src/design/export.ts";
import type { Layout } from "../src/design/layout-types.ts";
import type { StructuredFn } from "../src/lib/llm.ts";
import { MEDIA, makeTranscript } from "./helpers/plan-fixture.ts";

const RAW = {
  hook_title: [
    { text: "ФИЗИКА", style: "display" },
    { text: "ВЫСШИЙ СУДЬЯ", style: "accent" },
    { text: "а ИИ ошибается", style: "serif" },
    { text: "лишняя строка", style: "display" },
  ],
  panels: [
    { start: 9, end: 20, image_prompt: "AI chat on a monitor", cards: [{ kind: "code", corner: "bl", title: "", lines: ["answer = llm.ask(q)", "verify(answer)"] }] },
    { start: 0, end: 9.4, source: "photo", photo_query: "Isaac Newton portrait", image_prompt: "a gavel and an apple", cards: [{ kind: "quote", corner: "tl", title: "", lines: ["Реальность — это высший судья"] }, { kind: "tags", corner: "tl", title: "", lines: ["реальность", "законы физики"] }, { kind: "stat", corner: "br", title: "", lines: [] }] },
    { start: 20, end: 25, image_prompt: "", cards: [] },
  ],
  image_style: "cinematic purple neon",
};

test("normalizePanels: sorted, tiling 0..duration, distinct corners, empty prompts dropped, hook ≤ 3 lines", () => {
  const p = normalizePanels(RAW, 30);
  assert.deepEqual(p.panels.map((x) => [x.start, x.end]), [[0, 9.4], [9.4, 30]]);
  assert.deepEqual(p.panels[0].cards.map((c) => `${c.kind}:${c.corner}`), ["quote:tl", "tags:tr", "stat:br"], "second tl card moved to a free corner");
  assert.equal(p.hook_title.length, 3);
  assert.equal(p.image_style, "cinematic purple neon");
  const fb = fallbackPanels(12, "Физика это закон для всех");
  assert.equal(fb.panels.length, 1);
  assert.deepEqual(fb.hook_title.map((l) => l.style), ["display", "accent", "serif"]);
});

test("directPanels sends the transcript with output times", async () => {
  let prompt = "";
  const llm: StructuredFn = async (q) => ((prompt = q.prompt), { data: RAW, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.02, estimate: false, model: "m", provider: "mock" });
  const r = await directPanels([{ phrase: 0, clip: 0, start: 0, end: 2.3, text: "Добро пожаловать", lang: "ru", words: [] }] as never, 30, { llm, language: "ru", instruction: "1 рилс" });
  assert.match(prompt, /0\.0-2\.3s: Добро пожаловать/);
  assert.match(prompt, /REEL DURATION: 30\.0/);
  assert.equal(r.panels.panels.length, 2);
});

test("videoOffset keeps the face in the upper part of the bottom box", () => {
  assert.equal(videoOffset(0.3, 1920, 960), 18);
  assert.equal(videoOffset(0.05, 1920, 960), 0);
  assert.equal(videoOffset(0.95, 1920, 960), 100);
});

test("buildSplitLayer + composeHyperframes: video in the bottom half, panels and hook on top, EDL titles suppressed, single-quoted font stacks", () => {
  const design = DesignSpecSchema.parse({ layout: "split", split: { accent: "#8B6CFF" } });
  const panels = normalizePanels(RAW, 4.7);
  const layer = buildSplitLayer({ W: 1080, H: 1920, duration: 4.7, design, panels, images: { 0: "assets/panels/scene_0.jpg" }, faceY: 0.3, serifFamily: "'VPlayfairItalic', serif", monoFamily: "'VMono', monospace", displayFamily: "'Inter', sans-serif" });
  assert.match(layer.videoCss, /top: 960px; width: 1080px; height: 960px; object-fit: cover; object-position: 50% 18%/);
  assert.ok(!layer.sections.join("").includes('style="font-family:"'), "no double quotes inside style attributes");
  assert.equal(layer.sections.filter((x) => /class="clip sp-panel"/.test(x)).length, panels.panels.length);
  assert.ok(layer.tweens.some((t) => t.includes("#sp-h2")));

  const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }], titles: [{ at: 0.3, duration: 2.5, text: "Заголовок EDL" }], captions: { enabled: true, language: "ru" } }], reasoning: "" });
  const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);
  const job: DesignJob = { job_id: "t", rough_path: "C:/x/rough.mp4", timeline, pages: [], design, preset: "split_news", captions_language: "ru", translated: false, warnings: [], panels, panel_images: {}, face_y: 0.3 };
  const layout: Layout = {
    frame: { width: 1080, height: 1920, fps: 30, duration: 4.7 },
    captions: { anchorY: 0.79, maxWidth: 864, baseFontSize: 62, strokeWidth: 4, uppercase: true, language: "ru" },
    titles: { anchorY: 0.18, maxWidth: 800, baseFontSize: 88 },
    font: { family: "Inter", file: "f.ttf", weight: 800, source: "heuristic" },
    version: "layout/test",
    pages: [],
    titlesOut: [{ index: 0, at: 0.3, duration: 2.5, text: "Заголовок EDL", style: "hero", fontSize: 88, lines: ["Заголовок EDL"], width: 600 }],
  };
  const html = composeHyperframes(job, layout, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js", panelRel: { 0: "assets/panels/scene_0.jpg" }, extraFontFaces: "@font-face { font-family: \"VMono\"; }" });
  assert.match(html, /#a-roll \{ position: absolute; left: 0; top: 960px/);
  assert.ok(!/id="ttl-0"/.test(html), "EDL titles are replaced by the hook in split layout");
  assert.match(html, /id="sp-hook"/);
  assert.match(html, /<img class="sp-img" id="sp0-img" src="assets\/panels\/scene_0\.jpg"/);
  assert.match(html, /@font-face \{ font-family: "VMono"; \}/);
  // full layout is unchanged
  const full = composeHyperframes({ ...job, design: DesignSpecSchema.parse({}), panels: undefined }, layout, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js" });
  assert.match(full, /#a-roll \{ position: absolute; inset: 0;/);
  assert.match(full, /id="ttl-0"/);
});

test("bot styles: /style names and styles named in the instruction", () => {
  assert.equal(STYLES.split, "split_news");
  assert.equal(STYLES.pop, "bold_pop");
  assert.equal(styleFromText("2 рилса в стиле сплит"), "split_news");
  assert.equal(styleFromText("сделай как у aleko"), "split_news");
  assert.equal(styleFromText("3 рилса по 30 секунд"), undefined);
});
