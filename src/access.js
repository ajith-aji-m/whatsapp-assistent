import crypto from "node:crypto";
import "./env.js"; // ensures .env is loaded before we read process.env below

// Gates the WhatsApp QR/pairing screen and dashboard behind a server-side
// verification code (ASSISTANT_ACCESS_CODE in .env) plus a simple in-memory
// browser session — deliberately no database/session library, matching the
// rest of this project's in-memory, single-process design. Sessions and
// attempt counters are lost on server restart; that's fine for a personal,
// single-instance deployment and never affects the WhatsApp connection
// itself (see web.js: logout never touches auth_info_baileys/).

export const SESSION_COOKIE_NAME = "assistant_session";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes

const sessions = new Set();
const attemptsByIp = new Map(); // ip -> { count, windowStart, lockedUntil }

export function createSession() {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.add(token);
  return token;
}

export function isValidSession(token) {
  return !!token && sessions.has(token);
}

export function destroySession(token) {
  if (token) sessions.delete(token);
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
