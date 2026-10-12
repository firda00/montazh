// Sends a job's output_*.mp4 to a Telegram chat through the bot: tsx tools/send-outputs.ts <job_id> <chat_id> [--wait <file-with-DONE-marker>]
import fs from "node:fs/promises";
import { openAsBlob } from "node:fs";
import path from "node:path";
import { callMethod } from "../src/bot/telegram-api.ts";
import { jobDir, readJson } from "../src/lib/workspace.ts";
import { EdlSchema } from "../src/schemas/index.ts";
import { RenderReportSchema } from "../src/render/index.ts";

try {
  process.loadEnvFile();
} catch {}
const [jobId, chatArg, ...rest] = process.argv.slice(2);
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!jobId || !chatArg || !token) {
  console.error("usage: tsx tools/send-outputs.ts <job_id> <chat_id>   (TELEGRAM_BOT_TOKEN in .env)");
  process.exit(1);
}
const chatId = Number(chatArg);
const waitIdx = rest.indexOf("--wait");
if (waitIdx >= 0) {
  const marker = rest[waitIdx + 1];
  for (;;) {
    const text = await fs.readFile(marker, "utf8").catch(() => "");
    if (/CHAIN DONE/.test(text)) break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const dir = jobDir(jobId);
const edl = await readJson(path.join(dir, "edl.json"), EdlSchema);
const render = await readJson(path.join(dir, "render.json"), RenderReportSchema);
const ok = render.outputs.filter((o) => o.status === "ok" && o.output);
await callMethod(token, "sendMessage", { chat_id: chatId, text: `Готово: ${ok.length} из ${edl.outputs.length} рилсов из задачи ${jobId}.\n${edl.reasoning.slice(0, 900)}` });
let n = 0;
for (const out of edl.outputs) {
  const r = ok.find((o) => o.id === out.id);
  if (!r?.output) {
    await callMethod(token, "sendMessage", { chat_id: chatId, text: `${out.id}: не отрендерен` });
    continue;
  }
  const title = out.titles[0]?.text ? ` — ${out.titles[0].text}` : "";
  const caption = `${out.id}${title} (${r.duration?.toFixed(1) ?? "?"} с)`;
  const blob = await openAsBlob(r.output);
  const file = new File([blob], path.basename(r.output), { type: "video/mp4" });
  try {
    await callMethod(token, "sendVideo", { chat_id: chatId, video: file, caption, supports_streaming: true }, { signal: AbortSignal.timeout(600_000) });
  } catch (err) {
    console.error(`${out.id}: sendVideo failed (${err instanceof Error ? err.message : err}), sending as document`);
    await callMethod(token, "sendDocument", { chat_id: chatId, document: file, caption }, { signal: AbortSignal.timeout(600_000) });
  }
  n++;
  console.log(`sent ${out.id}`);
}
console.log(`SENT ${n}/${edl.outputs.length}`);
