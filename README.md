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

| Этап | Статус |
|---|---|
| 1. Каркас, CLI, схемы, ingest, cut | ✅ |
| 2. Понимание (Whisper + Gemini) | — |
| 3. Агент-планировщик (Claude tool use) | — |
| 4. Оформление (HyperFrames / Remotion) | — |
| 5. revise | — |
