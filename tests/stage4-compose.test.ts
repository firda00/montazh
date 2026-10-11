import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import { writeHyperframesProject, HF_BIN, ROOT } from "../src/design/hyperframes/project.ts";
import { runCli } from "../src/render/cli-runner.ts";
import { buildDesignTimeline } from "../src/design/timeline.ts";
import { BUILTIN_PRESETS } from "../src/plan/presets.ts";
import { EdlSchema, PresetSchema } from "../src/schemas/index.ts";
import type { DesignJob } from "../src/design/export.ts";
import type { Layout } from "../src/design/layout-types.ts";
import { MEDIA, makeTranscript } from "./helpers/plan-fixture.ts";
import { ffmpeg } from "../src/lib/ffmpeg.ts";

const design = PresetSchema.parse(BUILTIN_PRESETS.bold_pop).design;
const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }], titles: [{ at: 0.3, duration: 2.5, text: "Секрет плова — не торопиться" }], captions: { enabled: true, language: "ru" } }], reasoning: "" });
const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);

function job(roughPath: string): DesignJob {
  return { job_id: "test", rough_path: roughPath, timeline, pages: [], design, preset: "bold_pop", captions_language: "ru", translated: false };
}

/** A hand-built layout: two pages (one two-line), one title. */
const layout: Layout = {
  frame: { width: 1080, height: 1920, fps: 30, duration: 4.7 },
  captions: { anchorY: 0.72, maxWidth: 864, baseFontSize: 72, strokeWidth: 4, uppercase: true, language: "ru" },
  titles: { anchorY: 0.18, maxWidth: 800, baseFontSize: 88 },
  font: { family: "Inter", file: "assets/fonts/Inter-Variable.ttf", weight: 800, source: "heuristic" },
  version: "layout/test",
  pages: [
    { index: 0, start: 0, end: 2.3, dispStart: 0, dispEnd: 2.3, exitFade: false, fontSize: 72, wordGap: 22, width: 600, lines: [{ width: 600, words: [{ text: "ДОБРО", raw: "Добро", start: 0, end: 0.54, width: 250, popScale: 1.12 }, { text: "ПОЖАЛОВАТЬ", raw: "пожаловать", start: 0.54, end: 1.26, width: 350, popScale: 1.08 }] }] },
    { index: 1, start: 2.3, end: 4.6, dispStart: 2.3, dispEnd: 4.6, exitFade: true, fontSize: 64, wordGap: 20, width: 700, lines: [{ width: 400, words: [{ text: "КАЖДОЕ", raw: "Каждое", start: 2.3, end: 2.52, width: 300, popScale: 1.1 }] }, { width: 700, words: [{ text: "УТРО", raw: "утро", start: 2.52, end: 2.7, width: 200, popScale: 1.12 }, { text: "МЫ", raw: "мы", start: 2.7, end: 2.81, width: 120, popScale: 1.12 }] }] },
  ],
  titlesOut: [{ index: 0, at: 0.3, duration: 2.5, text: "Секрет плова — не торопиться", style: "hero", fontSize: 88, lines: ["Секрет плова —", "не торопиться"], width: 700 }],
};

test("composeHyperframes: deterministic standalone composition, video-only, caption groups, tweens on inner nodes only", () => {
  const html = composeHyperframes(job("C:/x/rough_reel_1.mp4"), layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "assets/fonts/Inter-Variable.ttf", gsapRel: "assets/gsap.min.js" });
  assert.equal(html, composeHyperframes(job("C:/x/rough_reel_1.mp4"), layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "assets/fonts/Inter-Variable.ttf", gsapRel: "assets/gsap.min.js" }));
  assert.match(html, /data-composition-id="main"[\s\S]*data-width="1080"[\s\S]*data-height="1920"[\s\S]*data-duration="4\.7"[\s\S]*data-fps="30"/);
  assert.ok(!/<audio/.test(html), "video-only overlay: audio is muxed at finalize");
  assert.match(html, /<video id="a-roll" src="assets\/rough_reel_1\.mp4" data-start="0" data-duration="4\.7" data-track-index="0" muted playsinline>/);
  assert.equal((html.match(/class="clip cap caption-group"/g) ?? []).length, 2);
  assert.equal((html.match(/class="w"/g) ?? []).length, 5);
  assert.equal((html.match(/class="cap-line"/g) ?? []).length, 3, "one span per laid-out line");
  assert.match(html, /<section id="cap-1"[^>]*data-start="2\.3" data-duration="2\.3"/);
  assert.match(html, /style="font-size:64px;--gap:20px"/);
  assert.match(html, /@font-face[\s\S]*url\("assets\/fonts\/Inter-Variable\.ttf"\)/);
  assert.match(html, /<section id="ttl-0" class="clip ttl" data-start="0\.3" data-duration="2\.5"/);
  assert.equal((html.match(/class="ttl-line"/g) ?? []).length, 2);
  assert.ok(!/\.w \{[^}]*\btransform\s*:/.test(html), "no CSS transform property on tweened nodes");
  assert.ok(!/<br/.test(html), "no <br> in body text");
  assert.match(html, /window\.__timelines\["main"\] = tl;/);
  // pops: one in-tween per word, one revert for all but the last word of each page
  assert.equal((html.match(/ease: "back\.out\(1\.7\)"/g) ?? []).length, 5);
  assert.match(html, /scale: 1\.12, color: "#FFD600"/);
  assert.ok(!/tl\.(fromTo|to|set)\("#cap-\d+",/.test(html), "never tween the .clip itself");
  assert.match(html, /tl\.fromTo\("#cap-1-line0, #cap-1-line1", \{ opacity: 1 \}, \{ opacity: 0/, "exit fade on the inner lines of a fading page");
  // outro card (bold_pop has it enabled): last 1.8 s, text in the caption language, two balanced lines
  assert.match(html, /<section id="outro" class="clip outro" data-start="2\.9" data-duration="1\.8"/);
  assert.match(html, /Подпишись — дальше/);
  assert.equal((html.match(/class="outro-line"/g) ?? []).length, 2);
  // uz captions pick the uz text; a video shorter than outro+1 s gets no outro
  const uz = composeHyperframes({ ...job("C:/x/r.mp4"), captions_language: "uz" }, { ...layout, captions: { ...layout.captions, language: "uz" } }, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js" });
  assert.match(uz, /Obuna/);
  const short = composeHyperframes(job("C:/x/r.mp4"), { ...layout, frame: { ...layout.frame, duration: 2.5 }, pages: [], titlesOut: [] }, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js" });
  assert.ok(!/id="outro"/.test(short));
});

test("splitBalanced keeps short texts on one line and balances longer ones", async () => {
  const { splitBalanced } = await import("../src/design/hyperframes/compose.ts");
  assert.deepEqual(splitBalanced("Follow for more", 2), ["Follow for more"]);
  assert.deepEqual(splitBalanced("Подпишись — дальше ещё вкуснее", 2), ["Подпишись — дальше", "ещё вкуснее"]);
});

test("writeHyperframesProject produces a project the pinned CLI lints clean", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-hf-"));
  const rough = path.join(dir, "rough_reel_1.mp4");
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=270x480:rate=30:duration=4.7", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", rough]);
  const project = path.join(dir, "project");
  const r = await writeHyperframesProject(job(rough), layout, project, { fontFile: path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf") });
  assert.ok(r.html.includes("assets/rough_reel_1.mp4"));
  for (const f of ["index.html", "hyperframes.json", "package.json", "meta.json", "layout.json", "design.json", "assets/rough_reel_1.mp4", "assets/fonts/Inter-Variable.ttf", "assets/gsap.min.js"]) {
    assert.ok((await fs.stat(path.join(project, f))).size > 0, f);
  }
  const lint = await runCli(HF_BIN, ["lint", "--json"], project);
  const start = lint.stdout.indexOf("{");
  const parsed = JSON.parse(lint.stdout.slice(start)) as { ok: boolean; errorCount: number; warningCount: number; findings?: unknown[] };
  assert.equal(parsed.errorCount, 0, JSON.stringify(parsed.findings));
  assert.equal(parsed.warningCount, 0, JSON.stringify(parsed.findings));
  await fs.rm(dir, { recursive: true, force: true });
});
