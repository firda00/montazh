# Деплой vedit-бота на сервер

Сервер: Oracle Cloud Always Free, **Ubuntu 24.04 ARM64** (VM.Standard.A1.Flex, 1 OCPU / 6 ГБ или 2 OCPU / 12 ГБ,
150 ГБ диска), пользователь `ubuntu`, ключ `~/.ssh/vedit_oracle`. Входящие порты — только 22: бот забирает сообщения
из Telegram сам (long polling), веб-сервер не нужен. GPU нет.

На сервере нет входов разработчика (Antigravity, подписка Claude Code) — только ключи из `.env`. Бот работает в
**серверном режиме** (`VEDIT_SERVER=1`): Claude — через API, тренды — Gemini + Google Search, ИИ-картинки — Gemini
image API, понимание кадра — Gemini API, одна тяжёлая задача за раз.

## Файлы

| файл | где запускается | что делает |
|---|---|---|
| `deploy.sh` | ноутбук, Git Bash | заливает коммит на сервер и перезапускает бота (при первом запуске сам готовит сервер) |
| `setup-ubuntu.sh` | сервер, `sudo` | подготовка свежей Ubuntu: swap, пакеты, Node 24, Chrome, пользователь `vedit`, автообновления, файрвол, systemd |
| `remote-update.sh` | сервер, `sudo` (его вызывает `deploy.sh`) | checkout, `npm ci`, whisper.cpp, Piper, `.env`, `vedit doctor`, рестарт, логи |
| `telegram-bot-api.sh` | сервер, `sudo` (по желанию) | локальный Bot API: файлы до 2 ГБ (нужны api_id/api_hash владельца, см. ниже) |
| `build-whisper.sh` | сервер (или любой Linux) | сборка whisper.cpp v1.9.5 из исходников (`-DGGML_NATIVE=ON`) + модель large-v3-turbo q5_0 |

## Первый деплой

1. В `.env` на ноутбуке должны быть: `TELEGRAM_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
   `TELEGRAM_ADMIN_IDS` (ваш Telegram id), по желанию `TELEGRAM_ALLOWED_USERS`, `GOOGLE_CLOUD_API_KEY`.
2. IP сервера — в `~/.oci/vedit-ip.txt` (или первым аргументом).
3. Из корня репозитория в Git Bash:

```bash
bash deploy/deploy.sh                 # IP из ~/.oci/vedit-ip.txt
bash deploy/deploy.sh 158.101.1.2     # или явно
```

Первый раз скрипт сам запустит `setup-ubuntu.sh` (5–15 минут: обновления, ffmpeg, Node.js, Chrome), затем зальёт код,
поставит зависимости, соберёт whisper.cpp (на 1 OCPU — до 15–20 минут) и скачает модель (574 МБ), Piper, положит `.env`,
проверит всё `vedit doctor --bot` и запустит бота. В конце — последние 30 строк лога.

Деплоится **только закоммиченный код** (`git bundle` коммита; при обновлении — только недостающие коммиты).
Незакоммиченные изменения остаются на ноутбуке — скрипт об этом предупреждает.

Python-сайдкар ASR (faster-whisper + говорящие, torch CPU, ~2 ГБ диска, тяжело для 6 ГБ RAM) по умолчанию **не ставится**:
распознавание идёт через whisper.cpp. Поставить: `bash deploy/deploy.sh --setup --setup-args "--with-python-asr"`.

## Обновление

```bash
git commit …                 # сначала коммит
bash deploy/deploy.sh        # ~1 минута, если package-lock.json не менялся
bash deploy/deploy.sh --no-env   # не трогать .env на сервере
bash deploy/deploy.sh --strict   # не перезапускать бота, если doctor нашёл недостающее
```

Повторный `setup-ubuntu.sh` безопасен (всё идемпотентно): `bash deploy/deploy.sh --setup`.

## Логи, статус, перезапуск

```bash
ssh -i ~/.ssh/vedit_oracle ubuntu@<IP>
journalctl -u vedit-bot -f                 # живой лог
journalctl -u vedit-bot --since "1 hour ago"
systemctl status vedit-bot
sudo systemctl restart vedit-bot
sudo systemctl stop vedit-bot              # остановить (Restart=always поднимет только после start)
cd /opt/vedit/app && sudo systemd-run --quiet --wait --pipe --collect -p User=vedit -p WorkingDirectory=/opt/vedit/app \
  -p EnvironmentFile=-/opt/vedit/app/.env -p EnvironmentFile=/opt/vedit/server.env /usr/bin/node --import tsx src/cli.ts doctor --bot
```

Бот при старте сам печатает отчёт doctor в лог (строки `doctor: …`): режим, какой бэкенд у каждого модуля, чего не хватает.

## Откат

```bash
bash deploy/deploy.sh --log              # история: время, коммит, что было до него
bash deploy/deploy.sh --ref 538a3521     # вернуть любой прежний коммит (на сервере он уже есть — без бандла)
```

Каждый деплой ставит на сервере тег `deployed-<время>` и пишет строку в `/opt/vedit/deploys.log`.
База бота (`/opt/vedit/workspace/_bot/vedit.db`) при откате не меняется; миграции схемы — только вперёд.

## Пользователи

- **Закрытая бета** (по умолчанию для старта): `TELEGRAM_ALLOWED_USERS=111,222` — бот отвечает только этим id.
- **Открыть бота всем**: удалить `TELEGRAM_ALLOWED_USERS` из `.env` (или оставить пустым) → `bash deploy/deploy.sh`.
  Тогда работает регистрация и лимиты: бесплатные задачи в день (`VEDIT_FREE_JOBS_PER_DAY`, `VEDIT_FREE_LONG_PER_DAY`),
  пробные кредиты (`VEDIT_TRIAL_CREDITS`); живые правки — `/admin → ⚙️ Лимиты`.
- **Добавить одного человека** в закрытую бету: дописать его id в `TELEGRAM_ALLOWED_USERS`, задеплоить (`--no-env` не ставить).
  Свой id человек узнаёт у @userinfobot.
- **Админы**: `TELEGRAM_ADMIN_IDS` — `/admin` (статистика, поиск пользователя, кредиты, бан, рассылка) и тексты ошибок
  задач. На админов не действуют дневные лимиты и бюджет.
- **Защита от расходов** (в `.env`): `VEDIT_USER_DAILY_JOBS=10` — потолок задач на человека в сутки (даже с кредитами);
  `VEDIT_BUDGET_DAILY_USD=10` — общий расход API за сутки (граница суток — `VEDIT_TZ_OFFSET`, по умолчанию UTC+5), после
  него новые задачи не принимаются до завтра; `VEDIT_MAX_JOBS=1` — задач одновременно (остальные ждут: «⏳ в очереди: N»).

## Где деньги

| что | цена | где видно |
|---|---|---|
| сервер Oracle A1 | $0 (Always Free: до 4 OCPU / 24 ГБ на аккаунт) | консоль Oracle |
| Claude API (план, сценарий, перевод) | по токенам модели `VEDIT_PLANNER_MODEL` (по умолчанию claude-opus-5-5); один план ≤ `VEDIT_BUDGET_USD` ($1.5) | console.anthropic.com → Usage |
| Gemini API: понимание кадра, хайлайты, TTS | бесплатный уровень есть (данные могут использоваться Google); платный — по токенам | aistudio.google.com → Usage |
| Gemini + Google Search (тренды) | **нет в бесплатном уровне**; платный: 5000 поисков/мес бесплатно, далее $14 / 1000 | там же |
| Gemini image (ИИ-картинки) | **нет в бесплатном уровне**; ≈$0.034 за картинку | там же |
| Google Cloud TTS (если задан ключ) | Chirp 3 HD: 1 млн символов/мес бесплатно | console.cloud.google.com → Billing |

Расход каждой задачи — в `/opt/vedit/workspace/<job>/cost.json`; сумма за день/неделю — `/admin → 📊 Статистика`;
`vedit modules` на сервере показывает использование и стоимость по модулям за 30 дней.

## Как это устроено на сервере

```
/opt/vedit/
  app/              код (git checkout коммита), node_modules, .env (600, vedit)
  server.env        серверные настройки — читаются ПОСЛЕ .env и побеждают его:
                    VEDIT_SERVER=1, VEDIT_WORKSPACE, VEDIT_WHISPER_BIN/MODEL, VEDIT_CHROME, HYPERFRAMES_BROWSER_PATH, VEDIT_VOICE_DIR
  workspace/        задачи, кэши, _bot/vedit.db (база бота)
  whisper/          whisper-cli (собран из исходников) + ggml-large-v3-turbo-q5_0.bin
  voice/            Piper (piper_linux_aarch64) и голоса (скачиваются при первом синтезе)
  browsers/         headless Chrome от Playwright; bin/chrome-headless-shell → ссылка на него
  deploys.log       история деплоев
```

- `vedit-bot.service`: `User=vedit`, `Restart=always` (через 10 с), `MemoryMax` = 80% RAM, `Nice=5`, `ProtectSystem=full`.
- `vedit-cleanup.timer`: каждый день в 04:30 удаляет папки задач старше 10 дней и кэши старше 14 дней (основная
  очистка — сам бот, `VEDIT_RETENTION_DAYS=7`; таймер — подстраховка).
- swap 8 ГБ (при RAM < 16 ГБ), journald ≤ 500 МБ, unattended-upgrades, ufw: входящие только 22/tcp (правила Oracle
  в `/etc/iptables/rules.v4` не трогаются).

### Chrome на ARM64

У puppeteer нет `chrome-headless-shell` для linux-arm64, а `chromium` в Ubuntu 24.04 — snap (на сервере избегаем).
Выбран **headless shell от Playwright** (`npx playwright@1.64.1 install --with-deps --only-shell chromium` в
`/opt/vedit/browsers`): Microsoft собирает его под linux-arm64 и официально поддерживает Ubuntu 24.04, версия
закреплена, `--with-deps` ставит нужные библиотеки через apt, и это тот же «headless shell», что HyperFrames качает на
x64 — значит работает быстрый режим захвата кадров (beginFrame). Запасной вариант (если Playwright не скачался):
`chromium` из PPA xtradeb (.deb, закреплён только этот пакет) — работает в режиме скриншотов, медленнее.

Как vedit находит Chrome: подгонка текста (`src/make/fit.ts`, puppeteer-core) — `VEDIT_CHROME`; рендер HyperFrames
0.8.145 — переменная `HYPERFRAMES_BROWSER_PATH` (её HyperFrames читает раньше своего кэша; алиас
`PRODUCER_HEADLESS_SHELL_PATH`). Обе заданы в `server.env` на `/opt/vedit/bin/chrome-headless-shell`. Если задана только
`VEDIT_CHROME`/`CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH`, vedit сам передаёт её HyperFrames как `HYPERFRAMES_BROWSER_PATH`
(`src/lib/chrome.ts`).

## Видео больше 20 МБ: ссылки и локальный Bot API

Облачный Bot API отдаёт боту файлы только до 20 МБ. Без настройки бот принимает **ссылки** (Google Диск, Яндекс Диск,
Dropbox, прямые); YouTube / Instagram / TikTok — через `yt-dlp`, который `setup-ubuntu.sh` кладёт в
`/opt/vedit/bin/yt-dlp` (`VEDIT_YTDLP` в `server.env`, обновляется таймером `vedit-cleanup` каждый день).

Файлы до 2 ГБ прямо в Telegram — локальный сервер Bot API (`deploy/telegram-bot-api.sh`):

1. Владелец создаёт **api_id / api_hash** на https://my.telegram.org → «API development tools» (это ключи аккаунта,
   не бота; никому не передавать).
2. `ssh … ; sudo TELEGRAM_API_ID=… TELEGRAM_API_HASH=… bash /opt/vedit/app/deploy/telegram-bot-api.sh` — сборка из
   исходников (1 OCPU: 30–60 мин, `-j 1`), `telegram-bot-api.service` (пользователь `vedit`, `--local`, только
   `127.0.0.1:8081`, данные `/opt/vedit/tg-bot-api`, их чистка через 2 дня — `telegram-bot-api-cleanup.timer`),
   drop-in `vedit-bot.service.d/bot-api.conf` (бот стартует после сервера и читает `/opt/vedit/bot-api.env`).
3. `sudo bash /opt/vedit/app/deploy/telegram-bot-api.sh --switch` — `logOut` бота в облаке (облако потом ~10 минут не
   принимает бота), `TELEGRAM_API_BASE=http://127.0.0.1:8081` в `/opt/vedit/bot-api.env`, рестарт. В логе бота:
   `Bot API: http://127.0.0.1:8081 (локальный сервер …)`.

Назад в облако: `curl -s http://127.0.0.1:8081/bot<TOKEN>/logOut; sudo rm /opt/vedit/bot-api.env; sudo systemctl restart vedit-bot`.
`setup-ubuntu.sh` эти файлы не трогает (он переписывает только `server.env` и сам юнит).

## Если что-то не так

- `doctor: ✖ Claude` — нет `ANTHROPIC_API_KEY` в `.env`.
- `doctor: ✖ Chrome` — `ls -l /opt/vedit/bin/chrome-headless-shell`; переустановить: `sudo bash setup-ubuntu.sh --chrome ppa`
  (или `bash deploy/deploy.sh --setup`).
- `doctor: ✖ whisper` — `sudo -u vedit bash /opt/vedit/app/deploy/build-whisper.sh --prefix /opt/vedit/whisper`.
- бот падает по памяти (`journalctl` → `oom-kill`) — оставить `VEDIT_MAX_JOBS=1`, перейти на 2 OCPU / 12 ГБ
  (Always Free позволяет до 4 OCPU / 24 ГБ), или модель whisper `small`: `build-whisper.sh --model small` и
  `VEDIT_WHISPER_MODEL=/opt/vedit/whisper/ggml-small.bin` в `server.env`.
- SSH не пускает после `setup-ubuntu.sh` — не должно случиться (22/tcp разрешён до включения ufw), но консоль
  Oracle → Instance → Console connection всегда доступна; `sudo ufw disable` вернёт как было.
