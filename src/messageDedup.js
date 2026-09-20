// Deduplicates incoming WhatsApp messages by their unique key.id, so a
// message that WhatsApp/Baileys delivers to messages.upsert more than once
// (a lost/delayed delivery receipt causing the server to resend the same
// stanza, a reconnect replaying recently-queued messages, a history-sync
// "append" event for something we already handled live) is only ever acted
// on once. Text can't be used for this — two different messages ("Hi") can
// legitimately share the same text, but never the same key.id.
//
// TTL-bounded rather than a permanent record: only redeliveries that arrive
// within WhatsApp's own retry/replay window are ever relevant (seconds to
// minutes), never hours later, so entries are swept out after TTL_MS
// instead of growing the Map forever across a long-running process.
const seen = new Map(); // "remoteJid:id" -> timestamp of first sighting
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export function isDuplicateMessage(remoteJid, id) {
  if (!id) return false; // nothing to key on — let it through rather than misfire dedup

  const key = `${remoteJid}:${id}`;
  if (seen.has(key)) return true;

  seen.set(key, Date.now());
  return false;
}

// Runs independently of any one WhatsApp connection/socket, so it keeps
// working across reconnects without needing to be reset or re-created.
setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [key, ts] of seen) {
    if (ts < cutoff) seen.delete(key);
  }
}, TTL_MS).unref();
