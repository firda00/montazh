// Stage 16: anti-slop make. Cliché check + one rewrite, real photos from Openverse (stubbed fetch, no network)
// with licences and credits, 9:16 / 16:9 / 1:1 frames (aspect from words, landscape composition fitted in
// Chrome), narration-timed word reveal, no persistent header by default, cuts/whips/zooms, livelier Piper.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-slop-ws-"));
process.env.VEDIT_MUSIC_OFFLINE = "1";

const { findCliches, wantsCta } = await import("../src/make/slop.ts");
const { writeScript, ScriptSchema } = await import("../src/make/script.ts");
const { detectAspect, stripAspectWords, frameFor } = await import("../src/lib/aspect.ts");
const { findPhotos, rankPhotos, rejectReason, photoCreditLine, queryVariants } = await import("../src/make/photos.ts");
const { normalizeDesign, varyComposition, photoQuery } = await import("../src/make/design.ts");
const { composeScenes, alignWords, dropRepeatedNumber } = await import("../src/make/scenes.ts");
const { make, writeDirectorProject, creditsText, speechByBeat } = await import("../src/make/index.ts");
const { speechWords, makeVoiceover, NARRATION } = await import("../src/voice/voiceover.ts");
const { sentenceParams } = await import("../src/voice/piper.ts");
const { parseMakeArgs } = await import("../src/bot/index.ts");
const { findHeadlessChrome } = await import("../src/make/fit.ts");
const { runCli } = await import("../src/render/cli-runner.ts");
const { HF_BIN } = await import("../src/design/hyperframes/project.ts");
const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
const { jobDir } = await import("../src/lib/workspace.ts");
type StructuredFn = import("../src/lib/llm.ts").StructuredFn;
type SentenceSynth = import("../src/voice/piper.ts").SentenceSynth;

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-slop-"));
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };

const SLOPPY = {
  title: "Кофе дорожает",
  language: "ru",
  beats: [
    { text: "Кофе дорожает, и дело не в жадности кофеен.", emphasis: "", icon: "coffee", seconds: 4, voiceover: "Давайте разберёмся, почему так." },
    { text: "Это не просто напиток — это ритуал.", emphasis: "", icon: "coffee", seconds: 4, voiceover: "Представьте мир, где кофе — роскошь." },
    { text: "Быстро. Дёшево. Удобно.", emphasis: "", icon: "coffee", seconds: 4, voiceover: "It's not just coffee, it's a game changer. Let's dive in." },
    { text: "Напиши в комментариях, сколько платишь.", emphasis: "", icon: "coffee", seconds: 4, voiceover: "Твоя очередь! Подпишись." },
  ],
  hashtags: [],
};
const CLEAN = {
  title: "Арабика по 301 центу",
  language: "ru",
  beats: [
    { text: "Арабика на ICE — 301,88 цента за фунт", emphasis: "301,88 цента", icon: "trending-up", seconds: 3, voiceover: "Арабика на бирже ICE — почти триста два цента за фунт." },
    { text: "Колумбия собрала на 15% меньше кофе", emphasis: "15%", icon: "cloud-rain", seconds: 5, voiceover: "Колумбия собрала на пятнадцать процентов меньше, экспорт упал на двенадцать." },
    { text: "Кофе навынос в России — 233 рубля", emphasis: "233 рубля", icon: "coffee", seconds: 5, voiceover: "Средний чек за кофе с собой в России вырос до двухсот тридцати трёх рублей." },
    { text: "Автоматы продают на 25% больше", emphasis: "25%", icon: "coins", seconds: 5, voiceover: "А кофе из автоматов по сто двадцать восемь рублей продаётся на четверть лучше." },
  ],
  hashtags: ["кофе"],
};

test("cliché check: the banned list fires in RU and EN, the hook needs a number or a name, CTA only when asked", () => {
  const f = findCliches(ScriptSchema.parse(SLOPPY));
  const rules = new Set(f.map((x) => x.rule));
  for (const r of ["delo_ne_v", "razberemsya", "ne_prosto", "dash_punchline", "predstav", "triplet", "game_changer", "dive_in", "not_just", "comments_cta", "subscribe_cta", "tvoya_ochered", "vague_hook"]) assert.ok(rules.has(r), `${r} found: ${[...rules].join(",")}`);
  assert.deepEqual(findCliches(ScriptSchema.parse(CLEAN)), [], "a concrete script passes (the copula dash «Кофе навынос — 233 рубля» is fine)");
  const ctaAllowed = findCliches(ScriptSchema.parse(SLOPPY), { allowCta: true });
  assert.ok(!ctaAllowed.some((x) => x.rule.endsWith("_cta") || x.rule === "tvoya_ochered"));
  assert.ok(wantsCta("сделай ролик и добавь призыв подписаться") && !wantsCta("почему кофе дорожает"));
});

test("writeScript: a sloppy draft is sent back once with the findings; the clean rewrite is kept", async () => {
  const prompts: string[] = [];
  const llm: StructuredFn = async (q) => {
    prompts.push(q.prompt);
    return { data: prompts.length === 1 ? SLOPPY : CLEAN, usage, usd: 0.01, estimate: false, model: "m", provider: "mock" };
  };
  const r = await writeScript("почему кофе дорожает", llm, { language: "ru", seconds: 20 });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /дело не в жадности/);
  assert.match(prompts[1], /the hook has no number/);
  assert.equal(r.script.title, "Арабика по 301 центу");
  assert.ok(r.cliches.length >= 10);
  assert.deepEqual(r.remaining, []);
  assert.equal(r.usd, 0.02);
  // a clean first draft costs one call
  prompts.length = 0;
  const once = await writeScript("x", async (q) => (prompts.push(q.prompt), { data: CLEAN, usage, usd: 0.01, estimate: false, model: "m", provider: "mock" }));
  assert.equal(prompts.length, 1);
  assert.equal(once.cliches.length, 0);
});

test("aspect from words: YouTube → 16:9, Shorts/Reels → 9:16 (YouTube Shorts stay vertical), square → 1:1; /make 16:9 тема", () => {
  const cases: [string, string | null][] = [
    ["почему кофе дорожает для ютуба", "16:9"],
    ["ролик для YouTube про кофе", "16:9"],
    ["горизонтальное видео про кофе", "16:9"],
    ["широкоформатный ролик", "16:9"],
    ["кофе 16:9", "16:9"],
    ["кофе для ютуб шортс", "9:16"],
    ["YouTube Shorts about coffee", "9:16"],
    ["рилс про кофе", "9:16"],
    ["для тиктока", "9:16"],
    ["вертикальное видео", "9:16"],
    ["9:16 кофе", "9:16"],
    ["квадратный ролик для ленты", "1:1"],
    ["почему кофе дорожает в 2026", null],
  ];
  for (const [t, want] of cases) assert.equal(detectAspect(t), want, t);
  assert.equal(stripAspectWords("почему кофе дорожает для ютуба"), "почему кофе дорожает");
  assert.equal(stripAspectWords("16:9 почему кофе дорожает"), "почему кофе дорожает");
  assert.deepEqual(parseMakeArgs("16:9 почему кофе дорожает"), { topic: "почему кофе дорожает", aspect: "16:9" });
  assert.deepEqual(parseMakeArgs("почему кофе дорожает для ютуба"), { topic: "почему кофе дорожает для ютуба", aspect: "16:9" });
  assert.deepEqual(parseMakeArgs("почему кофе дорожает"), { topic: "почему кофе дорожает", aspect: "9:16" });
  assert.deepEqual([frameFor("16:9").w, frameFor("16:9").h, frameFor("1:1").w, frameFor("9:16").h], [1920, 1080, 1080, 1920]);
});

// ---- photos (stubbed Openverse) ----

const JPEG = path.join(tmp, "photo.jpg");
await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=3000x2000:rate=1", "-frames:v", "1", "-q:v", "4", JPEG]);
const JPEG_BYTES = await fs.readFile(JPEG);

const OV = (o: Record<string, unknown>) => ({ id: "x", title: "Coffee cherries", creator: "Ann", creator_url: null, license: "by", license_version: "2.0", license_url: "https://creativecommons.org/licenses/by/2.0/", url: "https://img.example/x.jpg", foreign_landing_url: "https://flickr.example/x", provider: "flickr", source: "flickr", filetype: "jpg", filesize: null, width: 3000, height: 2000, mature: false, tags: [], ...o });

function stubFetch(results: Record<string, unknown[]>, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://api.openverse.org/v1/images/")) {
      const q = new URL(url).searchParams.get("q") ?? "";
      return new Response(JSON.stringify({ results: results[q] ?? [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.startsWith("https://img.example/")) return new Response(JPEG_BYTES, { status: 200, headers: { "content-type": "image/jpeg" } });
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

test("photos: ranking prefers CC0/PDM and the frame's shape; screenshots, graphics, tiny and panoramic results are rejected", () => {
  const f = frameFor("9:16");
  assert.equal(rejectReason(OV({ license: "by-nc" }) as never, f), "licence by-nc");
  assert.match(rejectReason(OV({ title: "Screenshot of a coffee app" }) as never, f)!, /not a photo/);
  assert.match(rejectReason(OV({ title: "Coffee price chart" }) as never, f)!, /not a photo/);
  assert.equal(rejectReason(OV({ title: "A photograph of coffee" }) as never, f), null, "«photograph» is not «graph»");
  assert.match(rejectReason(OV({ width: 800, height: 600 }) as never, f)!, /too small/);
  assert.match(rejectReason(OV({ width: 6000, height: 1500 }) as never, f)!, /aspect/);
  assert.match(rejectReason(OV({ filetype: "png", width: 1920, height: 1080 }) as never, frameFor("16:9"))!, /screenshot/);
  const ranked = rankPhotos([OV({ id: "cc0-other", license: "cc0", title: "Rock hyrax on a machine" }), OV({ id: "by-wide" }), OV({ id: "cc0-wide", license: "cc0", license_version: "1.0" })] as never, f, "coffee cherries");
  // stage 25: a result without half of the query words is dropped (it used to rank last and still win when alone)
  assert.deepEqual(ranked.map((r) => r.id), ["cc0-wide", "by-wide"], "relevant only, public domain over CC BY");
  const shape = rankPhotos([OV({ id: "by-wide" }), OV({ id: "by-tall", width: 2000, height: 3400 })] as never, f, "coffee cherries");
  assert.equal(shape[0].id, "by-tall", "the shape closer to 9:16 wins at equal relevance");
  assert.deepEqual(queryVariants("Coffee cherries harvest, Colombia!", "coffee"), ["coffee cherries harvest colombia", "coffee cherries harvest", "coffee cherries", "cherries harvest colombia", "cherries harvest"]);
  assert.equal(photoQuery("cinematic photograph of a coffee shop counter, warm light, 35mm"), "coffee shop counter");
});

test("photos: search → download → cover crop to the frame, one photo per beat, credits with licence; nothing found → missing", async () => {
  const calls: string[] = [];
  const fetchFn = stubFetch(
    {
      "coffee cherries": [OV({ id: "a", title: "Screenshot", license: "cc0" }), OV({ id: "b", license: "cc0", license_version: "1.0", title: "Coffee cherries", url: "https://img.example/b.jpg" }), OV({ id: "c", url: "https://img.example/c.jpg" })],
      "espresso machine": [OV({ id: "b", license: "cc0", url: "https://img.example/b.jpg" }), OV({ id: "d", title: "Espresso machine", creator: "Bob", url: "https://img.example/d.jpg" })],
    },
    calls,
  );
  const out = path.join(tmp, "ph");
  const r = await findPhotos([{ beat: 0, query: "coffee cherries" }, { beat: 2, query: "espresso machine" }, { beat: 3, query: "unicorn plantation" }], out, { frame: frameFor("16:9"), fetchFn, cacheDir: path.join(tmp, "phcache") });
  assert.deepEqual([...r.files.keys()], [0, 2]);
  assert.deepEqual(r.missing, [3]);
  assert.deepEqual(r.credits.map((c) => [c.beat, c.id, c.license]), [[0, "b", "cc0"], [2, "d", "by"]], "the same photo is never used twice");
  const v = (await ffprobe(r.files.get(2)!)).streams[0] as unknown as { width: number; height: number };
  assert.deepEqual([v.width, v.height], [1920, 1080]);
  assert.ok(calls.some((u) => /license=cc0%2Cpdm%2Cby|license=cc0,pdm,by/.test(u) && /mature=false/.test(u) && /page_size=20/.test(u)));
  const line = photoCreditLine(r.credits[1]);
  assert.match(line, /«Espresso machine» — Bob \(CC BY 2\.0, flickr\) https:\/\/flickr\.example\/x/);
  assert.match(creditsText({ photo_credits: r.credits.map(photoCreditLine), music_attribution: "" }), /^Фото: .*CC0.*CC BY 2\.0/);
  // stage 26: brand marks are credited too (licence of the path data + the trademark note)
  assert.match(creditsText({ photo_credits: [], music_attribution: "", brand_credits: ["Знак Anthropic: Simple Icons 16.30.0 (CC0-1.0)"] }), /^Знак Anthropic: Simple Icons/);
  // offline: nothing is fetched
  const off = await findPhotos([{ beat: 0, query: "coffee" }], out, { frame: frameFor("9:16"), offline: true, fetchFn: stubFetch({}, calls) });
  assert.deepEqual(off.missing, [0]);
});

// ---- composition ----

const script = ScriptSchema.parse({ ...CLEAN, beats: CLEAN.beats.map((b) => ({ ...b, seconds: 4 })) });
const scene = (o: Record<string, unknown>) => ({ accents: [], kicker: null, sub: null, number: null, items: null, image: null, entrance: "rise", ...o });
const RAWD = {
  identity: { palette: { bg: "#121212", bg2: "#1E1E1E", text: "#FFFFFF", accent: "#FFC93C", accent2: "#FF8A3D", muted: "#9A958C" }, display_font: "inter", accent_font: "playfair-italic", kicker_font: "mono", texture: "grain", image_style: "documentary", brand: "КОФЕ", music: "chill" },
  scenes: [
    scene({ beat: 0, layout: "media_number", headline: "Арабика на бирже ICE", number: { value: "301,88", unit: "¢" }, kicker: "ICE · ЦЕНЫ", image: { query: "coffee cherries", prompt: "coffee cherries", motion: "zoom_in" }, anchor: "bottom" }),
    scene({ beat: 1, layout: "media_full", headline: "Колумбия собрала на 15% меньше кофе", accents: [{ text: "15%", style: "marker" }], kicker: "КОЛУМБИЯ · УРОЖАЙ", image: { query: "coffee farm", prompt: "coffee farm", motion: "pan_left" }, anchor: "bottom", transition: "whip" }),
    scene({ beat: 2, layout: "statement", headline: "Кофе навынос в России — 233 рубля", anchor: "bottom", transition: "whip" }),
    scene({ beat: 3, layout: "list", headline: "Автоматы продают на 25% больше", items: ["128 рублей", "+25% продаж"], anchor: "top", transition: "zoom" }),
  ],
};

test("director: no header by default, generic kickers dropped, anchors and transitions varied", () => {
  const { design, notes } = normalizeDesign(RAWD, script);
  assert.equal(design.identity.chrome, "none");
  assert.deepEqual(design.scenes.map((s) => s.kicker), ["", "", "", ""], "«ICE · ЦЕНЫ»-style category labels are template noise");
  assert.ok(notes.some((n) => /убрана/.test(n)));
  for (let i = 1; i < design.scenes.length; i++) assert.notEqual(design.scenes[i].anchor, design.scenes[i - 1].anchor, `scene ${i} anchor differs`);
  assert.equal(design.scenes[0].transition, "cut");
  assert.equal(design.scenes[2].transition, "cut", "never the same move twice in a row");
  const allCut = varyComposition(design.scenes.map((s) => ({ ...s, transition: "cut" as const })));
  assert.equal(allCut.filter((s) => s.transition !== "cut").length, 1, "one move when the director gave only cuts");
  const html = composeScenes(script, design, { images: { 0: "assets/img/scene_0.jpg", 1: "assets/img/scene_1.jpg" }, fontFaces: "", gsapRel: "g.js" }).html;
  assert.ok(!/id="bg-bar"|class="ctr"|id="bg-brand"/.test(html), "no persistent header, counter or progress bar");
  assert.ok(!/id="bg-glow"/.test(html), "no generic glow unless the texture asks for it");
  assert.match(html, /class="clip scene L-media_number hook"/);
  assert.match(html, /class="clip scene L-statement"/);
  assert.match(html, /tl\.fromTo\("#sc1-in", \{ x: 486, filter: "blur\(18px\)" \}/, "whip into scene 1");
  assert.match(html, /tl\.fromTo\("#sc0-out", \{ x: 0, filter: "blur\(0px\)" \}/, "scene 0 whips out");
  assert.ok(!/tl\.fromTo\("#sc2-out"/.test(html) || /#sc2-out", \{ scale: 1, opacity: 1/.test(html));
  const withHeader = composeScenes(script, { ...design, identity: { ...design.identity, chrome: "header" } }, { images: {}, fontFaces: "", gsapRel: "g.js" }).html;
  assert.match(withHeader, /id="bg-bar"/);
  assert.match(withHeader, /class="ctr" id="sc0-ctr">01 \/ 04</);
});

test("narration-timed words: each headline word appears when it is spoken (stems match, the rest interpolated)", () => {
  const sp = { start: 1, end: 4, words: ["Четырнадцатого", "октября", "арабика", "на", "бирже", "ICE", "стоила", "почти", "триста"].map((w, k) => ({ text: w, start: 1 + k * 0.3, end: 1.3 + k * 0.3 })) };
  const al = alignWords(["Арабика", "на", "бирже", "ICE", "—", "301,88", "цента"], sp);
  assert.deepEqual(al.matched, [true, false, true, true, false, false, false]);
  assert.equal(al.times[0], 1.6, "«Арабика» at «арабика»");
  assert.equal(al.times[2], 2.2);
  assert.equal(al.times[3], 2.5);
  assert.ok(al.times[1] > al.times[0] && al.times[1] < al.times[2], "unmatched word interpolated");
  for (let i = 1; i < al.times.length; i++) assert.ok(al.times[i] > al.times[i - 1]);
  const none = alignWords(["Совсем", "другие", "слова"], sp);
  assert.ok(none.times[0] === 1 && none.times[2] < 4, "no match: spread over the speech");

  const { design } = normalizeDesign(RAWD, script);
  const speech = [{ start: 0.25, end: 3.2, words: sp.words.map((w) => ({ ...w, start: w.start - 0.75, end: w.end - 0.75 })) }, null, null, null];
  const html = composeScenes(script, design, { images: { 0: "a.jpg", 1: "b.jpg" }, fontFaces: "", gsapRel: "g.js", speech }).html;
  // the first word lands on the cut (never an empty frame), the next ones when they are said (60 ms early)
  assert.match(html, /tl\.fromTo\("#sc0-hl-w0", \{ opacity: 0, y: 34 \}, \{ opacity: 1, y: 0, duration: 0\.34, ease: "power3\.out" \}, 0\.5\);/, "media_number words start at 0.4 + 0.1");
  assert.match(html, /tl\.fromTo\("#sc0-hl-w2", [^;]+, 1\.39\);/, "«бирже» at 1.45 − 0.06");
  assert.match(html, /tl\.fromTo\("#sc0-hl-w3", [^;]+, 1\.69\);/, "«ICE» at 1.75 − 0.06");
  assert.ok(!/tl\.fromTo\("#sc0-hl-w0, #sc0-hl-w1/.test(html), "no blanket stagger on a voiced beat");
  assert.match(html, /tl\.fromTo\("#sc1-hl-w0, #sc1-hl-w1/, "a beat without speech keeps the stagger");
  // a word the narrator says only at the very end still lands by 70% of the beat (the line must be readable)
  const late = [{ start: 0.25, end: 3.9, words: ["Это", "сказано", "в", "самом", "конце", "арабика"].map((w, k) => ({ text: w, start: 0.25 + k * 0.7, end: 0.9 + k * 0.7 })) }, null, null, null];
  const lateHtml = composeScenes(script, design, { images: { 0: "a.jpg", 1: "b.jpg" }, fontFaces: "", gsapRel: "g.js", speech: late }).html;
  const lastAt = Number(/tl\.fromTo\("#sc0-hl-w3", [^;]+, ([\d.]+)\);/.exec(lateHtml)![1]);
  assert.ok(lastAt <= 0.7 * 4 + 1e-9, `last word at ${lastAt}`);
  // a big number is not repeated in the headline under it
  assert.equal(dropRepeatedNumber({ ...design.scenes[0], layout: "media_number", headline: "Арабика: $7500 за тонну", number: { value: "$7500", unit: "за тонну" } }).headline, "Арабика");
  assert.equal(dropRepeatedNumber({ ...design.scenes[0], layout: "hero_number", headline: "Зерно в России: +80% за два года", number: { value: "+80%", unit: "" } }).headline, "Зерно в России за два года");
  assert.equal(dropRepeatedNumber({ ...design.scenes[0], layout: "hero_number", headline: "+80%", number: { value: "+80%", unit: "" } }).headline, "+80%", "nothing left → unchanged");
  // word times from sentence times
  const words = speechWords([{ line: 0, text: "Цена 2026 года", start: 0, end: 3 }], [0], [10]);
  assert.equal(words.length, 3);
  assert.equal(words[0].start, 10);
  assert.ok(words[1].end - words[1].start > words[0].end - words[0].start, "«2026» is long when spoken");
  assert.ok(Math.abs(words[2].end - 13) < 0.002);
  const byBeat = speechByBeat({ beats: [{ beat: 0, start: 10, end: 13, text: "" }], words }, 2);
  assert.equal(byBeat[0]!.words.length, 3);
  assert.equal(byBeat[1], null);
});

test("16:9 and 1:1: frames, layouts and 3D scenes compose for the frame; landscape fitted in Chrome lints clean", async (t) => {
  const { design } = normalizeDesign(
    {
      ...RAWD,
      scenes: [
        scene({ beat: 0, layout: "orbit_title", headline: "Кофе по 301 центу", anchor: "center" }),
        scene({ beat: 1, layout: "depth_cards", headline: "Почему так дорого", items: ["Колумбия −15%", "Эль-Ниньо", "Экспорт −12%"] }),
        scene({ beat: 2, layout: "tunnel_number", headline: "мешков собрала Бразилия", number: { value: "67,6", unit: "млн" } }),
        scene({ beat: 3, layout: "media_split", headline: "Автоматы продают на 25% больше", image: { query: "vending machine coffee", prompt: "vending", motion: "zoom_in" } }),
      ],
    },
    script,
  );
  for (const [aspect, w, h, res] of [["16:9", 1920, 1080, "landscape"], ["1:1", 1080, 1080, "square"]] as const) {
    const html = composeScenes(script, design, { images: { 3: "assets/img/scene_3.jpg" }, fontFaces: "", gsapRel: "g.js", frame: frameFor(aspect) }).html;
    assert.match(html, new RegExp(`data-width="${w}"`));
    assert.match(html, new RegExp(`data-height="${h}"`));
    assert.match(html, new RegExp(`data-resolution="${res}"`));
    assert.match(html, new RegExp(`html, body \\{ margin: 0; width: ${w}px; height: ${h}px;`));
  }
  if (!(await findHeadlessChrome())) return t.skip("no headless Chrome in ~/.cache/puppeteer");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-169-"));
  const img = path.join(tmp, "land.jpg");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=1", "-frames:v", "1", img]);
  const r = await writeDirectorProject(script, design, { 3: img }, dir, { frame: frameFor("16:9") });
  assert.deepEqual(r.overflow, [], "every text fits its landscape box");
  const lay = JSON.parse(await fs.readFile(path.join(dir, "layout.json"), "utf8")) as { frame: { width: number; height: number; aspect: string } };
  assert.deepEqual([lay.frame.width, lay.frame.height, lay.frame.aspect], [1920, 1080, "16:9"]);
  const lint = await runCli(HF_BIN, ["lint", "--json"], dir);
  const parsed = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{"))) as { errorCount: number; findings?: { rule?: string; code?: string }[] };
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
  assert.deepEqual((parsed.findings ?? []).filter((f) => /gsap/.test(f.rule ?? f.code ?? "")), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test("Piper narration is livelier: 0.92 tempo, more noise, per-sentence variation (questions slower)", async () => {
  const a = sentenceParams("Цена выросла.", 0, 0.92, { vary: true, noiseW: 0.9, noiseScale: 0.72 });
  const b = sentenceParams("Цена выросла.", 1, 0.92, { vary: true, noiseW: 0.9, noiseScale: 0.72 });
  const q = sentenceParams("Почему?", 0, 0.92, { vary: true, noiseW: 0.9 });
  assert.equal(a.lengthScale, 0.92);
  assert.ok(b.lengthScale < a.lengthScale && q.lengthScale > a.lengthScale);
  assert.notEqual(a.noiseW, b.noiseW);
  assert.deepEqual(sentenceParams("x", 3, 1, {}), { lengthScale: 1, noiseScale: undefined, noiseW: undefined }, "flat when not asked");
  const seen: { lengthScale: number; noiseScale?: number; noiseW?: number }[] = [];
  const synth: SentenceSynth = async (text, _v, o) => (seen.push(o), { pcm: new Int16Array(Math.round(22050 * 0.05 * text.length)).fill(3000), rate: 22050 });
  const vo = await makeVoiceover(script, "denis", path.join(tmp, "vo"), { synth });
  assert.equal(seen[0].lengthScale, NARRATION.lengthScale);
  assert.equal(seen[0].noiseScale, NARRATION.noiseScale);
  assert.ok(new Set(seen.map((s) => s.lengthScale)).size > 1, "tempo varies across sentences");
  assert.ok(vo.words.length > 20 && vo.words.every((w) => w.end > w.start));
  assert.ok(vo.words.filter((w) => w.beat === 1).every((w) => w.start >= vo.beats[1].start - 1e-6 && w.end <= vo.beats[1].end + 1e-3));
});

test("make --aspect 16:9 with photos: script, director, Openverse photos (stub), landscape project, credits in the report", async () => {
  const design = { ...RAWD, scenes: RAWD.scenes.map((s) => ({ ...s, kicker: null })) };
  const llm: StructuredFn = async (q) => ({ data: /art director/.test(q.system) ? design : CLEAN, usage, usd: 0.01, estimate: false, model: "mock", provider: "mock" });
  const calls: string[] = [];
  const fetchFn = stubFetch({ "coffee cherries": [OV({ id: "p1", license: "cc0", url: "https://img.example/p1.jpg" })], "coffee farm": [OV({ id: "p2", url: "https://img.example/p2.jpg" })] }, calls);
  let projectHtml = "";
  const r = await make("почему кофе дорожает для ютуба", {
    llm,
    trends: false,
    music: "none",
    photoOptions: { fetchFn, cacheDir: path.join(tmp, "mkcache") },
    imageOptions: { generate: async () => {} },
    fakeRender: async (projectDir, out) => {
      projectHtml = await fs.readFile(path.join(projectDir, "index.html"), "utf8");
      await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=480x270:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    },
  });
  assert.equal(r.aspect, "16:9");
  assert.deepEqual([r.width, r.height], [1920, 1080]);
  assert.equal(r.topic, "почему кофе дорожает", "format words are not part of the topic");
  assert.equal(r.images, "photo");
  assert.equal(r.photo_credits.length, 2);
  assert.match(r.photo_credits[1], /CC BY 2\.0/);
  assert.match(projectHtml, /data-width="1920"/);
  assert.match(projectHtml, /src="assets\/img\/scene_0\.jpg"/);
  const credits = JSON.parse(await fs.readFile(path.join(jobDir(r.jobId), "credits.json"), "utf8")) as { beat: number; license: string }[];
  assert.deepEqual(credits.map((c) => [c.beat, c.license]), [[0, "cc0"], [1, "by"]]);
  const crop = (await ffprobe(path.join(jobDir(r.jobId), "make", "images", "scene_1.jpg"))).streams[0] as unknown as { width: number; height: number };
  assert.deepEqual([crop.width, crop.height], [1920, 1080]);
  assert.equal(r.cliches_fixed, 0);
});
