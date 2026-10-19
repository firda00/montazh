// Stage 30, dubbing: phrase-by-phrase translation with a character budget per phrase (the dub must fit the time
// the original phrase had). Chunks of ~60 phrases per structured call (a 2-hour podcast ≈ 1500 phrases ≈ 25 calls),
// with the previous phrases as context; cached in the job folder, so a re-run (other voice, failed TTS) is free.
// The captions translator's cache (translations_<lang>.json, design/translate.ts) is read first and filled after:
// reels dubbed and captioned in the same language say and show the same words.
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { addCost } from "../lib/cost.ts";
import { exists, readJson, writeJson } from "../lib/workspace.ts";
import { zodToApiSchema } from "../plan/schema-sanitize.ts";
import type { StructuredFn } from "../lib/llm.ts";
import { fill, loadPrompt } from "../lib/prompts.ts";
import { LANGUAGE_NAMES, TranslationCacheSchema } from "../design/translate.ts";

const ItemsSchema = z.object({ items: z.array(z.object({ i: z.number(), text: z.string() })) });

export interface DubItem {
  i: number;
  text: string;
  lang: string;
  max_chars: number;
}

export interface DubTranslateOptions {
  /** phrases per call (default VEDIT_DUB_CHUNK or 60) */
  chunk?: number;
  model?: string;
  /** job id for cost.json (optional: the CLI on a bare file still has a job) */
  jobId?: string;
  onEvent?: (line: string) => void;
  signal?: AbortSignal;
}

export interface DubTranslation {
  texts: Map<number, string>;
  usd: number;
  calls: number;
  cached: number;
  model?: string;
}

const DubCacheSchema = z.object({ target: z.string(), entries: z.record(z.string(), z.string()) });
const cacheKey = (it: Pick<DubItem, "lang" | "text">) => `${it.lang}|${it.text}`;

/** a cached captions translation is reused when it is not much longer than the dub's budget */
const fitsBudget = (text: string, max: number) => text.length <= Math.round(max * 1.15);

export async function translateForDub(dir: string, items: DubItem[], target: string, llm: StructuredFn, o: DubTranslateOptions = {}): Promise<DubTranslation> {
  const dubFile = path.join(dir, `dub_translations_${target}.json`);
  const capFile = path.join(dir, `translations_${target}.json`);
  const dubCache = (await exists(dubFile)) ? await readJson(dubFile, DubCacheSchema) : { target, entries: {} as Record<string, string> };
  const capCache = (await exists(capFile)) ? await readJson(capFile, TranslationCacheSchema) : { target, entries: {} as Record<string, string> };
  const texts = new Map<number, string>();
  const todo: DubItem[] = [];
  let cached = 0;
  for (const it of items) {
    if (!it.text.trim()) {
      texts.set(it.i, "");
      continue;
    }
    if (it.lang === target) {
      // already in the target language: the dub repeats it (rare: a mixed-language podcast)
      texts.set(it.i, it.text);
      continue;
    }
    const hit = dubCache.entries[cacheKey(it)] ?? (capCache.entries[cacheKey(it)] && fitsBudget(capCache.entries[cacheKey(it)], it.max_chars) ? capCache.entries[cacheKey(it)] : undefined);
    if (hit !== undefined) {
      texts.set(it.i, hit);
      cached++;
    } else todo.push(it);
  }
  const chunk = Math.max(5, o.chunk ?? (Number(process.env.VEDIT_DUB_CHUNK) || 60));
  let usd = 0;
  let calls = 0;
  let model: string | undefined;
  const to = LANGUAGE_NAMES[target] ?? target;
  for (let k = 0; k < todo.length; k += chunk) {
    if (o.signal?.aborted) throw new Error("отменено");
    const part = todo.slice(k, k + chunk);
    o.onEvent?.(`▸ перевод фраз ${k + 1}–${k + part.length} из ${todo.length}…`);
    // the last few translated phrases before this chunk keep pronouns and terms consistent
    const before = items.filter((x) => x.i < part[0].i && texts.get(x.i)).slice(-4).map((x) => texts.get(x.i)!);
    const from = [...new Set(part.map((x) => x.lang))].map((l) => LANGUAGE_NAMES[l] ?? l).join(", ");
    const prompt = fill(loadPrompt("dub.user"), { from, to, context: before.length ? before.join(" / ") : "—", items: JSON.stringify({ items: part.map(({ i, text, max_chars }) => ({ i, text, max_chars })) }) });
    const res = await llm({ system: fill(loadPrompt("dub.system"), { to }), prompt, schema: zodToApiSchema(ItemsSchema), model: o.model, effort: "low", maxTokens: 16000 });
    calls++;
    usd += res.usd;
    model = res.model;
    if (o.jobId) await addCost(o.jobId, { step: "design", provider: `${res.provider} (dub translate)`, model: res.model, units: { ...res.usage, calls: 1, phrases: part.length }, usd: res.usd });
    const parsed = ItemsSchema.safeParse(res.data);
    if (!parsed.success) throw new Error(`перевод для озвучки: неожиданный формат ответа: ${parsed.error.issues.map((x) => x.message).join("; ")}`);
    const byId = new Map(parsed.data.items.map((x) => [x.i, x.text.trim()]));
    for (const it of part) {
      const text = byId.get(it.i);
      // a missing item is spoken in silence rather than failing a 2-hour job
      texts.set(it.i, text ?? "");
      if (text !== undefined) {
        dubCache.entries[cacheKey(it)] = text;
        // captions in this language made later reuse the dubbed wording
        if (text && capCache.entries[cacheKey(it)] === undefined) capCache.entries[cacheKey(it)] = text;
      }
    }
    await writeJson(dubFile, DubCacheSchema, dubCache);
  }
  if (calls) await writeJson(capFile, TranslationCacheSchema, capCache);
  return { texts, usd, calls, cached, model };
}

/** The second pass: shorter lines for phrases that still did not fit (speed-up at its maximum and trimmed). */
export async function shortenForDub(dir: string, items: { i: number; text: string; max_chars: number; key: string }[], target: string, llm: StructuredFn, o: Pick<DubTranslateOptions, "model" | "jobId"> = {}): Promise<{ texts: Map<number, string>; usd: number }> {
  if (!items.length) return { texts: new Map(), usd: 0 };
  const to = LANGUAGE_NAMES[target] ?? target;
  const prompt = fill(loadPrompt("dub.shorten"), { to, items: JSON.stringify({ items: items.map(({ i, text, max_chars }) => ({ i, text, max_chars })) }) });
  const res = await llm({ system: fill(loadPrompt("dub.system"), { to }), prompt, schema: zodToApiSchema(ItemsSchema), model: o.model, effort: "low", maxTokens: 8000 });
  if (o.jobId) await addCost(o.jobId, { step: "design", provider: `${res.provider} (dub shorten)`, model: res.model, units: { ...res.usage, calls: 1, phrases: items.length }, usd: res.usd });
  const parsed = ItemsSchema.safeParse(res.data);
  const out = new Map<number, string>();
  if (!parsed.success) return { texts: out, usd: res.usd };
  const dubFile = path.join(dir, `dub_translations_${target}.json`);
  const dubCache = (await exists(dubFile)) ? await readJson(dubFile, DubCacheSchema) : { target, entries: {} as Record<string, string> };
  for (const x of parsed.data.items) {
    const it = items.find((y) => y.i === x.i);
    // only an actually shorter line replaces the first one
    if (it && x.text.trim() && x.text.trim().length < it.text.length) {
      out.set(x.i, x.text.trim());
      dubCache.entries[it.key] = x.text.trim();
    }
  }
  await fs.mkdir(dir, { recursive: true });
  await writeJson(dubFile, DubCacheSchema, dubCache);
  return { texts: out, usd: res.usd };
}
