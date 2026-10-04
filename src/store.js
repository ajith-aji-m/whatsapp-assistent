// In-memory conversation store, keyed by WhatsApp JID. No database —
// deliberately simple, and lost on restart (acceptable per design: this is
// just a short-lived holding area for while Ajith is unavailable).
const conversations = new Map();

export function hasConversation(jid) {
  return conversations.has(jid);
}

export function recordMessage(jid, role, text, displayName) {
  if (!conversations.has(jid)) {
    conversations.set(jid, { jid, displayName: displayName ?? null, messages: [], status: "active", closedAt: null });
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

export function isConversationClosed(jid) {
  return conversations.get(jid)?.status === "closed";
}

export function closeConversation(jid) {
  const convo = conversations.get(jid);
  if (!convo) return;
  convo.status = "closed";
  convo.closedAt = Date.now();
}

export function reopenConversation(jid, displayName) {
  conversations.set(jid, {
    jid,
    displayName: displayName ?? conversations.get(jid)?.displayName ?? null,
    messages: [],
    status: "active",
    closedAt: null,
  });
  return conversations.get(jid);
}

export function getPendingConversations() {
  return [...conversations.values()]
    .map((c) => ({
      jid: c.jid,
      displayName: c.displayName,
      messages: c.messages.filter((m) => m.role === "contact" && !m.handled),
    }))
    .filter((c) => c.messages.length > 0);
}

export function markConversationHandled(jid) {
  const convo = conversations.get(jid);
  if (!convo) return;
  for (const m of convo.messages) {
    if (m.role === "contact") m.handled = true;
  }
}
