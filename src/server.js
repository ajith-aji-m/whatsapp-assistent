// New entry point (replaces calling startBot() directly). All existing
// Baileys/AI logic in index.js is untouched — this just starts the web
// UI first, and lets the web UI's "Next" button (or an already-connected
// session) decide when startBot() actually runs.
import { startBot, logoutWhatsApp } from "./index.js";
import { startWebServer } from "./web.js";
import { startReminderScheduler } from "./reminderScheduler.js";
import { profile } from "./config.js";
import { connectionState } from "./connectionState.js";

const WEB_HOST = process.env.WEB_HOST || "localhost";
const WEB_PORT = Number(process.env.WEB_PORT || 3000);

startWebServer({ startBot, logoutWhatsApp, host: WEB_HOST, port: WEB_PORT });

// The setup wizard/dashboard profile now persists across restarts (see
// config.js/profileStore.js) — if a previous run already completed setup
// (profile.systemPrompt saved), resume the WhatsApp connection immediately
// using the existing auth_info_baileys/ session, instead of leaving the bot
// sitting idle until someone reopens the wizard. Guarded by the same
// connectionState.startedOnce flag web.js's own startBot() call uses, so
// there's no risk of starting it twice.
if (!!profile.systemPrompt && !connectionState.startedOnce) {
  connectionState.startedOnce = true;
  startBot().catch((err) => console.error("❌ Failed to resume WhatsApp connection on boot:", err.message));
}

// Independent of the WhatsApp connect/reconnect cycle — it self-guards
// against being started twice and just waits for a live socket on each
// tick (see reminderScheduler.js), so starting it once here at boot is
// enough regardless of when/how often startBot() itself runs.
startReminderScheduler();
