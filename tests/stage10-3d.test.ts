import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LAYOUTS, LAYOUTS_3D, normalizeDesign } from "../src/make/design.ts";
import { composeScenes, hueShift, mixHex, seeded } from "../src/make/scenes.ts";
import { ScriptSchema } from "../src/make/script.ts";
import { findHeadlessChrome } from "../src/make/fit.ts";
import { writeDirectorProject } from "../src/make/index.ts";
import { runCli } from "../src/render/cli-runner.ts";
import { HF_BIN } from "../src/design/hyperframes/project.ts";

const script = ScriptSchema.parse({
  title: "Кофе — новая нефть",
  language: "ru",
  beats: [
    { text: "Кофе — это новая нефть", seconds: 4 },
    { text: "Четыре шага к своей чашке дешевле", seconds: 4.5 },
    { text: "Цена чашки выросла в три раза", seconds: 4 },
    { text: "Сохрани и посчитай свои траты", seconds: 3 },
  ],
});

const identity = { palette: { bg: "#14100D", bg2: "#2A1D14", text: "#FFFFFF", accent: "#E8A36B", accent2: "#F6D2B0", muted: "#A79584" }, display_font: "inter", accent_font: "playfair-italic", kicker_font: "mono", texture: "grain", image_style: "cinematic", brand: "кофе", music: "chill" };
const scene = (o: Record<string, unknown>) => ({ accents: [], kicker: null, sub: null, number: null, items: null, image: null, entrance: "rise", ...o });

const RAW = {
  identity,
  scenes: [
    scene({ beat: 0, layout: "orbit_title", headline: "Кофе — новая нефть", kicker: "рынок · 2026", accents: [{ text: "нефть", style: "serif" }], entrance: "mask" }),
    scene({ beat: 1, layout: "depth_cards", headline: "Четыре шага к своей чашке дешевле", items: ["Купи зерно на развес", "Возьми ручную кофемолку", "Вари в аэропрессе", "Носи термокружку и никогда не бери стакан навынос"] }),
    scene({ beat: 2, layout: "tunnel_number", headline: "Цена чашки выросла за пять лет", number: { value: "×3", unit: "за 5 лет" }, sub: "капучино в Москве", entrance: "pop" }),
    scene({ beat: 3, layout: "headline", headline: "Сохрани и посчитай свои траты", accents: [{ text: "посчитай", style: "marker" }] }),
  ],
};

test("3D layouts are in the vocabulary and in the director prompt", async () => {
  for (const l of LAYOUTS_3D) assert.ok((LAYOUTS as readonly string[]).includes(l));
  const prompt = await fs.readFile(path.join(import.meta.dirname, "..", "prompts", "make.design.system.md"), "utf8");
  for (const l of LAYOUTS_3D) assert.match(prompt, new RegExp(`"${l}"`));
});

test("normalizeDesign keeps valid 3D scenes and downgrades the ones without data", () => {
  const { design } = normalizeDesign(RAW, script);
  assert.deepEqual(design.scenes.map((s) => s.layout), ["orbit_title", "depth_cards", "tunnel_number", "headline"]);
  assert.ok(design.scenes[1].items.every((t) => t.length <= 30), "card items cut to 30 chars");
  assert.equal(design.scenes[1].items[3], "Носи термокружку и никогда не…");
  assert.deepEqual(design.scenes[2].number, { value: "×3", unit: "за 5 лет" });

  const bad = {
    identity,
    scenes: [
      scene({ beat: 0, layout: "depth_cards", headline: "Два пункта", items: ["Первый", "Второй"] }),
      scene({ beat: 1, layout: "depth_cards", headline: "Один пункт", items: ["Первый"] }),
      scene({ beat: 2, layout: "tunnel_number", headline: "Без числа" }),
      scene({ beat: 3, layout: "orbit_title", headline: "Очень длинное предложение, которое никак не станет гигантским заголовком в кольце" }),
    ],
  };
  const d = normalizeDesign(bad, script);
  assert.deepEqual(d.design.scenes.map((s) => s.layout), ["list", "headline", "quote", "headline"], "2 items → list, 1 → headline, no number → headline (→ quote after a headline), long orbit → headline");
  assert.equal(d.design.scenes[2].number, null);

  const twice = { identity, scenes: [0, 1, 2, 3].map((b) => scene({ beat: b, layout: "orbit_title", headline: `Заголовок ${b}` })) };
  const t = normalizeDesign(twice, script);
  // stage 25: each typographic/3D device once per video; the repeats become headlines (never two in a row)
  assert.deepEqual(t.design.scenes.map((s) => s.layout), ["orbit_title", "headline", "quote", "headline"], "a 3D layout appears once per video");
});

test("composeScenes: 3D scenes are deterministic, timeline-driven, fit-ready and cue sound", () => {
  const { design } = normalizeDesign(RAW, script);
  const o = { images: {}, fontFaces: "", gsapRel: "g.js" };
  const a = composeScenes(script, design, o);
  assert.equal(a.html, composeScenes(script, design, o).html, "same input → same HTML");
  assert.match(a.html, /class="clip scene L-orbit_title hook"/);
  assert.match(a.html, /class="clip scene L-depth_cards"/);
  assert.match(a.html, /class="clip scene L-tunnel_number"/);
  // no runtime randomness, clocks or free-running loops
  assert.ok(!/Math\.random|Date\.now|performance\.now|requestAnimationFrame|repeat: -1/.test(a.html));
  // a real 3D context: perspective stage + preserve-3d world
  assert.match(a.html, /\.st3 \{[^}]*perspective: 1500px/);
  assert.match(a.html, /transform-style: preserve-3d/);
  // orbit: 24–40 cubes of six faces, each driven by its own tweens on the main timeline
  const cubes = a.html.match(/id="sc0-cr\d+"/g) ?? [];
  assert.ok(cubes.length >= 24 && cubes.length <= 40, `cubes: ${cubes.length}`);
  assert.equal((a.html.match(/<i class="fc"/g) ?? []).length, cubes.length * 6);
  assert.match(a.html, /tl\.fromTo\("#sc0-spin2", \{ rotation: -150 \}/);
  assert.match(a.html, /tl\.fromTo\("#sc0-cb0", \{ scale: 0 \}/);
  assert.match(a.html, /id="sc0-cap">рынок · 2026</);
  // text still goes through the fit pass
  assert.match(a.html, /data-fit="sc0-hl"/);
  for (let k = 0; k < 4; k++) assert.match(a.html, new RegExp(`data-fit="sc1-c${k}t"`));
  assert.match(a.html, /data-fit="sc2-num"/);
  // depth cards come forward in sequence; the tunnel number flies out of depth
  assert.equal((a.html.match(/tl\.fromTo\("#sc1-c\d", \{ z: 0, opacity: 0\.5/g) ?? []).length, 4);
  assert.match(a.html, /tl\.fromTo\("#sc2-num", \{ z: -2400, opacity: 0 \}/);
  // GSAP never fights a CSS transform: tweened 3D nodes carry no inline transform
  for (const tid of ["sc0-w3", "sc0-spin", "sc0-spin2", "sc0-cb0", "sc0-cr0", "sc1-cam", "sc1-c0", "sc2-tn", "sc2-tn2", "sc2-num"]) {
    const tag = a.html.match(new RegExp(`<[^>]*id="${tid}"[^>]*>`))?.[0] ?? "";
    assert.ok(tag, `element ${tid} exists`);
    assert.ok(!/transform:/.test(tag), `${tid} has no inline transform: ${tag}`);
  }
  // sound: riser into the orbit settle, ticks on the cards, an impact on the number
  const kinds = (from: number, to: number) => a.cues.filter((c) => c.t >= from && c.t < to).map((c) => c.kind);
  assert.ok(kinds(0, 4).includes("riser") && kinds(0, 4).includes("impact"));
  assert.equal(kinds(4, 8.5).filter((k) => k === "tick").length, 4);
  assert.ok(kinds(8.5, 12.5).includes("impact"));
  // the geometry depends on the seed only
  assert.equal(seeded("x")(), seeded("x")());
  assert.notEqual(seeded("x")(), seeded("y")());
  assert.equal(mixHex("#000000", "#FFFFFF", 0.5), "#808080");
  assert.equal(hueShift("#FF0000", 120), "#00FF00");
});

test("writeDirectorProject with 3D layouts: fitted in Chrome, lints clean", async (t) => {
  if (!(await findHeadlessChrome())) return t.skip("no headless Chrome in ~/.cache/puppeteer");
  const { design } = normalizeDesign(RAW, script);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-3d-"));
  const r = await writeDirectorProject(script, design, {}, dir);
  assert.deepEqual(r.overflow, []);
  const lint = await runCli(HF_BIN, ["lint", "--json"], dir);
  const parsed = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{"))) as { errorCount: number; findings?: { rule?: string; code?: string; severity?: string }[] };
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
  const gsapWarnings = (parsed.findings ?? []).filter((f) => /gsap/.test(f.rule ?? f.code ?? ""));
  assert.deepEqual(gsapWarnings, [], "no GSAP warnings (transform conflicts, repeated fromTo)");
  await fs.rm(dir, { recursive: true, force: true });
});
