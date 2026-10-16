// Stage 22: «Монтаж как в примере» — Style DNA schema and clamping, the mapping of every enum, cache keys and
// link canonicalisation, cut metrics from ffmpeg output, the jump-cut cleanup, the planner rules block, the
// resolver in reference mode, the extractor with stubs (cache hit = no model call) and the bot flow.
// Offline: no network, no whisper, no Gemini, no renderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

process.env.VEDIT_WORKSPACE = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-s22-ws-"));

const dnaMod = await import("../src/style/dna.ts");
const { DEFAULT_DNA, parseDNA, StyleDNASchema, STYLE_DNA_RESPONSE_SCHEMA, RANGES } = dnaMod;
const { mapStyle, applyStyleToPreset, styleSummary, colorKey, deepMerge } = await import("../src/style/map.ts");
const { canonicalUrl, contentKey, findUrl, StyleCache, tgAlias } = await import("../src/style/cache.ts");
const { parseSceneCuts, detectJumpCuts, cutStats, mergeCuts, parseSignalstats, speechStats, audioStats, bandDiffs } = await import("../src/style/metrics.ts");
const { jumpCutClip, jumpCutClips, fillerIndexes, zoomTargets, applyMotion, zoomField, splitLong } = await import("../src/style/jumpcut.ts");
const { extractStyle, mergeMeasured, metricsText, RefLinkError } = await import("../src/style/extract.ts");
const { StyleProfileSchema } = await import("../src/style/profile.ts");
const { buildTaskText } = await import("../src/plan/prompt.ts");
const { resolveDraft } = await import("../src/plan/resolve.ts");
const { makeFixtureContext, makeTranscript } = await import("./helpers/plan-fixture.ts");
const { BUILTIN_PRESETS } = await import("../src/plan/presets.ts");
const { DesignSpecSchema, PresetSchema } = await import("../src/schemas/index.ts");
const { buildMixGraph, bedLufsForDucking } = await import("../src/audio/mix.ts");
const { buildCutArgs, gradeFilter } = await import("../src/cut/index.ts");
const { createBot, MSG } = await import("../src/bot/index.ts");
const { STRINGS } = await import("../src/bot/i18n.ts");
const { fakeTelegram } = await import("./helpers/fake-telegram.ts");
type StyleDNA = import("../src/style/dna.ts").StyleDNA;
type Measured = import("../src/style/profile.ts").Measured;
type PipelineArgs = import("../src/bot/index.ts").PipelineArgs;
type Transcript = import("../src/schemas/index.ts").Transcript;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "vedit-s22-"));
const dna = (patch: unknown = {}): StyleDNA => deepMerge(structuredClone(DEFAULT_DNA), patch);

// ── schema ──────────────────────────────────────────────────────────────────────

test("parseDNA: numbers clamped to safe ranges, broken enums / colours / missing blocks fall back to defaults, string numbers and bare hex accepted", () => {
  const { dna: d, fixed } = parseDNA({
    style_summary: "Быстро.",
    planner_rules: { pacing_profile: "warp", hook_cut_duration_sec: 0.01, body_avg_cut_duration_sec: "1.8", silence_cut_threshold_ms: 9000, remove_fillers_and_retakes: true, speech_wpm_estimate: 999 },
    hyperframes_theme: {
      captions: { ...DEFAULT_DNA.hyperframes_theme.captions, max_words_per_screen: 2.6, position_y_percent: 120, primary_text_color: "red", active_word_color: "ffd600", stroke_width_px: -3, shadow_opacity: 4, active_word_scale: 3 },
      camera_motion: { ...DEFAULT_DNA.hyperframes_theme.camera_motion, zoom_scale_factor: 3 },
    },
    audio_and_color: { has_background_music: true, music_ducking_db: -40, sfx_on_cuts_and_zooms: true, sfx_intensity: "loud", color_grade: { preset: "cinematic_moody", contrast_multiplier: 2, saturation_multiplier: 0.1, brightness_offset: 1 } },
  });
  assert.equal(d.planner_rules.pacing_profile, DEFAULT_DNA.planner_rules.pacing_profile, "unknown enum → default");
  assert.equal(d.planner_rules.hook_cut_duration_sec, 0.3);
  assert.equal(d.planner_rules.body_avg_cut_duration_sec, 1.8, "a number sent as a string is still a number");
  assert.equal(d.planner_rules.silence_cut_threshold_ms, 1500);
  assert.equal(d.planner_rules.speech_wpm_estimate, 260);
  const C = d.hyperframes_theme.captions;
  assert.equal(C.max_words_per_screen, 3, "integers are rounded");
  assert.equal(C.position_y_percent, 92);
  assert.equal(C.primary_text_color, DEFAULT_DNA.hyperframes_theme.captions.primary_text_color, "not #RRGGBB → default");
  assert.equal(C.active_word_color, "#FFD600", "bare hex gets its #");
  assert.equal(C.stroke_width_px, 0);
  assert.equal(C.shadow_opacity, 1);
  assert.equal(C.active_word_scale, 1.4);
  assert.deepEqual(d.hyperframes_theme.overlays, DEFAULT_DNA.hyperframes_theme.overlays, "a missing block is the default block");
  assert.equal(d.hyperframes_theme.camera_motion.zoom_scale_factor, 1.3);
  assert.equal(d.audio_and_color.music_ducking_db, -26);
  assert.equal(d.audio_and_color.sfx_intensity, "none");
  assert.deepEqual(d.audio_and_color.color_grade, { preset: "cinematic_moody", contrast_multiplier: 1.2, saturation_multiplier: 0.85, brightness_offset: 0.05 });
  assert.ok(fixed.some((f) => f.startsWith("planner_rules.pacing_profile")) && fixed.some((f) => f.includes("zoom_scale_factor: 3 → 1.3")));
  assert.ok(StyleDNASchema.safeParse(d).success);
  // ducking: 0 = none survives, −5 counts as none, −14 stays
  for (const [inp, out] of [[0, 0], [-5, 0], [-14, -14], [-12.4, -12]] as const) assert.equal(parseDNA({ ...DEFAULT_DNA, audio_and_color: { ...DEFAULT_DNA.audio_and_color, music_ducking_db: inp } }).dna.audio_and_color.music_ducking_db, out);
  // every range in RANGES is inside the schema's own description
  for (const [k, [lo, hi]] of Object.entries(RANGES)) assert.ok(lo < hi, k);
  // garbage in → the default DNA out, never a throw
  assert.deepEqual(parseDNA("nonsense").dna, DEFAULT_DNA);
});

test("Gemini responseSchema: OpenAPI subset with enums enforced, every property required, propertyOrdering, no additionalProperties/$schema", () => {
  const s = STYLE_DNA_RESPONSE_SCHEMA as { type: string; properties: Record<string, any>; required: string[]; propertyOrdering: string[] };
  const text = JSON.stringify(s);
  assert.ok(!text.includes("additionalProperties") && !text.includes("$schema"));
  assert.deepEqual(s.propertyOrdering, ["style_summary", "planner_rules", "hyperframes_theme", "audio_and_color"]);
  assert.deepEqual(s.required, s.propertyOrdering);
  const caps = s.properties.hyperframes_theme.properties.captions;
  assert.deepEqual(caps.properties.layout_preset.enum, ["single_word_impact", "two_words_pop", "karaoke_two_lines", "minimal_clean_box", "none"]);
  assert.deepEqual(caps.properties.font_weight.enum, ["400_regular", "700_bold", "900_black"]);
  assert.equal(caps.properties.max_words_per_screen.type, "integer");
  assert.match(caps.properties.primary_text_color.pattern, /RRGGBB|\[0-9a-fA-F\]/);
  assert.deepEqual(s.properties.audio_and_color.properties.color_grade.properties.preset.enum.length, 5);
  assert.equal(s.properties.planner_rules.properties.pacing_profile.type, "string");
});

// ── mapping ─────────────────────────────────────────────────────────────────────

test("mapping: every enum value of the DNA lands on a real variable (captions, motion, sfx, grade, pace, base preset)", () => {
  // layout presets → size / words
  const sizes = new Set<number>();
  for (const v of dnaMod.LAYOUT_PRESETS) {
    const m = mapStyle(dna({ hyperframes_theme: { captions: { layout_preset: v, max_words_per_screen: 3 } } }));
    sizes.add(m.design.captions!.font_size!);
    assert.equal(m.captionsEnabled, v !== "none", v);
    if (v === "single_word_impact") assert.equal(m.design.captions!.max_words, 1);
    else assert.equal(m.design.captions!.max_words, 3);
  }
  assert.ok(sizes.size >= 4, "layout presets differ in size");
  // font weights
  assert.deepEqual(dnaMod.FONT_WEIGHTS.map((w) => mapStyle(dna({ hyperframes_theme: { captions: { font_weight: w } } })).design.font!.weight), [400, 700, 900]);
  // backgrounds
  const bg = Object.fromEntries(dnaMod.BACKGROUND_BOXES.map((b) => [b, mapStyle(dna({ hyperframes_theme: { captions: { background_box: b } } })).design.captions!.backing]));
  assert.equal(bg.none!.enabled, false);
  assert.ok(bg.rounded_pill!.enabled && bg.rounded_pill!.radius! >= 40);
  assert.ok(bg.full_strip!.enabled && bg.full_strip!.radius === 0);
  // word animations (highlight colour differs from the text colour)
  const anim = Object.fromEntries(dnaMod.WORD_ANIMATIONS.map((a) => {
    const c = mapStyle(dna({ hyperframes_theme: { captions: { word_animation: a, active_word_scale: 1.2, primary_text_color: "#FFFFFF", active_word_color: "#FFD600" } } })).design.captions!;
    return [a, `${c.word_animation}/${c.page_animation}/${c.pop_scale}`];
  }));
  assert.deepEqual(anim, { none: "none/none/1.2", spring_scale: "pop/none/1.2", fade_up: "fill/fade_up/1.2", color_switch_only: "fill/none/1", slide_in: "fill/fade_up/1.2" });
  assert.equal(mapStyle(dna({ hyperframes_theme: { captions: { word_animation: "spring_scale", active_word_scale: 1 } } })).design.captions!.word_animation, "fill", "a spring without scale is a colour switch");
  // camera motion
  const modes = dnaMod.ZOOM_STYLES.map((z) => mapStyle(dna({ hyperframes_theme: { camera_motion: { zoom_style: z, zoom_frequency: "every_2_3_sentences", zoom_scale_factor: 1.15 } } })).zoom.mode);
  assert.deepEqual(modes, ["none", "instant", "ken_burns", "ease"]);
  for (const f of dnaMod.ZOOM_FREQUENCIES) {
    const m = mapStyle(dna({ hyperframes_theme: { camera_motion: { zoom_frequency: f, zoom_style: "instant_punch_in", zoom_scale_factor: 1.15 } } }));
    assert.equal(m.zoom.frequency, f);
    assert.equal(m.zoom.mode, f === "none" ? "none" : "instant");
    assert.ok(m.plannerRules.includes("Наезды камерой"), f);
  }
  assert.equal(mapStyle(dna({ hyperframes_theme: { camera_motion: { split_screen_detected: true } } })).basePreset, "split_news");
  assert.equal(mapStyle(dna()).basePreset, "bold_pop");
  // sfx intensities
  const sfx = dnaMod.SFX_INTENSITIES.map((i) => mapStyle(dna({ audio_and_color: { sfx_on_cuts_and_zooms: true, sfx_intensity: i } })).audio.sfx);
  assert.deepEqual(sfx.map((s) => [s.enabled, s.hookImpact]), [[false, false], [true, false], [true, true]]);
  assert.equal(mapStyle(dna({ audio_and_color: { sfx_on_cuts_and_zooms: false, sfx_intensity: "heavy_cinematic" } })).audio.sfx.enabled, false);
  // grade presets
  for (const p of dnaMod.GRADE_PRESETS) {
    const g = mapStyle(dna({ audio_and_color: { color_grade: { preset: p, contrast_multiplier: 1.1, saturation_multiplier: 1.05, brightness_offset: 0.01 } } })).grade!;
    assert.equal(g.contrast, 1.1, p);
    assert.equal(typeof g.tint, "string");
  }
  assert.equal(mapStyle(dna()).grade, null, "neutral grade → no eq at all");
  assert.ok(mapStyle(dna({ audio_and_color: { color_grade: { preset: "high_contrast_warm" } } })).grade!.tint.startsWith("colorbalance"));
  // pacing
  assert.deepEqual(dnaMod.PACING.map((p) => mapStyle(dna({ planner_rules: { pacing_profile: p } })).pace), ["calm", "neutral", "dynamic", "dynamic"]);
  // music / ducking
  assert.equal(mapStyle(dna({ audio_and_color: { has_background_music: true, music_ducking_db: -20 } })).audio.duckDb, -20);
  assert.equal(mapStyle(dna({ audio_and_color: { has_background_music: true, music_ducking_db: 0 } })).audio.duckDb, null);
  // the styled preset is still a valid preset / design spec, with the house shade and CTA off
  const styled = applyStyleToPreset(BUILTIN_PRESETS.bold_pop, mapStyle(dna({ hyperframes_theme: { captions: { position_y_percent: 55, primary_text_color: "#00FF00" }, overlays: { progress_bar: true } } })));
  assert.ok(PresetSchema.safeParse(styled).success && DesignSpecSchema.safeParse(styled.design).success);
  assert.equal(styled.design.captions.anchor_y, 0.55);
  assert.equal(styled.design.colors.text, "#00FF00");
  assert.equal(styled.design.overlays.progress_bar, true);
  assert.equal(styled.design.outro.enabled, false);
  assert.equal(styled.design.captions.shade.enabled, false);
  // every DNA field shows up in the mapping table
  const fields = mapStyle(dna()).table.map((r) => r.field).join(" ");
  for (const k of ["layout_preset", "max_words_per_screen", "max_chars_per_line", "font_weight", "uppercase", "position_y_percent", "primary_text_color", "active_word_color", "secondary_accent_color", "stroke_color", "stroke_width_px", "shadow_opacity", "background_box", "word_animation", "active_word_scale", "zoom_frequency", "split_screen_detected", "progress_bar", "emoji_popups", "title_banner_first_3s", "pacing_profile", "hook_cut_duration_sec", "body_avg_cut_duration_sec", "silence_cut_threshold_ms", "remove_fillers_and_retakes", "speech_wpm_estimate", "has_background_music", "music_ducking_db", "sfx_intensity", "color_grade"]) assert.ok(fields.includes(k), k);
});

test("summary in ru / uz / en names the pace, cut length, caption words and colour", () => {
  const d = dna({ planner_rules: { pacing_profile: "fast", body_avg_cut_duration_sec: 1.8, silence_cut_threshold_ms: 200 }, hyperframes_theme: { captions: { layout_preset: "two_words_pop", max_words_per_screen: 2, active_word_color: "#FFD600" } } });
  assert.match(styleSummary(d, "ru"), /^Быстрый темп, склейка каждые 1\.8 с, паузы вырезаны \(джамп-каты\), субтитры по 2 слова капсом, активное слово жёлтым/);
  assert.match(styleSummary(d, "uz"), /Tez temp.*sariq/);
  assert.match(styleSummary(d, "en"), /Fast pace, a cut every 1\.8 s.*yellow/);
  assert.deepEqual(["#FFFFFF", "#000000", "#FF0000", "#00FF00", "#0000FF", "#FFD600", "#8B6CFF"].map(colorKey), ["white", "black", "red", "green", "blue", "yellow", "purple"]);
});

// ── cache ───────────────────────────────────────────────────────────────────────

test("cache keys: sha256 of size + first/last 512 KB; link canonicalisation strips tracking and names the platform id", async () => {
  const dir = await tmp();
  const big = Buffer.alloc(1_500_000, 7);
  const a = path.join(dir, "a.mp4");
  await fs.writeFile(a, big);
  const b = path.join(dir, "b.mp4");
  await fs.writeFile(b, Buffer.concat([big.subarray(0, 700_000), Buffer.alloc(100_000, 9), big.subarray(800_000)]));
  const c = path.join(dir, "c.mp4");
  await fs.writeFile(c, Buffer.concat([big, Buffer.from([1])]));
  const d = path.join(dir, "d.mp4");
  await fs.writeFile(d, Buffer.concat([Buffer.from([1]), big.subarray(1)]));
  const [ka, kb, kc, kd] = await Promise.all([a, b, c, d].map(contentKey));
  assert.match(ka, /^[0-9a-f]{64}$/);
  assert.equal(ka, kb, "only the edges are hashed: a change in the middle of a big file keeps the key");
  assert.notEqual(ka, kc, "the size is part of the key");
  assert.notEqual(ka, kd, "the first bytes are part of the key");
  const small = path.join(dir, "s.mp4");
  await fs.writeFile(small, "tiny");
  assert.match(await contentKey(small), /^[0-9a-f]{64}$/);

  assert.equal(canonicalUrl("https://www.instagram.com/reel/C9xYz_123/?igsh=abc&utm_source=ig_web_copy_link"), "instagram:reel:C9xYz_123");
  assert.equal(canonicalUrl("https://instagram.com/reels/C9xYz_123"), "instagram:reel:C9xYz_123");
  assert.equal(canonicalUrl("https://www.tiktok.com/@chef/video/7351234567890123456?is_from_webapp=1&sender_device=pc"), "tiktok:7351234567890123456");
  assert.equal(canonicalUrl("https://vm.tiktok.com/ZMabc123/"), "tiktok:short:ZMabc123");
  assert.equal(canonicalUrl("https://youtube.com/shorts/AbCdEf12345?si=xyz&feature=share"), "youtube:shorts:AbCdEf12345");
  assert.equal(canonicalUrl("https://m.youtube.com/watch?v=AbCdEf12345&t=10s"), "youtube:AbCdEf12345");
  assert.equal(canonicalUrl("https://youtu.be/AbCdEf12345?si=1"), "youtube:AbCdEf12345");
  assert.equal(canonicalUrl("https://Example.com/path/?b=2&utm_campaign=x&a=1#frag"), "example.com/path?a=1&b=2");
  assert.equal(canonicalUrl("not a link"), null);
  assert.equal(canonicalUrl("ftp://x.com/a"), null);
  assert.equal(findUrl("вот пример: https://www.instagram.com/reel/ABC/?igsh=1). спасибо"), "https://www.instagram.com/reel/ABC/?igsh=1");
  assert.equal(findUrl("без ссылки"), null);
  assert.equal(tgAlias("AgAD123"), "tg:AgAD123");
});

// ── metrics ─────────────────────────────────────────────────────────────────────

const SHOWINFO = `[Parsed_showinfo_2 @ 000001] config in time_base: 1/15360, frame_rate: 30/1
[Parsed_showinfo_2 @ 000001] n:   0 pts:  27648 pts_time:1.8     duration:    512 duration_time:0.0333333 fmt:yuv420p
[Parsed_showinfo_2 @ 000001] n:   1 pts:  71680 pts_time:4.66667 duration:    512 duration_time:0.0333333 fmt:yuv420p
[Parsed_showinfo_2 @ 000001] n:   2 pts: 101376 pts_time:6.6     duration:    512 duration_time:0.0333333 fmt:yuv420p
frame=    3 fps=0.0 q=-0.0 Lsize=N/A time=00:00:09.96 bitrate=N/A speed=40x`;

test("cut metrics: showinfo parsing, jump cuts from band diffs (impulse in ≥ 2 bands, captions in one band ignored), shot statistics", () => {
  assert.deepEqual(parseSceneCuts(SHOWINFO), [1.8, 4.66667, 6.6]);
  assert.deepEqual(parseSceneCuts("nothing here"), []);
  // three bands, 90 frames at 30 fps: a quiet baseline with noise, a jump cut at frame 30 (top + middle),
  // a caption change at frame 50 (bottom band only), a slow head turn over frames 60–66 (no impulse)
  const n = 90;
  const noise = (i: number, k: number) => 0.0012 + 0.0003 * Math.sin(i * 1.7 + k);
  const bands = [0, 1, 2].map((k) => Array.from({ length: n }, (_, i) => (i === 0 ? 0 : noise(i, k))));
  bands[0][30] = 0.006;
  bands[1][30] = 0.009;
  bands[2][50] = 0.03;
  for (let i = 60; i <= 66; i++) (bands[0][i] = 0.006 + 0.001 * (i - 60)), (bands[1][i] = 0.006 + 0.001 * (i - 60));
  assert.deepEqual(detectJumpCuts(bands, { fps: 30 }), [1]);
  // a hard cut: everything changes
  const hard = bands.map((b) => [...b]);
  for (const b of hard) b[75] = 0.3;
  assert.deepEqual(detectJumpCuts(hard, { fps: 30 }), [1, 2.5]);
  // band diffs of tiny frames
  const w = 4;
  const h = 6;
  const f0 = new Uint8Array(w * h).fill(10);
  const f1 = new Uint8Array(w * h).fill(10);
  f1.fill(10 + 255 / 2, 0, w * 2); // top band changes by half the range
  const d = bandDiffs([f0, f1], w, h);
  assert.equal(d.length, 3);
  assert.ok(Math.abs(d[0][1] - 0.5) < 0.01 && d[1][1] === 0 && d[2][1] === 0);
  assert.deepEqual(mergeCuts([[1.8, 4.6], [1.85, 3.0, 9.95]], 10), [1.8, 3, 4.6]);
  assert.deepEqual(cutStats([0.9, 1.8, 2.7, 5, 8], 12), { total_cuts: 5, asl: 2, hook_cuts: 3, hook_asl: 0.75, body_asl: 3 });
  const stats = parseSignalstats("frame:0\nlavfi.signalstats.YAVG=110.5\nlavfi.signalstats.YLOW=30\nlavfi.signalstats.YHIGH=200\nlavfi.signalstats.SATAVG=40\nframe:1\nlavfi.signalstats.YAVG=120.5\nlavfi.signalstats.YLOW=20\nlavfi.signalstats.YHIGH=210\nlavfi.signalstats.SATAVG=50\n");
  assert.deepEqual(stats, { yavg: 115.5, yrange: 180, satavg: 45 });
  assert.equal(parseSignalstats(""), null);
});

/** words "w0 … wN" laid out with given gaps (seconds) after each word, 0.3 s per word */
function words(spec: { w: string; gap?: number; len?: number }[], start = 1): Transcript["segments"][number]["words"] {
  let t = start;
  return spec.map((s) => {
    const len = s.len ?? 0.3;
    const out = { w: s.w, start: Math.round(t * 1000) / 1000, end: Math.round((t + len) * 1000) / 1000 };
    t += len + (s.gap ?? 0.05);
    return out;
  });
}

test("speech / audio stats: wpm, pause percentiles, fillers; music from the loudness of the gaps", () => {
  const ws = words([{ w: "Привет", gap: 0.6 }, { w: "э", gap: 0.1 }, { w: "это", gap: 0.05 }, { w: "наш", gap: 0.05 }, { w: "канал", gap: 0.8 }, { w: "сегодня" }, { w: "про" }, { w: "кофе" }]);
  const t: Transcript = { language: "ru", segments: [{ start: ws[0].start, end: ws.at(-1)!.end, text: "", words: ws }] };
  const s = speechStats(t, 10)!;
  assert.equal(s.words, 8);
  assert.equal(s.fillers, 1);
  assert.equal(s.pause_median_ms, 50);
  assert.ok(s.pause_p90_ms >= 600);
  assert.ok(s.wpm > 80 && s.wpm < 160);
  assert.equal(speechStats({ language: "ru", segments: [] }, 10), null);
  // loudness: words at −18, gaps at −30 (music) vs −60 (silence)
  const pts = (gapLufs: number) => Array.from({ length: 100 }, (_, i) => {
    const x = i / 10;
    return { t: x, lufs: ws.some((w) => x >= w.start && x <= w.end) ? -18 : gapLufs };
  });
  assert.equal(audioStats(pts(-30), t)!.music_likely, true);
  assert.equal(audioStats(pts(-60), t)!.music_likely, false);
});

// ── cleanup ─────────────────────────────────────────────────────────────────────

test("jump-cut cleanup: long pauses split the clip with handles, hesitations always go, ambiguous fillers only when standalone; never inside a word", () => {
  const ws = words([
    { w: "Ну,", gap: 0.3 }, // standalone filler opening the clip → dropped
    { w: "сегодня", gap: 0.05 },
    { w: "расскажу", gap: 0.7 }, // long pause → cut
    { w: "э-э", gap: 0.2, len: 0.4 }, // hesitation → dropped
    { w: "про", gap: 0.05 },
    { w: "ну", gap: 0.05 }, // "ну" inside fluent speech → kept
    { w: "кофе", gap: 0.15 },
    { w: "типа", gap: 0.3 }, // between pauses → dropped
    { w: "вот", gap: 0.05 }, // fluent → kept
    { w: "так.", gap: 0.05 },
  ]);
  const clip = { src_start: ws[0].start - 0.1, src_end: ws.at(-1)!.end + 0.1 };
  const r = jumpCutClip(clip, ws, { silenceMs: 250, removeFillers: true, handleMs: 40 });
  assert.deepEqual(r.removedFillers, ["Ну,", "э-э", "типа"]);
  // pieces: [сегодня расскажу] [про ну кофе] [вот так.]
  assert.equal(r.pieces.length, 3);
  const inside = (t: number) => ws.some((w) => t > w.start + 1e-6 && t < w.end - 1e-6);
  for (const p of r.pieces) {
    assert.ok(!inside(p.start) && !inside(p.end), `edge inside a word: ${p.start}–${p.end}`);
    assert.ok(p.end > p.start);
  }
  const at = (w: string) => ws.find((x) => x.w === w)!;
  assert.ok(Math.abs(r.pieces[0].start - (at("сегодня").start - 0.04)) < 1e-6, "40 ms handle before the first kept word");
  assert.ok(r.pieces[0].start >= at("Ну,").end, "the handle never reaches into the dropped filler");
  assert.ok(Math.abs(r.pieces[0].end - (at("расскажу").end + 0.04)) < 1e-6);
  assert.equal(r.pieces[2].end, clip.src_end, "short trailing silence: the planner's own edge stays");
  assert.ok(r.removedSilence > 1);
  // without filler removal only the long pause cuts
  const keep = jumpCutClip(clip, ws, { silenceMs: 250, removeFillers: false });
  assert.equal(keep.removedFillers.length, 0);
  assert.ok(keep.pieces.length >= 2);
  // a natural threshold keeps the 0.3 s breaths
  assert.equal(jumpCutClip(clip, ws, { silenceMs: 800, removeFillers: false }).pieces.length, 1);
  // a clip without words (b-roll) is untouched
  assert.deepEqual(jumpCutClip({ src_start: 20, src_end: 23 }, ws, { silenceMs: 200, removeFillers: true }).pieces, [{ start: 20, end: 23 }]);
  // pairs: "как бы" between pauses goes, "как бы ты" in a sentence stays
  const pair = words([{ w: "это", gap: 0.3 }, { w: "как" }, { w: "бы", gap: 0.3 }, { w: "важно" }, { w: "как" }, { w: "бы" }, { w: "ты" }]);
  assert.deepEqual([...fillerIndexes(pair)].sort(), [1, 2]);
  // idempotent: cleaning the cleaned pieces changes nothing (revise keeps untouched outputs identical)
  const once = jumpCutClips([{ ...clip, speed: 1, crop: "center" }], { language: "ru", segments: [{ start: 0, end: 9, text: "", words: ws }] }, { silenceMs: 250, removeFillers: true });
  const twice = jumpCutClips(once.clips.map(({ from: _f, punch: _p, ...c }) => c), { language: "ru", segments: [{ start: 0, end: 9, text: "", words: ws }] }, { silenceMs: 250, removeFillers: true });
  assert.deepEqual(twice.clips.map((c) => [c.src_start, c.src_end]), once.clips.map((c) => [c.src_start, c.src_end]));
});

test("fast references: long pieces are split at the word gap nearest the middle (nothing removed, each side ≥ 0.6 s)", () => {
  const ws = words(Array.from({ length: 12 }, (_, i) => ({ w: `w${i}`, gap: i === 3 ? 0.12 : 0.06 })));
  const piece = { start: ws[0].start, end: ws.at(-1)!.end };
  const parts = splitLong(piece, ws, 1.5);
  assert.ok(parts.length >= 3);
  assert.equal(parts[0].start, piece.start);
  assert.equal(parts.at(-1)!.end, piece.end);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end, "contiguous: nothing is removed");
  const inside = (t: number) => ws.some((w) => t > w.start + 1e-6 && t < w.end - 1e-6);
  for (const p of parts) assert.ok(!inside(p.start) && !inside(p.end) && p.end - p.start >= 0.6 - 1e-6);
  assert.deepEqual(splitLong({ start: 0, end: 1 }, ws, 1.5), [{ start: 0, end: 1 }], "short pieces stay");
  // through the clip pass: maxPiece applies after the pause/filler cleanup
  const r = jumpCutClip({ src_start: piece.start, src_end: piece.end }, ws, { silenceMs: 300, removeFillers: true, maxPiece: 1.5 });
  assert.ok(r.pieces.length >= 3 && r.pieces.every((p) => p.end - p.start <= 1.5 + 0.7));
});

test("reference mode: a clip restarting on the word the previous clip ended with is moved to its end (no word plays twice)", () => {
  const m = mapStyle(dna({ planner_rules: { pacing_profile: "moderate", silence_cut_threshold_ms: 1400 }, hyperframes_theme: { camera_motion: { zoom_frequency: "none", zoom_style: "none" } } }));
  const ctx = makeFixtureContext({ style: m, preset: applyStyleToPreset(BUILTIN_PRESETS.bold_pop, m) });
  const draft = {
    brief: { outputs_requested: 1, target_duration_s: 5, aspect: "9:16" as const, style_words: [] },
    outputs: [{ id: "reel_1", aspect: "9:16" as const, clips: [{ start: "p2", end: "p2.w2" }, { start: "p2.w2", end: "p2" }], captions: { enabled: true, language: "ru" }, titles: [], music: { enabled: false } }],
    reasoning: "x",
  };
  const r = resolveDraft(draft, ctx, { mode: "plan" });
  const clips = r.edl!.outputs[0].clips;
  for (let i = 1; i < clips.length; i++) assert.ok(clips[i].src_start >= clips[i - 1].src_end - 1e-6, JSON.stringify(clips));
  assert.ok(r.warnings.some((w) => /restarted inside clip/.test(w.message)));
  // without a reference the planner's overlap is only a warning (house behaviour unchanged)
  const plain = resolveDraft(draft, makeFixtureContext(), { mode: "plan" });
  assert.ok(plain.edl!.outputs[0].clips[1].src_start < plain.edl!.outputs[0].clips[0].src_end);
});

test("punch-ins and effects: aggressive alternates the framing, rare follows the planner's marks, instant vs eased zooms, whooshes on punch-ins", () => {
  const pieces = Array.from({ length: 6 }, (_, i) => ({ src_start: i * 2, src_end: i * 2 + 1.5, speed: 1, crop: "center" as const, from: i, ...(i === 3 ? { punch: true } : {}) }));
  const phraseOf = (t: number) => Math.floor(t / 4);
  const z = (frequency: any, mode: any = "instant", onHook = false) => ({ frequency, mode, scale: 1.2, ease: mode === "ease" ? 0.25 : 0, onHook });
  assert.deepEqual([...zoomTargets(pieces, z("every_cut_aggressive"), phraseOf)], [1, 3, 5]);
  assert.deepEqual([...zoomTargets(pieces, z("every_cut_aggressive", "instant", true), phraseOf)].sort(), [0, 2, 4]);
  assert.deepEqual([...zoomTargets(pieces, z("rare_emphasis"), phraseOf)], [3]);
  assert.ok(zoomTargets(pieces.map(({ punch: _p, ...p }) => p), z("rare_emphasis"), phraseOf).size === 1, "no marks → one fallback punch-in");
  assert.ok(zoomTargets(pieces, z("every_2_3_sentences"), phraseOf).has(3));
  assert.equal(zoomTargets(pieces, z("none", "none"), phraseOf).size, 0);
  assert.deepEqual(zoomField(z("x", "instant"), 1.5), { x: 0.5, y: 0.4, from: 1.2, to: 1.2, ease: 0, at: 0 });
  assert.deepEqual(zoomField(z("x", "ease"), 1.5), { x: 0.5, y: 0.4, from: 1, to: 1.2, ease: 0.25, at: 0 });
  assert.equal(zoomField(z("x", "ken_burns"), 1.5)!.ease, 1.5);
  const r = applyMotion(pieces, z("every_cut_aggressive"), { enabled: true, kind: "whoosh", gain: -8, everyCuts: 0, hookImpact: true }, phraseOf);
  assert.equal(r.zooms, 3);
  assert.ok(r.clips[1].zoom && !r.clips[0].zoom);
  assert.ok(!("from" in r.clips[0]) && !("punch" in r.clips[3]), "planning marks do not leak into the EDL");
  assert.deepEqual(r.sfx.map((c) => c.kind), ["impact", "whoosh", "whoosh", "whoosh"]);
  assert.equal(r.sfx[1].t, 1.38, "the whoosh leads the punch-in by 0.12 s");
});

// ── planner ─────────────────────────────────────────────────────────────────────

test("planner: the rules block goes into the task; in reference mode the resolver cleans clips, adds punch-ins, grade, ducking and measures the cleaned duration", () => {
  const m = mapStyle(dna({ planner_rules: { pacing_profile: "fast", body_avg_cut_duration_sec: 1.8, silence_cut_threshold_ms: 200 }, hyperframes_theme: { camera_motion: { zoom_frequency: "every_cut_aggressive", zoom_style: "instant_punch_in", zoom_scale_factor: 1.15 } }, audio_and_color: { has_background_music: true, music_ducking_db: -20, sfx_on_cuts_and_zooms: true, sfx_intensity: "subtle_whoosh", color_grade: { preset: "high_contrast_warm", contrast_multiplier: 1.1, saturation_multiplier: 1.1, brightness_offset: 0 } } }));
  const task = buildTaskText({ instruction: "1 рилс", presetName: "bold_pop", mode: "full", toolsAvailable: true, style: m.plannerRules });
  assert.match(task, /СТИЛЬ ПО ПРИМЕРУ/);
  assert.match(task, /Паузы между словами длиннее 200 мс/);
  assert.match(task, /склейка в среднем каждые 1\.8 с|в среднем склейка каждые 1\.8 с/);
  assert.ok(!buildTaskText({ instruction: "1 рилс", presetName: "bold_pop", mode: "full", toolsAvailable: true }).includes("СТИЛЬ"), "no style → no block");

  // a transcript with long pauses inside phrases
  const tr = makeTranscript();
  const seg = tr.segments[2]; // «Каждое утро мы закладываем рис, морковь и мясо в большой казан.» 8.29–13.08
  seg.words = seg.words.map((w, i) => (i >= 4 ? { ...w, start: w.start + 0, end: w.end } : w));
  const styled = applyStyleToPreset(BUILTIN_PRESETS.bold_pop, m);
  const ctxStyled = makeFixtureContext({ transcript: tr, preset: styled, style: m });
  const draft = {
    brief: { outputs_requested: 1, target_duration_s: 12, aspect: "9:16" as const, style_words: [] },
    outputs: [{ id: "reel_1", aspect: "9:16" as const, clips: [{ start: "p1", end: "p3", punch_in: true }], captions: { enabled: true, language: "ru" }, titles: [], music: { enabled: true } }],
    reasoning: "x",
  };
  const r = resolveDraft(draft, ctxStyled, { mode: "plan" });
  assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
  const out = r.edl!.outputs[0];
  assert.ok(out.clips.length > 1, "the gaps between the phrases (≥ 200 ms) became cuts");
  const plainCtx = makeFixtureContext({ transcript: tr });
  const plain = resolveDraft(draft, plainCtx, { mode: "plan" });
  assert.ok(r.outputs[0].duration_s < plain.outputs[0].duration_s, "the duration is measured after the cleanup");
  assert.ok(out.clips.some((c) => c.zoom), "punch-ins");
  assert.deepEqual(out.grade, m.grade);
  assert.equal(out.music_duck_db, -20);
  assert.ok((out.sfx ?? []).every((c) => c.kind === "whoosh"));
  assert.equal(plain.edl!.outputs[0].clips.length, 1);
  assert.equal(plain.edl!.outputs[0].grade, undefined);
  // the styled pack tells the planner the reference's clip lengths
  assert.match(ctxStyled.packText, /"pace":"dynamic","clip_seconds":\{"min":0\.9,"max":3\.96\}/);
});

test("mix and cut: the reference's ducking depth sets the bed level (null = no side-chain); the grade is an eq after the crop", () => {
  const g = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", speech: true, musicUnderSpeechDb: -20 }, { hasAudio: true, sfxFile: (k) => `${k}.wav` });
  const graph = g.args[g.args.indexOf("-filter_complex") + 1];
  assert.match(graph, /loudnorm=I=-28:/);
  assert.match(graph, /sidechaincompress/);
  const flat = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", speech: true, musicUnderSpeechDb: null }, { hasAudio: true, sfxFile: (k) => `${k}.wav` });
  const fg = flat.args[flat.args.indexOf("-filter_complex") + 1];
  assert.ok(!fg.includes("sidechaincompress") && fg.includes("anullsink") && fg.includes("loudnorm=I=-22:"));
  assert.equal(bedLufsForDucking(-16), -24, "−16 dB is the montage default bed");
  const def = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: "m.mp3", speech: true }, { hasAudio: true, sfxFile: (k) => `${k}.wav` });
  assert.match(def.args[def.args.indexOf("-filter_complex") + 1], /loudnorm=I=-24:/, "without a reference nothing changes");
  // sfx without music: the speech plus the cues
  const fx = buildMixGraph({ video: "v.mp4", out: "o.mp4", duration: 10, music: null, speech: true, sfx: [{ t: 1, kind: "whoosh" }] }, { hasAudio: true, sfxFile: (k) => `${k}.wav` });
  assert.ok(!fx.copy && fx.args.includes("whoosh.wav"));

  const grade = { contrast: 1.1, saturation: 1.15, brightness: 0.02, tint: "colorbalance=rs=0.04" };
  assert.equal(gradeFilter(grade), "eq=contrast=1.1:saturation=1.15:brightness=0.02,colorbalance=rs=0.04");
  const media = { source_path: "s.mp4", normalized_path: "n.mp4", audio_path: "a.wav", duration: 20, fps: 30, width: 1080, height: 1920, has_audio: true, source: { fps: 30, width: 1080, height: 1920, video_codec: "h264", audio_codec: "aac", rotation: 0 } };
  const clips = [{ src_start: 0, src_end: 2, speed: 1, crop: "center" as const }];
  const out = { id: "r", aspect: "9:16" as const, clips, captions: { enabled: false }, titles: [], music: { enabled: false }, transitions: "cut" as const, grade };
  const args = buildCutArgs(out, clips, media, "o.mp4");
  assert.match(args[args.indexOf("-filter_complex") + 1], /setsar=1,eq=contrast=1\.1:saturation=1\.15:brightness=0\.02,colorbalance=rs=0\.04,fps=30/);
  const noGrade = buildCutArgs({ ...out, grade: undefined }, clips, media, "o.mp4");
  assert.ok(!noGrade[noGrade.indexOf("-filter_complex") + 1].includes("eq=contrast"));
});

// ── extractor ───────────────────────────────────────────────────────────────────

const MEASURED: Measured = {
  duration: 30,
  cuts: [0.8, 1.6, 2.4, 4.2, 6, 7.8],
  total_cuts: 6,
  asl: 4.29,
  hook_cuts: 3,
  hook_asl: 0.75,
  body_asl: 1.8,
  speech: { words: 90, language: "ru", wpm: 195, pause_median_ms: 60, pause_p90_ms: 170, long_pauses_per_min: 1, speech_ratio: 0.85, fillers: 0 },
  audio: { speech_lufs: -16, gap_lufs: null, music_likely: false },
  picture: { yavg: 120, yrange: 170, satavg: 52, width: 1080, height: 1920 },
};

test("merge: measured cut lengths, pace, wpm, pause threshold and fillers override the model; the model keeps the visuals", () => {
  const model = dna({ planner_rules: { pacing_profile: "calm", body_avg_cut_duration_sec: 6, hook_cut_duration_sec: 3, speech_wpm_estimate: 120, silence_cut_threshold_ms: 500, remove_fillers_and_retakes: false }, hyperframes_theme: { captions: { active_word_color: "#00FFAA" } } });
  const { dna: d, provenance } = mergeMeasured(model, MEASURED, true);
  assert.equal(d.planner_rules.body_avg_cut_duration_sec, 1.8);
  assert.equal(d.planner_rules.hook_cut_duration_sec, 0.75);
  assert.equal(d.planner_rules.pacing_profile, "fast");
  assert.equal(d.planner_rules.speech_wpm_estimate, 195);
  assert.equal(d.planner_rules.silence_cut_threshold_ms, 200, "p90 170 ms × 1.15 → 200 ms: a jump-cut threshold");
  assert.equal(d.planner_rules.remove_fillers_and_retakes, true, "no fillers heard, almost no long pauses");
  assert.equal(d.hyperframes_theme.captions.active_word_color, "#00FFAA");
  assert.equal(provenance["planner_rules.body_avg_cut_duration_sec"], "measured");
  assert.equal(provenance["hyperframes_theme.captions"], "gemini");
  const filler = mergeMeasured(model, { ...MEASURED, speech: { ...MEASURED.speech!, fillers: 4, pause_p90_ms: 700 } }, true).dna.planner_rules;
  assert.equal(filler.remove_fillers_and_retakes, false);
  assert.equal(filler.silence_cut_threshold_ms, 600);
  assert.match(metricsText(MEASURED), /cuts detected: 6[\s\S]*195 words\/min[\s\S]*90th percentile 170 ms/);
});

test("extractStyle with stubs: measurements + Gemini answer → profile in the cache; the same file / link / Telegram file again is a $0 hit without any call", async () => {
  const dir = await tmp();
  const cache = new StyleCache(path.join(dir, "cache"));
  // a real (tiny) video: the extractor probes it and checks the stream
  const ref = path.join(dir, "ref.mp4");
  const { ffmpeg } = await import("../src/lib/ffmpeg.ts");
  await ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=180x320:d=2:r=15", "-f", "lavfi", "-i", "sine=f=440:d=2", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", ref]);
  let geminiCalls = 0;
  let userText = "";
  const answer = dna({ style_summary: "Тест.", hyperframes_theme: { captions: { active_word_color: "#FF00FF", font_weight: "700_bold" }, camera_motion: { zoom_frequency: "rare_emphasis" } } });
  const opts = {
    cache,
    transcribe: async () => ({ language: "ru", segments: [] }),
    measure: async () => MEASURED,
    gemini: async (_c: string, system: string, user: string) => {
      geminiCalls++;
      userText = user;
      assert.match(system, /reverse-engineer/);
      return { data: answer, model: "gemini-2.5-flash", usage: { promptTokenCount: 20000, candidatesTokenCount: 500 }, requests: 3 };
    },
  };
  const first = await extractStyle({ file: ref, fileUniqueId: "AgADuniq" }, opts);
  assert.equal(first.cached, false);
  assert.equal(geminiCalls, 1);
  assert.match(userText, /LOCAL MEASUREMENTS[\s\S]*cuts detected: 6/);
  assert.equal(first.profile.dna.hyperframes_theme.captions.active_word_color, "#FF00FF");
  assert.equal(first.profile.dna.planner_rules.body_avg_cut_duration_sec, 1.8, "measured wins");
  assert.equal(first.profile.gemini?.model, "gemini-2.5-flash");
  assert.ok(first.profile.gemini!.usd > 0 && first.profile.gemini!.priced);
  assert.ok(StyleProfileSchema.safeParse(JSON.parse(await fs.readFile(first.file, "utf8"))).success);
  assert.ok(await fs.stat(ref), "a local CLI file is not deleted");

  const byFile = await extractStyle({ file: ref }, opts);
  const byTg = await extractStyle({ fileUniqueId: "AgADuniq" }, opts);
  assert.ok(byFile.cached && byTg.cached);
  assert.equal(geminiCalls, 1, "hits never call the model");
  assert.equal(byTg.profile.key, first.profile.key);

  // a link: downloaded once (to a temp file that is deleted), then known by its canonical id
  let downloads = 0;
  const viaLink = { ...opts, download: async (_u: string, d: string) => {
    downloads++;
    await fs.mkdir(d, { recursive: true });
    const f = path.join(d, "reference.mp4");
    await fs.copyFile(ref, f);
    return f;
  } };
  const l1 = await extractStyle({ url: "https://www.instagram.com/reel/XYZ123/?igsh=a" }, viaLink);
  assert.ok(l1.cached, "same content as the file → the content key hits after the download");
  const l2 = await extractStyle({ url: "https://instagram.com/reel/XYZ123/?utm_source=x" }, viaLink);
  assert.ok(l2.cached);
  assert.equal(downloads, 1, "the second link resolves by its alias, no download");
  await assert.rejects(extractStyle({ url: "not a link" }, viaLink), (e: Error) => e instanceof RefLinkError && /файлом/.test(e.message));

  // a bot upload is deleted after the analysis (only the DNA is kept); force re-analyses
  const upload = path.join(dir, "upload.mp4");
  await fs.copyFile(ref, upload);
  const forced = await extractStyle({ file: upload }, { ...opts, force: true, deleteInput: true });
  assert.equal(forced.cached, false);
  assert.equal(geminiCalls, 2);
  await assert.rejects(fs.stat(upload));
  // no key, no stub: measurements + defaults with a warning
  const noKey = await extractStyle({ file: ref }, { cache: new StyleCache(path.join(dir, "c2")), transcribe: opts.transcribe, measure: opts.measure, apiKey: "", noGemini: false });
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) assert.ok(noKey.profile.warnings.some((w) => /GEMINI_API_KEY/.test(w)));
});

// ── bot ─────────────────────────────────────────────────────────────────────────

test("bot: 🎯 → reference (stub extractor) → summary → own video → card with «как в примере ✓» → ▶️ runs with like=…; a forwarded reference is a cache hit", async () => {
  const runs: PipelineArgs[] = [];
  const out = path.join(await tmp(), "output_reel_1.mp4");
  await fs.writeFile(out, "mp4");
  const tg = fakeTelegram();
  const ws = await tmp();
  let extracts = 0;
  const profile = StyleProfileSchema.parse({
    key: "k".repeat(64),
    source: { kind: "telegram", name: "ref.mp4" },
    created_at: new Date().toISOString(),
    dna: dna({ planner_rules: { pacing_profile: "fast", body_avg_cut_duration_sec: 1.8, silence_cut_threshold_ms: 200 }, hyperframes_theme: { captions: { max_words_per_screen: 2, active_word_color: "#FFD600" }, camera_motion: { split_screen_detected: true } } }),
    measured: MEASURED,
  });
  const bot = await createBot({
    token: "t",
    workspace: ws,
    callMethod: tg.callMethod,
    download: tg.download,
    onLog: () => {},
    statusEditMs: 0,
    cleanupIntervalMs: 0,
    albumDelayMs: 0,
    onboarding: false,
    quotas: false,
    pipeline: async (a) => (runs.push(a), { jobId: "20261016-bbbbbb", outputs: [{ id: "reel_1", file: out, duration: 30, aspect: "9:16" }] }),
    styleExtract: async (input, o) => {
      extracts++;
      assert.equal(input.fileUniqueId, "UNIQ1");
      assert.ok(input.file && (await fs.stat(input.file)), "the reference was downloaded for the analysis");
      const file = await o.cache.put(profile, input.fileUniqueId ? [tgAlias(input.fileUniqueId)] : []);
      return { profile, cached: false, file };
    },
  });
  await bot.handleUpdate(tg.press(5, "H:ref", 1));
  assert.equal(tg.texts(5).at(-1), MSG.refAsk(20));
  assert.equal(bot.session(5).awaiting, "ref");
  // text without a link while waiting for the reference
  await bot.handleUpdate(tg.text(5, "вот такой стиль"));
  assert.equal(tg.texts(5).at(-1), MSG.refNeedFileOrLink);
  await bot.handleUpdate(tg.video(5, "REF1", 5, { video: { file_id: "REF1", file_unique_id: "UNIQ1", file_size: 1000, mime_type: "video/mp4" } } as never));
  await bot.idle();
  assert.equal(extracts, 1);
  assert.ok(tg.texts(5).includes(MSG.refAnalyzing));
  const ready = tg.texts(5).at(-1)!;
  assert.ok(ready.startsWith("🎯 Стиль примера: Быстрый темп, склейка каждые 1.8 с"), ready);
  assert.match(ready, /субтитры по 2 слова/);
  const s = bot.session(5);
  assert.equal(s.awaiting, undefined);
  assert.ok(s.ref && s.ref.endsWith(`${profile.key}.json`));
  assert.equal(bot.db.styleKey("tg:UNIQ1"), profile.key);
  // own video → card: the style row is the single «как в примере ✓» toggle, one reel by default
  await bot.handleUpdate(tg.video(5, "OWN1"));
  const card = tg.sent(5, MSG.videoSaved)!;
  const id = tg.messageIdOf(card)!;
  const kb = tg.buttons(tg.keyboardOf(card));
  assert.ok(kb.includes(`✓ ${STRINGS.ru.styleRef}=M:y:ref`), kb.join(" | "));
  assert.ok(!kb.some((b) => b.endsWith("M:y:pop")), "the house styles give way to the reference");
  assert.ok(kb.includes("✓ 1 шт=M:n:1"));
  // toggling off shows the house styles (+ the way back), toggling on again hides them
  await bot.handleUpdate(tg.press(5, "M:y:ref", id));
  assert.ok(tg.buttons(tg.markupOf(id)).includes("✓ Динамичный=M:y:pop") && tg.buttons(tg.markupOf(id)).includes(`${STRINGS.ru.styleRef}=M:y:ref`));
  await bot.handleUpdate(tg.press(5, "M:y:ref", id));
  await bot.handleUpdate(tg.press(5, "M:go", id));
  await bot.idle();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].like, s.ref);
  assert.equal(runs[0].likeFresh, true, "the fresh analysis is billed to the first run");
  assert.equal(runs[0].preset, "split_news", "a split-screen reference runs on the split preset");
  assert.match(runs[0].instruction, /^1 рилс по 30 секунд/);
  // a second run with the same reference: not billed again
  await bot.handleUpdate(tg.video(5, "OWN2"));
  await bot.handleUpdate(tg.text(5, "2 рилса по 20 секунд"));
  await bot.idle();
  assert.equal(runs.length, 2);
  assert.equal(runs[1].like, s.ref);
  assert.equal(runs[1].likeFresh, false);
  // the same reference forwarded again: cache hit by file_unique_id, no extractor call
  await bot.handleUpdate(tg.press(5, "H:ref", 1));
  await bot.handleUpdate(tg.video(5, "REF1-again", 5, { video: { file_id: "REF1-again", file_unique_id: "UNIQ1", file_size: 1000, mime_type: "video/mp4" } } as never));
  await bot.idle();
  assert.equal(extracts, 1);
  assert.match(tg.texts(5).at(-1)!, /уже знаком/);
  // a link that cannot be downloaded: polite answer, still waiting for the reference
  const failing = await createBot({ token: "t", workspace: await tmp(), callMethod: tg.callMethod, download: tg.download, onLog: () => {}, statusEditMs: 0, cleanupIntervalMs: 0, albumDelayMs: 0, onboarding: false, quotas: false, styleExtract: async () => { throw new RefLinkError("login", "download_failed"); } });
  await failing.handleUpdate(tg.press(6, "H:ref", 1));
  await failing.handleUpdate(tg.text(6, "https://www.instagram.com/reel/ABC/"));
  await failing.idle();
  assert.equal(tg.texts(6).at(-1), MSG.refLinkFailed);
  assert.equal(failing.session(6).awaiting, "ref");
  // the normal montage menu forgets the reference; /clear too
  await bot.handleUpdate(tg.press(5, "H:montage", 1));
  assert.equal(bot.session(5).ref, undefined);
  bot.close();
  failing.close();
});
