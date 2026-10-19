// Stage 28: the feedback loop. After a 1–5 ⭐ press the result message asks why (reason chips, several at once, then an
// optional comment — text or a voice note, transcribed); everything goes to the `feedback` table with the job's
// kind / preset / voice / aspect / duration / cost. The admin card «📊 Оценки» and `vedit feedback report` read the
// same summary: averages (7 d / 30 d / all), by kind / style / voice, distribution, top reasons, recent low ratings
// next to the AI critic's fixes, and the cases where the critic and the user disagree by ≥ 2 stars.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { InlineButton, InlineKeyboard } from "./telegram-api.ts";
import type { FeedbackRow, JobRow, OutputRow, SelfReviewRow } from "./db.ts";
import type { Strings } from "./i18n.ts";
import { REVIEW_CRITERIA, type ReviewKey } from "../review/self-review.ts";
import { highlightsIntent } from "../highlights/intent.ts";

/** reasons offered after 1–3 ⭐ / 4–5 ⭐ (codes are stored; labels come from i18n) */
export const LOW_REASONS = ["subs", "vis", "dyn", "voice", "audio", "text", "cut", "wait", "other"] as const;
export const HIGH_REASONS = ["hook", "vis", "subs", "dyn", "voice", "music", "all"] as const;
export type LowReason = (typeof LOW_REASONS)[number];
export type HighReason = (typeof HIGH_REASONS)[number];

export const isLow = (stars: number) => stars <= 3;
export const reasonsFor = (stars: number): readonly string[] => (isLow(stars) ? LOW_REASONS : HIGH_REASONS);

export function reasonLabel(L: Strings, code: string, stars: number): string {
  const table = (isLow(stars) ? L.fb.low : L.fb.high) as Record<string, string>;
  return table[code] ?? code;
}

/** a comment typed / spoken within this window after «Готово» is taken as feedback, later text is a normal task */
export const COMMENT_WINDOW_MS = 15 * 60_000;
/** longest voice note transcribed for a comment, s */
export const VOICE_NOTE_MAX_S = 120;

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });

/** the reason chips (✓ on the picked ones) in rows of two + «Готово» */
export function feedbackKb(L: Strings, jobId: string, stars: number, selected: string[]): InlineKeyboard {
  const chips = reasonsFor(stars).map((code) => btn(selected.includes(code) ? `✓ ${reasonLabel(L, code, stars)}` : reasonLabel(L, code, stars), `fb:${jobId}:t:${code}`));
  const rows: InlineButton[][] = [];
  for (let i = 0; i < chips.length; i += 2) rows.push(chips.slice(i, i + 2));
  rows.push([btn(L.fb.done, `fb:${jobId}:ok`)]);
  return { inline_keyboard: rows };
}

export const commentKb = (L: Strings, jobId: string): InlineKeyboard => ({ inline_keyboard: [[btn(L.fb.done, `fb:${jobId}:end`)]] });

export const parseReasons = (raw: string | null | undefined): string[] => {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const payloadOf = (job: Pick<JobRow, "payload">): Record<string, unknown> => {
  try {
    return JSON.parse(job.payload) as Record<string, unknown>;
  } catch {
    return {};
  }
};
const str = (p: Record<string, unknown>, k: string) => (typeof p[k] === "string" && p[k] ? (p[k] as string) : undefined);


/** montage | highlights | reference | make | revise | avatar */
export function feedbackKind(job: Pick<JobRow, "kind" | "class" | "payload">): string {
  const p = payloadOf(job);
  switch (job.kind) {
    case "run":
      if (str(p, "like")) return "reference";
      if (/хайлайт|highlight/i.test(str(p, "instruction") ?? "") || highlightsIntent(str(p, "instruction")) === "strong") return "highlights";
      return "montage";
    case "make":
      return "make";
    case "revise":
      return "revise";
    default:
      return "avatar";
  }
}

/** the columns stored next to the stars: what the user was rating */
export function feedbackMeta(job: JobRow, outputs: Pick<OutputRow, "duration" | "aspect">[]) {
  const p = payloadOf(job);
  const kind = feedbackKind(job);
  const duration = outputs.reduce((s, o) => s + (o.duration ?? 0), 0) || null;
  return {
    kind,
    preset: str(p, "preset") ?? (job.kind === "make" ? "make" : null),
    voice: str(p, "voice") ?? str(p, "voiceId") ?? null,
    aspect: outputs.find((o) => o.aspect)?.aspect ?? str(p, "resultAspect") ?? str(p, "aspect") ?? null,
    duration,
    cost_usd: job.cost_usd,
  };
}

/** what the critic is told about the job */
export function reviewContext(job: JobRow, out: Pick<OutputRow, "duration" | "aspect">) {
  const p = payloadOf(job);
  return { kind: feedbackKind(job), task: str(p, "instruction") ?? str(p, "topic") ?? str(p, "edit") ?? str(p, "input"), style: str(p, "preset") ?? (job.kind === "make" ? "make" : undefined), duration: out.duration ?? undefined, aspect: out.aspect ?? str(p, "resultAspect") ?? str(p, "aspect") };
}

// ── voice comments ─────────────────────────────────────────────────────────────

/** a voice note → text (whisper.cpp through the shared ASR helper; ≤ 120 s) */
export async function transcribeNote(file: string): Promise<string> {
  const { ffmpeg, ffprobe } = await import("../lib/ffmpeg.ts");
  const { transcribe } = await import("../understand/whisper.ts");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vedit-note-"));
  try {
    const wav = path.join(tmp, "note.wav");
    await ffmpeg(["-t", String(VOICE_NOTE_MAX_S), "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav]);
    const duration = Number((await ffprobe(wav)).format.duration) || 1;
    const r = await transcribe(wav, duration, tmp, {});
    return r.transcript.segments
      .map((s) => s.text.trim())
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

// ── summary ────────────────────────────────────────────────────────────────────

export interface ReviewView {
  job: string;
  output_id: string;
  overall: number;
  scores: Partial<Record<ReviewKey, { score: number; reason: string }>>;
  fixes: string[];
  summary: string;
  confidence: number;
  model: string | null;
  cost_usd: number;
}

export function reviewView(r: SelfReviewRow): ReviewView | undefined {
  if (r.status !== "ok" || !r.scores) return undefined;
  let scores: ReviewView["scores"] = {};
  try {
    scores = JSON.parse(r.scores) as ReviewView["scores"];
  } catch {}
  return { job: r.job, output_id: r.output_id, overall: r.overall ?? scores.overall?.score ?? 0, scores, fixes: parseReasons(r.fixes), summary: r.summary ?? "", confidence: r.confidence ?? 0, model: r.model, cost_usd: r.cost_usd };
}

/** the critic's grade for what the user rated: that output, or the mean over the job's outputs ("*") */
export function aiGradeFor(f: Pick<FeedbackRow, "job" | "output_id">, reviews: SelfReviewRow[]): { overall: number; fixes: string[]; reviews: ReviewView[] } | undefined {
  const views = reviews
    .filter((r) => r.job === f.job && (f.output_id === "*" || r.output_id === f.output_id))
    .map(reviewView)
    .filter((v): v is ReviewView => !!v);
  if (!views.length) return undefined;
  const overall = Math.round((views.reduce((s, v) => s + v.overall, 0) / views.length) * 10) / 10;
  const worst = [...views].sort((a, b) => a.overall - b.overall)[0];
  return { overall, fixes: worst.fixes, reviews: views };
}

export interface Avg {
  avg: number | null;
  n: number;
}
export interface FeedbackSummary {
  /** window of the breakdowns, days (0 = all time) */
  days: number;
  avg7: Avg;
  avg30: Avg;
  avgAll: Avg;
  dist: number[];
  byKind: (Avg & { key: string })[];
  byStyle: (Avg & { key: string })[];
  byVoice: (Avg & { key: string })[];
  lowReasons: { code: string; n: number }[];
  highReasons: { code: string; n: number }[];
  /** recent ≤ 3 ⭐, newest first, with the critic's view */
  low: { f: FeedbackRow; ai?: { overall: number; fixes: string[] } }[];
  /** |critic − user| ≥ 2 */
  disagree: { f: FeedbackRow; ai: number; diff: number }[];
  reviews: { ok: number; skipped: number; failed: number; avgOverall: number | null; byCriterion: (Avg & { key: string })[]; cost: number };
}

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;

function avgOf(xs: number[]): Avg {
  return { avg: xs.length ? round2(xs.reduce((s, x) => s + x, 0) / xs.length) : null, n: xs.length };
}

function groupAvg(rows: FeedbackRow[], key: (f: FeedbackRow) => string | null | undefined): (Avg & { key: string })[] {
  const m = new Map<string, number[]>();
  for (const f of rows) {
    const k = key(f) || "—";
    m.set(k, [...(m.get(k) ?? []), f.stars]);
  }
  return [...m.entries()].map(([k, xs]) => ({ key: k, ...avgOf(xs) })).sort((a, b) => b.n - a.n || (b.avg ?? 0) - (a.avg ?? 0));
}

function countReasons(rows: FeedbackRow[]): { code: string; n: number }[] {
  const m = new Map<string, number>();
  for (const f of rows) for (const r of parseReasons(f.reasons)) m.set(r, (m.get(r) ?? 0) + 1);
  return [...m.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
}

/** pure: every number of the admin card and the report from the two tables */
export function summarizeFeedback(all: FeedbackRow[], reviews: SelfReviewRow[], o: { days?: number; now?: number; lowLimit?: number } = {}): FeedbackSummary {
  const now = o.now ?? Date.now();
  const days = o.days ?? 30;
  const since = (d: number) => (d > 0 ? all.filter((f) => Date.parse(f.updated_at) >= now - d * DAY) : all);
  const rows = since(days);
  const dist = [1, 2, 3, 4, 5].map((s) => rows.filter((f) => f.stars === s).length);
  const low = rows
    .filter((f) => isLow(f.stars))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, o.lowLimit ?? 8)
    .map((f) => {
      const g = aiGradeFor(f, reviews);
      return { f, ...(g ? { ai: { overall: g.overall, fixes: g.fixes } } : {}) };
    });
  const disagree = rows
    .map((f) => {
      const g = aiGradeFor(f, reviews);
      return g ? { f, ai: g.overall, diff: round2(g.overall - f.stars) } : undefined;
    })
    .filter((x): x is { f: FeedbackRow; ai: number; diff: number } => !!x && Math.abs(x.diff) >= 2)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.f.updated_at.localeCompare(a.f.updated_at));
  const rv = (days > 0 ? reviews.filter((r) => Date.parse(r.created_at) >= now - days * DAY) : reviews).map((r) => ({ r, v: reviewView(r) }));
  const ok = rv.filter((x) => x.v).map((x) => x.v!);
  return {
    days,
    avg7: avgOf(since(7).map((f) => f.stars)),
    avg30: avgOf(since(30).map((f) => f.stars)),
    avgAll: avgOf(all.map((f) => f.stars)),
    dist,
    byKind: groupAvg(rows, (f) => f.kind),
    byStyle: groupAvg(rows, (f) => f.preset),
    byVoice: groupAvg(
      rows.filter((f) => f.kind === "make" || f.voice),
      (f) => f.voice ?? "auto",
    ),
    lowReasons: countReasons(rows.filter((f) => isLow(f.stars))),
    highReasons: countReasons(rows.filter((f) => !isLow(f.stars))),
    low,
    disagree,
    reviews: {
      ok: ok.length,
      skipped: rv.filter((x) => x.r.status === "skipped").length,
      failed: rv.filter((x) => x.r.status === "failed").length,
      avgOverall: avgOf(ok.map((v) => v.overall)).avg,
      byCriterion: [...REVIEW_CRITERIA, "overall" as const].map((c) => ({ key: c, ...avgOf(ok.map((v) => v.scores[c]?.score).filter((s): s is number => typeof s === "number")) })),
      cost: Math.round(rv.reduce((s, x) => s + (x.r.cost_usd ?? 0), 0) * 1e4) / 1e4,
    },
  };
}

// ── text ───────────────────────────────────────────────────────────────────────

const fmtAvg = (a: Avg) => (a.n ? `${a.avg!.toFixed(2)} (${a.n})` : "—");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function kindLabel(L: Strings, k: string | null): string {
  return (L.fbAdmin.kinds as Record<string, string>)[k ?? ""] ?? k ?? "—";
}

function reasonsText(L: Strings, f: Pick<FeedbackRow, "reasons" | "stars">) {
  return parseReasons(f.reasons)
    .map((r) => reasonLabel(L, r, f.stars))
    .join(", ");
}

/** the admin card / the report body (the language of the admin) */
export function formatFeedbackSummary(L: Strings, s: FeedbackSummary): string {
  const A = L.fbAdmin;
  const lines = [`${A.title} · ${A.period(s.days)}`];
  if (!s.avgAll.n) return [...lines, A.none].join("\n");
  lines.push(`${A.avg}: ${A.period(7)} ${fmtAvg(s.avg7)} · ${A.period(30)} ${fmtAvg(s.avg30)} · ${A.period(0)} ${fmtAvg(s.avgAll)}`);
  lines.push(`${A.dist}: ${s.dist.map((n, i) => `${i + 1}⭐ ${n}`).join(" · ")}`);
  const group = (title: string, xs: (Avg & { key: string })[], label: (k: string) => string = (k) => k) => (xs.length ? `${title}: ${xs.slice(0, 8).map((x) => `${label(x.key)} ${fmtAvg(x)}`).join(" · ")}` : "");
  lines.push(group(A.byKind, s.byKind, (k) => kindLabel(L, k)));
  lines.push(group(A.byStyle, s.byStyle, (k) => (L.styleNames as Record<string, string>)[k] ?? k));
  lines.push(group(A.byVoice, s.byVoice));
  const reasons = (title: string, xs: { code: string; n: number }[], stars: number) => `${title}: ${xs.length ? xs.slice(0, 8).map((x) => `${reasonLabel(L, x.code, stars)} ${x.n}`).join(" · ") : "—"}`;
  lines.push(reasons(A.lowWhy, s.lowReasons, 1));
  lines.push(reasons(A.highWhy, s.highReasons, 5));
  const r = s.reviews;
  lines.push(`${A.ai}: ${A.aiLine(r.ok, r.skipped + r.failed, r.avgOverall === null ? "—" : r.avgOverall.toFixed(2), `$${r.cost.toFixed(4)}`)}`);
  if (r.ok) lines.push(`  ${r.byCriterion.filter((c) => c.n).map((c) => `${(A.criteria as Record<string, string>)[c.key] ?? c.key} ${c.avg!.toFixed(1)}`).join(" · ")}`);
  lines.push(`${A.disagree}: ${s.disagree.length}`);
  return lines.filter(Boolean).join("\n");
}

/** recent low ratings: the user's reasons next to the critic's top fixes */
export function formatLowList(L: Strings, s: FeedbackSummary): string {
  const A = L.fbAdmin;
  if (!s.low.length) return `${A.recentLow}: —`;
  const out = [`${A.recentLow} (${A.period(s.days)}):`];
  for (const { f, ai } of s.low) {
    const head = `• ${f.job} · ${"⭐".repeat(f.stars)} · ${kindLabel(L, f.kind)}${f.preset ? `/${f.preset}` : ""} · id ${f.user}`;
    const user = `  ${A.userSaid}: ${reasonsText(L, f) || "—"}${f.comment ? ` — «${clip(f.comment, 140)}»` : ""}`;
    const critic = ai ? `  ${A.aiSaid} ${ai.overall}/5: ${ai.fixes.slice(0, 3).map((x) => clip(x, 110)).join("; ") || "—"}` : `  ${A.aiSaid}: ${A.noReview}`;
    out.push(head, user, critic);
  }
  return clip(out.join("\n"), 4000);
}

export function formatDisagree(L: Strings, s: FeedbackSummary): string {
  const A = L.fbAdmin;
  if (!s.disagree.length) return `${A.disagree}: —`;
  const out = [`${A.disagree} (${A.period(s.days)}):`, A.disagreeHint];
  for (const d of s.disagree.slice(0, 10)) out.push(`• ${d.f.job} · ${A.userSaid} ${d.f.stars}⭐ · ${A.aiSaid} ${d.ai} (${d.diff > 0 ? "+" : ""}${d.diff}) · ${kindLabel(L, d.f.kind)} · ${reasonsText(L, d.f) || "—"}${d.f.comment ? ` · «${clip(d.f.comment, 100)}»` : ""}`);
  return clip(out.join("\n"), 4000);
}

/** one job: outputs, every rating with reasons and comment, the critic's grades with reasons and fixes */
export function formatJobFeedback(L: Strings, job: JobRow | undefined, jobId: string, outputs: OutputRow[], feedback: FeedbackRow[], reviews: SelfReviewRow[]): string {
  const A = L.fbAdmin;
  const out = [`🔎 ${jobId}${job ? ` · ${kindLabel(L, feedbackKind(job))} · id ${job.user} · ${job.created_at.slice(0, 16).replace("T", " ")}${job.cost_usd ? ` · $${job.cost_usd.toFixed(3)}` : ""}` : ""}`];
  if (job?.vedit_job) out.push(`job: ${job.vedit_job}`);
  for (const o of outputs) out.push(`🎬 ${o.output_id}${o.duration ? ` · ${o.duration.toFixed(1)} с` : ""}${o.aspect ? ` · ${o.aspect}` : ""}`);
  for (const f of feedback) out.push(`${A.userSaid} ${f.user}: ${"⭐".repeat(f.stars)} · ${reasonsText(L, f) || "—"}${f.comment ? `\n  «${clip(f.comment, 600)}»${f.comment_kind === "voice" ? " 🎤" : ""}` : ""}`);
  if (!feedback.length) out.push(`${A.userSaid}: —`);
  for (const r of reviews) {
    const v = reviewView(r);
    if (!v) {
      out.push(`${A.aiSaid} ${r.output_id}: ${r.status}${r.error ? ` (${clip(r.error, 160)})` : ""}`);
      continue;
    }
    out.push(`${A.aiSaid} ${r.output_id}: ${v.overall}/5 · ${v.model ?? "?"} · $${v.cost_usd.toFixed(4)} · ${A.confidence} ${v.confidence.toFixed(2)}`);
    if (v.summary) out.push(`  ${clip(v.summary, 300)}`);
    for (const c of REVIEW_CRITERIA) {
      const sc = v.scores[c];
      if (sc) out.push(`  ${(A.criteria as Record<string, string>)[c]} ${sc.score}: ${clip(sc.reason, 200)}`);
    }
    v.fixes.forEach((x, i) => out.push(`  ${i + 1}) ${clip(x, 220)}`));
  }
  if (!reviews.length) out.push(`${A.aiSaid}: ${A.noReview}`);
  return clip(out.join("\n"), 4000);
}

/** Markdown for docs/feedback-report.md (no personal data beyond the user id) */
export function feedbackReportMarkdown(L: Strings, s: FeedbackSummary, generatedAt = new Date()): string {
  const fence = (t: string) => ["```", t, "```"].join("\n");
  return [
    `# Оценки и самопроверка — отчёт`,
    "",
    `Сформирован ${generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC командой \`vedit feedback report --days ${s.days}\`. Персональных данных нет, кроме id пользователя.`,
    "",
    "## Сводка",
    "",
    fence(formatFeedbackSummary(L, s)),
    "",
    "## Низкие оценки: причины пользователя и правки критика",
    "",
    fence(formatLowList(L, s)),
    "",
    "## Расхождения критика и пользователей",
    "",
    fence(formatDisagree(L, s)),
    "",
  ].join("\n");
}
