// Stage 32: where a finished content-plan video goes. Only the Telegram channel is live: the bot posts as an admin of
// the user's channel (no token, no app review). Instagram / YouTube / TikTok / VK are typed stubs — their OAuth and
// upload flows need developer apps and platform reviews the owner applies for first (docs/autoposting-plan.md).
import fs from "node:fs/promises";
import type { AccountRow, Platform } from "./db.ts";
import type { BotApi, TgChat } from "./telegram-api.ts";
import { TelegramError } from "./telegram-api.ts";

export type PublishErrorCode = "not_configured" | "rights" | "too_big" | "gone" | "api";

export class PublishError extends Error {
  constructor(
    message: string,
    readonly code: PublishErrorCode,
  ) {
    super(message);
  }
}

export interface PublishInput {
  account: AccountRow;
  file: string;
  caption: string;
  title?: string;
}
export interface PublishResult {
  externalId?: string;
  url?: string;
}
export interface Publisher {
  readonly platform: Platform;
  publish(input: PublishInput): Promise<PublishResult>;
}

/** "@name" → public post link; a private channel (no username) has none we can build */
export const postUrl = (label: string, messageId?: number) => (/^@\w{4,}$/.test(label) && messageId ? `https://t.me/${label.slice(1)}/${messageId}` : "");

export type ChannelCheck =
  | { ok: true; chat: TgChat; label: string }
  | { ok: false; reason: "unsupported" | "not_found" | "not_channel" | "bot_not_admin" | "bot_cant_post" | "user_not_admin" };

/**
 * /connect_channel @name: the chat exists and is a channel, the bot is an admin allowed to post, and the user who asks
 * is the creator or an admin of it (nobody can point the bot at someone else's channel).
 */
export async function checkChannel(api: BotApi, userId: number, ref: string): Promise<ChannelCheck> {
  if (!api.getChat || !api.getChatMember || !api.getMe) return { ok: false, reason: "unsupported" };
  let chat: TgChat;
  try {
    chat = await api.getChat(/^-?\d+$/.test(ref) ? Number(ref) : ref);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (chat.type !== "channel") return { ok: false, reason: "not_channel" };
  const me = await api.getMe();
  const bot = await api.getChatMember(chat.id, me.id).catch(() => undefined);
  if (!bot || (bot.status !== "administrator" && bot.status !== "creator")) return { ok: false, reason: "bot_not_admin" };
  if (bot.status === "administrator" && bot.can_post_messages === false) return { ok: false, reason: "bot_cant_post" };
  const user = await api.getChatMember(chat.id, userId).catch(() => undefined);
  if (!user || (user.status !== "creator" && user.status !== "administrator")) return { ok: false, reason: "user_not_admin" };
  return { ok: true, chat, label: chat.username ? `@${chat.username}` : (chat.title ?? String(chat.id)) };
}

export function telegramPublisher(api: BotApi, o: { shrink?: (file: string, limitBytes: number) => Promise<string> } = {}): Publisher {
  return {
    platform: "telegram",
    async publish({ account, file, caption }) {
      const chatId = Number(account.external_id);
      // the rights may have been taken away since the channel was connected
      if (api.getMe && api.getChatMember) {
        const me = await api.getMe();
        const m = await api.getChatMember(chatId, me.id).catch(() => undefined);
        if (!m || (m.status !== "administrator" && m.status !== "creator") || m.can_post_messages === false) throw new PublishError("бот больше не может публиковать в канале", "rights");
      }
      let size: number;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        throw new PublishError("файл видео уже удалён", "gone");
      }
      let send = file;
      if (size > api.limits.uploadBytes) {
        if (!o.shrink) throw new PublishError("файл больше лимита отправки ботом", "too_big");
        send = await o.shrink(file, api.limits.uploadBytes);
      }
      try {
        const msg = await api.sendVideo(chatId, send, { caption });
        return { externalId: String(msg.message_id), url: postUrl(account.label, msg.message_id) };
      } catch (err) {
        throw new PublishError(err instanceof TelegramError ? err.description : err instanceof Error ? err.message : String(err), "api");
      }
    },
  };
}

/**
 * Not live yet — each needs the owner's developer app and the platform's review first (docs/autoposting-plan.md):
 *
 * TODO(instagram): Instagram API with Instagram Login (Business/Creator account), scope instagram_business_content_publish
 *   after Meta App Review + Business Verification. Flow: POST /{ig-user-id}/media media_type=REELS video_url=<public
 *   https URL> caption=… (or upload_type=resumable + rupload) → poll GET /{container}?fields=status_code until FINISHED →
 *   POST /{ig-user-id}/media_publish creation_id=… ; first comment: POST /{media-id}/comments. Respect the 24 h publishing
 *   limit (GET /{ig-user-id}/content_publishing_limit).
 * TODO(youtube): OAuth 2.0 scope youtube.upload (sensitive: OAuth app verification; in "Testing" refresh tokens die
 *   after 7 days); videos.insert (resumable upload) with snippet.title/description/tags and status.privacyStatus
 *   (+ publishAt for YouTube-side scheduling, private only). Since 2026-06-01 uploads have their own quota bucket
 *   (default 100 calls/day). The docs now say unverified projects are no longer locked to private — confirm with a test
 *   upload; the audit form is still the way to more quota. Shorts: vertical or square and ≤ 3 min, no API flag.
 * TODO(tiktok): Content Posting API — query creator_info first, then POST /v2/post/publish/video/init/ (Direct Post,
 *   scope video.publish; FILE_UPLOAD chunks or PULL_FROM_URL from a verified domain) or /v2/post/publish/inbox/video/init/
 *   (upload to the creator's drafts, scope video.upload). Unaudited clients may post SELF_ONLY only; the UX must show the
 *   creator's nickname, a privacy choice with no default, and the music-usage consent.
 * TODO(vk): VK video upload (video.save → upload URL → POST the file) with a user or community token; clips need
 *   the corresponding VK permissions.
 */
export function stubPublisher(platform: Exclude<Platform, "telegram">): Publisher {
  return {
    platform,
    async publish() {
      throw new PublishError(`${platform}: автопубликация ещё не подключена (нужна проверка приложения платформой)`, "not_configured");
    },
  };
}

/** TODO(oauth): the authorization URL of a platform's OAuth flow (state = signed user id, PKCE where supported). */
export function oauthStartUrl(platform: Exclude<Platform, "telegram">): never {
  throw new PublishError(`${platform}: OAuth ещё не реализован`, "not_configured");
}
