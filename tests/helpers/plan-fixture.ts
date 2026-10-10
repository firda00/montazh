// In-memory analysis of a 35 s clip mirroring job 20261010-7d76cd: 8 phrases (ru×6, en×2),
// a scene boundary at 8.50 s inside the word «Каждое» (8.29–8.74), 3 stub scenes, 8 highlights.
import type { Highlights, Media, PlanDraft, Scenes, Transcript } from "../../src/schemas/index.ts";
import { buildPlanContext, type PlanContext } from "../../src/plan/context.ts";
import { BUILTIN_PRESETS } from "../../src/plan/presets.ts";

const PHRASES: [number, number, string, string][] = [
  [0.0, 2.3, "ru", "Добро пожаловать в наше кафе."],
  [3.2, 5.75, "ru", "Здесь готовят лучший плов в городе."],
  [8.29, 13.08, "ru", "Каждое утро мы закладываем рис, морковь и мясо в большой казан."],
  [14.0, 16.42, "ru", "Огонь, специи и много терпения."],
  [19.6, 22.34, "ru", "Попробуйте нашу самсу прямо из тандыра."],
  [23.36, 27.16, "ru", "Ждём вас каждый день с 9 утра до 11 вечера."],
  [29.37, 30.35, "en", "Thank you for watching."],
  [31.36, 32.07, "en", "See you soon."],
];

function phrase(start: number, end: number, lang: string, text: string): Transcript["segments"][number] {
  const tokens = text.split(" ");
  const slot = (end - start) / tokens.length;
  const words = tokens.map((w, i) => ({ w, start: Math.round((start + i * slot) * 1000) / 1000, end: Math.round((start + (i + 1) * slot - 0.02) * 1000) / 1000 }));
  words[words.length - 1].end = end;
  return { start, end, text, words, lang };
}

export function makeTranscript(): Transcript {
  const segments = PHRASES.map((p) => phrase(...p));
  // pin «Каждое» to the measured span so a scene edge at 8.50 lands inside it
  segments[2].words[0] = { w: "Каждое", start: 8.29, end: 8.74 };
  segments[2].words[1].start = 8.74;
  return { language: "ru", segments };
}

export const MEDIA: Media = {
  source_path: "C:/fixture/cafe.mp4",
  normalized_path: "C:/fixture/normalized.mp4",
  audio_path: "C:/fixture/audio.wav",
  duration: 35,
  fps: 30,
  width: 1920,
  height: 1080,
  has_audio: true,
  source: { fps: 30, width: 1920, height: 1080, video_codec: "h264", audio_codec: "aac", rotation: 0 },
};

export const SCENES: Scenes = [
  { start: 0, end: 8.5, description: "[stub] shot 0, 8.5s, speech", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
  { start: 8.5, end: 23.1, description: "[stub] shot 1, 14.6s, speech", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
  { start: 23.1, end: 35, description: "[stub] shot 2, 11.9s, speech", objects: [], people_count: 0, emotion: "unknown", shot_type: "unknown", quality_score: 0.5 },
];

export const HIGHLIGHTS: Highlights = PHRASES.map(([start, end, , text], i) => ({ start, end, reason: `[stub] complete phrase: "${text}"`, score: Math.round((0.8 - i * 0.05) * 100) / 100 }));

export function makeFixtureContext(overrides: Partial<Parameters<typeof buildPlanContext>[0]> = {}): PlanContext {
  return buildPlanContext({ media: MEDIA, transcript: makeTranscript(), scenes: SCENES, highlights: HIGHLIGHTS, preset: BUILTIN_PRESETS.bold_pop, ...overrides });
}

export const GOOD_DRAFT: PlanDraft = {
  brief: { outputs_requested: 2, target_duration_s: 15, aspect: "9:16", captions_language: "uz", style_words: ["динамично"] },
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
      captions: { enabled: true, language: "uz", style: "bold_pop" },
      titles: [{ at: 0, text: "Лучший плов в городе", style: "hero" }],
      music: { enabled: false },
    },
    {
      id: "wide_1",
      aspect: "16:9",
      clips: [{ start: "p6", end: "p7" }],
      captions: { enabled: true, language: "en" },
      titles: [],
      music: { enabled: false },
    },
  ],
  reasoning: "Выбраны приветствие, процесс готовки и приглашение; хвост на английском — отдельным широким роликом.",
};

export const BAD_DRAFT_UNKNOWN_REF: PlanDraft = {
  ...GOOD_DRAFT,
  outputs: [{ ...GOOD_DRAFT.outputs[0], clips: [{ start: "p99", end: "p2" }] }, GOOD_DRAFT.outputs[1]],
};

/** Minimal JPEG marker bytes — enough for the preview_frame tool to read and base64 a file. */
export const TINY_JPEG = Buffer.from("ffd8ffd9", "hex");

/** A transcript long enough to force COMPACT mode (~25 min of speech). */
export function longTranscript(phrases = 900): Transcript {
  const segments: Transcript["segments"] = [];
  for (let i = 0; i < phrases; i++) {
    const start = i * 1.7;
    segments.push(phrase(start, start + 1.5, "ru", `Фраза номер ${i} про плов, самсу, казан и ещё немного слов для объёма текста.`));
  }
  return { language: "ru", segments };
}
