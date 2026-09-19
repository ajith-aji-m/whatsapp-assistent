// New entry point (replaces calling startBot() directly). All existing
// Baileys/AI logic in index.js is untouched — this just starts the web
// UI first, and lets the web UI's "Next" button (or an already-connected
// session) decide when startBot() actually runs.
import { startBot } from "./index.js";
import { startWebServer } from "./web.js";
import { startReminderScheduler } from "./reminderScheduler.js";

const WEB_HOST = process.env.WEB_HOST || "localhost";
const WEB_PORT = Number(process.env.WEB_PORT || 3000);

startWebServer({ startBot, host: WEB_HOST, port: WEB_PORT });

// Independent of the WhatsApp connect/reconnect cycle — it self-guards
// against being started twice and just waits for a live socket on each
// tick (see reminderScheduler.js), so starting it once here at boot is
// enough regardless of when/how often startBot() itself runs.
startReminderScheduler();
