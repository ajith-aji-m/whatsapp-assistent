import "./env.js"; // ensures .env is loaded before we read process.env below
import { loadPersistedAvailability, persistAvailability } from "./state.js";
import { loadPersistedProfile, persistProfile } from "./profileStore.js";
import { connectionEvents } from "./connectionState.js";

// Restored once at startup, if a previous run ever saved one (see
// persistCurrentProfile below) — takes priority over the env-var defaults so
// a dashboard-configured profile (name, assistant name, role, generated
// prompt, schedule) survives a server restart without redoing the setup
// wizard. null on first-ever run, before anything has been saved.
const persisted = loadPersistedProfile();

// The owner's assistant profile — read from environment so nothing personal
// is hard-coded throughout the codebase. Defaults here are just fallbacks;
// the web setup wizard (see web.js) is the normal way these get filled in
// for a given owner/role, and overwrites them in memory for this run.
export const profile = {
  name: persisted?.name ?? process.env.AJITH_NAME ?? "Ajith", // owner's display name
  role: persisted?.role ?? process.env.AJITH_ROLE ?? "Personal Assistant", // assistant's role (e.g. "Clinic Assistant")
  assistantName: persisted?.assistantName ?? process.env.ASSISTANT_NAME ?? "Assistant", // assistant's own name
  // Raw behavior/instructions text the owner typed in the setup wizard, kept
  // around only so "Regenerate Prompt" can re-run generation without asking
  // again. Not sent to WhatsApp contacts directly.
  instructions: persisted?.instructions ?? null,
  // Final system prompt driving WhatsApp replies — either Groq-generated
  // from role+instructions, or edited by the owner, via the setup wizard.
  // Persisted (see persistCurrentProfile) so a restart doesn't silently fall
  // back to the generic default prompt. IMPORTANT: this is the ONLY place
  // the assistant's identity/behavior text lives — see renameAssistant()
  // below for why it can't just be left stale when assistantName changes.
  systemPrompt: persisted?.systemPrompt ?? null,
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

  // OPTIONAL personal/professional profile + schedule info (profession,
  // workplace, working days/hours, breaks, preferred contact hours — see
  // web.js's setup wizard/dashboard for how these get filled in). Every
  // field inside scheduleProfile is itself optional. Both default to
  // "nothing configured" so that, unless the owner deliberately fills this
  // in AND enables it, assistant.js's contact-facing prompt is completely
  // unchanged from before this feature existed — never invented, never
  // required. In-memory only, like the rest of the setup-wizard profile
  // fields above (only availability is persisted to disk — see state.js).
  scheduleEnabled: persisted?.scheduleEnabled ?? false,
  scheduleProfile: persisted?.scheduleProfile ?? null,
};

// Persists every dashboard/wizard-configurable profile field (everything
// EXCEPT availability, which state.js already owns separately, and
// whatsappJid/whatsappLid, which must always come fresh from the live
// Baileys session — never a stale saved value). Called after every mutation
// below so "the latest saved configuration" and "what's on disk" can never
// drift apart.
export function persistCurrentProfile() {
  persistProfile({
    name: profile.name,
    role: profile.role,
    assistantName: profile.assistantName,
    instructions: profile.instructions,
    systemPrompt: profile.systemPrompt,
    scheduleEnabled: profile.scheduleEnabled,
    scheduleProfile: profile.scheduleProfile,
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// THE single legitimate way to change the assistant's name after setup
// (used by web.js's "/api/assistant-name" dashboard endpoint). Renaming only
// profile.assistantName is not enough: assistant.js's contact-facing system
// prompt uses profile.systemPrompt verbatim whenever one has been generated
// (see assistant.js), and that text has the OLD name baked into its prose by
// Groq at generation time — so without this, every reply after the first
// would keep introducing the assistant by its old name forever, no matter
// what the dashboard shows. Rather than regenerating the whole prompt (which
// would also discard any wording the owner hand-edited), this does a
// targeted whole-word replace of the exact old name with the new one,
// leaving the rest of the owner's prompt untouched.
export function renameAssistant(newName) {
  const trimmed = (newName || "").trim();
  if (!trimmed) return; // caller (web.js) already validates; defense in depth
  const oldName = profile.assistantName;

  profile.assistantName = trimmed;

  if (profile.systemPrompt && oldName && oldName !== trimmed) {
    const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, "g");
    profile.systemPrompt = profile.systemPrompt.replace(pattern, trimmed);
  }

  persistCurrentProfile();
}

export function getAvailability() {
  return profile.availability;
}

export function setAvailability(value) {
  profile.availability = value;
  persistAvailability(value);
  // Notify the web dashboard's SSE stream (see connectionState.js/web.js) so
  // an IN/OUT change is reflected live on every open dashboard tab —
  // regardless of whether it was triggered from the dashboard's own buttons
  // or from the owner's "/in"/"/out" WhatsApp commands (commands.js). Each
  // listener rebuilds its own fresh status snapshot on this event, so the
  // emitted value here is unused.
  connectionEvents.emit("update");
}
