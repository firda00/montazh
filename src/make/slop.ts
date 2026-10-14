import type { Script } from "./script.ts";

/**
 * A cheap post-check of a written script for the phrases that make short videos read as AI slop:
 * "не X, а Y" / "дело не в…", "давайте разберёмся", "представьте", "в мире, где", em-dash punchlines,
 * generic CTAs ("напиши в комментариях", "подпишись", "твоя очередь"), English equivalents ("game changer",
 * "let's dive in", "in a world where"…), rhetorical triplets, a hook without a number or a name.
 * writeScript() sends what this finds back to the model for one rewrite.
 */

export interface SlopRule {
  id: string;
  /** what the model is told (English, short) */
  why: string;
  re: RegExp;
  /** a call to action: allowed when the user asked for one */
  cta?: boolean;
}

// Cyrillic has no \b in JS regexes: (?<![\p{L}]) / (?![\p{L}]) with the u flag instead
const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const r = (s: string) => new RegExp(s.replace(/\\b</g, B).replace(/\\b>/g, E), "iu");

export const SLOP_RULES: SlopRule[] = [
  { id: "not_x_but_y", why: 'the "not X, but Y" construction', re: r("\\b<не\\b>\\s+[^,.;:!?]{1,40},\\s*(а|но)\\b>\\s") },
  { id: "delo_ne_v", why: '"дело не в…" / "дело в том"', re: r("\\b<дело\\s+(не\\s+)?в(о)?\\s+(том|\\p{L}+)") },
  { id: "razberemsya", why: '"давайте разберёмся"', re: r("\\b<(давайте|давай)\\s+(разбер[её]мся|разберем|посмотрим|узнаем)|\\b<разбер[её]мся\\b>") },
  { id: "predstav", why: '"представьте" as an opener', re: r("\\b<представ(ь|ьте)\\b>") },
  { id: "znaete_li", why: '"знаете ли вы" / "а вы знали"', re: r("\\b<(знаете|знаешь|знали|знал)\\s+ли\\b>|\\b<а\\s+вы\\s+знали\\b>|\\b<а\\s+ты\\s+знал") },
  { id: "v_mire_gde", why: '"в мире, где"', re: r("\\b<в\\s+мире,?\\s+где\\b>") },
  { id: "ne_prosto", why: '"это не просто…"', re: r("\\b<(это|был[аио]?|стал[аио]?)\\s+не\\s+просто\\b>") },
  { id: "sekret", why: '"секрет в том"', re: r("\\b<секрет\\s+(в\\s+том|прост)") },
  { id: "vot_pochemu", why: '"и вот почему" / "вот почему"', re: r("\\b<(и\\s+)?вот\\s+почему\\b>") },
  { id: "no_eto_ne_vse", why: '"но это ещё не всё"', re: r("\\b<(но\\s+)?это\\s+(ещ[её]\\s+)?не\\s+вс[её]\\b>") },
  { id: "dash_punchline", why: "an em-dash punchline (\"… — и …\", \"… — а …\")", re: r("\\s[—–-]\\s+(и|а|но|это|вот|зато|ведь|and|but|that's|it's)\\b>") },
  { id: "comments_cta", why: '"напиши в комментариях" (generic CTA)', re: r("\\b<(напиши|пиши|напишите|пишите|делись|поделись|поделитесь)\\b>[^.!?]{0,30}\\b<(в\\s+)?коммент|\\b<в\\s+комментари(ях|и)\\b>"), cta: true },
  { id: "subscribe_cta", why: '"подпишись" / "ставь лайк" / "сохрани" (generic CTA)', re: r("\\b<(подпиш(ись|итесь)|подписывайся|ставь(те)?\\s+лайк|лайкни|сохрани(те)?(\\s+(это|себе|видео|ролик))?)\\b>"), cta: true },
  { id: "tvoya_ochered", why: '"твоя очередь"', re: r("\\b<(тво[яй]|ваш[аи]?)\\s+очередь\\b>"), cta: true },
  { id: "game_changer", why: '"game changer"', re: r("\\b<game[\\s-]?changer\\b>|\\b<меня(ет|ющ\\p{L}*)\\s+правила\\s+игры\\b>") },
  { id: "dive_in", why: '"let\'s dive in" / "delve"', re: r("\\b<(let'?s\\s+dive|dive\\s+in(to)?|delve)\\b>|\\b<(погрузимся|нырн[её]м)\\b>") },
  { id: "in_a_world", why: '"in a world where"', re: r("\\b<in\\s+a\\s+world\\s+where\\b>") },
  { id: "not_just", why: '"it\'s not just…" / "not X, but Y"', re: r("\\b<(it'?s|this\\s+is)\\s+not\\s+just\\b>|\\b<not\\s+(just\\s+)?[^,.;]{1,40},\\s*but\\b>") },
  { id: "heres_why", why: '"here\'s why" / "the secret is"', re: r("\\b<(here'?s|and\\s+that'?s)\\s+why\\b>|\\b<the\\s+secret\\s+is\\b>") },
  { id: "did_you_know", why: '"did you know" / "imagine"', re: r("\\b<(did\\s+you\\s+know|imagine)\\b>") },
  { id: "en_cta", why: '"comment below" / "subscribe" / "your turn"', re: r("\\b<(comment\\s+below|let\\s+me\\s+know\\s+in\\s+the\\s+comments|subscribe|follow\\s+for\\s+more|smash\\s+(that|the)\\s+like|your\\s+turn)\\b>"), cta: true },
  { id: "buzz", why: "AI buzzwords (unlock, unleash, buckle up, revolutionary)", re: r("\\b<(unlock|unleash|buckle\\s+up|revolutionary|революционн\\p{L}*|невероятн\\p{L}*)\\b>") },
];

/** Three one- or two-word sentences in a row ("Быстро. Дёшево. Удобно.") */
const TRIPLET = /(?:^|[.!?…]\s+)((?:\p{L}+(?:\s\p{L}+)?[.!]\s+){2}\p{L}+(?:\s\p{L}+)?[.!])/u;

export interface SlopFinding {
  /** beat index, or -1 for the title */
  beat: number;
  field: "text" | "voiceover" | "title";
  rule: string;
  why: string;
  match: string;
}

/** Did the user ask for a call to action? ("призыв", "подписаться", "CTA", "комментарии"…) */
export function wantsCta(instruction: string): boolean {
  return /призыв|подпис|cta|call to action|коммент|лайк|subscribe|comment/i.test(instruction);
}

export function findCliches(script: Script, o: { allowCta?: boolean } = {}): SlopFinding[] {
  const out: SlopFinding[] = [];
  const check = (beat: number, field: SlopFinding["field"], text: string) => {
    if (!text) return;
    for (const rule of SLOP_RULES) {
      if (rule.cta && o.allowCta) continue;
      const m = rule.re.exec(text);
      if (m) out.push({ beat, field, rule: rule.id, why: rule.why, match: m[0].trim() });
    }
    const t = TRIPLET.exec(text);
    if (t) out.push({ beat, field, rule: "triplet", why: "a rhetorical triplet of fragments", match: t[1].trim() });
  };
  check(-1, "title", script.title);
  script.beats.forEach((b, i) => {
    check(i, "text", b.text);
    check(i, "voiceover", b.voiceover ?? "");
  });
  // the hook must carry something concrete: a number or a proper name (a capitalised word after the first)
  const hook = script.beats[0];
  if (hook) {
    // a capitalised word that does not start a sentence is a name (ICE, Колумбия, Starbucks)
    const named = [hook.text, hook.voiceover ?? ""].some((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      return words.some((w, k) => k > 0 && !/[.!?…:]$/.test(words[k - 1]) && /^[«"(]?[\p{Lu}][\p{L}-]{1,}/u.test(w));
    });
    if (!/\d/.test(`${hook.text} ${hook.voiceover ?? ""}`) && !named) out.push({ beat: 0, field: "text", rule: "vague_hook", why: "the hook has no number and no named thing", match: hook.text });
  }
  return out;
}

/** One line per finding, for the rewrite request and for warnings. */
export const describeFindings = (f: SlopFinding[]) => f.map((x) => `${x.beat < 0 ? "title" : `beat ${x.beat} ${x.field}`}: ${x.why} — «${x.match}»`).join("\n");
