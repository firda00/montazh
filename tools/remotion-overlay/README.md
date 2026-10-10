# Remotion overlay renderer (запасной вариант)

Прототип этапа 4 на Remotion 4.0.534: тот же DesignJob (`props.json`) → `<Video>` из `@remotion/media` +
пословные субтитры + титр → MP4. В пайплайн **не подключён**: выбран HyperFrames (Apache-2.0, без платы за
рендер). Remotion бесплатен только для физлиц и компаний ≤ 3 сотрудников; иначе «Remotion for Automators» —
$0.01 за рендер, минимум $100/мес (см. `docs/stage4-research.md`).

Если HyperFrames придётся заменить:

```bash
cd tools/remotion-overlay
npm install            # ставит Remotion, React и Chrome Headless Shell (~730 МБ, ~30 с)
node render.mjs props.json out/reel_1.mp4
```

`render.mjs`: `bundle()` один раз → `selectComposition()` → `renderMedia({ codec: "h264", crf: 18, audioCodec: "aac",
colorSpace: "bt709", concurrency: 2, x264Preset: "veryfast" })`. Медиа и шрифт кладутся в `public/`.
Адаптер к `OverlayRenderer` (`src/design/renderer.ts`) не написан — только скрипт прототипа.
