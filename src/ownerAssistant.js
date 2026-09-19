import { connectionState } from "./connectionState.js";
import {
  addTask,
  listTasks,
  completeTask,
  addReminder,
  listReminders,
  addNote,
  listNotes,
  addLink,
  listLinks,
  getCounts,
  searchAll,
} from "./productivityStore.js";
import { routeOwnerMessage, generateLinkTitle, groqConfigured } from "./groq.js";
import { resolveTodayOrTomorrowAt, formatLocalDateTime } from "./time.js";

// This module is the owner's OWN productivity assistant — tasks, reminders,
// notes, links, search, summary, help, status, and normal AI chat — reached
// only from Ajith's own self-chat (see index.js: handleOwnerMessage is only
// ever called after the existing group guard AND the existing isAjith()
// owner check have both already passed, exactly like the pre-existing
// /available, /unavailable, /summary, /list owner commands in commands.js).
// It never runs for a group message or for a message from anyone else.
//
// NOTE ON /summary: the pre-existing "/summary" command (commands.js) is
// untouched and keeps meaning "summarize pending CONTACT conversations". To
// avoid colliding with that, this module's own "show my tasks/reminders/
// notes/links" summary lives under "/mysummary" instead (also reachable via
// natural language like "today summary kudu" / "show my summary").

// ---- Small in-memory conversation context, separate from store.js's
// contact-conversation store (that one is for summarizing what CONTACTS
// sent; this one is for the owner's own back-and-forth with the assistant).
// Lost on restart — fine, matches every other piece of state in this app.
const MAX_CONTEXT_MESSAGES = 20;
const ownerContext = [];

function recordContext(role, text) {
  ownerContext.push({ role, text });
  if (ownerContext.length > MAX_CONTEXT_MESSAGES) ownerContext.shift();
}

// ---- URL helpers ----

function normalizeUrl(str) {
  return /^https?:\/\//i.test(str) ? str : `https://${str}`;
}

function isValidUrl(str) {
  try {
    new URL(str);
    return true;
  } catch {
    return false;
  }
}

// ---- /remind time-spec parsing (deterministic — no AI call needed for the
// documented command syntax) ----

function parseRemindTimeSpec(rest) {
  let m;

  if ((m = rest.match(/^(\d+)\s*(m|min|mins|minute|minutes)\s+(.+)$/i))) {
    const mins = parseInt(m[1], 10);
    return { remindAt: new Date(Date.now() + mins * 60_000), message: m[3].trim() };
  }
  if ((m = rest.match(/^(\d+)\s*(h|hr|hrs|hour|hours)\s+(.+)$/i))) {
    const hrs = parseInt(m[1], 10);
    return { remindAt: new Date(Date.now() + hrs * 3_600_000), message: m[3].trim() };
  }
  if ((m = rest.match(/^(tomorrow|today)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+(.+)$/i))) {
    const [, day, hourStr, minStr, ampm, message] = m;
    let hour = parseInt(hourStr, 10);
    const min = minStr ? parseInt(minStr, 10) : 0;
    if (ampm) {
      const isPM = ampm.toLowerCase() === "pm";
      if (isPM && hour < 12) hour += 12;
      if (!isPM && hour === 12) hour = 0;
    }
    if (hour > 23 || min > 59) return null;
    return { remindAt: resolveTodayOrTomorrowAt(day.toLowerCase(), hour, min), message: message.trim() };
  }

  return null;
}

// ---- Deterministic slash-command parsing. Covers the documented command
// syntax with zero AI calls (works even without GROQ_API_KEY configured) —
// only genuinely free-form/natural-language text falls through to Groq. ----

function parseDeterministic(rawText) {
  const text = rawText.trim();

  if (/^\/help$/i.test(text) || /^help$/i.test(text) || /^what can you do\??$/i.test(text)) {
    return { intent: "HELP" };
  }
  if (/^\/status$/i.test(text)) return { intent: "STATUS" };
  if (/^\/mysummary$/i.test(text)) return { intent: "SUMMARY" };

  if (/^\/tasks$/i.test(text)) return { intent: "TASK_LIST" };
  let m = text.match(/^\/task\s+done\s+#?(\d+)$/i);
  if (m) return { intent: "TASK_COMPLETE", taskId: parseInt(m[1], 10) };
  m = text.match(/^\/task\s+(.+)$/i);
  if (m) return { intent: "TASK_CREATE", title: m[1].trim() };

  if (/^\/reminders$/i.test(text)) return { intent: "REMINDER_LIST" };
  m = text.match(/^\/remind\s+(.+)$/i);
  if (m) {
    const parsed = parseRemindTimeSpec(m[1].trim());
    if (!parsed) return { intent: "REMINDER_PARSE_ERROR" };
    return { intent: "REMINDER_CREATE", message: parsed.message, remindAt: parsed.remindAt.toISOString() };
  }

  if (/^\/notes$/i.test(text)) return { intent: "NOTE_LIST" };
  m = text.match(/^\/note\s+(.+)$/i);
  if (m) return { intent: "NOTE_CREATE", content: m[1].trim() };

  if (/^\/links$/i.test(text)) return { intent: "LINK_LIST" };
  m = text.match(/^\/save\s+(\S+)$/i);
  if (m) return { intent: "LINK_SAVE", url: m[1].trim() };

  m = text.match(/^\/search\s+(.+)$/i);
  if (m) return { intent: "SEARCH", keyword: m[1].trim() };

  return null; // fall through to Groq — free-form/Tamil/Tanglish/ambiguous text
}

// ---- Reply formatting ----

function formatTaskList() {
  const pending = listTasks({ status: "pending" });
  if (pending.length === 0) return "📋 Tasks\n\nNo pending tasks 🎉";
  const lines = pending.map((t) => `#${t.id} ${t.title}`);
  return `📋 Tasks\n\n${lines.join("\n")}`;
}

function formatReminderList() {
  const pending = listReminders({ status: "pending" });
  if (pending.length === 0) return "⏰ Reminders\n\nNo upcoming reminders.";
  const lines = pending
    .slice()
    .sort((a, b) => a.remindAt - b.remindAt)
    .map((r) => `#${r.id} — ${formatLocalDateTime(new Date(r.remindAt))} — ${r.message}`);
  return `⏰ Reminders\n\n${lines.join("\n")}`;
}

function formatNoteList() {
  const all = listNotes();
  if (all.length === 0) return "📝 Notes\n\nNo notes yet.";
  const lines = all.map((n) => `#${n.id} ${n.content}`);
  return `📝 Notes\n\n${lines.join("\n")}`;
}

function formatLinkList() {
  const all = listLinks();
  if (all.length === 0) return "🔗 Links\n\nNo links saved yet.";
  const lines = all.map((l) => `#${l.id} ${l.url}${l.title ? ` — ${l.title}` : ""}`);
  return `🔗 Links\n\n${lines.join("\n")}`;
}

function formatSearchResults(keyword) {
  const { tasks, notes, links } = searchAll(keyword);
  if (tasks.length === 0 && notes.length === 0 && links.length === 0) {
    return `🔎 No results found for "${keyword}".`;
  }

  const sections = [];
  if (tasks.length > 0) sections.push(`📋 Tasks\n${tasks.map((t) => `• ${t.title}`).join("\n")}`);
  if (notes.length > 0) sections.push(`📝 Notes\n${notes.map((n) => `• ${n.content}`).join("\n")}`);
  if (links.length > 0) sections.push(`🔗 Links\n${links.map((l) => `• ${l.title || l.url}`).join("\n")}`);

  return `🔎 Search results\n\n${sections.join("\n\n")}`;
}

function formatSummary() {
  const pendingTasks = listTasks({ status: "pending" }).slice(0, 5);
  const pendingReminders = listReminders({ status: "pending" })
    .slice()
    .sort((a, b) => a.remindAt - b.remindAt)
    .slice(0, 5);
  const recentNotes = listNotes().slice(-5);
  const recentLinks = listLinks().slice(-5);

  const sections = [];
  sections.push(
    pendingTasks.length > 0
      ? `📋 Tasks\n${pendingTasks.map((t) => `• ${t.title}`).join("\n")}`
      : "📋 Tasks\nNo pending tasks 🎉"
  );
  sections.push(
    pendingReminders.length > 0
      ? `⏰ Reminders\n${pendingReminders.map((r) => `• ${formatLocalDateTime(new Date(r.remindAt))} — ${r.message}`).join("\n")}`
      : "⏰ Reminders\nNo upcoming reminders."
  );
  sections.push(recentNotes.length > 0 ? `📝 Notes\n${recentNotes.map((n) => `• ${n.content}`).join("\n")}` : "📝 Notes\nNo notes yet.");
  sections.push(recentLinks.length > 0 ? `🔗 Links\n${recentLinks.map((l) => `• ${l.title || l.url}`).join("\n")}` : "🔗 Links\nNo links saved yet.");

  return `📊 Summary\n\n${sections.join("\n\n")}`;
}

function formatHelp() {
  return (
    "🤖 Personal Assistant\n\n" +
    "💬 Chat naturally with me.\n\n" +
    "📋 Tasks\n/task <text>\n/tasks\n\n" +
    "⏰ Reminders\n/remind 10m <text>\n/remind tomorrow 10am <text>\n/reminders\n\n" +
    "📝 Notes\n/note <text>\n/notes\n\n" +
    "🔗 Links\n/save <url>\n/links\n\n" +
    "🔎 Search\n/search <keyword>\n\n" +
    "📊 Summary\n/mysummary\n\n" +
    "⚙️ Status\n/status\n\n" +
    "🗂️ Contacts (existing, unchanged)\n" +
    "/available, /unavailable — your availability to contacts\n" +
    "/summary — pending CONTACT conversations (not your own tasks)\n" +
    "/list — the contact-related commands above\n\n" +
    'Example natural request: "remind me tomorrow at 10 to check deployment"'
  );
}

function formatStatus() {
  const waLine =
    connectionState.status === "connected"
      ? "🟢 Connected"
      : connectionState.status === "qr"
        ? "🟡 Waiting for QR scan"
        : connectionState.status === "reconnecting"
          ? "🟡 Reconnecting"
          : "🔴 " + connectionState.status;
  const aiLine = groqConfigured() ? "🟢 Groq" : "🔴 Groq (GROQ_API_KEY not set)";
  const counts = getCounts();

  return (
    "🤖 Assistant Status\n\n" +
    `WhatsApp: ${waLine}\n` +
    `AI: ${aiLine}\n` +
    `Tasks: ${counts.tasks}\n` +
    `Reminders: ${counts.reminders}\n` +
    `Notes: ${counts.notes}\n` +
    `Links: ${counts.links}`
  );
}

// ---- Action execution — the app itself performs every action; Groq only
// ever identifies intent + fields (and, for CHAT, drafts the reply text) —
// never anything claiming an action happened without it actually happening.

async function executeIntent(intent) {
  switch (intent.intent) {
    case "HELP":
      return formatHelp();
    case "STATUS":
      return formatStatus();
    case "SUMMARY":
      return formatSummary();

    case "TASK_CREATE": {
      const title = (intent.title || "").trim();
      if (!title) return "What should I add as a task?";
      const task = addTask(title);
      return `Task added ✅\n\n#${task.id} — ${task.title}`;
    }
    case "TASK_LIST":
      return formatTaskList();
    case "TASK_COMPLETE": {
      const task = completeTask(intent.taskId);
      if (!task) return `Couldn't find task #${intent.taskId}.`;
      return `Task #${task.id} completed ✅`;
    }

    case "REMINDER_CREATE": {
      const message = (intent.message || "").trim();
      const remindAt = intent.remindAt ? new Date(intent.remindAt) : null;
      if (!message || !remindAt || Number.isNaN(remindAt.getTime())) {
        return "I couldn't understand that reminder. Try: /remind 10m Check deployment";
      }
      if (remindAt.getTime() <= Date.now()) {
        return "That time already passed — try something like 'tomorrow 10am' or '30m'.";
      }
      const reminder = addReminder(message, remindAt.getTime());
      return `⏰ Reminder set ✅\n\n#${reminder.id} — ${reminder.message}\n📅 ${formatLocalDateTime(remindAt)}`;
    }
    case "REMINDER_LIST":
      return formatReminderList();
    case "REMINDER_PARSE_ERROR":
      return (
        "I couldn't understand that reminder time. Try:\n" +
        "/remind 10m Check deployment\n/remind 2h Check email\n/remind tomorrow 10am Team meeting"
      );

    case "NOTE_CREATE": {
      const content = (intent.content || "").trim();
      if (!content) return "What should I note down?";
      const note = addNote(content);
      return `📝 Note saved.\n\n#${note.id} — ${note.content}`;
    }
    case "NOTE_LIST":
      return formatNoteList();

    case "LINK_SAVE": {
      const rawUrl = (intent.url || "").trim();
      const url = normalizeUrl(rawUrl);
      if (!rawUrl || !isValidUrl(url)) return "That doesn't look like a valid link.";
      let title = null;
      try {
        title = await generateLinkTitle(url);
      } catch {
        /* optional — link still gets saved without a title */
      }
      const link = addLink(url, title);
      return `🔗 Link saved.\n\n#${link.id} — ${link.url}${link.title ? ` — ${link.title}` : ""}`;
    }
    case "LINK_LIST":
      return formatLinkList();

    case "SEARCH": {
      const keyword = (intent.keyword || "").trim();
      if (!keyword) return "What should I search for?";
      return formatSearchResults(keyword);
    }

    case "CHAT":
    default:
      return (intent.reply || "").trim() || "AI service temporarily unavailable 😅 Please try again.";
  }
}

// ---- Top-level entry point, called from index.js only for Ajith's own
// self-chat messages that the pre-existing owner commands (commands.js)
// didn't already handle. Never throws — any failure degrades to a friendly
// WhatsApp reply, same policy as the rest of this app (see assistant.js).
export async function handleOwnerMessage(sock, remoteJid, text) {
  const priorContext = [...ownerContext];

  let intent = parseDeterministic(text);
  if (!intent) {
    try {
      intent = await routeOwnerMessage(text, priorContext);
    } catch (err) {
      console.error("❌ Groq routing failed:", err.message);
      intent = { intent: "CHAT", reply: null };
    }
  }

  let replyText;
  try {
    replyText = await executeIntent(intent);
  } catch (err) {
    console.error("❌ Error executing owner intent:", err.message);
    replyText = "Something went wrong handling that 😅 Please try again.";
  }

  recordContext("user", text);
  recordContext("assistant", replyText);

  await sock.sendMessage(remoteJid, { text: replyText });
}
