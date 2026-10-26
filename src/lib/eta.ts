/**
 * ETA (Estimated Time of Arrival) and progress time estimation for vedit pipelines.
 * Computes remaining time, formatted clock times (HH:MM), and localized progress strings.
 */

export interface EtaOptions {
  startedAt?: number;
  pct: number;
  durationSeconds?: number;
  kind?: string;
  count?: number;
}

export interface EtaResult {
  remainingMs: number;
  remainingSeconds: number;
  targetDate: Date;
  timeStr: string;
  durationStr: string;
}

/**
 * Baseline runtime estimates (seconds) for each job kind when progress percent is too low to extrapolate.
 */
export function defaultJobDurationSeconds(kind = "run", opts: { videoDuration?: number; outputsCount?: number } = {}): number {
  const vid = opts.videoDuration ?? 45;
  const count = opts.outputsCount ?? 1;

  switch (kind) {
    case "run":
      // Ingest (2s) + understand (0.15 * vid) + plan (10s) + cut (4s) + render (22s * count) + mix (4s)
      return Math.round(20 + 0.15 * vid + 22 * count);
    case "make":
      // Script (8s) + design/images (14s) + tts (8s) + render (25s) + mix (4s)
      return 60;
    case "highlights":
      // Scan (25s) + plan (10s) + cut (6s) + render (25s)
      return Math.round(40 + 0.1 * vid);
    case "revise":
      return Math.round(15 + 20 * count);
    case "avatar":
      return 35;
    case "dub":
      return Math.round(25 + 0.3 * vid);
    default:
      return 60;
  }
}

/**
 * Calculates remaining time and estimated completion date.
 */
export function calculateEta(o: EtaOptions): EtaResult {
  const now = Date.now();
  const started = o.startedAt ?? now;
  const elapsedMs = Math.max(0, now - started);
  const pct = Math.max(0, Math.min(100, o.pct));

  let remainingMs = 0;
  if (pct >= 8 && elapsedMs > 2000) {
    // Adaptive extrapolation based on actual elapsed time and current percent
    const estimatedTotalMs = (elapsedMs / pct) * 100;
    remainingMs = Math.max(3000, estimatedTotalMs - elapsedMs);
  } else {
    // Initial / early stage baseline estimation
    const baselineSec = defaultJobDurationSeconds(o.kind, {
      videoDuration: o.durationSeconds,
      outputsCount: o.count,
    });
    const baselineMs = baselineSec * 1000;
    remainingMs = Math.max(5000, baselineMs - elapsedMs);
  }

  const remainingSeconds = Math.round(remainingMs / 1000);
  const targetDate = new Date(now + remainingMs);

  const hours = String(targetDate.getHours()).padStart(2, "0");
  const minutes = String(targetDate.getMinutes()).padStart(2, "0");
  const timeStr = `${hours}:${minutes}`;

  const durationStr = formatDuration(remainingSeconds, "ru");

  return {
    remainingMs,
    remainingSeconds,
    targetDate,
    timeStr,
    durationStr,
  };
}

/**
 * Formats seconds into human-readable duration in ru/uz/en.
 */
export function formatDuration(sec: number, lang: "ru" | "uz" | "en" = "ru"): string {
  const s = Math.max(1, Math.round(sec));
  const m = Math.floor(s / 60);
  const remS = s % 60;

  if (lang === "uz") {
    if (m === 0) return `${remS} soniya`;
    if (remS === 0) return `${m} daqiqa`;
    return `${m} daq ${remS} son`;
  }

  if (lang === "en") {
    if (m === 0) return `${remS}s`;
    if (remS === 0) return `${m} min`;
    return `${m}m ${remS}s`;
  }

  // Russian
  if (m === 0) return `${remS} сек`;
  if (remS === 0) return `${m} мин`;
  return `${m} мин ${remS} сек`;
}

/**
 * Localized string for a running job's ETA.
 */
export function formatRunningEta(o: EtaOptions, lang: "ru" | "uz" | "en" = "ru"): string {
  const eta = calculateEta(o);
  const dur = formatDuration(eta.remainingSeconds, lang);

  if (lang === "uz") {
    return `⏳ Tayyor bo‘lishi: ~${eta.timeStr} (~${dur} qoldi)`;
  }
  if (lang === "en") {
    return `⏳ Ready around: ~${eta.timeStr} (~${dur} left)`;
  }
  return `⏳ Готовность: ~${eta.timeStr} (осталось ~${dur})`;
}

/**
 * Localized string for a queued job's ETA.
 */
export function formatQueuedEta(position: number, kind = "run", lang: "ru" | "uz" | "en" = "ru"): string {
  const pos = Math.max(1, position);
  const avgJobSec = 60;
  const waitSec = pos * avgJobSec;
  const targetDate = new Date(Date.now() + waitSec * 1000);
  const hours = String(targetDate.getHours()).padStart(2, "0");
  const minutes = String(targetDate.getMinutes()).padStart(2, "0");
  const timeStr = `${hours}:${minutes}`;
  const dur = formatDuration(waitSec, lang);

  if (lang === "uz") {
    return `⏳ Taxminiy tayyor bo‘lishi: ~${timeStr} (~${dur} dan keyin)`;
  }
  if (lang === "en") {
    return `⏳ Estimated completion: ~${timeStr} (in ~${dur})`;
  }
  return `⏳ Примерное время готовности: ~${timeStr} (через ~${dur})`;
}
