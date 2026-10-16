// Keyboards: the main menu and the option cards, all inline buttons under the bot's message. callback_data is a compact "<prefix>:<args>" string (≤ 64 bytes, Bot API limit);
// anything longer goes through the short id map in the DB (`~<id>`, see BotDb.putCallback).
import type { InlineButton, InlineKeyboard } from "./telegram-api.ts";
import { voiceLabel, type Strings } from "./i18n.ts";
import type { Lang } from "./db.ts";
import { isCloud, isLocal, VOICES } from "../voice/catalog.ts";
import { FREE_PLAN_FIELDS, type PlanLimits } from "./plans.ts";

export const CALLBACK_LIMIT = 64;
export const byteLength = (s: string) => Buffer.byteLength(s, "utf8");

const btn = (text: string, data: string): InlineButton => ({ text, callback_data: data });
const mark = (on: boolean, text: string) => (on ? `✓ ${text}` : text);

export type MontageMode = "reels" | "viral" | "hl" | "pp";
export interface MontageDraft {
  mode: MontageMode;
  count: number;
  seconds: number;
  aspect: string;
  /** pop | split | calm | ref (the reference style of «🎯 Монтаж как в примере») */
  style: string;
}
export interface MakeDraft {
  topic: string;
  aspect: string;
  /** a catalogue id, "auto" or "off" */
  voice: string;
}

export const COUNTS = [1, 3, 5];
export const SECONDS = [30, 60, 90];
export const STYLE_CODES = ["pop", "split", "calm"] as const;
export const STYLE_PRESET: Record<string, string> = { pop: "bold_pop", split: "split_news", calm: "calm" };
export const PRESET_STYLE: Record<string, string> = { bold_pop: "pop", split_news: "split", calm: "calm" };
/** voices offered on the make card (cloud voices first; avatar-only Chatterbox voices are not offered) */
export const MAKE_VOICES = ["gemini_charon", "gemini_kore", "gemini_puck", "gemini_aoede", "dmitri", "denis"];

/** the main menu as inline buttons under the message ("H:<action>"); the old reply keyboard is removed once per user */
export function mainMenu(L: Strings): InlineKeyboard {
  const m = L.menu;
  return {
    inline_keyboard: [
      [btn(m.montage, "H:montage")],
      [btn(m.ref, "H:ref")],
      [btn(m.make, "H:make"), btn(m.highlights, "H:highlights")],
      [btn(m.avatar, "H:avatar"), btn(m.settings, "H:settings")],
      [btn(m.balance, "H:balance"), btn(m.help, "H:help")],
    ],
  };
}

export const langKb = (): InlineKeyboard => ({ inline_keyboard: [[btn("🇷🇺 Русский", "L:ru"), btn("🇺🇿 O‘zbekcha", "L:uz"), btn("🇬🇧 English", "L:en")]] });

export const purposeKb = (L: Strings): InlineKeyboard => ({
  inline_keyboard: [
    [btn(L.purpose.blog, "P:blog"), btn(L.purpose.biz, "P:biz")],
    [btn(L.purpose.sport, "P:sport"), btn(L.purpose.other, "P:other")],
  ],
});

export const termsKb = (L: Strings): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnTerms, "T:terms"), btn(L.btnPrivacy, "T:privacy")], [btn(L.btnAccept, "T:ok")]] });

export function montageKb(L: Strings, d: MontageDraft, hasRef = false): InlineKeyboard {
  const rows: InlineButton[][] = [
    [btn(mark(d.mode === "reels", L.mode.reels), "M:m:reels"), btn(mark(d.mode === "viral", L.mode.viral), "M:m:viral")],
    [btn(mark(d.mode === "hl", L.mode.hl), "M:m:hl"), btn(mark(d.mode === "pp", L.mode.pp), "M:m:pp")],
  ];
  if (d.mode === "reels") rows.push(COUNTS.map((n) => btn(mark(d.count === n, L.countLabel(n)), `M:n:${n}`)));
  if (d.mode !== "pp") rows.push(SECONDS.map((n) => btn(mark(d.seconds === n, L.secondsLabel(n)), `M:s:${n}`)));
  rows.push(["9:16", "16:9"].map((a) => btn(mark(d.aspect === a, a), `M:a:${a}`)));
  if (d.mode === "reels" || d.mode === "viral") {
    // with a reference the style buttons give way to one toggle «🎯 как в примере ✓» (off → the house styles again)
    if (hasRef && d.style === "ref") rows.push([btn(mark(true, L.styleRef), "M:y:ref")]);
    else rows.push([...STYLE_CODES.map((s) => btn(mark(d.style === s, L.styleNames[STYLE_PRESET[s]]), `M:y:${s}`)), ...(hasRef ? [btn(L.styleRef, "M:y:ref")] : [])]);
  }
  rows.push([btn(L.btnStart, "M:go")]);
  return { inline_keyboard: rows };
}

export function makeKb(L: Strings, lang: Lang, d: MakeDraft): InlineKeyboard {
  const rows: InlineButton[][] = [["9:16", "16:9", "1:1"].map((a) => btn(mark(d.aspect === a, a), `K:a:${a}`))];
  rows.push([btn(mark(d.voice === "auto", L.voiceAuto), "K:v:auto"), btn(mark(d.voice === "off", L.voiceNone), "K:v:off")]);
  for (const id of MAKE_VOICES) {
    const v = VOICES.find((x) => x.id === id);
    if (!v) continue;
    rows.push([btn(mark(d.voice === id, voiceLabel(v, lang)), `K:v:${id}`), btn("▶️", `K:p:${id}`)]);
  }
  rows.push([btn(L.btnStart, "K:go")]);
  return { inline_keyboard: rows };
}

export function settingsKb(L: Strings, s: { aspect: string; style: string; send: string; lang: Lang; news: boolean }): InlineKeyboard {
  return {
    inline_keyboard: [
      ["9:16", "16:9", "1:1"].map((a) => btn(mark(s.aspect === a, a), `S:a:${a}`)),
      STYLE_CODES.map((c) => btn(mark(PRESET_STYLE[s.style] === c, L.styleNames[STYLE_PRESET[c]]), `S:y:${c}`)),
      (["file", "video", "both"] as const).map((m) => btn(mark(s.send === m, L.sendNames[m]), `S:s:${m}`)),
      [btn(L.btnVoice, "S:v")],
      (["ru", "uz", "en"] as const).map((l) => btn(mark(s.lang === l, l.toUpperCase()), `S:l:${l}`)),
      [btn(s.news ? L.newsOn : L.newsOff, "S:n")],
    ],
  };
}

export function voicesKb(L: Strings, lang: Lang, current: string | undefined): InlineKeyboard {
  const cur = current ?? "auto";
  const rows: InlineButton[][] = [[btn(mark(cur === "auto", L.voiceAuto), "V:auto"), btn(mark(cur === "off", L.voiceNone), "V:off")]];
  for (const v of VOICES) {
    const row = [btn(mark(cur === v.id, voiceLabel(v, lang)), `V:${v.id}`)];
    if (isLocal(v) || isCloud(v)) row.push(btn("▶️", `VP:${v.id}`));
    rows.push(row);
  }
  rows.push([btn(L.btnBack, "S:back")]);
  return { inline_keyboard: rows };
}

export const cancelKb = (L: Strings, jobId: string): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnCancel, `X:${jobId}`)]] });
export const retryKb = (L: Strings, jobId: string): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnRetry, `R:${jobId}`)]] });

export function resultKb(L: Strings, jobId: string, rating?: number | null): InlineKeyboard {
  return {
    inline_keyboard: [
      [btn(L.btnAgain, `A:${jobId}`), btn(L.btnEdit, `E:${jobId}`)],
      [btn(L.btnFormat, `F:${jobId}`)],
      rating ? [btn("⭐".repeat(rating), "noop")] : [1, 2, 3, 4, 5].map((n) => btn(`${n}⭐`, `r:${jobId}:${n}`)),
    ],
  };
}

export const adminKb = (L: Strings): InlineKeyboard => ({
  inline_keyboard: [
    [btn(L.btnStats, "a:st"), btn(L.btnFind, "a:f")],
    [btn(L.btnBroadcast, "a:b"), btn(L.btnLimits, "a:l")],
  ],
});

export function userCardKb(L: Strings, u: { tg_id: number; status: string; role: string }): InlineKeyboard {
  return {
    inline_keyboard: [
      [1, 5, 20].map((n) => btn(L.btnCredits(n), `a:c:${u.tg_id}:${n}`)),
      [btn(u.status === "banned" ? L.btnUnban : L.btnBan, `a:ban:${u.tg_id}`), btn(u.role === "admin" ? L.btnRemoveAdmin : L.btnMakeAdmin, `a:adm:${u.tg_id}`)],
    ],
  };
}

export const broadcastKb = (L: Strings): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnSend, "a:bs"), btn(L.btnCancelPlain, "a:bx")]] });

/** step of a free-plan field on the admin card */
export const limitStep = (key: keyof PlanLimits) => (key === "uploadMb" || key === "longMinutes" ? 5 : 1);

export function limitsKb(): InlineKeyboard {
  return {
    inline_keyboard: FREE_PLAN_FIELDS.map((f, i) => [btn(`${i + 1}: −${limitStep(f.key)}`, `a:lv:${i}:-`), btn(`${i + 1}: +${limitStep(f.key)}`, `a:lv:${i}:+`)]),
  };
}
