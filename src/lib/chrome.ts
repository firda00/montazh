import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Which Chrome the text-fit pass (puppeteer-core) and HyperFrames rendering use.
 *
 * Order: an explicit path from the environment (VEDIT_CHROME, HYPERFRAMES_BROWSER_PATH,
 * PRODUCER_HEADLESS_SHELL_PATH, PUPPETEER_EXECUTABLE_PATH, CHROME_PATH) → the puppeteer / HyperFrames
 * download caches (chrome-headless-shell; Windows, macOS, linux-x64) → Playwright's cache
 * (chromium_headless_shell-*, the only maintained headless-shell build for linux-arm64) → system
 * Chromium / Chrome (/usr/bin/chromium …).
 *
 * HyperFrames 0.8.145 reads HYPERFRAMES_BROWSER_PATH (alias PRODUCER_HEADLESS_SHELL_PATH) before its own
 * cache; chromeEnv() passes the chosen binary to the CLI that way when the user set one of the other
 * variables. On the ARM server the systemd unit sets HYPERFRAMES_BROWSER_PATH and VEDIT_CHROME directly.
 */

export const CHROME_ENV_VARS = ["VEDIT_CHROME", "HYPERFRAMES_BROWSER_PATH", "PRODUCER_HEADLESS_SHELL_PATH", "PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"] as const;

/** The first Chrome path set in the environment (not checked for existence). */
export function explicitChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const k of CHROME_ENV_VARS) {
    const v = env[k]?.trim();
    if (v) return v;
  }
  return null;
}

/** Extra env for the HyperFrames CLI: point it at an explicitly configured Chrome it would not look at by itself. */
export function chromeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (env.HYPERFRAMES_BROWSER_PATH?.trim() || env.PRODUCER_HEADLESS_SHELL_PATH?.trim()) return {};
  const p = explicitChrome(env);
  return p && existsSync(p) ? { HYPERFRAMES_BROWSER_PATH: p } : {};
}

const exe = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

async function isFile(p: string): Promise<boolean> {
  return fs.stat(p).then((s) => s.isFile() && s.size > 0, () => false);
}

/** <cacheBase>/<kind>/<version>/<platform-dir>/<binary>, newest version first (puppeteer / HyperFrames layout). */
async function fromVersionedCache(base: string, kinds: string[]): Promise<string | null> {
  for (const kind of kinds) {
    const dir = path.join(base, kind);
    const versions = (await fs.readdir(dir).catch(() => [] as string[])).sort().reverse();
    for (const v of versions) {
      for (const sub of await fs.readdir(path.join(dir, v)).catch(() => [] as string[])) {
        const p = path.join(dir, v, sub, exe(kind));
        if (await isFile(p)) return p;
      }
    }
  }
  return null;
}

/** Playwright: <base>/chromium_headless_shell-<rev>/<platform dir>/headless_shell (or chrome-headless-shell), then chromium-<rev>/<platform dir>/chrome. */
async function fromPlaywright(base: string): Promise<string | null> {
  const entries = (await fs.readdir(base).catch(() => [] as string[])).sort().reverse();
  for (const prefix of ["chromium_headless_shell-", "chromium-"]) {
    for (const e of entries.filter((n) => n.startsWith(prefix))) {
      for (const sub of await fs.readdir(path.join(base, e)).catch(() => [] as string[])) {
        for (const name of prefix === "chromium-" ? ["chrome"] : ["headless_shell", "chrome-headless-shell"]) {
          const p = path.join(base, e, sub, exe(name));
          if (await isFile(p)) return p;
        }
      }
    }
  }
  return null;
}

export const SYSTEM_CHROMES = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];

export async function findHeadlessChrome(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): Promise<string | null> {
  const own = explicitChrome(env);
  if (own) return own;
  const cache = path.join(home, ".cache");
  const hit =
    (await fromVersionedCache(path.join(cache, "puppeteer"), ["chrome-headless-shell", "chrome"])) ??
    (await fromVersionedCache(path.join(cache, "hyperframes", "chrome"), ["chrome-headless-shell"])) ??
    (await fromPlaywright(env.PLAYWRIGHT_BROWSERS_PATH?.trim() || path.join(cache, "ms-playwright")));
  if (hit) return hit;
  if (process.platform !== "win32") {
    for (const p of SYSTEM_CHROMES) {
      // the Ubuntu chromium-browser stub only points to the snap: skip it when the snap is not installed
      if ((await isFile(p)) && !(p.endsWith("chromium-browser") && !existsSync("/snap/bin/chromium"))) return p;
    }
  }
  return null;
}
