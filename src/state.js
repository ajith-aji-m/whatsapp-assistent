import fs from "node:fs";
import path from "node:path";

// Tiny on-disk persistence for the owner's AVAILABLE/UNAVAILABLE status only
// — everything else in this app (conversations, tasks, reminders, notes,
// links) is deliberately in-memory and lost on restart (see store.js /
// productivityStore.js), but availability must survive a restart: if the
// owner was AVAILABLE (handling contacts personally) when the process died,
// it must come back AVAILABLE, not silently start auto-replying again. A
// single JSON file matches the project's existing "no database" philosophy
// instead of introducing SQLite or another dependency for one field.
const STATE_FILE = path.join(process.cwd(), "data", "state.json");

// Returns the persisted availability ("AVAILABLE"/"UNAVAILABLE"), or null if
// nothing's been persisted yet (first run) or the file is missing/corrupt —
// callers fall back to the .env default in that case.
export function loadPersistedAvailability() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (parsed.availability === "AVAILABLE" || parsed.availability === "UNAVAILABLE") {
      return parsed.availability;
    }
  } catch {
    // no state file yet, or unreadable — treated the same as "not set"
  }
  return null;
}

export function persistAvailability(value) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ availability: value }, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to persist availability state:", err.message);
  }
}
