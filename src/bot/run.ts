// Entrypoint: `npm run bot`. Reads TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERS, TELEGRAM_ADMIN_IDS, VEDIT_* from env or .env.
try {
  process.loadEnvFile(); // .env in cwd, optional — loaded before the imports below so VEDIT_WORKSPACE from .env applies
} catch {}

const { startBot } = await import("./index.ts");
const { dailyBudgetUsdFromEnv, freePlanFromEnv, maxJobsFromEnv, retentionDaysFromEnv, userDailyJobsFromEnv } = await import("./plans.ts");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${stamp()} ${line}`);

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("✖ TELEGRAM_BOT_TOKEN не задан: создайте бота у @BotFather (/newbot) и добавьте токен в .env");
  process.exit(1);
}

function idList(name: string): number[] {
  const raw = process.env[name]?.trim() ?? "";
  const ids = raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((s) => Number(s));
  if (ids.some((n) => !Number.isSafeInteger(n))) {
    console.error(`✖ ${name}: ожидаются числовые id через запятую, получено "${raw}"`);
    process.exit(1);
  }
  return ids;
}

const allowedUserIds = idList("TELEGRAM_ALLOWED_USERS");
const adminIds = idList("TELEGRAM_ADMIN_IDS");
if (allowedUserIds.length) log(`закрытая бета: доступ только ${allowedUserIds.join(", ")}`);
else log("открытая регистрация (TELEGRAM_ALLOWED_USERS не задан): лимиты бесплатного тарифа защищают от расходов");
const admins = adminIds.length ? adminIds : allowedUserIds.slice(0, 1);
if (admins.length) log(`админы: ${admins.join(", ")}${adminIds.length ? "" : " (первый из TELEGRAM_ALLOWED_USERS)"}`);
else log("⚠ админов нет: задайте TELEGRAM_ADMIN_IDS, чтобы видеть ошибки задач и пользоваться /admin");

let plan, maxJobs, retentionDays, userDaily, budgetUsd;
try {
  plan = freePlanFromEnv();
  maxJobs = maxJobsFromEnv();
  retentionDays = retentionDaysFromEnv();
  userDaily = userDailyJobsFromEnv();
  budgetUsd = dailyBudgetUsdFromEnv();
} catch (err) {
  console.error(`✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
log(`бесплатно в день: ${plan.standardPerDay} обычн. + ${plan.longPerDay} длинн., пробных кредитов ${plan.trialCredits}; задач одновременно ${maxJobs}; хранение ${retentionDays} дн.`);
log(`потолок на пользователя: ${userDaily || "нет"} задач/день; общий бюджет API: ${budgetUsd ? `$${budgetUsd}/день` : "без лимита"}`);

// self-check (the same as `vedit doctor --bot`): which provider each module uses, what is missing
if (process.env.VEDIT_DOCTOR_ON_START !== "0") {
  try {
    const { runDoctor, formatDoctor } = await import("../doctor.ts");
    const report = await runDoctor({ bot: true });
    for (const line of formatDoctor(report).split(/\r?\n/)) if (line.trim()) log(`doctor: ${line}`);
    if (!report.ok) log("⚠ не хватает обязательного (см. doctor выше) — часть задач будет падать");
  } catch (err) {
    log(`⚠ doctor: ${err instanceof Error ? err.message : err}`);
  }
}

const apiBase = process.env.TELEGRAM_API_BASE?.trim() || undefined;
if (apiBase) log(`Bot API: ${apiBase} (локальный сервер — лимиты файлов 2000 МБ)`);

const running = await startBot({ token, allowedUserIds, adminIds: admins, apiBase, maxJobs, retentionDays, onLog: log });

let stopping = false;
const shutdown = async () => {
  if (stopping) process.exit(130); // second Ctrl+C: exit immediately
  stopping = true;
  log("останавливаюсь (Ctrl+C ещё раз — выйти сразу)…");
  await running.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await running.done;
