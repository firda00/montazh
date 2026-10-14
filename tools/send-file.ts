// Sends one file to a Telegram chat through the bot: tsx tools/send-file.ts <file> <chat_id> [caption] [--video]
// Default is a document (original quality, Telegram does not recompress); --video sends an inline player instead.
import { openAsBlob } from "node:fs";
import path from "node:path";
import { callMethod } from "../src/bot/telegram-api.ts";

try {
  process.loadEnvFile();
} catch {}
const args = process.argv.slice(2);
const asVideo = args.includes("--video");
const [file, chatArg, ...rest] = args.filter((a) => a !== "--video");
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!file || !chatArg || !token) {
  console.error("usage: tsx tools/send-file.ts <file> <chat_id> [caption] [--video]   (TELEGRAM_BOT_TOKEN in .env)");
  process.exit(1);
}
const caption = rest.join(" ") || path.basename(file);
const name = path.basename(file);
const isMp4 = name.toLowerCase().endsWith(".mp4");
const blob = new File([await openAsBlob(file)], name, { type: isMp4 ? "video/mp4" : "application/octet-stream" });
const params =
  asVideo && isMp4
    ? { method: "sendVideo", body: { chat_id: Number(chatArg), video: blob, caption, supports_streaming: true } }
    : { method: "sendDocument", body: { chat_id: Number(chatArg), document: blob, caption, disable_content_type_detection: true } };
const r = (await callMethod(token, params.method, params.body, { signal: AbortSignal.timeout(600_000) })) as { message_id?: number };
console.log(`sent ${name} as ${params.method === "sendVideo" ? "video" : "file"} → message ${r.message_id ?? "?"}`);
