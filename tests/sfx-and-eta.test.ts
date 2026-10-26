import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateEta, formatDuration, formatQueuedEta, formatRunningEta } from "../src/lib/eta.ts";
import { styleFromText } from "../src/bot/index.ts";
import { resolveDraft } from "../src/plan/resolve.ts";
import { makeFixtureContext, GOOD_DRAFT } from "./helpers/plan-fixture.ts";
import { BUILTIN_PRESETS } from "../src/plan/presets.ts";
import type { PlanDraft } from "../src/schemas/index.ts";

test("ETA: formatDuration formats seconds accurately in ru/uz/en", () => {
  assert.equal(formatDuration(25, "ru"), "25 сек");
  assert.equal(formatDuration(60, "ru"), "1 мин");
  assert.equal(formatDuration(95, "ru"), "1 мин 35 сек");

  assert.equal(formatDuration(25, "uz"), "25 soniya");
  assert.equal(formatDuration(60, "uz"), "1 daqiqa");
  assert.equal(formatDuration(95, "uz"), "1 daq 35 son");

  assert.equal(formatDuration(25, "en"), "25s");
  assert.equal(formatDuration(60, "en"), "1 min");
  assert.equal(formatDuration(95, "en"), "1m 35s");
});

test("ETA: calculateEta estimates remaining time and target completion time", () => {
  const started = Date.now() - 30_000; // 30s elapsed
  const res = calculateEta({
    startedAt: started,
    pct: 50, // 50% done in 30s -> ~30s remaining
    kind: "run",
  });

  assert.ok(res.remainingSeconds >= 25 && res.remainingSeconds <= 35, `expected ~30s, got ${res.remainingSeconds}s`);
  assert.match(res.timeStr, /^\d{2}:\d{2}$/);
  assert.ok(res.targetDate.getTime() > Date.now());

  const runningStr = formatRunningEta({ startedAt: started, pct: 50, kind: "run" }, "ru");
  assert.match(runningStr, /⏳ Готовность: ~\d{2}:\d{2} \(осталось ~\d+ сек\)/);

  const runningUz = formatRunningEta({ startedAt: started, pct: 50, kind: "uz" }, "uz");
  assert.match(runningUz, /⏳ Tayyor bo‘lishi: ~\d{2}:\d{2}/);

  const queuedStr = formatQueuedEta(1, "run", "ru");
  assert.match(queuedStr, /⏳ Примерное время готовности: ~\d{2}:\d{2} \(через ~1 мин\)/);
});

test("styleFromText: recognizes any montage style request", () => {
  assert.equal(styleFromText("сделай динамичный поп-стиль"), "bold_pop");
  assert.equal(styleFromText("2 рилса в стиле bold_pop"), "bold_pop");
  assert.equal(styleFromText("хайлайты игры баскетбол броски"), "sport_highlights");
  assert.equal(styleFromText("спокойный монтаж для подкаста"), "calm");
  assert.equal(styleFromText("чистые субтитры как у экспертов"), "clean_min");
  assert.equal(styleFromText("плашка с подсветкой караоке"), "box_reveal");
  assert.equal(styleFromText("в стиле сплит как у aleko"), "split_news");
  assert.equal(styleFromText("эксплейнер инфографика"), "explainer");
  assert.equal(styleFromText("в стиле аброра"), "abror_split");
  assert.equal(styleFromText("аброр весь кадр с фото"), "abror_full");
  assert.equal(styleFromText("3 рилса по 30 секунд"), undefined); // default falls back to user preset
});

test("SFX: automatic sound effects generation for dynamic montage", () => {
  const ctx = makeFixtureContext({ preset: BUILTIN_PRESETS.bold_pop });
  const draft: PlanDraft = {
    brief: { outputs_requested: 1, target_duration_s: 15, aspect: "9:16", style_words: ["динамично", "со", "звуками"] },
    outputs: [
      {
        id: "reel_1",
        aspect: "9:16",
        target_duration: 15,
        hook: "лучший плов в городе",
        clips: [
          { start: "p0", end: "p0", crop: "auto_face" },
          { start: "p2", end: "p2" },
          { start: "p4", end: "p5" },
        ],
        captions: { enabled: true, language: "ru", style: "bold_pop" },
        titles: [{ at: 0.5, text: "Вкуснейший плов", style: "hero" }],
        music: { enabled: true },
      },
    ],
    reasoning: "Монтаж со звуковыми эффектами и динамичными склейками",
  };

  const r = resolveDraft(draft, ctx, { mode: "plan" });
  assert.equal(r.errors.length, 0);
  assert.ok(r.edl);
  const out = r.edl!.outputs[0];
  assert.ok(out.sfx && out.sfx.length > 0, "sfx cues should be populated");

  // Verify key sound effect kinds
  const kinds = out.sfx!.map((c) => c.kind);
  assert.ok(kinds.includes("impact"), "hook impact cue expected at start");
  assert.ok(kinds.includes("pop"), "title pop cue expected at title time");
  assert.ok(kinds.includes("whoosh"), "whoosh cue expected at cuts");

  // Verify title pop cue timestamp
  const popCue = out.sfx!.find((c) => c.kind === "pop");
  assert.ok(popCue && Math.abs(popCue.t - 0.5) < 0.05, "pop cue should match title timestamp");
});

test("SFX: explicit no-sfx disables sound effects", () => {
  const ctx = makeFixtureContext({ preset: BUILTIN_PRESETS.bold_pop });
  const draft: PlanDraft = {
    brief: { outputs_requested: 1, aspect: "9:16", style_words: ["без", "звуков", "no-sfx"] },
    outputs: [
      {
        id: "reel_1",
        aspect: "9:16",
        hook: "тихий ролик",
        clips: [{ start: "p0", end: "p0" }],
        captions: { enabled: false },
        titles: [],
        music: { enabled: false },
        sfx: { enabled: false },
      },
    ],
    reasoning: "Смонтируй без звуковых эффектов",
  };

  const r = resolveDraft(draft, ctx, { mode: "plan" });
  assert.equal(r.errors.length, 0);
  assert.ok(r.edl);
  assert.equal(r.edl!.outputs[0].sfx, undefined, "sfx should be disabled");
});
