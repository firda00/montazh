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
    sfx: { enabled: true, intensity: "dynamic", hook_impact: true, transitions: true, title_pop: true, outro_chime: true },
    design: {
      // stage 23: smaller, softer captions (thin stroke + soft shadow), 3 words a page, lower third, off the faces
      colors: { stroke: "rgba(0,0,0,0.85)" },
      captions: { anchor_y: 0.75, max_words: 3, max_chars: 20, font_size: 60, line_height: 1.12, stroke_width: 3, shadow_opacity: 0.5, avoid_face: true },
      outro: {
        enabled: true,
        duration: 1.8,
        text: "Подпишись — дальше ещё вкуснее",
        text_by_lang: { ru: "Подпишись — дальше ещё вкуснее", uz: "Obuna boʻling — davomi yanada mazali", en: "Follow for more" },
      },
    },
  }),
  pronin_style: PresetSchema.parse({
    name: "pronin_style",
    description: "Стиль Pronin Media / Retention Pro: агрессивный динамичный монтаж, ультра-плотные джамп-каты без пауз, кинетическая типографика по 2 слова с неоновым хайлайтером, наезды камеры (punch-in), B-roll карточки и мощный саунд-дизайн",
    pace: "dynamic",
    clip_seconds: { min: 1, max: 4 },
    caption_style: "pronin_kinetic",
    title_style: "card",
    default_aspect: "9:16",
    music_default: true,
    notes: ["хук в первые 2.5 секунды", "ультра-плотный монтаж", "камера меняет крупность", "субтитры по 2 слова капсом"],
    sfx: { enabled: true, intensity: "heavy", hook_impact: true, transitions: true, title_pop: true, outro_chime: true },
    design: {
      font: { family: "Montserrat", file: "assets/fonts/Montserrat-Variable.ttf", weight: 900 },
      colors: { text: "#FFFFFF", highlight: "#FFE600", stroke: "rgba(0,0,0,0.92)", title: "#FFFFFF", title_bg: "linear-gradient(135deg, rgba(20,20,25,0.95) 0%, rgba(10,10,14,0.98) 100%)" },
      captions: { anchor_y: 0.68, max_words: 2, max_chars: 16, font_size: 76, line_height: 1.08, uppercase: true, letter_case: "upper", stroke_width: 6, shadow_opacity: 0.85, word_animation: "pop", pop_scale: 1.18, page_animation: "fade_up", avoid_face: true, backing: { enabled: true, color: "rgba(10,10,14,0.65)", padding: 12, radius: 20 }, shade: { enabled: true, strength: 0.55, from: 0.5 } },
      titles: { anchor_y: 0.16, font_size: 74, max_lines: 2, animation: "slide_up", padding: 24, radius: 20, avoid_face: true, face_zone: 0.42, accent_color: "#FFE600" },
      safe_area: { x: 0.06, y: 0.08 },
      inserts: { enabled: true, density: "high", site_capture: true, pip: true, chips: true, sfx: true },
      overlays: { progress_bar: true },
      outro: { enabled: true, duration: 2.0, text: "Подпишись — больше пользы в профиле", text_by_lang: { ru: "Подпишись — больше пользы в профиле", uz: "Obuna boʻling — profilda yanada koʻproq foyda", en: "Follow for more in profile" }, font_size: 78, backdrop: "rgba(0,0,0,0.55)" },
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
    sfx: { enabled: false, intensity: "none", hook_impact: false, transitions: false, title_pop: false, outro_chime: false },
  }),
};

export async function loadPreset(name: string, dir = PRESETS_DIR): Promise<{ preset: Preset; note?: string }> {
  const file = path.join(dir, `${name}.json`);
  if (await exists(file)) return { preset: await readJson(file, PresetSchema) };
  const builtin = BUILTIN_PRESETS[name];
  if (builtin) return { preset: builtin, note: `пресет ${name}: файл ${file} не найден, использован встроенный` };
  throw new Error(`пресет "${name}" не найден: нет ${file} и нет встроенного (есть: ${Object.keys(BUILTIN_PRESETS).join(", ")})`);
}
