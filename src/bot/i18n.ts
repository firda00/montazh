// Every user-facing string of the bot in three languages: Russian, Uzbek (Latin script), English.
// `ru` defines the shape; `uz` and `en` are typed against it, so a missing key is a compile error, and
// tests/stage19-users.test.ts walks all three tables (no empty strings, same function arity).
import { autoVoice, GEMINI_LICENSE_NOTE, isCloud, isLocal, piperVoiceFor, voicesListText, type VoiceDef } from "../voice/catalog.ts";
import { geminiApiKey } from "../voice/gemini.ts";
import { cloudApiKey } from "../voice/cloudtts.ts";
import { TTS_KEYS_HELP } from "../voice/piper.ts";
import type { Lang } from "./db.ts";

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
      "• нельзя присылать незаконный контент и чужие видео без разрешения;",
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
  menu: { montage: "🎬 Монтаж из моих видео", ref: "🎯 Монтаж как в примере", make: "✨ Ролик по теме", highlights: "🏀 Хайлайты игры", avatar: "🧑 Аватар", settings: "⚙️ Настройки", balance: "💳 Баланс", help: "❓ Помощь" },
  needStart: "Сначала закончим регистрацию — это пара нажатий. /start",
  banned: "Доступ к боту ограничен. Если это ошибка — напишите администратору.",
  docMissing: "Текст пока недоступен.",
  help: [
    "Я делаю короткие ролики: монтирую ваши видео, делаю ролики по теме с озвучкой, хайлайты игр и говорящих аватаров.",
    "",
    "Кнопки внизу:",
    "🎬 Монтаж — пришлите видео (до 20 МБ; можно несколько или альбомом), выберите, что сделать, и нажмите «▶️ Начать». Или просто напишите задачу: «3 рилса по 30 секунд, субтитры на узбекском».",
    "✨ Ролик по теме — напишите тему, выберите формат и голос.",
    "🏀 Хайлайты — видео игры → лучшие моменты с замедлением и музыкой; «по отдельности» — ролик на каждого игрока.",
    "🧑 Аватар — фото и голосовое → говорящий ведущий (через бесплатный Google Colab).",
    "⚙️ Настройки — формат, стиль, голос, как присылать ролики, язык.",
    "💳 Баланс — лимиты и кредиты.",
    "",
    "Команды (то же, что кнопки):",
    "/make <тема> — ролик по теме; /make 16:9 тема — для YouTube",
    "/viral — один самый вирусный ролик из всех присланных видео; /clear — новая подборка",
    "/revise <что изменить> — правка последнего монтажа (перережу и перерендерю только затронутое)",
    "/style pop | split | calm — стиль монтажа",
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
  montageAsk: (mb: number) => `Пришлите видео — одно или несколько (до ${mb} МБ каждое, можно альбомом). Потом выберите, что сделать.`,
  highlightsAsk: (mb: number) => `Пришлите видео игры или тренировки (до ${mb} МБ). Найду лучшие моменты, сделаю замедления и наложу музыку по битам.`,
  needVideo: "Сначала пришлите видео (как видео или файлом), потом напишите задачу.",
  notVideo: "Это не похоже на видео. Пришлите ролик как видео или файлом с типом video/*.",
  videoSaved: "Видео получено. Выберите, что сделать, и нажмите «▶️ Начать» — или напишите задачу своими словами (например, «2 рилса по 20 секунд с субтитрами»).",
  batchSaved: (n: number) => `Получено видео: ${n}. По умолчанию склею их в один ролик — выберите настройки и нажмите «▶️ Начать» (или напишите задачу словами). Можно дослать ещё видео; /clear — начать подборку заново.`,
  cleared: "Подборка очищена. Пришлите новые видео.",
  tooLarge: (sizeMb: number, limitMb: number) => `Файл слишком большой: ${sizeMb} МБ, а сейчас можно до ${limitMb} МБ. Сожмите видео или обрежьте лишнее и пришлите снова.`,
  tooLargeAdmin:
    "Варианты: сожмите видео или обрежьте лишнее; либо запустите локальный сервер Bot API (github.com/tdlib/telegram-bot-api, флаг --local) и укажите TELEGRAM_API_BASE=http://localhost:8081 — тогда лимит 2000 МБ.",
  mode: { reels: "Рилсы из лучших моментов", viral: "Один вирусный ролик", hl: "Хайлайты", pp: "По отдельности на каждого" },
  countLabel: (n: number) => `${n} шт`,
  secondsLabel: (n: number) => `${n} с`,
  styleNames: { bold_pop: "Динамичный", split_news: "Сплит", calm: "Спокойный" } as Record<string, string>,
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
  styleUsage: (cur: string) => `Сейчас: ${cur}. Варианты: /style pop — динамичные субтитры; /style split — сверху картинки и карточки, снизу спикер (как у новостных техно-блогеров); /style calm — спокойный.`,
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
      `Тариф: ${b.admin ? "администратор (без лимитов)" : b.plan === "free" ? "бесплатный" : b.plan}`,
      `Кредиты: ${b.credits}`,
      `Сегодня бесплатно: обычных ${b.usedStd}/${b.std}, длинных ${b.usedLong}/${b.long}`,
      `Сверх лимита: обычная задача — ${b.cs} кр., длинная (видео > ${b.longMinutes} мин или хайлайты) — ${b.cl} кр.`,
      "",
      "Скоро: оплата. Пока кредиты начисляет администратор.",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `Дневной лимит ${long ? "длинных задач" : "задач"} исчерпан, а кредитов не хватает: нужно ${need}, есть ${have}. Лимит обновится завтра. Скоро: оплата — 💳 Баланс.`,
  paidNote: (n: number, left: number) => `Списано кредитов: ${n}, осталось ${left}.`,
  userDailyCap: (n: number) => `Сегодня вы уже запустили ${n} задач — это дневной максимум. Лимит обновится завтра.`,
  budgetPaused: "Сервис на сегодня исчерпал дневной бюджет на ИИ — новые задачи принимаются завтра. Уже запущенные доделаются.",
  busy: "У вас уже есть задача в работе и две в очереди — дождитесь результата или отмените (/cancel).",

  kind: { run: "🎬 Монтаж", make: "✨ Ролик по теме", revise: "✏️ Правка", avatar: "🧑 Аватар", avatar_import: "🧑 Монтаж аватара" } as Record<string, string>,
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
      "• noqonuniy kontent va boshqalarning videolarini ruxsatsiz yuborish mumkin emas;",
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
  menu: { montage: "🎬 Videolarimdan montaj", ref: "🎯 Namunadagidek montaj", make: "✨ Mavzu bo‘yicha rolik", highlights: "🏀 O‘yin xaylaytlari", avatar: "🧑 Avatar", settings: "⚙️ Sozlamalar", balance: "💳 Balans", help: "❓ Yordam" },
  needStart: "Avval ro‘yxatdan o‘tishni yakunlaylik — bir necha bosish xolos. /start",
  banned: "Botdan foydalanish cheklangan. Agar bu xato bo‘lsa — administratorga yozing.",
  docMissing: "Matn hozircha mavjud emas.",
  help: [
    "Men qisqa roliklar tayyorlayman: videolaringizni montaj qilaman, mavzu bo‘yicha ovozli roliklar, o‘yin xaylaytlari va gapiradigan avatarlar yasayman.",
    "",
    "Pastdagi tugmalar:",
    "🎬 Montaj — video yuboring (20 MB gacha; bir nechta yoki albom bo‘lishi mumkin), nima qilishni tanlang va «▶️ Boshlash»ni bosing. Yoki vazifani o‘zingiz yozing: «30 soniyalik 3 ta rils, o‘zbekcha subtitrlar bilan».",
    "✨ Mavzu bo‘yicha rolik — mavzuni yozing, format va ovozni tanlang.",
    "🏀 Xaylaytlar — o‘yin videosi → sekinlashtirish va musiqa bilan eng yaxshi lahzalar; «alohida» — har bir o‘yinchiga alohida rolik.",
    "🧑 Avatar — rasm va ovozli xabar → gapiradigan boshlovchi (bepul Google Colab orqali).",
    "⚙️ Sozlamalar — format, uslub, ovoz, roliklarni qanday yuborish, til.",
    "💳 Balans — limitlar va kreditlar.",
    "",
    "Buyruqlar (tugmalar bilan bir xil):",
    "/make <mavzu> — mavzu bo‘yicha rolik; /make 16:9 mavzu — YouTube uchun",
    "/viral — yuborilgan barcha videolardan bitta eng virusli rolik; /clear — yangi to‘plam",
    "/revise <nimani o‘zgartirish> — oxirgi montajni tuzatish",
    "/style pop | split | calm — montaj uslubi",
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
  montageAsk: (mb: number) => `Video yuboring — bitta yoki bir nechta (har biri ${mb} MB gacha, albom ham mumkin). Keyin nima qilishni tanlaysiz.`,
  highlightsAsk: (mb: number) => `O‘yin yoki mashg‘ulot videosini yuboring (${mb} MB gacha). Eng yaxshi lahzalarni topib, sekinlashtiraman va musiqani ritmga moslayman.`,
  needVideo: "Avval video yuboring (video yoki fayl sifatida), keyin vazifani yozing.",
  notVideo: "Bu videoga o‘xshamayapti. Rolikni video yoki video/* turidagi fayl sifatida yuboring.",
  videoSaved: "Video qabul qilindi. Nima qilishni tanlang va «▶️ Boshlash»ni bosing — yoki vazifani o‘z so‘zlaringiz bilan yozing (masalan, «subtitrli 20 soniyalik 2 ta rils»).",
  batchSaved: (n: number) => `Qabul qilingan videolar: ${n}. Odatda ularni bitta rolikka yig‘aman — sozlamalarni tanlang va «▶️ Boshlash»ni bosing (yoki vazifani so‘z bilan yozing). Yana video yuborish mumkin; /clear — to‘plamni qaytadan boshlash.`,
  cleared: "To‘plam tozalandi. Yangi videolarni yuboring.",
  tooLarge: (sizeMb: number, limitMb: number) => `Fayl juda katta: ${sizeMb} MB, hozir esa ${limitMb} MB gacha mumkin. Videoni siqing yoki ortiqchasini qirqib, qayta yuboring.`,
  tooLargeAdmin: "Variantlar: videoni siqing yoki qirqing; yoki lokal Bot API serverini ishga tushiring (github.com/tdlib/telegram-bot-api, --local) va TELEGRAM_API_BASE=http://localhost:8081 ni ko‘rsating — shunda limit 2000 MB.",
  mode: { reels: "Eng yaxshi lahzalardan rilslar", viral: "Bitta virusli rolik", hl: "Xaylaytlar", pp: "Har biriga alohida" },
  countLabel: (n: number) => `${n} ta`,
  secondsLabel: (n: number) => `${n} s`,
  styleNames: { bold_pop: "Dinamik", split_news: "Split", calm: "Sokin" },
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
  styleUsage: (cur: string) => `Hozir: ${cur}. Variantlar: /style pop — dinamik subtitrlar; /style split — tepada rasmlar va kartochkalar, pastda spiker; /style calm — sokin.`,
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
      `Tarif: ${b.admin ? "administrator (limitsiz)" : b.plan === "free" ? "bepul" : b.plan}`,
      `Kreditlar: ${b.credits}`,
      `Bugun bepul: oddiy ${b.usedStd}/${b.std}, uzun ${b.usedLong}/${b.long}`,
      `Limitdan ortiq: oddiy vazifa — ${b.cs} kr., uzun (${b.longMinutes} daqiqadan uzun video yoki xaylaytlar) — ${b.cl} kr.`,
      "",
      "Tez orada: to‘lov. Hozircha kreditlarni administrator beradi.",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `Kunlik ${long ? "uzun vazifalar" : "vazifalar"} limiti tugadi, kreditlar esa yetmaydi: ${need} kerak, ${have} bor. Limit ertaga yangilanadi. Tez orada: to‘lov — 💳 Balans.`,
  paidNote: (n: number, left: number) => `${n} kredit yechildi, ${left} qoldi.`,
  userDailyCap: (n: number) => `Bugun siz allaqachon ${n} ta vazifa boshladingiz — bu kunlik maksimum. Limit ertaga yangilanadi.`,
  budgetPaused: "Xizmat bugungi AI byudjetini tugatdi — yangi vazifalar ertaga qabul qilinadi. Boshlanganlari yakunlanadi.",
  busy: "Sizda bitta vazifa bajarilmoqda va ikkitasi navbatda — natijani kuting yoki bekor qiling (/cancel).",

  kind: { run: "🎬 Montaj", make: "✨ Mavzu bo‘yicha rolik", revise: "✏️ Tuzatish", avatar: "🧑 Avatar", avatar_import: "🧑 Avatar montaji" },
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
      "• no illegal content and no other people’s videos without permission;",
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
  menu: { montage: "🎬 Edit my videos", ref: "🎯 Edit like an example", make: "✨ Video on a topic", highlights: "🏀 Game highlights", avatar: "🧑 Avatar", settings: "⚙️ Settings", balance: "💳 Balance", help: "❓ Help" },
  needStart: "Let’s finish signing up first — just a couple of taps. /start",
  banned: "Your access to the bot is restricted. If this is a mistake, contact the administrator.",
  docMissing: "This text is not available yet.",
  help: [
    "I make short videos: edit your footage, create narrated videos on a topic, cut game highlights and make talking avatars.",
    "",
    "Buttons below:",
    "🎬 Edit — send videos (up to 20 MB; several or an album is fine), choose what to make and tap “▶️ Start”. Or just type the task: “3 reels, 30 seconds each, Uzbek subtitles”.",
    "✨ Video on a topic — type a topic, pick the format and the voice.",
    "🏀 Highlights — a game video → best moments with slow motion and music; “one per player” — a clip for each player.",
    "🧑 Avatar — a photo and a voice note → a talking presenter (via free Google Colab).",
    "⚙️ Settings — format, style, voice, how clips are sent, language.",
    "💳 Balance — limits and credits.",
    "",
    "Commands (same as the buttons):",
    "/make <topic> — a video on a topic; /make 16:9 topic — for YouTube",
    "/viral — one most viral clip from all videos sent; /clear — new batch",
    "/revise <what to change> — edit the last montage",
    "/style pop | split | calm — editing style",
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
  montageAsk: (mb: number) => `Send your video — one or several (up to ${mb} MB each, albums are fine). Then choose what to make.`,
  highlightsAsk: (mb: number) => `Send a game or training video (up to ${mb} MB). I’ll find the best moments, add slow motion and cut to the beat.`,
  needVideo: "Send a video first (as a video or a file), then type the task.",
  notVideo: "That doesn’t look like a video. Send the clip as a video or as a video/* file.",
  videoSaved: "Video received. Choose what to make and tap “▶️ Start” — or type the task in your own words (e.g. “2 reels, 20 seconds each, with subtitles”).",
  batchSaved: (n: number) => `Videos received: ${n}. By default I will edit them into one clip — pick the options and tap “▶️ Start” (or type the task in words). You can send more; /clear — start the batch over.`,
  cleared: "Batch cleared. Send new videos.",
  tooLarge: (sizeMb: number, limitMb: number) => `The file is too big: ${sizeMb} MB, the limit right now is ${limitMb} MB. Compress or trim the video and send it again.`,
  tooLargeAdmin: "Options: compress or trim the video; or run a local Bot API server (github.com/tdlib/telegram-bot-api, --local) and set TELEGRAM_API_BASE=http://localhost:8081 — the limit becomes 2000 MB.",
  mode: { reels: "Reels from the best moments", viral: "One viral clip", hl: "Highlights", pp: "One per person" },
  countLabel: (n: number) => `${n} pcs`,
  secondsLabel: (n: number) => `${n} s`,
  styleNames: { bold_pop: "Dynamic", split_news: "Split", calm: "Calm" },
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
  styleUsage: (cur: string) => `Now: ${cur}. Options: /style pop — dynamic subtitles; /style split — pictures and cards on top, the speaker below; /style calm — calm.`,
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
      `Plan: ${b.admin ? "administrator (no limits)" : b.plan === "free" ? "free" : b.plan}`,
      `Credits: ${b.credits}`,
      `Free today: standard ${b.usedStd}/${b.std}, long ${b.usedLong}/${b.long}`,
      `Above the limit: a standard job — ${b.cs} cr., a long one (video > ${b.longMinutes} min or highlights) — ${b.cl} cr.`,
      "",
      "Coming soon: payments. For now credits are granted by the administrator.",
    ].join("\n"),
  quotaExceeded: (long: boolean, need: number, have: number) =>
    `The daily limit of ${long ? "long jobs" : "jobs"} is used up and there aren’t enough credits: ${need} needed, ${have} available. The limit resets tomorrow. Payments are coming soon — 💳 Balance.`,
  paidNote: (n: number, left: number) => `Credits charged: ${n}, left: ${left}.`,
  userDailyCap: (n: number) => `You have already started ${n} jobs today — that is the daily maximum. The limit resets tomorrow.`,
  budgetPaused: "The service has used up today’s AI budget — new jobs are accepted again tomorrow. Jobs already started will finish.",
  busy: "You already have one job running and two in the queue — wait for the result or cancel (/cancel).",

  kind: { run: "🎬 Edit", make: "✨ Video on a topic", revise: "✏️ Revision", avatar: "🧑 Avatar", avatar_import: "🧑 Avatar edit" },
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
