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

export function limitsFor(apiBase = DEFAULT_API_BASE): Limits {
  return apiBase.replace(/\/+$/, "") === DEFAULT_API_BASE ? { ...CLOUD_LIMITS } : { ...LOCAL_LIMITS };
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
export interface TgDocument {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
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
  document?: TgDocument;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
}
export interface TgFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}
export type ChatAction = "typing" | "upload_video" | "upload_document" | "record_video";

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
  if (path.isAbsolute(file.file_path)) {
    await fs.copyFile(file.file_path, dest);
    return;
  }
  const base = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const res = await (opts.fetch ?? fetch)(`${base}/file/bot${token}/${file.file_path}`, { signal: opts.signal });
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
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]>;
  getFile(fileId: string): Promise<TgFile>;
  download(file: TgFile, dest: string): Promise<void>;
  sendMessage(chatId: number, text: string): Promise<TgMessage>;
  /** multipart upload of a local MP4 (read into a Blob) */
  sendVideo(chatId: number, filePath: string, meta?: VideoMeta): Promise<TgMessage>;
  sendDocument(chatId: number, filePath: string, caption?: string): Promise<TgMessage>;
  sendChatAction(chatId: number, action: ChatAction): Promise<void>;
}

export interface BotApiOptions {
  apiBase?: string;
  callMethod?: CallMethod;
  download?: DownloadFn;
  limits?: Partial<Limits>;
  maxRetries?: number;
}

const TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function readAsFile(filePath: string, type: string) {
  const buf = await fs.readFile(filePath);
  return new File([buf], path.basename(filePath), { type });
}

export function makeBotApi(token: string, o: BotApiOptions = {}): BotApi {
  const call = o.callMethod ?? callMethod;
  const dl = o.download ?? downloadFile;
  const base: CallOptions = { apiBase: o.apiBase, maxRetries: o.maxRetries };
  const limits: Limits = { ...limitsFor(o.apiBase), ...o.limits };
  return {
    limits,
    getUpdates: (offset, timeoutSec, signal) =>
      call<TgUpdate[]>(token, "getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, { ...base, signal }),
    getFile: (fileId) => call<TgFile>(token, "getFile", { file_id: fileId }, base),
    download: (file, dest) => dl(token, file, dest, base),
    sendMessage: (chatId, text) => call<TgMessage>(token, "sendMessage", { chat_id: chatId, text: clip(text, TEXT_LIMIT), link_preview_options: { is_disabled: true } }, base),
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
    sendDocument: async (chatId, filePath, caption) =>
      call<TgMessage>(token, "sendDocument", { chat_id: chatId, document: await readAsFile(filePath, "application/octet-stream"), caption: caption ? clip(caption, CAPTION_LIMIT) : undefined }, base),
    sendChatAction: async (chatId, action) => {
      await call<boolean>(token, "sendChatAction", { chat_id: chatId, action }, base);
    },
  };
}
