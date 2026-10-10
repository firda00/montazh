// bundle() once -> selectComposition() -> renderStill() (preview PNG) -> renderMedia() (h264 crf18 + aac).
// usage: node render.mjs [--props props.json] [--out out/reel.mp4] [--still out/preview.png] [--still-at 1.0]
//                        [--concurrency 2] [--preset veryfast] [--color-space bt709] [--log info] [--no-still]
import path from 'node:path';
import fs from 'node:fs';
import {bundle} from '@remotion/bundler';
import {openBrowser, renderMedia, renderStill, selectComposition} from '@remotion/renderer';

const argv = process.argv.slice(2);
const opt = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) opt[a.slice(2)] = true;
  else { opt[a.slice(2)] = next; i++; }
}
const propsPath = path.resolve(opt.props ?? 'props.json');
const outPath = path.resolve(opt.out ?? 'out/reel.mp4');
const stillPath = path.resolve(opt.still ?? 'out/preview.png');
const stillAt = Number(opt['still-at'] ?? 1.0);
const concurrency = opt.concurrency === 'null' ? null : Number(opt.concurrency ?? 2);
const x264Preset = opt.preset ?? 'veryfast';
// bt709 = limited range, tagged bt709 (the v5 default). v4's 'default' writes full-range yuvj420p tagged bt470bg.
const colorSpace = opt['color-space'] ?? 'bt709';
const logLevel = opt.log ?? 'info';
const doStill = !opt['no-still'];

const inputProps = JSON.parse(fs.readFileSync(propsPath, 'utf8'));
fs.mkdirSync(path.dirname(outPath), {recursive: true});
const ms = (a, b) => Math.round(b - a);
const report = {props: propsPath, output: outPath, concurrency, x264Preset, colorSpace, crf: 18, timings_ms: {}};

const t0 = performance.now();
const serveUrl = await bundle({entryPoint: path.resolve('src/index.ts'), publicDir: path.resolve('public')});
const t1 = performance.now();
report.timings_ms.bundle = ms(t0, t1);
console.log('bundle: ' + report.timings_ms.bundle + ' ms -> ' + serveUrl);

// One browser for all three calls (skips two extra Chrome launches).
const browser = await openBrowser('chrome', {logLevel});
const t2 = performance.now();
report.timings_ms.openBrowser = ms(t1, t2);

try {
  const composition = await selectComposition({serveUrl, id: 'Reel', inputProps, puppeteerInstance: browser, logLevel});
  const t3 = performance.now();
  report.timings_ms.selectComposition = ms(t2, t3);
  report.composition = {width: composition.width, height: composition.height, fps: composition.fps, durationInFrames: composition.durationInFrames};
  console.log('selectComposition: ' + report.timings_ms.selectComposition + ' ms -> ' + composition.width + 'x' + composition.height + '@' + composition.fps + ' ' + composition.durationInFrames + 'f');

  if (doStill) {
    const frame = Math.min(composition.durationInFrames - 1, Math.round(stillAt * composition.fps));
    const s0 = performance.now();
    await renderStill({composition, serveUrl, inputProps, output: stillPath, frame, imageFormat: 'png', puppeteerInstance: browser, logLevel});
    report.timings_ms.renderStill = ms(s0, performance.now());
    report.still = {path: stillPath, frame};
    console.log('renderStill: ' + report.timings_ms.renderStill + ' ms -> ' + stillPath + ' (frame ' + frame + ')');
  }

  const r0 = performance.now();
  let lastLog = 0;
  const res = await renderMedia({
    composition,
    serveUrl,
    inputProps,
    codec: 'h264',
    crf: 18,
    x264Preset,
    colorSpace,
    audioCodec: 'aac',
    imageFormat: 'jpeg',
    concurrency,
    outputLocation: outPath,
    overwrite: true,
    puppeteerInstance: browser,
    logLevel,
    onStart: ({frameCount, resolvedConcurrency, parallelEncoding}) =>
      console.log('renderMedia start: ' + frameCount + ' frames, concurrency=' + resolvedConcurrency + ', parallelEncoding=' + parallelEncoding),
    onProgress: ({progress, renderedFrames, encodedFrames, stitchStage}) => {
      const now = performance.now();
      if (now - lastLog > 5000) {
        lastLog = now;
        console.log('  ' + Math.round(progress * 100) + '% rendered=' + renderedFrames + ' encoded=' + encodedFrames + ' stage=' + stitchStage);
      }
    },
  });
  const r1 = performance.now();
  report.timings_ms.renderMedia = ms(r0, r1);
  report.render_fps = +(composition.durationInFrames / ((r1 - r0) / 1000)).toFixed(1);
  report.slowestFrames = res.slowestFrames.slice(0, 5);
  console.log('renderMedia: ' + report.timings_ms.renderMedia + ' ms (' + report.render_fps + ' fps) -> ' + outPath);
} finally {
  await browser.close({silent: false});
}
report.timings_ms.total = ms(t0, performance.now());
fs.writeFileSync(path.join(path.dirname(outPath), 'render-report.json'), JSON.stringify(report, null, 2));
console.log('TOTAL: ' + report.timings_ms.total + ' ms');
