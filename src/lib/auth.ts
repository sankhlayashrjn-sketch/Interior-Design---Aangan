import { env } from "@/lib/env";

/**
 * A deliberately small login: one shared password (APP_PASSWORD) and a signed, expiring cookie.
 * Uses only Web Crypto, so it behaves the same in the proxy and in server actions.
 *
 *   APP_PASSWORD set                 -> login required
 *   unset, running in development    -> no login (your laptop)
 *   unset, running in production     -> the app LOCKS ITSELF and says why. It never runs open on the internet.
 *
 * This is a shared password, not per-person accounts: everyone who knows it sees everything, and the
 * "Viewing as" selector is still just a convenience. Move to real accounts when more people use it.
 */
export const SESSION_COOKIE = "aangan_session";
export const SESSION_TTL_MS = 7 * 24 * 3_600_000;

export type AuthMode = "off" | "password" | "blocked";

export function authMode(): AuthMode {
  if (env.APP_PASSWORD) return "password";
  if (env.OPEN_ACCESS === "true") return "off"; // a deliberate choice, never a default
  return process.env.NODE_ENV === "production" ? "blocked" : "off";
}

/** Paths that do their own authentication (shared secret, signature or bearer token), so the login gate skips them. */
export const PUBLIC_PATHS = ["/login", "/api/calls", "/api/bookings", "/api/telegram/webhook", "/api/cron/tick", "/api/vaani/webhook"];

export const isPublicPath = (pathname: string) => PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const enc = new TextEncoder();

async function hmacHex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

const signingSecret = () => env.AUTH_SECRET || `aangan-session:${env.APP_PASSWORD}`;

/** Constant-time string comparison. */
export function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True if `input` is the password. Both sides are hashed first, so the comparison time does not depend on the guess. */
export async function passwordMatches(input: string): Promise<boolean> {
  if (!env.APP_PASSWORD) return false;
  const [a, b] = await Promise.all([hmacHex("password-check", input), hmacHex("password-check", env.APP_PASSWORD)]);
  return same(a, b);
}

export async function createSession(now: number = Date.now()): Promise<string> {
  const expires = String(now + SESSION_TTL_MS);
  return `${expires}.${await hmacHex(signingSecret(), expires)}`;
}

export async function verifySession(token: string | undefined, now: number = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expires, sig] = token.split(".");
  if (!expires || !sig || !/^\d+$/.test(expires) || Number(expires) < now) return false;
  return same(sig, await hmacHex(signingSecret(), expires));
}

/** Only allow redirects to a path on this site. */
export const safeNext = (next: string | null | undefined) => (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/");
