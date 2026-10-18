import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Stage 25, offline: the pronunciation layer (brands, Latin, numbers with case agreement), the one-take narration
 * split, the speech score, pacing/hook constraints of the script, cuts on the music's beats, the anti-template design
 * rules and the living background of the composition.
 */
const { pronounce, pronounceRu, transliterate, spellLetters, applyStress, scoreSpeech, canonicalWords, hardTerms, loadPronounceDict } = await import("../src/voice/pronounce.ts");
const { normalizeRu, cardinal, caseBefore, splitSentences, ordinalToWords } = await import("../src/voice/normalize.ts");
const { splitTake, findPauses } = await import("../src/voice/take.ts");
const { synthesize, wavBytes } = await import("../src/voice/piper.ts");
const { snapBeatsToMusic, fitBeatsToSpeech, HOOK_LEAD, leadOf } = await import("../src/voice/voiceover.ts");
const { pacingFindings, narrationBudget, factWithin, ScriptSchema, HOOK_MAX_WORDS } = await import("../src/make/script.ts");
const { normalizeDesign, varyComposition } = await import("../src/make/design.ts");
const { composeScenes } = await import("../src/make/scenes.ts");
const { accentCues } = await import("../src/make/index.ts");
const { resetGeminiState } = await import("../src/voice/gemini.ts");

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s25-"));

test("pronunciation dictionary: brands and terms the way a Russian narrator says them, endings kept", () => {
  const p = (s: string) => pronounceRu(s, { expandAcronyms: false });
  assert.equal(p("OpenAI"), "Оупен Эй-Ай");
  assert.equal(p("Anthropic и Claude"), "Антропик и Клод");
  assert.equal(p("ChatGPT"), "Чат Джи-Пи-Ти");
  assert.equal(p("GPT-5"), "Джи-Пи-Ти пять");
  assert.equal(p("GPT-4o"), "Джи-Пи-Ти четыре о");
  assert.equal(p("Nvidia и Microsoft"), "Энвидиа и Майкрософт");
  assert.equal(p("iPhone"), "Айфон");
  assert.equal(p("API"), "Эй-Пи-Ай");
  assert.equal(p("AI"), "Эй-Ай");
  assert.equal(p("IPO"), "Ай-Пи-О");
  assert.equal(p("Thrive Capital"), "Трайв Кэпитал");
  assert.equal(p("YouTube и TikTok"), "Ютуб и Тик-Ток");
  assert.equal(p("у Google'а"), "у Гугла", "a Russian ending glued with an apostrophe stays");
  assert.equal(p("Модель Claude 3.5 Sonnet"), "Модель Клод три точка пять Соннет", "a dotted version next to a Latin name is a version, not «три с половиной»");
  assert.equal(p("A100 и H100"), "Эй сто и Эйч сто");
  // unknown acronyms letter by letter, unknown words transliterated
  assert.equal(p("SDK"), "Эс-ди-кей");
  assert.equal(spellLetters("CLI"), "Си-эл-ай");
  assert.equal(transliterate("Thrive"), "Трайв");
  assert.equal(transliterate("Robinhood"), "Робинхуд");
  assert.equal(transliterate("Palantir"), "Палантир");
  // the multiplier and the quarter are numbers, not Latin
  assert.equal(p("Рост ×3 в Q3"), "Рост в три раза в третьем квартале");
  // «ИИ-кодинг» is «И-И кодинг»; standalone «ИИ» is expanded for Piper, kept for Gemini
  assert.equal(pronounceRu("рынок ИИ-кодинга"), "рынок И-И кодинга");
  assert.equal(pronounceRu("ИИ меняет рынок"), "искусственный интеллект меняет рынок");
  assert.equal(p("ИИ меняет рынок"), "ИИ меняет рынок");
  // a user dictionary wins
  assert.equal(pronounceRu("Uzum Market", { extra: { "Uzum Market": "Узум Маркет" } }), "Узум Маркет");
  assert.ok(Object.keys(loadPronounceDict().terms).length >= 100, "the shipped dictionary is loaded");
});

test("numbers: money, percentages, years, quarters, ranges and units with case agreement", () => {
  const ru = (s: string) => normalizeRu(s);
  assert.equal(ru("$3,7 млрд"), "три и семь десятых миллиарда долларов");
  assert.equal(ru("157 миллиардов долларов"), "сто пятьдесят семь миллиардов долларов");
  assert.match(ru("Выручка в 2024 выросла"), /^Выручка в две тысячи двадцать четвёртом году выросла$/);
  assert.equal(ru("в 2024-м"), "в две тысячи двадцать четвёртом");
  assert.equal(ru("к концу 2025-го"), "к концу две тысячи двадцать пятого");
  assert.equal(ru("Q3"), "третий квартал");
  assert.equal(ru("в Q3 2025"), "в третьем квартале две тысячи двадцать пятого года");
  assert.equal(ru("×3"), "в три раза");
  assert.equal(ru("+45%"), "плюс сорок пять процентов");
  assert.equal(ru("−12%"), "минус двенадцать процентов");
  assert.equal(ru("от 400 млн до 4,6 млрд"), "от четырёхсот миллионов до четырёх и шести десятых миллиарда");
  assert.equal(ru("с примерно 400 млн до почти 4,6 млрд"), "с примерно четырёхсот миллионов до почти четырёх и шести десятых миллиарда");
  assert.equal(ru("40–50% рынка"), "от сорока до пятидесяти процентов рынка");
  assert.equal(ru("в 2–3 раза"), "в два-три раза");
  assert.equal(ru("в 3,5 раза"), "в три с половиной раза");
  assert.equal(ru("до $157 млрд"), "до ста пятидесяти семи миллиардов долларов");
  assert.equal(ru("более 1,5 млрд"), "более полутора миллиардов");
  assert.equal(ru("к 21 миллиону"), "к двадцати одному миллиону");
  assert.equal(ru("0,5%"), "половина процента");
  assert.equal(ru("в 1990-х"), "в тысяча девятьсот девяностых");
  assert.equal(ru("от 2000 рублей"), "от двух тысяч рублей", "a number after «от» is not a year when a noun follows");
  assert.equal(ru("с 2024 до 2026"), "с две тысячи двадцать четвёртого до две тысячи двадцать шестого года");
  assert.equal(ru("18 октября 2026 года"), "восемнадцатое октября две тысячи двадцать шестого года");
  assert.equal(ru("в 10:30"), "в десять тридцать");
  // building blocks
  assert.equal(cardinal(400_000_000, "gen"), "четырёхсот миллионов");
  assert.equal(cardinal(21, "dat"), "двадцати одному");
  assert.equal(cardinal(578, "inst"), "пятьюстами семьюдесятью восемью");
  assert.equal(cardinal(2, "prep", "f"), "двух");
  assert.equal(ordinalToWords(3, "gen"), "третьего");
  assert.equal(ordinalToWords(90, "pl"), "девяностые");
  assert.equal(caseBefore("выросла с примерно 400 до 600", "выросла с примерно ".length), "gen");
  assert.equal(caseBefore("работает с 5 сотрудниками", "работает с ".length), "nom");
  // «3.5» is not a sentence end; «т.е.» before a lowercase word is not either
  assert.deepEqual(splitSentences("Модель 3.5 Sonnet быстрая. Т.е. всё."), ["Модель 3.5 Sonnet быстрая.", "Т.е. всё."]);
});

test("pronounce: language guard, stress marks only on request", () => {
  assert.equal(pronounce("Revenue grew 30% in a year, and margins too", "ru"), "Revenue grew 30 percent in a year, and margins too", "a Latin-script line is not run through Russian rules");
  assert.equal(pronounce("Narx 30% oshdi va bu muhim", "uz"), "Narx 30% oshdi va bu muhim");
  const stress = { квартал: "кварта́л" };
  assert.equal(applyStress("Квартал и квартал", stress), "Кварта́л и кварта́л");
  assert.equal(pronounceRu("третий квартал", { stress: true, dict: { terms: {}, stress } }), "третий кварта́л");
  assert.equal(pronounceRu("третий квартал", { dict: { terms: {}, stress } }), "третий квартал", "no marks by default (Gemini honoured 1 of 5 in the stage-25 test)");
});

test("speech score: canonical spoken forms on both sides, hard terms found in a transcript", () => {
  assert.deepEqual(hardTerms("OpenAI оценили в $157 млрд, а Thrive Capital вложил 1,2 млрд."), ["OpenAI", "$157 млрд", "Thrive Capital", "1,2 млрд"]);
  assert.deepEqual(canonicalWords("OpenAI — $3,7 млрд"), ["оупен", "эй", "ай", "три", "и", "семь", "десятых", "миллиарда", "долларов"]);
  const good = scoreSpeech("OpenAI оценили в 157 миллиардов долларов.", "Опен Эйай оценили в 157 миллиардов долларов");
  assert.equal(good.termHits, good.terms.length);
  assert.ok(good.wer <= 0.2, String(good.wer));
  const bad = scoreSpeech("Выручка Anthropic выросла.", "Выручка Энсропик выросла");
  assert.equal(bad.terms[0].hit, false, "«Энсропик» is not «Антропик»");
  const version = scoreSpeech("Модель 3.5 Sonnet лучше.", "Модель 3.5 Sonnet лучше.");
  assert.equal(version.termHits, version.terms.length, "a term keeps its in-sentence reading (version, not decimal)");
});

/** n s of a 220 Hz tone, then `gap` s of silence */
function speechLike(parts: { tone: number; gap: number }[], rate = 24000): Int16Array {
  const total = parts.reduce((n, p) => n + Math.round((p.tone + p.gap) * rate), 0);
  const a = new Int16Array(total);
  let at = 0;
  for (const p of parts) {
    const n = Math.round(p.tone * rate);
    for (let i = 0; i < n; i++) a[at + i] = Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate));
    at += n + Math.round(p.gap * rate);
  }
  return a;
}

test("one-take split: paragraph cuts found among sentence and comma pauses", () => {
  // P1: two sentences (2.0 s, comma pause 0.15, 1.4 s), P2: one sentence 2.5 s, P3: two sentences
  const pcm = speechLike([
    { tone: 1.0, gap: 0.15 }, // comma
    { tone: 1.0, gap: 0.32 }, // sentence end inside P1
    { tone: 1.4, gap: 0.55 }, // paragraph P1 | P2
    { tone: 2.5, gap: 0.52 }, // paragraph P2 | P3
    { tone: 1.6, gap: 0.3 }, // sentence inside P3
    { tone: 1.2, gap: 0.05 },
  ]);
  assert.ok(findPauses(pcm, 24000).length >= 5);
  const spans = splitTake(pcm, 24000, [[20, 14], [25], [16, 12]]);
  assert.ok(spans, "a plausible split");
  const cuts = spans!.slice(0, -1).map((s) => s.end);
  assert.ok(Math.abs(cuts[0] - (1.0 + 0.15 + 1.0 + 0.32 + 1.4 + 0.275)) < 0.12, `cut 1 at ${cuts[0]}`);
  assert.ok(Math.abs(cuts[1] - (1.0 + 0.15 + 1.0 + 0.32 + 1.4 + 0.55 + 2.5 + 0.26)) < 0.12, `cut 2 at ${cuts[1]}`);
  // a take without pauses cannot be split
  assert.equal(splitTake(speechLike([{ tone: 6, gap: 0 }]), 24000, [[10], [10]]), null);
});

test("synthesize with a Gemini voice: the whole narration in ONE request, cut back into lines at the paragraph pauses", async () => {
  resetGeminiState();
  delete process.env.VEDIT_GEMINI_TTS_API;
  const calls: { text: string; style: string }[] = [];
  const fetchFn = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const text: string = body.input[0].content[0].text;
    calls.push({ text, style: body.input[0].content[0].annotations?.[0]?.style ?? "" });
    // one tone per paragraph, sentences separated by short pauses, paragraphs by long ones
    const paras = text.split("\n\n").map((p) => p.split(/(?<=[.!?])\s+/));
    const parts = paras.flatMap((sents, k) => sents.map((s, j) => ({ tone: 0.3 + s.length / 25, gap: j === sents.length - 1 ? (k === paras.length - 1 ? 0.05 : 0.6) : 0.25 })));
    const wav = wavBytes(speechLike(parts), 24000).toString("base64");
    return new Response(JSON.stringify({ steps: [{ type: "model_output", content: [{ type: "audio", mime_type: "audio/wav", data: wav }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const lines = ["OpenAI оценили в $157 млрд. Это рекорд.", "", "Anthropic растёт быстрее: в 11 раз за год.", "Nvidia продаёт чипы обоим."];
  const r = await synthesize(lines, "gemini_charon", path.join(tmp, "take.wav"), { gemini: { key: "k", fetch: fetchFn, cacheDir: null, sleep: async () => {} } });
  assert.equal(calls.length, 1, "one request for the whole narration");
  assert.match(calls[0].text, /^Оупен Эй-Ай оценили в сто пятьдесят семь миллиардов долларов\. Это рекорд\.\n\nАнтропик растёт быстрее: в одиннадцать раз за год\.\n\nЭнвидиа продаёт чипы обоим\.$/);
  assert.match(calls[0].style, /news explainer.*pause between paragraphs/);
  assert.equal(r.clips.length, 4);
  assert.equal(r.clips[1].pcm.length, 0, "an empty line stays empty");
  const secs = r.clips.map((c) => c.pcm.length / c.rate);
  assert.ok(secs[0] > 3.3 && secs[0] < 4.2, `line 1: ${secs[0]}`);
  assert.ok(secs[2] > 1.9 && secs[2] < 2.7, `line 3: ${secs[2]}`);
  assert.ok(secs[3] > 1.0 && secs[3] < 1.8, `line 4: ${secs[3]}`);
});

const mk = (beats: { text: string; voiceover?: string; seconds?: number }[]) => ScriptSchema.parse({ title: "t", language: "ru", beats: beats.map((b) => ({ seconds: 4, ...b })) });

test("script pacing: the hook is short and states its fact first; the narration fits its word budget", () => {
  assert.equal(narrationBudget(40, 7), 111);
  assert.ok(factWithin("157 миллиардов за компанию без прибыли", 5));
  assert.ok(factWithin("Сто пятьдесят семь миллиардов за OpenAI", 5));
  assert.ok(factWithin("Компания OpenAI стоит больше Boeing", 5));
  assert.ok(!factWithin("В октябре прошлого года компанию оценили в сто миллиардов", 5));
  const long = "В октябре две тысячи двадцать четвёртого OpenAI оценили в сто пятьдесят семь миллиардов долларов, когда компания закрыла раунд.";
  const rest = Array.from({ length: 6 }, () => ({ text: "Выручка выросла в три раза", voiceover: "Выручка выросла с трёх и семи десятых миллиарда в прошлом году до тринадцати с лишним миллиардов к концу этого года, но расходы огромные." }));
  const f = pacingFindings(mk([{ text: "OpenAI оценили в 157 миллиардов долларов в октябре", voiceover: long }, ...rest]), 40);
  const rules = new Set(f.map((x) => x.rule));
  for (const r of ["hook_text_long", "hook_long", "beat_long", "narration_long"]) assert.ok(rules.has(r), `${r}: ${[...rules].join(",")}`);
  const ok = pacingFindings(mk([{ text: "OpenAI: $157 млрд", voiceover: "Сто пятьдесят семь миллиардов долларов стоит OpenAI." }, ...rest.map(() => ({ text: "Выручка выросла втрое", voiceover: "За год выручка выросла втрое, до тринадцати миллиардов." }))]), 40);
  assert.deepEqual(ok, []);
  assert.ok(HOOK_MAX_WORDS <= 10);
  // a script without narration is only checked for its on-screen hook
  assert.deepEqual(pacingFindings(mk([{ text: "Кофе +40%" }, { text: "b" }, { text: "c" }]), 35), []);
});

test("cuts on the music: scene boundaries move onto beats without cutting into the speech", () => {
  const script = mk([{ text: "a", voiceover: "x" }, { text: "b", voiceover: "y" }, { text: "c", voiceover: "z" }]);
  const speech = [1.6, 3.0, 2.0];
  const fitted = fitBeatsToSpeech(script, speech);
  assert.ok(Math.abs(fitted.beats[0].seconds - (HOOK_LEAD + 1.6 + 0.35)) < 0.04, "the hook speaks at once");
  assert.equal(leadOf(0), HOOK_LEAD);
  // beats every 0.5 s: the first cut (≈2.0 s) lands on 2.0, the second (≈2.0 + 3.6 = 5.6) on 5.5 or 6.0
  const beats = Array.from({ length: 30 }, (_, k) => k * 0.5);
  const { script: snapped, snapped: n } = snapBeatsToMusic(fitted, speech, beats);
  assert.equal(n, 2);
  let t = 0;
  for (let i = 0; i < 2; i++) {
    t += snapped.beats[i].seconds;
    assert.ok(Math.abs(t * 2 - Math.round(t * 2)) < 0.04, `cut ${i} at ${t} is on a beat`);
  }
  assert.ok(snapped.beats[0].seconds >= HOOK_LEAD + speech[0] + 0.12 - 1e-9, "never shorter than the speech");
  // no beat near a cut: left alone
  assert.equal(snapBeatsToMusic(fitted, speech, [100]).snapped, 0);
});

test("design: every typographic device once; the second scene is a pattern interrupt; accents on the interrupt and the payoff", () => {
  const script = mk(Array.from({ length: 5 }, (_, i) => ({ text: `Бит ${i} про OpenAI`, voiceover: `Бит ${i}.` })));
  const scene = (b: number, layout: string, extra: Record<string, unknown> = {}) => ({ beat: b, layout, headline: `Бит ${b} про OpenAI`, accents: [], kicker: null, sub: null, number: null, items: ["Один", "Два", "Три"], image: null, entrance: "rise", anchor: "center", transition: "cut", ...extra });
  const raw = {
    identity: { palette: { bg: "#0D0D0F", bg2: "#1A1A1F", text: "#F5F3EE", accent: "#FFD23F", accent2: "#D97757", muted: "#8A8A92" }, display_font: "inter", accent_font: "inter", kicker_font: "mono", texture: "grid", image_style: "x", brand: "b", music: "tech", chrome: "none" },
    scenes: [scene(0, "hero_number", { number: { value: "$157", unit: "млрд" } }), scene(1, "list"), scene(2, "statement"), scene(3, "list"), scene(4, "statement")],
  };
  const { design } = normalizeDesign(raw, script);
  const layouts = design.scenes.map((s) => s.layout);
  assert.equal(layouts.filter((l) => l === "list").length, 1, layouts.join(","));
  assert.equal(layouts.filter((l) => l === "statement").length, 1, layouts.join(","));
  assert.notEqual(design.scenes[1].transition, "cut");
  assert.equal(design.scenes[0].transition, "cut");
  const scenes = varyComposition(design.scenes.map((s) => ({ ...s, transition: "cut" as const })));
  assert.ok(["whip", "zoom"].includes(scenes[1].transition));
  // sound accents: riser + hit into scene 2 and into the last scene
  const cues = accentCues(mk([{ text: "a", seconds: 2.5 }, { text: "b", seconds: 4 }, { text: "c", seconds: 4 }, { text: "d", seconds: 4 }]));
  assert.deepEqual(cues.map((c) => c.kind), ["riser", "impact", "riser", "impact"]);
  assert.equal(cues[1].t, 2.5);
  assert.equal(cues[3].t, 10.5);

  // the composition: a living background (two drifting colour fields, crawling grid), a hook punch-in with a flash
  const c = composeScenes(script, design, { images: {}, fontFaces: "", gsapRel: "g.js" });
  assert.match(c.html, /id="bg-a"[\s\S]*id="bg-b"/);
  assert.match(c.html, /tl\.fromTo\("#bg-a", \{ x: 0, y: 0 \}/);
  assert.match(c.html, /tl\.fromTo\("#bg-tex", \{ backgroundPosition: "0px 0px" \}/);
  assert.match(c.html, /tl\.fromTo\("#sc0-out", \{ scale: 1\.18, filter: "blur\(10px\)" \}/);
  assert.match(c.html, /id="sc0-flash"/);
  assert.match(c.html, /id="sc1-flash"/);
  if (layouts.includes("statement")) assert.match(c.html, /-sweep", \{ backgroundPosition: "130% 0%" \}/);
});

test("photos: officials and public figures are never picked (the director never searches for real people)", async () => {
  const { rejectReason, creditRejected } = await import("../src/make/photos.ts");
  const { frameFor } = await import("../src/lib/aspect.ts");
  const f = frameFor("9:16");
  const r = (title: string) => rejectReason({ id: "x", title, license: "by", url: "u", width: 3000, height: 4000, filetype: "jpg", tags: [] } as never, f);
  assert.match(r("Ukrainian President Volodymyr Zelenskyy meets with Italian Prime Minister Giuseppe Conte") ?? "", /public figure/);
  assert.match(r("Trump at the summit") ?? "", /public figure/);
  assert.equal(r("Business people at a meeting table"), null);
  assert.ok(creditRejected({ title: "Prime Minister visits a factory" }));
});

test("one-take split by words: whisper's word times decide the paragraph boundaries (no pause between paragraphs)", async () => {
  const { cutsFromWords, spansFromCuts, alignTake } = await import("../src/voice/align.ts");
  const paras = ["В марте Оупен Эй-Ай привлекла сто двадцать два миллиарда при оценке в восемьсот пятьдесят два.", "Причина в выручке: тринадцать миллиардов за прошлый год."];
  // whisper writes digits and Latin; the paragraphs run together, the only pause is at the colon
  const words = [
    ["В", 0.0, 0.2], ["марте", 0.2, 0.5], ["OpenAI", 0.5, 1.1], ["привлекла", 1.1, 1.6], ["122", 1.6, 2.6], ["миллиарда", 2.6, 3.1], ["при", 3.1, 3.3], ["оценке", 3.3, 3.7], ["в", 3.7, 3.8], ["852.", 3.8, 4.9],
    ["Причина", 4.9, 5.3], ["в", 5.3, 5.4], ["выручке", 5.4, 5.9], ["13", 6.4, 6.9], ["миллиардов", 6.9, 7.4], ["за", 7.4, 7.5], ["прошлый", 7.5, 7.9], ["год.", 7.9, 8.2],
  ].map(([w, start, end]) => ({ w: w as string, start: start as number, end: end as number }));
  const cuts = cutsFromWords(paras, words);
  assert.ok(cuts && Math.abs(cuts[0] - 4.9) < 0.01, JSON.stringify(cuts));
  assert.equal(cutsFromWords(paras, words.slice(0, 5)), null, "a boundary that was not heard: no answer");
  // a cut snaps to a pause nearby, never to a far one
  const pcm = speechLike([{ tone: 4.85, gap: 0.12 }, { tone: 1.0, gap: 0.5 }, { tone: 2.0, gap: 0 }]);
  const spans = spansFromCuts([4.9], pcm, 24000);
  assert.ok(Math.abs(spans[0].end - 4.91) < 0.03, `snapped to the 0.12 s pause: ${spans[0].end}`);
  assert.ok(Math.abs(spansFromCuts([3.0], pcm, 24000)[0].end - 3.0) < 1e-9, "no pause within 0.3 s: the word cut stays");
  // alignTake with an injected word timer
  const r = await alignTake(pcm, 24000, paras, { words: async () => words });
  assert.ok(r && r.length === 2 && Math.abs(r[0].end - 4.91) < 0.03);
});

test("presenter: a VP9-alpha circle in the bottom corner, bottom-anchored text moves up", async () => {
  const { presenterBox, presenterClip } = await import("../src/make/presenter.ts");
  const { frameFor } = await import("../src/lib/aspect.ts");
  const { ffmpeg, ffprobe } = await import("../src/lib/ffmpeg.ts");
  const f = frameFor("9:16");
  const box = presenterBox(f);
  assert.ok(box.size > 300 && box.size < 600 && box.bottom >= f.h - f.safe.bottom, JSON.stringify(box));
  // a 2 s source → a 3 s clip (last frame held), alpha kept
  const src = path.join(tmp, "face.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=320x240:d=2:r=25", "-pix_fmt", "yuv420p", src]);
  const out = path.join(tmp, "pres.webm");
  const { drift } = await presenterClip(src, 3, out, 200);
  assert.equal(drift, 1);
  const p = await ffprobe(out);
  const v = p.streams.find((s) => s.codec_type === "video")!;
  assert.equal(v.codec_name, "vp9");
  assert.equal(v.width, 200);
  assert.equal(v.tags?.alpha_mode ?? v.tags?.ALPHA_MODE, "1");
  assert.ok(Math.abs(Number(p.format.duration) - 3) < 0.1);
  // composition
  const script = mk([{ text: "Хук 1", voiceover: "a" }, { text: "Второй", voiceover: "b" }, { text: "Третий", voiceover: "c" }]);
  const design = (await import("../src/make/design.ts")).fallbackDesign(script);
  design.scenes.forEach((s) => (s.anchor = "bottom"));
  const c = composeScenes(script, design, { images: {}, fontFaces: "", gsapRel: "g.js", presenter: { src: "assets/presenter.webm", box } });
  assert.match(c.html, /<video id="presenter" src="assets\/presenter\.webm" data-start="0" data-duration="[\d.]+" data-track-index="3" muted playsinline><\/video>/);
  assert.match(c.html, /id="pres-ring"/);
  assert.doesNotMatch(c.html, /class="in a-bottom"/, "no text block sits at the bottom under the presenter");
  const plain = composeScenes(script, design, { images: {}, fontFaces: "", gsapRel: "g.js" });
  assert.doesNotMatch(plain.html, /id="presenter"/);
});
