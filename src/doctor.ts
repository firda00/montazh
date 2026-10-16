import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { detectServerMode, type ServerMode } from "./lib/server.ts";
import { WORKSPACE_ROOT } from "./lib/workspace.ts";
import { findHeadlessChrome } from "./lib/chrome.ts";
import { systemFontFile } from "./lib/sysfont.ts";
import { HF_BIN, ROOT } from "./design/hyperframes/project.ts";
import { whisperPaths } from "./understand/whisper.ts";
import { findAsrPython } from "./understand/asr.ts";
import { findMattePython } from "./design/matte.ts";
import { findAgy } from "./understand/vision/agy.ts";
import { claudeLoginAvailable } from "./plan/backend/index.ts";
import { piperExe, PIPER_DIR } from "./voice/piper.ts";

/**
 * `vedit doctor`: can this machine run the pipeline (and the bot) on its own? Prints the mode (server or
 * local logins), which provider every module will use, and every binary / key / folder that is missing.
 * Exit code 1 when something required is missing. The bot prints the same report on start.
 */

export interface Check {
  id: string;
  what: string;
  ok: boolean;
  /** missing → the run fails (exit 1); optional → a degraded feature */
  required: boolean;
  detail: string;
}

export interface DoctorReport {
  server: ServerMode;
  platform: string;
  checks: Check[];
  modules: { id: string; active: string; ready: boolean; note: string }[];
  ok: boolean;
}

function runQuiet(bin: string, args: string[], timeoutMs = 15_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    try {
      const child = spawn(bin, args, { windowsHide: true, timeout: timeoutMs });
      child.stdout?.on("data", (d) => (out += d));
      child.stderr?.on("data", (d) => (out += d));
      child.on("error", (err) => resolve({ ok: false, out: err.message }));
      child.on("close", (code) => resolve({ ok: code === 0, out }));
    } catch (err) {
      resolve({ ok: false, out: err instanceof Error ? err.message : String(err) });
    }
  });
}

const isFile = (p: string) => fs.stat(p).then((s) => s.isFile(), () => false);
const firstLine = (s: string) => s.trim().split(/\r?\n/)[0]?.slice(0, 120) ?? "";

export async function runDoctor(opts: { env?: NodeJS.ProcessEnv; bot?: boolean; modules?: boolean } = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const server = await detectServerMode(env).catch((err) => ({ on: false, source: "env" as const, reason: `✖ ${err instanceof Error ? err.message : err}` }));
  const checks: Check[] = [];
  const add = (id: string, what: string, ok: boolean, required: boolean, detail = "") => checks.push({ id, what, ok, required, detail });

  // runtime
  const [maj, min] = process.versions.node.split(".").map(Number);
  add("node", "Node.js ≥ 22.13 (node:sqlite)", maj > 22 || (maj === 22 && min >= 13), true, process.version);
  let sqlite = true;
  try {
    await import("node:sqlite");
  } catch {
    sqlite = false;
  }
  add("sqlite", "node:sqlite (база бота)", sqlite, !!opts.bot, sqlite ? "" : "нужен Node 22.13+");

  // binaries
  const ffBin = env.FFMPEG_PATH || "ffmpeg";
  const ff = await runQuiet(ffBin, ["-hide_banner", "-version"]);
  add("ffmpeg", "ffmpeg", ff.ok, true, ff.ok ? firstLine(ff.out) : `${ffBin}: ${firstLine(ff.out)}`);
  const fpBin = env.FFPROBE_PATH || "ffprobe";
  const fp = await runQuiet(fpBin, ["-hide_banner", "-version"]);
  add("ffprobe", "ffprobe", fp.ok, true, fp.ok ? "" : `${fpBin}: ${firstLine(fp.out)}`);
  if (ff.ok) {
    const enc = await runQuiet(ffBin, ["-hide_banner", "-encoders"]);
    add("ffmpeg-enc", "ffmpeg: libx264 + libopus", /libx264/.test(enc.out) && /libopus/.test(enc.out), true, /libx264/.test(enc.out) ? (/libopus/.test(enc.out) ? "" : "нет libopus") : "нет libx264");
  }

  const chrome = await findHeadlessChrome(env);
  const chromeOk = !!chrome && (await isFile(chrome));
  add("chrome", "Chrome для подгонки текста и рендера HyperFrames", chromeOk, true, chrome ? `${chrome}${chromeOk ? "" : " — файла нет"}${env.HYPERFRAMES_BROWSER_PATH ? "" : chromeOk && process.platform === "linux" && process.arch === "arm64" ? " (задайте HYPERFRAMES_BROWSER_PATH)" : ""}` : process.platform === "linux" && process.arch === "arm64" ? "нет: deploy/setup-ubuntu.sh ставит headless shell Playwright, путь — в VEDIT_CHROME / HYPERFRAMES_BROWSER_PATH" : "нет: npx hyperframes browser ensure или VEDIT_CHROME");
  if (chromeOk) {
    const v = await runQuiet(chrome!, ["--version"], 20_000);
    if (v.ok) checks[checks.length - 1].detail += ` (${firstLine(v.out)})`;
  }
  add("hyperframes", "HyperFrames CLI (npm)", await isFile(HF_BIN), true, (await isFile(HF_BIN)) ? "" : `${HF_BIN} — npm ci`);

  const wp = whisperPaths(env);
  const wBin = await isFile(wp.bin);
  const wModel = await isFile(wp.model);
  add("whisper-cli", "whisper.cpp (распознавание речи)", wBin, true, wBin ? wp.bin : `${wp.bin} — ${process.platform === "win32" ? "node scripts/setup-whisper.mjs" : "bash deploy/build-whisper.sh"} или VEDIT_WHISPER_BIN`);
  add("whisper-model", "модель whisper", wModel, true, wModel ? path.basename(wp.model) : `${wp.model} — node scripts/setup-whisper.mjs или VEDIT_WHISPER_MODEL`);

  const piper = piperExe();
  const piperOk = await isFile(piper);
  add("piper", "Piper TTS (локальный голос)", piperOk, false, piperOk ? piper : `скачается при первом синтезе в ${path.dirname(PIPER_DIR)} (${process.platform}-${process.arch})`);
  const py = await findAsrPython(env);
  add("asr-python", "Python-сайдкар tools/asr (faster-whisper, говорящие)", !!py, false, py ?? "не установлен (необязательно; на сервере: setup-ubuntu.sh --with-python-asr)");
  const mpy = await findMattePython(env);
  add("matte-python", "Python-сайдкар tools/matte (вырезание спикера в сплите, MediaPipe)", !!mpy, false, mpy ?? "не установлен (необязательно: split_news идёт с обычным видео; на сервере: setup-ubuntu.sh)");

  // fonts
  const inter = path.join(ROOT, "assets", "fonts", "Inter-Variable.ttf");
  add("font-inter", "шрифт Inter (assets/fonts)", await isFile(inter), true, "");
  const sys = systemFontFile();
  add("font-system", "системный шрифт для drawtext / запасной", await isFile(sys), false, sys);

  // keys (presence only, values are never printed)
  const has = (k: string) => !!env[k]?.trim();
  const claude = has("ANTHROPIC_API_KEY") || has("ANTHROPIC_AUTH_TOKEN") || claudeLoginAvailable(env);
  add("claude", "Claude (сценарии, планы, перевод)", claude, true, has("ANTHROPIC_API_KEY") || has("ANTHROPIC_AUTH_TOKEN") ? "ANTHROPIC_API_KEY" : claude ? "вход Claude Code (подписка)" : server.on ? "нет ANTHROPIC_API_KEY (в серверном режиме вход Claude Code не используется)" : "нет ANTHROPIC_API_KEY и входа Claude Code");
  const gemini = has("GEMINI_API_KEY") || has("GOOGLE_API_KEY");
  add("gemini", "Gemini API (кадры, хайлайты, тренды, картинки, голос)", gemini, false, gemini ? "GEMINI_API_KEY" : "нет — vision: заглушка, хайлайты недоступны, тренды пропускаются, голос Piper");
  add("cloud-tts", "Google Cloud TTS", has("GOOGLE_CLOUD_API_KEY"), false, has("GOOGLE_CLOUD_API_KEY") ? "GOOGLE_CLOUD_API_KEY" : "нет (необязательно)");
  if (opts.bot) {
    add("telegram", "TELEGRAM_BOT_TOKEN", has("TELEGRAM_BOT_TOKEN"), true, has("TELEGRAM_BOT_TOKEN") ? "" : "токен от @BotFather в .env");
    add("admins", "TELEGRAM_ADMIN_IDS / TELEGRAM_ALLOWED_USERS", has("TELEGRAM_ADMIN_IDS") || has("TELEGRAM_ALLOWED_USERS"), false, has("TELEGRAM_ALLOWED_USERS") ? "закрытая бета (белый список)" : "открытая регистрация");
  }
  if (!server.on) {
    const agy = await findAgy(env);
    add("agy", "Antigravity CLI (локально: тренды, картинки)", !!agy, false, agy ?? "нет");
  }

  // workspace
  let writable = false;
  try {
    await fs.mkdir(WORKSPACE_ROOT, { recursive: true });
    const probe = path.join(WORKSPACE_ROOT, `.doctor-${process.pid}`);
    await fs.writeFile(probe, "ok");
    await fs.rm(probe, { force: true });
    writable = true;
  } catch {}
  add("workspace", "рабочая папка (VEDIT_WORKSPACE)", writable, true, WORKSPACE_ROOT);
  try {
    const st = await fs.statfs(WORKSPACE_ROOT);
    const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
    add("disk", "свободно на диске ≥ 5 ГБ", freeGb >= 5, false, `${freeGb.toFixed(1)} ГБ`);
  } catch {}
  const memGb = os.totalmem() / 1024 ** 3;
  add("memory", "память", true, false, `${memGb.toFixed(1)} ГБ RAM, ${os.cpus().length} CPU, ${os.arch()}`);

  let modules: DoctorReport["modules"] = [];
  if (opts.modules !== false) {
    const { MODULES } = await import("./modules.ts");
    modules = await Promise.all(
      MODULES.filter((m) => m.stage !== "source").map(async (m) => {
        const p = await m.probe(env).catch((err) => ({ active: "?", ready: false, note: err instanceof Error ? err.message : String(err) }));
        return { id: m.id, ...p };
      }),
    );
  }
  return { server, platform: `${process.platform}-${process.arch}`, checks, modules, ok: checks.every((c) => c.ok || !c.required) };
}

export function formatDoctor(r: DoctorReport): string {
  const lines = [`режим: ${r.server.on ? "СЕРВЕР (только ключи API)" : "локальный (входы agy / Claude Code разрешены)"} — ${r.server.reason}; ${r.platform}`, ""];
  for (const c of r.checks) lines.push(`${c.ok ? "✔" : c.required ? "✖" : "·"} ${c.what}${c.detail ? `: ${c.detail}` : ""}`);
  if (r.modules.length) {
    lines.push("", "модули → бэкенд:");
    const w = Math.max(...r.modules.map((m) => m.id.length));
    for (const m of r.modules) lines.push(`  ${m.ready ? "✔" : "✖"} ${m.id.padEnd(w)}  ${m.active}${m.note ? ` — ${m.note}` : ""}`);
  }
  const missing = r.checks.filter((c) => !c.ok && c.required);
  lines.push("", missing.length ? `✖ не хватает обязательного: ${missing.map((c) => c.id).join(", ")}` : "✔ всё обязательное на месте");
  return lines.join("\n");
}
