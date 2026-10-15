import type { Aspect } from "../schemas/index.ts";

/**
 * Is this instruction asking for a sports / action highlights edit (no speech-driven plan)?
 *   strong — names a sport or a game action (баскет, футбол, броски, трюки…): highlights mode
 *   weak   — only "лучшие моменты / нарезка / хайлайты": highlights when the video is mostly not speech
 */
const STRONG = [
  /баскет/i, /футбол/i, /волейбол/i, /хоккей/i, /теннис/i, /спорт/i, /трюк/i, /скейт/i, /паркур/i, /бокс/i, /единоборств/i,
  /брос(ок|ки|ков|ках|кам)/i, /данк/i, /\bгол(ы|ов|ам)?\b/i, /матч/i, /нарезк\w* игр/i, /как мы игра/i, /\bигр(а|ы|у|ой) в\b/i,
  /basketball/i, /football/i, /soccer/i, /\bsport/i, /\btricks?\b/i, /\bdunks?\b/i, /\bgoals?\b/i, /\bshots?\b.*\b(made|make)/i,
  /basketbol/i, /futbol/i, /sport/i,
];
const WEAK = [/хайлайт/i, /лучшие момент/i, /лучших момент/i, /нарез(ка|ку|ать)/i, /highlights?/i, /best moments/i, /eng yaxshi/i];

export type HighlightsIntent = "strong" | "weak" | null;

export function highlightsIntent(instruction: string | undefined): HighlightsIntent {
  if (!instruction) return null;
  if (STRONG.some((r) => r.test(instruction))) return "strong";
  if (WEAK.some((r) => r.test(instruction))) return "weak";
  return null;
}

/** Highlights mode? strong intent always; weak intent only when speech covers less than `maxSpeech` of the sampled audio. */
export function wantsHighlights(intent: HighlightsIntent, speechRatio: number | null, maxSpeech = 0.25): boolean {
  if (intent === "strong") return true;
  if (intent === "weak") return speechRatio !== null && speechRatio < maxSpeech;
  return false;
}

/** Sport name for the event detector prompt (English), from the instruction. */
export function sportOf(instruction: string | undefined): string {
  const s = instruction ?? "";
  if (/футбол|football|soccer|futbol/i.test(s)) return "football (soccer)";
  if (/волейбол|volleyball/i.test(s)) return "volleyball";
  if (/хоккей|hockey/i.test(s)) return "ice hockey";
  if (/теннис|tennis/i.test(s)) return "tennis";
  if (/скейт|skate/i.test(s)) return "skateboarding tricks";
  if (/трюк|паркур|trick|parkour/i.test(s)) return "action sports tricks";
  return "basketball";
}

export interface HighlightsBrief {
  /** target length, s */
  target?: number;
  aspect?: Aspect;
  title?: string;
}

/** Length / aspect / a quoted title from the instruction ("45 секунд", "минута", "16:9", «ВЕЧЕРНИЙ БАСКЕТ»). */
export function parseHighlightsBrief(instruction: string | undefined): HighlightsBrief {
  const s = instruction ?? "";
  const out: HighlightsBrief = {};
  const sec = /(\d{2,3})\s*(?:-|–)?\s*(?:сек|с\b|s\b|sec|soniya)/i.exec(s);
  const min = /(\d+(?:[.,]\d+)?)\s*(?:мин|min|daqiqa)/i.exec(s);
  if (sec) out.target = Number(sec[1]);
  else if (min) out.target = Math.round(Number(min[1].replace(",", ".")) * 60);
  else if (/минут(у|ка|ный)|one minute/i.test(s)) out.target = 60;
  if (out.target !== undefined) out.target = Math.min(180, Math.max(15, out.target));
  if (/16\s*:\s*9|горизонт|ютуб|youtube|landscape/i.test(s)) out.aspect = "16:9";
  else if (/1\s*:\s*1|квадрат|square/i.test(s)) out.aspect = "1:1";
  else if (/9\s*:\s*16|вертикал|reels|shorts|тикток|tiktok/i.test(s)) out.aspect = "9:16";
  const q = /[«"]([^»"]{2,28})[»"]/.exec(s);
  if (q) out.title = q[1].trim();
  return out;
}

/** "по отдельности", "на каждого игрока", "каждого человека", "отдельные ролики": one reel per person. */
export function perPersonIntent(instruction: string | undefined): boolean {
  return /по\s+отдельност|на\s+каждого|каждого\s+(игрока|человека|участника)|отдельн\w*\s+(ролик|нарезк|видео)|each\s+player|per\s+person|har\s+bir\s+o.yinchi/i.test(instruction ?? "");
}
