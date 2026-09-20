import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  generateMessageIDV2,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";
import fs from "node:fs/promises";
import { profile } from "./config.js"; // also loads .env as a side effect (see config.js)
import { hasConversation, recordMessage } from "./store.js";
import { handleOwnerCommand, isAjith } from "./commands.js";
import { generateAssistantReply } from "./assistant.js";
import { handleOwnerMessage } from "./ownerAssistant.js";
import { setStatus, connectionState } from "./connectionState.js";
import { markSelfSent, isSelfSent } from "./selfEcho.js";

// Back to "silent" now that the connection itself is confirmed working —
// keeps the terminal readable while we test message handling.
const logger = pino({ level: "silent" });

// Set right before logoutWhatsApp() (below) intentionally closes the socket
// itself — the "connection.update" close handler further down always calls
// startBot() again to auto-heal from a DROPPED connection, which is correct
// for an organic disconnect (network blip, the owner unlinking the device
// from their own phone, etc.) but wrong for an explicit web-dashboard
// logout: there, the caller (web.js) — not this generic reconnect logic —
// decides what happens next (Option 1 restarts immediately for a fresh QR;
// Option 2 waits for the setup wizard to run again). Consumed exactly once
// per logoutWhatsApp() call.
let suppressNextAutoReconnect = false;

// The current socket's saveCreds callback (see startBot below) — kept here
// so logoutWhatsApp() can unregister it before deleting auth_info_baileys/.
let currentSaveCreds = null;

if (!process.env.GROQ_API_KEY) {
  console.error(
    "❌ GROQ_API_KEY is missing in .env — contact auto-replies, the pending-conversation summary, and the " +
      "owner assistant's natural-language routing/chat will all fail until it's set (the owner assistant's " +
      "slash commands like /task, /note, /remind still work without it)."
  );
}

if (!process.env.ASSISTANT_ACCESS_CODE) {
  console.error(
    "❌ ASSISTANT_ACCESS_CODE is missing in .env — the web setup's verification step will reject every code until it's set."
  );
}

async function startBot() {
  setStatus("connecting");

  // Persist WhatsApp login session in ./auth_info_baileys/
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  // Ask WhatsApp's servers for the current protocol version instead of
  // trusting the version baked into this Baileys build — a stale baked-in
  // version is the most common cause of "QR scans but nothing happens".
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WA version ${version.join(".")}, isLatest: ${isLatest}`);

  const sock = makeWASocket({
    auth: state,
    logger,
    version,
  });

  // Made available immediately (not just once "connected" — see the
  // connection.update handler below, which only ever put it in
  // connectionState on that one transition) so logoutWhatsApp() can find and
  // properly log out the CURRENT socket even while still mid-QR-scan or
  // reconnecting, not only once fully linked.
  connectionState.sock = sock;

  // Wrap sendMessage so EVERY message this bot ever sends — from here, from
  // commands.js, summary.js, ownerAssistant.js, reminderScheduler.js, all of
  // which call sock.sendMessage on this same object — gets its WhatsApp
  // message id recorded (see selfEcho.js for why this matters: without it,
  // a message this bot sends to the owner's own self-chat comes back
  // through messages.upsert indistinguishable from something the owner
  // typed, and gets replied to again, forever).
  //
  // The id is generated and marked BEFORE the send happens (not after
  // awaiting it) — Baileys emits the local "own message" echo via
  // process.nextTick internally, which can beat the `await` below back to
  // this function, so marking it post-hoc left a race window where the
  // bot's own reply slipped past isSelfSent() and got treated as a new
  // owner message, triggering another AI call and another reply, forever.
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    const messageId = options.messageId || generateMessageIDV2(sock.user?.id);
    markSelfSent(messageId);
    return originalSendMessage(jid, content, { ...options, messageId });
  };

  // Save updated credentials whenever they change
  sock.ev.on("creds.update", saveCreds);
  // Exposed so logoutWhatsApp() (below) can unregister this BEFORE deleting
  // auth_info_baileys/ — sock.logout() doesn't fully await its own internal
  // teardown before resolving, so without this a creds.update event could
  // still land in that narrow window and have Baileys silently re-write
  // files into the directory right after we've deleted it.
  currentSaveCreds = saveCreds;

  // Handle connection state changes (QR code, open, close)
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // The QR itself is rendered in the web UI (see web.js/index.html) —
      // nothing sensitive is printed to the server console for it.
      console.log("QR code ready — scan it from the web UI.");
      setStatus("qr", { qr });
    }

    if (connection === "open") {
      console.log("✅ WhatsApp connected successfully!");

      // Detect the owner's own identity from the logged-in session itself —
      // no manual JID entry needed. A WhatsApp account has TWO possible
      // identities that can show up as a message's remoteJid: the
      // phone-number JID (sock.user.id) and the LID (sock.user.lid) — these
      // are NOT derived from each other (a self-chat message can arrive
      // under either form). Both are captured so owner-command matching
      // (commands.js) can check either form. Neither is logged — they're
      // effectively the owner's phone number.
      const ownerJid = jidNormalizedUser(sock.user?.id);
      const ownerLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;

      if (ownerJid) {
        profile.whatsappJid = ownerJid;
      } else {
        console.error("⚠️ Could not detect the logged-in owner phone JID from sock.user.");
      }
      profile.whatsappLid = ownerLid;

      setStatus("connected", { qr: null, sock });
    }

    if (connection === "close") {
      // An explicit web-dashboard logout (see logoutWhatsApp below) closes
      // this same socket itself — that MUST NOT fall through to the
      // organic-disconnect handling below (which would call startBot()
      // again immediately, racing with whatever the caller in web.js is
      // about to do — e.g. Option 2 deliberately waits for the setup
      // wizard to run again before reconnecting).
      if (suppressNextAutoReconnect) {
        suppressNextAutoReconnect = false;
        console.log("Connection closed as part of an explicit logout — not auto-reconnecting from here.");
        return;
      }

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      console.log(
        `Connection closed (status code: ${statusCode}).`,
        loggedOut ? "Logged out — clearing stale session and generating a new QR." : "Reconnecting..."
      );

      setStatus(loggedOut ? "logged_out" : "reconnecting", { qr: null, sock: null });

      if (loggedOut) {
        // The saved credentials are no longer valid (session removed from
        // the phone, expired, etc.) — clear them so useMultiFileAuthState
        // starts fresh next call and Baileys emits a brand-new `qr` event,
        // instead of dead-ending here and requiring a manual restart.
        try {
          await fs.rm("auth_info_baileys", { recursive: true, force: true });
        } catch (err) {
          console.error("❌ Failed to clear stale auth_info_baileys/:", err.message);
        }
      }

      startBot();
    }
  });

  // Listen for incoming messages
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message) continue; // no content (e.g. protocol/receipt messages)

      // Our own message echoing back (see selfEcho.js) — never process it as
      // new input, regardless of chat. Must come before every other check.
      if (isSelfSent(msg.key.id)) continue;

      const remoteJid = msg.key.remoteJid;
      const fromMe = !!msg.key.fromMe;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
      const recognizedAsOwnerCommand = fromMe && isAjith(remoteJid) && !!text;

      // Group/status guard FIRST, before anything else — never act on these,
      // regardless of who sent them.
      if (remoteJid && remoteJid.endsWith("@g.us")) continue;
      if (!remoteJid || remoteJid === "status@broadcast") continue;

      // Owner commands ("/in", "/out", "/summary"): Ajith sends these to
      // himself via his own "Message Yourself" WhatsApp chat.
      // Because this bot IS a linked device on Ajith's own account, that
      // message arrives here with fromMe: true too — the same flag used on
      // the bot's own outgoing replies. So this checks BOTH fromMe AND that
      // remoteJid matches one of Ajith's two known identities (isAjith
      // checks phone JID and LID separately), before the generic fromMe skip
      // below — every other fromMe message (including the bot's own sent
      // messages, and any other self-chat text that isn't one of the three
      // exact commands) falls through and is ignored as always, and the
      // normal contact-handling logic never runs for a recognized command.
      if (recognizedAsOwnerCommand) {
        try {
          const handled = await handleOwnerCommand(sock, remoteJid, text);
          // Not one of the pre-existing /in, /out, /summary, /list
          // commands — hand it to the owner's own productivity
          // assistant (tasks/reminders/notes/links/search/chat, see
          // ownerAssistant.js). Still exactly the same isAjith()-gated,
          // group-excluded self-chat this block already only runs for.
          if (!handled) await handleOwnerMessage(sock, remoteJid, text);
        } catch (err) {
          console.error("❌ Error handling owner command:", err.message);
        }
        continue; // the owner's own message never falls through to the contact-reply flow below
      }

      if (fromMe) continue; // ignore our own messages/replies to prevent loops

      if (!text) continue; // ignore non-text messages (images, stickers, etc.) for now

      // AVAILABLE means the OWNER is available and handling this contact
      // personally — the AI must stay completely silent: no reply, no
      // typing indicator, no LLM call, and (deliberately) no recordMessage
      // either, so nothing here gets queued up and answered later once the
      // owner goes UNAVAILABLE again. UNAVAILABLE is the only state in which
      // the AI acts as the personal assistant for 1-to-1 contacts.
      if (profile.availability === "AVAILABLE") continue;

      try {
        const isFirstMessage = !hasConversation(remoteJid);
        const conversation = recordMessage(remoteJid, "contact", text, msg.pushName);

        // The very first message from a contact always gets this exact
        // fixed greeting (no Groq call needed for it); every message after
        // that gets a natural Groq-generated reply that keeps the
        // conversation going (see assistant.js), while still recording
        // everything for the next /summary.
        const reply = isFirstMessage
          ? `Hi! ${profile.name} is currently unavailable. I'm ${profile.assistantName}, ${profile.name}'s ${profile.role}. Is there anything you'd like to tell ${profile.name}?`
          : await generateAssistantReply(conversation);

        await sock.sendMessage(remoteJid, { text: reply });
        recordMessage(remoteJid, "assistant", reply);
      } catch (err) {
        // generateAssistantReply already has its own fallback/catch for
        // Groq failures — this only catches something else going wrong
        // (e.g. sock.sendMessage itself failing), so the bot never crashes.
        console.error("❌ Error handling message:", err.message);
      }
    }
  });
}

// Properly logs the linked device out of WhatsApp — sends the actual
// "remove-companion-device" logout request (via Baileys' sock.logout()) so
// the device disappears from the phone's own "Linked Devices" list, not
// just a local disconnect, then clears the local auth_info_baileys/ session
// so this app can't silently reconnect as that device again. Used by
// web.js's two dashboard logout options — NEVER called just because a
// browser tab/session closed (see access.js/web.js: web-session logout and
// WhatsApp logout are deliberately separate concepts).
//
// Deterministic regardless of what state the connection is currently in
// (connected, mid-QR, reconnecting, or nothing at all): suppresses the
// existing auto-reconnect-on-close logic above (so it can't race with or
// duplicate what this function itself does), does the actual logout +
// local cleanup itself, and leaves the DECISION of whether/when to
// reconnect entirely to the caller (see web.js) — this function never calls
// startBot() itself.
export async function logoutWhatsApp() {
  suppressNextAutoReconnect = true;
  const sock = connectionState.sock;

  if (sock) {
    try {
      await sock.logout();
    } catch (err) {
      console.error("⚠️ WhatsApp logout() request failed (clearing local session anyway):", err.message);
    }
    try {
      sock.end(undefined);
    } catch {
      // Already closed by logout() itself (or was never fully open) — fine.
    }
  } else {
    suppressNextAutoReconnect = false; // no close event will fire to consume it
  }

  // sock.logout() doesn't fully await its own internal teardown before
  // resolving — unregister the creds-saving listener explicitly so a
  // trailing creds.update event can't silently re-write files into
  // auth_info_baileys/ in the instant right after we delete it below.
  if (sock && currentSaveCreds) {
    try {
      sock.ev.off("creds.update", currentSaveCreds);
    } catch {
      // Emitter may already be torn down by logout()'s own end() — fine.
    }
  }
  currentSaveCreds = null;

  try {
    await fs.rm("auth_info_baileys", { recursive: true, force: true });
  } catch (err) {
    console.error("❌ Failed to clear auth_info_baileys/ during logout:", err.message);
  }

  profile.whatsappJid = null;
  profile.whatsappLid = null;
  setStatus("idle", { qr: null, sock: null, connectedAt: null });
  connectionState.startedOnce = false;
}

// Started by server.js once the web setup form is submitted (instead of
// unconditionally at module load) — nothing about startBot's own logic
// changed, only when it's first invoked. The recursive startBot() call
// above (on an unexpected disconnect) is unchanged.
export { startBot };
