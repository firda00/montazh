// A recording Bot API double for createBot(): every call is kept, messages get ids, and helpers build
// message / callback updates the way Telegram sends them (no network, no polling).
import fs from "node:fs/promises";
import path from "node:path";
import type { CallMethod, InlineKeyboard, TgMessage, TgUpdate } from "../../src/bot/telegram-api.ts";

export interface Call {
  method: string;
  params: Record<string, unknown>;
}

export function fakeTelegram() {
  const calls: Call[] = [];
  let nextMsg = 100;
  let nextUpdate = 1;
  let nextCb = 1;
  const callMethod: CallMethod = async <T,>(_token: string, method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    if (method === "getFile") return { file_id: params.file_id, file_size: 1000, file_path: `x/${params.file_id}` } as T;
    if (method === "sendChatAction" || method === "answerCallbackQuery" || method === "setMyCommands") return true as T;
    if (method === "editMessageText" || method === "editMessageReplyMarkup") return { message_id: params.message_id, chat: { id: params.chat_id, type: "private" } } as T;
    return { message_id: nextMsg++, chat: { id: params.chat_id, type: "private" } } as T;
  };
  const download = async (_t: string, _f: unknown, dest: string) => {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "fake-video");
  };
  const of = (chat?: number) => (c: Call) => chat === undefined || c.params.chat_id === chat;
  /** texts of new messages to a chat */
  const texts = (chat?: number) => calls.filter((c) => c.method === "sendMessage" && of(chat)(c)).map((c) => String(c.params.text));
  /** texts of edited messages */
  const edits = (chat?: number) => calls.filter((c) => c.method === "editMessageText" && of(chat)(c)).map((c) => String(c.params.text));
  /** the last message sent with this text fragment (with its keyboard) */
  const sent = (chat: number, fragment: string | RegExp) =>
    [...calls].reverse().find((c) => c.method === "sendMessage" && of(chat)(c) && (typeof fragment === "string" ? String(c.params.text).includes(fragment) : fragment.test(String(c.params.text))));
  const keyboardOf = (c: Call | undefined) => (c?.params.reply_markup as InlineKeyboard | undefined)?.inline_keyboard ?? [];
  /** the latest inline keyboard set on a message (by send, edit text or edit markup) */
  const markupOf = (msgId: number): InlineKeyboard["inline_keyboard"] => {
    for (const c of [...calls].reverse()) {
      if (c.method === "sendMessage" && messageIdOf(c) === msgId) return keyboardOf(c);
      if ((c.method === "editMessageReplyMarkup" || c.method === "editMessageText") && c.params.message_id === msgId) return keyboardOf(c);
    }
    return [];
  };
  const sentIds = new Map<Call, number>();
  const messageIdOf = (c: Call) => sentIds.get(c);
  // remember the id each sendMessage got (calls are pushed before the reply is built)
  const wrapped: CallMethod = async <T,>(token: string, method: string, params?: Record<string, unknown>, opts?: unknown) => {
    const r = await callMethod<T>(token, method, params, opts as never);
    if (method === "sendMessage") sentIds.set(calls[calls.length - 1], (r as { message_id: number }).message_id);
    return r;
  };
  const buttons = (kb: InlineKeyboard["inline_keyboard"]) => kb.flat().map((b) => `${b.text}=${b.callback_data}`);
  const msg = (chat: number, from: number, m: Partial<TgMessage>, user: { username?: string; first_name?: string } = {}): TgUpdate => ({
    update_id: nextUpdate++,
    message: { message_id: nextUpdate, chat: { id: chat, type: "private" }, from: { id: from, ...user }, ...m },
  });
  const text = (chat: number, t: string, from = chat, user: { username?: string; first_name?: string } = {}) => msg(chat, from, { text: t }, user);
  const video = (chat: number, fileId: string, from = chat, extra: Partial<TgMessage> = {}) => msg(chat, from, { video: { file_id: fileId, file_size: 1000, mime_type: "video/mp4" }, ...extra });
  /** a press on an inline button of message `msgId` */
  const press = (chat: number, data: string, msgId = 0, from = chat): TgUpdate => ({
    update_id: nextUpdate++,
    callback_query: { id: `cb${nextCb++}`, from: { id: from }, message: { message_id: msgId, chat: { id: chat, type: "private" } }, data },
  });
  /** the toast of the last answerCallbackQuery */
  const lastToast = () => [...calls].reverse().find((c) => c.method === "answerCallbackQuery")?.params.text as string | undefined;
  return { calls, callMethod: wrapped, download, texts, edits, sent, keyboardOf, markupOf, messageIdOf, buttons, msg, text, video, press, lastToast };
}
