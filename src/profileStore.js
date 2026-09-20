import fs from "node:fs";
import path from "node:path";

// On-disk persistence for the owner/assistant profile (name, role,
// assistantName, instructions, systemPrompt, scheduleEnabled,
// scheduleProfile) — everything in config.js's `profile` that the setup
// wizard/dashboard lets the owner configure. Mirrors state.js's pattern for
// availability: a single JSON file, same "no database" philosophy. NOT
// responsible for availability (state.js already owns that) or
// whatsappJid/whatsappLid (those are re-detected from the live Baileys
// session on every connect — see index.js — and must never be persisted
// stale).
const PROFILE_FILE = path.join(process.cwd(), "data", "profile.json");

// Returns the persisted profile fields, or null if nothing's been persisted
// yet (first run) or the file is missing/corrupt — callers fall back to
// process.env defaults in that case, exactly like loadPersistedAvailability.
export function loadPersistedProfile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8"));
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // no profile file yet, or unreadable — treated the same as "not set"
  }
  return null;
}

export function persistProfile(fields) {
  try {
    fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(fields, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to persist profile state:", err.message);
  }
}
