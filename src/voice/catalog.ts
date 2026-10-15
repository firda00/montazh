/**
 * Voice library for voiceovers (`vedit make --voice`) and avatars (`vedit avatar export --voice`).
 *
 * Two engines:
 *   - piper: local, CPU, a few seconds per video (Piper by rhasspy, MIT; models from huggingface
 *     rhasspy/piper-voices, ~60 MB each, downloaded on first use into tools/voice/models/).
 *   - chatterbox: Chatterbox Multilingual on the free Colab T4 (only through the avatar notebook).
 *     "Clone" presets give Chatterbox a short Piper-generated reference clip, so it speaks with the same
 *     timbre as the Piper voice but with Chatterbox's prosody.
 * The user's own voice (a voice note / --voice file / --speech recording) is not in the catalogue: it
 * always wins over a catalogue choice.
 *
 * Only voices whose training data licence allows commercial use are listed (dataset licence from each
 * voice's MODEL_CARD in rhasspy/piper-voices, checked 2026-10):
 *   ru_RU denis, dmitri — CC0 (OHF-Voice/voice-datasets)
 *   en_US ljspeech      — public domain (LJ Speech)
 *   en_US john          — public domain (LibriVox recordings)
 *   en_GB cori          — public domain (LibriVox recordings)
 * Deliberately EXCLUDED:
 *   ru_RU ruslan  — RUSLAN corpus is CC BY-NC-SA 4.0 (non-commercial)
 *   ru_RU irina   — dataset licence "Unknown" (RHVoice)
 *   en_US lessac  — Blizzard 2013 licence (research use)
 *   en_US ryan, hfc_female, hfc_male — CC BY-NC-SA 4.0
 *   en_US amy, en_GB alan, jenny_dioco — "See URL" / non-standard licences
 * There is no clean female Russian Piper voice; the female option for Russian is chatterbox_default.
 *
 * Third engine — gemini: Gemini-TTS prebuilt voices that speak Russian (and ~70 other languages, detected from the
 * text), with one style prompt per narration. Backend by key: GOOGLE_CLOUD_API_KEY → Cloud Text-to-Speech Gemini-TTS
 * (src/voice/cloudtts.ts), else GEMINI_API_KEY → Gemini API (src/voice/gemini.ts), else the Piper `fallback` with a
 * warning. Fourth — chirp3: Cloud TTS Chirp 3: HD (ru-RU-Chirp3-HD-<Name>, 1M characters/month free, no style
 * prompt); without the Cloud key it speaks through the Gemini API with the same voice name, else Piper.
 */

export type VoiceEngine = "piper" | "chatterbox" | "gemini" | "chirp3";
export type VoiceGender = "male" | "female";

export interface PiperModel {
  /** model name in piper-voices, e.g. ru_RU-denis-medium */
  key: string;
  /** folder in the repo: ru/ru_RU/denis/medium */
  path: string;
  /** size of the .onnx (from voices.json), for a sanity check after download */
  bytes: number;
}

export interface VoiceDef {
  id: string;
  /** short Russian label for the bot and the CLI */
  name: string;
  gender: VoiceGender;
  /** ISO 639-1 language the voice speaks */
  language: string;
  engine: VoiceEngine;
  /** licence of the voice (model weights / training data) */
  license: string;
  /** licence of the engine that runs it */
  engineLicense: string;
  source: string;
  notes: string;
  piper?: PiperModel;
  /** chatterbox: a Piper voice whose sample becomes the cloning reference (no ref = Chatterbox's built-in voice) */
  refFrom?: string;
  /** gemini / chirp3: the prebuilt voice name (Kore, Charon…) — the same names exist in the Gemini API,
   *  Cloud Gemini-TTS and Chirp 3: HD, so a voice can move between backends with a similar timbre */
  gemini?: { voiceName: string };
  /** gemini: the Piper voice used when there is no API key */
  fallback?: string;
  aliases?: string[];
}

const PIPER_ENGINE = "MIT (Piper 2023.11.14-2); espeak-ng (GPL-3.0) только как внешний процесс";
const CHATTERBOX_ENGINE = "MIT (Chatterbox Multilingual 0.1.7); неслышимый водяной знак Perth в речи";
const HF = "https://huggingface.co/rhasspy/piper-voices/tree/main/";
const GEMINI_ENGINE = "Gemini API (Google, облако): ключ GEMINI_API_KEY";
const GEMINI_LICENSE = "условия Gemini API: коммерция разрешена; для продакшена — платный уровень";
/** full licence note (README, /voice) */
export const GEMINI_LICENSE_NOTE = "Условия Gemini API: озвучку можно использовать коммерчески; для продакшена рекомендуется платный уровень — на бесплатном Google может использовать запросы для улучшения продуктов.";
const GEMINI_DOCS = "https://ai.google.dev/gemini-api/docs/speech-generation · https://docs.cloud.google.com/text-to-speech/docs/gemini-tts";
const CHIRP_ENGINE = "Google Cloud Text-to-Speech (облако): ключ GOOGLE_CLOUD_API_KEY";
const CHIRP_LICENSE = "условия Google Cloud TTS: коммерция разрешена; 1 млн символов в месяц бесплатно, далее $30 / 1 млн";
const CHIRP_DOCS = "https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd";

export const VOICES: VoiceDef[] = [
  {
    id: "gemini_charon",
    name: "Харон (Gemini) — мужской, информативный рассказчик",
    gender: "male",
    language: "ru",
    engine: "gemini",
    license: GEMINI_LICENSE,
    engineLicense: GEMINI_ENGINE,
    source: GEMINI_DOCS,
    notes: "Gemini TTS, голос Charon («Informative»); живая интонация, без ключа — Piper dmitri",
    gemini: { voiceName: "Charon" },
    fallback: "dmitri",
    aliases: ["charon", "харон", "gemini"],
  },
  {
    id: "gemini_puck",
    name: "Пак (Gemini) — мужской, бодрый",
    gender: "male",
    language: "ru",
    engine: "gemini",
    license: GEMINI_LICENSE,
    engineLicense: GEMINI_ENGINE,
    source: GEMINI_DOCS,
    notes: "Gemini TTS, голос Puck («Upbeat»); для энергичных роликов, без ключа — Piper denis",
    gemini: { voiceName: "Puck" },
    fallback: "denis",
    aliases: ["puck", "пак"],
  },
  {
    id: "gemini_kore",
    name: "Кора (Gemini) — женский, уверенный",
    gender: "female",
    language: "ru",
    engine: "gemini",
    license: GEMINI_LICENSE,
    engineLicense: GEMINI_ENGINE,
    source: GEMINI_DOCS,
    notes: "Gemini TTS, голос Kore («Firm»); женский русский голос для /make, без ключа — Piper dmitri",
    gemini: { voiceName: "Kore" },
    fallback: "dmitri",
    aliases: ["kore", "кора"],
  },
  {
    id: "chirp_orus",
    name: "Орус (Chirp 3 HD) — мужской, твёрдый",
    gender: "male",
    language: "ru",
    engine: "chirp3",
    license: CHIRP_LICENSE,
    engineLicense: CHIRP_ENGINE,
    source: CHIRP_DOCS,
    notes: "Cloud TTS ru-RU-Chirp3-HD-Orus; ровнее Gemini, без стиля; без Cloud-ключа — Gemini API Orus, иначе Piper dmitri",
    gemini: { voiceName: "Orus" },
    fallback: "dmitri",
    aliases: ["orus", "орус", "ru-RU-Chirp3-HD-Orus"],
  },
  {
    id: "chirp_fenrir",
    name: "Фенрир (Chirp 3 HD) — мужской, энергичный",
    gender: "male",
    language: "ru",
    engine: "chirp3",
    license: CHIRP_LICENSE,
    engineLicense: CHIRP_ENGINE,
    source: CHIRP_DOCS,
    notes: "Cloud TTS ru-RU-Chirp3-HD-Fenrir («Excitable»); без Cloud-ключа — Gemini API Fenrir, иначе Piper denis",
    gemini: { voiceName: "Fenrir" },
    fallback: "denis",
    aliases: ["fenrir", "фенрир", "ru-RU-Chirp3-HD-Fenrir"],
  },
  {
    id: "chirp_leda",
    name: "Леда (Chirp 3 HD) — женский, молодой",
    gender: "female",
    language: "ru",
    engine: "chirp3",
    license: CHIRP_LICENSE,
    engineLicense: CHIRP_ENGINE,
    source: CHIRP_DOCS,
    notes: "Cloud TTS ru-RU-Chirp3-HD-Leda («Youthful»); без Cloud-ключа — Gemini API Leda, иначе Piper dmitri",
    gemini: { voiceName: "Leda" },
    fallback: "dmitri",
    aliases: ["leda", "леда", "ru-RU-Chirp3-HD-Leda"],
  },
  {
    id: "chirp_sulafat",
    name: "Сулафат (Chirp 3 HD) — женский, тёплый",
    gender: "female",
    language: "ru",
    engine: "chirp3",
    license: CHIRP_LICENSE,
    engineLicense: CHIRP_ENGINE,
    source: CHIRP_DOCS,
    notes: "Cloud TTS ru-RU-Chirp3-HD-Sulafat («Warm»); без Cloud-ключа — Gemini API Sulafat, иначе Piper denis",
    gemini: { voiceName: "Sulafat" },
    fallback: "denis",
    aliases: ["sulafat", "сулафат", "ru-RU-Chirp3-HD-Sulafat"],
  },
  {
    id: "gemini_aoede",
    name: "Аэда (Gemini) — женский, лёгкий",
    gender: "female",
    language: "ru",
    engine: "gemini",
    license: GEMINI_LICENSE,
    engineLicense: GEMINI_ENGINE,
    source: GEMINI_DOCS,
    notes: "Gemini TTS, голос Aoede («Breezy»); мягче и разговорнее, без ключа — Piper denis",
    gemini: { voiceName: "Aoede" },
    fallback: "denis",
    aliases: ["aoede", "аэда"],
  },
  {
    id: "denis",
    name: "Денис — мужской, спокойный",
    gender: "male",
    language: "ru",
    engine: "piper",
    license: "CC0 (датасет OHF-Voice/voice-datasets)",
    engineLicense: PIPER_ENGINE,
    source: `${HF}ru/ru_RU/denis/medium`,
    notes: "локально на CPU, секунды на ролик; ровная дикторская подача",
    piper: { key: "ru_RU-denis-medium", path: "ru/ru_RU/denis/medium", bytes: 63201294 },
    aliases: ["ru_RU-denis-medium", "денис"],
  },
  {
    id: "dmitri",
    name: "Дмитрий — мужской, ниже и плотнее",
    gender: "male",
    language: "ru",
    engine: "piper",
    license: "CC0 (датасет OHF-Voice/voice-datasets)",
    engineLicense: PIPER_ENGINE,
    source: `${HF}ru/ru_RU/dmitri/medium`,
    notes: "локально на CPU",
    piper: { key: "ru_RU-dmitri-medium", path: "ru/ru_RU/dmitri/medium", bytes: 63201294 },
    aliases: ["ru_RU-dmitri-medium", "dmitry", "дмитрий"],
  },
  {
    id: "ljspeech",
    name: "LJ — женский, английский (US)",
    gender: "female",
    language: "en",
    engine: "piper",
    license: "public domain (LJ Speech)",
    engineLicense: PIPER_ENGINE,
    source: `${HF}en/en_US/ljspeech/medium`,
    notes: "для англоязычных роликов; локально на CPU",
    piper: { key: "en_US-ljspeech-medium", path: "en/en_US/ljspeech/medium", bytes: 63531379 },
    aliases: ["en_US-ljspeech-medium", "lj"],
  },
  {
    id: "john",
    name: "John — мужской, английский (US)",
    gender: "male",
    language: "en",
    engine: "piper",
    license: "public domain (записи LibriVox)",
    engineLicense: PIPER_ENGINE,
    source: `${HF}en/en_US/john/medium`,
    notes: "для англоязычных роликов; локально на CPU",
    piper: { key: "en_US-john-medium", path: "en/en_US/john/medium", bytes: 63531379 },
    aliases: ["en_US-john-medium"],
  },
  {
    id: "cori",
    name: "Cori — женский, британский английский",
    gender: "female",
    language: "en",
    engine: "piper",
    license: "public domain (записи LibriVox)",
    engineLicense: PIPER_ENGINE,
    source: `${HF}en/en_GB/cori/medium`,
    notes: "для англоязычных роликов; локально на CPU",
    piper: { key: "en_GB-cori-medium", path: "en/en_GB/cori/medium", bytes: 63531379 },
    aliases: ["en_GB-cori-medium"],
  },
  {
    id: "chatterbox_default",
    name: "Chatterbox — женский, живой (только аватар, Colab)",
    gender: "female",
    language: "ru",
    engine: "chatterbox",
    license: "MIT (встроенный голос Chatterbox, conds.pt)",
    engineLicense: CHATTERBOX_ENGINE,
    source: "https://huggingface.co/ResembleAI/chatterbox",
    notes: "синтез в Colab вместе с анимацией; 23 языка; женский голос для русского (чистого женского Piper-голоса нет)",
    aliases: ["chatterbox", "default"],
  },
  {
    id: "chatterbox_denis",
    name: "Денис (Chatterbox) — тембр Дениса, живая интонация (аватар, Colab)",
    gender: "male",
    language: "ru",
    engine: "chatterbox",
    license: "MIT (Chatterbox) + образец от Piper denis (CC0)",
    engineLicense: CHATTERBOX_ENGINE,
    source: "https://huggingface.co/ResembleAI/chatterbox",
    notes: "в архив кладётся образец голоса, сгенерированный Piper denis; Chatterbox клонирует тембр",
    refFrom: "denis",
  },
  {
    id: "chatterbox_dmitri",
    name: "Дмитрий (Chatterbox) — тембр Дмитрия, живая интонация (аватар, Colab)",
    gender: "male",
    language: "ru",
    engine: "chatterbox",
    license: "MIT (Chatterbox) + образец от Piper dmitri (CC0)",
    engineLicense: CHATTERBOX_ENGINE,
    source: "https://huggingface.co/ResembleAI/chatterbox",
    notes: "в архив кладётся образец голоса, сгенерированный Piper dmitri",
    refFrom: "dmitri",
  },
];

/** words "off" for a voice option (CLI --voice none, bot /voice off) */
export const NO_VOICE = /^(none|off|no|нет|выкл|выключить|без)$/i;

/** A catalogue voice by id or alias (case-insensitive); undefined when unknown. */
export function getVoice(id: string | undefined | null): VoiceDef | undefined {
  const k = (id ?? "").trim().toLowerCase();
  if (!k) return undefined;
  return VOICES.find((v) => v.id === k || (v.aliases ?? []).some((a) => a.toLowerCase() === k));
}

/** Like getVoice, but throws with the list of ids. */
export function requireVoice(id: string): VoiceDef {
  const v = getVoice(id);
  if (!v) throw new Error(`голос «${id}» не найден; есть: ${VOICES.map((x) => x.id).join(", ")} (vedit voices)`);
  return v;
}

/** Can be synthesised from this machine (Piper locally, Gemini through the API) — not only inside the Colab avatar notebook. */
export const isLocal = (v: VoiceDef) => v.engine === "piper" || v.engine === "gemini" || v.engine === "chirp3";

/** Needs a Google key (Gemini API or Cloud TTS) to sound as itself; falls back to Piper without one. */
export const isCloud = (v: VoiceDef) => v.engine === "gemini" || v.engine === "chirp3";

/** Where the voice is made, for the tables. */
export const whereLabel = (v: VoiceDef) => (v.engine === "piper" ? "локально" : v.engine === "gemini" ? "Gemini/Cloud TTS" : v.engine === "chirp3" ? "Cloud TTS" : "colab (аватар)");

/** The Piper voice that produces audio on this machine without a cloud key: itself, a clone preset's reference
 *  source, or a Gemini voice's fallback. */
export function piperVoiceFor(v: VoiceDef): VoiceDef | undefined {
  if (v.engine === "piper") return v;
  if (v.engine === "gemini" || v.engine === "chirp3") return getVoice(v.fallback ?? "dmitri");
  return v.refFrom ? getVoice(v.refFrom) : undefined;
}

/** The voice that speaks a sample / narration here: itself when it can, else piperVoiceFor. */
export const sampleVoiceFor = (v: VoiceDef): VoiceDef | undefined => (isLocal(v) ? v : piperVoiceFor(v));

/** Default Gemini voice for /make when a Google key (Gemini API or Cloud TTS) exists. */
export const DEFAULT_GEMINI_VOICE = "gemini_charon";
/** Default local voice per language when there is no key. */
export const DEFAULT_PIPER_VOICE: Record<string, string> = { ru: "dmitri", en: "john" };
/** Words that mean "the best voice available here" (bot default for /make, `--voice auto`). */
export const AUTO_VOICE = /^(auto|авто|default-voice)$/i;

/** `auto` → a Gemini voice when a Google key is set, else the Piper voice for the language. */
export function autoVoice(language = "ru", hasGoogleKey = false): VoiceDef {
  if (hasGoogleKey) return getVoice(DEFAULT_GEMINI_VOICE)!;
  return getVoice(DEFAULT_PIPER_VOICE[languageCode(language)] ?? "dmitri") ?? getVoice("dmitri")!;
}

/** The catalogue as a table (CLI `vedit voices`). */
export function formatVoices(voices = VOICES): string {
  const head = ["id", "пол", "язык", "движок", "где", "лицензия"];
  const rows = voices.map((v) => [v.id, v.gender === "male" ? "муж" : "жен", v.language, v.engine, whereLabel(v), v.license]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)].join("\n");
}

/** Short Russian list for the bot. */
export function voicesListText(current?: string): string {
  return VOICES.map((v) => `${v.id === current ? "▶" : "•"} ${v.id} — ${v.name}`).join("\n");
}

const LANGUAGE_CODES: Record<string, string> = { russian: "ru", "русский": "ru", english: "en", "английский": "en", uzbek: "uz", "узбекский": "uz", kazakh: "kk", turkish: "tr", german: "de", spanish: "es", french: "fr" };
/** "ru", "ru-RU", "Russian", "Uzbek (Latin script)" → ISO 639-1 code */
export function languageCode(language: string): string {
  const l = language.trim().toLowerCase();
  const word = l.split(/[\s(_-]/)[0];
  return LANGUAGE_CODES[word] ?? l.slice(0, 2);
}
