// Every user-facing string of the bot in three languages: Russian, Uzbek (Latin script), English.
// `ru` defines the shape; `uz` and `en` are typed against it, so a missing key is a compile error, and
// tests/stage19-users.test.ts walks all three tables (no empty strings, same function arity).
import { autoVoice, GEMINI_LICENSE_NOTE, isCloud, isLocal, piperVoiceFor, voicesListText, type VoiceDef } from "../voice/catalog.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { cloudApiKey } from "../voice/cloudtts.ts";
import { TTS_KEYS_HELP } from "../voice/piper.ts";
import type { Lang } from "./db.ts";
import { CP_EN, CP_RU, CP_UZ } from "./i18n-cp.ts";

export type { Lang } from "./db.ts";

/** a Google TTS key (Cloud TTS or Gemini API) is configured */
export const hasGoogleTtsKey = () => !!(cloudApiKey() || geminiApiKey());

export type SendMode = "file" | "video" | "both";
export interface SettingsView {
  aspect: string;
  style: string;
  voice: string;
  send: SendMode;
  lang: Lang;
  news: boolean;
}
export interface BalanceView {
  plan: string;
  credits: number;
  usedStd: number;
  std: number;
  usedLong: number;
  long: number;
  cs: number;
  cl: number;
  longMinutes: number;
  admin: boolean;
}
export interface StatsView {
  users: number;
  usersToday: number;
  activeToday: number;
  banned: number;
  byStatus: { status: string; n: number }[];
  byKind: { kind: string; n: number }[];
  costToday: number;
  cost7d: number;
  ratingAvg: number | null;
  ratings: number;
  running: number;
  queued: number;
  maxJobs: number;
}
export interface UserCardView {
  id: number;
  username: string | null;
  name: string | null;
  lang: string;
  purpose: string | null;
  status: string;
  role: string;
  credits: number;
  plan: string;
  created: string;
  lastSeen: string | null;
  jobs: number;
  done: number;
  failed: number;
  cost: number;
  todayStd: number;
  todayLong: number;
}

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const LANG_NAMES: Record<Lang, string> = { ru: "Русский", uz: "O‘zbekcha", en: "English" };

const ru = {
  langPrompt: "Выберите язык · Tilni tanlang · Choose your language",
  langName: LANG_NAMES.ru,
  intro: "Привет! Я ИИ-монтажёр: делаю короткие ролики из ваших видео, ролики по теме с озвучкой, хайлайты игр и говорящих аватаров. Всё — прямо в Telegram, кнопками.",
  askPurpose: "Для чего вам ролики? Так я подберу настройки.",
  purpose: { blog: "Блог / контент", biz: "Бизнес / реклама", sport: "Спорт", other: "Другое" },
  terms: (days: number) =>
    [
      "Перед началом — условия и конфиденциальность. Коротко:",
      "• храним ваш Telegram id, имя, язык и настройки;",
      `• загруженные видео и готовые ролики удаляются через ${days} дн.;`,
      "• для обработки используются сервисы Anthropic (Claude), Google (Gemini) и Openverse (фото и музыка);",
      "• нельзя присылать незаконный контент и чужие видео без разрешения; ролики с YouTube, TikTok, Instagram — только с правами или для обзора, цитаты, обучения (бот попросит подтвердить);",
      "• переводы с озвучкой помечаются «Неофициальный перевод»; чужие голоса не клонируем;",
      "• права на ваши видео и ролики остаются у вас.",
      "",
      "Полные тексты — кнопками ниже.",
    ].join("\n"),
  btnTerms: "📄 Условия",
  btnPrivacy: "🔒 Конфиденциальность",
  btnAccept: "✅ Принимаю",
  welcome: (credits: number, std: number, long: number, longMinutes: number) =>
    `Готово, вы зарегистрированы! Пробных кредитов: ${credits}. Бесплатно каждый день: ${std} обычн. задачи и ${long} длинная (видео дольше ${longMinutes} минут или хайлайты игры).\nВыберите, что сделать, — кнопки внизу.`,
  menuText: "Главное меню — выберите, что сделать:",
  menu: { montage: "🎬 Монтаж из моих видео", ref: "🎯 Монтаж как в примере", make: "✨ Ролик по теме", highlights: "🏀 Хайлайты игры", plan: "🗓 Контент-план", avatar: "🧑 Аватар", settings: "⚙️ Настройки", balance: "💳 Баланс", help: "❓ Помощь", guide: "📘 Как пользоваться" },
  needStart: "Сначала закончим регистрацию — это пара нажатий. /start",
  banned: "Доступ к боту ограничен. Если это ошибка — напишите администратору.",
  docMissing: "Текст пока недоступен.",
  help: [
    "Я делаю короткие ролики: монтирую ваши видео, делаю ролики по теме с озвучкой, хайлайты игр и говорящих аватаров.",
    "",
    "Кнопки внизу:",
    "🎬 Монтаж — пришлите видео (до 20 МБ; можно несколько или альбомом; больше — ссылкой на Google Диск, Яндекс Диск, Dropbox или YouTube), выберите, что сделать, и нажмите «▶️ Начать». Или просто напишите задачу: «3 рилса по 30 секунд, субтитры на узбекском».",
    "✨ Ролик по теме — напишите тему, выберите формат и голос.",
    "🏀 Хайлайты — видео игры → лучшие моменты с замедлением и музыкой; «по отдельности» — ролик на каждого игрока.",
    "🧑 Аватар — фото и голосовое → говорящий ведущий (через бесплатный Google Colab).",
    "🔗 Ссылка на YouTube / TikTok / Instagram (подкаст, интервью, фильм) — нарезка лучших моментов, «смонтировать мой ролик так же», 🌐 русская версия (перевод и озвучка) или аватар по сценарию. Чужие видео — только с правами или для обзора, цитаты, обучения.",
    "⚙️ Настройки — формат, стиль, голос, как присылать ролики, язык.",
    "💳 Баланс — лимиты и кредиты.",
    "",
    "Команды (то же, что кнопки):",
    "/make <тема> — ролик по теме; /make 16:9 тема — для YouTube",
    "/viral — один самый вирусный ролик из всех присланных видео; /clear — новая подборка",
    "/revise <что изменить> — правка последнего монтажа (перережу и перерендерю только затронутое)",
    "/style pop | clean | box | split | calm — стиль монтажа",
    "/voice — голоса для озвучки: /voice gemini_charon — выбрать (пришлю пробу), /voice off — без голоса",
    "/send file | video | both — как присылать ролики: файлом в исходном качестве (по умолчанию), видео с плеером или и так и так",
    "/avatar <текст или тема> — говорящий аватар; готовый avatar_result.zip пришлите сюда",
    "/status — что сейчас делается; /cancel — отменить",
    "/start — меню",
  ].join("\n"),
  unknownCommand: "Не знаю такой команды. /help — справка.",
  noJob: "Пока нет задач. Пришлите видео или выберите действие в меню.",

  refAsk: (mb: number) => `Пришлите пример — рилс, который нравится, файлом (до ${mb} МБ) или ссылкой (Instagram, TikTok, YouTube Shorts). Я разберу его монтаж: темп, паузы, субтитры, наезды, звук и цвет — и смонтирую ваше видео так же. Сам пример в ваш ролик не попадёт.`,
  refAnalyzing: "🔎 Разбираю монтаж примера… (обычно до минуты)",
  refReady: (summary: string, cached: boolean) => `🎯 Стиль примера${cached ? " (уже знаком)" : ""}: ${summary}

Теперь пришлите своё видео — одно или несколько. Смонтирую в этом стиле.`,
  refLinkFailed: "Не получилось скачать ролик по ссылке (Instagram часто требует вход). Пришлите сам ролик файлом.",
  refFailed: "Не получилось разобрать пример. Попробуйте другой ролик или пришлите его файлом.",
  refNeedFileOrLink: "Жду пример: видеофайл или ссылку на рилс.",
  refBusy: "Ещё разбираю предыдущий пример — минутку.",
  styleRef: "🎯 Как в примере",
  montageAsk: (mb: number) => `Пришлите видео — одно или несколько (до ${mb} МБ каждое, можно альбомом). Видео больше — пришлите ссылкой: Google Диск, Яндекс Диск, Dropbox или YouTube. Потом выберите, что сделать.`,
  highlightsAsk: (mb: number) => `Пришлите видео игры или тренировки (до ${mb} МБ; больше — ссылкой на Google Диск, Яндекс Диск или YouTube). Найду лучшие моменты, сделаю замедления и наложу музыку по битам.`,
  needVideo: "Сначала пришлите видео (как видео или файлом), потом напишите задачу.",
  notVideo: "Это не похоже на видео. Пришлите ролик как видео или файлом с типом video/*.",
  videoSaved: "Видео получено. Выберите, что сделать, и нажмите «▶️ Начать» — или напишите задачу своими словами (например, «2 рилса по 20 секунд с субтитрами»).",
  batchSaved: (n: number) => `Получено видео: ${n}. По умолчанию склею их в один ролик — выберите настройки и нажмите «▶️ Начать» (или напишите задачу словами). Можно дослать ещё видео; /clear — начать подборку заново.`,
  cleared: "Подборка очищена. Пришлите новые видео.",
  tooLarge: (sizeMb: number, limitMb: number, byTelegram: boolean) =>
    `${sizeMb > limitMb ? `Файл ${sizeMb} МБ` : `Файл больше ${limitMb} МБ`}, а ${byTelegram ? "Telegram даёт боту скачивать файлы только" : "на вашем тарифе файл можно прислать"} до ${limitMb} МБ — пришлите ссылку на видео (Google Диск / Яндекс Диск / Dropbox / YouTube) или сожмите видео. Ссылку просто вставьте сообщением.`,
  linkStart: "⬇️ Скачиваю видео по ссылке…",
  linkProgress: (mb: number, totalMb: number) => `⬇️ Скачиваю видео по ссылке… ${mb} МБ${totalMb ? ` из ${totalMb} МБ` : ""}`,
  linkDone: (n: number, mb: number) => `✅ Скачано по ссылке: ${n > 1 ? `${n} видео, ` : ""}${mb} МБ`,
  linkTooBig: (sizeMb: number, maxMb: number) => `✖ Видео по ссылке слишком большое${sizeMb ? `: ${sizeMb} МБ` : ""} — можно до ${maxMb} МБ. Обрежьте или сожмите его и пришлите снова.`,
  linkPrivate: "✖ Ссылка закрыта. Откройте доступ «всем, у кого есть ссылка» (Google Диск: Поделиться → Общий доступ) и пришлите её снова.",
  linkFolder: "✖ Это ссылка на папку. Пришлите ссылку на сам видеофайл (папку Яндекс Диска можно — возьму все видео из неё).",
  linkNotVideo: "✖ По ссылке не видео (или веб-страница, а не файл). Пришлите ссылку на видеофайл или само видео.",
  linkNoYtdlp: "✖ Ссылки YouTube / Instagram / TikTok сейчас не скачиваются. Пришлите ссылку Google Диска, Яндекс Диска или Dropbox — или само видео.",
  linkFailed: "✖ Не получилось скачать видео по ссылке. Проверьте, что она открывается без входа в аккаунт, и пришлите снова — или отправьте видео файлом.",
  linkTimeout: "✖ Видео по ссылке скачивалось слишком долго. Попробуйте ещё раз или пришлите файл поменьше.",
  linkCancelled: "Загрузка по ссылке отменена.",
  btnCancelDownload: "🛑 Отменить загрузку",
  uploadFailed: "✖ Не получилось получить файл из Telegram. Пришлите его ещё раз.",
  photoInMontage: "Фото в монтаж пока не добавляю — пришлите видео. Фото для аватара — в меню «🧑 Аватар».",
  cardStale: "Эта карточка уже использована — нажмите ▶️ на последней.",
  uploadsPending: "⏳ Ещё загружаю видео — начну сразу после загрузки.",
  tooLargeAdmin:
    "Варианты: сожмите видео или обрежьте лишнее; либо запустите локальный сервер Bot API (github.com/tdlib/telegram-bot-api, флаг --local) и укажите TELEGRAM_API_BASE=http://localhost:8081 — тогда лимит 2000 МБ.",
  mode: { reels: "Рилсы из лучших моментов", viral: "Один вирусный ролик", hl: "Хайлайты", pp: "По отдельности на каждого" },
  countLabel: (n: number) => `${n} шт`,
  secondsLabel: (n: number) => `${n} с`,
  styleNames: { bold_pop: "Динамичный", clean_min: "Чистые (как у экспертов)", box_reveal: "Плашка с подсветкой", split_news: "Сплит", explainer: "Эксплейнер (светлая студия)", abror_split: "Аброр (сплит)", abror_full: "Аброр (весь кадр)", calm: "Спокойный" } as Record<string, string>,
  btnStart: "▶️ Начать",

  makeAskTopic: "Напишите тему ролика — например «почему кофе дорожает в 2026».",
  makeCard: (topic: string) => `Тема: «${topic}»\nВыберите формат и голос (▶️ — проба голоса) и нажмите «Начать».`,
  voiceAuto: "Авто",
  voiceNone: "Без голоса",
  makeUsage: "Напишите тему: /make почему кофе дорожает в 2026",
  avatarMenu:
    "Говорящий аватар: пришлите фото (лицо анфас) и, по желанию, голосовое 5–10 с — аватар будет с вашим лицом и голосом; без них — вымышленный ведущий.\nЗатем напишите текст или тему следующим сообщением.",
  btnAvatarReset: "Забыть фото и голос",
  avatarUsage: "Напишите текст или тему: /avatar почему кофе дорожает (тема — монолог напишу сам) или /avatar текст: Привет! Сегодня расскажу… Фото и голосовое для аватара можно прислать заранее; /avatar сброс — забыть их.",
  avatarStart: (photo: boolean, voice: boolean, voiceId?: string) =>
    `Готовлю задание для аватара: ${photo ? "ваше фото" : "вымышленный ведущий (сгенерирую портрет)"}, ${voice ? "ваш голос (клон)" : voiceId ? `голос ${voiceId}` : "стандартный голос"}. Это 1–3 минуты.`,
  avatarPhotoSaved: "Фото сохранено для аватара. Теперь /avatar <текст или тема> — или просто напишите текст после кнопки «🧑 Аватар».",
  avatarVoiceSaved: "Голос сохранён: аватар будет говорить им (нужно 5–10 с чистой речи на языке текста). Теперь /avatar <текст или тема>.",
  avatarReset: "Фото и голос для аватара забыты.",
  avatarNoJob: "Не нашёл задачу для этого архива: сначала /avatar <текст>, затем пришлите avatar_result.zip из Colab.",
  avatarImportStart: (jobId: string) => `Принял avatar_result.zip (задача ${jobId}). Монтирую рилс: аватар снизу, картинки сверху, субтитры, музыка.`,
  avatarInstructions: (jobId: string, lines: string[], warnings: string[]) =>
    [
      `Задание для аватара готово (задача ${jobId}) — файл avatar_job.zip выше.`,
      "",
      "Как получить видео (бесплатно, Google Colab):",
      "1. Откройте ноутбук colab_vedit_avatar.ipynb (из папки tools/avatar проекта) в colab.research.google.com → File → Upload notebook.",
      "2. Runtime → Change runtime type → T4 GPU, затем Runtime → Run all.",
      "3. В ячейке «Загрузка» выберите avatar_job.zip.",
      "4. Первый запуск ~10 минут (установка и модели), потом 2–5 минут.",
      "5. Скачается avatar_result.zip — пришлите его сюда документом, я смонтирую рилс.",
      ...(lines.length ? ["", "Текст:", ...lines.slice(0, 8).map((l, i) => `${i + 1}. ${l}`), ...(lines.length > 8 ? [`… ещё ${lines.length - 8}`] : [])] : []),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n"),

  voiceList: (current?: string, hasKey = hasGoogleTtsKey()) =>
    [
      `Голоса для озвучки (${current === "off" ? "сейчас без голоса" : current ? `сейчас: ${current}` : `сейчас: авто — ${autoVoice("ru", hasKey).id}`}):`,
      voicesListText(current),
      "",
      "/voice <id> — выбрать (пришлю пробу), /voice off — без голоса.",
      `gemini_* и chirp_* — живые голоса Google (облако; нужен ключ GOOGLE_CLOUD_API_KEY или GEMINI_API_KEY${hasKey ? " — есть" : " — пока нет, вместо них звучит Piper"}); они озвучивают и /make, и /avatar. ${GEMINI_LICENSE_NOTE}`,
      "Piper-голоса (denis, dmitri, ljspeech, john, cori) — локально, без ключа; chatterbox_* — только в /avatar (синтез в Colab).",
      "Без выбора /make озвучивается автоматически: Gemini, если есть ключ, иначе Piper.",
      "Ваше голосовое сообщение для /avatar важнее выбранного голоса.",
    ].join("\n"),
  voiceSet: (v: VoiceDef, hasKey = hasGoogleTtsKey()) =>
    `Голос: ${v.id} — ${v.name}. Лицензия: ${v.license}.
${
      isCloud(v) && !hasKey
        ? `Ключа Google пока нет — до его появления /make и /avatar озвучит Piper ${piperVoiceFor(v)?.id}.
${TTS_KEYS_HELP}`
        : isLocal(v)
          ? "Им будут озвучены /make и /avatar."
          : "Им будет говорить /avatar (Colab); для /make возьму локальный " + (piperVoiceFor(v)?.id ?? "голос по языку") + "."
    }`,
  voiceOff: "Озвучка выключена: /make снова без голоса, /avatar — стандартный голос Chatterbox (или ваше голосовое).",
  voiceUnknown: (id: string) => `Не знаю голос «${id}». /voice — список.`,
  voicePick: "Выберите голос (▶️ — проба):",
  voiceChosen: (name: string) => `Голос: ${name}`,
  sampleCaption: (id: string, forId?: string) => `проба: ${id}${forId && forId !== id ? ` (тембр для ${forId})` : ""}`,
  sampleFailed: (err: string) => `Пробу голоса прислать не получилось (${err}), но голос выбран.`,
  noSample: "У этого голоса нет пробы здесь — он синтезируется в Colab.",
  sendUsage: (cur: string) => `Сейчас: ${cur}. /send file — файлом в исходном качестве (по умолчанию); /send video — видео с плеером (Telegram сжимает); /send both — и то и другое.`,
  sendSet: (mode: SendMode): string => (mode === "file" ? "Ролики буду присылать файлом — без пережатия, можно сразу выкладывать." : mode === "video" ? "Ролики буду присылать как видео (с плеером; Telegram их сжимает)." : "Ролики буду присылать и видео (посмотреть), и файлом (для публикации)."),
  styleUsage: (cur: string) => `Сейчас: ${cur}. Варианты: /style pop — динамичные субтитры; /style clean — чистые маленькие субтитры как у экспертов, перебивки по словам, без музыки; /style box — строка на плашке, сказанные слова загораются, чипы с цифрами; /style split — сверху картинки и карточки, снизу спикер (как у новостных техно-блогеров); /style calm — спокойный.`,
  styleSet: (style: string) => `Стиль: ${style}. Следующий монтаж будет в нём.`,
  reviseUsage: "Напишите, что изменить: /revise в reel_1 убери приветствие",
  reviseNoJob: "Нечего править: сначала смонтируйте видео (пришлите видео и задачу).",

  settings: (s: SettingsView) =>
    [
      "⚙️ Настройки",
      `Формат: ${s.aspect}`,
      `Стиль монтажа: ${s.style}`,
      `Голос: ${s.voice}`,
      `Как присылать: ${s.send === "file" ? "файлом" : s.send === "video" ? "видео" : "видео и файлом"}`,
      `Язык: ${LANG_NAMES[s.lang]}`,
      `Новости бота: ${s.news ? "вкл" : "выкл"}`,
    ].join("\n"),
  sendNames: { file: "Файлом", video: "Видео", both: "Оба" } as Record<SendMode, string>,
  newsOn: "🔔 Новости: вкл",
  newsOff: "🔕 Новости: выкл",
  btnVoice: "🎙 Выбрать голос",
  btnBack: "← Назад",
  saved: "Сохранено",

  balance: (b: BalanceView) =>
    [
      "💳 Баланс",
      `Тариф: ${b.admin ? "администратор (без лимитов)" : b.plan === "vip" ? "VIP (без лимитов и списаний)" : b.plan === "free" ? "бесплатный" : b.plan}`,
      `Кредиты: ${b.credits}`,
      `Сегодня бесплатно: обычных ${b.usedStd}/${b.std}, длинных ${b.usedLong}/${b.long}`,
      `Сверх лимита: обычная задача — ${b.cs} кр., длинная (видео > ${b.longMinutes} мин или хайлайты) — ${b.cl} кр.`,
      "",
      "💎 Пополнение баланса и PRO без водяного знака — выберите пакет ниже (оплата переводом на карту Uzcard / Humo / Visa).",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `Дневной лимит ${long ? "длинных задач" : "задач"} исчерпан, а кредитов не хватает: нужно ${need}, есть ${have}. Выберите пакет ниже, чтобы пополнить баланс или включить 👑 PRO без лимитов (💳 Баланс):`,
  paidNote: (n: number, left: number) => `Списано кредитов: ${n}, осталось ${left}.`,
  userDailyCap: (n: number) => `Сегодня вы уже запустили ${n} задач — это дневной максимум. Лимит обновится завтра.`,
  budgetPaused: "Сервис на сегодня исчерпал дневной бюджет на ИИ — новые задачи принимаются завтра. Уже запущенные доделаются.",
  busy: "У вас уже есть задача в работе и две в очереди — дождитесь результата или отмените (/cancel).",

  kind: { run: "🎬 Монтаж", make: "✨ Ролик по теме", revise: "✏️ Правка", avatar: "🧑 Аватар", avatar_import: "🧑 Монтаж аватара", dub: "🌐 Озвучка" } as Record<string, string>,
  stage: {
    queued: (pos: number) => `⏳ в очереди: ${pos}`,
    start: "старт",
    prepare: "подготовка видео",
    understand: "понимаю видео",
    plan: "план",
    cut: "нарезка",
    render: (pct: number) => `рендер ${pct}%`,
    audio: "звук",
    script: "сценарий",
    design: "оформление",
    send: "отправка",
    done: "✅ готово",
    cancelled: "🛑 отменено",
    failed: "✖ не получилось",
  },
  btnCancel: "🛑 Отменить",
  cancelling: "Отменяю — останавливаю процесс.",
  cancelled: "Отменено.",
  nothingToCancel: "Сейчас ничего не выполняется.",
  notYours: "Это не ваша задача.",

  done: (n: number, job: string) => `Готово: ${n} ролик(ов), задача ${job}.`,
  noNew: (job: string) => `Новых роликов нет (задача ${job}).`,
  reviseHint: "Правка: кнопка «✏️ Поправить» или /revise <что изменить>",
  rateAsk: "Оцените результат:",
  btnAgain: "🔁 Ещё вариант",
  btnEdit: "✏️ Поправить",
  btnFormat: "📐 Другой формат",
  rated: (n: number) => `Спасибо! Оценка: ${"⭐".repeat(n)}`,
  askEdit: "Напишите, что поправить, — например «убери приветствие, субтитры крупнее».",
  failed: "Не получилось сделать ролик — что-то пошло не так при обработке. Попробуйте ещё раз или измените задачу.",
  btnRetry: "🔁 Попробовать ещё раз",
  restarted: "Бот перезапускался, и задача прервалась. Нажмите «Попробовать ещё раз» — лимит за неё не списан.",
  jobGone: "Эта задача больше недоступна.",
  tooBigToSend: "Ролик не удалось отправить через Telegram (слишком большой). Попробуйте ролик короче или напишите администратору.",
  creditsGrantedUser: (n: number, balance: number) => `Вам начислено кредитов: ${n}. Баланс: ${balance}.`,

  statusNow: (kind: string, stage: string, sec: number, aborting: boolean) => `Сейчас: ${kind}, шаг «${stage}», ${sec} с${aborting ? " (отменяется)" : ""}`,
  statusQueued: (kind: string, pos: number) => `В очереди: ${kind}, место ${pos}`,
  statusVideo: (name: string) => `Видео: ${name}`,
  statusTask: (prompt: string) => `Задача: ${prompt}`,
  statusJobMissing: (id: string) => `job ${id}: не найдена в workspace`,

  adminMenu: "Админка:",
  btnStats: "📊 Статистика",
  btnFind: "👤 Найти пользователя",
  btnBroadcast: "📣 Рассылка",
  btnLimits: "⚙️ Лимиты",
  stats: (s: StatsView) =>
    [
      "📊 Статистика",
      `Пользователи: ${s.users} (новых сегодня ${s.usersToday}, активных сегодня ${s.activeToday}, заблокировано ${s.banned})`,
      `Задачи за 7 дней по статусу: ${s.byStatus.map((x) => `${x.status} ${x.n}`).join(", ") || "—"}`,
      `по типу: ${s.byKind.map((x) => `${x.kind} ${x.n}`).join(", ") || "—"}`,
      `Расходы: сегодня ${usd(s.costToday)}, за 7 дней ${usd(s.cost7d)}`,
      `Очередь: в работе ${s.running}/${s.maxJobs}, ждут ${s.queued}`,
      `Оценки: ${s.ratings ? `${s.ratingAvg!.toFixed(2)} ⭐ (${s.ratings})` : "—"}`,
    ].join("\n"),
  askUser: "Пришлите id пользователя или @username.",
  userNotFound: (q: string) => `Пользователь «${q}» не найден.`,
  userCard: (u: UserCardView) =>
    [
      `👤 ${u.name ?? "—"}${u.username ? ` @${u.username}` : ""} · id ${u.id}`,
      `Язык: ${u.lang}, цель: ${u.purpose ?? "—"}, роль: ${u.role}, статус: ${u.status}`,
      `Тариф: ${u.plan}, кредиты: ${u.credits}`,
      `С нами с ${u.created.slice(0, 10)}, был(а) ${u.lastSeen?.slice(0, 16).replace("T", " ") ?? "—"}`,
      `Задачи: ${u.jobs} (готово ${u.done}, ошибок ${u.failed}), расходы ${usd(u.cost)}`,
      `Сегодня: обычных ${u.todayStd}, длинных ${u.todayLong}`,
    ].join("\n"),
  btnCredits: (n: number) => `+${n} кр.`,
  btnBan: "🚫 Заблокировать",
  btnUnban: "✅ Разблокировать",
  btnMakeAdmin: "⭐ Сделать админом",
  btnRemoveAdmin: "Снять админа",
  creditsGranted: (n: number, id: number, balance: number) => `Начислено ${n} кр. пользователю ${id}. Баланс: ${balance}.`,
  askBroadcast: "Пришлите текст рассылки (одно сообщение). Получат все активные пользователи, кроме отписавшихся.",
  broadcastConfirm: (n: number, text: string) => `Отправить ${n} пользователям?\n\n${text}`,
  btnSend: "✅ Отправить",
  btnCancelPlain: "✖ Отмена",
  broadcastStarted: (n: number) => `Рассылка пошла: ${n} получателей (≤ 20 сообщений в секунду).`,
  broadcastDone: (ok: number, fail: number) => `Рассылка закончена: доставлено ${ok}, не доставлено ${fail}.`,
  broadcastCancelled: "Рассылка отменена.",
  broadcastFooter: "— Отписаться от новостей: ⚙️ Настройки → 🔔 Новости",
  limitsCard: (rows: { what: string; value: number }[]) => ["⚙️ Лимиты бесплатного тарифа (меняются сразу, хранятся в базе):", ...rows.map((r, i) => `${i + 1}. ${r.what}: ${r.value}`)].join("\n"),
  adminJobFailed: (user: number, job: string, kind: string, error: string) => `⚠ ${kind} · задача ${job} · пользователь ${user}\n${error}`,
  // VIP testers and the DB allowlist
  btnVipOn: "✓ ⭐ VIP (снять)",
  btnVipOff: "⭐ VIP",
  vipSet: (id: number, on: boolean) => (on ? `⭐ VIP включён для ${id}: без дневных лимитов и списаний, доступ к боту открыт.` : `VIP снят у ${id}: снова бесплатный тариф.`),
  vipUserOn: "Вам открыт ⭐ VIP-доступ: все функции без дневных лимитов и списаний кредитов. Спасибо, что тестируете!",
  vipUsage: "Формат: /vip <id или @username> on|off",
  allowUsage: "Формат: /allow <id> [off]",
  allowSet: (id: number, on: boolean) => (on ? `Пользователь ${id} допущен к боту (без правки .env).` : `Пользователь ${id} убран из списка допуска (если его нет в TELEGRAM_ALLOWED_USERS — бот перестанет ему отвечать).`),
  strangerNotice: (id: number, name: string, username: string) => `👤 Незнакомец пишет боту (закрытая бета): ${name}${username ? ` @${username}` : ""} · id ${id}`,
  btnLetIn: "✅ Пустить (VIP)",
  btnIgnore: "Игнорировать",
  strangerLet: (id: number) => `✅ ${id} пущен с ⭐ VIP. Ему отправлено приглашение.`,
  strangerIgnored: (id: number) => `Игнорируем ${id}: больше уведомлений о нём не будет.`,
  // the in-bot guide
  guide: {
    cards: [
      { title: "🎬 Монтаж из своих видео", body: "Пришлите 1 или несколько видео (можно альбомом).\nБольше 20 МБ — ссылкой: Google Диск, Яндекс Диск, Dropbox, YouTube.\nПоявится карточка: рилсы, один вирусный, хайлайты; длина, формат, стиль.\nНажмите «▶️ Начать» — пришлю готовые ролики.\nИли просто напишите: «3 рилса по 30 секунд»." },
      { title: "🔤 Стили субтитров и вставки", body: "Динамичный — крупные слова с подсветкой, для блогов.\nЧистые — маленькие белые строчные, как у экспертов.\nПлашка с подсветкой — слова загораются на тёмной плашке.\nСплит — вы внизу, картинки и карточки сверху.\nВ «Чистых» и «Плашке» — вставки по словам: фото, логотипы, сайты, цифры." },
      { title: "✨ Ролик по теме", body: "Кнопка «Ролик по теме» или /make — напишите тему.\nВыберите формат (9:16, 16:9, 1:1) и голос, ▶️ — послушать.\nСценарий, картинки, анимацию и озвучку сделаю сам.\nОбычно 5–10 минут." },
      { title: "🎯 Монтаж как в примере", body: "Пришлите рилс-пример: файлом или ссылкой (Instagram, TikTok, Shorts).\nЯ разберу стиль: субтитры, темп, наезды, музыку, цвет.\nЗатем пришлите своё видео — смонтирую так же." },
      { title: "🏀 Хайлайты игры", body: "Пришлите запись игры — найду лучшие броски и моменты.\nЗамедление, повтор, музыка по битам.\n«По отдельности на каждого» — свой ролик на каждого игрока." },
      { title: "🧑 Аватар", body: "Фото лица (по желанию) + голосовое 5–10 с для своего голоса + текст или тема.\nЯ подготовлю пакет avatar_job.zip и пошаговую инструкцию.\nГоворящую голову вы запускаете сами в Google Colab (бесплатный GPU, 10–20 мин).\nГотовый avatar_result.zip пришлите сюда — смонтирую ролик." },
      { title: "⭐ Оценки", body: "Под каждым результатом — 1–5 ⭐.\nПосле оценки отметьте, что получилось или нет; можно пару слов или голосовое.\nМы читаем каждый отзыв и по ним улучшаем ролики.\n«✏️ Поправить» — исправлю ролик по вашим словам." },
    ],
    head: (n: number, total: number) => `📘 Как пользоваться · ${n}/${total}`,
    tryIt: "▶️ Попробовать",
    sheet: "🖼 Шпаргалка",
    sheetCaption: "Шпаргалка vedit: всё на одной картинке.",
    sheetMissing: "Шпаргалка сейчас недоступна — листайте карточки кнопками ◀️ ▶️.",
    imageTitle: "Как пользоваться ботом",
    imageSub: "ИИ-монтажёр в Telegram: всё кнопками",
    imageFoot: "Меню: /start · Помощь: /help · Отмена: /cancel",
  },
  // stage 28: reasons after a rating, comment, admin analytics
  fb: {
    askLow: (n: number) => `Спасибо за оценку ${"⭐".repeat(n)}. Что не получилось? Отметьте одно или несколько:`,
    askHigh: (n: number) => `Спасибо за ${"⭐".repeat(n)}! Что понравилось больше всего? Можно несколько:`,
    low: { subs: "Субтитры", vis: "Картинки не по теме", dyn: "Нет динамики / скучно", voice: "Голос / произношение", audio: "Музыка / звук", text: "Ошибка в тексте / фактах", cut: "Обрезано не там", wait: "Долго ждать", other: "Другое" },
    high: { hook: "Хук", vis: "Картинки", subs: "Субтитры", dyn: "Динамика", voice: "Голос", music: "Музыка", all: "Всё отлично" },
    done: "✅ Готово",
    comment: "Можно добавить пару слов или голосовое — или нажмите Готово",
    thanks: "Спасибо! Отзыв сохранён — учтём в следующих роликах.",
    heard: (text: string) => `Спасибо! Записал: «${text}»`,
    voiceKept: "Спасибо! Голосовое сохранил — разберём вручную.",
    issue: { subs: "в субтитрах", vis: "в картинках", dyn: "в темпе ролика", voice: "в озвучке", audio: "в звуке", text: "в тексте", hook: "в начале ролика" },
    ack: (issue: string) => `Похоже, проблема ${issue}. Учтём.`,
    rated: (n: number) => `${"⭐".repeat(n)} · изменить`,
  },
  btnFeedback: "📊 Оценки",
  fbAdmin: {
    title: "📊 Оценки",
    period: (d: number) => (d > 0 ? `${d} д` : "всё время"),
    avg: "Средняя",
    dist: "Распределение",
    byKind: "По типу",
    byStyle: "По стилю",
    byVoice: "По голосу",
    lowWhy: "Почему низкие (1–3⭐)",
    highWhy: "Почему высокие (4–5⭐)",
    ai: "Самопроверка ИИ",
    aiLine: (ok: number, skipped: number, avg: string, cost: string) => `проверено ${ok}, пропущено ${skipped}, средняя ${avg}, расходы ${cost}`,
    disagree: "Расхождения ИИ и пользователей (|разница| ≥ 2)",
    disagreeHint: "Это случаи, на которых стоит учиться: критик и человек видят ролик по-разному.",
    none: "Оценок пока нет.",
    recentLow: "Последние низкие оценки",
    userSaid: "Пользователь",
    aiSaid: "ИИ",
    noReview: "самопроверки нет",
    confidence: "уверенность",
    btnLow: "👎 Низкие",
    btnDisagree: "⚖️ Расхождения",
    btnVideo: "▶️ Видео",
    videoGone: "Файл уже удалён очисткой.",
    kinds: { montage: "монтаж", highlights: "хайлайты", reference: "по примеру", make: "по теме", revise: "правка", avatar: "аватар", dub: "озвучка" } as Record<string, string>,
    criteria: { hook: "хук", visual_relevance: "картинки", dynamics: "динамика", captions: "субтитры", audio: "звук", text_accuracy: "текст", overall: "общая" } as Record<string, string>,
  },
  // stage 30: testers, links as the starting point, «Русская версия» (dubbing), compliance
  // stage 31: the promo / explainer format (clean UI, 16:9 for YouTube)
  s31: { promo: "🎬 Промо / объяснялка (YouTube)" },
  // stage 32: «🗓 Контент-план» (src/bot/i18n-cp.ts)
  cp: CP_RU,
  s30: {
    // testers
    testerNotice: (id: number, name: string, username: string, slot: number, slots: number) => `👤 Новый тестировщик: ${name}${username ? ` @${username}` : ""} · id ${id} (слот ${slot}/${slots})`,
    btnRevoke: "🚫 Отозвать",
    testerRevoked: (id: number) => `🚫 Доступ ${id} отозван — слот освобождён.`,
    vipPending: (username: string) => `⏳ @${username} ещё не писал боту. Как только напишет — сразу пущу с ⭐ VIP (слот автодоступа не тратится).`,
    vipPendingRemoved: (username: string) => `@${username} убран из ожидающих VIP.`,
    pendingArrived: (id: number, name: string, username: string) => `✅ @${username} (${name}, id ${id}) написал боту — ⭐ VIP открыт.`,
    adminTesters: (used: number, slots: number, testers: string[], pending: string[]) =>
      [`🧪 Автодоступ тестировщиков: ${used}/${slots}${testers.length ? ` — ${testers.join(", ")}` : ""}`, `⏳ Ждут VIP: ${pending.length ? pending.map((u) => `@${u}`).join(", ") : "—"}`].join("\n"),
    // compliance
    rightsAsk: (n: number) =>
      `${n > 1 ? `Это ${n} видео` : "Это видео"} с чужой платформы. Перед обработкой подтвердите:\n«Я подтверждаю, что у меня есть права на это видео или я использую его в допустимых целях (обзор, цитата, обучение)».`,
    btnConfirm: "✅ Подтверждаю",
    btnCancel: "Отмена",
    rightsOk: "✅ Подтверждено. Скачиваю…",
    rightsNo: "Хорошо, это видео не обрабатываю. Пришлите своё видео файлом или ссылкой.",
    rightsGone: "Это подтверждение уже неактуально — пришлите ссылку ещё раз.",
    linkBlocked: "✖ Эта ссылка заблокирована по запросу правообладателя — обработать её нельзя.",
    linkLogin: "✖ Этот ролик открывается только после входа в аккаунт. Мы скачиваем только публичные видео и не используем чужие логины — пришлите сам файл, если у вас есть на него права.",
    source: "Источник",
    takedownUsage: "Формат: /takedown <задача или ссылка> [причина] — удалю файлы задачи и заблокирую ссылку.",
    takedownDone: (jobs: number, removed: number, blocked: number) => `🧹 Удаление по жалобе: задач ${jobs}, удалено файлов и папок ${removed}, заблокировано ссылок ${blocked}.`,
    takedownNothing: (target: string) => `По «${target}» задач не нашлось.`,
    // a link as the starting point
    linkCard: (title?: string) => `Видео по ссылке получено${title ? `: «${title}»` : ""}. Что сделать?\n✂️ нарезать лучшие моменты · 🎯 смонтировать ваш ролик так же · 🌐 русская версия · 🧑 аватар по этому сценарию — или выберите рилсы ниже и нажмите «▶️ Начать».`,
    btnLinkCut: "✂️ Нарезка лучших моментов",
    btnLinkRef: "🎯 Смонтировать мой ролик так же",
    btnLinkAvatar: "🧑 Аватар по этому сценарию",
    btnDubOpen: "🌐 Русская версия",
    btnDubToggle: "🌐 Озвучить на русском",
    refFromLink: "🔎 Разбираю стиль этого ролика. Сам ролик в ваш монтаж не попадёт — только приёмы: темп, субтитры, наезды, звук.",
    avatarFromLink: "🧑 Беру речь из видео и пересказываю своими словами — из этого сценария соберу пакет аватара. Дословно чужой текст не копирую.",
    needLinkVideo: "Сначала пришлите видео или ссылку на него.",
    // dubbing
    dubCard: (name: string, minutes: number) =>
      `🌐 Перевод и озвучка: ${name}${minutes ? ` (≈${minutes} мин)` : ""}\nВыберите язык и голос. Оригинал станет тише, перевод — сверху (как закадровый перевод на ТВ), субтитры — на языке перевода. В описании будет пометка «Неофициальный перевод». Голос автора не клонируем.`,
    modeVoiceover: "🔉 Закадровый",
    modeReplace: "🔇 Заменить речь",
  },
};

export type Strings = typeof ru;

const uz: Strings = {
  langPrompt: ru.langPrompt,
  langName: LANG_NAMES.uz,
  intro: "Salom! Men sun’iy intellektli montajchiman: videolaringizdan qisqa roliklar, mavzu bo‘yicha ovozli roliklar, o‘yin lahzalari (xaylaytlar) va gapiradigan avatarlar tayyorlayman. Hammasi shu yerda, Telegram’da, tugmalar orqali.",
  askPurpose: "Roliklar sizga nima uchun kerak? Shunga qarab sozlamalarni tanlayman.",
  purpose: { blog: "Blog / kontent", biz: "Biznes / reklama", sport: "Sport", other: "Boshqa" },
  terms: (days: number) =>
    [
      "Boshlashdan oldin — foydalanish shartlari va maxfiylik. Qisqacha:",
      "• Telegram id, ism, til va sozlamalaringizni saqlaymiz;",
      `• yuklangan videolar va tayyor roliklar ${days} kundan keyin o‘chiriladi;`,
      "• qayta ishlash uchun Anthropic (Claude), Google (Gemini) va Openverse (rasm va musiqa) xizmatlaridan foydalaniladi;",
      "• noqonuniy kontent va boshqalarning videolarini ruxsatsiz yuborish mumkin emas; YouTube, TikTok, Instagram roliklari — faqat huquq bilan yoki sharh, iqtibos, o‘qitish uchun (bot tasdiqlashni so‘raydi);",
      "• ovozli tarjimalar «Norasmiy tarjima» deb belgilanadi; boshqalarning ovozini klonlamaymiz;",
      "• videolar va roliklarga bo‘lgan huquq sizda qoladi.",
      "",
      "To‘liq matnlar — quyidagi tugmalarda.",
    ].join("\n"),
  btnTerms: "📄 Shartlar",
  btnPrivacy: "🔒 Maxfiylik",
  btnAccept: "✅ Qabul qilaman",
  welcome: (credits: number, std: number, long: number, longMinutes: number) =>
    `Tayyor, siz ro‘yxatdan o‘tdingiz! Sinov kreditlari: ${credits}. Har kuni bepul: ${std} ta oddiy vazifa va ${long} ta uzun vazifa (${longMinutes} daqiqadan uzun video yoki o‘yin xaylaytlari).\nNima qilishni tanlang — tugmalar pastda.`,
  menuText: "Asosiy menyu — nima qilamiz?",
  menu: { montage: "🎬 Videolarimdan montaj", ref: "🎯 Namunadagidek montaj", make: "✨ Mavzu bo‘yicha rolik", highlights: "🏀 O‘yin xaylaytlari", plan: "🗓 Kontent-reja", avatar: "🧑 Avatar", settings: "⚙️ Sozlamalar", balance: "💳 Balans", help: "❓ Yordam", guide: "📘 Qanday foydalanish" },
  needStart: "Avval ro‘yxatdan o‘tishni yakunlaylik — bir necha bosish xolos. /start",
  banned: "Botdan foydalanish cheklangan. Agar bu xato bo‘lsa — administratorga yozing.",
  docMissing: "Matn hozircha mavjud emas.",
  help: [
    "Men qisqa roliklar tayyorlayman: videolaringizni montaj qilaman, mavzu bo‘yicha ovozli roliklar, o‘yin xaylaytlari va gapiradigan avatarlar yasayman.",
    "",
    "Pastdagi tugmalar:",
    "🎬 Montaj — video yuboring (20 MB gacha; bir nechta yoki albom bo‘lishi mumkin; kattarog‘ini — Google Disk, Yandex Disk, Dropbox yoki YouTube havolasi bilan), nima qilishni tanlang va «▶️ Boshlash»ni bosing. Yoki vazifani o‘zingiz yozing: «30 soniyalik 3 ta rils, o‘zbekcha subtitrlar bilan».",
    "✨ Mavzu bo‘yicha rolik — mavzuni yozing, format va ovozni tanlang.",
    "🏀 Xaylaytlar — o‘yin videosi → sekinlashtirish va musiqa bilan eng yaxshi lahzalar; «alohida» — har bir o‘yinchiga alohida rolik.",
    "🧑 Avatar — rasm va ovozli xabar → gapiradigan boshlovchi (bepul Google Colab orqali).",
    "🔗 YouTube / TikTok / Instagram havolasi (podkast, intervyu, film) — eng yaxshi lahzalar, «rolikimni shunday montaj qil», 🌐 ruscha versiya (tarjima va ovoz) yoki ssenariy bo‘yicha avatar. Boshqalarning videolari — faqat huquq bilan yoki sharh, iqtibos, o‘qitish uchun.",
    "⚙️ Sozlamalar — format, uslub, ovoz, roliklarni qanday yuborish, til.",
    "💳 Balans — limitlar va kreditlar.",
    "",
    "Buyruqlar (tugmalar bilan bir xil):",
    "/make <mavzu> — mavzu bo‘yicha rolik; /make 16:9 mavzu — YouTube uchun",
    "/viral — yuborilgan barcha videolardan bitta eng virusli rolik; /clear — yangi to‘plam",
    "/revise <nimani o‘zgartirish> — oxirgi montajni tuzatish",
    "/style pop | clean | box | split | calm — montaj uslubi",
    "/voice — ovozlar: /voice gemini_charon — tanlash, /voice off — ovozsiz",
    "/send file | video | both — roliklarni qanday yuborish: fayl (asl sifat), video yoki ikkalasi",
    "/avatar <matn yoki mavzu> — gapiradigan avatar; tayyor avatar_result.zip ni shu yerga yuboring",
    "/status — hozir nima bajarilmoqda; /cancel — bekor qilish",
    "/start — menyu",
  ].join("\n"),
  unknownCommand: "Bunday buyruqni bilmayman. /help — yordam.",
  noJob: "Hozircha vazifalar yo‘q. Video yuboring yoki menyudan amal tanlang.",

  refAsk: (mb: number) => `Namuna yuboring — yoqqan rilsni fayl (${mb} MB gacha) yoki havola (Instagram, TikTok, YouTube Shorts) qilib. Uning montajini tahlil qilaman: temp, pauzalar, subtitrlar, yaqinlashtirishlar, tovush va rang — va videongizni xuddi shunday montaj qilaman. Namunaning o‘zi rolikka qo‘shilmaydi.`,
  refAnalyzing: "🔎 Namuna montajini tahlil qilyapman… (odatda bir daqiqagacha)",
  refReady: (summary: string, cached: boolean) => `🎯 Namuna uslubi${cached ? " (avval ko‘rilgan)" : ""}: ${summary}

Endi o‘z videongizni yuboring — bitta yoki bir nechta. Shu uslubda montaj qilaman.`,
  refLinkFailed: "Havola bo‘yicha rolikni yuklab bo‘lmadi (Instagram ko‘pincha kirishni talab qiladi). Rolikning o‘zini fayl qilib yuboring.",
  refFailed: "Namunani tahlil qilib bo‘lmadi. Boshqa rolikni sinab ko‘ring yoki uni fayl qilib yuboring.",
  refNeedFileOrLink: "Namunani kutyapman: video fayl yoki rilsga havola.",
  refBusy: "Oldingi namunani hali tahlil qilyapman — bir daqiqa.",
  styleRef: "🎯 Namunadagidek",
  montageAsk: (mb: number) => `Video yuboring — bitta yoki bir nechta (har biri ${mb} MB gacha, albom ham mumkin). Kattaroq videoni havola qilib yuboring: Google Disk, Yandex Disk, Dropbox yoki YouTube. Keyin nima qilishni tanlaysiz.`,
  highlightsAsk: (mb: number) => `O‘yin yoki mashg‘ulot videosini yuboring (${mb} MB gacha; kattarog‘ini — Google Disk, Yandex Disk yoki YouTube havolasi bilan). Eng yaxshi lahzalarni topib, sekinlashtiraman va musiqani ritmga moslayman.`,
  needVideo: "Avval video yuboring (video yoki fayl sifatida), keyin vazifani yozing.",
  notVideo: "Bu videoga o‘xshamayapti. Rolikni video yoki video/* turidagi fayl sifatida yuboring.",
  videoSaved: "Video qabul qilindi. Nima qilishni tanlang va «▶️ Boshlash»ni bosing — yoki vazifani o‘z so‘zlaringiz bilan yozing (masalan, «subtitrli 20 soniyalik 2 ta rils»).",
  batchSaved: (n: number) => `Qabul qilingan videolar: ${n}. Odatda ularni bitta rolikka yig‘aman — sozlamalarni tanlang va «▶️ Boshlash»ni bosing (yoki vazifani so‘z bilan yozing). Yana video yuborish mumkin; /clear — to‘plamni qaytadan boshlash.`,
  cleared: "To‘plam tozalandi. Yangi videolarni yuboring.",
  tooLarge: (sizeMb: number, limitMb: number, byTelegram: boolean) =>
    `${sizeMb > limitMb ? `Fayl ${sizeMb} MB` : `Fayl ${limitMb} MB dan katta`}, ${byTelegram ? "Telegram esa botga faqat" : "tarifingizda esa faqat"} ${limitMb} MB gacha fayl ${byTelegram ? "yuklab olishga ruxsat beradi" : "yuborish mumkin"} — videoga havola yuboring (Google Disk / Yandex Disk / Dropbox / YouTube) yoki videoni siqing. Havolani shunchaki xabar qilib yuboring.`,
  linkStart: "⬇️ Videoni havola orqali yuklab olyapman…",
  linkProgress: (mb: number, totalMb: number) => `⬇️ Videoni havola orqali yuklab olyapman… ${mb} MB${totalMb ? ` / ${totalMb} MB` : ""}`,
  linkDone: (n: number, mb: number) => `✅ Havola orqali yuklandi: ${n > 1 ? `${n} ta video, ` : ""}${mb} MB`,
  linkTooBig: (sizeMb: number, maxMb: number) => `✖ Havoladagi video juda katta${sizeMb ? `: ${sizeMb} MB` : ""} — ${maxMb} MB gacha mumkin. Uni qirqing yoki siqing va qayta yuboring.`,
  linkPrivate: "✖ Havola yopiq. «Havolasi bor hammaga» ruxsat bering (Google Disk: Ulashish → Umumiy ruxsat) va havolani qayta yuboring.",
  linkFolder: "✖ Bu papkaga havola. Video faylning o‘ziga havola yuboring (Yandex Disk papkasi mumkin — undagi barcha videolarni olaman).",
  linkNotVideo: "✖ Havolada video yo‘q (yoki fayl emas, veb-sahifa). Video faylga havola yoki videoning o‘zini yuboring.",
  linkNoYtdlp: "✖ YouTube / Instagram / TikTok havolalari hozir yuklanmaydi. Google Disk, Yandex Disk yoki Dropbox havolasini — yoki videoning o‘zini yuboring.",
  linkFailed: "✖ Havola orqali videoni yuklab bo‘lmadi. U akkauntga kirmasdan ochilishini tekshiring va qayta yuboring — yoki videoni fayl qilib yuboring.",
  linkTimeout: "✖ Havoladagi video juda uzoq yuklandi. Yana urinib ko‘ring yoki kichikroq fayl yuboring.",
  linkCancelled: "Havola orqali yuklash bekor qilindi.",
  btnCancelDownload: "🛑 Yuklashni bekor qilish",
  uploadFailed: "✖ Faylni Telegramdan olib bo‘lmadi. Uni qayta yuboring.",
  photoInMontage: "Montajga hozircha rasm qo‘shmayman — video yuboring. Avatar uchun rasm — «🧑 Avatar» menyusida.",
  cardStale: "Bu kartochka allaqachon ishlatilgan — oxirgisidagi ▶️ ni bosing.",
  uploadsPending: "⏳ Videolarni hali yuklayapman — yuklash tugashi bilan boshlayman.",
  tooLargeAdmin: "Variantlar: videoni siqing yoki qirqing; yoki lokal Bot API serverini ishga tushiring (github.com/tdlib/telegram-bot-api, --local) va TELEGRAM_API_BASE=http://localhost:8081 ni ko‘rsating — shunda limit 2000 MB.",
  mode: { reels: "Eng yaxshi lahzalardan rilslar", viral: "Bitta virusli rolik", hl: "Xaylaytlar", pp: "Har biriga alohida" },
  countLabel: (n: number) => `${n} ta`,
  secondsLabel: (n: number) => `${n} s`,
  styleNames: { bold_pop: "Dinamik", clean_min: "Toza (ekspertlardek)", box_reveal: "Plashka bilan yoritish", split_news: "Split", explainer: "Ekspleyner (yorug‘ studiya)", abror_split: "Abror (split)", abror_full: "Abror (to‘liq kadr)", calm: "Sokin" },
  btnStart: "▶️ Boshlash",

  makeAskTopic: "Rolik mavzusini yozing — masalan, «nega 2026-yilda qahva qimmatlashmoqda».",
  makeCard: (topic: string) => `Mavzu: «${topic}»\nFormat va ovozni tanlang (▶️ — ovoz namunasi) va «Boshlash»ni bosing.`,
  voiceAuto: "Avto",
  voiceNone: "Ovozsiz",
  makeUsage: "Mavzuni yozing: /make nega qahva qimmatlashmoqda",
  avatarMenu:
    "Gapiradigan avatar: rasm (yuz to‘g‘ridan) va xohlasangiz 5–10 soniyalik ovozli xabar yuboring — avatar sizning yuzingiz va ovozingiz bilan bo‘ladi; ularsiz — to‘qima boshlovchi.\nKeyin keyingi xabarda matn yoki mavzuni yozing.",
  btnAvatarReset: "Rasm va ovozni unutish",
  avatarUsage: "Matn yoki mavzuni yozing: /avatar nega qahva qimmatlashmoqda (mavzu bo‘lsa, monologni o‘zim yozaman) yoki /avatar matn: Salom! Bugun… Avatar uchun rasm va ovozli xabarni oldindan yuborish mumkin; /avatar reset — ularni unutish.",
  avatarStart: (photo: boolean, voice: boolean, voiceId?: string) =>
    `Avatar uchun vazifa tayyorlanmoqda: ${photo ? "sizning rasmingiz" : "to‘qima boshlovchi (portret yarataman)"}, ${voice ? "sizning ovozingiz (klon)" : voiceId ? `${voiceId} ovozi` : "standart ovoz"}. Bu 1–3 daqiqa.`,
  avatarPhotoSaved: "Rasm avatar uchun saqlandi. Endi /avatar <matn yoki mavzu> — yoki «🧑 Avatar» tugmasidan keyin matnni yozing.",
  avatarVoiceSaved: "Ovoz saqlandi: avatar shu ovozda gapiradi (matn tilida 5–10 soniya toza nutq kerak). Endi /avatar <matn yoki mavzu>.",
  avatarReset: "Avatar uchun rasm va ovoz unutildi.",
  avatarNoJob: "Bu arxiv uchun vazifa topilmadi: avval /avatar <matn>, keyin Colab’dan avatar_result.zip ni yuboring.",
  avatarImportStart: (jobId: string) => `avatar_result.zip qabul qilindi (vazifa ${jobId}). Rils montaj qilinmoqda: pastda avatar, tepada rasmlar, subtitrlar, musiqa.`,
  avatarInstructions: (jobId: string, lines: string[], warnings: string[]) =>
    [
      `Avatar uchun vazifa tayyor (vazifa ${jobId}) — avatar_job.zip fayli yuqorida.`,
      "",
      "Videoni qanday olish mumkin (bepul, Google Colab):",
      "1. colab_vedit_avatar.ipynb noutbukini (loyihaning tools/avatar papkasidan) colab.research.google.com da oching → File → Upload notebook.",
      "2. Runtime → Change runtime type → T4 GPU, keyin Runtime → Run all.",
      "3. «Yuklash» katagida avatar_job.zip ni tanlang.",
      "4. Birinchi ishga tushirish ~10 daqiqa (o‘rnatish va modellar), keyin 2–5 daqiqa.",
      "5. avatar_result.zip yuklab olinadi — uni shu yerga hujjat sifatida yuboring, men rils montaj qilaman.",
      ...(lines.length ? ["", "Matn:", ...lines.slice(0, 8).map((l, i) => `${i + 1}. ${l}`), ...(lines.length > 8 ? [`… yana ${lines.length - 8}`] : [])] : []),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n"),

  voiceList: (current?: string, hasKey = hasGoogleTtsKey()) =>
    [
      `Ovozlar (${current === "off" ? "hozir ovozsiz" : current ? `hozir: ${current}` : `hozir: avto — ${autoVoice("ru", hasKey).id}`}):`,
      voicesListText(current),
      "",
      "/voice <id> — tanlash (namuna yuboraman), /voice off — ovozsiz.",
      `gemini_* va chirp_* — Google’ning jonli ovozlari (bulut; GOOGLE_CLOUD_API_KEY yoki GEMINI_API_KEY kaliti kerak${hasKey ? " — bor" : " — hozircha yo‘q, ularning o‘rniga Piper eshitiladi"}).`,
      "Piper ovozlari (denis, dmitri, ljspeech, john, cori) — lokal, kalitsiz; chatterbox_* — faqat /avatar uchun (Colab’da).",
      "Tanlanmasa, /make avtomatik ovozlanadi: kalit bo‘lsa Gemini, aks holda Piper.",
      "/avatar uchun yuborgan ovozli xabaringiz tanlangan ovozdan ustun.",
    ].join("\n"),
  voiceSet: (v: VoiceDef, hasKey = hasGoogleTtsKey()) =>
    `Ovoz: ${v.id}. Litsenziya: ${v.license}.\n${
      isCloud(v) && !hasKey
        ? `Google kaliti hozircha yo‘q — u paydo bo‘lguncha /make va /avatar’ni Piper ${piperVoiceFor(v)?.id} ovozlaydi.`
        : isLocal(v)
          ? "/make va /avatar shu ovoz bilan ovozlanadi."
          : `Bu ovozda /avatar gapiradi (Colab); /make uchun lokal ${piperVoiceFor(v)?.id ?? "ovoz"} olinadi.`
    }`,
  voiceOff: "Ovoz o‘chirildi: /make yana ovozsiz, /avatar — standart Chatterbox ovozi (yoki sizning ovozli xabaringiz).",
  voiceUnknown: (id: string) => `«${id}» ovozini bilmayman. /voice — ro‘yxat.`,
  voicePick: "Ovozni tanlang (▶️ — namuna):",
  voiceChosen: (name: string) => `Ovoz: ${name}`,
  sampleCaption: (id: string, forId?: string) => `namuna: ${id}${forId && forId !== id ? ` (${forId} uchun tembr)` : ""}`,
  sampleFailed: (err: string) => `Ovoz namunasini yuborib bo‘lmadi (${err}), lekin ovoz tanlandi.`,
  noSample: "Bu ovozning namunasi bu yerda yo‘q — u Colab’da sintez qilinadi.",
  sendUsage: (cur: string) => `Hozir: ${cur}. /send file — asl sifatdagi fayl (standart); /send video — pleerli video (Telegram siqadi); /send both — ikkalasi.`,
  sendSet: (mode: SendMode) => (mode === "file" ? "Roliklarni fayl sifatida yuboraman — siqilmasdan, darhol joylash mumkin." : mode === "video" ? "Roliklarni video sifatida yuboraman (pleer bilan; Telegram ularni siqadi)." : "Roliklarni ham video (ko‘rish uchun), ham fayl (joylash uchun) qilib yuboraman."),
  styleUsage: (cur: string) => `Hozir: ${cur}. Variantlar: /style pop — dinamik subtitrlar; /style clean — ekspertlardek toza kichik subtitrlar, so‘zlarga mos qo‘shimcha kadrlar, musiqasiz; /style box — plashkadagi qator, aytilgan so‘zlar yonadi, raqamli chiplar; /style split — tepada rasmlar va kartochkalar, pastda spiker; /style calm — sokin.`,
  styleSet: (style: string) => `Uslub: ${style}. Keyingi montaj shu uslubda bo‘ladi.`,
  reviseUsage: "Nimani o‘zgartirishni yozing: /revise reel_1 da salomlashishni olib tashla",
  reviseNoJob: "Tuzatadigan narsa yo‘q: avval videoni montaj qiling (video va vazifa yuboring).",

  settings: (s: SettingsView) =>
    [
      "⚙️ Sozlamalar",
      `Format: ${s.aspect}`,
      `Montaj uslubi: ${s.style}`,
      `Ovoz: ${s.voice}`,
      `Qanday yuborish: ${s.send === "file" ? "fayl" : s.send === "video" ? "video" : "video va fayl"}`,
      `Til: ${LANG_NAMES[s.lang]}`,
      `Bot yangiliklari: ${s.news ? "yoqilgan" : "o‘chirilgan"}`,
    ].join("\n"),
  sendNames: { file: "Fayl", video: "Video", both: "Ikkalasi" },
  newsOn: "🔔 Yangiliklar: yoqilgan",
  newsOff: "🔕 Yangiliklar: o‘chirilgan",
  btnVoice: "🎙 Ovoz tanlash",
  btnBack: "← Orqaga",
  saved: "Saqlandi",

  balance: (b: BalanceView) =>
    [
      "💳 Balans",
      `Tarif: ${b.admin ? "administrator (limitsiz)" : b.plan === "vip" ? "VIP (limitsiz, kredit yechilmaydi)" : b.plan === "free" ? "bepul" : b.plan}`,
      `Kreditlar: ${b.credits}`,
      `Bugun bepul: oddiy ${b.usedStd}/${b.std}, uzun ${b.usedLong}/${b.long}`,
      `Limitdan ortiq: oddiy vazifa — ${b.cs} kr., uzun (${b.longMinutes} daqiqadan uzun video yoki xaylaytlar) — ${b.cl} kr.`,
      "",
      "💎 Balansni to‘ldirish va suv belgisisiz PRO — pastdagi paketni tanlang (Uzcard / Humo / Visa karta orqali; Tez orada: to‘lov Click/Payme).",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `Kunlik ${long ? "uzun vazifalar" : "vazifalar"} limiti tugadi, kreditlar esa yetmaydi: ${need} kerak, ${have} bor. Balansni to‘ldirish yoki 👑 PRO yoqish uchun pastdan paket tanlang (💳 Balans):`,
  paidNote: (n: number, left: number) => `${n} kredit yechildi, ${left} qoldi.`,
  userDailyCap: (n: number) => `Bugun siz allaqachon ${n} ta vazifa boshladingiz — bu kunlik maksimum. Limit ertaga yangilanadi.`,
  budgetPaused: "Xizmat bugungi AI byudjetini tugatdi — yangi vazifalar ertaga qabul qilinadi. Boshlanganlari yakunlanadi.",
  busy: "Sizda bitta vazifa bajarilmoqda va ikkitasi navbatda — natijani kuting yoki bekor qiling (/cancel).",

  kind: { run: "🎬 Montaj", make: "✨ Mavzu bo‘yicha rolik", revise: "✏️ Tuzatish", avatar: "🧑 Avatar", avatar_import: "🧑 Avatar montaji", dub: "🌐 Ovoz berish" },
  stage: {
    queued: (pos: number) => `⏳ navbatda: ${pos}`,
    start: "boshlanmoqda",
    prepare: "video tayyorlanmoqda",
    understand: "videoni tushunyapman",
    plan: "reja",
    cut: "kesish",
    render: (pct: number) => `render ${pct}%`,
    audio: "ovoz",
    script: "ssenariy",
    design: "bezash",
    send: "yuborish",
    done: "✅ tayyor",
    cancelled: "🛑 bekor qilindi",
    failed: "✖ bo‘lmadi",
  },
  btnCancel: "🛑 Bekor qilish",
  cancelling: "Bekor qilyapman — jarayonni to‘xtatyapman.",
  cancelled: "Bekor qilindi.",
  nothingToCancel: "Hozir hech narsa bajarilmayapti.",
  notYours: "Bu sizning vazifangiz emas.",

  done: (n: number, job: string) => `Tayyor: ${n} ta rolik, vazifa ${job}.`,
  noNew: (job: string) => `Yangi roliklar yo‘q (vazifa ${job}).`,
  reviseHint: "Tuzatish: «✏️ Tuzatish» tugmasi yoki /revise <nimani o‘zgartirish>",
  rateAsk: "Natijani baholang:",
  btnAgain: "🔁 Yana bir variant",
  btnEdit: "✏️ Tuzatish",
  btnFormat: "📐 Boshqa format",
  rated: (n: number) => `Rahmat! Baho: ${"⭐".repeat(n)}`,
  askEdit: "Nimani tuzatish kerakligini yozing — masalan, «salomlashishni olib tashla, subtitrlarni kattaroq qil».",
  failed: "Rolikni tayyorlab bo‘lmadi — ishlov berishda nimadir xato ketdi. Yana urinib ko‘ring yoki vazifani o‘zgartiring.",
  btnRetry: "🔁 Qayta urinish",
  restarted: "Bot qayta ishga tushdi va vazifa uzildi. «Qayta urinish»ni bosing — bu vazifa uchun limit yechilmagan.",
  jobGone: "Bu vazifa endi mavjud emas.",
  tooBigToSend: "Rolikni Telegram orqali yuborib bo‘lmadi (juda katta). Qisqaroq rolik qilib ko‘ring yoki administratorga yozing.",
  creditsGrantedUser: (n: number, balance: number) => `Sizga ${n} kredit qo‘shildi. Balans: ${balance}.`,

  statusNow: (kind: string, stage: string, sec: number, aborting: boolean) => `Hozir: ${kind}, bosqich «${stage}», ${sec} s${aborting ? " (bekor qilinmoqda)" : ""}`,
  statusQueued: (kind: string, pos: number) => `Navbatda: ${kind}, ${pos}-o‘rin`,
  statusVideo: (name: string) => `Video: ${name}`,
  statusTask: (prompt: string) => `Vazifa: ${prompt}`,
  statusJobMissing: (id: string) => `job ${id}: workspace’da topilmadi`,

  adminMenu: "Admin panel:",
  btnStats: "📊 Statistika",
  btnFind: "👤 Foydalanuvchini topish",
  btnBroadcast: "📣 Xabar tarqatish",
  btnLimits: "⚙️ Limitlar",
  stats: (s: StatsView) =>
    [
      "📊 Statistika",
      `Foydalanuvchilar: ${s.users} (bugun yangi ${s.usersToday}, bugun faol ${s.activeToday}, bloklangan ${s.banned})`,
      `7 kunlik vazifalar holati bo‘yicha: ${s.byStatus.map((x) => `${x.status} ${x.n}`).join(", ") || "—"}`,
      `turi bo‘yicha: ${s.byKind.map((x) => `${x.kind} ${x.n}`).join(", ") || "—"}`,
      `Xarajatlar: bugun ${usd(s.costToday)}, 7 kunda ${usd(s.cost7d)}`,
      `Navbat: bajarilmoqda ${s.running}/${s.maxJobs}, kutmoqda ${s.queued}`,
      `Baholar: ${s.ratings ? `${s.ratingAvg!.toFixed(2)} ⭐ (${s.ratings})` : "—"}`,
    ].join("\n"),
  askUser: "Foydalanuvchi id sini yoki @username ni yuboring.",
  userNotFound: (q: string) => `«${q}» foydalanuvchisi topilmadi.`,
  userCard: (u: UserCardView) =>
    [
      `👤 ${u.name ?? "—"}${u.username ? ` @${u.username}` : ""} · id ${u.id}`,
      `Til: ${u.lang}, maqsad: ${u.purpose ?? "—"}, rol: ${u.role}, holat: ${u.status}`,
      `Tarif: ${u.plan}, kreditlar: ${u.credits}`,
      `Ro‘yxatdan: ${u.created.slice(0, 10)}, oxirgi faollik: ${u.lastSeen?.slice(0, 16).replace("T", " ") ?? "—"}`,
      `Vazifalar: ${u.jobs} (tayyor ${u.done}, xato ${u.failed}), xarajat ${usd(u.cost)}`,
      `Bugun: oddiy ${u.todayStd}, uzun ${u.todayLong}`,
    ].join("\n"),
  btnCredits: (n: number) => `+${n} kr.`,
  btnBan: "🚫 Bloklash",
  btnUnban: "✅ Blokdan chiqarish",
  btnMakeAdmin: "⭐ Admin qilish",
  btnRemoveAdmin: "Adminlikdan olish",
  creditsGranted: (n: number, id: number, balance: number) => `${id} foydalanuvchisiga ${n} kr. qo‘shildi. Balans: ${balance}.`,
  askBroadcast: "Tarqatma matnini yuboring (bitta xabar). Obunani o‘chirmagan barcha faol foydalanuvchilar oladi.",
  broadcastConfirm: (n: number, text: string) => `${n} ta foydalanuvchiga yuborilsinmi?\n\n${text}`,
  btnSend: "✅ Yuborish",
  btnCancelPlain: "✖ Bekor qilish",
  broadcastStarted: (n: number) => `Tarqatish boshlandi: ${n} ta qabul qiluvchi (soniyasiga ≤ 20 xabar).`,
  broadcastDone: (ok: number, fail: number) => `Tarqatish tugadi: yetkazildi ${ok}, yetkazilmadi ${fail}.`,
  broadcastCancelled: "Tarqatish bekor qilindi.",
  broadcastFooter: "— Yangiliklardan voz kechish: ⚙️ Sozlamalar → 🔔 Yangiliklar",
  limitsCard: (rows: { what: string; value: number }[]) => ["⚙️ Bepul tarif limitlari (darhol o‘zgaradi, bazada saqlanadi):", ...rows.map((r, i) => `${i + 1}. ${r.what}: ${r.value}`)].join("\n"),
  adminJobFailed: (user: number, job: string, kind: string, error: string) => `⚠ ${kind} · vazifa ${job} · foydalanuvchi ${user}\n${error}`,
  btnVipOn: "✓ ⭐ VIP (olib tashlash)",
  btnVipOff: "⭐ VIP berish",
  vipSet: (id: number, on: boolean) => (on ? `⭐ VIP ${id} uchun yoqildi: kunlik limitlar va kredit yechilishisiz, botga kirish ochiq.` : `${id} dan VIP olindi: yana bepul tarif.`),
  vipUserOn: "Sizga ⭐ VIP ochildi: barcha funksiyalar kunlik limitsiz va kredit yechilmasdan. Sinab ko‘rganingiz uchun rahmat!",
  vipUsage: "Format: /vip <id yoki @username> on|off",
  allowUsage: "Format: /allow <id> [off]",
  allowSet: (id: number, on: boolean) => (on ? `Foydalanuvchi ${id} botga qo‘yildi (.env tahrirlanmasdan).` : `Foydalanuvchi ${id} ruxsat ro‘yxatidan olindi (TELEGRAM_ALLOWED_USERS da bo‘lmasa, bot unga javob bermaydi).`),
  strangerNotice: (id: number, name: string, username: string) => `👤 Notanish odam botga yozmoqda (yopiq beta): ${name}${username ? ` @${username}` : ""} · id ${id}`,
  btnLetIn: "✅ Kiritish (VIP)",
  btnIgnore: "E’tiborsiz qoldirish",
  strangerLet: (id: number) => `✅ ${id} ⭐ VIP bilan kiritildi. Unga taklif yuborildi.`,
  strangerIgnored: (id: number) => `${id} e’tiborsiz qoldirildi: u haqida boshqa xabar bo‘lmaydi.`,
  guide: {
    cards: [
      { title: "🎬 O‘z videolaringizdan montaj", body: "1 yoki bir nechta video yuboring (albom ham bo‘ladi).\n20 MB dan katta — havola bilan: Google Disk, Yandex Disk, Dropbox, YouTube.\nKartochka chiqadi: rilslar, bitta virusli, xaylaytlar; uzunlik, format, uslub.\n«▶️ Boshlash» ni bosing — tayyor roliklarni yuboraman.\nYoki shunchaki yozing: «30 soniyalik 3 ta rils»." },
      { title: "🔤 Subtitr uslublari va qo‘shimchalar", body: "Dinamik — yoritilgan katta so‘zlar, bloglar uchun.\nToza — kichik oq kichik harflar, ekspertlardek.\nPlashka bilan yoritish — so‘zlar qora plashkada yonadi.\nSplit — siz pastda, rasmlar va kartochkalar tepada.\n«Toza» va «Plashka»da so‘zlar bo‘yicha qo‘shimchalar: foto, logotip, sayt, raqamlar." },
      { title: "✨ Mavzu bo‘yicha rolik", body: "«Mavzu bo‘yicha rolik» tugmasi yoki /make — mavzuni yozing.\nFormat (9:16, 16:9, 1:1) va ovozni tanlang, ▶️ — tinglash.\nSsenariy, rasmlar, animatsiya va ovozni o‘zim qilaman.\nOdatda 5–10 daqiqa." },
      { title: "🎯 Namunadagidek montaj", body: "Namuna rilsni yuboring: fayl yoki havola (Instagram, TikTok, Shorts).\nUslubini tahlil qilaman: subtitr, sur’at, yaqinlashtirish, musiqa, rang.\nKeyin o‘z videongizni yuboring — xuddi shunday montaj qilaman." },
      { title: "🏀 O‘yin xaylaytlari", body: "O‘yin yozuvini yuboring — eng yaxshi otishlar va lahzalarni topaman.\nSekinlashtirish, takror, bitga mos musiqa.\n«Har biriga alohida» — har bir o‘yinchiga o‘z roligi." },
      { title: "🧑 Avatar", body: "Yuz fotosi (ixtiyoriy) + o‘z ovozingiz uchun 5–10 s ovozli xabar + matn yoki mavzu.\navatar_job.zip paketi va qadamma-qadam yo‘riqnoma tayyorlayman.\nGapiruvchi boshni Google Colab’da o‘zingiz ishga tushirasiz (bepul GPU, 10–20 daq).\nTayyor avatar_result.zip ni shu yerga yuboring — rolik montaj qilaman." },
      { title: "⭐ Baholar", body: "Har bir natija ostida — 1–5 ⭐.\nBahodan keyin nima chiqdi yoki chiqmadi belgilang; bir-ikki so‘z yoki ovozli xabar qo‘shish mumkin.\nHar bir fikrni o‘qiymiz va roliklarni yaxshilaymiz.\n«✏️ Tuzatish» — rolikni so‘zlaringiz bo‘yicha tuzataman." },
    ],
    head: (n: number, total: number) => `📘 Qanday foydalanish · ${n}/${total}`,
    tryIt: "▶️ Sinab ko‘rish",
    sheet: "🖼 Shpargalka",
    sheetCaption: "vedit shpargalkasi: hammasi bitta rasmda.",
    sheetMissing: "Shpargalka hozir mavjud emas — kartochkalarni ◀️ ▶️ tugmalari bilan varaqlang.",
    imageTitle: "Botdan qanday foydalanish",
    imageSub: "Telegram’dagi AI-montajchi: hammasi tugmalar bilan",
    imageFoot: "Menyu: /start · Yordam: /help · Bekor qilish: /cancel",
  },
  fb: {
    askLow: (n: number) => `Baho uchun rahmat ${"⭐".repeat(n)}. Nima chiqmadi? Bittasini yoki bir nechtasini belgilang:`,
    askHigh: (n: number) => `${"⭐".repeat(n)} uchun rahmat! Eng ko‘p nima yoqdi? Bir nechtasini tanlash mumkin:`,
    low: { subs: "Subtitrlar", vis: "Rasmlar mavzuga mos emas", dyn: "Dinamika yo‘q / zerikarli", voice: "Ovoz / talaffuz", audio: "Musiqa / ovoz effektlari", text: "Matn / faktlarda xato", cut: "Noto‘g‘ri joyda kesilgan", wait: "Uzoq kutish", other: "Boshqa" },
    high: { hook: "Hook (boshlanishi)", vis: "Rasmlar", subs: "Subtitrlar", dyn: "Dinamika", voice: "Ovoz", music: "Musiqa", all: "Hammasi a’lo" },
    done: "✅ Tayyor",
    comment: "Bir-ikki so‘z yoki ovozli xabar qo‘shishingiz mumkin — yoki Tayyor tugmasini bosing",
    thanks: "Rahmat! Fikringiz saqlandi — keyingi roliklarda hisobga olamiz.",
    heard: (text: string) => `Rahmat! Yozib oldim: «${text}»`,
    voiceKept: "Rahmat! Ovozli xabarni saqladim — qo‘lda ko‘rib chiqamiz.",
    issue: { subs: "subtitrlarda", vis: "rasmlarda", dyn: "rolik sur’atida", voice: "ovoz berishda", audio: "ovozda", text: "matnda", hook: "rolik boshida" },
    ack: (issue: string) => `Muammo ${issue} bo‘lsa kerak. Hisobga olamiz.`,
    rated: (n: number) => `${"⭐".repeat(n)} · o‘zgartirish`,
  },
  btnFeedback: "📊 Baholar",
  fbAdmin: {
    title: "📊 Baholar",
    period: (d: number) => (d > 0 ? `${d} kun` : "butun davr"),
    avg: "O‘rtacha",
    dist: "Taqsimot",
    byKind: "Turi bo‘yicha",
    byStyle: "Uslub bo‘yicha",
    byVoice: "Ovoz bo‘yicha",
    lowWhy: "Nega past (1–3⭐)",
    highWhy: "Nega yuqori (4–5⭐)",
    ai: "AI o‘z-o‘zini tekshiruvi",
    aiLine: (ok: number, skipped: number, avg: string, cost: string) => `tekshirildi ${ok}, o‘tkazib yuborildi ${skipped}, o‘rtacha ${avg}, xarajat ${cost}`,
    disagree: "AI va foydalanuvchi farqi (|farq| ≥ 2)",
    disagreeHint: "Bular o‘rganish kerak bo‘lgan holatlar: tanqidchi va odam rolikni turlicha ko‘radi.",
    none: "Hozircha baholar yo‘q.",
    recentLow: "Oxirgi past baholar",
    userSaid: "Foydalanuvchi",
    aiSaid: "AI",
    noReview: "tekshiruv yo‘q",
    confidence: "ishonch",
    btnLow: "👎 Pastlar",
    btnDisagree: "⚖️ Farqlar",
    btnVideo: "▶️ Video",
    videoGone: "Fayl tozalashda o‘chirilgan.",
    kinds: { montage: "montaj", highlights: "xaylaytlar", reference: "namunadek", make: "mavzu bo‘yicha", revise: "tuzatish", avatar: "avatar", dub: "ovoz berish" },
    criteria: { hook: "hook", visual_relevance: "rasmlar", dynamics: "dinamika", captions: "subtitrlar", audio: "ovoz", text_accuracy: "matn", overall: "umumiy" },
  },
  s31: { promo: "🎬 Promo / tushuntirish (YouTube)" },
  cp: CP_UZ,
  s30: {
    testerNotice: (id: number, name: string, username: string, slot: number, slots: number) => `👤 Yangi testchi: ${name}${username ? ` @${username}` : ""} · id ${id} (o‘rin ${slot}/${slots})`,
    btnRevoke: "🚫 Bekor qilish",
    testerRevoked: (id: number) => `🚫 ${id} ruxsati bekor qilindi — o‘rin bo‘shadi.`,
    vipPending: (username: string) => `⏳ @${username} hali botga yozmagan. Yozishi bilan ⭐ VIP bilan kiritaman (avtomatik o‘rin sarflanmaydi).`,
    vipPendingRemoved: (username: string) => `@${username} VIP kutayotganlar ro‘yxatidan olib tashlandi.`,
    pendingArrived: (id: number, name: string, username: string) => `✅ @${username} (${name}, id ${id}) botga yozdi — ⭐ VIP ochildi.`,
    adminTesters: (used: number, slots: number, testers: string[], pending: string[]) =>
      [`🧪 Testchilar avtomatik kirishi: ${used}/${slots}${testers.length ? ` — ${testers.join(", ")}` : ""}`, `⏳ VIP kutmoqda: ${pending.length ? pending.map((u) => `@${u}`).join(", ") : "—"}`].join("\n"),
    rightsAsk: (n: number) =>
      `${n > 1 ? `Bu ${n} ta video` : "Bu video"} boshqa platformadan. Qayta ishlashdan oldin tasdiqlang:\n«Bu videoga huquqim borligini yoki undan ruxsat etilgan maqsadda (sharh, iqtibos, o‘qitish) foydalanayotganimni tasdiqlayman».`,
    btnConfirm: "✅ Tasdiqlayman",
    btnCancel: "Bekor qilish",
    rightsOk: "✅ Tasdiqlandi. Yuklab olyapman…",
    rightsNo: "Yaxshi, bu videoni qayta ishlamayman. O‘z videongizni fayl yoki havola bilan yuboring.",
    rightsGone: "Bu tasdiq eskirgan — havolani qayta yuboring.",
    linkBlocked: "✖ Bu havola huquq egasining so‘rovi bilan bloklangan — uni qayta ishlab bo‘lmaydi.",
    linkLogin: "✖ Bu rolik faqat akkauntga kirgandan keyin ochiladi. Biz faqat ochiq videolarni yuklaymiz va boshqalarning loginidan foydalanmaymiz — agar huquqingiz bo‘lsa, faylning o‘zini yuboring.",
    source: "Manba",
    takedownUsage: "Format: /takedown <vazifa yoki havola> [sabab] — vazifa fayllarini o‘chiraman va havolani bloklayman.",
    takedownDone: (jobs: number, removed: number, blocked: number) => `🧹 Shikoyat bo‘yicha o‘chirish: vazifalar ${jobs}, o‘chirilgan fayl va papkalar ${removed}, bloklangan havolalar ${blocked}.`,
    takedownNothing: (target: string) => `«${target}» bo‘yicha vazifa topilmadi.`,
    linkCard: (title?: string) => `Havola bo‘yicha video olindi${title ? `: «${title}»` : ""}. Nima qilamiz?\n✂️ eng yaxshi lahzalarni kesish · 🎯 o‘z rolikingizni shunday montaj qilish · 🌐 ruscha versiya · 🧑 shu ssenariy bo‘yicha avatar — yoki pastda rilslarni tanlab «▶️ Boshlash»ni bosing.`,
    btnLinkCut: "✂️ Eng yaxshi lahzalar",
    btnLinkRef: "🎯 Rolikimni shunday montaj qil",
    btnLinkAvatar: "🧑 Shu ssenariy bo‘yicha avatar",
    btnDubOpen: "🌐 Ruscha versiya",
    btnDubToggle: "🌐 Rus tilida ovoz berish",
    refFromLink: "🔎 Bu rolikning uslubini tahlil qilyapman. Rolikning o‘zi montajingizga tushmaydi — faqat usullar: temp, subtitrlar, yaqinlashtirish, ovoz.",
    avatarFromLink: "🧑 Videodagi nutqni olib, o‘z so‘zlarim bilan qayta aytaman — shu ssenariydan avatar paketini yig‘aman. Boshqaning matnini so‘zma-so‘z ko‘chirmayman.",
    needLinkVideo: "Avval video yoki unga havola yuboring.",
    dubCard: (name: string, minutes: number) =>
      `🌐 Tarjima va ovoz berish: ${name}${minutes ? ` (≈${minutes} daq)` : ""}\nTil va ovozni tanlang. Asl nutq pastroq, tarjima ustida bo‘ladi (televizordagi kadr ortidan tarjima kabi), subtitrlar tarjima tilida. Tavsifda «Norasmiy tarjima» belgisi bo‘ladi. Muallif ovozini klonlamaymiz.`,
    modeVoiceover: "🔉 Kadr ortidan",
    modeReplace: "🔇 Nutqni almashtirish",
  },
};

const en: Strings = {
  langPrompt: ru.langPrompt,
  langName: LANG_NAMES.en,
  intro: "Hi! I’m an AI video editor: I turn your footage into short clips, make narrated videos on any topic, cut game highlights and create talking avatars. All right here in Telegram, with buttons.",
  askPurpose: "What will you use the videos for? I’ll pick settings to match.",
  purpose: { blog: "Blog / content", biz: "Business / ads", sport: "Sports", other: "Other" },
  terms: (days: number) =>
    [
      "Before we start — terms and privacy. In short:",
      "• we store your Telegram id, name, language and settings;",
      `• uploaded videos and finished clips are deleted after ${days} days;`,
      "• processing uses Anthropic (Claude), Google (Gemini) and Openverse (photos and music);",
      "• no illegal content and no other people’s videos without permission; YouTube, TikTok, Instagram videos only with the rights or for review, quotation, education (the bot asks you to confirm);",
      "• dubbed translations are marked “Unofficial translation”; we never clone anyone’s voice;",
      "• you keep all rights to your videos and clips.",
      "",
      "Full texts — buttons below.",
    ].join("\n"),
  btnTerms: "📄 Terms",
  btnPrivacy: "🔒 Privacy",
  btnAccept: "✅ I accept",
  welcome: (credits: number, std: number, long: number, longMinutes: number) =>
    `You’re all set! Trial credits: ${credits}. Free every day: ${std} standard jobs and ${long} long one (video over ${longMinutes} minutes or game highlights).\nPick what to do — buttons below.`,
  menuText: "Main menu — what shall we make?",
  menu: { montage: "🎬 Edit my videos", ref: "🎯 Edit like an example", make: "✨ Video on a topic", highlights: "🏀 Game highlights", plan: "🗓 Content plan", avatar: "🧑 Avatar", settings: "⚙️ Settings", balance: "💳 Balance", help: "❓ Help", guide: "📘 How to use" },
  needStart: "Let’s finish signing up first — just a couple of taps. /start",
  banned: "Your access to the bot is restricted. If this is a mistake, contact the administrator.",
  docMissing: "This text is not available yet.",
  help: [
    "I make short videos: edit your footage, create narrated videos on a topic, cut game highlights and make talking avatars.",
    "",
    "Buttons below:",
    "🎬 Edit — send videos (up to 20 MB; several or an album is fine; bigger ones as a Google Drive, Yandex Disk, Dropbox or YouTube link), choose what to make and tap “▶️ Start”. Or just type the task: “3 reels, 30 seconds each, Uzbek subtitles”.",
    "✨ Video on a topic — type a topic, pick the format and the voice.",
    "🏀 Highlights — a game video → best moments with slow motion and music; “one per player” — a clip for each player.",
    "🧑 Avatar — a photo and a voice note → a talking presenter (via free Google Colab).",
    "🔗 A YouTube / TikTok / Instagram link (podcast, interview, film) — best moments as reels, “edit my video like this”, 🌐 Russian version (translation and voice-over) or an avatar with the script. Other people’s videos only with the rights or for review, quotation, education.",
    "⚙️ Settings — format, style, voice, how clips are sent, language.",
    "💳 Balance — limits and credits.",
    "",
    "Commands (same as the buttons):",
    "/make <topic> — a video on a topic; /make 16:9 topic — for YouTube",
    "/viral — one most viral clip from all videos sent; /clear — new batch",
    "/revise <what to change> — edit the last montage",
    "/style pop | clean | box | split | calm — editing style",
    "/voice — voices: /voice gemini_charon — choose, /voice off — no voice",
    "/send file | video | both — how to send clips: file in original quality, video with a player, or both",
    "/avatar <text or topic> — talking avatar; send the finished avatar_result.zip here",
    "/status — what is running; /cancel — cancel",
    "/start — menu",
  ].join("\n"),
  unknownCommand: "I don’t know that command. /help — help.",
  noJob: "No jobs yet. Send a video or pick an action in the menu.",

  refAsk: (mb: number) => `Send an example — a reel you like, as a file (up to ${mb} MB) or a link (Instagram, TikTok, YouTube Shorts). I’ll break down its editing — pace, pauses, captions, punch-ins, sound and colour — and edit your video the same way. The example itself never ends up in your video.`,
  refAnalyzing: "🔎 Breaking down the example’s editing… (usually under a minute)",
  refReady: (summary: string, cached: boolean) => `🎯 Example style${cached ? " (seen before)" : ""}: ${summary}

Now send your own video — one or several. I’ll edit it in this style.`,
  refLinkFailed: "Couldn’t download the video from the link (Instagram often requires a login). Please send the video itself as a file.",
  refFailed: "Couldn’t analyse the example. Try another video or send it as a file.",
  refNeedFileOrLink: "Waiting for the example: a video file or a link to a reel.",
  refBusy: "Still analysing the previous example — one moment.",
  styleRef: "🎯 Like the example",
  montageAsk: (mb: number) => `Send your video — one or several (up to ${mb} MB each, albums are fine). Bigger videos — send a link: Google Drive, Yandex Disk, Dropbox or YouTube. Then choose what to make.`,
  highlightsAsk: (mb: number) => `Send a game or training video (up to ${mb} MB; bigger ones as a Google Drive, Yandex Disk or YouTube link). I’ll find the best moments, add slow motion and cut to the beat.`,
  needVideo: "Send a video first (as a video or a file), then type the task.",
  notVideo: "That doesn’t look like a video. Send the clip as a video or as a video/* file.",
  videoSaved: "Video received. Choose what to make and tap “▶️ Start” — or type the task in your own words (e.g. “2 reels, 20 seconds each, with subtitles”).",
  batchSaved: (n: number) => `Videos received: ${n}. By default I will edit them into one clip — pick the options and tap “▶️ Start” (or type the task in words). You can send more; /clear — start the batch over.`,
  cleared: "Batch cleared. Send new videos.",
  tooLarge: (sizeMb: number, limitMb: number, byTelegram: boolean) =>
    `${sizeMb > limitMb ? `The file is ${sizeMb} MB` : `The file is over ${limitMb} MB`}, but ${byTelegram ? "Telegram lets bots download files only" : "your plan accepts files only"} up to ${limitMb} MB — send a link to the video instead (Google Drive / Yandex Disk / Dropbox / YouTube) or compress it. Just paste the link as a message.`,
  linkStart: "⬇️ Downloading the video from the link…",
  linkProgress: (mb: number, totalMb: number) => `⬇️ Downloading the video from the link… ${mb} MB${totalMb ? ` of ${totalMb} MB` : ""}`,
  linkDone: (n: number, mb: number) => `✅ Downloaded from the link: ${n > 1 ? `${n} videos, ` : ""}${mb} MB`,
  linkTooBig: (sizeMb: number, maxMb: number) => `✖ The video at the link is too big${sizeMb ? `: ${sizeMb} MB` : ""} — the limit is ${maxMb} MB. Trim or compress it and send again.`,
  linkPrivate: "✖ The link is private. Allow access for “anyone with the link” (Google Drive: Share → General access) and send it again.",
  linkFolder: "✖ That’s a folder link. Send a link to the video file itself (a Yandex Disk folder is fine — I’ll take every video in it).",
  linkNotVideo: "✖ There’s no video at the link (or it’s a web page, not a file). Send a link to a video file or the video itself.",
  linkNoYtdlp: "✖ YouTube / Instagram / TikTok links can’t be downloaded right now. Send a Google Drive, Yandex Disk or Dropbox link — or the video itself.",
  linkFailed: "✖ Couldn’t download the video from the link. Check that it opens without signing in and send it again — or send the video as a file.",
  linkTimeout: "✖ The video took too long to download. Try again or send a smaller file.",
  linkCancelled: "The download was cancelled.",
  btnCancelDownload: "🛑 Cancel download",
  uploadFailed: "✖ Couldn’t get the file from Telegram. Please send it again.",
  photoInMontage: "Photos aren’t added to a montage yet — send a video. A photo for the avatar — in the «🧑 Avatar» menu.",
  cardStale: "This card was already used — tap ▶️ on the latest one.",
  uploadsPending: "⏳ Still uploading your videos — I’ll start right after.",
  tooLargeAdmin: "Options: compress or trim the video; or run a local Bot API server (github.com/tdlib/telegram-bot-api, --local) and set TELEGRAM_API_BASE=http://localhost:8081 — the limit becomes 2000 MB.",
  mode: { reels: "Reels from the best moments", viral: "One viral clip", hl: "Highlights", pp: "One per person" },
  countLabel: (n: number) => `${n} pcs`,
  secondsLabel: (n: number) => `${n} s`,
  styleNames: { bold_pop: "Dynamic", clean_min: "Clean (expert style)", box_reveal: "Box with highlight", split_news: "Split", explainer: "Explainer (light studio)", abror_split: "Abror (split)", abror_full: "Abror (full frame)", calm: "Calm" },
  btnStart: "▶️ Start",

  makeAskTopic: "Type the topic — e.g. “why coffee is getting more expensive in 2026”.",
  makeCard: (topic: string) => `Topic: “${topic}”\nPick the format and the voice (▶️ — voice sample) and tap “Start”.`,
  voiceAuto: "Auto",
  voiceNone: "No voice",
  makeUsage: "Type a topic: /make why coffee is getting more expensive",
  avatarMenu:
    "Talking avatar: send a photo (face, front view) and optionally a 5–10 s voice note — the avatar will have your face and voice; without them — a fictional presenter.\nThen type the text or the topic in the next message.",
  btnAvatarReset: "Forget photo and voice",
  avatarUsage: "Type a text or a topic: /avatar why coffee is getting pricier (a topic — I’ll write the monologue) or /avatar text: Hi! Today… You can send the photo and the voice note beforehand; /avatar reset — forget them.",
  avatarStart: (photo: boolean, voice: boolean, voiceId?: string) =>
    `Preparing the avatar job: ${photo ? "your photo" : "a fictional presenter (I’ll generate a portrait)"}, ${voice ? "your voice (cloned)" : voiceId ? `voice ${voiceId}` : "the standard voice"}. This takes 1–3 minutes.`,
  avatarPhotoSaved: "Photo saved for the avatar. Now /avatar <text or topic> — or type the text after the “🧑 Avatar” button.",
  avatarVoiceSaved: "Voice saved: the avatar will speak with it (5–10 s of clean speech in the text’s language). Now /avatar <text or topic>.",
  avatarReset: "Avatar photo and voice forgotten.",
  avatarNoJob: "No job found for this archive: run /avatar <text> first, then send avatar_result.zip from Colab.",
  avatarImportStart: (jobId: string) => `Got avatar_result.zip (job ${jobId}). Editing the reel: avatar at the bottom, pictures on top, subtitles, music.`,
  avatarInstructions: (jobId: string, lines: string[], warnings: string[]) =>
    [
      `The avatar job is ready (job ${jobId}) — avatar_job.zip above.`,
      "",
      "How to get the video (free, Google Colab):",
      "1. Open the colab_vedit_avatar.ipynb notebook (tools/avatar in the project) at colab.research.google.com → File → Upload notebook.",
      "2. Runtime → Change runtime type → T4 GPU, then Runtime → Run all.",
      "3. In the “Upload” cell choose avatar_job.zip.",
      "4. The first run takes ~10 minutes (install and models), then 2–5 minutes.",
      "5. avatar_result.zip will download — send it here as a file and I’ll edit the reel.",
      ...(lines.length ? ["", "Text:", ...lines.slice(0, 8).map((l, i) => `${i + 1}. ${l}`), ...(lines.length > 8 ? [`… ${lines.length - 8} more`] : [])] : []),
      ...warnings.map((w) => `⚠ ${w}`),
    ].join("\n"),

  voiceList: (current?: string, hasKey = hasGoogleTtsKey()) =>
    [
      `Voices (${current === "off" ? "now: no voice" : current ? `now: ${current}` : `now: auto — ${autoVoice("ru", hasKey).id}`}):`,
      voicesListText(current),
      "",
      "/voice <id> — choose (I’ll send a sample), /voice off — no voice.",
      `gemini_* and chirp_* are natural Google voices (cloud; needs GOOGLE_CLOUD_API_KEY or GEMINI_API_KEY${hasKey ? " — present" : " — missing, Piper speaks instead"}).`,
      "Piper voices (denis, dmitri, ljspeech, john, cori) run locally without a key; chatterbox_* — /avatar only (Colab).",
      "Without a choice /make is narrated automatically: Gemini with a key, otherwise Piper.",
      "Your own voice note for /avatar wins over the chosen voice.",
    ].join("\n"),
  voiceSet: (v: VoiceDef, hasKey = hasGoogleTtsKey()) =>
    `Voice: ${v.id}. License: ${v.license}.\n${
      isCloud(v) && !hasKey
        ? `No Google key yet — until then /make and /avatar are narrated by Piper ${piperVoiceFor(v)?.id}.`
        : isLocal(v)
          ? "It will narrate /make and /avatar."
          : `/avatar will speak with it (Colab); /make uses the local ${piperVoiceFor(v)?.id ?? "voice"}.`
    }`,
  voiceOff: "Narration off: /make is silent again, /avatar uses the standard Chatterbox voice (or your voice note).",
  voiceUnknown: (id: string) => `Unknown voice “${id}”. /voice — the list.`,
  voicePick: "Choose a voice (▶️ — sample):",
  voiceChosen: (name: string) => `Voice: ${name}`,
  sampleCaption: (id: string, forId?: string) => `sample: ${id}${forId && forId !== id ? ` (timbre for ${forId})` : ""}`,
  sampleFailed: (err: string) => `Couldn’t send the voice sample (${err}), but the voice is selected.`,
  noSample: "No sample for this voice here — it is synthesised in Colab.",
  sendUsage: (cur: string) => `Now: ${cur}. /send file — a file in original quality (default); /send video — a video with a player (Telegram compresses it); /send both — both.`,
  sendSet: (mode: SendMode) => (mode === "file" ? "I’ll send clips as files — no recompression, ready to post." : mode === "video" ? "I’ll send clips as videos (with a player; Telegram compresses them)." : "I’ll send clips both as a video (to watch) and as a file (to post)."),
  styleUsage: (cur: string) => `Now: ${cur}. Options: /style pop — dynamic subtitles; /style clean — small clean expert subtitles, B-roll on the words, no music; /style box — a line on a dark box, spoken words light up, number chips; /style split — pictures and cards on top, the speaker below; /style calm — calm.`,
  styleSet: (style: string) => `Style: ${style}. The next edit will use it.`,
  reviseUsage: "Type what to change: /revise in reel_1 remove the greeting",
  reviseNoJob: "Nothing to edit yet: make a montage first (send a video and a task).",

  settings: (s: SettingsView) =>
    [
      "⚙️ Settings",
      `Format: ${s.aspect}`,
      `Editing style: ${s.style}`,
      `Voice: ${s.voice}`,
      `Delivery: ${s.send === "file" ? "file" : s.send === "video" ? "video" : "video and file"}`,
      `Language: ${LANG_NAMES[s.lang]}`,
      `Bot news: ${s.news ? "on" : "off"}`,
    ].join("\n"),
  sendNames: { file: "File", video: "Video", both: "Both" },
  newsOn: "🔔 News: on",
  newsOff: "🔕 News: off",
  btnVoice: "🎙 Choose voice",
  btnBack: "← Back",
  saved: "Saved",

  balance: (b: BalanceView) =>
    [
      "💳 Balance",
      `Plan: ${b.admin ? "administrator (no limits)" : b.plan === "vip" ? "VIP (no limits, no charges)" : b.plan === "free" ? "free" : b.plan}`,
      `Credits: ${b.credits}`,
      `Free today: standard ${b.usedStd}/${b.std}, long ${b.usedLong}/${b.long}`,
      `Above the limit: a standard job — ${b.cs} cr., a long one (video > ${b.longMinutes} min or highlights) — ${b.cl} cr.`,
      "",
      "💎 Top up credits or unlock PRO (no watermark) — choose a package below (Uzcard / Humo / Visa card transfer).",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `The daily limit of ${long ? "long jobs" : "jobs"} is used up and there aren’t enough credits: ${need} needed, ${have} available. Choose a package below to top up or unlock 👑 PRO (💳 Balance):`,
  paidNote: (n: number, left: number) => `Credits charged: ${n}, left: ${left}.`,
  userDailyCap: (n: number) => `You have already started ${n} jobs today — that is the daily maximum. The limit resets tomorrow.`,
  budgetPaused: "The service has used up today’s AI budget — new jobs are accepted again tomorrow. Jobs already started will finish.",
  busy: "You already have one job running and two in the queue — wait for the result or cancel (/cancel).",

  kind: { run: "🎬 Edit", make: "✨ Video on a topic", revise: "✏️ Revision", avatar: "🧑 Avatar", avatar_import: "🧑 Avatar edit", dub: "🌐 Voice-over" },
  stage: {
    queued: (pos: number) => `⏳ in queue: ${pos}`,
    start: "starting",
    prepare: "preparing the video",
    understand: "understanding the video",
    plan: "plan",
    cut: "cutting",
    render: (pct: number) => `render ${pct}%`,
    audio: "sound",
    script: "script",
    design: "design",
    send: "sending",
    done: "✅ done",
    cancelled: "🛑 cancelled",
    failed: "✖ failed",
  },
  btnCancel: "🛑 Cancel",
  cancelling: "Cancelling — stopping the process.",
  cancelled: "Cancelled.",
  nothingToCancel: "Nothing is running right now.",
  notYours: "This is not your job.",

  done: (n: number, job: string) => `Done: ${n} clip(s), job ${job}.`,
  noNew: (job: string) => `No new clips (job ${job}).`,
  reviseHint: "Edits: the “✏️ Edit” button or /revise <what to change>",
  rateAsk: "Rate the result:",
  btnAgain: "🔁 Another take",
  btnEdit: "✏️ Edit",
  btnFormat: "📐 Other format",
  rated: (n: number) => `Thanks! Rating: ${"⭐".repeat(n)}`,
  askEdit: "Type what to fix — e.g. “remove the greeting, bigger subtitles”.",
  failed: "Couldn’t make the video — something went wrong during processing. Try again or change the task.",
  btnRetry: "🔁 Try again",
  restarted: "The bot restarted and the job was interrupted. Tap “Try again” — it was not counted against your limit.",
  jobGone: "This job is no longer available.",
  tooBigToSend: "Couldn’t send the clip through Telegram (too big). Try a shorter clip or contact the administrator.",
  creditsGrantedUser: (n: number, balance: number) => `You received ${n} credits. Balance: ${balance}.`,

  statusNow: (kind: string, stage: string, sec: number, aborting: boolean) => `Now: ${kind}, step “${stage}”, ${sec} s${aborting ? " (cancelling)" : ""}`,
  statusQueued: (kind: string, pos: number) => `Queued: ${kind}, position ${pos}`,
  statusVideo: (name: string) => `Video: ${name}`,
  statusTask: (prompt: string) => `Task: ${prompt}`,
  statusJobMissing: (id: string) => `job ${id}: not found in the workspace`,

  adminMenu: "Admin:",
  btnStats: "📊 Stats",
  btnFind: "👤 Find a user",
  btnBroadcast: "📣 Broadcast",
  btnLimits: "⚙️ Limits",
  stats: (s: StatsView) =>
    [
      "📊 Stats",
      `Users: ${s.users} (new today ${s.usersToday}, active today ${s.activeToday}, banned ${s.banned})`,
      `Jobs in 7 days by status: ${s.byStatus.map((x) => `${x.status} ${x.n}`).join(", ") || "—"}`,
      `by kind: ${s.byKind.map((x) => `${x.kind} ${x.n}`).join(", ") || "—"}`,
      `Spend: today ${usd(s.costToday)}, 7 days ${usd(s.cost7d)}`,
      `Queue: running ${s.running}/${s.maxJobs}, waiting ${s.queued}`,
      `Ratings: ${s.ratings ? `${s.ratingAvg!.toFixed(2)} ⭐ (${s.ratings})` : "—"}`,
    ].join("\n"),
  askUser: "Send the user id or @username.",
  userNotFound: (q: string) => `User “${q}” not found.`,
  userCard: (u: UserCardView) =>
    [
      `👤 ${u.name ?? "—"}${u.username ? ` @${u.username}` : ""} · id ${u.id}`,
      `Language: ${u.lang}, purpose: ${u.purpose ?? "—"}, role: ${u.role}, status: ${u.status}`,
      `Plan: ${u.plan}, credits: ${u.credits}`,
      `Joined ${u.created.slice(0, 10)}, last seen ${u.lastSeen?.slice(0, 16).replace("T", " ") ?? "—"}`,
      `Jobs: ${u.jobs} (done ${u.done}, failed ${u.failed}), spend ${usd(u.cost)}`,
      `Today: standard ${u.todayStd}, long ${u.todayLong}`,
    ].join("\n"),
  btnCredits: (n: number) => `+${n} cr.`,
  btnBan: "🚫 Ban",
  btnUnban: "✅ Unban",
  btnMakeAdmin: "⭐ Make admin",
  btnRemoveAdmin: "Remove admin",
  creditsGranted: (n: number, id: number, balance: number) => `Granted ${n} cr. to user ${id}. Balance: ${balance}.`,
  askBroadcast: "Send the broadcast text (one message). All active users get it, except those who opted out.",
  broadcastConfirm: (n: number, text: string) => `Send to ${n} users?\n\n${text}`,
  btnSend: "✅ Send",
  btnCancelPlain: "✖ Cancel",
  broadcastStarted: (n: number) => `Broadcast started: ${n} recipients (≤ 20 messages per second).`,
  broadcastDone: (ok: number, fail: number) => `Broadcast finished: delivered ${ok}, failed ${fail}.`,
  broadcastCancelled: "Broadcast cancelled.",
  broadcastFooter: "— Unsubscribe from news: ⚙️ Settings → 🔔 News",
  limitsCard: (rows: { what: string; value: number }[]) => ["⚙️ Free plan limits (applied immediately, stored in the database):", ...rows.map((r, i) => `${i + 1}. ${r.what}: ${r.value}`)].join("\n"),
  adminJobFailed: (user: number, job: string, kind: string, error: string) => `⚠ ${kind} · job ${job} · user ${user}\n${error}`,
  btnVipOn: "✓ ⭐ VIP (remove)",
  btnVipOff: "⭐ Grant VIP",
  vipSet: (id: number, on: boolean) => (on ? `⭐ VIP on for ${id}: no daily limits or charges, access to the bot granted.` : `VIP removed from ${id}: back to the free plan.`),
  vipUserOn: "You now have ⭐ VIP access: every feature with no daily limits and no credit charges. Thank you for testing!",
  vipUsage: "Usage: /vip <id or @username> on|off",
  allowUsage: "Usage: /allow <id> [off]",
  allowSet: (id: number, on: boolean) => (on ? `User ${id} can use the bot now (no .env edit needed).` : `User ${id} removed from the allowlist (unless listed in TELEGRAM_ALLOWED_USERS, the bot stops answering them).`),
  strangerNotice: (id: number, name: string, username: string) => `👤 A stranger is writing to the bot (closed beta): ${name}${username ? ` @${username}` : ""} · id ${id}`,
  btnLetIn: "✅ Let in (VIP)",
  btnIgnore: "Ignore",
  strangerLet: (id: number) => `✅ ${id} let in with ⭐ VIP. An invitation was sent.`,
  strangerIgnored: (id: number) => `Ignoring ${id}: no more notices about them.`,
  guide: {
    cards: [
      { title: "🎬 Edit your own videos", body: "Send 1 or more videos (an album works too).\nOver 20 MB — send a link: Google Drive, Yandex Disk, Dropbox, YouTube.\nA card appears: reels, one viral clip, highlights; length, format, style.\nTap «▶️ Start» — I send the finished clips.\nOr just write: “3 reels of 30 seconds”." },
      { title: "🔤 Caption styles and inserts", body: "Dynamic — big highlighted words, for blogs.\nClean — small white lowercase, expert style.\nBox with highlight — words light up on a dark box.\nSplit — you at the bottom, pictures and cards on top.\nClean and Box add inserts on words: photos, logos, sites, numbers." },
      { title: "✨ Video on a topic", body: "The «Video on a topic» button or /make — write a topic.\nPick a format (9:16, 16:9, 1:1) and a voice, ▶️ to listen.\nI write the script and make pictures, animation and voiceover.\nUsually 5–10 minutes." },
      { title: "🎯 Edit like an example", body: "Send an example reel: a file or a link (Instagram, TikTok, Shorts).\nI study its style: captions, pace, zooms, music, colour.\nThen send your video — I edit it the same way." },
      { title: "🏀 Game highlights", body: "Send a game recording — I find the best shots and moments.\nSlow motion, replay, music on the beat.\n«One per person» — a separate clip for every player." },
      { title: "🧑 Avatar", body: "A face photo (optional) + a 5–10 s voice note for your voice + a text or topic.\nI prepare avatar_job.zip and step-by-step instructions.\nYou run the talking head yourself in Google Colab (free GPU, 10–20 min).\nSend the finished avatar_result.zip here — I edit the video." },
      { title: "⭐ Ratings", body: "Every result has 1–5 ⭐ under it.\nAfter rating, mark what worked or not; add a few words or a voice note.\nWe read every review and improve the videos with it.\n«✏️ Edit» — I fix the video by your words." },
    ],
    head: (n: number, total: number) => `📘 How to use · ${n}/${total}`,
    tryIt: "▶️ Try it",
    sheet: "🖼 Cheat sheet",
    sheetCaption: "vedit cheat sheet: everything in one picture.",
    sheetMissing: "The cheat sheet is not available right now — flip the cards with ◀️ ▶️.",
    imageTitle: "How to use the bot",
    imageSub: "An AI video editor in Telegram: all with buttons",
    imageFoot: "Menu: /start · Help: /help · Cancel: /cancel",
  },
  fb: {
    askLow: (n: number) => `Thanks for the ${"⭐".repeat(n)}. What went wrong? Pick one or more:`,
    askHigh: (n: number) => `Thanks for the ${"⭐".repeat(n)}! What did you like most? You can pick several:`,
    low: { subs: "Captions", vis: "Off-topic pictures", dyn: "No pace / boring", voice: "Voice / pronunciation", audio: "Music / sound", text: "Mistake in text / facts", cut: "Cut in the wrong place", wait: "Took too long", other: "Other" },
    high: { hook: "Hook", vis: "Pictures", subs: "Captions", dyn: "Pace", voice: "Voice", music: "Music", all: "Everything was great" },
    done: "✅ Done",
    comment: "You can add a few words or a voice note — or tap Done",
    thanks: "Thank you! Feedback saved — we will use it in the next videos.",
    heard: (text: string) => `Thank you! Noted: “${text}”`,
    voiceKept: "Thank you! Voice note saved — we will go through it by hand.",
    issue: { subs: "with the captions", vis: "with the pictures", dyn: "with the pace", voice: "with the voiceover", audio: "with the sound", text: "with the text", hook: "with the opening" },
    ack: (issue: string) => `Looks like the problem is ${issue}. We will take it into account.`,
    rated: (n: number) => `${"⭐".repeat(n)} · edit`,
  },
  btnFeedback: "📊 Ratings",
  fbAdmin: {
    title: "📊 Ratings",
    period: (d: number) => (d > 0 ? `${d} d` : "all time"),
    avg: "Average",
    dist: "Distribution",
    byKind: "By kind",
    byStyle: "By style",
    byVoice: "By voice",
    lowWhy: "Why low (1–3⭐)",
    highWhy: "Why high (4–5⭐)",
    ai: "AI self-review",
    aiLine: (ok: number, skipped: number, avg: string, cost: string) => `reviewed ${ok}, skipped ${skipped}, average ${avg}, cost ${cost}`,
    disagree: "AI vs users disagreements (|diff| ≥ 2)",
    disagreeHint: "These are the cases to learn from: the critic and the person see the video differently.",
    none: "No ratings yet.",
    recentLow: "Recent low ratings",
    userSaid: "User",
    aiSaid: "AI",
    noReview: "no self-review",
    confidence: "confidence",
    btnLow: "👎 Low",
    btnDisagree: "⚖️ Disagreements",
    btnVideo: "▶️ Video",
    videoGone: "The file was already removed by the cleanup.",
    kinds: { montage: "montage", highlights: "highlights", reference: "like example", make: "topic video", revise: "revision", avatar: "avatar", dub: "voice-over" },
    criteria: { hook: "hook", visual_relevance: "pictures", dynamics: "pace", captions: "captions", audio: "sound", text_accuracy: "text", overall: "overall" },
  },
  s31: { promo: "🎬 Promo / explainer (YouTube)" },
  cp: CP_EN,
  s30: {
    testerNotice: (id: number, name: string, username: string, slot: number, slots: number) => `👤 New tester: ${name}${username ? ` @${username}` : ""} · id ${id} (slot ${slot}/${slots})`,
    btnRevoke: "🚫 Revoke",
    testerRevoked: (id: number) => `🚫 Access of ${id} revoked — the slot is free again.`,
    vipPending: (username: string) => `⏳ @${username} has not written to the bot yet. As soon as they do, they get in with ⭐ VIP (no auto slot used).`,
    vipPendingRemoved: (username: string) => `@${username} removed from the pending VIP list.`,
    pendingArrived: (id: number, name: string, username: string) => `✅ @${username} (${name}, id ${id}) wrote to the bot — ⭐ VIP is on.`,
    adminTesters: (used: number, slots: number, testers: string[], pending: string[]) =>
      [`🧪 Tester auto-access: ${used}/${slots}${testers.length ? ` — ${testers.join(", ")}` : ""}`, `⏳ Pending VIP: ${pending.length ? pending.map((u) => `@${u}`).join(", ") : "—"}`].join("\n"),
    rightsAsk: (n: number) =>
      `${n > 1 ? `These ${n} videos are` : "This video is"} from someone else's platform. Before processing, please confirm:\n“I confirm that I have the rights to this video or use it for a permitted purpose (review, quotation, education).”`,
    btnConfirm: "✅ I confirm",
    btnCancel: "Cancel",
    rightsOk: "✅ Confirmed. Downloading…",
    rightsNo: "OK, I will not process this video. Send your own video as a file or a link.",
    rightsGone: "This confirmation is out of date — send the link again.",
    linkBlocked: "✖ This link is blocked at the rights holder's request — it cannot be processed.",
    linkLogin: "✖ This video opens only for signed-in accounts. We download public videos only and never use anyone's login — send the file itself if you have the rights to it.",
    source: "Source",
    takedownUsage: "Format: /takedown <job or link> [reason] — deletes the job's files and blocks the link.",
    takedownDone: (jobs: number, removed: number, blocked: number) => `🧹 Takedown: ${jobs} job(s), ${removed} file(s)/folder(s) deleted, ${blocked} link(s) blocked.`,
    takedownNothing: (target: string) => `No jobs found for “${target}”.`,
    linkCard: (title?: string) => `Video from the link received${title ? `: “${title}”` : ""}. What should I do?\n✂️ cut the best moments · 🎯 edit your video the same way · 🌐 Russian version · 🧑 an avatar with this script — or pick reels below and press “▶️ Start”.`,
    btnLinkCut: "✂️ Best moments as reels",
    btnLinkRef: "🎯 Edit my video like this",
    btnLinkAvatar: "🧑 Avatar with this script",
    btnDubOpen: "🌐 Russian version",
    btnDubToggle: "🌐 Russian voice-over",
    refFromLink: "🔎 Analysing this video's style. The video itself never goes into your edit — only the techniques: pace, captions, zooms, sound.",
    avatarFromLink: "🧑 Taking the speech from the video and retelling it in my own words — this script becomes an avatar bundle. I do not copy someone else's text word for word.",
    needLinkVideo: "Send a video or a link to it first.",
    dubCard: (name: string, minutes: number) =>
      `🌐 Translation and voice-over: ${name}${minutes ? ` (≈${minutes} min)` : ""}\nChoose the language and the voice. The original gets quieter with the translation on top (a TV-style voice-over), captions in the target language. The description is marked “Unofficial translation”. We never clone the author's voice.`,
    modeVoiceover: "🔉 Voice-over",
    modeReplace: "🔇 Replace speech",
  },
};

export const STRINGS: Record<Lang, Strings> = { ru, uz, en };

export const t = (lang: Lang | undefined | null): Strings => STRINGS[lang ?? "ru"] ?? ru;

export type MenuAction = keyof Strings["menu"];

/** main-menu (reply keyboard) button text in any language → action */
export function menuAction(text: string): MenuAction | undefined {
  const s = text.trim();
  for (const lang of Object.keys(STRINGS) as Lang[]) {
    for (const [k, label] of Object.entries(STRINGS[lang].menu)) if (label === s) return k as MenuAction;
  }
  return undefined;
}

/** a voice as a short button label: "Харон (Gemini)" in Russian, "Charon (Gemini) ♂" elsewhere */
export function voiceLabel(v: VoiceDef, lang: Lang): string {
  const sign = v.gender === "female" ? "♀" : "♂";
  if (lang === "ru") return `${v.name.split(" — ")[0]} ${sign}`;
  const engine = v.engine === "gemini" ? " (Gemini)" : v.engine === "chirp3" ? " (Chirp)" : v.engine === "chatterbox" ? " (Chatterbox)" : "";
  const base = v.gemini?.voiceName ?? (v.id === "ljspeech" ? "LJ" : v.id.replace(/^chatterbox_/, "").replace(/^\w/, (c) => c.toUpperCase()));
  return `${base}${engine} ${sign}`;
}
