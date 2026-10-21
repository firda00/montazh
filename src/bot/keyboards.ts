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
  /** stage 30: «🌐 Озвучить на русском» — the reels are dubbed into this language after the montage */
  dub?: string;
}
/** stage 30: the «🌐 Русская версия» card */
export interface DubDraft {
  lang: string;
  /** a catalogue id or "auto" */
  voice: string;
  mode: "voiceover" | "replace";
}
/** the dub card's language buttons: each language by its own name */
export const DUB_LANG_NAMES: Record<string, string> = { ru: "Русский", uz: "O‘zbekcha", en: "English" };
export const DUB_VOICES = ["gemini_charon", "gemini_kore", "gemini_puck", "gemini_aoede"];
export interface MakeDraft {
  topic: string;
  aspect: string;
  /** a catalogue id, "auto" or "off" */
  voice: string;
  /** stage 31: "promo" — the clean-UI promo / explainer (no voice by default) */
  format?: "reel" | "promo";
}

export const COUNTS = [1, 3, 5];
export const SECONDS = [30, 60, 90];
export const STYLE_CODES = ["pop", "clean", "box", "split", "calm"] as const;
export const STYLE_PRESET: Record<string, string> = { pop: "bold_pop", clean: "clean_min", box: "box_reveal", split: "split_news", calm: "calm" };
export const PRESET_STYLE: Record<string, string> = { bold_pop: "pop", clean_min: "clean", box_reveal: "box", split_news: "split", calm: "calm" };
/** stage 27: the caption styles in rows of two (long names: «Чистые (как у экспертов)») */
const styleRows = <T>(xs: T[]): T[][] => xs.reduce<T[][]>((rows, x, i) => (i % 2 ? rows[rows.length - 1].push(x) : rows.push([x]), rows), []);
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
      // stage 32: ideas on a schedule → video → publish
      [btn(m.plan, "H:plan")],
      [btn(m.avatar, "H:avatar"), btn(m.settings, "H:settings")],
      [btn(m.balance, "H:balance"), btn(m.help, "H:help")],
      [btn(m.guide, "H:guide")],
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

export function montageKb(L: Strings, d: MontageDraft, hasRef = false, o: { link?: boolean } = {}): InlineKeyboard {
  // stage 30: a video from a platform link — what people do with someone else's video comes first
  const top: InlineButton[][] = o.link ? [[btn(L.s30.btnLinkCut, "LK:cut")], [btn(L.s30.btnLinkRef, "LK:ref")], [btn(L.s30.btnDubOpen, "D:open"), btn(L.s30.btnLinkAvatar, "LK:av")]] : [];
  const rows: InlineButton[][] = [
    ...top,
    [btn(mark(d.mode === "reels", L.mode.reels), "M:m:reels"), btn(mark(d.mode === "viral", L.mode.viral), "M:m:viral")],
    [btn(mark(d.mode === "hl", L.mode.hl), "M:m:hl"), btn(mark(d.mode === "pp", L.mode.pp), "M:m:pp")],
  ];
  if (d.mode === "reels") rows.push(COUNTS.map((n) => btn(mark(d.count === n, L.countLabel(n)), `M:n:${n}`)));
  if (d.mode !== "pp") rows.push(SECONDS.map((n) => btn(mark(d.seconds === n, L.secondsLabel(n)), `M:s:${n}`)));
  rows.push(["9:16", "16:9"].map((a) => btn(mark(d.aspect === a, a), `M:a:${a}`)));
  if (d.mode === "reels" || d.mode === "viral") {
    // with a reference the style buttons give way to one toggle «🎯 как в примере ✓» (off → the house styles again)
    if (hasRef && d.style === "ref") rows.push([btn(mark(true, L.styleRef), "M:y:ref")]);
    else rows.push(...styleRows([...STYLE_CODES.map((s) => btn(mark(d.style === s, L.styleNames[STYLE_PRESET[s]]), `M:y:${s}`)), ...(hasRef ? [btn(L.styleRef, "M:y:ref")] : [])]));
  }
  if (d.mode === "reels" || d.mode === "viral") rows.push([btn(mark(!!d.dub, L.s30.btnDubToggle), "M:d")]);
  if (!o.link) rows.push([btn(L.s30.btnDubOpen, "D:open")]);
  rows.push([btn(L.btnStart, "M:go")]);
  return { inline_keyboard: rows };
}

/** «🌐 Русская версия»: target language, voice (▶️ — a sample), voice-over or replace, start */
export function dubKb(L: Strings, lang: Lang, d: DubDraft): InlineKeyboard {
  const rows: InlineButton[][] = [(["ru", "uz", "en"] as const).map((l) => btn(mark(d.lang === l, DUB_LANG_NAMES[l]), `DB:l:${l}`))];
  rows.push([btn(mark(d.voice === "auto", L.voiceAuto), "DB:v:auto")]);
  for (const id of DUB_VOICES) {
    const v = VOICES.find((x) => x.id === id);
    if (v) rows.push([btn(mark(d.voice === id, voiceLabel(v, lang)), `DB:v:${id}`), btn("▶️", `VP:${id}`)]);
  }
  rows.push([btn(mark(d.mode === "voiceover", L.s30.modeVoiceover), "DB:m:voiceover"), btn(mark(d.mode === "replace", L.s30.modeReplace), "DB:m:replace")]);
  rows.push([btn(L.btnStart, "DB:go")]);
  return { inline_keyboard: rows };
}

/** a third-party link: the rights confirmation */
export const rightsKb = (L: Strings): InlineKeyboard => ({ inline_keyboard: [[btn(L.s30.btnConfirm, "RC:ok"), btn(L.s30.btnCancel, "RC:no")]] });

/** the admin's notice of a tester let in by a free slot */
export const testerKb = (L: Strings, id: number): InlineKeyboard => ({ inline_keyboard: [[btn(L.s30.btnRevoke, `a:rv:${id}`)]] });

export function makeKb(L: Strings, lang: Lang, d: MakeDraft): InlineKeyboard {
  const rows: InlineButton[][] = [["9:16", "16:9", "1:1"].map((a) => btn(mark(d.aspect === a, a), `K:a:${a}`))];
  rows.push([btn(mark(d.voice === "auto", L.voiceAuto), "K:v:auto"), btn(mark(d.voice === "off", L.voiceNone), "K:v:off")]);
  for (const id of MAKE_VOICES) {
    const v = VOICES.find((x) => x.id === id);
    if (!v) continue;
    rows.push([btn(mark(d.voice === id, voiceLabel(v, lang)), `K:v:${id}`), btn("▶️", `K:p:${id}`)]);
  }
  // stage 31: the promo / explainer format (clean UI, no voice by default)
  rows.push([btn(mark(d.format === "promo", L.s31.promo), "K:f:promo")]);
  rows.push([btn(L.btnStart, "K:go")]);
  return { inline_keyboard: rows };
}

export function settingsKb(L: Strings, s: { aspect: string; style: string; send: string; lang: Lang; news: boolean }): InlineKeyboard {
  return {
    inline_keyboard: [
      ["9:16", "16:9", "1:1"].map((a) => btn(mark(s.aspect === a, a), `S:a:${a}`)),
      ...styleRows(STYLE_CODES.map((c) => btn(mark(PRESET_STYLE[s.style] === c, L.styleNames[STYLE_PRESET[c]]), `S:y:${c}`))),
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
      // stage 28: a rated result can be re-rated (the stars row comes back, the reasons are kept)
      rating ? [btn(L.fb.rated(rating), `fb:${jobId}:re`)] : [1, 2, 3, 4, 5].map((n) => btn(`${n}⭐`, `r:${jobId}:${n}`)),
    ],
  };
}

export const adminKb = (L: Strings): InlineKeyboard => ({
  inline_keyboard: [
    [btn(L.btnStats, "a:st"), btn(L.btnFind, "a:f")],
    [btn(L.btnBroadcast, "a:b"), btn(L.btnLimits, "a:l")],
    [btn(L.btnFeedback, "a:fb:30:n")],
  ],
});

/** «📊 Оценки»: the window (7 d / 30 d / all) and the two lists of that window */
export function feedbackAdminKb(L: Strings, days: number): InlineKeyboard {
  const mark2 = (on: boolean, text: string) => (on ? `✓ ${text}` : text);
  return {
    inline_keyboard: [
      [7, 30, 0].map((d) => btn(mark2(d === days, L.fbAdmin.period(d)), `a:fb:${d}`)),
      [btn(L.fbAdmin.btnLow, `a:fl:${days}`), btn(L.fbAdmin.btnDisagree, `a:fd:${days}`)],
    ],
  };
}

/** one button per listed job: opens its feedback + self-review card */
export const feedbackJobsKb = (jobs: string[]): InlineKeyboard => ({ inline_keyboard: [...new Set(jobs)].slice(0, 10).map((j) => [btn(`🔎 ${j}`, `a:fo:${j}`)]) });

export const feedbackJobKb = (L: Strings, jobId: string): InlineKeyboard => ({ inline_keyboard: [[btn(L.fbAdmin.btnVideo, `a:fv:${jobId}`)]] });

export function userCardKb(L: Strings, u: { tg_id: number; status: string; role: string; plan?: string }): InlineKeyboard {
  return {
    inline_keyboard: [
      [...[1, 5, 20].map((n) => btn(L.btnCredits(n), `a:c:${u.tg_id}:${n}`)), btn(u.plan === "vip" ? L.btnVipOn : L.btnVipOff, `a:vip:${u.tg_id}`)],
      [btn(u.status === "banned" ? L.btnUnban : L.btnBan, `a:ban:${u.tg_id}`), btn(u.role === "admin" ? L.btnRemoveAdmin : L.btnMakeAdmin, `a:adm:${u.tg_id}`)],
    ],
  };
}

/** a stranger knocked on the closed beta: one tap lets them in as a VIP tester */
export const strangerKb = (L: Strings, id: number): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnLetIn, `a:let:${id}`), btn(L.btnIgnore, `a:ign:${id}`)]] });

export const broadcastKb = (L: Strings): InlineKeyboard => ({ inline_keyboard: [[btn(L.btnSend, "a:bs"), btn(L.btnCancelPlain, "a:bx")]] });

/** step of a free-plan field on the admin card */
export const limitStep = (key: keyof PlanLimits) => (key === "uploadMb" || key === "longMinutes" ? 5 : 1);

export function limitsKb(): InlineKeyboard {
  return {
    inline_keyboard: FREE_PLAN_FIELDS.map((f, i) => [btn(`${i + 1}: −${limitStep(f.key)}`, `a:lv:${i}:-`), btn(`${i + 1}: +${limitStep(f.key)}`, `a:lv:${i}:+`)]),
  };
}
