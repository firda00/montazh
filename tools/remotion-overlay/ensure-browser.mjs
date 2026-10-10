// One-time: download Chrome Headless Shell into node_modules/.remotion (timed, with size).
import {ensureBrowser} from '@remotion/renderer';

const t0 = performance.now();
let total = 0;
let lastPct = -1;
let downloaded = false;
await ensureBrowser({
  logLevel: 'info',
  onBrowserDownload: () => {
    downloaded = true;
    console.log('Downloading Chrome Headless Shell...');
    return {
      version: null,
      onProgress: ({percent, downloadedBytes, totalSizeInBytes}) => {
        total = totalSizeInBytes ?? downloadedBytes;
        const p = Math.floor(percent * 10);
        if (p !== lastPct) {
          lastPct = p;
          console.log('  ' + Math.round(percent * 100) + '% ' + (downloadedBytes / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB');
        }
      },
    };
  },
});
const ms = performance.now() - t0;
console.log(JSON.stringify({ensureBrowser_ms: Math.round(ms), downloaded, download_bytes: total}));
