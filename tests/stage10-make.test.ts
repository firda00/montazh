import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-ws-"));

const { beatSeconds, beatsFor, normalizeScript, writeScript, scriptDuration, ScriptSchema } = await import("../src/make/script.ts");
const { composeMake, fitSentence, timeBeats } = await import("../src/make/compose.ts");
const { loadIconSvg } = await import("../src/make/icons.ts");
const { researchTrends, trendsText } = await import("../src/make/trends.ts");
const { make, writeMakeProject } = await import("../src/make/index.ts");
const { runCli } = await import("../src/render/cli-runner.ts");
const { HF_BIN } = await import("../src/design/hyperframes/project.ts");
const { jobDir, readJson } = await import("../src/lib/workspace.ts");
const { CostSchema } = await import("../src/schemas/index.ts");
const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
import type { StructuredFn } from "../src/lib/llm.ts";
import type { AgyRunner } from "../src/understand/vision/agy.ts";

const RAW = {
  title: "Почему кофе дорожает",
  language: "ru",
  beats: [
    { text: "Чашка кофе за год подорожала на 30 процентов.", emphasis: "30 процентов", icon: "coffee", seconds: 3 },
    { text: "Засуха в Бразилии срезала урожай арабики.", emphasis: "Бразилии", icon: "cloud-sun", seconds: 4 },
    { text: "Логистика и доллар добавили ещё по десять.", emphasis: "ещё", icon: "no-such-icon", seconds: 1 },
    { text: "Хочешь дешевле — бери зерно, а не капсулы.", emphasis: "не в тексте", icon: "Shopping Cart", seconds: 5 },
    { text: "Подпишись, расскажу, где брать.", emphasis: "Подпишись", icon: "arrow-right", seconds: 3 },
  ],
  hashtags: ["#Кофе", "цены ", "economy"],
};

test("script: durations by reading speed, icons resolved to Lucide names, emphasis must be in the text", async () => {
  assert.equal(beatsFor(35), 7);
  assert.equal(beatsFor(20), 4);
  assert.equal(beatsFor(90), 8);
  assert.equal(beatSeconds("Три слова тут.", 2), 2.5);
  assert.equal(beatSeconds("Одно два три четыре пять шесть семь восемь девять десять.", 3), 4.8);
  const s = await normalizeScript(RAW);
  ScriptSchema.parse(s);
  assert.equal(s.beats[2].icon, "sparkles", "unknown icon → sparkles");
  assert.equal(s.beats[3].icon, "shopping-cart", "spaces/case normalised");
  assert.equal(s.beats[3].emphasis, "", "emphasis not found in the text is dropped");
  assert.equal(s.beats[0].emphasis, "30 процентов");
  assert.ok(s.beats[2].seconds >= 3, "1 s asked, reading floor applied");
  assert.deepEqual(s.hashtags, ["кофе", "цены", "economy"]);
  assert.ok(scriptDuration(s) > 15);

  const calls: string[] = [];
  const llm: StructuredFn = async (q) => {
    calls.push(q.prompt);
    return { data: RAW, usage: { input_tokens: 500, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.02, estimate: false, model: "mock", provider: "mock" };
  };
  const r = await writeScript("почему кофе дорожает", llm, { language: "ru", seconds: 35, trendsText: "TREND NOTES:\n- fact: арабика +40% [x]" });
  assert.match(calls[0], /TOPIC: почему кофе дорожает/);
  assert.match(calls[0], /LANGUAGE: Russian/);
  assert.match(calls[0], /7 beats/);
  assert.match(calls[0], /TREND NOTES/);
  assert.equal(r.script.title, "Почему кофе дорожает");
  assert.equal(r.usd, 0.02);
});

test("compose: deterministic composition, one section per beat on the frame grid, icons inline, word reveal, lints clean", async () => {
  const s = await normalizeScript(RAW);
  const icons = Object.fromEntries(await Promise.all([...new Set(s.beats.map((b) => b.icon))].map(async (n) => [n, await loadIconSvg(n)])));
  const o = { icons, fontRel: "assets/fonts/Inter-Variable.ttf", gsapRel: "assets/gsap.min.js", kicker: "почему кофе дорожает" };
  const a = composeMake(s, o);
  assert.equal(a.html, composeMake(s, o).html);
  const { beats, duration } = timeBeats(s, 30);
  assert.equal(a.duration, duration);
  for (let i = 1; i < beats.length; i++) assert.ok(Math.abs(beats[i].start - (beats[i - 1].start + beats[i - 1].duration)) < 1e-9, "back-to-back on the frame grid");
  assert.equal((a.html.match(/class="clip beat/g) ?? []).length, 5);
  assert.match(a.html, /class="clip beat hook"/);
  assert.match(a.html, /class="clip beat cta"/);
  assert.equal((a.html.match(/<svg /g) ?? []).length, 5, "one inline icon per beat");
  assert.match(a.html, /class="w em"/, "emphasis words carry the accent class");
  assert.match(a.html, /ПОЧЕМУ КОФЕ ДОРОЖАЕТ|почему кофе дорожает/);
  assert.match(a.html, /data-duration="[\d.]+"\n\s+data-fps="30"/);
  assert.ok(!/tl\.(fromTo|to|set)\("#beat-\d+",/.test(a.html), "never tween the .clip itself");
  assert.match(a.html, /tl\.fromTo\("#bg-bar", \{ scaleX: 0 \}, \{ scaleX: 1/);

  const f = fitSentence("Короткая фраза.", 880, true);
  assert.ok(f.fontSize >= 84 && f.fontSize <= 100, String(f.fontSize));
  assert.equal(f.lines.length, 1);
  const long = fitSentence("Это очень длинное предложение, которое точно не влезет в одну строку на экране телефона.", 880);
  assert.ok(long.fontSize < 80 && long.lines.length >= 2 && long.lines.length <= 3, JSON.stringify(long));
  // measured: every line of the hook from the live run fits the 886 px text box
  const { loadFontMetrics } = await import("../src/design/layout.ts");
  const inter = await loadFontMetrics(path.join(process.cwd(), "assets", "fonts", "Inter-Variable.ttf"), { family: "Inter", weight: 800 });
  const hook = fitSentence("Почему капучино в столице стоит уже 400–600 рублей?", 886, true, inter);
  assert.ok(hook.lines.every((l) => inter.measure(l, hook.fontSize) <= 886), JSON.stringify(hook));
  assert.ok(hook.lines.length <= 3 && hook.fontSize >= 48);

  // the real project lints clean with the pinned HyperFrames CLI
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-make-"));
  const p = await writeMakeProject(s, dir, { kicker: "кофе" });
  for (const f of ["index.html", "hyperframes.json", "package.json", "meta.json", "layout.json", "script.json", "assets/gsap.min.js", "assets/fonts/Inter-Variable.ttf"]) assert.ok((await fs.stat(path.join(dir, f))).size > 0, f);
  const lint = await runCli(HF_BIN, ["lint", "--json"], dir);
  const parsed = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{"))) as { errorCount: number; findings?: unknown[] };
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
  assert.equal(p.duration, duration);
  await fs.rm(dir, { recursive: true, force: true });
});

test("trends: the Antigravity research answer is parsed and turned into notes; failures surface", async () => {
  const run: AgyRunner = async (args, stdin) => {
    assert.ok(args.includes("--json-schema"));
    assert.match(stdin, /Research what is being said/);
    const result = { status: "SUCCESS", response: "", structured_output: { facts: [{ text: "Арабика +40% за год", source: "https://x" }], angles: ["цена чашки"], hooks: ["Кофе стал роскошью?"], avoid: ["слухи о запрете"] }, usage: { input_tokens: 20000, output_tokens: 400 }, duration_seconds: 70 };
    return { code: 0, stdout: `{"event":"result","result":${JSON.stringify(result)}}\n`, stderr: "" };
  };
  const r = await researchTrends("кофе", { run, bin: "fake" });
  assert.equal(r.trends.facts[0].source, "https://x");
  assert.equal(r.wall_seconds, 70);
  const notes = trendsText(r.trends);
  assert.match(notes, /^TREND NOTES/);
  assert.match(notes, /- fact: Арабика \+40% за год \[https:\/\/x\]/);
  assert.match(notes, /- avoid: слухи/);
  const bad: AgyRunner = async () => ({ code: 1, stdout: '{"event":"result","result":{"status":"ERROR","error":"quota"}}\n', stderr: "" });
  await assert.rejects(() => researchTrends("x", { run: bad, bin: "fake" }), /ERROR: quota/);
});

test("make: end to end with a mock writer and a fake render; trends failure degrades to a warning; cost logged", async () => {
  const llm: StructuredFn = async () => ({ data: RAW, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 }, usd: 0.01, estimate: false, model: "mock", provider: "mock" });
  const events: string[] = [];
  const r = await make("почему кофе дорожает", {
    llm,
    trends: true,
    trendsOptions: { run: async () => ({ code: 1, stdout: "", stderr: "no agy" }), bin: "fake" },
    fakeRender: async (projectDir, out) => {
      assert.ok((await fs.stat(path.join(projectDir, "index.html"))).size > 0);
      await ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=270x480:rate=30:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
    },
    onEvent: (l) => events.push(l),
  });
  assert.equal(r.trends, "failed");
  assert.ok(r.warnings.some((w) => /тренды не собраны/.test(w)));
  assert.ok(r.warnings.some((w) => /без звука/.test(w)));
  assert.equal(r.beats, 5);
  assert.ok((await fs.stat(r.output)).size > 0);
  assert.ok(events.some((e) => /^job /.test(e)) && events.some((e) => /^▸ сценарий/.test(e)));
  const cost = await readJson(path.join(jobDir(r.jobId), "cost.json"), CostSchema);
  assert.equal(cost.total_usd, 0.01);
  assert.ok(await fs.stat(path.join(jobDir(r.jobId), "script.json")));
  assert.ok(await fs.stat(path.join(jobDir(r.jobId), "make.json")));
});
