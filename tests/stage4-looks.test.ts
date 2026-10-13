import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeHyperframes } from "../src/design/hyperframes/compose.ts";
import { buildLayout, loadFontMetrics, titleAnchor } from "../src/design/layout.ts";
import { buildDesignTimeline } from "../src/design/timeline.ts";
import { faceCentreY } from "../src/design/export.ts";
import { cropScaleFilter, upscaleFactor, SHARPEN_ABOVE_UPSCALE } from "../src/cut/index.ts";
import { BUILTIN_PRESETS } from "../src/plan/presets.ts";
import { DesignSpecSchema, EdlSchema, PresetSchema, ScenesSchema } from "../src/schemas/index.ts";
import type { DesignJob } from "../src/design/export.ts";
import { MEDIA, makeTranscript } from "./helpers/plan-fixture.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inter = await loadFontMetrics(path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf"), { family: "Inter", weight: 800 });
const edl = EdlSchema.parse({ outputs: [{ id: "reel_1", aspect: "9:16", clips: [{ src_start: 0, src_end: 2.3 }, { src_start: 8.29, src_end: 13.08 }], titles: [{ at: 0.3, duration: 2.5, text: "Физика — это закон", style: "card" }], captions: { enabled: true, language: "ru" } }], reasoning: "" });
const timeline = buildDesignTimeline(edl.outputs[0], makeTranscript(), MEDIA);
const base = PresetSchema.parse(BUILTIN_PRESETS.bold_pop).design;

function job(design = base, extra: Partial<DesignJob> = {}): DesignJob {
  return { job_id: "t", rough_path: "C:/x/rough.mp4", timeline, pages: [], design, preset: "bold_pop", captions_language: "ru", translated: false, warnings: [], ...extra };
}
const assets = { videoRel: "a.mp4", fontRel: "f.ttf", gsapRel: "g.js" };

test("caption backing and lower shade are opt-in and land in the composition when enabled", () => {
  const off = composeHyperframes(job(), buildLayout(job(), inter), assets);
  assert.ok(!/id="shade"/.test(off), "no shade by default");
  assert.ok(!/\.cap-line \{[^}]*background:/s.test(off), "no backing by default");

  const on = DesignSpecSchema.parse({ ...base, captions: { ...base.captions, backing: { enabled: true, color: "rgba(0,0,0,0.5)", padding: 10, radius: 18 }, shade: { enabled: true, strength: 0.4, from: 0.6 } } });
  const html = composeHyperframes(job(on), buildLayout(job(on), inter), assets);
  assert.match(html, /\.cap-line \{[^}]*display: inline-block;[^}]*background: rgba\(0,0,0,0\.5\);[^}]*border-radius: 18px/s);
  assert.match(html, /<section id="shade" class="clip shade" data-start="0" data-duration="7\.1" data-track-index="1"><\/section>/);
  assert.match(html, /\.shade \{[^}]*linear-gradient\(to bottom, rgba\(0,0,0,0\) 60%, rgba\(0,0,0,0\.4\) 100%\)/s);
  assert.ok(html.indexOf('id="shade"') < html.indexOf('id="cap-0"'), "shade is painted under the captions");

  // no captions → no shade either
  const noCaps = { ...job(on), timeline: { ...timeline, captions: { enabled: false } } } as DesignJob;
  assert.ok(!/id="shade"/.test(composeHyperframes(noCaps, buildLayout(noCaps, inter), assets)));
});

test("the title moves below a high face and stays on top otherwise", () => {
  assert.equal(titleAnchor(base, undefined), base.titles.anchor_y);
  assert.equal(titleAnchor(base, 0.6), base.titles.anchor_y, "face centred/low: title stays on top");
  const moved = titleAnchor(base, 0.29);
  assert.ok(moved > 0.5 && moved < base.captions.anchor_y, `${moved} sits between the face and the captions`);
  const noAvoid = DesignSpecSchema.parse({ ...base, titles: { ...base.titles, avoid_face: false } });
  assert.equal(titleAnchor(noAvoid, 0.29), base.titles.anchor_y);

  const layoutTop = buildLayout(job(base, { face_y: 0.6 }), inter);
  const layoutMoved = buildLayout(job(base, { face_y: 0.29 }), inter);
  assert.equal(layoutTop.titles.anchorY, base.titles.anchor_y);
  assert.equal(layoutMoved.titles.anchorY, moved);
  assert.match(composeHyperframes(job(base, { face_y: 0.29 }), layoutMoved, assets), /class="ttl-box card"/, "card style from the EDL title");
});

test("faceCentreY: duration-weighted over clips with focus; undefined without focus data", () => {
  const scenes = ScenesSchema.parse([
    { start: 0, end: 5, description: "a", objects: [], people_count: 1, emotion: "x", shot_type: "medium", quality_score: 0.5, focus: { x: 0.5, y: 0.2 } },
    { start: 5, end: 15, description: "b", objects: [], people_count: 1, emotion: "x", shot_type: "medium", quality_score: 0.5, focus: { x: 0.5, y: 0.6 } },
    { start: 15, end: 20, description: "c", objects: [], people_count: 0, emotion: "x", shot_type: "wide", quality_score: 0.5 },
  ]);
  const y = faceCentreY([{ src_start: 0, src_end: 2 }, { src_start: 8, src_end: 14 }], scenes)!;
  assert.ok(Math.abs(y - (0.2 * 2 + 0.6 * 6) / 8) < 1e-3, String(y));
  assert.equal(faceCentreY([{ src_start: 15, src_end: 20 }], scenes), undefined);
  assert.equal(faceCentreY([], scenes), undefined);
});

test("cut sharpens only strong upscales: 9:16 from 1080p yes, 16:9 from 1080p no", () => {
  const up = upscaleFactor("9:16", { width: 1920, height: 1080 });
  assert.ok(Math.abs(up - 1080 / 607.5) < 1e-6);
  assert.ok(up >= SHARPEN_ABOVE_UPSCALE);
  assert.equal(upscaleFactor("16:9", { width: 1920, height: 1080 }), 1);
  assert.ok(upscaleFactor("9:16", { width: 2160, height: 3840 }) < 1);
  assert.match(cropScaleFilter("9:16", null, up), /scale=1080:1920:flags=lanczos,unsharp=5:5:0\.7:5:5:0,setsar=1$/);
  assert.ok(!/unsharp/.test(cropScaleFilter("16:9", null, 1)));
  assert.ok(!/unsharp/.test(cropScaleFilter("9:16")), "default: no sharpening");
});
