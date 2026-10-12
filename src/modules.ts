import fs from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "./lib/ffmpeg.ts";
import { promptNames, promptsHash } from "./lib/prompts.ts";
import { exists, readJson, WORKSPACE_ROOT } from "./lib/workspace.ts";
import { claudeLoginExists } from "./plan/backend/index.ts";
import { HF_BIN } from "./design/hyperframes/project.ts";
import { findAsrPython } from "./understand/asr.ts";
import { selectAsr } from "./understand/index.ts";
import { selectVisionProvider } from "./understand/vision/index.ts";
import { findAgy } from "./understand/vision/agy.ts";
import { WHISPER_BIN, WHISPER_MODEL } from "./understand/whisper.ts";
import { CostSchema, JobSchema, type Cost, type Job, type StepName } from "./schemas/index.ts";

/**
 * The module registry: every replaceable part of the pipeline, what it depends on (and under
 * which licence), how its backend is chosen, and how to tell whether it is ready on this machine.
 * `vedit modules` prints it next to usage from the workspace, so "what is in use" and "what can
 * go" are answered by numbers.
 */

export interface Backend {
  id: string;
  title: string;
  /** dependency and its licence, for due diligence */
  deps: string;
  license: string;
}

export interface ModuleDef {
  id: string;
  stage: StepName | "delivery";
  title: string;
  what: string;
  /** how the active backend is chosen (flag / env) */
  selector: string;
  backends: Backend[];
  /** step whose run counts as a use of this module */
  step?: StepName;
  /** cost.json entries that belong to this module */
  cost?: (e: Cost["entries"][number]) => boolean;
  /** jobs that belong to this module (delivery modules) */
  job?: (j: Job) => boolean;
  probe: (env: NodeJS.ProcessEnv) => Promise<{ active: string; ready: boolean; note: string }>;
}

const has = async (p: string) => exists(p);

export const MODULES: ModuleDef[] = [
  {
    id: "ingest",
    stage: "ingest",
    title: "Нормализация видео",
    what: "CFR 30 fps, ключевой кадр в секунду, WAV 16 кГц для речи",
    selector: "всегда; FFMPEG_PATH / FFPROBE_PATH",
    backends: [{ id: "ffmpeg", title: "FFmpeg", deps: "ffmpeg, ffprobe", license: "LGPL-2.1+ (динамическая линковка; GPL-сборки — только как внешний процесс)" }],
    step: "ingest",
    probe: async () => {
      try {
        await ffmpeg(["-version"]);
        return { active: "ffmpeg", ready: true, note: "" };
      } catch (err) {
        return { active: "ffmpeg", ready: false, note: err instanceof Error ? err.message.split("\n")[0] : String(err) };
      }
    },
  },
  {
    id: "asr",
    stage: "understand",
    title: "Распознавание речи",
    what: "фразы и пословные таймкоды",
    selector: "--asr auto|cpp|faster, VEDIT_ASR; auto = faster только с NVIDIA GPU",
    backends: [
      { id: "cpp", title: "whisper.cpp large-v3-turbo", deps: "whisper-cli, ggml-модель", license: "MIT (код и веса Whisper)" },
      { id: "faster", title: "faster-whisper", deps: "tools/asr/.venv: faster-whisper, CTranslate2", license: "MIT" },
    ],
    step: "understand",
    cost: (e) => /whisper/.test(e.provider),
    probe: async (env) => {
      const sel = await selectAsr("auto", env).catch(() => ({ engine: "whisper.cpp" as const, python: null }));
      if (sel.engine === "faster-whisper") return { active: "faster", ready: true, note: "GPU" };
      const ok = (await has(WHISPER_BIN)) && (await has(WHISPER_MODEL));
      const sidecar = await findAsrPython(env);
      return { active: "cpp", ready: ok, note: ok ? (sidecar ? "faster-whisper установлен, на CPU не используется" : "") : `нет ${(await has(WHISPER_BIN)) ? "модели" : "whisper-cli"}` };
    },
  },
  {
    id: "speakers",
    stage: "understand",
    title: "Говорящие",
    what: "S1, S2… на каждой фразе; фильтр --speaker",
    selector: "--no-diarize, VEDIT_DIARIZE=0; авто при установленном сайдкаре",
    backends: [{ id: "ecapa", title: "ECAPA-TDNN + кластеризация", deps: "tools/asr/.venv: speechbrain, torch, scipy", license: "Apache-2.0 (SpeechBrain, веса VoxCeleb)" }],
    step: "understand",
    cost: (e) => /speaker/.test(e.provider),
    probe: async (env) => {
      const py = await findAsrPython(env);
      return { active: "ecapa", ready: !!py, note: py ? "" : "сайдкар tools/asr не установлен" };
    },
  },
  {
    id: "scenes",
    stage: "understand",
    title: "Шоты и громкость",
    what: "границы шотов (scene 0.2), кадр на шот, кривая громкости",
    selector: "всегда",
    backends: [{ id: "ffmpeg", title: "FFmpeg select/ebur128", deps: "ffmpeg", license: "LGPL-2.1+" }],
    step: "understand",
    probe: async () => ({ active: "ffmpeg", ready: true, note: "" }),
  },
  {
    id: "vision",
    stage: "understand",
    title: "Понимание кадра",
    what: "описание шотов, точки фокуса (auto_face), highlights",
    selector: "--vision auto|gemini|agy|stub, VEDIT_VISION; auto = ключ → agy → stub",
    backends: [
      { id: "gemini", title: "Gemini API", deps: "GEMINI_API_KEY", license: "условия Gemini API; по умолчанию gemini-2.5-flash-lite" },
      { id: "agy", title: "Antigravity CLI", deps: "agy + вход Google", license: "условия Antigravity; $0, подписка" },
      { id: "stub", title: "Заглушка", deps: "—", license: "—" },
    ],
    step: "understand",
    cost: (e) => ["stub", "gemini", "antigravity-cli"].includes(e.provider),
    probe: async (env) => {
      try {
        const { provider, note } = await selectVisionProvider("auto", env);
        const active = provider.name === "antigravity-cli" ? "agy" : provider.name;
        return { active, ready: active !== "stub", note: note.replace(/^vision: /, "") };
      } catch (err) {
        return { active: "stub", ready: false, note: err instanceof Error ? err.message : String(err) };
      }
    },
  },
  {
    id: "planner",
    stage: "plan",
    title: "Планировщик",
    what: "инструкция + пак → edl.json; правки диалогом",
    selector: "--backend auto|api|agent|mock, VEDIT_PLANNER; модель VEDIT_PLANNER_MODEL",
    backends: [
      { id: "api", title: "Claude API", deps: "@anthropic-ai/sdk, ANTHROPIC_API_KEY", license: "MIT (SDK); условия Anthropic API" },
      { id: "agent", title: "Claude Code (подписка)", deps: "@anthropic-ai/claude-agent-sdk, вход Claude Code", license: "MIT (SDK); условия подписки" },
      { id: "mock", title: "Мок", deps: "—", license: "—" },
    ],
    step: "plan",
    cost: (e) => (e.step === "plan" || e.step === "revise") && e.units.shortlist !== 1,
    probe: async (env) => {
      if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return { active: "api", ready: true, note: "" };
      const login = !!env.CLAUDE_CODE_OAUTH_TOKEN || claudeLoginExists(env);
      return { active: login ? "agent" : "api", ready: login, note: login ? "вход Claude Code" : "нет ANTHROPIC_API_KEY и входа Claude Code" };
    },
  },
  {
    id: "shortlist",
    stage: "plan",
    title: "Отбор окон (длинное видео)",
    what: "индекс фраз → ≤24 окна; авто при >250 фраз",
    selector: "--long / --no-long, --windows; те же бэкенды, что у планировщика",
    backends: [{ id: "llm", title: "Structured-вызов Claude", deps: "как планировщик", license: "как планировщик" }],
    step: "plan",
    cost: (e) => e.units.shortlist === 1,
    probe: async (env) => {
      const ready = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || claudeLoginExists(env));
      return { active: "llm", ready, note: ready ? "" : "без модели окна берутся из highlights" };
    },
  },
  {
    id: "cut",
    stage: "cut",
    title: "Нарезка",
    what: "клипы по EDL, кроп 9:16 / 1:1 / 16:9, auto_face, snap к словам",
    selector: "всегда; --no-snap",
    backends: [{ id: "ffmpeg", title: "FFmpeg", deps: "ffmpeg", license: "LGPL-2.1+" }],
    step: "cut",
    probe: async () => ({ active: "ffmpeg", ready: true, note: "" }),
  },
  {
    id: "translate",
    stage: "design",
    title: "Перевод субтитров",
    what: "ru ↔ uz ↔ en по фразам, кэш в задаче",
    selector: "--no-translate; авто, когда язык субтитров ≠ язык речи",
    backends: [{ id: "llm", title: "Structured-вызов Claude", deps: "как планировщик", license: "как планировщик" }],
    step: "design",
    cost: (e) => e.step === "design",
    probe: async (env) => {
      const ready = !!(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.CLAUDE_CODE_OAUTH_TOKEN || claudeLoginExists(env));
      return { active: "llm", ready, note: ready ? "" : "перевод недоступен, субтитры на языке речи" };
    },
  },
  {
    id: "render",
    stage: "render",
    title: "Оформление и рендер",
    what: "субтитры с подсветкой, титры, аутро, −14 LUFS",
    selector: "--renderer hyperframes; --quality, --workers",
    backends: [
      { id: "hyperframes", title: "HyperFrames 0.8.145", deps: "hyperframes (npm), Chromium; GSAP 3.14 vendored; Inter", license: "Apache-2.0; GSAP Standard (бесплатно, без ограничений с 2024); Inter OFL-1.1" },
      { id: "remotion", title: "Remotion (прототип, выключен)", deps: "tools/remotion-overlay", license: "коммерческая от 4 сотрудников — не использовать в проде" },
    ],
    step: "render",
    probe: async () => {
      const ok = await has(HF_BIN);
      return { active: "hyperframes", ready: ok, note: ok ? "" : "npm install" };
    },
  },
  {
    id: "bot",
    stage: "delivery",
    title: "Telegram-бот",
    what: "видео + подпись → MP4 в чат; /revise, /status",
    selector: "npm run bot; TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS",
    backends: [{ id: "telegram", title: "Bot API (fetch, без зависимостей)", deps: "—", license: "условия Telegram Bot API" }],
    job: (j) => /[\\/]_bot[\\/]/.test(j.source),
    probe: async (env) => {
      const token = !!env.TELEGRAM_BOT_TOKEN?.trim();
      return { active: "telegram", ready: token, note: token ? (env.TELEGRAM_ALLOWED_USERS?.trim() ? "" : "без белого списка") : "нет TELEGRAM_BOT_TOKEN" };
    },
  },
  {
    id: "cli",
    stage: "delivery",
    title: "CLI и batch",
    what: "vedit run/plan/revise/render, batch по папке",
    selector: "всегда",
    backends: [{ id: "commander", title: "commander", deps: "commander", license: "MIT" }],
    job: (j) => !/[\\/]_bot[\\/]/.test(j.source),
    probe: async () => ({ active: "commander", ready: true, note: "" }),
  },
];

export interface ModuleUsage {
  runs: number;
  ok: number;
  failed: number;
  usd: number;
  last?: string;
}

export interface ModuleStatus {
  id: string;
  stage: string;
  title: string;
  active: string;
  ready: boolean;
  note: string;
  usage: ModuleUsage;
}

/** Usage per module over the jobs in the workspace created in the last `days` days. */
export async function moduleUsage(days = 30, root = WORKSPACE_ROOT): Promise<Map<string, ModuleUsage>> {
  const since = Date.now() - days * 86_400_000;
  const usage = new Map<string, ModuleUsage>(MODULES.map((m) => [m.id, { runs: 0, ok: 0, failed: 0, usd: 0 }]));
  let names: string[] = [];
  try {
    names = (await fs.readdir(root)).filter((n) => /^\d{8}-[0-9a-f]+$/.test(n));
  } catch {
    return usage;
  }
  for (const name of names) {
    const dir = path.join(root, name);
    let job: Job;
    try {
      job = await readJson(path.join(dir, "job.json"), JobSchema);
    } catch {
      continue;
    }
    if (new Date(job.created_at).getTime() < since) continue;
    const costFile = path.join(dir, "cost.json");
    const cost: Cost = (await exists(costFile)) ? await readJson(costFile, CostSchema).catch(() => ({ total_usd: 0, entries: [] })) : { total_usd: 0, entries: [] };
    for (const m of MODULES) {
      const u = usage.get(m.id)!;
      const bump = (status: string | undefined, at: string | undefined) => {
        u.runs++;
        if (status === "ok") u.ok++;
        else if (status === "failed") u.failed++;
        if (at && (!u.last || at > u.last)) u.last = at;
      };
      if (m.job) {
        if (m.job(job)) bump(job.steps.ingest?.status, job.created_at);
      } else if (m.step) {
        const st = job.steps[m.step];
        const entries = m.cost ? cost.entries.filter(m.cost) : [];
        // a module with its own cost entries counts a run only when it actually produced one (e.g. shortlist, translate)
        if (st && (!m.cost || entries.length || m.id === "asr" || m.id === "vision")) bump(st.status, st.finished_at ?? st.started_at);
        for (const e of entries) u.usd += e.usd;
      }
    }
  }
  return usage;
}

export async function moduleStatus(opts: { days?: number; env?: NodeJS.ProcessEnv; root?: string } = {}): Promise<{ modules: ModuleStatus[]; prompts: { files: string[]; hash: string } }> {
  const env = opts.env ?? process.env;
  const usage = await moduleUsage(opts.days ?? 30, opts.root);
  const modules = await Promise.all(
    MODULES.map(async (m) => {
      const p = await m.probe(env).catch((err) => ({ active: "?", ready: false, note: err instanceof Error ? err.message : String(err) }));
      return { id: m.id, stage: m.stage, title: m.title, ...p, usage: usage.get(m.id)! };
    }),
  );
  return { modules, prompts: { files: promptNames(), hash: promptsHash() } };
}

export function formatModules(s: Awaited<ReturnType<typeof moduleStatus>>, days: number): string {
  const rows = s.modules.map((m) => [m.id, m.stage, m.active, m.ready ? "✔" : "✖", `${m.usage.runs}${m.usage.failed ? ` (${m.usage.failed} ✖)` : ""}`, m.usage.usd ? `$${m.usage.usd.toFixed(2)}` : "—", m.usage.last ? m.usage.last.slice(0, 10) : "—", m.note]);
  const head = ["модуль", "этап", "бэкенд", "готов", `запусков/${days}д`, "стоимость", "последний", "примечание"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "─".repeat(w))), ...rows.map(line), "", `промпты: ${s.prompts.files.length} файлов в prompts/, версия ${s.prompts.hash}`].join("\n");
}
