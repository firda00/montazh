import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import { ICONS_DIR } from "./icons.ts";
import { describeFindings, findCliches, wantsCta, type SlopFinding } from "./slop.ts";
import { pronounce } from "../voice/pronounce.ts";
import { languageCode } from "../voice/catalog.ts";
export type { SlopFinding };

/** A beat is one screen: a sentence, an icon, how long it stays. */
export const BeatSchema = z.object({
  text: z.string().min(1).max(140),
  emphasis: z.string().default(""),
  icon: z.string().default("sparkles"),
  /** voice-stretched beats (make --voice) may run longer than a read-only beat */
  seconds: z.number().min(2).max(15).default(4),
  /** what the narrator says on this beat (make --voice): 1–2 short spoken sentences; empty = the on-screen text */
  voiceover: z.string().max(300).optional(),
});
export const ScriptSchema = z.object({
  title: z.string().min(1).max(60),
  language: z.string().default("ru"),
  beats: z.array(BeatSchema).min(3).max(10),
  hashtags: z.array(z.string()).default([]),
});
export type Script = z.infer<typeof ScriptSchema>;
export type Beat = z.infer<typeof BeatSchema>;

/** What the model must return (hook = beats[0], call to action = last beat). */
const ScriptOutSchema = z.object({
  title: z.string(),
  language: z.string(),
  beats: z.array(z.object({ text: z.string(), emphasis: z.string(), icon: z.string(), seconds: z.number(), voiceover: z.string().optional() })),
  hashtags: z.array(z.string()),
});

export const LANGUAGE_NAMES: Record<string, string> = { ru: "Russian", uz: "Uzbek (Latin script)", en: "English", kk: "Kazakh", tr: "Turkish" };

export interface ScriptOptions {
  language?: string;
  seconds?: number;
  audience?: string;
  /** TREND NOTES block (from trends.ts), already formatted */
  trendsText?: string;
  model?: string;
  /** the user's instruction (CTA allowed only when it asks for one); default: the topic */
  instruction?: string;
}

/**
 * Pacing of a voiced script (stage 25). The 65 s videos came from ~25-word narrations per beat; reels that hold attention
 * are 35–45 s with a 2–3 s hook. Budget: the fast narrator says ~3 words a second; every beat also costs ~0.45 s of
 * lead-in and tail around its speech.
 */
export const VOICE_WPS = 3.0;
/** the hook's narration: at most this many words, and its number/name within the first HOOK_FACT_WITHIN words */
export const HOOK_MAX_WORDS = 10;
export const HOOK_FACT_WITHIN = 5;
/** on-screen words of the hook (it is read in under two seconds) */
export const HOOK_TEXT_MAX_WORDS = 7;
/** any other beat's narration */
export const BEAT_MAX_WORDS = 20;

/** Words the whole narration may have for a target length. */
export function narrationBudget(seconds: number, beats: number): number {
  return Math.max(30, Math.round((seconds - 0.45 * beats) * VOICE_WPS));
}

export const countWords = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
/** words as the narrator says them: «965 миллиардов» is four spoken words, «OpenAI» two (Оупен Эй-Ай) */
export function spokenWords(t: string, language = "ru"): number {
  try {
    return countWords(pronounce(t, languageCode(language), { expandAcronyms: false }));
  } catch {
    return countWords(t);
  }
}
const NUMBER_WORD = /^[«"(]?(\d|сто|двести|триста|четыреста|пятьсот|тысяч|миллион|миллиард|триллион|полтора|полторы|половин|вдвое|втрое|вчетверо|дважды|трижды|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|двадцать|тридцать|сорок|пятьдесят|шестьдесят|семьдесят|восемьдесят|девяносто)/i;
/** a number (digits or words) or a name (a capitalised word that does not start a sentence, or any Latin name) among the first n words */
export function factWithin(line: string, n: number): boolean {
  const words = line.split(/\s+/).filter(Boolean).slice(0, n);
  return words.some((w, k) => NUMBER_WORD.test(w) || /^[«"(]?[A-Z]/.test(w) || (k > 0 && !/[.!?…:]$/.test(words[k - 1]) && /^[«"(]?[\p{Lu}][\p{L}-]{1,}/u.test(w)));
}

/**
 * Length and hook checks of a script: the narration over its word budget, a long beat, a hook that is long or states
 * its fact late. Same shape as the cliché findings, so one rewrite pass fixes both.
 */
export function pacingFindings(script: Script, seconds: number): SlopFinding[] {
  const out: SlopFinding[] = [];
  const voiced = script.beats.some((b) => b.voiceover?.trim());
  const hook = script.beats[0];
  if (hook) {
    const tw = countWords(hook.text);
    if (tw > HOOK_TEXT_MAX_WORDS) out.push({ beat: 0, field: "text", rule: "hook_text_long", why: `the hook's on-screen line has ${tw} words: at most ${HOOK_TEXT_MAX_WORDS}, it is read in under two seconds`, match: hook.text });
    if (voiced && hook.voiceover) {
      const vw = spokenWords(hook.voiceover, script.language);
      if (vw > HOOK_MAX_WORDS) out.push({ beat: 0, field: "voiceover", rule: "hook_long", why: `the hook's narration has ${vw} words: at most ${HOOK_MAX_WORDS} (2–3 seconds), the shortest beat of the video`, match: hook.voiceover });
      if (!factWithin(hook.voiceover, HOOK_FACT_WITHIN)) out.push({ beat: 0, field: "voiceover", rule: "hook_late_fact", why: `the hook must say its number or name within the first ${HOOK_FACT_WITHIN} words, with no warm-up`, match: hook.voiceover.split(/\s+/).slice(0, 6).join(" ") });
    }
  }
  if (!voiced) return out;
  script.beats.forEach((b, i) => {
    if (i === 0 || !b.voiceover) return;
    const n = spokenWords(b.voiceover, script.language);
    if (n > BEAT_MAX_WORDS) out.push({ beat: i, field: "voiceover", rule: "beat_long", why: `the narration has ${n} words: at most ${BEAT_MAX_WORDS}, one sentence`, match: b.voiceover });
  });
  const total = script.beats.reduce((n, b) => n + spokenWords(b.voiceover?.trim() || b.text, script.language), 0);
  const budget = narrationBudget(seconds, script.beats.length);
  if (total > budget * 1.1) out.push({ beat: -1, field: "voiceover", rule: "narration_long", why: `the whole narration is ${total} words; the budget for a ${seconds}-second video is ${budget}: cut every beat down to its one fact`, match: `${total} words` });
  return out;
}

/** Beats for a target length: ~5 s per beat, 4..8. */
export function beatsFor(seconds: number): number {
  return Math.max(4, Math.min(8, Math.round(seconds / 5)));
}

/** Reading-speed floor: a beat stays at least long enough to read (≈2.6 words/s plus settle time). */
export function beatSeconds(text: string, asked: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const floor = Math.round((words / 2.6 + 1.0) * 10) / 10;
  return Math.min(10, Math.max(2.5, Math.max(asked, floor)));
}

/** Lucide icon name → exists? (lowercase, hyphens); fallback "sparkles". */
export async function resolveIcon(name: string, dir = ICONS_DIR): Promise<string> {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  try {
    await fs.access(path.join(dir, `${n}.svg`));
    return n;
  } catch {
    return "sparkles";
  }
}

/** Normalises a model answer: durations by reading speed, icons that exist, emphasis that is really in the text. */
export async function normalizeScript(raw: unknown, opts: ScriptOptions = {}): Promise<Script> {
  const out = ScriptOutSchema.parse(raw);
  const beats: Beat[] = [];
  for (const b of out.beats) {
    const text = b.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const emphasis = text.toLowerCase().includes(b.emphasis.trim().toLowerCase()) && b.emphasis.trim() ? b.emphasis.trim() : "";
    const voiceover = (b.voiceover ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    beats.push({ text, emphasis, icon: await resolveIcon(b.icon), seconds: beatSeconds(text, b.seconds), ...(voiceover ? { voiceover } : {}) });
  }
  return ScriptSchema.parse({
    title: out.title.replace(/\s+/g, " ").trim().slice(0, 60),
    language: out.language || opts.language || "ru",
    beats,
    hashtags: out.hashtags.map((h) => h.replace(/^#/, "").replace(/\s+/g, "").toLowerCase()).filter(Boolean).slice(0, 6),
  });
}

export interface ScriptResult {
  script: Script;
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: string;
  estimate: boolean;
  /** banned phrases the cliché check found in the first draft (rewritten once) */
  cliches: SlopFinding[];
  /** pacing problems of the first draft (narration over budget, long or late hook), fixed in the same rewrite */
  pacing: SlopFinding[];
  /** pacing problems left after the rewrite */
  pacingLeft: SlopFinding[];
  /** what is still there after the rewrite (reported as a warning) */
  remaining: SlopFinding[];
}

export async function writeScript(topic: string, llm: StructuredFn, opts: ScriptOptions = {}): Promise<ScriptResult> {
  const language = opts.language ?? "ru";
  const seconds = opts.seconds ?? 35;
  const allowCta = wantsCta(opts.instruction ?? topic);
  const cta = allowCta ? "the instruction asks for a call to action: end with one short, specific call to action." : "no call to action: end on the sharpest fact, consequence or observation.";
  const lang = LANGUAGE_NAMES[language] ?? language;
  const prompt = fill(loadPrompt("make.script.user"), {
    topic,
    language: lang,
    seconds,
    beats: beatsFor(seconds),
    words: narrationBudget(seconds, beatsFor(seconds)),
    hook_words: HOOK_MAX_WORDS,
    beat_words: BEAT_MAX_WORDS,
    audience: opts.audience ?? "people scrolling Reels/Shorts on their phone",
    cta,
    trends: opts.trendsText ? `\n${opts.trendsText}\n` : "",
  });
  const system = loadPrompt("make.script.system");
  const schema = zodToApiSchema(ScriptOutSchema);
  const res = await llm({ system, prompt, schema, model: opts.model, effort: "medium", maxTokens: 4000 });
  let script = await normalizeScript(res.data, { language });
  let usd = res.usd;
  const usage = { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens };
  const cliches = findCliches(script, { allowCta });
  const pacing = pacingFindings(script, seconds);
  let remaining = cliches;
  let pacingLeft = pacing;
  if (cliches.length || pacing.length) {
    // enforced, not just suggested: one rewrite with the findings spelled out (clichés and pacing together)
    const fix = fill(loadPrompt("make.script.rewrite"), { topic, language: lang, cta, words: narrationBudget(seconds, script.beats.length), problems: describeFindings([...cliches, ...pacing]), script: JSON.stringify(script, null, 1) });
    try {
      const again = await llm({ system, prompt: fix, schema, model: opts.model, effort: "medium", maxTokens: 4000 });
      usd += again.usd;
      usage.input_tokens += again.usage.input_tokens;
      usage.output_tokens += again.usage.output_tokens;
      const rewritten = await normalizeScript(again.data, { language });
      const left = findCliches(rewritten, { allowCta });
      const leftPacing = pacingFindings(rewritten, seconds);
      // keep the rewrite unless it made things worse (clichés weigh more than pacing)
      if (left.length <= cliches.length && left.length * 3 + leftPacing.length <= cliches.length * 3 + pacing.length) {
        script = rewritten;
        remaining = left;
        pacingLeft = leftPacing;
      }
    } catch {
      /* the first draft stands; the findings are reported */
    }
  }
  return { script, usd, usage, model: res.model, provider: res.provider, estimate: res.estimate, cliches, remaining, pacing, pacingLeft };
}

export function scriptDuration(s: Script): number {
  return Math.round(s.beats.reduce((n, b) => n + b.seconds, 0) * 100) / 100;
}
