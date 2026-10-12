import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { exists, jobDir, readJson, writeJson } from "../lib/workspace.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { partKey, type OutPhrase, type OutWord } from "./timeline.ts";

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

export const TRANSLATE_SYSTEM = loadPrompt("translate.system");

/**
 * Translates the phrase PARTS that are not already in `target`, through a cache in the job dir.
 * A transcript phrase cut into several parts is translated part by part (each part has its own
 * words); the result is keyed by partKey(part) = "phrase:clip".
 */
export async function translatePhrases(jobId: string, phrases: OutPhrase[], target: string, llm: StructuredFn, opts: { model?: string } = {}): Promise<Map<string, string>> {
  const dir = jobDir(jobId);
  const cacheFile = path.join(dir, `translations_${target}.json`);
  const cache = (await exists(cacheFile)) ? await readJson(cacheFile, TranslationCacheSchema) : { target, entries: {} as Record<string, string> };
  const out = new Map<string, string>();
  const todo: { i: number; key: string; text: string; lang: string }[] = [];
  const seen = new Set<string>();
  for (const p of phrases) {
    const key = partKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    if (p.lang === target) continue;
    const cacheKey = `${p.lang}|${p.text}`;
    const hit = cache.entries[cacheKey];
    if (hit) out.set(key, hit);
    else todo.push({ i: todo.length, key, text: p.text, lang: p.lang });
  }
  if (todo.length) {
    const langs = [...new Set(todo.map((t) => t.lang))].map((l) => LANGUAGE_NAMES[l] ?? l).join(", ");
    const prompt = fill(loadPrompt("translate.user"), { from: langs, to: LANGUAGE_NAMES[target] ?? target, items: JSON.stringify({ items: todo.map(({ i, text }) => ({ i, text })) }) });
    const res = await llm({ system: TRANSLATE_SYSTEM, prompt, schema: zodToApiSchema(TranslationSchema), model: opts.model, effort: "low", maxTokens: 8000 });
    // the call is paid whatever the answer looks like: log it before validating
    await addCost(jobId, { step: "design", provider: res.provider, model: res.model, units: { ...res.usage, calls: 1, estimate: res.estimate ? 1 : 0, unpriced: res.priced === false ? 1 : 0, phrases: todo.length }, usd: res.usd });
    const parsed = TranslationSchema.safeParse(res.data);
    if (!parsed.success) throw new Error(`перевод: неожиданный формат ответа: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    const byId = new Map(parsed.data.items.map((it) => [it.i, it.text.trim()]));
    for (const t of todo) {
      const text = byId.get(t.i);
      if (!text) throw new Error(`перевод: нет перевода для части ${t.key}`);
      cache.entries[`${t.lang}|${t.text}`] = text;
      out.set(t.key, text);
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

export function applyTranslations(phrases: OutPhrase[], translations: Map<string, string>, target: string): OutPhrase[] {
  return phrases.map((p) => {
    const text = translations.get(partKey(p));
    return text && p.lang !== target ? retimePhrase(p, text, target) : p;
  });
}
