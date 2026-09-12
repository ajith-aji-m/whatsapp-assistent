// New entry point (replaces calling startBot() directly). All existing
// Baileys/NVIDIA logic in index.js is untouched — this just starts the web
// UI first, and lets the web UI's "Next" button (or an already-connected
// session) decide when startBot() actually runs.
import { startBot } from "./index.js";
import { startWebServer } from "./web.js";

const WEB_HOST = process.env.WEB_HOST || "localhost";
const WEB_PORT = Number(process.env.WEB_PORT || 3000);

startWebServer({ startBot, host: WEB_HOST, port: WEB_PORT });
