import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import type { StructuredFn } from "../lib/llm.ts";
import type { OutPhrase, OutWord } from "./timeline.ts";

export const LANGUAGE_NAMES: Record<string, string> = {
  uz: "Uzbek (Latin script, as used in Uzbekistan today)",
  ru: "Russian",
  en: "English",
  kk: "Kazakh",
  tr: "Turkish",
};

const TranslationSchema = z.object({ items: z.array(z.object({ i: z.number(), text: z.string() })) });

export const TranslationCacheSchema = z.object({
  target: z.string(),
  entries: z.record(z.string(), z.string()), // key = `${lang}|${source text}`
});

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export const TRANSLATE_SYSTEM = `You translate short-video subtitle lines. Rules: keep each line's meaning; keep it about as long as the original (it is shown as captions, 2–4 words at a time); keep numbers, names and brand names; natural spoken register; no quotes, no explanations. Return JSON {"items":[{"i":<same id>,"text":"<translation>"}]} with exactly one item per input id, in the same order.`;

/** Translates the phrases that are not already in `target`, through a cache in the job dir. Returns the texts by phrase index. */
export async function translatePhrases(jobId: string, phrases: OutPhrase[], target: string, llm: StructuredFn, opts: { model?: string } = {}): Promise<Map<number, string>> {
  const dir = jobDir(jobId);
  const cacheFile = path.join(dir, `translations_${target}.json`);
  const cache = (await exists(cacheFile)) ? await readJson(cacheFile, TranslationCacheSchema) : { target, entries: {} as Record<string, string> };
  const out = new Map<number, string>();
  const todo: { i: number; text: string; lang: string }[] = [];
  const seen = new Set<number>();
  for (const p of phrases) {
    if (seen.has(p.phrase)) continue;
    seen.add(p.phrase);
    if (p.lang === target) continue;
    const key = `${p.lang}|${p.text}`;
    const hit = cache.entries[key];
    if (hit) out.set(p.phrase, hit);
    else todo.push({ i: p.phrase, text: p.text, lang: p.lang });
  }
  if (todo.length) {
    const langs = [...new Set(todo.map((t) => t.lang))].map((l) => LANGUAGE_NAMES[l] ?? l).join(", ");
    const prompt = `Translate from ${langs} to ${LANGUAGE_NAMES[target] ?? target}.\n${JSON.stringify({ items: todo.map(({ i, text }) => ({ i, text })) })}`;
    const res = await llm({ system: TRANSLATE_SYSTEM, prompt, schema: zodToApiSchema(TranslationSchema), model: opts.model, effort: "low", maxTokens: 8000 });
    const parsed = TranslationSchema.safeParse(res.data);
    if (!parsed.success) throw new Error(`перевод: неожиданный формат ответа: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    await addCost(jobId, { step: "design", provider: res.provider, model: res.model, units: { ...res.usage, calls: 1, estimate: res.estimate ? 1 : 0, unpriced: 0, phrases: todo.length }, usd: res.usd });
    const byId = new Map(parsed.data.items.map((it) => [it.i, it.text.trim()]));
    for (const t of todo) {
      const text = byId.get(t.i);
      if (!text) throw new Error(`перевод: нет перевода для фразы ${t.i}`);
      cache.entries[`${t.lang}|${t.text}`] = text;
      out.set(t.i, text);
    }
    await writeJson(cacheFile, TranslationCacheSchema, cache);
  }
  return out;
}

/**
 * Re-times a translated phrase: words are spread over the original phrase span in
 * proportion to their length, so the karaoke highlight still moves with the speech.
 */
export function retimePhrase(phrase: OutPhrase, text: string, lang: string): OutPhrase {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return phrase;
  const span = phrase.end - phrase.start;
  const weights = tokens.map((t) => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, "").length));
  const total = weights.reduce((s, w) => s + w, 0);
  const words: OutWord[] = [];
  let t = phrase.start;
  tokens.forEach((w, k) => {
    const len = (span * weights[k]) / total;
    words.push({ w, start: r3(t), end: r3(k === tokens.length - 1 ? phrase.end : t + len), clip: phrase.clip, phrase: phrase.phrase });
    t += len;
  });
  return { ...phrase, lang, text: tokens.join(" "), words };
}

export function applyTranslations(phrases: OutPhrase[], translations: Map<number, string>, target: string): OutPhrase[] {
  return phrases.map((p) => {
    const text = translations.get(p.phrase);
    return text && p.lang !== target ? retimePhrase(p, text, target) : p;
  });
}
