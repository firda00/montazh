// The cancel signal of the job that is running in the current async context.
// The bot runs every pipeline inside `withJobSignal(ac.signal, …)`; spawn sites (ffmpeg, whisper, piper,
// HyperFrames, agy…) pass `jobSignal()` to child_process.spawn, so 🛑 kills the child process right away
// instead of waiting for the end of the step. Outside a bot job the signal is undefined (CLI behaviour unchanged).
import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<AbortSignal>();

export function withJobSignal<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  return store.run(signal, fn);
}

/** the cancel signal of the current bot job (undefined in the CLI) */
export function jobSignal(): AbortSignal | undefined {
  return store.getStore();
}

/** `own` (an explicit signal) combined with the job's signal */
export function withCurrent(own?: AbortSignal): AbortSignal | undefined {
  const cur = store.getStore();
  if (own && cur) return AbortSignal.any([own, cur]);
  return own ?? cur;
}
