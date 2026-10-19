import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "./lib/ffmpeg.ts";
import { promptNames, promptsHash } from "./lib/prompts.ts";
import { exists, readJson, WORKSPACE_ROOT } from "./lib/workspace.ts";
import { resolveLlmProvider, type LlmStep, type ProviderPick } from "./lib/llm-provider.ts";
import { plannerModels, textModels } from "./lib/gemini-llm.ts";
import { HF_BIN } from "./design/hyperframes/project.ts";
import { findMattePython, MATTE_MODEL } from "./design/matte.ts";
import { findAsrPython } from "./understand/asr.ts";
import { selectAsr } from "./understand/index.ts";
import { selectVisionProvider } from "./understand/vision/index.ts";
import { WHISPER_BIN, WHISPER_MODEL } from "./understand/whisper.ts";
import { CostSchema, JobSchema, PresetSchema, type Cost, type Job, type Preset, type StepName } from "./schemas/index.ts";
import { BUDGET_ENV, DEFAULT_BUDGET, budgetFromEnv, type Budget } from "./plan/budget.ts";
import { BUILTIN_PRESETS, PRESETS_DIR } from "./plan/presets.ts";
import { COMPACT_ABOVE_TOKENS, MAX_HIGHLIGHTS, MIN_GAP } from "./plan/context.ts";
import { DEFAULT_MAX_WINDOWS, LONG_PHRASES, LONG_TOKENS } from "./plan/shortlist.ts";
import { DEFAULT_SCENE_THRESHOLD } from "./understand/shots.ts";
import { TARGET_FPS } from "./ingest/index.ts";
import { RESERVE_MB, WORKER_MB } from "./render/workers.ts";
import { DEFAULT_MODEL } from "./plan/backend/index.ts";
import { DEFAULT_GEMINI_MODEL } from "./understand/vision/gemini.ts";
import { DEFAULT_AGY_MODEL } from "./understand/vision/agy.ts";
import { VOICES } from "./voice/catalog.ts";
import { piperStatus } from "./voice/piper.ts";
import { geminiApiKey, geminiTtsModels } from "./voice/gemini.ts";
import { dailyBudgetUsdFromEnv, FREE_PLAN_FIELDS, freePlanFromEnv, maxJobsFromEnv, PER_USER_QUEUED, PER_USER_RUNNING, retentionDaysFromEnv, tzOffsetFromEnv, userDailyJobsFromEnv } from "./bot/plans.ts";
import { trendsBackend } from "./make/trends.ts";
import { imageBackend } from "./make/images.ts";
import { cloudApiKey, cloudGeminiModels } from "./voice/cloudtts.ts";

/** the provider a step would use, or null when no model is configured (registry probes never throw) */
function llmPick(step: LlmStep, env: NodeJS.ProcessEnv): ProviderPick | null {
  try {
    return resolveLlmProvider(step, env);
  } catch {
    return null;
  }
}

/**
 * The module registry: every replaceable part of the pipeline, what it depends on (and under
 * which licence), how its backend is chosen, and how to tell whether it is ready on this machine.
 * `vedit modules` prints it next to usage from the workspace, so "what is in use" and "what can
 * go" are answered by numbers.
 */

export interface Backend {
  id: string;
  title: string;
  /** dependency and its licence, for due diligence */
  deps: string;
  license: string;
}

export interface ModuleDef {
  id: string;
  /** "source": produces the video the pipeline starts from (avatars) */
  stage: StepName | "delivery" | "source";
  title: string;
  what: string;
  /** how the active backend is chosen (flag / env) */
  selector: string;
  backends: Backend[];
  /** step whose run counts as a use of this module */
  step?: StepName;
  /** cost.json entries that belong to this module */
  cost?: (e: Cost["entries"][number]) => boolean;
  /** jobs that belong to this module (delivery modules) */
  job?: (j: Job) => boolean;
  probe: (env: NodeJS.ProcessEnv) => Promise<{ active: string; ready: boolean; note: string }>;
}

const has = async (p: string) => exists(p);
/** a job started from the bot: its source is an upload under workspace/_bot/ (stage 7–18) or workspace/users/<tg_id>/ (stage 19) */
const BOT_SOURCE = /[\\/](_bot|users[\\/]\d+)[\\/]/;

export const MODULES: ModuleDef[] = [
  {
    id: "ingest",
    stage: "ingest",
    title: "Нормализация видео",
    what: "CFR 30 fps, ключевой кадр в секунду, WAV 16 кГц для речи",
    selector: "всегда; FFMPEG_PATH / FFPROBE_PATH",
    backends: [{ id: "ffmpeg", title: "FFmpeg", deps: "ffmpeg, ffprobe", license: "LGPL-2.1+ (динамическая линковка; GPL-сборки — только как внешний процесс)" }],
    step: "ingest",
    probe: async () => {
      try {
        await ffmpeg(["-version"]);
        return { active: "ffmpeg", ready: true, note: "" };
      } catch (err) {
        return { active: "ffmpeg", ready: false, note: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    },
  },
  {
    id: "asr",
    stage: "understand",
    title: "Распознавание речи",
    what: "фразы и пословные таймкоды",
    selector: "--asr auto|cpp|faster, VEDIT_ASR; auto = faster с NVIDIA GPU или для файлов > 20 мин; правка имён/терминов VEDIT_ASR_FIX=auto|off (Gemini flash-lite), VEDIT_WHISPER_PROMPT=on|carry|off",
    backends: [
      { id: "cpp", title: "whisper.cpp large-v3-turbo", deps: "whisper-cli, ggml-модель", license: "MIT (код и веса Whisper)" },
      { id: "faster", title: "faster-whisper", deps: "tools/asr/.venv: faster-whisper, CTranslate2", license: "MIT" },
    ],
    step: "understand",
    cost: (e) => /whisper/.test(e.provider),
    probe: async (env) => {
      const sel = await selectAsr("auto", env).catch(() => ({ engine: "whisper.cpp" as const, python: null, reason: "" }));
      if (sel.engine === "faster-whisper") return { active: "faster", ready: true, note: sel.reason };
      const ok = (await has(WHISPER_BIN)) && (await has(WHISPER_MODEL));
      const sidecar = await findAsrPython(env);
      return { active: "cpp", ready: ok, note: ok ? (sidecar ? "faster-whisper установлен: на CPU — для файлов > 20 мин" : "") : `нет ${(await has(WHISPER_BIN)) ? "модели" : "whisper-cli"}` };
    },
  },
  {
    id: "speakers",
    stage: "understand",
    title: "Говорящие",
    what: "S1, S2… на каждой фразе; фильтр --speaker",
    selector: "--no-diarize, VEDIT_DIARIZE=0; авто при установленном сайдкаре",
    backends: [{ id: "ecapa", title: "ECAPA-TDNN + кластеризация", deps: "tools/asr/.venv: speechbrain, torch, scipy", license: "Apache-2.0 (SpeechBrain, веса VoxCeleb)" }],
    step: "understand",
    cost: (e) => /speaker/.test(e.provider),
    probe: async (env) => {
      const py = await findAsrPython(env);
      return { active: "ecapa", ready: !!py, note: py ? "" : "сайдкар tools/asr не установлен" };
    },
  },
  {
    id: "scenes",
    stage: "understand",
    title: "Шоты и громкость",
    what: "границы шотов (scene 0.2), кадр на шот, кривая громкости",
    selector: "всегда",
    backends: [{ id: "ffmpeg", title: "FFmpeg select/ebur128", deps: "ffmpeg", license: "LGPL-2.1+" }],
    step: "understand",
    probe: async () => ({ active: "ffmpeg", ready: true, note: "" }),
  },
  {
    id: "vision",
    stage: "understand",
    title: "Понимание кадра",
    what: "описание шотов, точки фокуса (auto_face), highlights",
    selector: "--vision auto|gemini|agy|stub, VEDIT_VISION; auto = ключ → agy → stub",
    backends: [
      { id: "gemini", title: "Gemini API", deps: "GEMINI_API_KEY", license: "условия Gemini API; по умолчанию gemini-3.5-flash-lite" },
      { id: "agy", title: "Antigravity CLI", deps: "agy + вход Google", license: "условия Antigravity; $0, подписка" },
      { id: "stub", title: "Заглушка", deps: "—", license: "—" },
    ],
    step: "understand",
    cost: (e) => ["stub", "gemini", "antigravity-cli"].includes(e.provider),
    probe: async (env) => {
      try {
        const { provider, note } = await selectVisionProvider("auto", env);
        const active = provider.name === "antigravity-cli" ? "agy" : provider.name;
        return { active, ready: active !== "stub", note: note.replace(/^vision: /, "") };
      } catch (err) {
        return { active: "stub", ready: false, note: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    id: "planner",
    stage: "plan",
    title: "Планировщик",
    what: "инструкция + пак → edl.json; правки диалогом",
    selector: "--backend auto|api|agent|gemini|mock, VEDIT_PLANNER; auto — VEDIT_LLM_PLANNER / VEDIT_LLM (claude|gemini); модель VEDIT_PLANNER_MODEL / VEDIT_GEMINI_PLANNER_MODEL; запаска VEDIT_LLM_FALLBACK",
    backends: [
      { id: "api", title: "Claude API", deps: "@anthropic-ai/sdk, ANTHROPIC_API_KEY", license: "MIT (SDK); условия Anthropic API" },
      { id: "agent", title: "Claude Code (подписка)", deps: "@anthropic-ai/claude-agent-sdk, вход Claude Code", license: "MIT (SDK); условия подписки" },
      { id: "gemini", title: "Gemini API: function calling (инструменты планировщика) + responseSchema, ремонт по валидатору, запасные модели на 429/503/404 (этап 29)", deps: "GEMINI_API_KEY; модели VEDIT_GEMINI_PLANNER_MODEL → gemini-3.8-flash → 3.7-flash → 3.6-flash → 3.5-flash", license: "условия Gemini API (бесплатный уровень: 20 запросов в день на модель, данные могут использоваться Google — для клиентов платный)" },
      { id: "mock", title: "Мок", deps: "—", license: "—" },
    ],
    step: "plan",
    cost: (e) => (e.step === "plan" || e.step === "revise") && e.units.shortlist !== 1,
    probe: async (env) => {
      const pick = llmPick("planner", env);
      if (!pick) return { active: "api", ready: false, note: "нет ANTHROPIC_API_KEY, входа Claude Code и GEMINI_API_KEY" };
      if (pick.provider === "gemini") return { active: "gemini", ready: true, note: pick.reason };
      const active = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "api" : "agent";
      return { active, ready: true, note: [active === "agent" ? "вход Claude Code" : "", pick.fallback ? "запаска: Gemini" : ""].filter(Boolean).join("; ") };
    },
  },
  {
    id: "shortlist",
    stage: "plan",
    title: "Отбор окон (длинное видео)",
    what: "индекс фраз → ≤24 окна; авто при >250 фраз",
    selector: "--long / --no-long, --windows; те же бэкенды, что у планировщика",
    backends: [{ id: "llm", title: "Structured-вызов Claude или Gemini (VEDIT_LLM_SHORTLIST / VEDIT_LLM)", deps: "как планировщик", license: "как планировщик" }],
    step: "plan",
    cost: (e) => e.units.shortlist === 1,
    probe: async (env) => {
      const pick = llmPick("shortlist", env);
      return { active: "llm", ready: !!pick, note: pick ? pick.provider : "без модели окна берутся из highlights" };
    },
  },
  {
    id: "cut",
    stage: "cut",
    title: "Нарезка",
    what: "клипы по EDL, кроп 9:16 / 1:1 / 16:9, auto_face, snap к словам",
    selector: "всегда; --no-snap",
    backends: [{ id: "ffmpeg", title: "FFmpeg", deps: "ffmpeg", license: "LGPL-2.1+" }],
    step: "cut",
    probe: async () => ({ active: "ffmpeg", ready: true, note: "" }),
  },
  {
    id: "highlights",
    stage: "understand",
    title: "Хайлайты спорта/экшена",
    what: "события по видео (Gemini, чанки ~8 мин через Files API) → проверка бросков по кадрам у кольца и по звуку → отбор → замедление 0.5× из 60 fps, наезд на кольцо, вспышка, повтор, музыка по битам",
    selector: "vedit run … --mode highlights | auto по инструкции (баскет, футбол, броски, трюки…); vedit highlights <job>; VEDIT_EVENTS_MODEL",
    backends: [
      { id: "gemini-events", title: "Gemini API: видео со звуком 480p, 2 кадра/с, media_resolution low; кэш workspace/_cache/events", deps: "GEMINI_API_KEY; модели gemini-3.8-flash → 3.6-flash → 3.7-flash → 3.5-flash → flash-latest", license: "условия Gemini API (бесплатный уровень: данные могут использоваться Google)" },
      { id: "local-refine", title: "Трек мяча у кольца (фон-медиана, коричневые пятна размера мяча) + онсет звука", deps: "ffmpeg (raw-кадры ROI, f32 PCM)", license: "свой код" },
      { id: "beats", title: "Сетка битов музыки (автокорреляция онсетов)", deps: "ffmpeg", license: "свой код" },
      { id: "players", title: "--per-person: кто бросал — проход «игроки» Gemini по чанкам + мяч назад к рукам (findShooter) + правки players.fix.json; ролик на каждого", deps: "GEMINI_API_KEY; ffmpeg", license: "условия Gemini API; свой код" },
    ],
    job: (j) => j.preset === "sport_highlights",
    cost: (e) => e.provider === "gemini-events",
    probe: async (env) => {
      const key = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
      return { active: key ? "gemini-events" : "—", ready: key, note: key ? "" : "нет GEMINI_API_KEY — режим highlights недоступен" };
    },
  },
  {
    id: "style",
    stage: "understand",
    title: "Монтаж по примеру (Style DNA)",
    what: "рилс-пример → темп, джамп-каты, паразиты, субтитры, наезды, музыка, эффекты, цвет → правила планировщика, пресет оформления, чистка пауз, наезды, eq-цвет; кэш workspace/_cache/style",
    selector: "vedit run … --like <файл|ссылка>; vedit style <пример>; бот: 🎯 Монтаж как в примере; VEDIT_STYLE_MODEL, VEDIT_STYLE_FPS, VEDIT_YTDLP",
    backends: [
      { id: "measure", title: "Замеры: склейки (ffmpeg scene + джамп-каты по трём полосам кадра), темп речи и паузы (whisper), громкость пауз, signalstats", deps: "ffmpeg; whisper.cpp", license: "свой код; LGPL-2.1+ (ffmpeg); MIT (whisper)" },
      { id: "gemini-style", title: "Gemini API: пример ≤ 90 с, ≤ 960 px со звуком, 4 кадра/с, responseSchema = Style DNA, temperature 0.1", deps: "GEMINI_API_KEY; модели gemini-3.8-flash → … → 2.5-flash", license: "условия Gemini API (бесплатный уровень: данные могут использоваться Google)" },
      { id: "yt-dlp", title: "Ссылки Instagram / TikTok / YouTube Shorts (по желанию; Instagram часто требует вход)", deps: "yt-dlp в PATH или VEDIT_YTDLP", license: "Unlicense" },
    ],
    cost: (e) => e.provider === "gemini-style",
    probe: async (env) => {
      const key = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
      return { active: key ? "measure + gemini-style" : "measure", ready: true, note: key ? "" : "нет GEMINI_API_KEY — визуальный стиль по умолчанию, ритм и паузы по замерам" };
    },
  },
  {
    id: "translate",
    stage: "design",
    title: "Перевод субтитров",
    what: "ru ↔ uz ↔ en по фразам, кэш в задаче",
    selector: "--no-translate; авто, когда язык субтитров ≠ язык речи",
    backends: [{ id: "llm", title: "Structured-вызов Claude или Gemini (VEDIT_LLM_TRANSLATE / VEDIT_LLM)", deps: "как планировщик", license: "как планировщик" }],
    step: "design",
    cost: (e) => e.step === "design",
    probe: async (env) => {
      const pick = llmPick("translate", env);
      return { active: "llm", ready: !!pick, note: pick ? pick.provider : "перевод недоступен, субтитры на языке речи" };
    },
  },
  {
    id: "render",
    stage: "render",
    title: "Оформление и рендер",
    what: "субтитры с подсветкой, титры, аутро, −14 LUFS",
    selector: "--renderer hyperframes; --quality, --workers",
    backends: [
      { id: "hyperframes", title: "HyperFrames 0.8.145", deps: "hyperframes (npm), Chromium; GSAP 3.14 vendored; Inter", license: "Apache-2.0; GSAP Standard (бесплатно, без ограничений с 2024); Inter OFL-1.1" },
      { id: "split-photos", title: "split_news: настоящие фото на панелях — Openverse (как в make), кэш design/<id>-panels/, атрибуция в credits.json и в описании бота", deps: "сеть; ffmpeg (кадрирование под рамку)", license: "только CC0 / Public Domain Mark / CC BY; CC BY — атрибуция обязательна (строки добавляются автоматически)" },
      { id: "split-graphics", title: "split_news: моушн-графика кодом (src/design/panel-graphics.ts: одометр, графики, цитата, таймлайн, сравнение, чат, поиск, пост, список) + фильтр ИИ-метафор", deps: "HyperFrames + GSAP", license: "свой код (приёмы как у компонентов number-wheel / headline-slam реестра HyperFrames, Apache-2.0; код не копировался)" },
      { id: "split-ai", title: "split_news: ИИ-картинка Antigravity — только последний вариант, документальный промпт", deps: "agy + вход Google", license: "условия Antigravity; $0" },
      { id: "remotion", title: "Remotion (прототип, выключен)", deps: "tools/remotion-overlay", license: "коммерческая от 4 сотрудников — не использовать в проде" },
    ],
    step: "render",
    probe: async () => {
      const ok = await has(HF_BIN);
      return { active: "hyperframes", ready: ok, note: ok ? "" : "npm install" };
    },
  },
  {
    id: "cutout",
    stage: "render",
    title: "Вырезание спикера (сплит)",
    what: "split_news: спикер без фона поверх фирменного фона, голова «выходит» над стыком; auto — только при надёжной маске",
    selector: "design.split.cutout off|on|auto (split_news: auto), --cutout on|off|auto; VEDIT_MATTE_PYTHON",
    backends: [
      {
        id: "mediapipe",
        title: "MediaPipe Tasks ImageSegmenter, selfie_segmenter.tflite (256×256, 15 кадров/с) + цветной guided filter, сглаживание во времени → VP9 WebM с альфой",
        deps: "tools/matte/.venv: mediapipe 1.1.1 (--no-deps), opencv-python-headless, numpy, absl-py, flatbuffers, matplotlib, certifi; модель в tools/matte/models (скачивается один раз)",
        license: "Apache-2.0 (MediaPipe, модель selfie_segmenter — карточка модели Google), OpenCV Apache-2.0, NumPy BSD-3",
      },
    ],
    step: "render",
    probe: async (env) => {
      const py = await findMattePython(env);
      if (!py) return { active: "mediapipe", ready: false, note: "сайдкар tools/matte не установлен — сплит идёт с обычным видео" };
      const model = await has(MATTE_MODEL);
      return { active: "mediapipe", ready: true, note: model ? "" : "модель скачается при первом запуске" };
    },
  },
  {
    id: "faces",
    stage: "design",
    title: "Субтитры не закрывают лицо (этап 23)",
    what: "лица по кадрам черновой нарезки → каждая страница субтитров, титр, плашка и аутро — в свободной полосе вне лица, в безопасной зоне Reels (верх 8 %, низ 16 %), без скачков между страницами",
    selector: "design.captions.avoid_face (по умолчанию true, все пресеты); VEDIT_MATTE_PYTHON",
    backends: [
      {
        id: "mediapipe",
        title: "MediaPipe Tasks FaceDetector, BlazeFace short-range (8 кадров/с, кадр + квадратные окна), кэш design/<id>-faces/",
        deps: "tools/matte/.venv (тот же сайдкар, что вырезание спикера); модель blaze_face_short_range.tflite в tools/matte/models (скачивается один раз, ~230 КБ)",
        license: "Apache-2.0 (MediaPipe, модель BlazeFace — карточка модели Google)",
      },
      { id: "scenes", title: "Запаска без сайдкара: точки фокуса сцен (vision) через кроп нарезки, размер лица по типу плана", deps: "scenes.json с focus", license: "свой код" },
    ],
    step: "render",
    probe: async (env) => {
      const py = await findMattePython(env);
      return py ? { active: "mediapipe", ready: true, note: "" } : { active: "scenes", ready: true, note: "сайдкар tools/matte не установлен — лица по точкам фокуса сцен (грубо)" };
    },
  },
  {
    id: "make",
    stage: "design",
    title: "Ролик из ничего",
    what: "тема → тренды → сценарий (с проверкой на клише) → настоящие фото и моушн-графика → MP4 9:16 / 16:9 / 1:1 (озвучка по желанию: --voice)",
    selector: "vedit make <тема> / Telegram /make [16:9] <тема>; --aspect, --images photo|ai|none, --no-trends, --music, --script, --voice, --presenter [фото] / --presenter-video avatar_result.zip",
    backends: [
      { id: "agy-trends", title: "Тренды: Antigravity CLI (поиск в вебе)", deps: "agy + вход Google", license: "условия Antigravity; $0" },
      { id: "gemini-trends", title: "Тренды без agy (сервер): Gemini + Google Search grounding, источники из цитат", deps: "GEMINI_API_KEY (платный уровень: поиск не входит в бесплатный); VEDIT_TRENDS_MODEL → gemini-3.8-flash → 2.5-flash", license: "условия Gemini API; 5000 поисков/мес бесплатно, далее $14 / 1000" },
      { id: "claude-script", title: "Сценарий и арт-директор: structured-вызов Claude + проверка клише (src/make/slop.ts, одна переписка)", deps: "как планировщик", license: "как планировщик" },
      { id: "gemini-script", title: "Сценарий и арт-директор на Gemini (этап 29): responseSchema, один ремонт ответа (VEDIT_LLM_SCRIPT / VEDIT_LLM_DESIGN / VEDIT_LLM)", deps: "GEMINI_API_KEY; VEDIT_GEMINI_LLM_MODEL → gemini-3.8-flash → …", license: "условия Gemini API" },
      { id: "openverse-photos", title: "Фото: Openverse (api.openverse.org, без ключа), кэш workspace/_cache/photos", deps: "сеть; ffmpeg (кадрирование)", license: "только CC0 / Public Domain Mark / CC BY (коммерческое использование разрешено); CC BY требует атрибуции — строки в credits.json, make.json и в описании (CLI, бот)" },
      { id: "commons-entities", title: "Этап 26: фото названного (компания, место, человек, биржа) — Wikimedia Commons API по точному имени, кэш workspace/_cache/photos", deps: "сеть; ffmpeg (кадрирование по фокусу)", license: "только CC0 / Public domain / CC BY / CC BY-SA; автор и лицензия — в credits.json и описании; CC BY-SA: кадрированный кадр под той же лицензией" },
      { id: "simple-icons", title: "Этап 26: знаки брендов Simple Icons (jsDelivr, версия зафиксирована, кэш workspace/_cache/simple-icons)", deps: "сеть при первом использовании", license: "данные CC0-1.0 (у отдельных иконок своя лицензия — пишется в make.json); товарные знаки — владельцев, показ для обозначения компании; бренды, удалённые из Simple Icons (OpenAI, Microsoft, Nasdaq), — набранное имя" },
      { id: "gemini-visual-check", title: "Этап 26: сущности сценария (Gemini flash-lite, один текстовый запрос) и проверка каждой картинки на соответствие (Gemini vision, пачкой, кэш)", deps: "GEMINI_API_KEY; VEDIT_VISUAL_LLM_MODEL / VEDIT_RELEVANCE_MODEL; VEDIT_VISUALS=off выключает этап", license: "условия Gemini API; ≈$0.005 на ролик" },
      { id: "agy-images", title: "Картинки-запаска: Antigravity CLI (генерация), если фото не нашлось или --images ai", deps: "agy + вход Google", license: "условия Antigravity; $0" },
      { id: "gemini-images", title: "Картинки-запаска без agy (сервер): Gemini image API, по запросу на картинку", deps: "GEMINI_API_KEY с биллингом (бесплатного уровня нет); VEDIT_IMAGE_MODEL → gemini-3.1-flash-lite-image → nano-banana-2.1", license: "условия Gemini API; ≈$0.034 за картинку; без квоты — только фото и типографика" },
      { id: "lucide", title: "Иконки Lucide", deps: "lucide-static (npm)", license: "ISC" },
      { id: "hyperframes", title: "Композиция и рендер HyperFrames", deps: "hyperframes, Chromium, GSAP, Inter", license: "Apache-2.0; GSAP Standard; OFL-1.1" },
    ],
    job: (j) => /make:/.test(j.source),
    probe: async (env) => {
      const scriptPick = llmPick("script", env);
      const script = !!scriptPick;
      const trends = await trendsBackend(env);
      const images = await imageBackend(env);
      const active = [trends === "agy" ? "agy-trends" : trends === "gemini-search" ? "gemini-trends" : "", scriptPick?.provider === "gemini" ? "gemini-script" : "claude-script", "openverse-photos", env.VEDIT_VISUALS?.trim().toLowerCase() === "off" ? "" : `commons-entities+simple-icons${env.GEMINI_API_KEY || env.GOOGLE_API_KEY ? "+gemini-visual-check" : ""}`, images === "agy" ? "agy-images" : images === "gemini-image" ? "gemini-images" : ""].filter(Boolean).join("+");
      const notes = [script ? "" : "нет ANTHROPIC_API_KEY / входа Claude / GEMINI_API_KEY для сценария", trends ? "" : "нет agy и GEMINI_API_KEY — тренды пропускаются", images ? "" : "нет генератора картинок — только фото и типографика"].filter(Boolean);
      return { active, ready: script, note: notes.join("; ") };
    },
  },
  {
    id: "voice",
    stage: "design",
    title: "Голоса (озвучка)",
    what: "каталог голосов: Gemini TTS (облако, живая интонация, нужен GEMINI_API_KEY), Piper локально на CPU (запасной, $0) и пресеты Chatterbox для аватара",
    selector: "vedit voices; vedit make --voice <id>; vedit avatar export --voice <id>; Telegram /voice; произношение data/pronounce.ru.json + VEDIT_PRONOUNCE_DICT, VEDIT_TTS_TAKE=single|line, VEDIT_GEMINI_TTS_STYLE (doc), VEDIT_TTS_STRESS=1",
    backends: [
      { id: "piper", title: "Piper 2023.11.14-2 (rhasspy), бинарник + onnx-модели, скачиваются при первом использовании в tools/voice/", deps: "piper(.exe), espeak-ng-data, onnxruntime (в архиве релиза); ~22 МБ + ~60 МБ на голос", license: "MIT (Piper); espeak-ng GPL-3.0 — только как внешний процесс" },
      { id: "gemini-tts", title: "Gemini TTS (Google Gemini API): по одному запросу на бит, один стиль диктора на ролик, ретраи на 429, кэш workspace/_cache/tts/gemini", deps: "GEMINI_API_KEY (или GOOGLE_API_KEY); модели VEDIT_GEMINI_TTS_MODEL → gemini-3.8-flash-tts → 3.8-flash-lite-tts → 3.1-flash-tts-preview → 2.5-flash-preview-tts", license: "условия Gemini API: коммерческое использование озвучки разрешено; бесплатный уровень — данные могут использоваться Google, для продакшена платный (≈$9 / 1M аудио-токенов ≈ $0.02 за минуту речи)" },
      { id: "cloud-tts", title: "Google Cloud Text-to-Speech: Gemini-TTS (gemini_*, стиль диктора) и Chirp 3: HD (chirp_*), по запросу на бит, кэш workspace/_cache/tts/cloud; если есть оба ключа — берётся этот", deps: "GOOGLE_CLOUD_API_KEY (ключ Cloud Console с доступом к Cloud Text-to-Speech API, биллинг включён); модели VEDIT_CLOUD_TTS_MODEL → gemini-2.5-flash-tts → 2.5-pro-tts → 3.1-flash-tts-preview", license: "условия Google Cloud: коммерческое использование разрешено; Chirp 3 HD — 1 млн символов/мес бесплатно, далее $30 / 1M; Gemini-TTS — $0.50 / 1M токенов текста + $10 / 1M аудио-токенов (25 ток/с ≈ $0.015 за минуту), бесплатной квоты нет" },
      ...VOICES.map((v) => ({ id: `voice:${v.id}`, title: `${v.name} [${v.engine}, ${v.language}]`, deps: v.piper ? `huggingface rhasspy/piper-voices ${v.piper.key}` : v.engine === "chirp3" ? `Cloud TTS ru-RU-Chirp3-HD-${v.gemini?.voiceName}; без Cloud-ключа — Gemini API, без ключей — Piper ${v.fallback}` : v.gemini ? `Gemini-TTS ${v.gemini.voiceName} (Cloud TTS или Gemini API); без ключа — Piper ${v.fallback}` : v.refFrom ? `образец от Piper ${v.refFrom} + Chatterbox в Colab` : "Chatterbox в Colab", license: v.license })),
    ],
    step: "design",
    cost: (e) => /piper|gemini tts|cloud tts/i.test(e.provider),
    probe: async (env) => {
      const st = await piperStatus();
      const piper = `${st.binary ? "piper установлен" : "piper скачается при первом синтезе"}; голоса: ${st.models.join(", ") || "ещё не скачаны"}`;
      const cloud = !!cloudApiKey(env);
      const key = !!geminiApiKey(env);
      if (cloud) return { active: "cloud-tts+piper", ready: true, note: `Cloud TTS: ${cloudGeminiModels(env)[0]} + Chirp 3 HD${key ? "; Gemini API — запасной" : ""}; ${piper}` };
      return { active: key ? "gemini-tts+piper" : "piper", ready: true, note: key ? `Gemini: ${geminiTtsModels(env)[0]}; ${piper}` : `нет GOOGLE_CLOUD_API_KEY / GEMINI_API_KEY — gemini_*/chirp_* звучат голосом Piper; ${piper}` };
    },
  },
  {
    id: "avatar",
    stage: "source",
    title: "Говорящий аватар",
    what: "текст/тема → речь (клон голоса) → говорящее фото на Colab T4 → монтаж split_news; $0",
    selector: "vedit avatar export|import / Telegram /avatar; tools/avatar/colab_vedit_avatar.ipynb",
    backends: [
      { id: "chatterbox", title: "Речь: Chatterbox Multilingual (Resemble AI), 23 языка, клон голоса по 5–10 с", deps: "Colab: chatterbox-tts 0.1.7, torch 2.6 (отдельный venv)", license: "MIT; в речи неслышимый водяной знак Perth (Resemble AI)" },
      { id: "joyvasa", title: "Мимика и голова: JoyVASA (диффузия по звуку) + рендер LivePortrait", deps: "Colab: JoyVASA (git), веса jdh-algo/JoyVASA, KwaiVGI/LivePortrait, TencentGameMate/chinese-hubert-base; transformers 4.39", license: "MIT (код и веса JoyVASA, LivePortrait, chinese-hubert-base)" },
      { id: "insightface", title: "Детекция лица в LivePortrait: InsightFace buffalo_l (det_10g, 2d106det)", deps: "веса из KwaiVGI/LivePortrait", license: "ТОЛЬКО некоммерческое исследование — TODO до коммерческого запуска: заменить на MediaPipe Face Detection (Apache-2.0)" },
      { id: "colab", title: "GPU: Google Colab T4 (бесплатно)", deps: "аккаунт Google, браузер", license: "условия Google Colab; $0" },
      { id: "portrait", title: "Портрет вымышленного ведущего: Antigravity (как в make), или фото пользователя", deps: "agy + вход Google", license: "условия Antigravity; $0; реальных и известных людей не генерируем" },
      { id: "claude-script", title: "Монолог по теме: structured-вызов Claude или Gemini (prompts/avatar.script.*, VEDIT_LLM_AVATAR / VEDIT_LLM)", deps: "как планировщик", license: "как планировщик" },
    ],
    job: (j) => /avatar:/.test(j.source),
    probe: async (env) => {
      const script = !!llmPick("avatar", env);
      const agy = !!(await imageBackend(env));
      const notes = [agy ? "" : "без генератора картинок (agy / GEMINI_API_KEY) нужен --photo", script ? "" : "по теме — нет модели (Claude / Gemini), только --text", "InsightFace — некоммерческая лицензия"].filter(Boolean);
      return { active: "colab: chatterbox+joyvasa", ready: true, note: notes.join("; ") };
    },
  },
  {
    id: "bot",
    stage: "delivery",
    title: "Telegram-бот",
    what: "кнопки и меню на ru/uz/en: монтаж, ролик по теме, хайлайты, аватар, настройки, баланс; карточка прогресса с отменой; результат с «ещё вариант / поправить / другой формат / оценка»; команды /make, /viral, /revise, /voice, /send, /style, /avatar остаются",
    selector: "npm run bot; TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS (закрытая бета, иначе открытая регистрация), TELEGRAM_ADMIN_IDS, TELEGRAM_API_BASE",
    backends: [{ id: "telegram", title: "Bot API (fetch, без зависимостей): inline-кнопки, callback_query, editMessageText", deps: "—", license: "условия Telegram Bot API" }],
    job: (j) => BOT_SOURCE.test(j.source),
    probe: async (env) => {
      const token = !!env.TELEGRAM_BOT_TOKEN?.trim();
      return { active: "telegram", ready: token, note: token ? (env.TELEGRAM_ALLOWED_USERS?.trim() ? "закрытая бета (белый список)" : "открытая регистрация") : "нет TELEGRAM_BOT_TOKEN" };
    },
  },
  {
    id: "dub",
    stage: "delivery",
    title: "Перевод и озвучка — «Русская версия» (этап 30)",
    what: "речь → фразы → перевод с бюджетом символов на фразу → TTS пачками по N фраз → каждая фраза на своём месте (ресинхронизация на каждой фразе, заход в паузу, ускорение ≤ 1.25×, одно сокращение) → оригинал −18 дБ под переводом, субтитры на языке перевода; метка «Неофициальный перевод», без клонирования чужого голоса",
    selector: "vedit dub <задача|видео> --lang ru --voice gemini_charon [--mode voiceover|replace] [--full]; бот: 🌐 Русская версия, 🌐 Озвучить на русском; VEDIT_DUB_BATCH (12), VEDIT_DUB_CHUNK (60), VEDIT_DUB_SHORTEN_MAX (12)",
    backends: [
      { id: "translate", title: "Structured-вызов Claude или Gemini (VEDIT_LLM_TRANSLATE / VEDIT_LLM), кэш dub_translations_<lang>.json + общий с субтитрами translations_<lang>.json", deps: "как планировщик", license: "как планировщик" },
      { id: "tts", title: "Голоса каталога: Gemini TTS / Cloud TTS (одна запись на пачку фраз, кэш) или Piper", deps: "как модуль voice", license: "как модуль voice" },
      { id: "ffmpeg", title: "atempo (ускорение без смены тона), автоматизация громкости оригинала, mov_text-субтитры", deps: "ffmpeg", license: "LGPL-2.1+" },
    ],
    cost: (e) => /\(dub/.test(e.provider),
    job: (j) => j.preset === "dub",
    probe: async (env) => {
      const pick = llmPick("translate", env);
      const key = !!(geminiApiKey(env) || cloudApiKey(env));
      return { active: key ? "llm + gemini-tts" : "llm + piper", ready: !!pick, note: pick ? (key ? "" : "нет ключа Google — озвучка голосом Piper") : "нет модели для перевода (GEMINI_API_KEY или ANTHROPIC_API_KEY)" };
    },
  },
  {
    id: "users",
    stage: "delivery",
    title: "Пользователи, лимиты, очередь (этап 19)",
    what: "регистрация (язык → цель → условия), настройки и сессии в SQLite, бесплатный тариф и кредиты, общая очередь задач с честным порядком и отменой, админка, рассылка, очистка старых файлов",
    selector: "VEDIT_MAX_JOBS, VEDIT_RETENTION_DAYS, VEDIT_FREE_*, VEDIT_TRIAL_CREDITS, VEDIT_CREDITS_*, VEDIT_LONG_MINUTES, VEDIT_TZ_OFFSET; живые лимиты — /admin → ⚙️ Лимиты",
    backends: [
      { id: "sqlite", title: "node:sqlite (встроен в Node 24, без нативных зависимостей) — workspace/_bot/vedit.db: users, settings, sessions, jobs, usage, kv, callbacks, migrations", deps: "Node.js ≥ 22.13", license: "MIT (Node.js; SQLite — public domain)" },
      { id: "legal", title: "Условия и политика конфиденциальности (черновики для юриста) — docs/legal/{terms,privacy}.{ru,uz,en}.md", deps: "—", license: "свой текст" },
    ],
    probe: async (env) => {
      let ok = true;
      let note = "";
      try {
        await import("node:sqlite");
      } catch (err) {
        ok = false;
        note = `node:sqlite недоступен: ${err instanceof Error ? err.message : err}`;
      }
      const admins = (env.TELEGRAM_ADMIN_IDS ?? env.TELEGRAM_ALLOWED_USERS ?? "").trim();
      if (ok && !admins) note = "нет TELEGRAM_ADMIN_IDS — админка недоступна";
      return { active: "sqlite", ready: ok, note };
    },
  },
  {
    id: "feedback",
    stage: "delivery",
    title: "Оценки и самопроверка ИИ (этап 28)",
    what: "после ⭐ бот спрашивает «почему» (причины-кнопки, текст или голосовое), в фоне Gemini смотрит каждый готовый ролик и ставит оценки 1–5 по хуку, картинкам, темпу, субтитрам, звуку, тексту + 3 правки; админка «📊 Оценки» и `vedit feedback report` сводят оценки людей и критика, расхождения ≥ 2",
    selector: "VEDIT_SELF_REVIEW=on|off (по умолчанию on), VEDIT_REVIEW_MODEL, VEDIT_SELF_REVIEW_MAX, VEDIT_REVIEW_FPS, VEDIT_REVIEW_RESOLUTION; голосовой отзыв — whisper.cpp",
    backends: [
      { id: "gemini-review", title: "Gemini API: копия 480p ≤ 180 с, 1 кадр/с, Files API (удаляется сразу), JSON-оценки по критериям docs/reference-reels-analysis.md; кэш workspace/_cache/review/<хэш>.json; квота → пауза 1 ч", deps: "GEMINI_API_KEY; модели gemini-3.5-flash-lite → 3.6-flash → flash-lite-latest", license: "условия Gemini API (бесплатный уровень: данные могут использоваться Google); ≈ $0.003 за ролик 35–45 с" },
      { id: "sqlite-feedback", title: "workspace/_bot/vedit.db: outputs, feedback (одна запись на задачу/ролик/пользователя), self_review", deps: "node:sqlite", license: "MIT / public domain" },
    ],
    probe: async (env) => {
      const on = !/^(off|0|false|no)$/i.test(env.VEDIT_SELF_REVIEW?.trim() ?? "");
      const key = !!(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
      return { active: on ? "gemini-review" : "выкл.", ready: true, note: on ? (key ? "" : "нет GEMINI_API_KEY — самопроверка пропускается, оценки людей пишутся") : "VEDIT_SELF_REVIEW=off" };
    },
  },
  {
    id: "cli",
    stage: "delivery",
    title: "CLI и batch",
    what: "vedit run/plan/revise/render, batch по папке",
    selector: "всегда",
    backends: [{ id: "commander", title: "commander", deps: "commander", license: "MIT" }],
    job: (j) => !BOT_SOURCE.test(j.source) && !/(make|avatar):/.test(j.source),
    probe: async () => ({ active: "commander", ready: true, note: "" }),
  },
];

// ---- presets: the house styles the planner and the design stage follow ----

export interface PresetEntry {
  name: string;
  /** presets/<name>.json, or built-in when the file is missing */
  source: "file" | "builtin";
  file?: string;
  pace: Preset["pace"];
  clip_seconds: Preset["clip_seconds"];
  default_aspect: Preset["default_aspect"];
  caption_style: string;
  title_style: string;
  outro: boolean;
  description: string;
  /** a file that does not parse is listed with its error instead of hiding it */
  error?: string;
}

export async function presetsCatalog(dir = PRESETS_DIR): Promise<PresetEntry[]> {
  const names = new Map<string, string | null>(Object.keys(BUILTIN_PRESETS).map((n) => [n, null]));
  try {
    for (const f of await fs.readdir(dir)) if (f.endsWith(".json")) names.set(f.slice(0, -5), path.join(dir, f));
  } catch {}
  const out: PresetEntry[] = [];
  for (const [name, file] of [...names.entries()].sort()) {
    try {
      const p = file ? await readJson(file, PresetSchema) : BUILTIN_PRESETS[name];
      out.push({ name, source: file ? "file" : "builtin", ...(file ? { file } : {}), pace: p.pace, clip_seconds: p.clip_seconds, default_aspect: p.default_aspect, caption_style: p.caption_style, title_style: p.title_style, outro: p.design.outro.enabled, description: p.description });
    } catch (err) {
      out.push({ name, source: "file", file: file ?? undefined, pace: "dynamic", clip_seconds: { min: 0, max: 0 }, default_aspect: "9:16", caption_style: "?", title_style: "?", outro: false, description: "", error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
    }
  }
  return out;
}

// ---- limits: every number that bounds a run, with where it is set ----

export interface LimitEntry {
  id: string;
  module: string;
  what: string;
  value: string;
  default: string;
  /** "env VEDIT_X" when overridden from the environment, "flag --x" when a flag exists, else "код" */
  set_by: string;
}

export function limitsCatalog(env: NodeJS.ProcessEnv = process.env): LimitEntry[] {
  const out: LimitEntry[] = [];
  let budget: Budget;
  let budgetError: string | undefined;
  try {
    budget = budgetFromEnv(env);
  } catch (err) {
    budget = DEFAULT_BUDGET;
    budgetError = err instanceof Error ? err.message : String(err);
  }
  const flag: Partial<Record<keyof Budget, string>> = { maxUsd: "--budget", maxRepairs: "--max-repairs", frameBudget: "--frames" };
  for (const key of Object.keys(BUDGET_ENV) as (keyof Budget)[]) {
    const meta = BUDGET_ENV[key];
    const show = (v: number) => (key === "maxWallMs" ? `${v / 1000} ${meta.unit}` : `${meta.unit === "$" ? "$" : ""}${v}${meta.unit === "$" ? "" : ` ${meta.unit}`}`);
    const overridden = !!env[meta.env]?.trim();
    out.push({ id: `budget.${key}`, module: "planner", what: meta.what, value: budgetError && overridden ? `✖ ${budgetError}` : show(budget[key]), default: show(DEFAULT_BUDGET[key]), set_by: overridden ? `env ${meta.env}` : flag[key] ? `${flag[key]} / env ${meta.env}` : `env ${meta.env}` });
  }
  const fixed = (id: string, module: string, what: string, value: string, set_by = "код") => out.push({ id, module, what, value, default: value, set_by });
  fixed("planner.model", "planner", "модель планировщика", env.VEDIT_PLANNER_MODEL?.trim() || DEFAULT_MODEL, env.VEDIT_PLANNER_MODEL?.trim() ? "env VEDIT_PLANNER_MODEL" : "--model / env VEDIT_PLANNER_MODEL");
  fixed("planner.gemini_model", "planner", "модель планировщика на Gemini (бэкенд gemini)", plannerModels(env).join(" → "), "env VEDIT_GEMINI_PLANNER_MODEL");
  fixed("llm.gemini_model", "make", "модель Gemini для сценария, арт-директора, перевода, шортлиста", textModels(env).join(" → "), "env VEDIT_GEMINI_LLM_MODEL");
  fixed("llm.provider", "planner", "провайдер LLM-шагов", (() => { try { const p = resolveLlmProvider(undefined, env); return `${p.provider}${p.fallback ? " (+ запаска gemini)" : ""}`; } catch { return "—"; } })(), "env VEDIT_LLM / VEDIT_LLM_<ШАГ>, VEDIT_LLM_FALLBACK");
  fixed("planner.compact_above_tokens", "planner", "пак сжимается выше, токенов", String(COMPACT_ABOVE_TOKENS));
  fixed("planner.max_highlights", "planner", "highlights в паке, не больше", String(MAX_HIGHLIGHTS));
  fixed("planner.min_gap", "planner", "пауза считается разрезом от, с", String(MIN_GAP));
  fixed("shortlist.long_phrases", "shortlist", "длинное видео от, фраз", String(LONG_PHRASES), "--long / --no-long");
  fixed("shortlist.long_tokens", "shortlist", "длинное видео от, токенов пака", String(LONG_TOKENS), "--long / --no-long");
  fixed("shortlist.max_windows", "shortlist", "окон-кандидатов, не больше", String(DEFAULT_MAX_WINDOWS), "--windows");
  fixed("vision.model", "vision", "модель понимания кадра", env.VEDIT_VISION_MODEL?.trim() || `${DEFAULT_GEMINI_MODEL} (API) / ${DEFAULT_AGY_MODEL} (agy)`, env.VEDIT_VISION_MODEL?.trim() ? "env VEDIT_VISION_MODEL" : "env VEDIT_VISION_MODEL");
  fixed("vision.chunk_seconds", "vision", "чанк анализа, с (цель / максимум)", "180 / 300");
  fixed("scenes.threshold", "scenes", "порог смены шота", String(DEFAULT_SCENE_THRESHOLD));
  fixed("asr.chunk_seconds", "asr", "кусок речи для whisper.cpp, с", "28");
  fixed("ingest.fps", "ingest", "кадров в секунду после нормализации", String(TARGET_FPS));
  fixed("render.worker_mb", "render", "памяти на воркер рендера, МБ (резерв системе)", `${WORKER_MB} (${RESERVE_MB})`, "--workers");
  fixed("bot.file_mb", "bot", "файл от пользователя / ответ бота, МБ", env.TELEGRAM_API_BASE?.trim() ? "2000 / 2000 (локальный Bot API)" : "20 / 50", "env TELEGRAM_API_BASE");
  // stage 19: free plan, queue, retention (a bad value is shown as an error, like the budget)
  const num = (fn: () => number) => {
    try {
      return String(fn());
    } catch (err) {
      return `✖ ${err instanceof Error ? err.message : err}`;
    }
  };
  for (const f of FREE_PLAN_FIELDS) {
    const overridden = !!env[f.env]?.trim();
    out.push({ id: `users.free.${f.key}`, module: "users", what: f.what, value: num(() => freePlanFromEnv(env)[f.key]), default: String(f.default), set_by: overridden ? `env ${f.env}` : `env ${f.env} / /admin → Лимиты` });
  }
  out.push({ id: "users.max_jobs", module: "users", what: "задач одновременно (общая очередь)", value: num(() => maxJobsFromEnv(env)), default: "1 при < 12 ГБ RAM или VEDIT_SERVER=1, иначе 2", set_by: "env VEDIT_MAX_JOBS" });
  out.push({ id: "users.per_user", module: "users", what: "на пользователя: в работе / в очереди", value: `${PER_USER_RUNNING} / ${PER_USER_QUEUED}`, default: `${PER_USER_RUNNING} / ${PER_USER_QUEUED}`, set_by: "код" });
  out.push({ id: "users.user_daily_jobs", module: "users", what: "задач на пользователя в день, жёсткий потолок (0 = нет)", value: num(() => userDailyJobsFromEnv(env)), default: "10", set_by: "env VEDIT_USER_DAILY_JOBS" });
  out.push({ id: "users.budget_daily_usd", module: "users", what: "общий бюджет API в день, $ — выше новые задачи не принимаются (0 = нет)", value: num(() => dailyBudgetUsdFromEnv(env)), default: "10", set_by: "env VEDIT_BUDGET_DAILY_USD" });
  out.push({ id: "users.retention_days", module: "users", what: "хранение загрузок и готовых задач, дней", value: num(() => retentionDaysFromEnv(env)), default: "7", set_by: "env VEDIT_RETENTION_DAYS" });
  out.push({ id: "users.tz_offset", module: "users", what: "граница суток для дневных лимитов, UTC+ч", value: num(() => tzOffsetFromEnv(env)), default: "5", set_by: "env VEDIT_TZ_OFFSET" });
  return out;
}

export interface ModuleUsage {
  runs: number;
  ok: number;
  failed: number;
  usd: number;
  last?: string;
}

export interface ModuleStatus {
  id: string;
  stage: string;
  title: string;
  active: string;
  ready: boolean;
  note: string;
  usage: ModuleUsage;
}

/** Usage per module over the jobs in the workspace created in the last `days` days. */
export async function moduleUsage(days = 30, root = WORKSPACE_ROOT): Promise<Map<string, ModuleUsage>> {
  const since = Date.now() - days * 86_400_000;
  const usage = new Map<string, ModuleUsage>(MODULES.map((m) => [m.id, { runs: 0, ok: 0, failed: 0, usd: 0 }]));
  let names: string[] = [];
  try {
    names = (await fs.readdir(root)).filter((n) => /^\d{8}-[0-9a-f]+$/.test(n));
  } catch {
    return usage;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    let job: Job;
    try {
      job = await readJson(path.join(dir, "job.json"), JobSchema);
    } catch {
      continue;
    }
    if (new Date(job.created_at).getTime() < since) continue;
    const costFile = path.join(dir, "cost.json");
    const cost: Cost = (await exists(costFile)) ? await readJson(costFile, CostSchema).catch(() => ({ total_usd: 0, entries: [] })) : { total_usd: 0, entries: [] };
    for (const m of MODULES) {
      const u = usage.get(m.id)!;
      const bump = (status: string | undefined, at: string | undefined) => {
        u.runs++;
        if (status === "ok") u.ok++;
        else if (status === "failed") u.failed++;
        if (at && (!u.last || at > u.last)) u.last = at;
      };
      if (m.job) {
        if (m.job(job)) bump(job.steps.ingest?.status, job.created_at);
      } else if (m.step) {
        const st = job.steps[m.step];
        const entries = m.cost ? cost.entries.filter(m.cost) : [];
        // a module with its own cost entries counts a run only when it actually produced one (e.g. shortlist, translate)
        if (st && (!m.cost || entries.length || m.id === "asr" || m.id === "vision")) bump(st.status, st.finished_at ?? st.started_at);
        for (const e of entries) u.usd += e.usd;
      }
    }
  }
  return usage;
}

export interface Registry {
  modules: ModuleStatus[];
  presets: PresetEntry[];
  limits: LimitEntry[];
  prompts: { files: string[]; hash: string };
}

export async function moduleStatus(opts: { days?: number; env?: NodeJS.ProcessEnv; root?: string; presetsDir?: string } = {}): Promise<Registry> {
  const env = opts.env ?? process.env;
  const usage = await moduleUsage(opts.days ?? 30, opts.root);
  const modules = await Promise.all(
    MODULES.map(async (m) => {
      const p = await m.probe(env).catch((err) => ({ active: "?", ready: false, note: err instanceof Error ? err.message : String(err) }));
      return { id: m.id, stage: m.stage, title: m.title, ...p, usage: usage.get(m.id)! };
    }),
  );
  return { modules, presets: await presetsCatalog(opts.presetsDir), limits: limitsCatalog(env), prompts: { files: promptNames(), hash: promptsHash() } };
}

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "─".repeat(w))), ...rows.map(line)];
}

export function formatModules(s: Registry, days: number): string {
  const modules = table(
    ["модуль", "этап", "бэкенд", "готов", `запусков/${days}д`, "стоимость", "последний", "примечание"],
    s.modules.map((m) => [m.id, m.stage, m.active, m.ready ? "✔" : "✖", `${m.usage.runs}${m.usage.failed ? ` (${m.usage.failed} ✖)` : ""}`, m.usage.usd ? `$${m.usage.usd.toFixed(2)}` : "—", m.usage.last ? m.usage.last.slice(0, 10) : "—", m.note]),
  );
  const presets = table(
    ["пресет", "откуда", "темп", "клип, с", "формат", "субтитры", "титры", "аутро", "описание"],
    s.presets.map((p) => [p.name, p.source === "file" ? "presets/" : "встроенный", p.pace, `${p.clip_seconds.min}–${p.clip_seconds.max}`, p.default_aspect, p.caption_style, p.title_style, p.outro ? "да" : "нет", p.error ? `✖ ${p.error}` : p.description]),
  );
  const limits = table(["лимит", "модуль", "что", "значение", "по умолчанию", "задаётся"], s.limits.map((l) => [l.id, l.module, l.what, l.value, l.default, l.set_by]));
  return [...modules, "", "ПРЕСЕТЫ", ...presets, "", "ЛИМИТЫ", ...limits, "", `промпты: ${s.prompts.files.length} файлов в prompts/, версия ${s.prompts.hash}`].join("\n");
}
