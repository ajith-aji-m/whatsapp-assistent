import crypto from "node:crypto";
import "./env.js"; // ensures .env is loaded before we read process.env below

// Gates the WhatsApp QR/pairing screen and dashboard behind a server-side
// verification code (ASSISTANT_ACCESS_CODE in .env) plus a browser session.
//
// Sessions are stateless HMAC-signed tokens rather than an in-memory
// Set-of-tokens — a browser that has verified once stays logged in
// indefinitely (paired with the long-lived cookie set in web.js), including
// across server restarts/redeploys (e.g. Render spinning the instance back
// up, or a new deploy). A random token in an in-memory Set would NOT survive
// that: the Set is wiped on every restart, forcing re-verification even
// though WhatsApp itself is still connected. The signing key is derived
// from ASSISTANT_ACCESS_CODE, which is stable across restarts (.env) — no
// extra secret to generate or persist, and anyone who could forge a valid
// signature already knows the access code, so this doesn't weaken anything.
//
// Deliberately still no database/session library, matching the rest of
// this project's in-memory, single-process design. Attempt counters (rate
// limiting) and the logout revocation list below are lost on server
// restart; that's fine for a personal, single-instance deployment and never
// affects the WhatsApp connection itself (see web.js: logout never touches
// auth_info_baileys/).

export const SESSION_COOKIE_NAME = "assistant_session";
// ~1 year: effectively "never expires" for a personal device, matching
// "ask once, never again after that" — the owner logs out explicitly (or
// clears cookies) rather than getting silently signed out.
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const attemptsByIp = new Map(); // ip -> { count, windowStart, lockedUntil }

// Explicitly logged-out tokens (see destroySession). Only needed so Logout
// actually revokes the token server-side instead of just clearing the
// cookie client-side; losing this list on restart just means a token that
// was logged out long ago (and never used since) would verify again after a
// restart — an acceptable edge case for a personal, single-owner deployment.
const revokedTokenHashes = new Set();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signingKey() {
  const code = process.env.ASSISTANT_ACCESS_CODE || "";
  return crypto.createHash("sha256").update(`assistant-session:${code}`).digest();
}

export function createSession() {
  const issuedAt = Date.now().toString(36);
  const random = crypto.randomBytes(16).toString("hex");
  const payload = `${issuedAt}.${random}`;
  const sig = crypto.createHmac("sha256", signingKey()).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

export function isValidSession(token) {
  if (!token || typeof token !== "string") return false;

  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [issuedAt, random, sig] = parts;

  const expectedSig = crypto.createHmac("sha256", signingKey()).update(`${issuedAt}.${random}`).digest("hex");
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  return !revokedTokenHashes.has(hashToken(token));
}

export function destroySession(token) {
  if (token) revokedTokenHashes.add(hashToken(token));
}

// Basic brute-force protection on the verification code: after MAX_ATTEMPTS
// failed tries from the same IP within WINDOW_MS, further attempts are
// rejected until LOCKOUT_MS has passed since the last failure.
export function checkRateLimit(ip) {
  const entry = attemptsByIp.get(ip);
  if (!entry) return { allowed: true };

  const now = Date.now();
  if (entry.lockedUntil) {
    if (now < entry.lockedUntil) return { allowed: false, retryAfterMs: entry.lockedUntil - now };
    attemptsByIp.delete(ip);
    return { allowed: true };
  }

  if (now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.delete(ip);
    return { allowed: true };
  }

  return { allowed: entry.count < MAX_ATTEMPTS };
}

export function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = attemptsByIp.get(ip);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    attemptsByIp.set(ip, { count: 1, windowStart: now, lockedUntil: null });
    return;
  }
  entry.count++;
  if (entry.count >= MAX_ATTEMPTS) entry.lockedUntil = now + LOCKOUT_MS;
}

export function recordSuccessfulAttempt(ip) {
  attemptsByIp.delete(ip);
}

// Fails closed: if the owner never set ASSISTANT_ACCESS_CODE, no code can
// pass verification (rather than silently accepting anything).
export function verifyAccessCode(code) {
  const expected = process.env.ASSISTANT_ACCESS_CODE;
  if (!expected) return false;
  return typeof code === "string" && code.length > 0 && code === expected;
}
