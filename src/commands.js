import { areJidsSameUser } from "@whiskeysockets/baileys";
import { profile, setAvailability } from "./config.js";
import { sendSummaryToAjith } from "./summary.js";

// Single source of truth for the command list text — used by both the
// "/list" WhatsApp command below and the web UI's "Show Commands" button.
// A function (not a constant) so it always reflects the current owner's name
// from config.js, whoever that is for this run.
export function commandsListText() {
  return (
    "Available commands:\n\n" +
    `/available — Set ${profile.name}'s availability to available and process pending conversations.\n` +
    `/unavailable — Set ${profile.name}'s availability to unavailable.\n` +
    "/summary — Generate a summary of pending conversations.\n" +
    "/list — Show this list of available commands."
  );
}

// True only for Ajith's own WhatsApp identity — auto-detected at connection
// time (see index.js), never something a contact can influence.
//
// IMPORTANT: a WhatsApp account can be addressed as EITHER its phone-number
// JID ("...@s.whatsapp.net") OR its LID ("...@lid"), and the two are NOT
// derived from each other — confirmed for real, where a self-chat message's
// remoteJid came back as a totally different number under "@lid" than the
// account's own phone number. So this checks the incoming jid against each
// of Ajith's two known identities SEPARATELY (same-type comparison only),
// exactly like Baileys' own internal fromMe check does:
// areJidsSameUser(from, creds.me.id) || areJidsSameUser(from, creds.me.lid)
export function isAjith(jid) {
  if (!jid) return false;
  if (profile.whatsappJid && areJidsSameUser(jid, profile.whatsappJid)) return true;
  if (profile.whatsappLid && areJidsSameUser(jid, profile.whatsappLid)) return true;
  return false;
}

// Handles "/available", "/unavailable", "/summary" sent from Ajith's own
// WhatsApp chat (his "Message Yourself" conversation, which may show up as
// either his phone-number JID or his LID — see isAjith above). Returns true
// if the message was a recognized owner command — the caller should not run
// the normal AI chat handler on it either way, since it came from Ajith's
// own account. Always replies on the SAME remoteJid the command arrived on
// (not a separately cached address), so the reply lands in the exact chat
// thread Ajith is actually looking at.
export async function handleOwnerCommand(sock, remoteJid, text) {
  if (!isAjith(remoteJid)) return false;

  const command = text.trim().toLowerCase();

  if (command === "/available") {
    console.log("[COMMAND] /available recognized as owner command");
    setAvailability("AVAILABLE");
    console.log("[STATE] Availability changed: AVAILABLE");
    console.log("[SUMMARY] Generating summary...");
    await sendSummaryToAjith(sock, remoteJid);
    return true;
  }

  if (command === "/unavailable") {
    console.log("[COMMAND] /unavailable recognized as owner command");
    setAvailability("UNAVAILABLE");
    console.log("[STATE] Availability changed: UNAVAILABLE");
    await sock.sendMessage(remoteJid, { text: "Availability changed to unavailable." });
    return true;
  }

  if (command === "/summary") {
    console.log("[COMMAND] /summary recognized as owner command");
    console.log("[SUMMARY] Generating summary...");
    await sendSummaryToAjith(sock, remoteJid);
    return true;
  }

  if (command === "/list") {
    console.log("[COMMAND] /list recognized as owner command");
    await sock.sendMessage(remoteJid, { text: commandsListText() });
    return true;
  }

  return false;
}
