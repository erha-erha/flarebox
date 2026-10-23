import { getSetting } from "./db";
import { fromBase64, randomToken, safeEqual, sha256Hex, toBase64 } from "./util";

export const SESSION_COOKIE = "fb_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Kept modest so login fits the Workers Free CPU budget; combined with login rate limiting.
// The iteration count is stored in each hash, so it can be raised later without breaking logins.
const PBKDF2_ITERATIONS = 10_000;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iter || !salt || !hash) return false;
  const computed = await pbkdf2(password, fromBase64(salt), Number(iter));
  return safeEqual(toBase64(computed), hash);
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** The owner is "initialized" once a password exists, either in D1 or as the ADMIN_PASSWORD secret. */
export async function isInitialized(env: Env): Promise<boolean> {
  return !!(await getSetting(env.DB, "admin_password_hash")) || !!env.ADMIN_PASSWORD;
}

export async function checkPassword(env: Env, password: string): Promise<boolean> {
  const stored = await getSetting(env.DB, "admin_password_hash");
  if (stored) return verifyHash(password, stored);
  if (env.ADMIN_PASSWORD) return safeEqual(password, env.ADMIN_PASSWORD);
  return false;
}

export async function createSession(env: Env): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)").bind(
      await sha256Hex(token),
      now,
      now + SESSION_TTL_MS,
    ),
  ]);
  return token;
}

export async function validateSession(env: Env, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const row = await env.DB.prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ expires_at: number }>();
  return !!row && row.expires_at > Date.now();
}

export async function destroySession(env: Env, token: string | undefined): Promise<void> {
  if (!token) return;
  await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
}

export async function destroyAllSessions(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions").run();
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`;
}

export function clearSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
}

/** Fixed-window limiter: returns false once `limit` hits occur inside `windowMs`. */
export async function rateLimit(env: Env, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, count, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_limits.reset_at < ?3 THEN 1 ELSE rate_limits.count + 1 END,
       reset_at = CASE WHEN rate_limits.reset_at < ?3 THEN ?2 ELSE rate_limits.reset_at END
     RETURNING count`,
  )
    .bind(key, now + windowMs, now)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

export async function clearRateLimit(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
}
