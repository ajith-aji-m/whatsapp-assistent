// In-memory conversation store, keyed by WhatsApp JID. No database —
// deliberately simple, and lost on restart (acceptable per design: this is
// just a short-lived holding area for while Ajith is unavailable).
const conversations = new Map();

export function hasConversation(jid) {
  return conversations.has(jid);
}

// Records one turn of a conversation. role is "contact" or "assistant".
// Creates the conversation on first use and returns it.
export function recordMessage(jid, role, text, displayName) {
  if (!conversations.has(jid)) {
    conversations.set(jid, { jid, displayName: displayName ?? null, messages: [] });
  } else if (displayName) {
    conversations.get(jid).displayName = displayName;
  }

  const convo = conversations.get(jid);
  convo.messages.push({ role, text, timestamp: Date.now(), handled: false });
  return convo;
}

export function getConversation(jid) {
  return conversations.get(jid);
}

// One entry per contact that has at least one not-yet-handled incoming
// message, with just those pending messages (not the assistant's own
// replies — the summary should reflect only what was actually received).
export function getPendingConversations() {
  return [...conversations.values()]
    .map((c) => ({
      jid: c.jid,
      displayName: c.displayName,
      messages: c.messages.filter((m) => m.role === "contact" && !m.handled),
    }))
    .filter((c) => c.messages.length > 0);
}

// Marks every contact message in a conversation as handled — called after a
// summary covering it has been sent, so the same messages aren't
// re-summarized next time. Does not delete anything.
export function markConversationHandled(jid) {
  const convo = conversations.get(jid);
  if (!convo) return;
  for (const m of convo.messages) {
    if (m.role === "contact") m.handled = true;
  }
}
