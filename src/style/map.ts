import type { DesignSpec, Preset } from "../schemas/index.ts";
import type { StyleDNA } from "./dna.ts";

/**
 * Style DNA → vedit's own variables (stage 22). Pure and deterministic: the same DNA always gives the same
 * preset patch, planner block, cut/audio parameters, so a job stores only the DNA (style.json) and every
 * stage re-derives what it needs.
 *
 *   (a) design patch      → DesignSpec (captions, font, colours, overlays) of the HyperFrames overlay
 *   (b) planner rules     → a Russian block appended to the planner task (+ pace / clip length of the pack preset)
 *   (c) render / audio    → jump-cut cleanup, music bed + ducking (src/audio/mix.ts), sfx cues, ffmpeg eq grade
 *   (d) camera motion     → clip zoom punch-ins in the cut (the same `zoom` field the highlights use)
 */

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };
export type DesignPatch = DeepPartial<DesignSpec>;

export interface ZoomPlan {
  /** which clips punch in */
  frequency: StyleDNA["hyperframes_theme"]["camera_motion"]["zoom_frequency"];
  /** instant: the whole clip sits at `scale`; ease: 1 → scale over `ease` s; ken_burns: over the whole clip */
  mode: "none" | "instant" | "ease" | "ken_burns";
  scale: number;
  ease: number;
  onHook: boolean;
}

export interface Grade {
  contrast: number;
  saturation: number;
  brightness: number;
  /** extra colour balance of the preset (warm / teal-orange …), an ffmpeg filter or "" */
  tint: string;
}

export interface SfxPlan {
  enabled: boolean;
  /** whoosh on punch-ins / every few cuts */
  kind: "whoosh" | "swipe";
  gain: number;
  /** a cut every this many clips also gets an effect (0 = only punch-ins) */
  everyCuts: number;
  /** impact on the very first frame (heavy cinematic) */
  hookImpact: boolean;
}

export interface StyleMapping {
  /** the house preset the reference is closest to (split screen → split_news) */
  basePreset: "bold_pop" | "split_news";
  pace: Preset["pace"];
  clipSeconds: { min: number; max: number };
  captionsEnabled: boolean;
  titleFirst3s: boolean;
  design: DesignPatch;
  plannerRules: string;
  /** maxPiece: fast references cut inside sentences too (pieces longer than this are split at a word gap) */
  cleanup: { enabled: boolean; silenceMs: number; removeFillers: boolean; handleMs: number; maxPiece?: number };
  zoom: ZoomPlan;
  grade: Grade | null;
  audio: { music: boolean; duckDb: number | null; sfx: SfxPlan };
  /** stage 27: the house caption look the reference matches (expert clean captions / karaoke box), or null */
  captionLook: "clean_min" | "box_reveal" | null;
  /** what could not be reproduced (shown in `vedit style` and the README) */
  unsupported: string[];
  /** DNA field → our variable → value, for reports and the README table */
  table: { field: string; target: string; value: string }[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const FONT_WEIGHT: Record<StyleDNA["hyperframes_theme"]["captions"]["font_weight"], number> = { "400_regular": 400, "700_bold": 700, "900_black": 900 };

/** caption size and line rhythm per layout preset (px on a 1080-wide frame) */
const LAYOUT: Record<StyleDNA["hyperframes_theme"]["captions"]["layout_preset"], { font_size: number; line_height: number; maxWords?: number }> = {
  single_word_impact: { font_size: 104, line_height: 1.05, maxWords: 1 },
  two_words_pop: { font_size: 86, line_height: 1.1 },
  karaoke_two_lines: { font_size: 64, line_height: 1.18 },
  minimal_clean_box: { font_size: 58, line_height: 1.2 },
  none: { font_size: 68, line_height: 1.15 },
};

/** colour-balance tint of each grade preset (applied after eq) */
const TINT: Record<StyleDNA["audio_and_color"]["color_grade"]["preset"], string> = {
  neutral_natural: "",
  high_contrast_warm: "colorbalance=rs=0.04:gs=0.01:bs=-0.04:rm=0.03:bm=-0.03",
  cinematic_moody: "colorbalance=rs=-0.03:bs=0.04:rh=0.04:bh=-0.03",
  bright_airy: "colorbalance=rh=0.01:bh=0.02",
  desaturated_clean: "",
};

const PACE_RU: Record<StyleDNA["planner_rules"]["pacing_profile"], string> = { calm: "спокойный", moderate: "умеренный", fast: "быстрый", aggressive: "очень быстрый (агрессивный)" };
const ZOOM_RU: Record<ZoomPlan["frequency"], string> = {
  none: "наездов нет — не отмечай punch_in",
  rare_emphasis: "редкие наезды: отметь punch_in: true только на 1–3 клипах с самой сильной мыслью, числом или эмоцией",
  every_2_3_sentences: "наезд примерно на каждой 2–3-й фразе: отметь punch_in: true на клипах с акцентом (главная мысль, число, эмоция)",
  every_cut_aggressive: "наезд почти на каждой склейке (это сделает монтаж сам, чередуя крупность); punch_in отмечать не нужно",
};

/**
 * stage 27: which expert look a reference's captions are — "clean_min" (reel #14: small, not caps, no box, no stroke, no
 * word highlight, chest height) or "box_reveal" (reel #15: a dark box per line, the spoken words light up without a pop).
 */
export function matchCaptionLook(C: StyleDNA["hyperframes_theme"]["captions"], enabled = true): "clean_min" | "box_reveal" | null {
  if (!enabled || C.uppercase) return null;
  const highlight = C.active_word_color.toUpperCase() !== C.primary_text_color.toUpperCase();
  if (C.background_box !== "none" && (C.word_animation === "color_switch_only" || (highlight && C.active_word_scale <= 1.03))) return "box_reveal";
  if (C.background_box === "none" && C.stroke_width_px <= 2 && C.font_weight !== "900_black" && C.position_y_percent >= 68 && !highlight && (C.word_animation === "none" || C.word_animation === "fade_up")) return "clean_min";
  return null;
}

export function mapStyle(dna: StyleDNA): StyleMapping {
  const P = dna.planner_rules;
  const C = dna.hyperframes_theme.captions;
  const M = dna.hyperframes_theme.camera_motion;
  const O = dna.hyperframes_theme.overlays;
  const A = dna.audio_and_color;
  const G = A.color_grade;
  const unsupported: string[] = [];
  const table: StyleMapping["table"] = [];
  const row = (field: string, target: string, value: unknown) => table.push({ field, target, value: typeof value === "string" ? value : JSON.stringify(value) });

  // ── (a) captions → DesignSpec ──
  const captionsEnabled = C.enabled && C.layout_preset !== "none";
  const lay = LAYOUT[C.layout_preset];
  const maxWords = lay.maxWords ?? C.max_words_per_screen;
  const active = C.active_word_color;
  const highlightDiffers = active.toUpperCase() !== C.primary_text_color.toUpperCase();
  let wordAnimation: DesignSpec["captions"]["word_animation"];
  let pageAnimation: DesignSpec["captions"]["page_animation"];
  let popScale = r2(C.active_word_scale);
  switch (C.word_animation) {
    case "spring_scale":
      wordAnimation = C.active_word_scale > 1.02 ? "pop" : "fill";
      pageAnimation = "none";
      break;
    case "color_switch_only":
      wordAnimation = "fill";
      pageAnimation = "none";
      popScale = 1;
      break;
    case "fade_up":
      wordAnimation = highlightDiffers ? "fill" : "none";
      pageAnimation = "fade_up";
      break;
    case "slide_in":
      // no horizontal slide in the overlay: the closest entrance is the page rising in
      wordAnimation = highlightDiffers ? "fill" : "none";
      pageAnimation = "fade_up";
      unsupported.push("word_animation slide_in → page fade_up (горизонтального въезда нет)");
      break;
    case "none":
      wordAnimation = "none";
      pageAnimation = "none";
      break;
  }
  const backing: { enabled: boolean; color?: string; padding?: number; radius?: number } =
    C.background_box === "none"
      ? { enabled: false }
      : C.background_box === "rounded_pill"
        ? { enabled: true, color: "rgba(0,0,0,0.55)", padding: 12, radius: 60 }
        : { enabled: true, color: "rgba(0,0,0,0.62)", padding: 16, radius: 0 };
  if (C.background_box === "full_strip") unsupported.push("background_box full_strip → прямоугольная подложка по ширине строки (не на всю ширину кадра)");
  const design: DesignPatch = {
    font: { weight: FONT_WEIGHT[C.font_weight] },
    colors: { text: C.primary_text_color, highlight: active, stroke: C.stroke_color },
    captions: {
      anchor_y: r2(C.position_y_percent / 100),
      max_words: maxWords,
      max_chars: C.max_chars_per_line,
      font_size: lay.font_size,
      line_height: lay.line_height,
      uppercase: C.uppercase,
      stroke_width: r2(C.stroke_width_px),
      shadow_opacity: r2(C.shadow_opacity),
      word_animation: wordAnimation,
      pop_scale: popScale,
      page_animation: pageAnimation,
      backing,
      // the house shade under the captions is ours, not the reference's
      shade: { enabled: false },
    },
    overlays: { progress_bar: O.progress_bar },
    split: { accent: C.secondary_accent_color },
    // the house CTA card is ours, not the reference's
    outro: { enabled: false },
  };
  // stage 27: references in the two expert talking-head looks get the house versions of them (and B-roll inserts)
  const captionLook = matchCaptionLook(C, captionsEnabled);
  if (captionLook === "clean_min") {
    design.captions = { ...design.captions, letter_case: "as_spoken", stroke_width: 0, shadow_y: 2, shadow_blur: 6, shadow_opacity: Math.max(0.35, r2(C.shadow_opacity)), font_size: Math.min(lay.font_size, 42), word_animation: "none", page_animation: "none", backing: { enabled: false } };
    design.inserts = { enabled: true };
  } else if (captionLook === "box_reveal") {
    design.captions = { ...design.captions, letter_case: "as_spoken", stroke_width: 0, shadow_opacity: 0, word_animation: "reveal", dim_color: "rgba(255,255,255,0.3)", numbers_font: "serif", font_size: Math.min(lay.font_size, 44), page_animation: "none", backing: { enabled: true, color: "rgba(0,0,0,0.8)", padding: 10, radius: 6 } };
    design.colors = { ...design.colors, text: "#FFFFFF" };
    design.inserts = { enabled: true };
  }
  row("captions (look)", "stage 27 caption look + design.inserts", captionLook ?? "—");
  row("captions.enabled + layout_preset", "EDL output.captions.enabled", captionsEnabled);
  row("captions.layout_preset", "design.captions.font_size / line_height (max_words=1 for single_word_impact)", `${C.layout_preset} → ${lay.font_size}px / ${lay.line_height}`);
  row("captions.max_words_per_screen", "design.captions.max_words", maxWords);
  row("captions.max_chars_per_line", "design.captions.max_chars", C.max_chars_per_line);
  row("captions.font_weight", "design.font.weight (Inter variable)", FONT_WEIGHT[C.font_weight]);
  row("captions.uppercase", "design.captions.uppercase", C.uppercase);
  row("captions.position_y_percent", "design.captions.anchor_y", r2(C.position_y_percent / 100));
  row("captions.primary_text_color", "design.colors.text", C.primary_text_color);
  row("captions.active_word_color", "design.colors.highlight", active);
  row("captions.secondary_accent_color", "design.split.accent", C.secondary_accent_color);
  row("captions.stroke_color", "design.colors.stroke", C.stroke_color);
  row("captions.stroke_width_px", "design.captions.stroke_width", C.stroke_width_px);
  row("captions.shadow_opacity", "design.captions.shadow_opacity", C.shadow_opacity);
  row("captions.background_box", "design.captions.backing", backing);
  row("captions.word_animation", "design.captions.word_animation / page_animation", `${C.word_animation} → ${wordAnimation} / ${pageAnimation}`);
  row("captions.active_word_scale", "design.captions.pop_scale", popScale);
  row("overlays.progress_bar", "design.overlays.progress_bar", O.progress_bar);
  if (O.emoji_popups) unsupported.push("overlays.emoji_popups — эмодзи-попапов в оверлее нет");
  row("overlays.emoji_popups", "— (не поддерживается)", O.emoji_popups);
  row("overlays.title_banner_first_3s", "planner rule: титр-хук at 0 / без титров", O.title_banner_first_3s);

  // ── (b) planner rules + pack preset ──
  const pace: Preset["pace"] = P.pacing_profile === "calm" ? "calm" : P.pacing_profile === "moderate" ? "neutral" : "dynamic";
  const body = P.body_avg_cut_duration_sec;
  const clipSeconds = { min: r2(Math.max(0.5, body * 0.5)), max: r2(Math.max(1.5, body * 2.2)) };
  const silenceMs = Math.round(P.silence_cut_threshold_ms);
  const fastCuts = P.pacing_profile === "fast" || P.pacing_profile === "aggressive";
  const jumpCut = silenceMs <= 300;
  const zoomRule = M.zoom_style === "none" ? ZOOM_RU.none : ZOOM_RU[M.zoom_frequency];
  const lines = [
    "СТИЛЬ ПО ПРИМЕРУ (монтаж как в присланном референсе). Эти правила важнее темпа пресета:",
    `- Темп: ${PACE_RU[P.pacing_profile]}. Хук: в первые 3 с склейка в среднем каждые ${r2(P.hook_cut_duration_sec)} с — первой ставь самую сильную короткую фразу, без приветствий и вступлений.`,
    `- Тело: в среднем склейка каждые ${r2(body)} с (клипы примерно ${clipSeconds.min}–${clipSeconds.max} с). ${fastCuts ? `Планируй по законченным фразам: длинные куски монтаж сам разрежет по паузам между словами (не длиннее ~${r2(Math.max(1.2, body * 1.6))} с) и сменит крупность — не дели фразы по словам ради ритма.` : "Держи законченные мысли целиком."}`,
    "- pN.wK нужен только для дублей и оговорок. Чтобы разрезать фразу между словами K и K+1: конец клипа pN.wK, начало следующего pN.w(K+1) — никогда одно и то же слово в двух клипах.",
    `- Паузы между словами длиннее ${silenceMs} мс монтаж вырежет сам (${jumpCut ? "джамп-каты, как в примере" : "естественный ритм"}); планируй по фразам, не дроби клипы ради пауз.`,
    P.remove_fillers_and_retakes
      ? "- Слова-паразиты (э, ммм, ну, короче, типа, uh, um…) монтаж вырежет сам. Дубли и оговорки убираешь ты: если человек повторяет фразу или начинает её заново — бери только последний удачный вариант (через pN.wK, если нужно)."
      : "- Слова-паразиты и оговорки не вырезай — в примере речь звучит естественно.",
    `- Наезды камерой: ${zoomRule}.${M.zoom_on_hook && M.zoom_style !== "none" ? " Первый клип — с наездом (punch_in: true)." : ""}`,
    `- Темп речи в примере ≈ ${Math.round(P.speech_wpm_estimate)} слов/мин${P.speech_wpm_estimate >= 180 ? " — плотная речь без провисаний" : ""}.`,
    "- Длительность выхода считается ПОСЛЕ автоматической чистки пауз и паразитов: бери фраз примерно на 15–25 % больше цели.",
    O.title_banner_first_3s ? "- Титр-хук: один титр at 0, 2–3 с, крупно — суть ролика в 2–5 словах из речи." : "- Титров нет (в примере их нет): titles = [].",
    captionsEnabled ? "- Субтитры включены (captions.enabled = true) на языке речи, если инструкция не просит другой." : "- Субтитров нет (в примере их нет): captions.enabled = false.",
    A.has_background_music ? "- Музыка под речью: music.enabled = true." : "- Без фоновой музыки: music.enabled = false.",
  ];
  const plannerRules = lines.join("\n");
  row("planner_rules.pacing_profile", "preset.pace + planner rules block", `${P.pacing_profile} → ${pace}`);
  row("planner_rules.hook_cut_duration_sec", "planner rules (hook rhythm)", P.hook_cut_duration_sec);
  row("planner_rules.body_avg_cut_duration_sec", "preset.clip_seconds + planner rules", clipSeconds);
  row("planner_rules.silence_cut_threshold_ms", "jump-cut pass: split clips at word gaps above it", silenceMs);
  row("planner_rules.remove_fillers_and_retakes", "jump-cut pass (fillers) + planner rules (retakes)", P.remove_fillers_and_retakes);
  row("planner_rules.speech_wpm_estimate", "planner rules (information only)", P.speech_wpm_estimate);

  // ── (c) cleanup, audio, colour ──
  const cleanup = { enabled: true, silenceMs, removeFillers: P.remove_fillers_and_retakes, handleMs: jumpCut ? 40 : 80, ...(fastCuts ? { maxPiece: r2(Math.max(1.2, body * 1.6)) } : {}) };
  const sfxOn = A.sfx_on_cuts_and_zooms && A.sfx_intensity !== "none";
  const sfx: SfxPlan = sfxOn
    ? A.sfx_intensity === "heavy_cinematic"
      ? { enabled: true, kind: "whoosh", gain: 0, everyCuts: 3, hookImpact: true }
      : { enabled: true, kind: "whoosh", gain: -8, everyCuts: 0, hookImpact: false }
    : { enabled: false, kind: "whoosh", gain: 0, everyCuts: 0, hookImpact: false };
  const duckDb = A.has_background_music ? (A.music_ducking_db === 0 ? null : A.music_ducking_db) : null;
  row("audio_and_color.has_background_music", "EDL output.music.enabled", A.has_background_music);
  row("audio_and_color.music_ducking_db", "mix: music bed under speech (musicUnderSpeechDb; 0 → no side-chain)", A.music_ducking_db);
  row("audio_and_color.sfx_on_cuts_and_zooms + sfx_intensity", "EDL output.sfx cues (whoosh on punch-ins, every Nth cut, impact on the hook)", sfx);
  const tint = TINT[G.preset];
  const identity = Math.abs(G.contrast_multiplier - 1) < 0.005 && Math.abs(G.saturation_multiplier - 1) < 0.005 && Math.abs(G.brightness_offset) < 0.002 && !tint;
  const grade: Grade | null = identity ? null : { contrast: r2(G.contrast_multiplier), saturation: r2(G.saturation_multiplier), brightness: Math.round(G.brightness_offset * 1000) / 1000, tint };
  row("audio_and_color.color_grade", "EDL output.grade → ffmpeg eq=contrast:saturation:brightness (+ colorbalance tint) in the cut", grade ?? "none");

  // ── (d) camera motion → clip zoom ──
  const mode: ZoomPlan["mode"] = M.zoom_style === "none" || M.zoom_frequency === "none" || M.zoom_scale_factor < 1.02 ? "none" : M.zoom_style === "instant_punch_in" ? "instant" : M.zoom_style === "fast_ease_out" ? "ease" : "ken_burns";
  const zoom: ZoomPlan = { frequency: M.zoom_frequency, mode, scale: r2(M.zoom_scale_factor), ease: mode === "ease" ? 0.25 : 0, onHook: M.zoom_on_hook };
  row("camera_motion.zoom_frequency / zoom_style / zoom_scale_factor", "EDL clip.zoom {from,to,ease} on chosen clips", zoom);
  row("camera_motion.split_screen_detected", "base preset split_news (else bold_pop)", M.split_screen_detected);

  return {
    basePreset: M.split_screen_detected ? "split_news" : "bold_pop",
    pace,
    clipSeconds,
    captionsEnabled,
    titleFirst3s: O.title_banner_first_3s,
    design,
    plannerRules,
    cleanup,
    zoom,
    grade,
    audio: { music: A.has_background_music, duckDb, sfx },
    captionLook,
    unsupported,
    table,
  };
}

/** deep merge of a patch into a plain object (arrays and primitives replace) */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = out[k];
    out[k] = b && typeof b === "object" && !Array.isArray(b) && v && typeof v === "object" && !Array.isArray(v) ? deepMerge(b, v) : v;
  }
  return out as T;
}

/** The job's preset with the reference style applied: pace / clip length / notes for the planner, the design patch for the overlay. */
export function applyStyleToPreset(preset: Preset, m: StyleMapping): Preset {
  return {
    ...preset,
    pace: m.pace,
    clip_seconds: m.clipSeconds,
    music_default: m.audio.music,
    notes: ["монтаж по примеру: правила стиля в задаче важнее этих заметок", ...preset.notes.filter((n) => !/чередовать сцены/.test(n))],
    design: deepMerge(preset.design, m.design),
  };
}

type SummaryLang = "ru" | "uz" | "en";
type ColorKey = "white" | "black" | "gray" | "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink";

const COLOR_NAMES: Record<SummaryLang, Record<ColorKey, string>> = {
  ru: { white: "белым", black: "чёрным", gray: "серым", red: "красным", orange: "оранжевым", yellow: "жёлтым", green: "зелёным", teal: "бирюзовым", blue: "синим", purple: "фиолетовым", pink: "розовым" },
  uz: { white: "oq", black: "qora", gray: "kulrang", red: "qizil", orange: "to‘q sariq", yellow: "sariq", green: "yashil", teal: "moviy-yashil", blue: "ko‘k", purple: "binafsha", pink: "pushti" },
  en: { white: "white", black: "black", gray: "gray", red: "red", orange: "orange", yellow: "yellow", green: "green", teal: "teal", blue: "blue", purple: "purple", pink: "pink" },
};

/** rough colour family of a hex */
export function colorKey(hex: string): ColorKey {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 28) return max > 200 ? "white" : max < 60 ? "black" : "gray";
  const d = max - min;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  if (h < 15 || h >= 340) return "red";
  if (h < 40) return "orange";
  if (h < 70) return "yellow";
  if (h < 160) return "green";
  if (h < 200) return "teal";
  if (h < 245) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

export const colorNameRu = (hex: string) => COLOR_NAMES.ru[colorKey(hex)];

const SUMMARY = {
  ru: {
    pace: { calm: "Спокойный темп", moderate: "Умеренный темп", fast: "Быстрый темп", aggressive: "Очень быстрый темп" },
    every: (s: number) => `склейка каждые ${s} с`,
    jump: "паузы вырезаны (джамп-каты)",
    caps: (n: number, upper: boolean, color: string) => `субтитры по ${n} ${n === 1 ? "слову" : "слова"}${upper ? " капсом" : ""}, активное слово ${color}`,
    noCaps: "без субтитров",
    zoom: { every_cut_aggressive: "наезды на каждой склейке", rare_emphasis: "редкие наезды на акцентах", every_2_3_sentences: "наезды каждые 2–3 фразы" },
    split: "сплит-экран",
    music: "музыка под речью",
    noMusic: "без музыки",
    sfx: "звуки на склейках",
  },
  uz: {
    pace: { calm: "Sokin temp", moderate: "O‘rtacha temp", fast: "Tez temp", aggressive: "Juda tez temp" },
    every: (s: number) => `har ${s} soniyada kesim`,
    jump: "pauzalar kesilgan (jump-cut)",
    caps: (n: number, upper: boolean, color: string) => `subtitrlar ${n} so‘zdan${upper ? ", katta harflarda" : ""}, faol so‘z ${color}`,
    noCaps: "subtitrsiz",
    zoom: { every_cut_aggressive: "har kesimda yaqinlashtirish", rare_emphasis: "urg‘ularda kam yaqinlashtirish", every_2_3_sentences: "har 2–3 gapda yaqinlashtirish" },
    split: "ikkiga bo‘lingan ekran",
    music: "nutq ostida musiqa",
    noMusic: "musiqasiz",
    sfx: "kesimlarda tovush effektlari",
  },
  en: {
    pace: { calm: "Calm pace", moderate: "Moderate pace", fast: "Fast pace", aggressive: "Very fast pace" },
    every: (s: number) => `a cut every ${s} s`,
    jump: "pauses removed (jump cuts)",
    caps: (n: number, upper: boolean, color: string) => `captions ${n} word${n === 1 ? "" : "s"} at a time${upper ? " in caps" : ""}, active word in ${color}`,
    noCaps: "no captions",
    zoom: { every_cut_aggressive: "punch-ins on every cut", rare_emphasis: "rare punch-ins on key words", every_2_3_sentences: "punch-ins every 2–3 sentences" },
    split: "split screen",
    music: "music under the voice",
    noMusic: "no music",
    sfx: "sound effects on cuts",
  },
};

/** One-line summary for the bot («Быстрый темп, склейка каждые 1.8 с, субтитры по 2 слова жёлтым…»). */
export function styleSummary(dna: StyleDNA, lang: SummaryLang = "ru"): string {
  const S = SUMMARY[lang];
  const P = dna.planner_rules;
  const C = dna.hyperframes_theme.captions;
  const M = dna.hyperframes_theme.camera_motion;
  const A = dna.audio_and_color;
  const parts = [`${S.pace[P.pacing_profile]}, ${S.every(r2(P.body_avg_cut_duration_sec))}`];
  if (P.silence_cut_threshold_ms <= 300) parts.push(S.jump);
  if (C.enabled && C.layout_preset !== "none") {
    const n = C.layout_preset === "single_word_impact" ? 1 : C.max_words_per_screen;
    parts.push(S.caps(n, C.uppercase, COLOR_NAMES[lang][colorKey(C.active_word_color)]));
  } else parts.push(S.noCaps);
  if (M.zoom_style !== "none" && M.zoom_frequency !== "none") parts.push(S.zoom[M.zoom_frequency]);
  if (M.split_screen_detected) parts.push(S.split);
  parts.push(A.has_background_music ? S.music : S.noMusic);
  if (A.sfx_on_cuts_and_zooms && A.sfx_intensity !== "none") parts.push(S.sfx);
  return `${parts.join(", ")}.`;
}

export const styleSummaryRu = (dna: StyleDNA) => styleSummary(dna, "ru");
