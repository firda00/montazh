import test from "node:test";
import assert from "node:assert/strict";
import { loadPreset } from "../src/plan/presets.ts";
import { styledPreset } from "../src/style/profile.ts";
import { PRONIN_STYLE_MAPPING } from "../src/style/map.ts";
import { styleFromText } from "../src/bot/index.ts";
import { resolveDraft } from "../src/plan/resolve.ts";
import type { PlanDraft, Transcript } from "../src/schemas/index.ts";
import { makeFixtureContext } from "./helpers/plan-fixture.ts";

test("pronin_style: preset schema and properties", async () => {
  const { preset } = await loadPreset("pronin_style");
  assert.equal(preset.name, "pronin_style");
  assert.equal(preset.pace, "dynamic");
  assert.equal(preset.design.font.family, "Montserrat");
  assert.equal(preset.design.font.weight, 900);
  assert.equal(preset.design.colors.highlight, "#FFE600");
  assert.equal(preset.design.captions.max_words, 2);
  assert.equal(preset.design.captions.word_animation, "pop");
  assert.equal(preset.design.captions.pop_scale, 1.18);
  assert.equal(preset.design.captions.backing.enabled, true);
  assert.equal(preset.design.captions.shade.enabled, true);
  assert.equal(preset.design.inserts.enabled, true);
  assert.equal(preset.design.inserts.density, "high");
  assert.equal(preset.design.overlays.progress_bar, true);
  assert.equal(preset.sfx?.enabled, true);
  assert.equal(preset.sfx?.intensity, "heavy");
  assert.equal(preset.sfx?.hook_impact, true);
});

test("pronin_style: styledPreset yields PRONIN_STYLE_MAPPING", async () => {
  const { preset } = await loadPreset("pronin_style");
  const { mapping } = await styledPreset("job_non_existent_123", preset);
  assert.ok(mapping, "mapping must be present for pronin_style");
  assert.equal(mapping.cleanup.enabled, true);
  assert.ok(mapping.cleanup.silenceMs <= 200, "silenceMs must be <= 200ms for tight retention cut");
  assert.equal(mapping.cleanup.removeFillers, true);
  assert.equal(mapping.zoom.frequency, "every_cut_aggressive");
  assert.equal(mapping.zoom.scale, 1.14);
  assert.equal(mapping.audio.sfx.enabled, true);
  assert.equal(mapping.audio.sfx.hookImpact, true);
  assert.ok(mapping.grade, "grade must be defined for pronin_style");
  assert.equal(mapping.grade.contrast, 1.08);
});

test("pronin_style: styleFromText recognizes pronin / retention keywords", () => {
  assert.equal(styleFromText("сделай монтаж как у пронина"), "pronin_style");
  assert.equal(styleFromText("стиль pronin.media для рилса"), "pronin_style");
  assert.equal(styleFromText("нужен retention стиль"), "pronin_style");
  assert.equal(styleFromText("commercial reel с неоновыми субтитрами"), "pronin_style");
  assert.equal(styleFromText("сделай в стиле Пронин"), "pronin_style");
});

test("pronin_style: resolveDraft applies jump-cuts, punch-in zooms, color grade and SFX", async () => {
  const { preset } = await loadPreset("pronin_style");

  const transcript: Transcript = {
    language: "ru",
    segments: [
      {
        start: 0,
        end: 3.2,
        text: "Дизайн не всегда продает, эээ, запомните это навсегда.",
        words: [
          { w: "Дизайн", start: 0.1, end: 0.6 },
          { w: "не", start: 0.65, end: 0.8 },
          { w: "всегда", start: 0.85, end: 1.3 },
          { w: "продает", start: 1.35, end: 1.8 },
          { w: "эээ", start: 1.9, end: 2.1 },
          { w: "запомните", start: 2.3, end: 2.7 },
          { w: "это", start: 2.75, end: 2.9 },
          { w: "навсегда", start: 2.95, end: 3.2 },
        ],
      },
      {
        start: 3.5,
        end: 6.0,
        text: "Потому что главное — это конверсия и смыслы.",
        words: [
          { w: "Потому", start: 3.6, end: 3.9 },
          { w: "что", start: 3.95, end: 4.1 },
          { w: "главное", start: 4.15, end: 4.6 },
          { w: "это", start: 4.7, end: 4.9 },
          { w: "конверсия", start: 4.95, end: 5.5 },
          { w: "и", start: 5.55, end: 5.65 },
          { w: "смыслы", start: 5.7, end: 6.0 },
        ],
      },
    ],
  };

  const ctx = makeFixtureContext({
    transcript,
    preset,
  });

  assert.ok(ctx.style, "buildPlanContext must attach PRONIN_STYLE_MAPPING to ctx.style");

  const draft: PlanDraft = {
    brief: {
      style_words: ["pronin", "retention"],
    },
    reasoning: "Монтаж в стиле Pronin Media: динамичные джамп-каты, зумы и мощный саунд-дизайн.",
    outputs: [
      {
        id: "reel_pronin",
        aspect: "9:16",
        hook: "Дизайн не всегда продает",
        clips: [
          { start: "p0.start", end: "p0.end" },
          { start: "p1.start", end: "p1.end" },
        ],
        captions: { enabled: true },
        titles: [{ at: 0, text: "ДИЗАЙН НЕ ПРОДАЕТ" }],
        music: { enabled: true },
      },
    ],
  };

  const res = resolveDraft(draft, ctx, { mode: "plan" });
  assert.equal(res.errors.length, 0, `Expected 0 errors: ${JSON.stringify(res.errors)}`);
  assert.ok(res.edl, "EDL must be produced");

  const out = res.outputs[0]?.output;
  assert.ok(out, "Output must be resolved");

  // Filler "эээ" removed and pieces split
  assert.ok(out.clips.length >= 2, "Clips should be processed by jumpCutClips");

  // Camera punch-in zoom must be present on clips
  const hasZoom = out.clips.some((c) => c.zoom && (c.zoom.to === 1.14 || c.zoom.from === 1.14));
  assert.ok(hasZoom, "Expected at least one clip with 1.14x punch-in zoom");

  // SFX cues must include hook impact at t=0 and whooshes
  assert.ok(out.sfx && out.sfx.length > 0, "SFX cues must be generated");
  const impactCue = out.sfx.find((c) => c.kind === "impact" && c.t === 0);
  assert.ok(impactCue, "Hook impact cue at t=0 must be present");
  const whooshCue = out.sfx.find((c) => c.kind === "whoosh");
  assert.ok(whooshCue, "Whoosh SFX cue must be present");

  // Color grade
  assert.ok(out.grade, "Color grade must be applied");
  assert.equal(out.grade.contrast, 1.08);
  assert.equal(out.grade.saturation, 1.14);
});
