import fs from "node:fs/promises";
import path from "node:path";
import type { Frame } from "../lib/aspect.ts";
import { GeminiClient } from "../understand/gemini-client.ts";
import { DEFAULT_GEMINI_MODEL, priceUsage } from "../understand/vision/gemini.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { brandCreditLine, brandMark } from "./brandmarks.ts";
import { commonsCreditLine, commonsRejectReason, cropToFrameFocus, downloadCommons, searchCommons, type CommonsFile } from "./commons.ts";
import type { Design } from "./design.ts";
import type { PhotoCredit } from "./photos.ts";
import { checkRelevance, relevanceDecision, type RelevanceCandidate } from "./relevance.ts";
import { SHOT_LAYOUTS, type BeatSpeech, type SceneShot } from "./scenes.ts";
import type { Script } from "./script.ts";
import {
  beatWords,
  entityFromLlm,
  findMentions,
  findNumbers,
  hashOf,
  KNOWN_ENTITIES,
  readCache,
  scheduleShots,
  scriptInDollars,
  VISUALS_CACHE,
  writeCache,
  type BeatVisuals,
  type EntityDef,
  type NumberMention,
  type PlannedShot,
  type ShotAnchor,
  type VisualOption,
} from "./visuals.ts";

/**
 * Stage 26 glue: script + narration → per-beat visual options (verified real photos of the named entities, brand marks,
 * product UIs, number cards) → the director picks → the sub-shot schedule on the final timeline.
 *
 * Priority per entity: 1) a real photo OF it from Wikimedia Commons (title names it, licence allowed, the vision check
 * says it clearly shows it); 2) its brand mark (Simple Icons) or a typeset wordmark; 3) the product UI drawn in code
 * (Claude Code → a terminal session, an exchange → a ticker board, funding → a round card, comparable numbers → a
 * chart); 4) generated images only for generic beats (never for real people or brands; handled by make's old path).
 */

export interface ResolveOptions {
  frame: Frame;
  /** where the cropped photos go (make/visuals) */
  outDir: string;
  /** one Gemini text call for names the dictionary does not know (default: when a key exists; VEDIT_VISUAL_LLM=off) */
  llm?: boolean;
  key?: string;
  client?: GeminiClient;
  fetchFn?: typeof fetch;
  /** photo candidates per entity sent to the vision check */
  candidates?: number;
  /** accepted photos per entity */
  photosPerEntity?: number;
  /** skip network (tests) */
  offline?: boolean;
  /** stage 27: the entity dictionary to match (the caller ran its own LLM pass); skips this module's LLM pass */
  entities?: EntityDef[];
  onEvent?: (l: string) => void;
}

export interface RelevanceDecisionLog {
  beat: number;
  entity: string;
  title: string;
  shows: boolean;
  score: number;
  sees: string;
  accepted: boolean;
  checked: boolean;
  cached: boolean;
}

export interface VisualPlan {
  beats: BeatVisuals[];
  entities: { id: string; name: string; kind: string; beats: number[]; photos: number; mark: "logo" | "wordmark" | "none"; ui: string | null }[];
  credits: PhotoCredit[];
  brandCredits: string[];
  /** the credit line of each Simple Icons slug */
  brandBySlug: Record<string, string>;
  decisions: RelevanceDecisionLog[];
  llm: { model: string; usd: number; cached: boolean } | null;
  checks: { candidates: number; checked: number; passed: number; cached: number; usd: number; requests: number; model: string };
  /** per beat: the director's analysis hints from the LLM pass (chart series etc.) */
  series: Record<number, { label: string; value: string }[]>;
}

// ---- the cheap LLM pass: names the dictionary does not know, and chartable series ----

const LLM_SCHEMA = {
  type: "OBJECT",
  properties: {
    beats: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          beat: { type: "INTEGER" },
          entities: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: { name: { type: "STRING" }, kind: { type: "STRING", enum: ["company", "product", "person", "place", "exchange", "org"] }, forms: { type: "ARRAY", items: { type: "STRING" } }, commons_query: { type: "STRING" }, subject: { type: "STRING" } },
              required: ["name", "kind", "forms", "commons_query", "subject"],
            },
          },
          series: { type: "ARRAY", items: { type: "OBJECT", properties: { label: { type: "STRING" }, value: { type: "STRING" } }, required: ["label", "value"] } },
          intent: { type: "STRING" },
        },
        required: ["beat", "entities", "series", "intent"],
      },
    },
  },
  required: ["beats"],
};

const LLM_SYSTEM = [
  "You prepare the picture research for a short narrated news video. For every beat list the named things a viewer could be SHOWN: companies, products, people, places, stock exchanges, organisations (investors, banks).",
  "name: the usual written name (Latin for brands: OpenAI, Nasdaq; people in the script's language). forms: every exact spelling of it that occurs in that beat's narration, inflected forms included, copied verbatim.",
  "commons_query: an English Wikimedia Commons search that finds a real photograph OF it (headquarters, signage, the product on a stage, the person's full name); empty for pure software without a physical presence.",
  "subject: an English phrase for a photo checker: what must be visible for a photo to clearly show it.",
  "series: only when the beat's narration compares the SAME measure over periods of the same length at two or more points in time (e.g. yearly revenue last year and now; never a year against a quarter), 2–4 points in time order, label ≤ 12 characters in the script's language, value exactly as said with its unit (\"$13 млрд\"). Otherwise an empty list. Never invent numbers.",
  "intent: 3–6 English words, what the beat should show visually.",
  "Skip generic nouns (company, investors, banks without a name). Return JSON only.",
].join(" ");

interface LlmBeat {
  beat: number;
  entities: { name: string; kind: string; forms: string[]; commons_query: string; subject: string }[];
  series: { label: string; value: string }[];
  intent: string;
}

async function llmPass(script: Script, o: ResolveOptions): Promise<{ beats: LlmBeat[]; model: string; usd: number; cached: boolean } | null> {
  const lines = script.beats.map((b, i) => `${i}: ${b.voiceover?.trim() || b.text}  [screen: ${b.text}]`).join("\n");
  const key = hashOf(["visual-llm/2", lines]);
  const cacheDir = path.join(VISUALS_CACHE, "entities");
  const hit = await readCache<{ beats: LlmBeat[]; model: string }>(cacheDir, key);
  if (hit) return { ...hit, usd: 0, cached: true };
  const apiKey = o.key ?? geminiApiKey();
  if (!apiKey && !o.client) return null;
  const client = o.client ?? new GeminiClient({ apiKey: apiKey!, rounds: 1, roundWaitMs: 15_000, maxRetries: 2, backoffMs: 4000, onLog: (l) => o.onEvent?.(`  ${l}`) });
  const models = (process.env.VEDIT_VISUAL_LLM_MODEL ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const r = await client.generate(models.length ? models : [DEFAULT_GEMINI_MODEL, "gemini-flash-lite-latest", "gemini-3.5-flash"], { system: LLM_SYSTEM, parts: [{ text: `LANGUAGE: ${script.language}\nBEATS:\n${lines}` }], schema: LLM_SCHEMA, temperature: 0, rounds: 1 });
  const beats = ((r.data as { beats?: LlmBeat[] }).beats ?? []).map((b) => ({ beat: Math.round(b.beat), entities: b.entities ?? [], series: b.series ?? [], intent: String(b.intent ?? "") }));
  await writeCache(cacheDir, key, { beats, model: r.model });
  return { beats, model: r.model, usd: priceUsage(r.model, r.usage).usd, cached: false };
}

/** LLM entities the dictionary does not cover (a name or form the dictionary already matches is dropped). */
export function mergeEntities(llm: LlmBeat[] | null, known: EntityDef[] = KNOWN_ENTITIES): EntityDef[] {
  const out = [...known];
  for (const b of llm ?? []) {
    for (const e of b.entities) {
      const texts = [e.name, ...(e.forms ?? [])];
      if (out.some((d) => texts.some((t) => new RegExp(d.match.source, d.match.flags.replace("g", "")).test(t)))) continue;
      const def = entityFromLlm(e);
      if (def && !out.some((d) => d.id === def.id)) out.push(def);
    }
  }
  return out;
}

/** Series values must be said in the beat (no invented chart points). */
export function validSeries(series: { label: string; value: string }[], numbers: NumberMention[]): { label: string; value: string }[] {
  const ok: { label: string; value: string }[] = [];
  for (const s of series) {
    const m = /(\d+(?:[.,]\d+)?)/.exec(s.value);
    const n = m ? numbers.find((x) => x.shown.replace(/^\$/, "") === m[1].replace(".", ",")) : undefined;
    // the value as the video shows numbers («$13 млрд»), never the model's wording
    if (n) ok.push({ label: s.label.replace(/\s+/g, " ").trim().slice(0, 14), value: numText(n) });
  }
  // a year against a quarter (or a month) is not one measure: no chart
  const periods = new Set(ok.map((s) => (/квартал|quarter|\bq[1-4]\b/i.test(s.label) ? "q" : /месяц|month/i.test(s.label) ? "m" : /год|year/i.test(s.label) ? "y" : "")).filter(Boolean));
  if (periods.size > 1) return [];
  return ok.length >= 2 ? ok.slice(0, 4) : [];
}

const FUNDING = /привлек|раунд|инвестиц|вложил|funding|raised|round/i;
const IPO = /\bipo\b|ай-?пи-?о|размещени|выход\p{L}* на бирж|на бирж|nasdaq|насдак|nyse/iu;
const VALUATION = /оцен(ил|к|я)|valuation|valued/i;

const numText = (n: NumberMention) => `${n.shown}${n.unit && n.unit !== "%" ? ` ${n.unit}` : n.unit}`;

/**
 * Resolves the visual options of every beat. Network: Commons searches + downloads, Simple Icons, one Gemini text call,
 * one or two batched Gemini vision calls. Everything is cached; a failing source only removes its options.
 */
export async function resolveVisuals(script: Script, speech: (BeatSpeech | null | undefined)[], o: ResolveOptions): Promise<VisualPlan> {
  const say = (l: string) => o.onEvent?.(l);
  const dollars = scriptInDollars(script);
  let llm: Awaited<ReturnType<typeof llmPass>> = null;
  const wantLlm = !o.entities && (o.llm ?? process.env.VEDIT_VISUAL_LLM?.trim().toLowerCase() !== "off");
  if (wantLlm && !o.offline) {
    try {
      llm = await llmPass(script, o);
      if (llm) say(`  сущности (Gemini ${llm.model}${llm.cached ? ", кэш" : `, $${llm.usd.toFixed(4)}`}): ${[...new Set(llm.beats.flatMap((b) => b.entities.map((e) => e.name)))].join(", ") || "—"}`);
    } catch (err) {
      say(`  ⚠ разбор сущностей Gemini не удался: ${err instanceof Error ? err.message.split("\n")[0].slice(0, 160) : err}`);
    }
  }
  const entities = o.entities ?? mergeEntities(llm?.beats ?? null);
  const byId = new Map(entities.map((e) => [e.id, e]));
  const beats: BeatVisuals[] = script.beats.map((_, i) => {
    const words = beatWords(script, i, speech[i]);
    return { beat: i, mentions: findMentions(words, entities), numbers: findNumbers(words, { dollars }), options: [] };
  });
  const series: VisualPlan["series"] = {};
  for (const b of llm?.beats ?? []) {
    const v = validSeries(b.series ?? [], beats[b.beat]?.numbers ?? []);
    if (v.length) series[b.beat] = v;
  }
  const used = [...new Set(beats.flatMap((b) => b.mentions.map((m) => m.entity)))];
  say(`  названы: ${used.map((id) => byId.get(id)?.name ?? id).join(", ") || "—"}; чисел: ${beats.reduce((n, b) => n + b.numbers.length, 0)}`);

  // 1. real photos of each named entity (Commons) → one batched vision check
  const decisions: RelevanceDecisionLog[] = [];
  const credits: PhotoCredit[] = [];
  const photos = new Map<string, { file: string; credit: PhotoCredit; score: number; focus: { x: number; y: number }; title: string }[]>();
  const cands: (RelevanceCandidate & { entity: string; file0: CommonsFile })[] = [];
  const perEntity = o.candidates ?? 3;
  if (!o.offline) {
    for (const id of used) {
      const def = byId.get(id)!;
      if (!def.commons?.length) continue;
      const seen = new Set<number>();
      const picked: CommonsFile[] = [];
      for (const q of def.commons.slice(0, 3)) {
        if (picked.length >= perEntity) break;
        let res: CommonsFile[] = [];
        try {
          res = await searchCommons(q, { fetchFn: o.fetchFn });
        } catch (err) {
          say(`  ⚠ Commons «${q}»: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        for (const f of res) {
          if (picked.length >= perEntity || seen.has(f.pageid)) continue;
          seen.add(f.pageid);
          const why = commonsRejectReason(f, o.frame, def.titleWords ?? [def.name]);
          if (why) continue;
          picked.push(f);
        }
      }
      for (const f of picked) {
        const src = await downloadCommons(f, o.frame, { fetchFn: o.fetchFn });
        if (!src) continue;
        cands.push({ id: `${id}#${f.pageid}`, file: src, subject: def.subject ?? `${def.name}`, title: def.kind === "person" ? f.title : undefined, entity: id, file0: f });
      }
    }
  }
  let checks: VisualPlan["checks"] = { candidates: cands.length, checked: 0, passed: 0, cached: 0, usd: 0, requests: 0, model: "" };
  if (cands.length) {
    say(`  проверка фото (${cands.length}, Gemini vision одним-двумя запросами)…`);
    const rel = await checkRelevance(cands, { key: o.key, client: o.client, onLog: (l) => say(`  ${l}`) });
    checks = { candidates: cands.length, checked: [...rel.verdicts.values()].filter((v) => v.checked).length, passed: 0, cached: [...rel.verdicts.values()].filter((v) => v.cached).length, usd: rel.usd, requests: rel.requests, model: rel.model };
    const keep = o.photosPerEntity ?? 2;
    for (const c of cands) {
      const v = rel.verdicts.get(c.id);
      if (!v) continue;
      const ok = relevanceDecision(v);
      if (ok) checks.passed++;
      decisions.push({ beat: -1, entity: c.entity, title: c.file0.title, shows: v.shows, score: v.score, sees: v.sees, accepted: ok, checked: v.checked, cached: v.cached });
      say(`    ${ok ? "✓" : "✗"} ${byId.get(c.entity)?.name}: «${c.file0.title.slice(0, 60)}» ${v.checked ? `${v.score}/10 — ${v.sees}` : "(без проверки)"}`);
      if (!ok) continue;
      const list = photos.get(c.entity) ?? [];
      if (list.length >= keep) continue;
      const dest = path.join(o.outDir, `${c.entity}-${list.length}.jpg`);
      try {
        await cropToFrameFocus(c.file, dest, o.frame, v.focus);
      } catch {
        continue;
      }
      const f = c.file0;
      const credit: PhotoCredit = { beat: -1, query: byId.get(c.entity)?.name ?? c.entity, id: `commons-${f.pageid}`, title: f.title, creator: f.artist, creator_url: "", license: f.license === "pd" ? "pdm" : f.license, license_version: f.license_version, license_url: f.license_url, url: f.descriptionUrl, source: "wikimedia commons", file: dest };
      list.push({ file: dest, credit, score: v.score, focus: v.focus, title: f.title });
      photos.set(c.entity, list);
    }
  }

  // 2. brand marks / wordmarks
  const marks = new Map<string, { path?: string; hex: string; slug?: string; credit?: string }>();
  for (const id of used) {
    const def = byId.get(id)!;
    if (def.kind === "person" || def.kind === "place") continue;
    if (def.icon && !o.offline) {
      try {
        const m = await brandMark(def.icon, { fetchFn: o.fetchFn });
        if (m) {
          marks.set(id, { path: m.path, hex: m.hex, slug: m.slug, credit: brandCreditLine(m) });
          continue;
        }
      } catch (err) {
        say(`  ⚠ Simple Icons ${def.icon}: ${err instanceof Error ? err.message : err}`);
      }
    }
    marks.set(id, { hex: def.color ?? "" });
  }
  const brandCredits = [...new Set([...marks.values()].map((m) => m.credit).filter((x): x is string => !!x))];
  const brandBySlug: Record<string, string> = {};
  for (const m of marks.values()) if (m.slug && m.credit) brandBySlug[m.slug] = m.credit;

  // 3. options per beat
  const factTape: { label: string; value: string }[] = [];
  for (const b of beats) {
    const main = b.mentions.find((m) => byId.get(m.entity)?.kind === "company") ?? b.mentions[0];
    for (const n of b.numbers) if (main && n.unit && n.unit !== "%") factTape.push({ label: (byId.get(main.entity)?.name ?? "").toUpperCase(), value: numText(n) });
  }
  for (const b of beats) {
    const opts: VisualOption[] = [];
    const add = (x: Omit<VisualOption, "beat">) => {
      if (!opts.some((y) => y.id === x.id)) opts.push({ ...x, beat: b.beat });
    };
    const text = `${script.beats[b.beat].voiceover ?? ""} ${script.beats[b.beat].text}`;
    for (const m of b.mentions) {
      const def = byId.get(m.entity)!;
      (photos.get(m.entity) ?? []).forEach((p, k) => add({ id: `b${b.beat}.${m.entity}.p${k}`, kind: "photo", entity: m.entity, label: `real photo: ${p.title.replace(/\.(jpe?g|webp|tiff?)$/i, "")} (Commons, ${p.credit.license.toUpperCase()}, ${p.score}/10)`, file: p.file, focus: p.focus, credit: p.credit, score: p.score, name: def.name }));
      const mk = marks.get(m.entity);
      if (mk?.path) add({ id: `b${b.beat}.${m.entity}.l`, kind: "logo", entity: m.entity, label: `${def.name} brand mark`, path: mk.path, hex: mk.hex, slug: mk.slug, name: def.name });
      else if (mk) add({ id: `b${b.beat}.${m.entity}.l`, kind: "wordmark", entity: m.entity, label: `${def.name} wordmark (typeset name)`, hex: mk.hex, name: def.name });
      if (def.kind === "person" && !(photos.get(m.entity) ?? []).length) add({ id: `b${b.beat}.${m.entity}.l`, kind: "wordmark", entity: m.entity, label: `${def.name} (name card)`, name: def.name });
      if (def.ui === "terminal") add({ id: `b${b.beat}.${m.entity}.u`, kind: "ui", entity: m.entity, label: `${def.name} terminal session (UI drawn in code)`, graphic: { kind: "terminal", title: def.id === "claude-code" ? "claude" : def.name.toLowerCase(), items: [{ label: "Read", value: "src/billing/" }, { label: "Edit", value: "src/billing.ts" }, { label: "Run tests", value: "passed" }], note: script.language.startsWith("ru") || script.language === "Russian" ? "добавь оплату и тесты" : "add billing and tests" } });
      if (def.ui === "chat") add({ id: `b${b.beat}.${m.entity}.u`, kind: "ui", entity: m.entity, label: `${def.name} chat (UI drawn in code)`, graphic: { kind: "chat", title: def.name, items: [{ label: "user", value: script.beats[b.beat].text }, { label: "ai", value: def.name }], note: "" } });
      if (def.ui === "ticker") {
        const co = b.mentions.find((x) => byId.get(x.entity)?.kind === "company");
        const last = b.numbers.filter((n) => n.unit && n.unit !== "%").at(-1);
        add({ id: `b${b.beat}.${m.entity}.u`, kind: "ui", entity: m.entity, label: `${def.name} ticker board (UI drawn in code, facts from the script)`, graphic: { kind: "ticker", title: def.name.toUpperCase(), items: [{ label: `${co ? byId.get(co.entity)?.name : def.name}${IPO.test(text) ? " · IPO" : ""}`, value: last ? numText(last) : "" }, ...factTape.slice(0, 4)], note: "" } });
      }
    }
    // numbers: the main entity's mark with the number, the concept UI, a number card
    const main = b.mentions.find((m) => (byId.get(m.entity)?.kind ?? "") !== "exchange") ?? b.mentions[0];
    const money = b.numbers.filter((n) => n.unit && n.unit !== "%");
    b.numbers.forEach((n, j) => {
      const mk = main ? marks.get(main.entity) : undefined;
      // the mention right before the number names whose number it is
      const owner = [...b.mentions].reverse().find((m) => m.word <= n.word && byId.get(m.entity)?.kind !== "exchange") ?? main;
      const om = owner ? marks.get(owner.entity) : mk;
      if (owner && om) add({ id: `b${b.beat}.${owner.entity}.ln${j}`, kind: om.path ? "logo" : "wordmark", entity: owner.entity, label: `${byId.get(owner.entity)?.name} mark + «${numText(n)}»`, path: om.path, hex: om.hex, slug: om.slug, name: byId.get(owner.entity)?.name, number: { value: n.shown, unit: n.unit }, numberIndex: j });
      add({ id: `b${b.beat}.n${j}`, kind: "number", label: `number card «${numText(n)}»`, number: { value: n.shown, unit: n.unit }, name: owner ? byId.get(owner.entity)?.name : undefined, numberIndex: j });
    });
    if (FUNDING.test(text) && money.length) {
      const val = VALUATION.test(text) && money.length > 1 ? money[money.length - 1] : null;
      const orgs = b.mentions.filter((m) => byId.get(m.entity)?.kind === "org").map((m) => byId.get(m.entity)!.name);
      add({ id: `b${b.beat}.round`, kind: "ui", label: `funding round card «${numText(money[0])}»${val ? ` / valuation «${numText(val)}»` : ""}`, graphic: { kind: "round", title: script.language.startsWith("ru") || script.language === "Russian" ? "Раунд финансирования" : "Funding round", items: [{ label: main ? byId.get(main.entity)?.name ?? "" : "", value: numText(money[0]) }, ...(val ? [{ label: script.language === "en" ? "valuation" : "оценка", value: numText(val) }] : [])], note: orgs.join(", ") }, numberIndex: b.numbers.indexOf(money[0]) });
    }
    if (series[b.beat]) add({ id: `b${b.beat}.chart`, kind: "ui", label: `line chart ${series[b.beat].map((s) => `${s.label} ${s.value}`).join(" → ")}`, graphic: { kind: "line", title: script.beats[b.beat].text, items: series[b.beat], note: "" }, numberIndex: Math.max(0, b.numbers.findIndex((n) => numText(n) === series[b.beat][0].value)) });
    b.options = opts;
  }
  const entityList = used.map((id) => ({ id, name: byId.get(id)!.name, kind: byId.get(id)!.kind, beats: beats.filter((b) => b.mentions.some((m) => m.entity === id)).map((b) => b.beat), photos: photos.get(id)?.length ?? 0, mark: (marks.get(id)?.path ? "logo" : marks.has(id) ? "wordmark" : "none") as "logo" | "wordmark" | "none", ui: byId.get(id)!.ui ?? null }));
  for (const [id, list] of photos) for (const p of list) credits.push({ ...p.credit, beat: beats.find((b) => b.mentions.some((m) => m.entity === id))?.beat ?? -1 });
  return { beats, entities: entityList, credits, brandCredits, brandBySlug, decisions, llm: llm ? { model: llm.model, usd: llm.usd, cached: llm.cached } : null, checks, series };
}

/** The options of every beat as lines for the art director's prompt. */
export function optionsForDirector(plan: Pick<VisualPlan, "beats">): string {
  return plan.beats
    .map((b) => `${b.beat}: ${b.options.length ? b.options.map((o) => `${o.id} = ${o.label}`).join(" · ") : "(no named entity or number: use a generic photo query)"}`)
    .join("\n");
}

// ---- the schedule on the final timeline ----

const KIND_RANK: Record<string, number> = { photo: 0, ui: 1, logo: 2, wordmark: 3, number: 4, layout: 5 };

export interface PlanShotsOptions {
  timings: { start: number; duration: number }[];
  speech: (BeatSpeech | null | undefined)[];
  /** generic photo of a beat (the director's own query, Openverse), project-relative src */
  genericImages?: Record<number, string>;
  /** option id → project-relative src for photos */
  srcOf?: (opt: VisualOption) => string;
  musicBeats?: number[];
}

/**
 * Sub-shots per beat (null = the scene's layout as is). Options of an entity are ordered by kind (photo, product UI for
 * products, mark) and by how often the video already showed them, so a company named in four beats is seen as a photo,
 * then its mark, then its product.
 */
export function planShots(script: Script, design: Design, visuals: VisualPlan, o: PlanShotsOptions): { shots: (SceneShot[] | null)[]; planned: (PlannedShot[] | null)[] } {
  const useCount = new Map<string, number>();
  const kindKey = (x: VisualOption) => `${x.entity ?? ""}:${x.kind}:${x.file ?? x.graphic?.kind ?? ""}`;
  const shots: (SceneShot[] | null)[] = [];
  const planned: (PlannedShot[] | null)[] = [];
  design.scenes.forEach((scene, i) => {
    const t = o.timings[i];
    const bv = visuals.beats[i];
    const layout = scene.layout;
    const media = layout.startsWith("media_") || layout === "headline";
    const shotLayout = (SHOT_LAYOUTS as readonly string[]).includes(layout);
    if (!t || !bv || (!media && !shotLayout)) {
      shots.push(null);
      planned.push(null);
      return;
    }
    const chosen = scene.shots?.length ? bv.options.filter((x) => scene.shots!.includes(x.id)) : [];
    const pool = chosen.length >= 1 ? [...chosen, ...bv.options.filter((x) => !chosen.includes(x) && (x.kind === "number" || x.id.includes(".ln")))] : bv.options;
    const byId = new Map(pool.map((x) => [x.id, x]));
    const generic = o.genericImages?.[i];
    if (generic) byId.set(`b${i}.gen`, { id: `b${i}.gen`, beat: i, kind: "photo", label: "generic photo", file: generic });
    const kindOf = new Map(visuals.entities.map((e) => [e.id, e.kind]));
    // a product is best shown by its UI (Claude Code → terminal); anything else by a photo, then its mark
    const rank = (x: VisualOption) => (x.kind === "ui" && kindOf.get(x.entity ?? "") === "product" ? -0.5 : KIND_RANK[x.kind] ?? 9) + 1.2 * (useCount.get(kindKey(x)) ?? 0);
    const anchors: ShotAnchor[] = [];
    const sp = o.speech[i];
    const words = beatWords(script, i, sp, t.start, t.duration);
    const seenEntity = new Set<string>();
    for (const m of bv.mentions) {
      if (seenEntity.has(m.entity)) continue;
      seenEntity.add(m.entity);
      const opts = pool.filter((x) => x.entity === m.entity && x.numberIndex === undefined).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
      if (opts.length) anchors.push({ t: words[m.word]?.start ?? m.t, key: m.entity, options: opts.map((x) => x.id) });
    }
    // the typographic layout comes in when the number IT shows is said (hero «≈$50» → at «50»)
    const shown = shotLayout ? JSON.stringify([scene.number?.value ?? "", scene.items]) : "";
    let layoutJ = shotLayout ? bv.numbers.findIndex((n) => shown.includes(n.shown.replace(/^\$/, ""))) : -1;
    if (shotLayout && layoutJ < 0 && bv.numbers.length && scene.layout !== "compare") layoutJ = 0;
    bv.numbers.forEach((n, j) => {
      if (layout === "media_number") return;
      const at = words[n.word]?.start ?? n.t;
      if (j === layoutJ) {
        anchors.push({ t: at, key: `#${j}`, options: ["layout"] });
        return;
      }
      const opts = pool.filter((x) => x.numberIndex === j).sort((a, b) => (a.kind === "ui" ? -1 : 0) - (b.kind === "ui" ? -1 : 0) || (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9));
      if (opts.length) anchors.push({ t: at, key: `#${j}`, options: opts.map((x) => x.id) });
    });
    const fill: string[] = [];
    if (shotLayout && layoutJ < 0) fill.push("layout");
    if (generic) fill.push(`b${i}.gen`);
    for (const x of pool) if (x.numberIndex === undefined && !fill.includes(x.id)) fill.push(x.id);
    if (shotLayout && !fill.includes("layout")) fill.push("layout");
    const uis = pool.filter((y) => y.kind === "ui" && !y.entity).map((y) => y.id);
    const variants = (id: string): string[] => {
      if (id === "layout") return uis;
      const x = byId.get(id.replace(/~detail$/, ""));
      if (!x) return [];
      const same = pool.filter((y) => y.entity && y.entity === x.entity && y.id !== x.id && y.numberIndex === undefined).map((y) => y.id);
      // «~detail»: a punch-in on a photo, the alternative composition of a mark / wordmark / number card (accent field)
      const alt = id.endsWith("~detail") || x.kind === "ui" ? [] : [`${id}~detail`];
      if (x.kind === "number") return [...uis, ...(shotLayout ? ["layout"] : []), ...alt];
      return x.kind === "photo" ? [...alt, ...same] : [...same, ...alt];
    };
    const plan = scheduleShots({ start: t.start, end: t.start + t.duration, anchors, fill, variants, wordStarts: words.map((w) => w.start), musicBeats: o.musicBeats });
    if (!plan.length || (plan.length === 1 && plan[0].option === "layout")) {
      shots.push(null);
      planned.push(null);
      return;
    }
    planned.push(plan);
    shots.push(
      plan.map((s) => {
        if (s.option === "layout") return { start: s.start, end: s.end, option: "layout" as const };
        const detail = s.option.endsWith("~detail");
        const x = byId.get(s.option.replace(/~detail$/, ""))!;
        useCount.set(kindKey(x), (useCount.get(kindKey(x)) ?? 0) + 1);
        const n = x.numberIndex !== undefined ? bv.numbers[x.numberIndex] : undefined;
        return { start: s.start, end: s.end, option: x, detail, src: x.kind === "photo" ? (x.id.endsWith(".gen") ? generic : o.srcOf?.(x)) : undefined, numberAt: n ? (words[n.word]?.start ?? n.t) : undefined };
      }),
    );
  });
  return { shots, planned };
}

/**
 * How well the pictures follow the narration: an entity mention counts as shown when a sub-shot of its beat showing that
 * entity is on screen within 1 s after it is said; a number counts when a pane shows it (a number card, a mark with the
 * number, a chart/round/ticker built on it) or the scene's own number layout carries it.
 */
export function visualReport(v: VisualPlan, shots: (SceneShot[] | null)[], timings: { start: number; duration: number }[], speech: (BeatSpeech | null | undefined)[], script: Script, design: Design, usd: number) {
  let mentions = 0;
  let mentionsShown = 0;
  let numbers = 0;
  let numbersShown = 0;
  for (const b of v.beats) {
    const t = timings[b.beat];
    if (!t) continue;
    const words = beatWords(script, b.beat, speech[b.beat], t.start, t.duration);
    const list = shots[b.beat] ?? [];
    const at = (word: number, fallback: number) => words[word]?.start ?? fallback;
    const seen = new Set<string>();
    for (const m of b.mentions) {
      if (seen.has(m.entity)) continue;
      seen.add(m.entity);
      mentions++;
      const tm = at(m.word, m.t);
      if (list.some((s) => s.option !== "layout" && s.option.entity === m.entity && s.start <= tm + 1 && s.end >= tm)) mentionsShown++;
    }
    const scene = design.scenes[b.beat];
    b.numbers.forEach((n, j) => {
      numbers++;
      const tm = at(n.word, n.t);
      const digits = n.shown.replace(/^\$/, "");
      const onPane = list.some((s) => s.start <= tm + 1 && s.end >= tm && (s.option === "layout" ? JSON.stringify([scene?.number, scene?.items]).includes(digits) : s.option.numberIndex === j || JSON.stringify(s.option.graphic ?? "").includes(digits)));
      const inLayout = !list.length && !!scene && ["media_number", "hero_number", "tunnel_number", "compare"].includes(scene.layout) && JSON.stringify([scene.number, scene.items]).includes(digits);
      if (onPane || inLayout) numbersShown++;
    });
  }
  const st = shots.flatMap((l, i) => l ?? [{ start: timings[i]?.start ?? 0, end: (timings[i]?.start ?? 0) + (timings[i]?.duration ?? 0) }]);
  const mean = st.length ? st.reduce((n, s) => n + s.end - s.start, 0) / st.length : 0;
  return { shots: st.length, mean_shot: Math.round(mean * 100) / 100, mentions, mentions_shown: mentionsShown, numbers, numbers_shown: numbersShown, photo_candidates: v.checks.candidates, photos_checked: v.checks.checked, photos_passed: v.checks.passed, usd: Math.round(usd * 1e5) / 1e5 };
}

/** visuals.json: what was found, checked, picked and shown (for the report and debugging). */
export async function writeVisualsReport(file: string, v: VisualPlan, planned: (PlannedShot[] | null)[]) {
  const out = {
    entities: v.entities,
    llm: v.llm,
    checks: v.checks,
    decisions: v.decisions,
    beats: v.beats.map((b) => ({ beat: b.beat, mentions: b.mentions.map((m) => ({ entity: m.entity, t: m.t, text: m.text })), numbers: b.numbers.map((n) => ({ shown: n.shown, unit: n.unit, t: n.t, text: n.text })), options: b.options.map((x) => ({ id: x.id, kind: x.kind, label: x.label })), shots: planned[b.beat] ?? null })),
    credits: v.credits.map((c) => commonsCreditLine({ title: c.title, artist: c.creator, license_short: c.license === "pdm" ? "Public domain" : c.license === "cc0" ? "CC0" : `CC ${c.license.toUpperCase()} ${c.license_version}`.trim(), descriptionUrl: c.url })),
    brand_credits: v.brandCredits,
  };
  await fs.writeFile(file, JSON.stringify(out, null, 1));
}
