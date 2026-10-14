// Sends one video file to a Telegram chat through the bot: tsx tools/send-file.ts <file> <chat_id> [caption]
import { openAsBlob } from "node:fs";
import path from "node:path";
import { callMethod } from "../src/bot/telegram-api.ts";

try {
  process.loadEnvFile();
} catch {}
const [file, chatArg, ...rest] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!file || !chatArg || !token) {
  console.error("usage: tsx tools/send-file.ts <file> <chat_id> [caption]   (TELEGRAM_BOT_TOKEN in .env)");
  process.exit(1);
}
const caption = rest.join(" ") || path.basename(file);
const blob = new File([await openAsBlob(file)], path.basename(file), { type: "video/mp4" });
const r = (await callMethod(token, "sendVideo", { chat_id: Number(chatArg), video: blob, caption, supports_streaming: true }, { signal: AbortSignal.timeout(600_000) })) as { message_id?: number };
console.log(`sent ${path.basename(file)} → message ${r.message_id ?? "?"}`);
