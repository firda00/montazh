// Split montage without AI slop: banned-metaphor filter, panel sources (photo → graphic → ai), graphics only
// with numbers said in the speech, code-rendered graphic kinds, photo credits on the frame. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bannedMetaphor, parseNumber, numbersIn, saidInSpeech, renderGraphic, graphicsCss, GRAPHIC_KINDS, type Graphic } from "../src/design/panel-graphics.ts";
import { normalizePanels, resanitizePanels, sanitizeGraphic, PanelsSchema } from "../src/design/panels.ts";
import { buildSplitLayer, panelFrame } from "../src/design/hyperframes/split.ts";
import { shortPhotoCredit } from "../src/design/hyperframes/compose.ts";
import { DesignSpecSchema } from "../src/schemas/index.ts";

const PHRASES = [
  { start: 0, end: 4, text: "Реальность — это высший судья, физика — это закон." },
  { start: 4, end: 9, text: "Илон Маск говорит, что Tesla продала 1,8 миллиона машин, а в 2023 году 47% ответов ИИ были с ошибкой." },
  { start: 9, end: 14, text: "В 2020 было 10, в 2021 — 25, в 2022 — 60 запусков." },
];

test("bannedMetaphor: symbolic AI clichés are caught, documentary subjects pass", () => {
  for (const bad of [
    "A heavy brass judge's gavel resting on granite",
    "a precise balance scale weighing a holographic conclusion",
    "an apple frozen mid-fall above it",
    "glowing brain made of circuits",
    "a light bulb over a desk",
    "chess pieces on a board",
    "puzzle pieces fitting together",
    "a chain of glowing nodes",
    "answer dissolving into shimmering hallucinated mirages",
    "surreal floating island",
    "scales of justice",
  ])
    assert.ok(bannedMetaphor(bad), bad);
  for (const ok of ["Elon Musk portrait", "Falcon 9 rocket launch", "server rack data center", "apple orchard harvest", "physicist desk with handwritten equations, daylight", "Tesla Model 3 factory"]) assert.equal(bannedMetaphor(ok), null, ok);
});

test("numbers: parsing and 'said in the speech' (digits, thousands, decimal comma, small Russian number words)", () => {
  assert.deepEqual(parseNumber("$7,500"), { prefix: "$", value: 7500, decimals: 0, suffix: "" });
  assert.deepEqual(parseNumber("47%"), { prefix: "", value: 47, decimals: 0, suffix: "%" });
  assert.deepEqual(parseNumber("1,8 млн"), { prefix: "", value: 1.8, decimals: 1, suffix: " млн" });
  assert.equal(parseNumber("−3")?.value, -3);
  assert.equal(parseNumber("нет"), null);
  assert.ok(numbersIn("7 500 и 1,5").has("7500"));
  assert.ok(numbersIn("7 500 и 1,5").has("1.5"));
  const speech = PHRASES.map((p) => p.text).join(" ");
  assert.ok(saidInSpeech("47%", speech));
  assert.ok(saidInSpeech("1,8 млн", speech));
  assert.ok(!saidInSpeech("93%", speech));
  assert.ok(saidInSpeech("40%", "сорок процентов ответов"));
});

test("sanitizeGraphic: charts keep only numbers from the speech, otherwise a quote card", () => {
  const speech = PHRASES.map((p) => p.text).join(" ");
  const ok = sanitizeGraphic({ kind: "line", title: "Запуски", items: [{ label: "2020", value: "10" }, { label: "2021", value: "25" }, { label: "2022", value: "60" }, { label: "2023", value: "98" }], note: "" }, speech, []);
  assert.equal(ok.graphic.kind, "line");
  assert.equal(ok.graphic.items.length, 3, "the unsaid 98 is dropped");
  const bad = sanitizeGraphic({ kind: "counter", title: "", items: [{ label: "доля", value: "93%" }], note: "" }, speech, [{ kind: "quote", corner: "tl", title: "", lines: ["физика — это закон"] }]);
  assert.equal(bad.graphic.kind, "quote");
  assert.equal(bad.graphic.note, "физика — это закон");
  assert.match(bad.note!, /93%/);
  const tagsOnly = sanitizeGraphic(null, "", [{ kind: "tags", corner: "tl", title: "", lines: ["реальность", "физика"] }]);
  assert.equal(tagsOnly.graphic.kind, "list");
});

test("normalizePanels: AI metaphors become photo/graphic, graphic panels drop corner cards, every panel has a graphic", () => {
  const raw = {
    hook_title: [{ text: "ФИЗИКА", style: "display" }],
    panels: [
      { start: 0, end: 4, source: "ai", photo_query: "", image_prompt: "A judge's gavel and an apple frozen mid-fall", graphic: { kind: "quote", title: "", items: [], note: "Реальность — это высший судья" }, cards: [{ kind: "tags", corner: "tl", title: "", lines: ["физика"] }] },
      { start: 4, end: 9, source: "ai", photo_query: "Elon Musk portrait", image_prompt: "glowing brain hologram", graphic: { kind: "counter", title: "", items: [{ label: "ответов ИИ с ошибкой", value: "47%" }], note: "" }, cards: [{ kind: "quote", corner: "br", title: "", lines: ["Tesla продала 1,8 миллиона машин"] }] },
      { start: 9, end: 14, source: "photo", photo_query: "chess pieces", image_prompt: "", graphic: { kind: "bars", title: "Запуски", items: [{ label: "2020", value: "10" }, { label: "2021", value: "25" }, { label: "2022", value: "60" }], note: "" }, cards: [] },
    ],
    image_style: "",
  };
  const p = normalizePanels(raw, 14, PHRASES);
  assert.deepEqual(p.panels.map((x) => x.source), ["graphic", "photo", "graphic"]);
  assert.equal(p.panels[0].cards.length, 0, "graphic panel: no corner cards");
  assert.equal(p.panels[1].cards.length, 1, "photo panel keeps its cards");
  assert.ok(p.panels.every((x) => x.graphic));
  assert.equal(p.panels[2].graphic!.kind, "bars");
  assert.equal(p.notes.length, 3);
  assert.match(p.notes.join("\n"), /gavel[\s\S]*brain[\s\S]*chess/);
  // the reel_3 panels from before stage 17 (image_prompt only) all fall back to graphics
  const old = PanelsSchema.parse({ hook_title: [], panels: [{ start: 0, end: 9.4, image_prompt: "brass gavel, an apple frozen mid-fall", cards: [{ kind: "quote", corner: "tl", title: "", lines: ["Реальность — это высший судья"] }] }, { start: 9.4, end: 14, image_prompt: "a chain of glowing logical nodes, a balance scale", cards: [] }] });
  const re = resanitizePanels(old, PHRASES);
  assert.deepEqual(re.panels.map((x) => x.source), ["graphic", "graphic"]);
  assert.equal(re.panels[0].graphic!.kind, "quote");
  assert.equal(re.panels[0].graphic!.note, "Реальность — это высший судья");
  // a documentary AI prompt is allowed (last resort)
  const doc = normalizePanels({ hook_title: [], panels: [{ start: 0, end: 5, source: "ai", photo_query: "", image_prompt: "a physicist's desk with handwritten equations on paper, laboratory, daylight", graphic: { kind: "quote", title: "", items: [], note: "физика — это закон" }, cards: [] }], image_style: "" }, 5, PHRASES);
  assert.equal(doc.panels[0].source, "ai");
});

test("renderGraphic: every kind renders, every tween targets an element that exists, no CSS transform on tweened nodes", () => {
  const samples: Graphic[] = [
    { kind: "counter", title: "", items: [{ label: "ответов ИИ с ошибкой", value: "47%" }], note: "" },
    { kind: "bars", title: "Запуски", items: [{ label: "2020", value: "10" }, { label: "2021", value: "25" }, { label: "2022", value: "60" }], note: "по словам спикера" },
    { kind: "line", title: "Запуски", items: [{ label: "2020", value: "10" }, { label: "2021", value: "25" }, { label: "2022", value: "60" }], note: "" },
    { kind: "quote", title: "Илон Маск", items: [], note: "Реальность — это высший судья, физика — это закон" },
    { kind: "timeline", title: "", items: [{ label: "2020", value: "первый запуск" }, { label: "2022", value: "60 запусков" }], note: "" },
    { kind: "compare", title: "", items: [{ label: "ИИ", value: "уверенно ошибается" }, { label: "Физика", value: "не ошибается" }], note: "" },
    { kind: "chat", title: "", items: [{ label: "user", value: "Это правда?" }, { label: "ai", value: "Да, абсолютно точно." }], note: "" },
    { kind: "search", title: "законы физики", items: [{ label: "Первые принципы", value: "рассуждение от базовых истин" }], note: "" },
    { kind: "post", title: "Илон Маск", items: [{ label: "просмотров", value: "1,8 млн" }], note: "Проверяйте выводы реальностью" },
    { kind: "list", title: "Как проверять", items: [{ label: "первые принципы", value: "" }, { label: "математика", value: "" }], note: "" },
  ];
  assert.equal(samples.length, GRAPHIC_KINDS.length);
  for (const g of samples) {
    const out = renderGraphic(g, { id: "sp0", w: 972, h: 750, start: 2, duration: 6, accent: "#8B6CFF", bg: "#0D0A1A", displayFamily: "'Inter', sans-serif", serifFamily: "'VPlayfairItalic', serif", monoFamily: "'VMono', monospace" });
    assert.ok(out.tweens.length >= 2, g.kind);
    for (const t of out.tweens) {
      const sel = /tl\.fromTo\("#([^"]+)"/.exec(t)![1];
      assert.ok(out.html.includes(`id="${sel}"`), `${g.kind}: ${sel}`);
      const at = Number(/, ([\d.]+)\);$/.exec(t)![1]);
      assert.ok(at >= 2 && at < 8, `${g.kind}: tween at ${at} inside the panel`);
      assert.ok(!/repeat: -1/.test(t));
    }
    assert.ok(!out.html.includes('style="font-family:"'), "single quotes only inside style attributes");
  }
  const css = graphicsCss({ w: 972, h: 750, accent: "#8B6CFF", bg: "#0D0A1A", displayFamily: "'Inter'", monoFamily: "'VMono'" });
  assert.ok(!/[^-]transform:/.test(css), "only transform-origin, never a CSS transform");
  // the odometer rolls each digit to its value
  const odo = renderGraphic(samples[0], { id: "x", w: 972, h: 750, start: 0, duration: 4, accent: "#fff", bg: "#000", displayFamily: "a", serifFamily: "b", monoFamily: "c" });
  assert.ok(odo.tweens.some((t) => /yPercent: -40/.test(t)) && odo.tweens.some((t) => /yPercent: -70/.test(t)));
});

test("buildSplitLayer: graphic panels render without an image or corner cards, photo panels get a credit line", () => {
  const design = DesignSpecSchema.parse({ layout: "split", split: { accent: "#8B6CFF" } });
  const p = normalizePanels(
    {
      hook_title: [{ text: "ФИЗИКА", style: "display" }],
      panels: [
        { start: 0, end: 5, source: "photo", photo_query: "Elon Musk portrait", image_prompt: "", graphic: { kind: "quote", title: "", items: [], note: "Реальность — это высший судья" }, cards: [{ kind: "tags", corner: "tl", title: "", lines: ["Маск"] }] },
        { start: 5, end: 14, source: "graphic", photo_query: "", image_prompt: "", graphic: { kind: "counter", title: "", items: [{ label: "ответов ИИ с ошибкой", value: "47%" }], note: "" }, cards: [] },
      ],
      image_style: "",
    },
    14,
    PHRASES,
  );
  const credit = shortPhotoCredit({ creator: "Gage Skidmore", license: "by-sa", license_version: "2.0", source: "wikimedia" });
  assert.equal(credit, "фото: Gage Skidmore · CC BY-SA 2.0 · wikimedia");
  const layer = buildSplitLayer({ W: 1080, H: 1920, duration: 14, design, panels: p, images: { 0: "assets/panels/scene_0.jpg" }, credits: { 0: credit }, serifFamily: "'VPlayfairItalic', serif", monoFamily: "'VMono', monospace", displayFamily: "'Inter', sans-serif" });
  const html = layer.sections.join("\n");
  assert.match(html, /id="sp0-img"/);
  assert.match(html, /id="sp0-cr">фото: Gage Skidmore/);
  assert.match(html, /id="sp0-c0"/, "photo panel keeps its card");
  assert.match(html, /<span class="gx" id="sp1-g">/);
  assert.ok(!/id="sp1-img"/.test(html));
  assert.ok(layer.tweens.some((t) => t.includes("#sp1-g-d0")), "the counter's digits roll");
  assert.match(layer.css, /\.gx-strip/);
  assert.deepEqual(panelFrame(1080, 1920, 0.5), { x: 54, y: 150, w: 972, h: 750 });
});

test("photo search: statistics maps/charts with photo-like titles are not photos", async () => {
  const { rejectReason } = await import("../src/make/photos.ts");
  const { FRAMES } = await import("../src/lib/aspect.ts");
  const base = { id: "x", creator: "", creator_url: "", license: "cc0", license_version: "1.0", license_url: "", url: "u", foreign_landing_url: "", provider: "wikimedia", source: "wikimedia", filetype: "png", filesize: null, width: 3400, height: 2400, mature: false, tags: [] };
  assert.equal(rejectReason({ ...base, title: "Green coffee production, 2022" }, FRAMES["16:9"]), "not a photo (data graphic)");
  assert.equal(rejectReason({ ...base, title: "Coffee consumption per capita" }, FRAMES["16:9"]), "not a photo (data graphic)");
  assert.equal(rejectReason({ ...base, filetype: "jpg", title: "Vietnam - Coffee plant" }, FRAMES["16:9"]), null);
});
