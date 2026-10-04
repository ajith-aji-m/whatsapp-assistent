import { connectionState } from "./connectionState.js";
import { addTask, listTasks, completeTask, addNote, listNotes, getCounts, searchAll } from "./productivityStore.js";
import { routeOwnerMessage, groqConfigured } from "./groq.js";
import { updatePersonalMemory } from "./memoryStore.js";
import { readLatestErrorLog } from "./driveStore.js";

const MAX_CONTEXT_MESSAGES = 20;
const ownerContext = [];

function recordContext(role, text) {
  ownerContext.push({ role, text });
  if (ownerContext.length > MAX_CONTEXT_MESSAGES) ownerContext.shift();
}

function parseDeterministic(rawText) {
  const text = rawText.trim();
  if (/^\/help$/i.test(text) || /^help$/i.test(text) || /^what can you do\??$/i.test(text)) return { intent: "HELP" };
  if (/^\/status$/i.test(text)) return { intent: "STATUS" };\n  if (/^(\/error|\/errors|latest error|error log|latest error log)$/i.test(text)) return { intent: "LATEST_ERROR" };
  if (/^\/tasks$/i.test(text)) return { intent: "TASK_LIST" };
  let m = text.match(/^\/task\s+done\s+#?(\d+)$/i);
  if (m) return { intent: "TASK_COMPLETE", taskId: parseInt(m[1], 10) };
  m = text.match(/^\/task\s+(.+)$/i);
  if (m) return { intent: "TASK_CREATE", title: m[1].trim() };
  if (/^\/notes$/i.test(text)) return { intent: "NOTE_LIST" };
  m = text.match(/^\/note\s+(.+)$/i);
  if (m) return { intent: "NOTE_CREATE", content: m[1].trim() };
  return null;
}

async function formatTaskList() {
  const pending = await listTasks({ status: "pending" });
  if (pending.length === 0) return "📋 Tasks\n\nNo pending tasks 🎉";
  return `📋 Tasks\n\n${pending.map((t) => `#${t.id} ${t.title}`).join("\n")}`;
}
async function formatNoteList() {
  const all = await listNotes();
  if (all.length === 0) return "📝 Notes\n\nNo notes yet.";
  return `📝 Notes\n\n${all.map((n) => `#${n.id} ${n.content}`).join("\n")}`;
}
async function formatSummary() {
  const [tasks, notes] = await Promise.all([listTasks({ status: "pending" }), listNotes()]);
  return `📊 Summary\n\n📋 Tasks\n${tasks.length ? tasks.slice(0,5).map((t)=>`• ${t.title}`).join("\n") : "No pending tasks 🎉"}\n\n📝 Notes\n${notes.length ? notes.slice(-5).map((n)=>`• ${n.content}`).join("\n") : "No notes yet."}`;
}
function formatHelp() {
  return "🤖 Personal Assistant\n\n💬 Chat naturally with me.\n\n📋 Tasks\n/task <text>\n/tasks\n/task done #<id>\n\n📝 Notes\n/note <text>\n/notes\n\n🧠 Personal memory\nTell me a personal detail and ask me to remember it.\n\n🔎 Search\n/search <keyword>\n\n📊 Summary\n/mysummary\n\n⚙️ Status\n/status";
}
async function formatStatus() {
  const waLine = connectionState.status === "connected" ? "🟢 Connected" : connectionState.status === "qr" ? "🟡 Waiting for QR scan" : connectionState.status === "reconnecting" ? "🟡 Reconnecting" : "🔴 " + connectionState.status;
  const counts = await getCounts();
  return `🤖 Assistant Status\n\nWhatsApp: ${waLine}\nAI: ${groqConfigured() ? "🟢 Groq" : "🔴 Groq (GROQ_API_KEY not set)"}\nTasks: ${counts.tasks}\nNotes: ${counts.notes}`;
}

async function executeIntent(intent) {
  switch (intent.intent) {
    case "HELP": return formatHelp();
    case "STATUS": return formatStatus();\n    case "LATEST_ERROR": {\n      try {\n        const latestError = await readLatestErrorLog();\n        return latestError ? "⚠️ Latest error\\n\\n" + latestError : "✅ No error is currently recorded in errorLog.txt.";\n      } catch (err) {\n        return "⚠️ I could not read the latest error log from Google Drive: " + err.message;\n      }\n    }
    case "SUMMARY": return formatSummary();
    case "MEMORY_UPDATE": {
      const key = (intent.key || "").trim();
      const value = (intent.value || "").trim();
      if (!key || !value) return "I need the detail and its value to remember it.";
      await updatePersonalMemory(key, value, "owner");
      return `Got it — I’ll remember that ${key} is ${value}.`;
    }
    case "TASK_CREATE": {
      const title = (intent.title || "").trim();
      if (!title) return "What should I add as a task?";
      const task = await addTask(title);
      return `Task saved to Personal Assistant memory ✅\n\n#${task.id} — ${task.title}`;
    }
    case "TASK_LIST": return formatTaskList();
    case "TASK_COMPLETE": {
      const task = await completeTask(intent.taskId);
      return task ? `Task #${task.id} completed ✅` : `Couldn't find task #${intent.taskId}.`;
    }
    case "NOTE_CREATE": {
      const content = (intent.content || "").trim();
      if (!content) return "What should I note down?";
      const note = await addNote(content);
      return `📝 Note saved to Personal Assistant memory.\n\n#${note.id} — ${note.content}`;
    }
    case "NOTE_LIST": return formatNoteList();
    case "SEARCH": {
      const keyword = (intent.keyword || "").trim();
      if (!keyword) return "What should I search for?";
      const { tasks, notes } = await searchAll(keyword);
      if (!tasks.length && !notes.length) return `🔎 No results found for "${keyword}".`;
      const sections = [];
      if (tasks.length) sections.push(`📋 Tasks\n${tasks.map(t=>`• ${t.title}`).join("\n")}`);
      if (notes.length) sections.push(`📝 Notes\n${notes.map(n=>`• ${n.content}`).join("\n")}`);
      return `🔎 Search results\n\n${sections.join("\n\n")}`;
    }
    case "CHAT":
    default: return (intent.reply || "").trim() || "AI service temporarily unavailable 😅 Please try again.";
  }
}

export async function handleOwnerMessage(sock, remoteJid, text) {
  const priorContext = [...ownerContext];
  let intent = parseDeterministic(text);
  if (!intent) {
    try { intent = await routeOwnerMessage(text, priorContext); }
    catch (err) { console.error("❌ Groq routing failed:", err.message); intent = { intent: "CHAT", reply: null }; }
  }
  let replyText;
  try { replyText = await executeIntent(intent); }
  catch (err) { console.error("❌ Error executing owner intent:", err.message); replyText = "Something went wrong handling that 😅 Please try again."; }
  recordContext("user", text);
  recordContext("assistant", replyText);
  await sock.sendMessage(remoteJid, { text: replyText });
}
