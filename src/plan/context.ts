import { createHash } from "node:crypto";
import type { Highlights, Media, Preset, Scenes, Transcript } from "../schemas/index.ts";

type Word = Transcript["segments"][number]["words"][number];

export interface CtxPhrase {
  id: string;
  index: number;
  start: number;
  end: number;
  lang: string;
  text: string;
  words: Word[];
}
export interface CtxScene {
  id: string;
  index: number;
  start: number;
  end: number;
  description: string;
  objects: string[];
  people_count: number;
  emotion: string;
  shot_type: string;
  quality_score: number;
  is_stub: boolean;
  phrases: string[];
}
export interface CtxGap {
  id: string;
  start: number;
  end: number;
}
export interface CtxHighlight {
  id: string;
  rank: number;
  score: number;
  start: number;
  end: number;
  phrases: string[];
  reason: string;
}

export type PackMode = "full" | "compact";

export interface PlanContext {
  media: Media;
  transcript: Transcript;
  preset: Preset;
  duration: number;
  phrases: CtxPhrase[];
  scenes: CtxScene[];
  gaps: CtxGap[];
  highlights: CtxHighlight[];
  mode: PackMode;
  packText: string;
  packHash: string;
  tokenEstimate: number;
}

export const MIN_GAP = 0.5;
export const COMPACT_ABOVE_TOKENS = 40_000;
export const MAX_HIGHLIGHTS = 40;

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Conservative token estimate (Cyrillic ≈ 2.8 chars/token). */
export function estimateTokens(text: string) {
  return Math.ceil(text.length / 2.8);
}

export function phrasesOverlapping(ctx: Pick<PlanContext, "phrases">, start: number, end: number) {
  return ctx.phrases.filter((p) => p.start < end && p.end > start);
}

function gapsFromPhrases(phrases: CtxPhrase[], duration: number): CtxGap[] {
  const spans: { start: number; end: number }[] = [];
  let cursor = 0;
  for (const p of phrases) {
    if (p.start - cursor >= MIN_GAP) spans.push({ start: cursor, end: p.start });
    cursor = Math.max(cursor, p.end);
  }
  if (duration - cursor >= MIN_GAP) spans.push({ start: cursor, end: duration });
  return spans.map((s, i) => ({ id: `g${i}`, start: round2(s.start), end: round2(s.end) }));
}

export interface ContextInput {
  media: Media;
  transcript: Transcript;
  scenes: Scenes;
  highlights: Highlights;
  preset: Preset;
}

export function buildPlanContext(input: ContextInput): PlanContext {
  const duration = input.media.duration;
  const phrases: CtxPhrase[] = [...input.transcript.segments]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({ id: `p${i}`, index: i, start: s.start, end: s.end, lang: s.lang ?? input.transcript.language, text: s.text, words: s.words }));
  const base = { phrases };
  const scenes: CtxScene[] = [...input.scenes]
    .sort((a, b) => a.start - b.start)
    .map((s, i) => ({
      id: `s${i}`,
      index: i,
      start: s.start,
      end: s.end,
      description: s.description,
      objects: s.objects,
      people_count: s.people_count,
      emotion: s.emotion,
      shot_type: s.shot_type,
      quality_score: s.quality_score,
      is_stub: s.description.startsWith("[stub]"),
      phrases: phrasesOverlapping(base, s.start, s.end).map((p) => p.id),
    }));
  const gaps = gapsFromPhrases(phrases, duration);
  const highlights: CtxHighlight[] = [...input.highlights]
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_HIGHLIGHTS)
    .map((h, i) => ({ id: `h${i}`, rank: i + 1, score: h.score, start: h.start, end: h.end, phrases: phrasesOverlapping(base, h.start, h.end).map((p) => p.id), reason: h.reason }));

  const partial = { media: input.media, transcript: input.transcript, preset: input.preset, duration, phrases, scenes, gaps, highlights };
  let mode: PackMode = "full";
  let packText = renderPack({ ...partial, mode });
  if (estimateTokens(packText) > COMPACT_ABOVE_TOKENS) {
    mode = "compact";
    packText = renderPack({ ...partial, mode });
  }
  return { ...partial, mode, packText, packHash: createHash("sha256").update(packText).digest("hex"), tokenEstimate: estimateTokens(packText) };
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Deterministic, job-static text: fixed key order, rounded numbers, no paths or timestamps. */
export function renderPack(ctx: Omit<PlanContext, "packText" | "packHash" | "tokenEstimate">): string {
  const compact = ctx.mode === "compact";
  const langs = [...new Set(ctx.phrases.map((p) => p.lang))].sort();
  const pack = {
    media: {
      duration_s: round2(ctx.duration),
      fps: ctx.media.fps,
      w: ctx.media.width,
      h: ctx.media.height,
      has_audio: ctx.media.has_audio,
      language: ctx.transcript.language,
      languages: langs,
      mode: ctx.mode,
    },
    preset: {
      name: ctx.preset.name,
      pace: ctx.preset.pace,
      clip_seconds: { min: ctx.preset.clip_seconds.min, max: ctx.preset.clip_seconds.max },
      caption_style: ctx.preset.caption_style,
      title_style: ctx.preset.title_style,
      default_aspect: ctx.preset.default_aspect,
      notes: ctx.preset.notes,
    },
    phrases: ctx.phrases.map((p) => ({ id: p.id, start: round2(p.start), end: round2(p.end), lang: p.lang, text: compact ? cut(p.text, 60) : p.text })),
    gaps: ctx.gaps.map((g) => ({ id: g.id, start: round2(g.start), end: round2(g.end) })),
    scenes: ctx.scenes.map((s) => ({
      id: s.id,
      start: round2(s.start),
      end: round2(s.end),
      shot_type: s.shot_type,
      people: s.people_count,
      emotion: s.emotion,
      q: round2(s.quality_score),
      is_stub: s.is_stub,
      description: cut(s.description, compact ? 80 : 160),
      phrases: s.phrases,
    })),
    highlights: ctx.highlights.map((h) => ({ id: h.id, rank: h.rank, score: round2(h.score), start: round2(h.start), end: round2(h.end), phrases: h.phrases, reason: cut(h.reason, compact ? 80 : 200) })),
  };
  return JSON.stringify(pack);
}
