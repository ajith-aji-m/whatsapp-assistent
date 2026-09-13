import { callNvidiaChat } from "./nvidia.js";
import { getPendingConversations, markConversationHandled } from "./store.js";

const SUMMARY_SYSTEM_PROMPT =
  "detailed thinking off\n" +
  "You summarize a WhatsApp conversation for a personal assistant. " +
  'Write 1-4 short bullet points starting with "-", in third person, describing what the contact wanted ' +
  "and any important detail or request. Skip bare greetings like \"Hi\"/\"Hello\" on their own. " +
  "Base this ONLY on the messages given below — never invent a name, date, deadline, or request that " +
  "isn't explicitly present. " +
  'If nothing meaningful is present, say exactly: "- No clear request — see raw messages."';

async function summarizeMessages(messages) {
  const transcript = messages.map((m) => `- ${m.text}`).join("\n");
  const reply = await callNvidiaChat([
    { role: "system", content: SUMMARY_SYSTEM_PROMPT },
    { role: "user", content: `Messages received:\n${transcript}\n\nSummarize them.` },
  ]);
  return reply || "- No clear request — see raw messages.";
}

function contactLabel(conversation) {
  return conversation.displayName || conversation.jid.split("@")[0];
}

// Builds one combined summary of every pending (not-yet-handled) in-memory
// conversation and sends it to destinationJid — always the exact remoteJid
// the triggering owner command arrived on, never a separately cached
// address, so it lands in the chat thread Ajith is actually using (avoids
// any PN-vs-LID address mismatch). Never sent to the contacts themselves.
// Marks covered messages as handled after a successful send.
export async function sendSummaryToAjith(sock, destinationJid) {
  const pending = getPendingConversations();

  if (pending.length === 0) {
    const text = "No pending conversations.";
    await sock.sendMessage(destinationJid, { text });
    console.log("[SUMMARY] No pending conversations.");
    return text;
  }

  const sections = [];
  let i = 1;
  for (const convo of pending) {
    const summary = await summarizeMessages(convo.messages);
    sections.push(`${i}. ${contactLabel(convo)}\n${summary}`);
    i++;
  }

  const fullText =
    `📋 Pending conversations\n\n${sections.join("\n\n")}\n\n` +
    `These are summaries of conversations received while you were unavailable.`;

  await sock.sendMessage(destinationJid, { text: fullText });

  for (const convo of pending) {
    markConversationHandled(convo.jid);
  }

  console.log(`✅ Sent summary for ${pending.length} conversation(s); marked as handled.`);
  return fullText;
}
