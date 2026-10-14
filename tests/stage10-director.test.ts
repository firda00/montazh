import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contrast, directDesign, fallbackDesign, normalizeDesign } from "../src/make/design.ts";
import { composeScenes, timeScenes, tokenize } from "../src/make/scenes.ts";
import { ScriptSchema } from "../src/make/script.ts";
import { generateImages } from "../src/make/images.ts";
import { findHeadlessChrome } from "../src/make/fit.ts";
import { writeDirectorProject } from "../src/make/index.ts";
import { runCli } from "../src/render/cli-runner.ts";
import { HF_BIN } from "../src/design/hyperframes/project.ts";
import { ffmpeg } from "../src/lib/ffmpeg.ts";
import type { StructuredFn } from "../src/lib/llm.ts";

const script = ScriptSchema.parse({
  title: "Кофе дорожает",
  language: "ru",
  beats: [
    { text: "Арабика за год подорожала на 70 процентов", seconds: 3 },
    { text: "Кофе на бирже дешевеет, а в кофейне дорожает", seconds: 3 },
    { text: "Что входит в цену чашки", seconds: 3 },
    { text: "Сохрани и посчитай свои траты", seconds: 3 },
  ],
});

const RAW = {
  identity: { palette: { bg: "#14100D", bg2: "#2A1D14", text: "#1A1A1A", accent: "#E8A36B", accent2: "#F6D2B0", muted: "#A79584" }, display_font: "inter", accent_font: "playfair-italic", kicker_font: "mono", texture: "grain", image_style: "cinematic", brand: "кофе 2026 и дальше", music: "chill" },
  scenes: [
    { beat: 0, layout: "hero_number", headline: "Арабика за год подорожала", accents: [{ text: "подорожала", style: "serif" }, { text: "не в тексте", style: "marker" }], kicker: "ICE", sub: null, number: { value: "+70%", unit: "за год" }, items: null, image: null, entrance: "mask" },
    { beat: 1, layout: "media_full", headline: "Кофе на бирже дешевеет, а в кофейне дорожает", accents: [{ text: "В КОФЕЙНЕ дорожает", style: "marker" }], kicker: null, sub: null, number: null, items: null, image: { prompt: "espresso cup", motion: "zoom_in" }, entrance: "rise" },
    { beat: 2, layout: "list", headline: "Что входит в цену чашки", accents: [], kicker: "из чего", sub: null, number: null, items: ["Аренда"], image: null, entrance: "rise" },
    { beat: 3, layout: "headline", headline: "Сохрани и посчитай свои траты", accents: [{ text: "посчитай", style: "marker" }], kicker: null, sub: null, number: null, items: null, image: null, entrance: "pop" },
  ],
};

test("normalizeDesign: unreadable text colour fixed, accents verbatim only, layouts without data downgraded, no repeats", () => {
  const { design, notes } = normalizeDesign(RAW, script);
  assert.equal(design.identity.palette.text, "#FFFFFF", "dark text on a dark bg is replaced");
  assert.ok(contrast(design.identity.palette.text, design.identity.palette.bg) >= 4.5);
  assert.equal(design.identity.brand, "КОФЕ 2026 И Д…", "brand cut to 14 chars and uppercased");
  assert.deepEqual(design.scenes[0].accents.map((a) => a.text), ["подорожала"]);
  assert.equal(design.scenes[0].number?.value, "+70%");
  assert.equal(design.scenes[1].layout, "media_full");
  assert.equal(design.scenes[1].accents[0].text, "В КОФЕЙНЕ дорожает", "case-insensitive match kept");
  assert.equal(design.scenes[2].layout, "headline", "list with one item → headline");
  assert.equal(design.scenes[3].layout, "quote", "second headline in a row → quote");
  assert.ok(notes.some((n) => /плохо читается/.test(n)) && notes.some((n) => /акцент не найден/.test(n)));
  const fb = fallbackDesign(script);
  assert.deepEqual(fb.scenes.map((s) => s.layout), ["headline", "quote", "headline", "quote"]);
});

test("directDesign sends the beats and parses the answer", async () => {
  let prompt = "";
  const llm: StructuredFn = async (q) => {
    prompt = q.prompt;
    return { data: RAW, usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.03, estimate: false, model: "m", provider: "mock" };
  };
  const r = await directDesign("кофе", script, llm);
  assert.match(prompt, /0 \(3s\): Арабика за год подорожала на 70 процентов/);
  assert.match(prompt, /4 scenes/);
  assert.equal(r.design.scenes.length, 4);
  assert.equal(r.usd, 0.03);
});

test("composeScenes: deterministic, one section per beat on the frame grid, accents and entrances rendered, media falls back without an image", () => {
  const { design } = normalizeDesign(RAW, script);
  const o = { images: {}, fontFaces: "", gsapRel: "g.js" };
  const a = composeScenes(script, design, o);
  assert.equal(a.html, composeScenes(script, design, o).html);
  assert.equal(a.duration, timeScenes(script).duration);
  assert.equal((a.html.match(/class="clip scene /g) ?? []).length, 4);
  assert.match(a.html, /class="clip scene L-hero_number hook"/);
  assert.match(a.html, /class="clip scene L-headline"/, "media_full without an image renders as a headline");
  assert.match(a.html, /class="num-v">\+70%<\/span><span class="num-u">за год</);
  assert.match(a.html, /class="w acc-w-serif"/);
  assert.match(a.html, /class="acc acc-marker" id="sc1-hl-a0"/);
  assert.match(a.html, /class="wm"><span class="w"/, "mask entrance wraps words");
  assert.match(a.html, /yPercent: 110/);
  assert.match(a.html, /backgroundSize: "0% 78%"/, "marker swipe");
  assert.ok(!/tl\.(fromTo|to|set)\("#sc\d+",/.test(a.html), "never tween the .clip itself");
  const withImg = composeScenes(script, design, { ...o, images: { 1: "assets/img/scene_1.jpg" } });
  assert.match(withImg.html, /class="clip scene L-media_full"/);
  assert.match(withImg.html, /<img class="img" id="sc1-img" src="assets\/img\/scene_1\.jpg"/);
  assert.match(withImg.html, /tl\.fromTo\("#sc1-img", \{ scale: 1 \}, \{ scale: 1\.14/);
  // tokenize maps a multi-word accent onto its words
  const t = tokenize(design.scenes[1]);
  assert.deepEqual(t.filter((x) => x.accent === 0).map((x) => x.word), ["в", "кофейне", "дорожает"]);
  // sizes override the defaults
  const sized = composeScenes(script, design, { ...o, sizes: { "sc0-hl": 61 } });
  assert.match(sized.html, /id="sc0-hl"|font-size:61px/);
});

test("generateImages: files from the generator are normalised to 1080×1920 JPEG; missing ones reported", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-img-test-"));
  const r = await generateImages([{ beat: 1, prompt: "a" }, { beat: 4, prompt: "b" }], dir, {
    style: "x",
    generate: async (reqs, work) => {
      await ffmpeg(["-f", "lavfi", "-i", "color=c=orange:size=768x1376", "-frames:v", "1", path.join(work, `scene_${reqs[0].beat}.PNG`)]);
    },
  });
  assert.deepEqual([...r.files.keys()], [1]);
  assert.deepEqual(r.missing, [4]);
  const probe = await import("../src/lib/ffmpeg.ts").then((m) => m.ffprobe(r.files.get(1)!));
  const v = probe.streams.find((s: { codec_type?: string }) => s.codec_type === "video") as { width: number; height: number };
  assert.deepEqual([v.width, v.height], [1080, 1920]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("writeDirectorProject: fonts installed, text fitted in Chrome, lints clean", async (t) => {
  if (!(await findHeadlessChrome())) return t.skip("no headless Chrome in ~/.cache/puppeteer");
  const { design } = normalizeDesign(RAW, script);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-dir-"));
  const long = { ...design, scenes: design.scenes.map((s, i) => (i === 3 ? { ...s, headline: "Сохрани это видео и обязательно посчитай все свои траты на кофе за последний месяц прямо сейчас" } : s)) };
  const r = await writeDirectorProject(script, long, {}, dir);
  assert.deepEqual(r.overflow, []);
  const lay = JSON.parse(await fs.readFile(path.join(dir, "layout.json"), "utf8")) as { sizes: Record<string, number>; scenes: unknown[] };
  assert.equal(lay.scenes.length, 4);
  assert.ok(lay.sizes["sc3-hl"] < 116, `long headline shrunk: ${lay.sizes["sc3-hl"]}`);
  assert.ok((await fs.readdir(path.join(dir, "assets", "fonts"))).some((f) => /playfair-display-cyrillic-700-italic\.woff$/.test(f)));
  const lint = await runCli(HF_BIN, ["lint", "--json"], dir);
  const parsed = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{"))) as { errorCount: number; findings?: unknown[] };
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
  await fs.rm(dir, { recursive: true, force: true });
});
