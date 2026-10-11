// Entrypoint: `npm run bot`. Reads TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USERS from env or .env.
try {
  process.loadEnvFile(); // .env in cwd, optional — loaded before the imports below so VEDIT_WORKSPACE from .env applies
} catch {}

const { startBot } = await import("./index.ts");

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (line: string) => console.log(`${stamp()} ${line}`);

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
  console.error("✖ TELEGRAM_BOT_TOKEN не задан: создайте бота у @BotFather (/newbot) и добавьте токен в .env");
  process.exit(1);
}

const rawAllowed = process.env.TELEGRAM_ALLOWED_USERS?.trim() ?? "";
const allowedUserIds = rawAllowed
  .split(/[,\s]+/)
  .filter(Boolean)
  .map((s) => Number(s));
if (allowedUserIds.some((n) => !Number.isSafeInteger(n))) {
  console.error(`✖ TELEGRAM_ALLOWED_USERS: ожидаются числовые id через запятую, получено "${rawAllowed}"`);
  process.exit(1);
}
if (allowedUserIds.length) log(`доступ: ${allowedUserIds.join(", ")}`);
else log("⚠ TELEGRAM_ALLOWED_USERS не задан — бот отвечает всем, а каждый монтаж тратит деньги на планировщик");

const apiBase = process.env.TELEGRAM_API_BASE?.trim() || undefined;
if (apiBase) log(`Bot API: ${apiBase} (локальный сервер — лимиты файлов 2000 МБ)`);

const running = await startBot({ token, allowedUserIds, apiBase, onLog: log });

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
