import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { profile, setAvailability } from "./config.js";
import { connectionState, connectionEvents } from "./connectionState.js";
import { sendSummaryToAjith } from "./summary.js";
import { COMMANDS_LIST_TEXT } from "./commands.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETUP_PAGE_HTML = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// Builds the JSON snapshot sent both from GET /api/status and over the SSE
// stream. Deliberately excludes NVIDIA_API_KEY/NVIDIA_MODEL and any
// WhatsApp auth/session data — only non-secret state needed to render the
// UI. NVIDIA config is never part of the web surface; it comes from .env only.
async function buildStatusPayload() {
  const qrDataUrl = connectionState.qr ? await qrcode.toDataURL(connectionState.qr) : null;
  return {
    status: connectionState.status,
    qrDataUrl,
    profile: {
      name: profile.name,
      role: profile.role,
      availability: profile.availability,
    },
    ownerJid: profile.whatsappJid,
  };
}

// Starts the local setup/control web UI. `startBot` is the existing Baileys
// connection function from index.js — this module only decides WHEN to call
// it (on first setup submission), never how it works.
export function startWebServer({ startBot, host, port }) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    try {
      // Single static page — no framework, no build step, no other files served.
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SETUP_PAGE_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, await buildStatusPayload());
        return;
      }

      // Server-Sent Events: pushes a fresh status snapshot whenever
      // connectionState changes (new QR, connected, disconnected, etc.) so
      // the browser never needs to poll or manually refresh.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = async () => {
          try {
            res.write(`data: ${JSON.stringify(await buildStatusPayload())}\n\n`);
          } catch {
            /* client likely disconnected mid-write; listener cleanup below handles it */
          }
        };
        send();
        const listener = () => send();
        connectionEvents.on("update", listener);
        req.on("close", () => connectionEvents.off("update", listener));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/setup") {
        const body = await readJsonBody(req);

        if (typeof body.name === "string" && body.name.trim()) profile.name = body.name.trim();
        if (typeof body.role === "string" && body.role.trim()) profile.role = body.role.trim();
        if (body.availability === "AVAILABLE" || body.availability === "UNAVAILABLE") {
          setAvailability(body.availability);
        }
        // NVIDIA_API_KEY / NVIDIA_MODEL are intentionally NOT accepted here —
        // they come only from .env (see nvidia.js), never from the browser.

        console.log("[WEB] Setup submitted (name/role/availability updated).");

        if (!connectionState.startedOnce) {
          connectionState.startedOnce = true;
          startBot().catch((err) => console.error("❌ Failed to start WhatsApp connection:", err.message));
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/availability") {
        const body = await readJsonBody(req);
        if (body.availability !== "AVAILABLE" && body.availability !== "UNAVAILABLE") {
          sendJson(res, 400, { ok: false, error: "availability must be AVAILABLE or UNAVAILABLE" });
          return;
        }
        setAvailability(body.availability);
        console.log(`[WEB] Availability changed via web UI: ${body.availability}`);
        sendJson(res, 200, { ok: true, availability: body.availability });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/summary") {
        if (!connectionState.sock || !profile.whatsappJid) {
          sendJson(res, 409, { ok: false, error: "WhatsApp is not connected yet." });
          return;
        }
        console.log("[WEB] Get Summary requested from web UI.");
        const summaryText = await sendSummaryToAjith(connectionState.sock, profile.whatsappJid);
        sendJson(res, 200, { ok: true, summary: summaryText });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/commands") {
        sendJson(res, 200, { text: COMMANDS_LIST_TEXT });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } catch (err) {
      console.error("❌ Web server error:", err.message);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Internal error" });
    }
  });

  server.listen(port, host, () => {
    const displayHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`Web UI: http://${displayHost}:${port}`);
  });

  return server;
}
