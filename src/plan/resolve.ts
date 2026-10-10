import type { z } from "zod";
import { EdlSchema, type Edl, type OutputSchema, type PlanDraft, type PlanIssue } from "../schemas/index.ts";
import { checkClipBoundaries } from "./validate.ts";
import type { PlanContext } from "./context.ts";
import { parseRef, resolveRef } from "./refs.ts";

export interface ResolvedClip {
  /** index of the clip in the model's draft (messages use it, so skipped clips do not shift numbering) */
  index: number;
  start: number;
  end: number;
  from: string;
  to: string;
  speed: number;
  crop: "center" | "auto_face";
}
export interface ResolvedOutput {
  id: string;
  aspect: string;
  errors: PlanIssue[];
  warnings: PlanIssue[];
  clips: ResolvedClip[];
  duration_s: number;
  target_s: number | null;
  captions_language: string | null;
  output?: z.input<typeof OutputSchema>;
}
export interface ResolvedDraft {
  edl: z.input<typeof EdlSchema> | null;
  outputs: ResolvedOutput[];
  issues: PlanIssue[];
  errors: PlanIssue[];
  warnings: PlanIssue[];
}
export interface ResolveOptions {
  mode: "plan" | "revise";
  currentEdl?: Edl;
  /** how far a clip edge may move to keep a word whole (seconds) */
  maxSnap?: number;
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Times that already appear as clip edges in the current EDL (revise mode may keep them as tS refs). */
function knownTimes(edl?: Edl): { keys: Set<string>; times: number[] } {
  const keys = new Set<string>();
  const times: number[] = [];
  for (const o of edl?.outputs ?? []) for (const c of o.clips) for (const t of [c.src_start, c.src_end]) keys.add(t.toFixed(3)), times.push(t);
  return { keys, times };
}

/** In revise mode an edge within `tol` of an existing edge keeps the existing value, so untouched outputs stay byte-identical. */
function anchorToCurrent(t: number, times: number[], tol = 0.03): number {
  let best = t;
  let bestDiff = tol;
  for (const k of times) {
    const d = Math.abs(k - t);
    if (d <= bestDiff) (best = k), (bestDiff = d);
  }
  return best;
}

function hasSpeech(ctx: PlanContext, start: number, end: number) {
  return ctx.phrases.some((p) => p.start < end && p.end > start);
}

/**
 * The single validator behind the harness check, validate_edl, submit_edl and revise.
 * Resolves refs to seconds, keeps words whole, checks durations and builds the EDL.
 */
export function resolveDraft(draft: PlanDraft, ctx: PlanContext, opts: ResolveOptions): ResolvedDraft {
  const maxSnap = opts.maxSnap ?? 0.4;
  const known = knownTimes(opts.currentEdl);
  const outputs: ResolvedOutput[] = [];
  const global: PlanIssue[] = [];
  if (draft.outputs.length === 0) global.push({ severity: "error", code: "no_outputs", message: "the plan has no outputs" });
  // the requested count is checked for fresh plans only: an edit may add or remove outputs
  if (opts.mode === "plan" && draft.brief.outputs_requested !== undefined && draft.outputs.length > 0 && draft.brief.outputs_requested !== draft.outputs.length) {
    global.push({ severity: "error", code: "count_mismatch", message: `brief says ${draft.brief.outputs_requested} outputs were requested but the plan has ${draft.outputs.length}` });
  }
  const seenIds = new Set<string>();
  const seenRanges = new Map<string, string>();

  for (const o of draft.outputs) {
    const errors: PlanIssue[] = [];
    const warnings: PlanIssue[] = [];
    const err = (code: PlanIssue["code"], message: string, clip?: number, suggestion?: string) => errors.push({ severity: "error", code, output: o.id, clip, message, suggestion });
    const warn = (code: PlanIssue["code"], message: string, clip?: number, suggestion?: string) => warnings.push({ severity: "warning", code, output: o.id, clip, message, suggestion });

    // an output carried over from the current plan keeps its fields as they are; only new outputs get brief/preset defaults
    const existing = opts.mode === "revise" && Boolean(opts.currentEdl?.outputs.some((x) => x.id === o.id));
    if (!ID_RE.test(o.id)) err("bad_id", `output id "${o.id}" must match [a-zA-Z0-9_-]+ (e.g. reel_1)`);
    if (seenIds.has(o.id)) err("duplicate_id", `output id "${o.id}" is used twice`);
    seenIds.add(o.id);
    if (o.clips.length === 0) err("no_clips", "output has no clips");

    // 1. refs → seconds
    const clips: ResolvedClip[] = [];
    o.clips.forEach((c, i) => {
      const a = resolveRef(c.start, "start", ctx);
      const b = resolveRef(c.end, "end", ctx);
      for (const [side, r, ref] of [["start", a, c.start] as const, ["end", b, c.end] as const]) {
        if (!r.ok) {
          err("unknown_ref", `clip ${i} ${side}: ${r.error}`, i, "use ids from the pack");
          continue;
        }
        const parsed = r.parsed;
        if (parsed.kind === "t") {
          if (opts.mode === "plan" || !known.keys.has(r.t.toFixed(3))) err("raw_time", `clip ${i} ${side}: "${ref}" is a raw time; use phrase/scene/gap ids`, i);
        } else if (parsed.kind === "g") warn("gap_cut", `clip ${i} ${side}: cut inside silence ${ref} (${r2(r.t)}s)`, i);
        else if (parsed.kind === "w") {
          const w = ctx.phrases[parsed.n].words[parsed.k];
          warn("mid_phrase", `clip ${i} ${side}: cut at word boundary ${ref} "${w.w}" (${w.start}–${w.end}s) inside a phrase`, i);
        }
      }
      if (!a.ok || !b.ok) return;
      let start = opts.mode === "revise" ? anchorToCurrent(a.t, known.times) : a.t;
      let end = opts.mode === "revise" ? anchorToCurrent(b.t, known.times) : b.t;
      if (start >= ctx.duration) return err("out_of_media", `clip ${i} starts at ${r2(start)}s, after the end of the video (${r2(ctx.duration)}s)`, i);
      if (end > ctx.duration) {
        if (end - ctx.duration <= 0.5) warn("out_of_media", `clip ${i} end ${r2(end)}s clamped to ${r2(ctx.duration)}s`, i), (end = ctx.duration);
        else return err("out_of_media", `clip ${i} ends at ${r2(end)}s, after the end of the video (${r2(ctx.duration)}s)`, i);
      }
      if (end <= start) return err("empty_clip", `clip ${i}: end ${c.end} (${r2(end)}s) is not after start ${c.start} (${r2(start)}s)`, i, "pick an end ref later than the start ref");
      const speed = c.speed ?? 1;
      if (speed < 0.25 || speed > 4) return err("bad_speed", `clip ${i}: speed ${speed} outside 0.25–4`, i);
      if (speed !== 1 && hasSpeech(ctx, start, end)) warn("speech_speed", `clip ${i}: speed ${speed} over speech`, i);
      clips.push({ index: i, start, end, from: c.start, to: c.end, speed, crop: c.crop ?? "center" });
    });

    // 2. keep words whole (scene/gap edges can land inside a word)
    const issues = checkClipBoundaries(clips.map((c) => ({ src_start: c.start, src_end: c.end, speed: c.speed, crop: c.crop })), ctx.transcript);
    for (const is of issues) {
      const clip = clips[is.clip];
      const shift = Math.abs(is.suggested - is.t);
      const label = `clip ${clip.index} ${is.edge} ${r2(is.t)}s cuts the word "${is.word.w}" (${is.word.start}–${is.word.end}s)`;
      if (shift <= maxSnap) {
        if (is.edge === "start") clip.start = is.suggested;
        else clip.end = is.suggested;
        warn("cuts_word", `${label} → moved to ${r2(is.suggested)}s`, clip.index);
      } else {
        const p = ctx.phrases.find((ph) => ph.words.includes(is.word));
        err("cuts_word", `${label}; moving it would shift ${r2(shift)}s`, clip.index, p ? `use ${p.id}.start / ${p.id}.end or a gap id` : undefined);
      }
    }
    for (const c of clips) if (c.end <= c.start) err("empty_clip", `clip ${c.index} collapsed after word snapping (${r2(c.start)}–${r2(c.end)}s)`, c.index);

    // 3. overlaps inside the output and identical ranges across outputs
    for (let i = 0; i < clips.length; i++)
      for (let j = i + 1; j < clips.length; j++)
        if (clips[i].start < clips[j].end && clips[j].start < clips[i].end) warn("overlap", `clips ${clips[i].index} and ${clips[j].index} overlap (${r2(clips[i].start)}–${r2(clips[i].end)}s / ${r2(clips[j].start)}–${r2(clips[j].end)}s)`, clips[j].index);
    for (const c of clips) {
      const key = `${c.start.toFixed(2)}-${c.end.toFixed(2)}`;
      const other = seenRanges.get(key);
      if (other && other !== o.id) warn("overlap", `clip ${r2(c.start)}–${r2(c.end)}s also appears in output ${other}`);
      else seenRanges.set(key, o.id);
    }

    // 4. duration vs target
    const duration = clips.reduce((s, c) => s + (c.end - c.start) / c.speed, 0);
    // the brief's target applies to outputs of the requested kind; a differently shaped extra output sets its own
    const briefTarget = draft.brief.aspect === undefined || draft.brief.aspect === o.aspect ? draft.brief.target_duration_s : undefined;
    const target = o.target_duration ?? (existing ? undefined : briefTarget) ?? null;
    if (target && clips.length) {
      const diff = duration - target;
      const hard = Math.max(0.25 * target, 5);
      const soft = Math.max(0.1 * target, 2);
      if (Math.abs(diff) > hard) {
        const last = clips[clips.length - 1];
        const candidates = diff < 0
          ? ctx.phrases.filter((p) => p.start >= last.end - 0.05).slice(0, 3).map((p) => `${p.id} (${r2(p.end - p.start)}s)`)
          : clips.map((c) => `clip ${c.index} (${r2((c.end - c.start) / c.speed)}s)`).slice(-3);
        err("duration_off", `output is ${r2(duration)}s, target ${target}s (${diff < 0 ? "too short" : "too long"} by ${r2(Math.abs(diff))}s)`, undefined, diff < 0 ? `add phrases, e.g. ${candidates.join(", ")}` : `remove or shorten ${candidates.join(", ")}`);
      } else if (Math.abs(diff) > soft) warn("duration_off", `output is ${r2(duration)}s vs target ${target}s`);
    }

    // 5. captions / titles (a carried-over output inherits its own previous defaults, a new one the preset's)
    const currentOut = existing ? opts.currentEdl?.outputs.find((x) => x.id === o.id) : undefined;
    let captionsLanguage = o.captions.language ?? null;
    // a carried-over output with captions already on keeps whatever language it had (possibly none)
    if (o.captions.enabled && !captionsLanguage && !(existing && currentOut?.captions.enabled)) {
      const guess = draft.brief.captions_language ?? majorityLang(ctx);
      if (guess && guess !== "unknown") {
        captionsLanguage = guess;
        warn("captions_no_language", `captions enabled without a language → ${captionsLanguage}`);
      } else warn("captions_no_language", "captions enabled without a language and the speech language is unknown; left unset");
    }
    const titles = o.titles.map((t) => {
      let at = t.at;
      if (at < 0 || at > duration) {
        warn("title_outside", `title "${t.text}" at ${t.at}s is outside the ${r2(duration)}s output → clamped`);
        at = Math.min(Math.max(0, at), Math.max(0, duration - 1));
      }
      if (t.text.length > 60) warn("title_long", `title "${t.text.slice(0, 30)}…" is ${t.text.length} chars (keep ≤ 40)`);
      // a title that already existed (same text, nearest time) keeps its style; a title added by the edit gets the preset's
      const prevTitle = currentOut?.titles.filter((p) => p.text === t.text).sort((a, b) => Math.abs(a.at - t.at) - Math.abs(b.at - t.at))[0];
      return { at: r2(at), duration: t.duration, text: t.text, style: t.style ?? (prevTitle ? prevTitle.style : ctx.preset.title_style) };
    });

    const out: ResolvedOutput = { id: o.id, aspect: o.aspect, errors, warnings, clips, duration_s: r2(duration), target_s: target, captions_language: captionsLanguage };
    if (errors.length === 0) {
      out.output = {
        id: o.id,
        aspect: o.aspect,
        target_duration: target ?? undefined,
        clips: clips.map((c) => ({ src_start: Number(c.start.toFixed(3)), src_end: Number(c.end.toFixed(3)), speed: c.speed, crop: c.crop })),
        // new output → preset; existing with captions already on → its own style; switched on by the edit → preset; still off → untouched
        captions: {
          enabled: o.captions.enabled,
          language: captionsLanguage ?? undefined,
          style: o.captions.style ?? (!existing ? ctx.preset.caption_style : currentOut?.captions.enabled ? currentOut.captions.style : o.captions.enabled ? ctx.preset.caption_style : currentOut?.captions.style),
        },
        titles,
        music: { enabled: o.music.enabled },
        transitions: "cut",
      };
    }
    outputs.push(out);
  }

  // 6. final guard: the EDL schema itself
  let edl: z.input<typeof EdlSchema> | null = null;
  const valid = outputs.filter((o) => o.output);
  if (valid.length > 0 && global.every((g) => g.severity !== "error")) {
    const candidate = { outputs: valid.map((o) => o.output!), reasoning: draft.reasoning };
    const parsed = EdlSchema.safeParse(candidate);
    if (parsed.success) edl = candidate;
    else {
      for (const is of parsed.error.issues) {
        const idx = typeof is.path[1] === "number" ? is.path[1] : undefined;
        const target = idx !== undefined ? valid[idx] : undefined;
        const issue: PlanIssue = { severity: "error", code: "schema", output: target?.id, message: `${is.path.join(".")}: ${is.message}` };
        if (target) target.errors.push(issue), (target.output = undefined);
        else global.push(issue);
      }
      const still = outputs.filter((o) => o.output);
      edl = still.length ? { outputs: still.map((o) => o.output!), reasoning: draft.reasoning } : null;
    }
  }
  const issues = [...global, ...outputs.flatMap((o) => [...o.errors, ...o.warnings])];
  return { edl, outputs, issues, errors: issues.filter((i) => i.severity === "error"), warnings: issues.filter((i) => i.severity === "warning") };
}

function majorityLang(ctx: PlanContext) {
  const by = new Map<string, number>();
  for (const p of ctx.phrases) by.set(p.lang, (by.get(p.lang) ?? 0) + (p.end - p.start));
  return [...by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ctx.transcript.language;
}

/** Compact issue list for the model (repair message / validate_edl result). */
export function formatIssuesForModel(issues: PlanIssue[]): string {
  return JSON.stringify(
    issues.map((i) => ({ severity: i.severity, code: i.code, ...(i.output ? { output: i.output } : {}), ...(i.clip !== undefined ? { clip: i.clip } : {}), message: i.message, ...(i.suggestion ? { suggestion: i.suggestion } : {}) })),
  );
}

export function refKind(ref: string) {
  return parseRef(ref)?.kind ?? null;
}
