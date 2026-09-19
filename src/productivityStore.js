// In-memory store for the owner-facing productivity features (tasks,
// reminders, notes, links) — deliberately no database, same philosophy as
// store.js's contact-conversation store: simple arrays, lost on restart.
// Ids are small sequential integers (not UUIDs) on purpose — the owner
// refers to items as "#3", "task 2", etc., so short numbers are what the
// chat interface (ownerAssistant.js) actually needs to expose.

let nextTaskId = 1;
const tasks = [];

let nextReminderId = 1;
const reminders = [];

let nextNoteId = 1;
const notes = [];

let nextLinkId = 1;
const links = [];

// ---- Tasks ----

export function addTask(title, { priority = "normal", dueAt = null } = {}) {
  const task = { id: nextTaskId++, title, status: "pending", priority, createdAt: Date.now(), dueAt };
  tasks.push(task);
  return task;
}

export function listTasks({ status } = {}) {
  return status ? tasks.filter((t) => t.status === status) : tasks;
}

export function getTask(id) {
  return tasks.find((t) => t.id === id);
}

export function completeTask(id) {
  const task = getTask(id);
  if (!task) return null;
  task.status = "completed";
  return task;
}

export function cancelTask(id) {
  const task = getTask(id);
  if (!task) return null;
  task.status = "cancelled";
  return task;
}

export function searchTasks(keyword) {
  const kw = keyword.toLowerCase();
  return tasks.filter((t) => t.title.toLowerCase().includes(kw));
}

// ---- Reminders ----

export function addReminder(message, remindAt) {
  const reminder = { id: nextReminderId++, message, remindAt, status: "pending", createdAt: Date.now() };
  reminders.push(reminder);
  return reminder;
}

export function listReminders({ status } = {}) {
  return status ? reminders.filter((r) => r.status === status) : reminders;
}

export function getReminder(id) {
  return reminders.find((r) => r.id === id);
}

export function cancelReminder(id) {
  const reminder = getReminder(id);
  if (!reminder) return null;
  reminder.status = "cancelled";
  return reminder;
}

// Reminders due to fire right now — used only by reminderScheduler.js.
export function getDueReminders(now = Date.now()) {
  return reminders.filter((r) => r.status === "pending" && r.remindAt <= now);
}

export function markReminderSent(id) {
  const reminder = getReminder(id);
  if (!reminder) return null;
  reminder.status = "sent";
  return reminder;
}

// ---- Notes ----

export function addNote(content) {
  const note = { id: nextNoteId++, content, createdAt: Date.now() };
  notes.push(note);
  return note;
}

export function listNotes() {
  return notes;
}

export function searchNotes(keyword) {
  const kw = keyword.toLowerCase();
  return notes.filter((n) => n.content.toLowerCase().includes(kw));
}

// ---- Links ----

export function addLink(url, title = null) {
  const link = { id: nextLinkId++, url, title, createdAt: Date.now() };
  links.push(link);
  return link;
}

export function listLinks() {
  return links;
}

export function searchLinks(keyword) {
  const kw = keyword.toLowerCase();
  return links.filter((l) => l.url.toLowerCase().includes(kw) || l.title?.toLowerCase().includes(kw));
}

// ---- Cross-cutting ----

// Used by /status — counts only, never the content itself.
export function getCounts() {
  return {
    tasks: tasks.filter((t) => t.status === "pending").length,
    reminders: reminders.filter((r) => r.status === "pending").length,
    notes: notes.length,
    links: links.length,
  };
}

// Used by /search — deliberately excludes reminders (a reminder is a
// scheduled alert, not a searchable reference item like a task/note/link).
export function searchAll(keyword) {
  return {
    tasks: searchTasks(keyword),
    notes: searchNotes(keyword),
    links: searchLinks(keyword),
  };
}
