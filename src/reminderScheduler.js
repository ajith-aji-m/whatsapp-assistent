import { connectionState } from "./connectionState.js";
import { profile } from "./config.js";
import { getDueReminders, markReminderSent } from "./productivityStore.js";

// Delivers due reminders to the owner's own WhatsApp chat. 30s resolution is
// plenty for a personal reminder bot (reminders are set in minutes/hours,
// not seconds) and keeps this cheap to run indefinitely.
const CHECK_INTERVAL_MS = 30_000;

let intervalHandle = null;
let tickInFlight = false;

// Exported separately from the setInterval wiring below so it can be
// exercised directly in tests without waiting on real timers.
export async function tick() {
  if (tickInFlight) return; // a slow previous tick is still running — never overlap
  tickInFlight = true;
  try {
    const due = getDueReminders();
    if (due.length === 0) return;

    // Read the CURRENT socket from connectionState on every tick, rather
    // than capturing one at scheduler start — startBot() creates a new
    // socket on every reconnect (see index.js), so a captured reference
    // would go stale after the first reconnect.
    const sock = connectionState.sock;
    if (!sock || connectionState.status !== "connected" || !profile.whatsappJid) {
      return; // not connected right now — leave these pending, next tick retries
    }

    for (const reminder of due) {
      // Marked sent BEFORE attempting delivery so a slow/erroring send can
      // never cause the same reminder to fire twice on a later tick — "no
      // duplicate reminders" matters more here than guaranteed delivery of
      // a reminder that failed to send once (also not required — see
      // productivityStore.js's design comment).
      markReminderSent(reminder.id);
      try {
        await sock.sendMessage(profile.whatsappJid, { text: `⏰ Reminder\n\n${reminder.message}` });
      } catch (err) {
        console.error("❌ Failed to deliver reminder:", err.message);
      }
    }
  } finally {
    tickInFlight = false;
  }
}

// Starts the reminder-delivery loop exactly once for the life of the
// process — safe to call multiple times (e.g. if something calls it again
// later) since the intervalHandle guard makes every call after the first a
// no-op. Independent of the WhatsApp connect/reconnect cycle (see tick()
// above), so it only needs to be started once at boot (see server.js).
export function startReminderScheduler() {
  if (intervalHandle) return;
  intervalHandle = setInterval(tick, CHECK_INTERVAL_MS);
}
