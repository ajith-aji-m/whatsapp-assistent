import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import { profile, setAvailability, renameAssistant, persistCurrentProfile, resetProfile } from "./config.js";
import { connectionState, connectionEvents } from "./connectionState.js";
import { sendSummaryToAjith } from "./summary.js";
import { commandsListText, commandsList } from "./commands.js";
import { generateSystemPrompt, generateFieldSuggestion } from "./groq.js";

const SUGGEST_ELIGIBLE_FIELDS = new Set(["role", "profession"]);
import { getScheduleSnapshot } from "./time.js";
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  isValidSession,
  destroySession,
  checkRateLimit,
  recordFailedAttempt,
  recordSuccessfulAttempt,
  verifyAccessCode,
} from "./access.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPublicFile(relPath) {
  return fs.readFileSync(path.join(__dirname, "public", relPath));
}
const STATIC_ASSETS = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "application/javascript; charset=utf-8" },
  "/suggest.js": { file: "suggest.js", type: "application/javascript; charset=utf-8" },
  "/assets/robot.svg": { file: "assets/robot.svg", type: "image/svg+xml" },
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
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

function isHttps(req) {
  return req.headers["x-forwarded-proto"] === "https" || !!req.socket.encrypted;
}

function setSessionCookie(res, token, req) {
  const secure = isHttps(req) ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function clientIp(req) {
  return req.socket.remoteAddress || "unknown";
}

const SCHEDULE_WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const HHMM_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

function sanitizeScheduleTime(value) {
  return typeof value === "string" && HHMM_RE.test(value.trim()) ? value.trim() : "";
}

function sanitizeScheduleProfile(body) {
  const src = body && typeof body === "object" ? body : {};
  const workingDays = Array.isArray(src.workingDays) ? src.workingDays.filter((d) => SCHEDULE_WEEKDAYS.includes(d)) : [];

  const scheduleProfile = {
    profession: typeof src.profession === "string" ? src.profession.trim() : "",
    workplace: typeof src.workplace === "string" ? src.workplace.trim() : "",
    location: typeof src.location === "string" ? src.location.trim() : "",
    workingDays,
    workingHoursStart: sanitizeScheduleTime(src.workingHoursStart),
    workingHoursEnd: sanitizeScheduleTime(src.workingHoursEnd),
    breakStart: sanitizeScheduleTime(src.breakStart),
    breakEnd: sanitizeScheduleTime(src.breakEnd),
    preferredStart: sanitizeScheduleTime(src.preferredStart),
    preferredEnd: sanitizeScheduleTime(src.preferredEnd),
    notes: typeof src.notes === "string" ? src.notes.trim() : "",
  };

  const hasAnyData = Object.values(scheduleProfile).some((v) => (Array.isArray(v) ? v.length > 0 : !!v));
  return hasAnyData ? scheduleProfile : null;
}

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
    connectedAt: connectionState.connectedAt,
    profile: {
      name: profile.name,
      role: profile.role,
      assistantName: profile.assistantName,
      availability: profile.availability,
      scheduleEnabled: profile.scheduleEnabled,
      scheduleProfile: profile.scheduleProfile,
    },
    scheduleSnapshot:
      profile.scheduleEnabled && profile.scheduleProfile ? getScheduleSnapshot(profile.scheduleProfile) : null,
  };
}

export function startWebServer({ startBot, logoutWhatsApp, host, port }) {
  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }

    try {
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(readPublicFile("index.html"));
        return;
      }

      if (req.method === "GET" && STATIC_ASSETS[url.pathname]) {
        const asset = STATIC_ASSETS[url.pathname];
        res.writeHead(200, { "Content-Type": asset.type, "Cache-Control": "no-cache" });
        res.end(readPublicFile(asset.file));
        return;
      }

      if ((req.method === "GET" || req.method === "HEAD") && (url.pathname === "/health" || url.pathname === "/api/health")) {
        const payload = {
          status: "ok",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        };
        if (req.method === "HEAD") {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end();
        } else {
          sendJson(res, 200, payload);
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        sendJson(res, 200, await buildStatusPayload(isAuthenticated(req)));
        return;
      }

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
            /* noop */
          }
        };
        send();
        const listener = () => send();
        connectionEvents.on("update", listener);
        req.on("close", () => connectionEvents.off("update", listener));
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/generate-prompt") {
        if (profile.systemPrompt && !isAuthenticated(req)) {
          sendJson(res, 401, { ok: false, error: "Not verified." });
          return;
        }
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

      if (req.method === "POST" && url.pathname === "/api/suggest") {
        const body = await readJsonBody(req);
        const field = typeof body.field === "string" ? body.field : "";
        const value = typeof body.value === "string" ? body.value : "";

        if (!SUGGEST_ELIGIBLE_FIELDS.has(field) || !value.trim() || value.length > 60) {
          sendJson(res, 200, { ok: true, suggestion: null });
          return;
        }

        const suggestion = await generateFieldSuggestion({ field, value });
        sendJson(res, 200, { ok: true, suggestion });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/confirm-setup") {
        if (profile.systemPrompt && !isAuthenticated(req)) {
          sendJson(res, 401, { ok: false, error: "Not verified." });
          return;
        }
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

        const scheduleProfile = sanitizeScheduleProfile(body.scheduleProfile);
        profile.scheduleProfile = scheduleProfile;
        profile.scheduleEnabled = !!body.scheduleEnabled && !!scheduleProfile;

        persistCurrentProfile();
        console.log("[WEB] Setup wizard completed (assistant profile + system prompt saved).");

        if (!connectionState.startedOnce) {
          connectionState.startedOnce = true;
          startBot().catch((err) => console.error("❌ Failed to start WhatsApp connection:", err.message));
        }

        sendJson(res, 200, { ok: true });
        return;
      }

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
          setSessionCookie(res, token, req);
          console.log("[WEB] Verification code accepted; browser session created.");
          sendJson(res, 200, { ok: true });
        } else {
          recordFailedAttempt(ip);
          sendJson(res, 401, { ok: false, error: "Invalid verification code." });
        }
        return;
      }

      if (!isAuthenticated(req)) {
        sendJson(res, 401, { ok: false, error: "Not verified." });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        destroySession(getSessionToken(req));
        clearSessionCookie(res);

        await logoutWhatsApp();
        console.log("[WEB] Logged out: web session ended, WhatsApp device logged out, profile/settings kept.");

        connectionState.startedOnce = true;
        startBot().catch((err) => console.error("❌ Failed to restart WhatsApp connection after logout:", err.message));

        connectionEvents.emit("update");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout-clear-data") {
        destroySession(getSessionToken(req));
        clearSessionCookie(res);

        await logoutWhatsApp();
        resetProfile();
        console.log("[WEB] Logged out and cleared data: web session ended, WhatsApp device logged out, profile reset.");

        connectionEvents.emit("update");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/assistant-name") {
        const body = await readJsonBody(req);
        const assistantName = typeof body.assistantName === "string" ? body.assistantName.trim() : "";
        if (!assistantName) {
          sendJson(res, 400, { ok: false, error: "Assistant name can't be empty." });
          return;
        }
        renameAssistant(assistantName);
        console.log("[WEB] Assistant name updated via dashboard.");
        sendJson(res, 200, { ok: true, assistantName: profile.assistantName });
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

      if (req.method === "POST" && url.pathname === "/api/schedule-profile") {
        const body = await readJsonBody(req);
        const scheduleProfile = sanitizeScheduleProfile(body.scheduleProfile);
        profile.scheduleProfile = scheduleProfile;
        profile.scheduleEnabled = !!body.scheduleEnabled && !!scheduleProfile;
        persistCurrentProfile();
        console.log(`[WEB] Schedule-aware profile ${profile.scheduleEnabled ? "enabled" : "disabled"} via dashboard.`);
        sendJson(res, 200, { ok: true, scheduleEnabled: profile.scheduleEnabled, scheduleProfile: profile.scheduleProfile });
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
        sendJson(res, 200, { text: commandsListText(), commands: commandsList() });
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
