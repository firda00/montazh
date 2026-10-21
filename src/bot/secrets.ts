// Stage 32: platform tokens (OAuth access / refresh) are stored encrypted at rest. AES-256-GCM with a key from the
// environment: VEDIT_TOKEN_KEY = 32 random bytes as 64 hex chars or base64 (`openssl rand -hex 32`). No key → tokens
// are never stored (sealing throws); the Telegram channel needs no token (the bot itself posts as an admin).
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class TokenKeyError extends Error {}

const PREFIX = "v1:";

/** the 32-byte key from VEDIT_TOKEN_KEY, or null when unset; a malformed key is an error (never silently weak) */
export function tokenKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = (env.VEDIT_TOKEN_KEY ?? "").trim();
  if (!raw) return null;
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new TokenKeyError("VEDIT_TOKEN_KEY: нужно 32 байта (64 hex-символа или base64), например `openssl rand -hex 32`");
  return key;
}

/** "v1:" + base64(iv[12] | tag[16] | ciphertext) */
export function sealToken(plain: string, key: Buffer): string {
  if (key.length !== 32) throw new TokenKeyError("ключ шифрования токенов — 32 байта");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

/** throws on a wrong key or a tampered value (GCM authentication) */
export function openToken(sealed: string, key: Buffer): string {
  if (!sealed.startsWith(PREFIX)) throw new TokenKeyError("неизвестный формат зашифрованного токена");
  const buf = Buffer.from(sealed.slice(PREFIX.length), "base64");
  if (buf.length < 29) throw new TokenKeyError("зашифрованный токен повреждён");
  const d = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
