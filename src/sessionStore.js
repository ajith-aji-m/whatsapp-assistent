import fs from "node:fs";
import path from "node:path";

const SESSIONS_FILE = path.join(process.cwd(), "data", "sessions.json");

export function loadPersistedSessions() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
    if (parsed && typeof parsed === "object") return Object.entries(parsed);
  } catch {
    return [];
  }
  return [];
}

export function persistSessions(sessionsMap) {
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessionsMap), null, 2));
  } catch (err) {
    console.error("⚠️ Failed to persist session state:", err.message);
  }
}
