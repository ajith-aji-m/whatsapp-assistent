import crypto from "node:crypto";
import "./env.js";
import { loadPersistedSessions, persistSessions } from "./sessionStore.js";

export const SESSION_COOKIE_NAME = "assistant_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

const attemptsByIp = new Map();

const sessions = new Map(loadPersistedSessions());

(function pruneExpiredOnLoad() {
  const now = Date.now();
  let changed = false;
  for (const [hash, record] of sessions) {
    if (!record || typeof record.expiresAt !== "number" || record.expiresAt <= now) {
      sessions.delete(hash);
      changed = true;
    }
  }
  if (changed) persistSessions(sessions);
})();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession() {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(hashToken(token), { expiresAt: Date.now() + SESSION_MAX_AGE_MS });
  persistSessions(sessions);
  return token;
}

export function isValidSession(token) {
  if (!token || typeof token !== "string") return false;

  const hash = hashToken(token);
  const record = sessions.get(hash);
  if (!record) return false;

  if (record.expiresAt <= Date.now()) {
    sessions.delete(hash);
    persistSessions(sessions);
    return false;
  }

  return true;
}

export function destroySession(token) {
  if (!token) return;
  if (sessions.delete(hashToken(token))) persistSessions(sessions);
}

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

export function verifyAccessCode(code) {
  const expected = process.env.ASSISTANT_ACCESS_CODE;
  if (!expected) return false;
  return typeof code === "string" && code.length > 0 && code === expected;
}
