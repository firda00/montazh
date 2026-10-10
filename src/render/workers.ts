import os from "node:os";

export interface WorkerPlan {
  workers: number;
  /** pass --low-memory-mode (1 worker, screenshot capture) instead of --no-low-memory-mode */
  lowMemory: boolean;
  freeMemMB: number;
  totalMemMB: number;
  cpus: number;
}

/** Each HyperFrames worker is a Chrome process of roughly 256–320 MB; keep 1 GB for the OS, ffmpeg and the encoder. */
export const WORKER_MB = 320;
export const RESERVE_MB = 1024;

export function planWorkers(sys: { freeMemMB: number; totalMemMB: number; cpus: number }, requested?: number): WorkerPlan {
  const byMem = Math.floor((sys.freeMemMB - RESERVE_MB) / WORKER_MB);
  const byCpu = Math.max(1, Math.floor(sys.cpus / 2));
  let workers = Math.max(1, Math.min(byMem, byCpu, 12));
  if (requested !== undefined && Number.isFinite(requested) && requested >= 1) workers = Math.floor(requested);
  return { workers, lowMemory: workers <= 1, freeMemMB: sys.freeMemMB, totalMemMB: sys.totalMemMB, cpus: sys.cpus };
}

export function currentSystem() {
  return { freeMemMB: Math.round(os.freemem() / 1048576), totalMemMB: Math.round(os.totalmem() / 1048576), cpus: os.cpus().length };
}
