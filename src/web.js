import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { profile, setAvailability } from "./config.js";
import { connectionState, connectionEvents } from "./connectionState.js";
import { sendSummaryToAjith } from "./summary.js";
import { commandsListText } from "./commands.js";
import { generateSystemPrompt } from "./nvidia.js";
import {
  SESSION_COOKIE_NAME,
  createSession,
  isValidSession,
  destroySession,
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  verifyAccessCode,
} from "./access.js";

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

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    cookies[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return cookies;
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE_NAME];
}

function isAuthenticated(req) {
  return isValidSession(getSessionToken(req));
}

function setSessionCookie(res, token) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function clientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

// Builds the JSON snapshot sent both from GET /api/status and over the SSE
// stream. Deliberately excludes NVIDIA_API_KEY/NVIDIA_MODEL, the access
// code, and any WhatsApp auth/session data. Before the browser has verified
// the access code, this reveals nothing about the live connection (no QR, no
// status) — just enough to decide whether to show the setup wizard or the
// verification screen (see index.html).
async function buildStatusPayload(authenticated) {
  const configured = !!profile.systemPrompt;

  if (!authenticated) {
    return { authenticated: false, configured };
  }

  const qrDataUrl = connectionState.qr ? await qrcode.toDataURL(connectionState.qr) : null;
  return {
    authenticated: true,
    configured,
    status: connectionState.status,
    qrDataUrl,
    profile: {
      name: profile.name,
      role: profile.role,
      assistantName: profile.assistantName,
      availability: profile.availability,
    },
    ownerJid: profile.whatsappJid,
  };
}

// Starts the local setup/control web UI. `startBot` is the existing Baileys
// connection function from index.js — this module only decides WHEN to call
// it (once the setup wizard is completed), never how it works.
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
        sendJson(res, 200, await buildStatusPayload(isAuthenticated(req)));
        return;
      }

      // Server-Sent Events: pushes a fresh status snapshot whenever
      // connectionState changes (new QR, connected, disconnected, etc.) so
      // the browser never needs to poll or manually refresh. Each connected
      // client's own auth state (from its own cookie) decides what it's sent.
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        const send = async () => {
          try {
            res.write(`data: ${JSON.stringify(await buildStatusPayload(isAuthenticated(req)))}\n\n`);
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

      // Step 1→2 of the setup wizard: given the owner/assistant details,
      // generate a system prompt via NVIDIA for the owner to review. Not
      // gated by the access code — that only guards the QR/dashboard step —
      // and nothing here starts the WhatsApp connection yet.
      if (req.method === "POST" && url.pathname === "/api/generate-prompt") {
        const body = await readJsonBody(req);
        const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
        const assistantName = typeof body.assistantName === "string" ? body.assistantName.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";

        if (!ownerName || !assistantName || !role || !instructions) {
          sendJson(res, 400, { ok: false, error: "Owner name, assistant name, role, and instructions are all required." });
          return;
        }

        try {
          const generatedPrompt = await generateSystemPrompt({ ownerName, assistantName, role, instructions });
          sendJson(res, 200, { ok: true, prompt: generatedPrompt });
        } catch (err) {
          console.error("❌ Prompt generation failed:", err.message);
          sendJson(res, 502, { ok: false, error: "Could not generate a prompt right now. Please try again." });
        }
        return;
      }

      // Step 2→3 of the setup wizard ("Next"): saves the owner/assistant
      // details and the (possibly edited) prompt, and starts the WhatsApp
      // connection so the QR is ready by the time the owner clears
      // verification. Still not gated by the access code — only the QR/
      // dashboard view itself is (see /api/status and /api/verify below).
      if (req.method === "POST" && url.pathname === "/api/confirm-setup") {
        const body = await readJsonBody(req);
        const ownerName = typeof body.ownerName === "string" ? body.ownerName.trim() : "";
        const assistantName = typeof body.assistantName === "string" ? body.assistantName.trim() : "";
        const role = typeof body.role === "string" ? body.role.trim() : "";
        const instructions = typeof body.instructions === "string" ? body.instructions.trim() : "";
        const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt.trim() : "";

        if (!ownerName || !assistantName || !role || !systemPrompt) {
          sendJson(res, 400, { ok: false, error: "Missing required setup fields." });
          return;
        }

        profile.name = ownerName;
        profile.assistantName = assistantName;
        profile.role = role;
        profile.instructions = instructions;
        profile.systemPrompt = systemPrompt;
        // NVIDIA_API_KEY / NVIDIA_MODEL / ASSISTANT_ACCESS_CODE are
        // intentionally NOT accepted here — they come only from .env, never
        // from the browser.

        console.log("[WEB] Setup wizard completed (assistant profile + system prompt saved).");

        if (!connectionState.startedOnce) {
          connectionState.startedOnce = true;
          startBot().catch((err) => console.error("❌ Failed to start WhatsApp connection:", err.message));
        }

        sendJson(res, 200, { ok: true });
        return;
      }

      // Step 3→4: verification code gating the QR/pairing screen. Rate
      // limited per IP (see access.js) so it can't be brute-forced.
      if (req.method === "POST" && url.pathname === "/api/verify") {
        const ip = clientIp(req);
        const rate = checkRateLimit(ip);
        if (!rate.allowed) {
          sendJson(res, 429, {
            ok: false,
            error: "Too many attempts. Please wait a while before trying again.",
          });
          return;
        }

        const body = await readJsonBody(req);
        if (verifyAccessCode(body.code)) {
          recordSuccessfulAttempt(ip);
          const token = createSession();
          setSessionCookie(res, token);
          console.log("[WEB] Verification code accepted; browser session created.");
          sendJson(res, 200, { ok: true });
        } else {
          recordFailedAttempt(ip);
          sendJson(res, 401, { ok: false, error: "Invalid verification code." });
        }
        return;
      }

      // Browser/web-session logout only — never touches the WhatsApp
      // connection, auth_info_baileys/, or stored conversation data. The
      // next login just needs the verification code again; the setup
      // wizard's saved profile/prompt and the live WhatsApp session are
      // untouched, so it continues right where it left off.
      if (req.method === "POST" && url.pathname === "/api/logout") {
        destroySession(getSessionToken(req));
        clearSessionCookie(res);
        console.log("[WEB] Browser session logged out (WhatsApp connection left untouched).");
        sendJson(res, 200, { ok: true });
        return;
      }

      // Everything below this point is dashboard functionality — gated
      // behind the verification code.
      if (!isAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: "Not verified." });
        return;
      }

      // Lets the owner rename the assistant from the dashboard, without
      // going back through setup. Only the display name changes here — the
      // system prompt already generated during setup is untouched (it may
      // still reference the old name in its wording; re-running "Train
      // Assistant" from setup is how that gets regenerated).
      if (req.method === "POST" && url.pathname === "/api/assistant-name") {
        const body = await readJsonBody(req);
        const assistantName = typeof body.assistantName === "string" ? body.assistantName.trim() : "";
        if (!assistantName) {
          sendJson(res, 400, { ok: false, error: "Assistant name can't be empty." });
          return;
        }
        profile.assistantName = assistantName;
        console.log("[WEB] Assistant name updated via dashboard.");
        sendJson(res, 200, { ok: true, assistantName });
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
        sendJson(res, 200, { text: commandsListText() });
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
