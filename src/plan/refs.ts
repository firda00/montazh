import type { Edl, PlanDraft } from "../schemas/index.ts";
import type { PlanContext } from "./context.ts";

export type Side = "start" | "end";

export type ParsedRef =
  | { kind: "p" | "s" | "g"; n: number; edge?: "start" | "end" | "mid" }
  | { kind: "w"; n: number; k: number }
  | { kind: "t"; seconds: number };

const ID_RE = /^([psg])(\d+)(?:\.(start|end|mid))?$/;
const WORD_RE = /^p(\d+)\.w(\d+)$/;
const TIME_RE = /^t(\d+(?:\.\d+)?)$/;

export function parseRef(ref: string): ParsedRef | null {
  let m = WORD_RE.exec(ref);
  if (m) return { kind: "w", n: Number(m[1]), k: Number(m[2]) };
  m = ID_RE.exec(ref);
  if (m) return { kind: m[1] as "p" | "s" | "g", n: Number(m[2]), edge: m[3] as "start" | "end" | "mid" | undefined };
  m = TIME_RE.exec(ref);
  if (m) return { kind: "t", seconds: Number(m[1]) };
  return null;
}

export type ResolvedRef = { ok: true; t: number; parsed: ParsedRef } | { ok: false; error: string; parsed: ParsedRef | null };

/** Turns a ref into seconds. For `start` the default edge of pN/sN is its start, for `end` its end; gN means "cut inside the pause". */
export function resolveRef(ref: string, side: Side, ctx: PlanContext): ResolvedRef {
  const parsed = parseRef(ref);
  if (!parsed) return { ok: false, error: `"${ref}" is not a ref (expected p12, s3, g7, p12.end, p12.w4)`, parsed: null };
  if (parsed.kind === "t") return { ok: true, t: parsed.seconds, parsed };
  if (parsed.kind === "w") {
    const p = ctx.phrases[parsed.n];
    if (!p) return { ok: false, error: `unknown phrase p${parsed.n} (last is p${ctx.phrases.length - 1})`, parsed };
    const w = p.words[parsed.k];
    if (!w) return { ok: false, error: `phrase p${parsed.n} has words w0..w${p.words.length - 1}, not w${parsed.k}`, parsed };
    return { ok: true, t: side === "start" ? w.start : w.end, parsed };
  }
  const list = parsed.kind === "p" ? ctx.phrases : parsed.kind === "s" ? ctx.scenes : ctx.gaps;
  const item = list[parsed.n];
  if (!item) {
    const name = parsed.kind === "p" ? "phrase" : parsed.kind === "s" ? "scene" : "gap";
    return { ok: false, error: list.length ? `unknown ${name} ${ref} (last is ${parsed.kind}${list.length - 1})` : `there are no ${name}s in this video`, parsed };
  }
  const edge = parsed.edge ?? (parsed.kind === "g" ? (side === "start" ? "end" : "start") : side);
  const t = edge === "start" ? item.start : edge === "end" ? item.end : (item.start + item.end) / 2;
  return { ok: true, t, parsed };
}

/** The id of a known boundary within `tol` of t, or null. Used to express an existing EDL as refs (revise). */
export function nearestBoundaryRef(t: number, side: Side, ctx: PlanContext, tol = 0.03): string | null {
  const near = (a: number) => Math.abs(a - t) <= tol;
  const other = side === "start" ? "end" : "start";
  // natural edges first (phrase/scene start for a clip start), then gaps, then the opposite edges, then words
  for (const p of ctx.phrases) if (near(side === "start" ? p.start : p.end)) return p.id;
  for (const s of ctx.scenes) if (near(side === "start" ? s.start : s.end)) return s.id;
  for (const g of ctx.gaps) if (near(side === "start" ? g.end : g.start)) return g.id;
  for (const p of ctx.phrases) if (near(side === "start" ? p.end : p.start)) return `${p.id}.${other}`;
  for (const s of ctx.scenes) if (near(side === "start" ? s.end : s.start)) return `${s.id}.${other}`;
  for (const p of ctx.phrases) {
    for (const [k, w] of p.words.entries()) if (near(side === "start" ? w.start : w.end)) return `${p.id}.w${k}`;
  }
  return null;
}

/** Expresses an EDL as a draft (refs where a boundary matches, `tS` otherwise) so revise can show the current plan. */
export function draftFromEdl(edl: Edl, ctx: PlanContext): PlanDraft {
  const asRef = (t: number, side: Side) => nearestBoundaryRef(t, side, ctx) ?? `t${t.toFixed(3)}`;
  const outputs = edl.outputs.map((o) => ({
    id: o.id,
    aspect: o.aspect,
    target_duration: o.target_duration,
    clips: o.clips.map((c) => ({ start: asRef(c.src_start, "start"), end: asRef(c.src_end, "end"), speed: c.speed, crop: c.crop })),
    captions: { enabled: o.captions.enabled, language: o.captions.language, style: o.captions.style },
    titles: o.titles.map((t) => ({ at: t.at, duration: t.duration, text: t.text, style: t.style })),
    music: { enabled: o.music.enabled },
  }));
  // No synthesized counts/targets: each carried output already has its own target_duration and
  // aspect, and a brief target or count would leak into sibling outputs the edit never touched.
  return {
    brief: {
      captions_language: edl.outputs.find((o) => o.captions.language)?.captions.language,
      style_words: [],
    },
    outputs,
    reasoning: edl.reasoning,
  };
}
