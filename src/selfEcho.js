// Tracks WhatsApp message IDs this bot has itself sent (to ANY chat,
// including the owner's own self-chat), so the messages.upsert handler in
// index.js can recognize and skip them.
//
// Why this exists: in the owner's own "Message Yourself" self-chat, every
// message this bot SENDS via sock.sendMessage() also arrives back through
// messages.upsert, with fromMe: true and remoteJid equal to the owner's own
// JID — indistinguishable, by those fields alone, from something the owner
// actually typed. Without this, the bot's own reply gets mistaken for a new
// owner command/message, gets ANOTHER reply, which echoes back again, and
// so on — an infinite self-reply loop (this is exactly what happened:
// hundreds of messages from a single "hi").
//
// Bounded (not unbounded) since only very recent IDs are ever relevant —
// an echo shows up within the same messages.upsert batch or the very next
// one, never long after.
const recentlySent = new Set();
const MAX_TRACKED = 200;

export function markSelfSent(id) {
  if (!id) return;
  recentlySent.add(id);
  if (recentlySent.size > MAX_TRACKED) {
    const oldest = recentlySent.values().next().value;
    recentlySent.delete(oldest);
  }
}

export function isSelfSent(id) {
  return !!id && recentlySent.has(id);
}
