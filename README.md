# vedit — ИИ-агент для видеомонтажа (MVP)

Спецификация: [SPEC.md](SPEC.md). Требуется Node 20+ и ffmpeg/ffprobe в PATH.

```bash
npm install
npm run fixtures            # тестовые видео с таймкодом в кадре → tests/fixtures/
npm test
```

## Этап 1 — каркас: ingest + cut по ручному edl.json

```bash
node bin/vedit.mjs run tests/fixtures/timecode_60s_1080p25.mp4 --edl tests/edl/demo_three_formats.json
node bin/vedit.mjs status <job_id>
node bin/vedit.mjs cut <job_id> [--edl new.json] [--only reel_1]
npx tsx tests/contact-sheet.ts <job_id>   # первый/последний кадр каждого клипа для проверки
```

Всё по задаче лежит в `workspace/<job_id>/`: `job.json` (статусы шагов), `media.json`,
`normalized.mp4` (CFR 30fps, H.264/AAC, всегда с аудио), `audio.wav` (16 kHz для Whisper),
`edl.json`, `cut.json`, `rough_<id>.mp4`, `cost.json`.

## Этап 2 — понимание: транскрипт, сцены, лучшие моменты

```bash
node scripts/setup-whisper.mjs      # whisper.cpp + ggml-large-v3-turbo-q5_0 (574 MB) → vendor/whisper/
node bin/vedit.mjs run tests/fixtures/cafe_speech_ru_en.mp4           # ingest → understand
node bin/vedit.mjs understand <job_id> [--language ru] [--method dtw|tokens] [--threads 16]
node bin/vedit.mjs cut <job_id> --edl tests/edl/demo_speech.json [--no-snap]
npx tsx tests/eval-transcript.ts <job_id>   # точность пословных таймкодов против .truth.json
```

Результаты в `workspace/<job_id>/`: `transcript.json` (фразы и слова с таймкодами, язык
каждой фразы), `scenes.json`, `highlights.json`, `frames/shot_NNN.jpg`, `understand.json`
(отчёт), `whisper/chunk_N.json` (сырой вывод whisper).

Как это устроено:

- **Транскрипция** — локальный whisper.cpp. Аудио режется на куски по паузам (`silencedetect`),
  каждый кусок ≤ 28 с (whisper кодирует окна по 30 с, кусок короче окна стоит столько же),
  язык определяется на каждом куске отдельно — смешанные ru/en/uz видео работают.
  Пословные таймкоды через DTW (`-dtw`): на тестовом ролике медиана ошибки 40 мс, p90 135 мс.
  Встроенный VAD whisper **не используется**: он сдвигает таймкоды токенов. Известные
  галлюцинации («Редактор субтитров…») отфильтровываются.
- **Сцены** — границы шотов через `select=gt(scene,0.2)` в ffmpeg + кадр из середины каждого шота.
- **Vision** — интерфейс `VisionProvider`; пока работает `stub`: описания помечены `[stub]`,
  людей/эмоций не выдумывает, highlights ранжирует по измеримому (целая фраза, длина, громкость).
  Gemini подключается в `src/understand/vision/` когда появится `GEMINI_API_KEY`.
- **Границы слов** — `cut` проверяет края клипов по транскрипту и по умолчанию подтягивает их
  к границе слова (сдвиг ≤ 0.4 с), иначе предупреждает.

Грабли Windows: whisper-cli падает (0xC0000409), если путь к **модели** содержит не-ASCII
символы — поэтому процесс запускается из папки модели. Скорость на CPU (i7-13700, 16 потоков)
≈ 1–2× реального времени.

## Этап 3 — агент-планировщик (инструкция → edl.json) и правки диалогом

```bash
node bin/vedit.mjs run tests/fixtures/cafe_long_ru.mp4 -p "3 рилса по 30 секунд для кафе, динамично, субтитры на узбекском"
node bin/vedit.mjs plan <job_id> -p "…" [--preset bold_pop] [--cut] [--dry-run] [--backend auto|api|agent|mock] [--effort medium] [--budget 1.5] [--verbose]
node bin/vedit.mjs revise <job_id> -p "в reel_3 убери приветствие и добавь фразу про самсу" [--no-cut]
node bin/vedit.mjs status <job_id>
```

Как это устроено (дизайн: [docs/stage3-design.md](docs/stage3-design.md)):

- **Пакет контекста** — все фразы `pN`, сцены `sN`, паузы `gN`, highlights `hN` одним детерминированным
  JSON (~3k токенов на 2-минутное видео, ~15k на 10 минут). Он кэшируется и переиспользуется в
  ремонтах и правках.
- **План по ссылкам, а не секундам** — клип `{start:"p3", end:"p5"}`; граница фразы/сцены гарантирована
  конструкцией (ТЗ §5.3). Резы в паузе `gN` и по границе слова `pN.wK` разрешены с предупреждением.
- **Валидация на нашей стороне** (`src/plan/resolve.ts`): неизвестные ссылки, пустые клипы, скорость
  поверх речи, длительность ±10 % (жёстко ±25 %), слова целиком, число выходов, титры. Ошибки уходят
  модели списком, ≤ 2 исправлений; выходы без ошибок сохраняются даже если другие отброшены.
- **Инструменты** (ТЗ): `get_transcript_range`, `get_scene_details`, `preview_frame`, `validate_edl` —
  объявлены всегда, модель вызывает их по необходимости (на фикстуре — ни разу: пакета хватает).
- **Бэкенды**: `api` — Claude API через SDK (`ANTHROPIC_API_KEY`); `agent` — Claude Agent SDK, то есть
  вход Claude Code по подписке, выбирается автоматически без ключа; `mock` — эвристика для тестов
  (план помечен `[mock]`, никогда не выбирается сам). Модель `claude-opus-5-5`, effort `medium`.
- **Лимиты на одно планирование**: $1.50, 240 с, 12 запросов, 2 исправления, 6 превью-кадров.
- **Правки** (`revise`, этап 5 со стороны плана): текущий план показывается модели ссылками, меняется
  только запрошенное, `edl.vN.json` — бэкап, `revise.json` — diff, перерезаются только затронутые выходы.
- **Стоимость** пишется в `cost.json` по каждому запросу; для `agent` это оценка SDK (`≈$`), не счёт.

Измерено на `cafe_long_ru.mp4` (114 с, 20 фраз) через подписку: план — 1 запрос, 86 с, ≈$0.19;
правка — 1 запрос, 50 с, ≈$0.11. Ремонт через `resume` сессии CLI стоил ≈$1.1 (перезаливка транскрипта),
поэтому ремонты и правки идут новой сессией с тем же префиксом (`VEDIT_AGENT_RESUME=1` возвращает resume).

| Этап | Статус |
|---|---|
| 1. Каркас, CLI, схемы, ingest, cut | ✅ |
| 2. Понимание (whisper.cpp + сцены; Gemini — заглушка) | ✅ (без Gemini) |
| 3. Агент-планировщик (Claude, tool use, валидация) | ✅ |
| 4. Оформление (HyperFrames / Remotion) | — |
| 5. Правки диалогом — со стороны плана (`revise` → diff → cut --only) | ✅ (перерендер оформления — после этапа 4) |
