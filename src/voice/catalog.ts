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
 */

export type VoiceEngine = "piper" | "chatterbox";
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
  aliases?: string[];
}

const PIPER_ENGINE = "MIT (Piper 2023.11.14-2); espeak-ng (GPL-3.0) только как внешний процесс";
const CHATTERBOX_ENGINE = "MIT (Chatterbox Multilingual 0.1.7); неслышимый водяной знак Perth в речи";
const HF = "https://huggingface.co/rhasspy/piper-voices/tree/main/";

export const VOICES: VoiceDef[] = [
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

/** Runs locally (Piper) or only inside the Colab avatar notebook (Chatterbox). */
export const isLocal = (v: VoiceDef) => v.engine === "piper";

/** The Piper voice that actually produces audio on this machine: itself, or the reference source of a clone preset. */
export function piperVoiceFor(v: VoiceDef): VoiceDef | undefined {
  if (v.engine === "piper") return v;
  return v.refFrom ? getVoice(v.refFrom) : undefined;
}

/** The catalogue as a table (CLI `vedit voices`). */
export function formatVoices(voices = VOICES): string {
  const head = ["id", "пол", "язык", "движок", "где", "лицензия"];
  const rows = voices.map((v) => [v.id, v.gender === "male" ? "муж" : "жен", v.language, v.engine, isLocal(v) ? "локально" : "colab (аватар)", v.license]);
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
