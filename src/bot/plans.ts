// Plans, quotas and bot-wide limits — registry style: every number has a default, an env variable and
// (for the free plan) a live override an admin sets in /admin → ⚙️ Лимиты (stored in the DB, wins over env).
// `vedit modules` lists them next to the other limits (src/modules.ts → limitsCatalog).
import os from "node:os";

/** what a job costs: standard (montage, make, revise, avatar montage), long (> N min of video or highlights), light (free: avatar bundle) */
export type JobClass = "standard" | "long" | "light";

export interface PlanLimits {
  /** free standard jobs per day */
  standardPerDay: number;
  /** free long jobs per day (video longer than longMinutes, or sports highlights) */
  longPerDay: number;
  /** credits granted once, when registration is finished */
  trialCredits: number;
  /** credits for one standard job above the daily limit */
  creditsStandard: number;
  /** credits for one long job above the daily limit */
  creditsLong: number;
  /** a video longer than this is a long job, minutes */
  longMinutes: number;
  /** biggest upload, MB (capped by the Bot API: 20 MB cloud, 2000 MB local server) */
  uploadMb: number;
}

export interface PlanField {
  key: keyof PlanLimits;
  what: string;
  env: string;
  default: number;
  min: number;
  max: number;
}

/** the free plan, field by field (order = order on the admin card) */
export const FREE_PLAN_FIELDS: PlanField[] = [
  { key: "standardPerDay", what: "бесплатных обычных задач в день", env: "VEDIT_FREE_JOBS_PER_DAY", default: 3, min: 0, max: 1000 },
  { key: "longPerDay", what: "бесплатных длинных задач в день (видео > longMinutes или хайлайты)", env: "VEDIT_FREE_LONG_PER_DAY", default: 1, min: 0, max: 1000 },
  { key: "trialCredits", what: "пробных кредитов после регистрации", env: "VEDIT_TRIAL_CREDITS", default: 3, min: 0, max: 10000 },
  { key: "creditsStandard", what: "кредитов за обычную задачу сверх лимита", env: "VEDIT_CREDITS_STANDARD", default: 1, min: 0, max: 100 },
  { key: "creditsLong", what: "кредитов за длинную задачу сверх лимита", env: "VEDIT_CREDITS_LONG", default: 3, min: 0, max: 100 },
  { key: "longMinutes", what: "видео длиннее, мин — длинная задача", env: "VEDIT_LONG_MINUTES", default: 15, min: 1, max: 600 },
  { key: "uploadMb", what: "файл от пользователя, МБ (не больше лимита Bot API)", env: "VEDIT_FREE_UPLOAD_MB", default: 20, min: 1, max: 2000 },
];

/** a bad env value is an error, not a silent fallback (same rule as VEDIT_BUDGET_*) */
function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name}=${raw}: ожидается число от ${min} до ${max}`);
  return n;
}

/** free plan from env (live DB overrides are applied by the bot on top: BotDb.planLimits) */
export function freePlanFromEnv(env: NodeJS.ProcessEnv = process.env): PlanLimits {
  const out = {} as PlanLimits;
  for (const f of FREE_PLAN_FIELDS) out[f.key] = envNumber(env, f.env, f.default, f.min, f.max);
  return out;
}

/** VEDIT_MAX_JOBS: jobs running at once; default 1 on a small machine (< 12 GB RAM), 2 on a server */
export function maxJobsFromEnv(env: NodeJS.ProcessEnv = process.env, totalMemBytes = os.totalmem()): number {
  const def = totalMemBytes < 12 * 1024 ** 3 ? 1 : 2;
  return envNumber(env, "VEDIT_MAX_JOBS", def, 1, 16);
}

/** VEDIT_RETENTION_DAYS: uploads and finished jobs older than this are deleted (daily cleanup), default 7 */
export function retentionDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "VEDIT_RETENTION_DAYS", 7, 1, 3650);
}

/** day boundary for "per day" quotas: local time of the audience (default UTC+5, Tashkent), VEDIT_TZ_OFFSET hours */
export function tzOffsetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return envNumber(env, "VEDIT_TZ_OFFSET", 5, -12, 14);
}

/** ISO timestamp of the start of the current quota day */
export function dayStart(now = Date.now(), tzOffsetHours = 5): string {
  const shifted = now + tzOffsetHours * 3_600_000;
  const day = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(day - tzOffsetHours * 3_600_000).toISOString();
}

export const PER_USER_RUNNING = 1;
export const PER_USER_QUEUED = 2;
