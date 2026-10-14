/**
 * Output aspect from words: "для ютуба" / "горизонтально" / "16:9" → 16:9, "рилс" / "shorts" / "вертикально" /
 * "9:16" → 9:16, "квадрат" / "1:1" → 1:1. YouTube Shorts are vertical, so the Shorts family wins over "YouTube":
 * "для ютуб шортс" stays 9:16. Used by `vedit make --aspect auto`, the bot's /make and the mock planner.
 */

export const ASPECTS = ["9:16", "16:9", "1:1"] as const;
export type Aspect = (typeof ASPECTS)[number];

export function isAspect(s: string): s is Aspect {
  return (ASPECTS as readonly string[]).includes(s);
}

const RATIO = /(?<![\d:])(9\s*[:x×]\s*16|16\s*[:x×]\s*9|1\s*[:x×]\s*1)(?![\d:])/;
const VERTICAL = /(?<![a-z])(shorts?|reels?|tiktok|tik-tok|stories|vertical video|vertical format)(?![a-z])|шортс|шорты|шортах|рилс|рилз|reels|тикток|тик-ток|сторис|вертикал/;
const HORIZONTAL = /(?<![a-z])(youtube|widescreen|horizontal video|horizontal format|landscape video)(?![a-z])|ютуб|ютьюб|youtube|горизонтал|широкоформат|широкий экран/;
const SQUARE = /(?<![a-z])square(?![a-z])|квадрат/;

/** The aspect a text asks for, or null when it does not say. */
export function detectAspect(text: string): Aspect | null {
  const s = text.toLowerCase().replace(/ё/g, "е");
  const r = RATIO.exec(s);
  if (r) {
    const [a, b] = r[1].split(/\s*[:x×]\s*/).map(Number);
    return a === b ? "1:1" : a > b ? "16:9" : "9:16";
  }
  if (VERTICAL.test(s)) return "9:16";
  if (HORIZONTAL.test(s)) return "16:9";
  if (SQUARE.test(s)) return "1:1";
  return null;
}

/** Drops format words from a topic ("… для ютуба", "16:9 …") so the writer does not put them in the script. */
export function stripAspectWords(text: string): string {
  return text
    .replace(/(^|\s)(9\s*:\s*16|16\s*:\s*9|1\s*:\s*1)(?=\s|$)/g, " ")
    .replace(/\s(для|под|в|на|for)\s+(ютуб\S*|youtube\S*|шортс\S*|рилс\S*|reels\S*|shorts\S*|тикток\S*|tiktok\S*)(\s+(шортс\S*|shorts\S*))?/gi, " ")
    .replace(/[,;]?\s*(горизонтальн|вертикальн|широкоформатн)\S*(\s+(ролик|видео|формат)\S*)?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Frame {
  aspect: Aspect;
  w: number;
  h: number;
  /** text keeps inside x..w-x and top..bottom (platform UI: Reels/Shorts buttons at the bottom, player bar on YouTube) */
  safe: { x: number; top: number; bottom: number };
}

export const FRAMES: Record<Aspect, Frame> = {
  "9:16": { aspect: "9:16", w: 1080, h: 1920, safe: { x: 72, top: 150, bottom: 1590 } },
  "16:9": { aspect: "16:9", w: 1920, h: 1080, safe: { x: 112, top: 84, bottom: 990 } },
  "1:1": { aspect: "1:1", w: 1080, h: 1080, safe: { x: 72, top: 72, bottom: 1000 } },
};

export const frameFor = (a: Aspect = "9:16"): Frame => FRAMES[a];
