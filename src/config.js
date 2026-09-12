import "./env.js"; // ensures .env is loaded before we read process.env below

// Ajith's assistant profile — read from environment so nothing personal is
// hard-coded throughout the codebase. Defaults here are just fallbacks.
export const profile = {
  name: process.env.AJITH_NAME || "Ajith",
  role: process.env.AJITH_ROLE || "Developer",
  // In-memory only. process.env.AJITH_AVAILABILITY is read exactly ONCE,
  // right here, as the startup default. After that, nothing in this app ever
  // reads process.env.AJITH_AVAILABILITY again — use getAvailability() /
  // setAvailability() below, which only touch this in-memory field.
  availability: (process.env.AJITH_AVAILABILITY || "UNAVAILABLE").toUpperCase(),
  // Ajith's own WhatsApp identity — BOTH forms, auto-detected from the
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
}
