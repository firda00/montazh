// Minimal Telegram Bot API client: fetch + FormData from Node 24, no dependencies.
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export const DEFAULT_API_BASE = "https://api.telegram.org";
const MB = 1024 * 1024;
/** cloud Bot API: getFile downloads ≤ 20 MB, uploads (sendVideo/sendDocument) ≤ 50 MB */
export const CLOUD_LIMITS = { downloadBytes: 20 * MB, uploadBytes: 50 * MB } as const;
/** self-hosted telegram-bot-api server (`--local`): both up to 2000 MB */
export const LOCAL_LIMITS = { downloadBytes: 2000 * MB, uploadBytes: 2000 * MB } as const;
export type Limits = { downloadBytes: number; uploadBytes: number };

/** a self-hosted server (TELEGRAM_API_BASE), run with --local: getFile returns a path on its disk, files up to 2000 MB */
export const isLocalApi = (apiBase = DEFAULT_API_BASE) => apiBase.replace(/\/+$/, "") !== DEFAULT_API_BASE;

export function limitsFor(apiBase = DEFAULT_API_BASE): Limits {
  return isLocalApi(apiBase) ? { ...LOCAL_LIMITS } : { ...CLOUD_LIMITS };
}

// ── types (only the fields the bot reads) ──────────────────────────────────────

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: string;
}
export interface TgVideo {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  duration?: number;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}
/** a round video message */
export interface TgVideoNote {
  file_id: string;
  file_unique_id?: string;
  /** diameter, px */
  length?: number;
  duration?: number;
  file_size?: number;
}
export interface TgDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}
export interface TgPhotoSize {
  file_id: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
}
export interface TgVoice {
  file_id: string;
  file_unique_id?: string;
  duration?: number;
  mime_type?: string;
  file_size?: number;
  /** audio messages carry a file name, voice notes do not */
  file_name?: string;
}
export interface TgMessage {
  message_id: number;
  date?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  caption?: string;
  /** set on every message of an album */
  media_group_id?: string;
  video?: TgVideo;
  /** round video */
  video_note?: TgVideoNote;
  /** GIF / silent MP4 (Telegram fills `document` for it too) */
  animation?: TgVideo;
  document?: TgDocument;
  /** sizes of one photo, smallest first */
  photo?: TgPhotoSize[];
  voice?: TgVoice;
  audio?: TgVoice;
}
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  /** the message with the inline keyboard (absent for very old messages) */
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

// ── keyboards ──────────────────────────────────────────────────────────────────

export interface InlineButton {
  text: string;
  /** ≤ 64 bytes (Bot API limit) */
  callback_data?: string;
  url?: string;
}
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}
/** the persistent reply keyboard under the input field (main menu) */
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}
export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };
export interface SendOptions {
  reply_markup?: ReplyMarkup;
}
export interface TgFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}
export type ChatAction = "typing" | "upload_video" | "upload_document" | "record_video" | "upload_voice" | "upload_photo";

// ── errors & transport ─────────────────────────────────────────────────────────

export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly description: string,
    public readonly errorCode?: number,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${method}: ${description}${errorCode ? ` (${errorCode})` : ""}`);
    this.name = "TelegramError";
  }
}

export interface CallOptions {
  signal?: AbortSignal;
  apiBase?: string;
  /** how many times a 429 is retried after its retry_after (default 3) */
  maxRetries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type CallMethod = <T = unknown>(token: string, method: string, params?: Record<string, unknown>, opts?: CallOptions) => Promise<T>;

interface ApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

const sleepMs = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

function encodeBody(params: Record<string, unknown>): { body: string | FormData; headers: Record<string, string> } {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
  if (!entries.some(([, v]) => v instanceof Blob)) {
    return { body: JSON.stringify(Object.fromEntries(entries)), headers: { "content-type": "application/json" } };
  }
  const form = new FormData();
  for (const [k, v] of entries) {
    if (v instanceof Blob) form.append(k, v, v instanceof File ? v.name : "file");
    else form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return { body: form, headers: {} }; // fetch sets the multipart boundary itself
}

/** POST /bot<token>/<method>. Params with a Blob/File value go as multipart/form-data, the rest as JSON. */
export const callMethod: CallMethod = async <T = unknown>(token: string, method: string, params: Record<string, unknown> = {}, opts: CallOptions = {}): Promise<T> => {
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const { body, headers } = encodeBody(params);
    let res: Response;
    try {
      res = await doFetch(`${base}/bot${token}/${method}`, { method: "POST", body, headers, signal: opts.signal });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      throw new TelegramError(method, `сеть: ${err instanceof Error ? err.message : String(err)}`);
    }
    let data: ApiResponse<T>;
    try {
      data = (await res.json()) as ApiResponse<T>;
    } catch {
      throw new TelegramError(method, `ответ не JSON (HTTP ${res.status})`, res.status);
    }
    if (data.ok) return data.result as T;
    const retryAfter = data.parameters?.retry_after;
    if ((data.error_code ?? res.status) === 429 && attempt < maxRetries) {
      const waitMs = Math.max(1, retryAfter ?? 1) * 1000;
      await (opts.sleep ? opts.sleep(waitMs) : sleepMs(waitMs, opts.signal));
      continue;
    }
    throw new TelegramError(method, data.description ?? `HTTP ${res.status}`, data.error_code ?? res.status, retryAfter);
  }
};

/** Downloads a file returned by getFile to `dest`. A local Bot API server (`--local`) returns an absolute path — copied as is. */
export type DownloadFn = (token: string, file: TgFile, dest: string, opts?: CallOptions) => Promise<void>;

export const downloadFile: DownloadFn = async (token, file, dest, opts = {}) => {
  if (!file.file_path) throw new TelegramError("getFile", "в ответе нет file_path (файл больше лимита?)");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  let url = `${base}/file/bot${token}/${file.file_path}`;
  if (path.isAbsolute(file.file_path)) {
    // local server (--local): the file is already on this machine — copied (the server keeps its own copy)
    try {
      await fs.copyFile(file.file_path, dest);
      return;
    } catch (err) {
      // the server runs where its paths are not ours (a container): its HTTP file route, if a proxy serves it
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "EPERM") throw err;
      url = `${base}/file/bot${token}/${file.file_path.replace(/^[\\/]+/, "")}`;
    }
  }
  const res = await (opts.fetch ?? fetch)(url, { signal: opts.signal });
  if (!res.ok || !res.body) throw new TelegramError("download", `HTTP ${res.status} ${res.statusText}`, res.status);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>), createWriteStream(tmp));
  await fs.rename(tmp, dest);
};

// ── typed wrappers ─────────────────────────────────────────────────────────────

export interface VideoMeta {
  caption?: string;
  duration?: number;
  width?: number;
  height?: number;
}

/** The bot talks to Telegram only through this object — tests replace `callMethod` / `download`. */
export interface BotApi {
  readonly limits: Limits;
  /** a self-hosted Bot API server (TELEGRAM_API_BASE): files up to 2000 MB, read from its disk */
  readonly local?: boolean;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  getFile(fileId: string): Promise<TgFile>;
  download(file: TgFile, dest: string): Promise<void>;
  sendMessage(chatId: number, text: string, opts?: SendOptions): Promise<TgMessage>;
  /** edits a sent text message in place (status cards, option cards); `markup` replaces the inline keyboard (omit → removed) */
  editMessageText(chatId: number, messageId: number, text: string, markup?: InlineKeyboard): Promise<void>;
  editMessageReplyMarkup(chatId: number, messageId: number, markup?: InlineKeyboard): Promise<void>;
  /** stops the spinner on a pressed inline button; `text` shows a short toast */
  answerCallbackQuery(id: string, text?: string): Promise<void>;
  /** the command list in the Telegram menu */
  setMyCommands(commands: { command: string; description: string }[], languageCode?: string): Promise<void>;
  /** multipart upload of a local MP4 (read into a Blob) */
  sendVideo(chatId: number, filePath: string, meta?: VideoMeta): Promise<TgMessage>;
  /** a file as is; `fileName` renames it in the chat, `disableContentTypeDetection` keeps an MP4 a file (no recompression into a video) */
  sendDocument(chatId: number, filePath: string, caption?: string, opts?: DocumentOptions): Promise<TgMessage>;
  /** a voice message: OGG with Opus audio */
  sendVoice(chatId: number, filePath: string, caption?: string): Promise<TgMessage>;
  /** a picture (PNG / JPEG ≤ 10 MB) */
  sendPhoto(chatId: number, filePath: string, caption?: string): Promise<TgMessage>;
  sendChatAction(chatId: number, action: ChatAction): Promise<void>;
}

export interface DocumentOptions {
  fileName?: string;
  disableContentTypeDetection?: boolean;
}

export interface BotApiOptions {
  apiBase?: string;
  callMethod?: CallMethod;
  download?: DownloadFn;
  limits?: Partial<Limits>;
  maxRetries?: number;
}

const TEXT_LIMIT = 4096;
/** getFile of a file over the Bot API download limit (20 MB in the cloud): "Bad Request: file is too big" */
export const isFileTooBig = (err: unknown) => err instanceof TelegramError && /file is too big/i.test(err.description);
/** "Bad Request: message is not modified" — the same text/keyboard again; harmless */
export const isNotModified = (err: unknown) => err instanceof TelegramError && /message is not modified/i.test(err.description);
const CAPTION_LIMIT = 1024;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function readAsFile(filePath: string, type: string, name = path.basename(filePath)) {
  const buf = await fs.readFile(filePath);
  return new File([buf], name, { type });
}

export function makeBotApi(token: string, o: BotApiOptions = {}): BotApi {
  const call = o.callMethod ?? callMethod;
  const dl = o.download ?? downloadFile;
  const base: CallOptions = { apiBase: o.apiBase, maxRetries: o.maxRetries };
  const limits: Limits = { ...limitsFor(o.apiBase), ...o.limits };
  return {
    limits,
    local: isLocalApi(o.apiBase),
    getUpdates: (offset, timeoutSec, signal) =>
      call<TgUpdate[]>(token, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, { ...base, signal }),
    getFile: (fileId) => call<TgFile>(token, "getFile", { file_id: fileId }, base),
    download: (file, dest) => dl(token, file, dest, base),
    sendMessage: (chatId, text, opts = {}) =>
      call<TgMessage>(token, "sendMessage", { chat_id: chatId, text: clip(text, TEXT_LIMIT), link_preview_options: { is_disabled: true }, reply_markup: opts.reply_markup }, base),
    editMessageText: async (chatId, messageId, text, markup) => {
      try {
        await call(token, "editMessageText", { chat_id: chatId, message_id: messageId, text: clip(text, TEXT_LIMIT), link_preview_options: { is_disabled: true }, reply_markup: markup ?? { inline_keyboard: [] } }, base);
      } catch (err) {
        if (!isNotModified(err)) throw err;
      }
    },
    editMessageReplyMarkup: async (chatId, messageId, markup) => {
      try {
        await call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: markup ?? { inline_keyboard: [] } }, base);
      } catch (err) {
        if (!isNotModified(err)) throw err;
      }
    },
    answerCallbackQuery: async (id, text) => {
      await call(token, "answerCallbackQuery", { callback_query_id: id, text: text ? clip(text, 200) : undefined }, base);
    },
    setMyCommands: async (commands, languageCode) => {
      await call(token, "setMyCommands", { commands, language_code: languageCode }, base);
    },
    sendVideo: async (chatId, filePath, meta = {}) =>
      call<TgMessage>(
        token,
        "sendVideo",
        {
          chat_id: chatId,
          video: await readAsFile(filePath, "video/mp4"),
          caption: meta.caption ? clip(meta.caption, CAPTION_LIMIT) : undefined,
          duration: meta.duration !== undefined ? Math.round(meta.duration) : undefined,
          width: meta.width,
          height: meta.height,
          supports_streaming: true,
        },
        base,
      ),
    sendDocument: async (chatId, filePath, caption, opts = {}) =>
      call<TgMessage>(
        token,
        "sendDocument",
        {
          chat_id: chatId,
          document: await readAsFile(filePath, "application/octet-stream", opts.fileName),
          caption: caption ? clip(caption, CAPTION_LIMIT) : undefined,
          disable_content_type_detection: opts.disableContentTypeDetection ? true : undefined,
        },
        base,
      ),
    sendVoice: async (chatId, filePath, caption) =>
      call<TgMessage>(token, "sendVoice", { chat_id: chatId, voice: await readAsFile(filePath, "audio/ogg"), caption: caption ? clip(caption, CAPTION_LIMIT) : undefined }, base),
    sendPhoto: async (chatId, filePath, caption) =>
      call<TgMessage>(token, "sendPhoto", { chat_id: chatId, photo: await readAsFile(filePath, filePath.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg"), caption: caption ? clip(caption, CAPTION_LIMIT) : undefined }, base),
    sendChatAction: async (chatId, action) => {
      await call<boolean>(token, "sendChatAction", { chat_id: chatId, action }, base);
    },
  };
}
