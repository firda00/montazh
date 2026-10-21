import type { StructuredFn } from "../../lib/llm.ts";
import { fill, loadPrompt } from "../../lib/prompts.ts";
import { zodToApiSchema } from "../../plan/schema-sanitize.ts";
import { describeFindings, findCliches, type SlopFinding } from "../slop.ts";
import { LANGUAGE_NAMES, type Script } from "../script.ts";
import { mergeStory, normalizePromo, PromoScreensOutSchema, PromoStoryOutSchema, promoLines, type Promo, type PromoStoryOut } from "./schema.ts";
import { briefText, type SiteBrief } from "./site.ts";
import { z } from "zod";

/** Features for a target length: a feature (text card + UI) is ~6.2 s, the frame around them ~24 s. */
export function featuresFor(seconds: number): number {
  return Math.max(3, Math.min(5, Math.round((seconds - 24) / 6.2)));
}

/** The promo's visible lines as a Script, so the shared cliché check (src/make/slop.ts) can read them. */
export function promoAsScript(p: Promo): Script {
  const says = [p.hook.say, ...p.pains.map((x) => x.say), p.reveal.say, p.audience.say, p.summary.say, ...p.features.map((x) => x.say), p.proof?.say ?? "", p.outro.say];
  const lines = promoLines(p);
  return { title: p.title, language: p.language, hashtags: p.hashtags, beats: lines.map((text, k) => ({ text, emphasis: "", icon: "sparkles", seconds: 3, ...(says[k] ? { voiceover: says[k] } : {}) })) };
}

export interface PromoWriteResult {
  promo: Promo;
  usd: number;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: string;
  estimate: boolean;
  cliches: SlopFinding[];
  remaining: SlopFinding[];
}

export async function writePromo(input: string, llm: StructuredFn, o: { language?: string; seconds?: number; aspect?: string; site?: SiteBrief | null; model?: string } = {}): Promise<PromoWriteResult> {
  const language = o.language ?? "en";
  const seconds = o.seconds ?? 60;
  const lang = LANGUAGE_NAMES[language] ?? language;
  const system = loadPrompt("make.promo.system");
  const storySchema = zodToApiSchema(PromoStoryOutSchema);
  const screensSchema = zodToApiSchema(PromoScreensOutSchema);
  const prompt = fill(loadPrompt("make.promo.user"), {
    input,
    language: lang,
    seconds,
    features: featuresFor(seconds),
    aspect: o.aspect === "9:16" ? "9:16 vertical (Reels/Shorts): keep every line short" : "16:9 (YouTube)",
    site: o.site ? `\n${briefText(o.site)}${o.site.accent ? `\nbrand colour from the site: ${o.site.accent}` : ""}\n` : "",
  });
  let usd = 0;
  const usage = { input_tokens: 0, output_tokens: 0 };
  let model = "";
  let provider = "";
  let estimate = false;
  const call = async (p: string, schema: Record<string, unknown>, maxTokens: number) => {
    const r = await llm({ system, prompt: p, schema, model: o.model, effort: "medium", maxTokens });
    usd += r.usd;
    usage.input_tokens += r.usage.input_tokens;
    usage.output_tokens += r.usage.output_tokens;
    model = r.model;
    provider = r.provider;
    estimate ||= r.estimate;
    return r.data;
  };
  /** story → screens → normalised promo */
  const write = async (storyPrompt: string): Promise<Promo> => {
    const story = PromoStoryOutSchema.parse(await call(storyPrompt, storySchema, 6000)) as PromoStoryOut;
    const plan = [...story.features.map((f, k) => `${k + 1}. ${f.ui_kind} — «${f.a} ${f.b}» — ${f.ui_brief}`), ...(story.proof?.ui_kind ? [`${story.features.length + 1}. ${story.proof.ui_kind} (proof) — «${story.proof.a} ${story.proof.b}» — ${story.proof.ui_brief}`] : [])].join("\n");
    const screensPrompt = fill(loadPrompt("make.promo.screens"), { language: lang, story: JSON.stringify({ product: story.product, mode: story.mode, integrations: story.integrations }), plan, count: story.features.length + (story.proof?.ui_kind ? 1 : 0) });
    const screens = PromoScreensOutSchema.parse(await call(screensPrompt, screensSchema, 6000)).screens;
    const p = normalizePromo(mergeStory(story, screens), { language, url: o.site?.url });
    // the site's colour wins over a guess
    if (o.site?.accent) p.product.accent = o.site.accent;
    return p;
  };
  let promo = await write(prompt);
  // a promo hook is an object + a negation by design (reference #16): the reel rule «hook needs a number or a name» does not apply
  const check = (p: Promo) => findCliches(promoAsScript(p), { allowCta: true }).filter((x) => x.rule !== "vague_hook");
  const cliches = check(promo);
  let remaining = cliches;
  if (cliches.length) {
    try {
      const p2 = await write(`${prompt}\n\nA previous draft used banned phrasing — avoid it:\n${describeFindings(cliches)}`);
      const left = check(p2);
      if (left.length <= cliches.length) {
        promo = p2;
        remaining = left;
      }
    } catch {
      /* the first draft stands */
    }
  }
  return { promo, usd, usage, model, provider, estimate, cliches, remaining };
}

/** What a group of scenes shows (on-screen lines + what the UI does) and how long it stays. */
export interface NarrationGroup {
  seconds: number;
  screen: string;
}

/** Words a group of `seconds` can hold at a calm narrator pace (≈ 2.4 words/s, minus a breath). */
export const narrationWords = (seconds: number) => Math.max(3, Math.floor((seconds - 0.6) * 2.4));

/**
 * The voice-over of a promo: one spoken line per scene group, fitted to the group's seconds (`--voice`). One structured
 * call (prompts/make.promo.narration.md); lines longer than their budget are cut back to it at a sentence or word end.
 */
export async function writeNarration(p: Promo, groups: NarrationGroup[], llm: StructuredFn, o: { model?: string } = {}): Promise<{ lines: string[]; usd: number; model: string; provider: string }> {
  const lang = LANGUAGE_NAMES[p.language] ?? p.language;
  const prompt = fill(loadPrompt("make.promo.narration"), {
    language: lang,
    product: `${p.product.name}${p.product.tagline ? ` — ${p.product.tagline}` : ""}${p.mode === "explainer" ? " (an explainer)" : ""}`,
    groups: groups.map((g, k) => `${k + 1}. ${g.seconds.toFixed(1)} s, at most ${narrationWords(g.seconds)} words · ${g.screen}`).join("\n"),
    count: groups.length,
  });
  const schema = zodToApiSchema(z.object({ lines: z.array(z.string()) }));
  const r = await llm({ system: loadPrompt("make.promo.system"), prompt, schema, model: o.model, effort: "medium", maxTokens: 3000 });
  const raw = (r.data as { lines?: unknown[] }).lines ?? [];
  const lines = groups.map((g, k) => {
    const line = String(raw[k] ?? "").replace(/\s+/g, " ").trim();
    const max = narrationWords(g.seconds);
    const ws = line.split(" ");
    if (ws.length <= max) return line;
    const cut = ws.slice(0, max).join(" ");
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    return end > cut.length * 0.5 ? cut.slice(0, end + 1) : cut.replace(/[,;:—-]?$/, ".");
  });
  return { lines, usd: r.usd, model: r.model, provider: r.provider };
}
