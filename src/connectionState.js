import { EventEmitter } from "node:events";

// Minimal shared state bridging the existing Baileys connection logic
// (index.js) to the web UI (web.js), without those two modules needing to
// import each other directly. This module does not touch Baileys behavior
// at all — it only observes/records what index.js's existing
// connection.update handler already knows.
export const connectionEvents = new EventEmitter();

export const connectionState = {
  status: "idle", // "idle" | "connecting" | "qr" | "connected" | "reconnecting" | "logged_out"
  qr: null, // raw QR string, most recent (null once connected / before one exists)
  sock: null, // the live Baileys socket once connected — used by web-triggered actions (Get Summary)
  startedOnce: false, // guards against starting the bot twice from repeated "Next" clicks
  connectedAt: null, // ms timestamp of the most recent "connected" transition — dashboard display only
};

export function setStatus(status, extra = {}) {
  if (status === "connected") extra = { ...extra, connectedAt: Date.now() };
  Object.assign(connectionState, { status }, extra);
  connectionEvents.emit("update", connectionState);
}
