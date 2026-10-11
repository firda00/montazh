import path from "node:path";
import { fileURLToPath } from "node:url";
import { PresetSchema, type Preset } from "../schemas/index.ts";
import { exists, readJson } from "../lib/workspace.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PRESETS_DIR = path.join(ROOT, "presets");

/** Built-in defaults, used when presets/<name>.json is missing. */
export const BUILTIN_PRESETS: Record<string, Preset> = {
  bold_pop: PresetSchema.parse({
    name: "bold_pop",
    description: "Динамичные вертикальные ролики: хук в первые 3 секунды, короткие клипы, крупные субтитры",
    pace: "dynamic",
    clip_seconds: { min: 2, max: 6 },
    caption_style: "bold_pop",
    title_style: "hero",
    default_aspect: "9:16",
    music_default: false,
    notes: ["хук в первые 3 секунды", "заканчивать на законченной фразе", "чередовать сцены"],
    design: {
      outro: {
        enabled: true,
        duration: 1.8,
        text: "Подпишись — дальше ещё вкуснее",
        text_by_lang: { ru: "Подпишись — дальше ещё вкуснее", uz: "Obuna boʻling — davomi yanada mazali", en: "Follow for more" },
      },
    },
  }),
  calm: PresetSchema.parse({
    name: "calm",
    description: "Спокойный монтаж в исходном порядке, длинные планы",
    pace: "calm",
    clip_seconds: { min: 5, max: 15 },
    caption_style: "clean",
    title_style: "minimal",
    default_aspect: "16:9",
    music_default: false,
    notes: ["сохранять исходный порядок", "не ускорять речь"],
  }),
};

export async function loadPreset(name: string, dir = PRESETS_DIR): Promise<{ preset: Preset; note?: string }> {
  const file = path.join(dir, `${name}.json`);
  if (await exists(file)) return { preset: await readJson(file, PresetSchema) };
  const builtin = BUILTIN_PRESETS[name];
  if (builtin) return { preset: builtin, note: `пресет ${name}: файл ${file} не найден, использован встроенный` };
  throw new Error(`пресет "${name}" не найден: нет ${file} и нет встроенного (есть: ${Object.keys(BUILTIN_PRESETS).join(", ")})`);
}
