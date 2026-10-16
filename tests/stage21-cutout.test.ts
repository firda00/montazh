// Split layout, speaker cutout (MediaPipe matte sidecar): schema/preset defaults, the plate/pop geometry and
// z-order in the composition (pop-out above the seam, captions on their backing over the cutout), the
// auto/on/off decision on good and bad mattes, the cache, and the sidecar selftest on a synthetic clip
// (colour-key segmenter, no model, no network; skipped when tools/matte/.venv is not installed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizePanels } from "../src/design/panels.ts";
import { buildSplitLayer } from "../src/design/hyperframes/split.ts";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import { buildDesignTimeline } from "../src/design/timeline.ts";
import { cutoutGeometry, findMattePython, judgeMatte, makeCutout, resolveCutout, runMatteSidecar, type MatteRunner, type MatteStats } from "../src/design/matte.ts";
import { loadPreset } from "../src/plan/presets.ts";
import { DesignSpecSchema, EdlSchema, PresetSchema } from "../src/schemas/index.ts";
import type { DesignJob } from "../src/design/export.ts";
import type { Layout } from "../src/design/layout-types.ts";
import { MEDIA, makeTranscript } from "./helpers/plan-fixture.ts";

const GOOD: MatteStats = {
  version: "matte/1",
  segmenter: "mediapipe-selfie",
  output: { plate: "x.plate.mp4", pop: "x.pop.webm", width: 1080, height: 1076, plate_height: 960, y0: 13, overlap: 116 },
  placement: { samples: 30, with_person: 30, head_top: 37, head_clipped: 0 },
  frames: 910,
  analysed_frames: 456,
  cuts: 2,
  coverage: { median: 0.59, p10: 0.57, p90: 0.63 },
  empty_frac: 0,
  fallback_frames: 0,
  stability: { median_iou: 0.99, unstable_frac: 0 },
  uncertain_ratio: 0.05,
  timings: { wall_seconds: 21, realtime_factor: 0.69 },
};
const BAD: MatteStats = { ...GOOD, coverage: { median: 0.03, p10: 0, p90: 0.1 }, empty_frac: 0.4, stability: { median_iou: 0.6, unstable_frac: 0.5 }, placement: { samples: 30, with_person: 9, head_top: null, head_clipped: 0 } };

test("schema and preset: cutout off by default, split_news cuts out on auto with a 7% pop-out", async () => {
  const d = DesignSpecSchema.parse({ layout: "split" });
  assert.equal(d.split.cutout, "off");
  assert.equal(d.split.pop_out, 0.06);
  assert.throws(() => DesignSpecSchema.parse({ split: { cutout: "maybe" } }));
  const { preset } = await loadPreset("split_news");
  const sn = PresetSchema.parse(preset).design;
  assert.equal(sn.layout, "split");
  assert.equal(sn.split.cutout, "auto");
  assert.equal(sn.split.pop_out, 0.07);
});

test("cutoutGeometry: even sizes, the layer starts pop_out above the seam", () => {
  const g = cutoutGeometry(1080, 1920, 0.5, 0.06);
  assert.deepEqual(g, { width: 1080, height: 1076, overlap: 116, seam: 960, top: 844 });
  assert.equal(cutoutGeometry(1080, 1920, 0.5, 0).top, 960);
});

function fixture(withCutout: boolean) {
  const design = DesignSpecSchema.parse({ layout: "split", split: { accent: "#8B6CFF", cutout: "auto" }, captions: { backing: { enabled: true, color: "rgba(0,0,0,0.42)" } } });
  const panels = normalizePanels({ hook_title: [{ text: "ФИЗИКА", style: "display" }], panels: [{ start: 0, end: 4.7, image_prompt: "AI chat", cards: [] }] }, 4.7);
  const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }], captions: { enabled: true, language: "ru" } }], reasoning: "" });
  const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);
  const job: DesignJob = { job_id: "t", rough_path: "C:/x/rough.mp4", timeline, pages: [], design, preset: "split_news", captions_language: "ru", translated: false, warnings: [], panels, panel_images: {}, face_y: 0.3, ...(withCutout ? { cutout: { plate: "C:/x/cutout_ab.plate.mp4", pop: "C:/x/cutout_ab.pop.webm", width: 1080, plate_height: 960, overlap: 116 } } : {}) };
  const layout: Layout = {
    frame: { width: 1080, height: 1920, fps: 30, duration: 4.7 },
    captions: { anchorY: 0.79, maxWidth: 864, baseFontSize: 62, strokeWidth: 4, uppercase: true, language: "ru" },
    titles: { anchorY: 0.18, maxWidth: 800, baseFontSize: 88 },
    font: { family: "Inter", file: "f.ttf", weight: 800, source: "heuristic" },
    version: "layout/test",
    pages: [{ index: 0, dispStart: 0.2, dispEnd: 2, fontSize: 62, wordGap: 14, exitFade: false, lines: [{ words: [{ text: "ПРИВЕТ", start: 0.2, end: 0.8, popScale: 1.12 }] }] }] as never,
    titlesOut: [],
  };
  return { job, layout, design, panels };
}

test("compose with a cutout: plate in the bottom box, alpha pop strip 116 px over the seam above the panels, captions on top with their backing", () => {
  const { job, layout } = fixture(true);
  const html = composeHyperframes(job, layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "f.ttf", gsapRel: "g.js", cutoutRel: { plate: "assets/cutout_ab.plate.mp4", pop: "assets/cutout_ab.pop.webm" } });
  assert.match(html, /<video id="a-roll" src="assets\/cutout_ab\.plate\.mp4"/);
  assert.match(html, /<video id="a-pop" src="assets\/cutout_ab\.pop\.webm" data-start="0" data-duration="4\.7"[^>]*muted playsinline>/);
  assert.match(html, /#a-roll \{ position: absolute; left: 0; top: 960px; width: 1080px; height: 960px; object-fit: fill; z-index: 2;/);
  assert.match(html, /#a-pop \{ position: absolute; left: 0; top: 844px; width: 1080px; height: 116px; object-fit: fill; z-index: 3;/);
  const z = (sel: string) => Number(new RegExp(`${sel.replace(".", "\\.")} \\{ z-index: (\\d+)`).exec(html)?.[1] ?? NaN);
  assert.ok(z(".sp-panel") < 3 && z(".sp-seam") < 2, "panels and the seam line stay under the speaker (pop-out)");
  assert.ok(/\.cap, \.shade \{ z-index: 4/.test(html) && z(".sp-hook") > 3, "captions and the hook stay readable over the cutout");
  assert.match(html, /background: rgba\(0,0,0,0\.42\)/, "caption backing kept");
  assert.ok(!/drop-shadow/.test(html), "no CSS filter on the videos (halo, ~70 ms a frame)");
  // the boxes scale with the frame (a 720-wide render)
  const small = buildSplitLayer({ W: 720, H: 1280, duration: 4.7, design: job.design, panels: job.panels!, images: {}, serifFamily: "s", monoFamily: "m", displayFamily: "d", cutout: { plateHeight: 640, popHeight: 116 * (720 / 1080) } });
  assert.match(small.css, /#a-pop \{ position: absolute; left: 0; top: 562\.7px/);
  // no pop strip (pop_out 0): plate only
  const flat = composeHyperframes({ ...job, cutout: { ...job.cutout!, pop: undefined } }, layout, { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js", cutoutRel: { plate: "assets/p.mp4" } });
  assert.ok(!flat.includes("a-pop"));
});

test("compose without the cutout asset (or off) keeps the plain bottom-half video", () => {
  const { job, layout } = fixture(true);
  const html = composeHyperframes(job, layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "f.ttf", gsapRel: "g.js" });
  assert.match(html, /<video id="a-roll" src="assets\/rough_reel_1\.mp4"/);
  assert.match(html, /#a-roll \{ position: absolute; left: 0; top: 960px; width: 1080px; height: 960px; object-fit: cover/);
  assert.ok(!html.includes("a-pop"));
  const plain = composeHyperframes(fixture(false).job, layout, { videoRel: "assets/rough_reel_1.mp4", fontRel: "f.ttf", gsapRel: "g.js", cutoutRel: { plate: "assets/x.mp4" } });
  assert.ok(!plain.includes("x.mp4"));
});

test("judgeMatte: a stable person passes; empty, jittery or tiny mattes fail with reasons", () => {
  assert.deepEqual(judgeMatte(GOOD), { ok: true, reasons: [] });
  const bad = judgeMatte(BAD);
  assert.equal(bad.ok, false);
  assert.ok(bad.reasons.length >= 3, bad.reasons.join("; "));
  assert.equal(judgeMatte({ ...GOOD, coverage: { median: 0.97, p10: 0.95, p90: 0.99 } }).ok, false, "a matte covering the whole frame is a failed segmentation");
});

/** a fake sidecar: writes the plate, the pop strip and the stats the Node side expects */
function fakeRunner(stats: MatteStats, calls: string[][]): MatteRunner {
  return async (_py, args) => {
    calls.push(args);
    const plate = args[args.indexOf("--out-plate") + 1];
    const pop = args[args.indexOf("--out-pop") + 1];
    await fs.writeFile(plate, "mp4");
    await fs.writeFile(pop, "webm");
    await fs.writeFile(args[args.indexOf("--stats") + 1], JSON.stringify({ ...stats, output: { ...stats.output, plate, pop } }));
    return { code: 0, stderr: "matte done" };
  };
}

test("resolveCutout: auto falls back on a bad matte or a missing sidecar, on insists, off skips; results are cached", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-cutout-"));
  try {
    const rough = path.join(dir, "rough.mp4");
    await fs.writeFile(rough, "rough-bytes");
    const p = { width: 1080, height: 1076, overlap: 116, bg: "#0D0A1A", accent: "#8B6CFF" };
    const calls: string[][] = [];
    assert.deepEqual(await resolveCutout("off", rough, dir, p, { python: "py", run: fakeRunner(GOOD, calls) }), { warnings: [] });
    assert.equal(calls.length, 0);

    const good = await resolveCutout("auto", rough, path.join(dir, "g"), p, { python: "py", run: fakeRunner(GOOD, calls) });
    assert.ok(good.cutout && good.cutout.plate.endsWith(".plate.mp4") && good.cutout.pop?.endsWith(".pop.webm") && good.cutout.overlap === 116 && good.cutout.plateHeight === 960);
    assert.deepEqual(good.warnings, []);
    const arg = (k: string) => calls[0][calls[0].indexOf(k) + 1];
    assert.equal(arg("--crop-h"), "1076");
    assert.equal(arg("--bg-color"), "#0D0A1A");
    assert.equal(arg("--accent"), "#8B6CFF");
    // second run: from the cache, the sidecar is not started
    const again = await makeCutout(rough, path.join(dir, "g"), p, { python: "py", run: async () => assert.fail("must come from the cache") });
    assert.equal(again.cached, true);

    const autoBad = await resolveCutout("auto", rough, path.join(dir, "b"), p, { python: "py", run: fakeRunner(BAD, calls) });
    assert.equal(autoBad.cutout, undefined);
    assert.match(autoBad.warnings[0], /маска ненадёжна.*обычное видео/);
    const onBad = await resolveCutout("on", rough, path.join(dir, "b2"), p, { python: "py", run: fakeRunner(BAD, calls) });
    assert.ok(onBad.cutout);
    assert.match(onBad.warnings[0], /--cutout on/);

    const missing = await resolveCutout("auto", rough, dir, p, { python: null });
    assert.match(missing.warnings[0], /не установлен/);
    await assert.rejects(resolveCutout("on", rough, dir, p, { python: null }), /не установлен/);
    const crash: MatteRunner = async () => ({ code: 1, stderr: "error: RuntimeError: boom" });
    const autoCrash = await resolveCutout("auto", rough, path.join(dir, "c"), p, { python: "py", run: crash });
    assert.match(autoCrash.warnings[0], /boom/);
    await assert.rejects(resolveCutout("on", rough, path.join(dir, "c2"), p, { python: "py", run: crash }), /boom/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sidecar selftest: synthetic person on a moving background → VP9 alpha WebM with the true silhouette", async (t) => {
  const python = await findMattePython();
  if (!python) return t.skip("tools/matte/.venv not installed");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-matte-"));
  try {
    const r = await runMatteSidecar(python, ["selftest", "--out-dir", dir]);
    assert.equal(r.code, 0, r.stderr.slice(-800));
    const stats = JSON.parse(await fs.readFile(path.join(dir, "stats.json"), "utf8"));
    assert.equal(stats.frames, 30);
    assert.equal(stats.selftest.decoded_frames, 30, "the WebM carries an alpha plane for every frame");
    assert.equal(stats.selftest.pop_frames, 30, "the pop strip carries alpha too");
    assert.deepEqual(stats.selftest.plate_size, [stats.output.width, stats.output.plate_height]);
    assert.ok(stats.selftest.iou_mean > 0.9, `matte vs ground truth IoU ${stats.selftest.iou_mean}`);
    assert.ok(stats.coverage.median > 0.2 && stats.coverage.median < 0.8);
    assert.ok(Math.abs(stats.placement.head_top - stats.selftest.true_head_top) <= 8, "head top found for the pop-out");
    assert.equal(judgeMatte(stats).ok, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
