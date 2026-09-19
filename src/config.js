import "./env.js"; // ensures .env is loaded before we read process.env below
import { loadPersistedAvailability, persistAvailability } from "./state.js";

// The owner's assistant profile — read from environment so nothing personal
// is hard-coded throughout the codebase. Defaults here are just fallbacks;
// the web setup wizard (see web.js) is the normal way these get filled in
// for a given owner/role, and overwrites them in memory for this run.
export const profile = {
  name: process.env.AJITH_NAME || "Ajith", // owner's display name
  role: process.env.AJITH_ROLE || "Personal Assistant", // assistant's role (e.g. "Clinic Assistant")
  assistantName: process.env.ASSISTANT_NAME || "Assistant", // assistant's own name
  // Raw behavior/instructions text the owner typed in the setup wizard, kept
  // around only so "Regenerate Prompt" can re-run generation without asking
  // again. Not sent to WhatsApp contacts directly.
  instructions: null,
  // Final system prompt driving WhatsApp replies — either Groq-generated
  // from role+instructions, or edited by the owner, via the setup wizard.
  // In-memory only for the current run (see assistant.js for the fallback
  // used when this hasn't been set yet).
  systemPrompt: null,
  // AVAILABLE means the OWNER is available and handling contacts personally
  // (the AI stays silent for them); UNAVAILABLE means the AI is active as
  // the personal assistant for 1-to-1 contacts. Restored from disk (see
  // state.js) so a restart doesn't flip this — only falls back to
  // process.env.AJITH_AVAILABILITY (read exactly once, here) on first ever
  // run, before anything has been persisted. After startup, nothing in this
  // app ever reads process.env.AJITH_AVAILABILITY again — use
  // getAvailability() / setAvailability() below.
  availability: loadPersistedAvailability() || (process.env.AJITH_AVAILABILITY || "UNAVAILABLE").toUpperCase(),
  // Owner's own WhatsApp identity — BOTH forms, auto-detected from the
  // logged-in Baileys session as soon as the connection opens (see
  // index.js). A WhatsApp account can be addressed as either of these, and
  // they are NOT derived from one another (a @lid id is an opaque id
  // unrelated to the phone number) — confirmed for real: a self-chat message
  // arrived with remoteJid="...@lid" while the phone-number JID was a
  // completely different number. Owner-command matching (commands.js) must
  // check both, the same way Baileys itself checks fromMe internally.
  whatsappJid: process.env.AJITH_WHATSAPP_JID || null, // "<number>@s.whatsapp.net" form
  whatsappLid: null, // "<opaque-id>@lid" form
};

export function getAvailability() {
  return profile.availability;
}

export function setAvailability(value) {
  profile.availability = value;
  persistAvailability(value);
}
