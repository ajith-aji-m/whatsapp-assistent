import { loadPersonalMemoryFresh, savePersonalMemory } from "./memoryStore.js";

const TASK_PREFIX = "task_";
const NOTE_PREFIX = "note_";

function entries(memory, prefix) {
  return Object.entries(memory.facts || {})
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, item]) => {
      try { return JSON.parse(item.value); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.id - b.id);
}

async function loadData() {
  const memory = await loadPersonalMemoryFresh();
  return {
    memory,
    tasks: entries(memory, TASK_PREFIX),
    notes: entries(memory, NOTE_PREFIX),
  };
}

async function persist(memory, prefix, item) {
  const key = `${prefix}${item.id}`;
  memory.facts[key] = { value: JSON.stringify(item), source: "owner", updatedAt: new Date().toISOString() };
  memory.updatedAt = new Date().toISOString();
  await savePersonalMemory(memory);
  return item;
}

export async function addTask(title, { priority = "normal", dueAt = null } = {}) {
  const { memory, tasks } = await loadData();
  const id = tasks.reduce((max, t) => Math.max(max, Number(t.id) || 0), 0) + 1;
  return persist(memory, TASK_PREFIX, { id, title, status: "pending", priority, createdAt: Date.now(), dueAt });
}
export async function listTasks({ status } = {}) {
  const { tasks } = await loadData();
  return status ? tasks.filter((t) => t.status === status) : tasks;
}
export async function completeTask(id) {
  const { memory, tasks } = await loadData();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  task.status = "completed";
  return persist(memory, TASK_PREFIX, task);
}
export async function addNote(content) {
  const { memory, notes } = await loadData();
  const id = notes.reduce((max, n) => Math.max(max, Number(n.id) || 0), 0) + 1;
  return persist(memory, NOTE_PREFIX, { id, content, createdAt: Date.now() });
}
export async function listNotes() {
  const { notes } = await loadData();
  return notes;
}
export async function searchTasks(keyword) {
  const tasks = await listTasks();
  const kw = keyword.toLowerCase();
  return tasks.filter((t) => t.title.toLowerCase().includes(kw));
}
export async function searchNotes(keyword) {
  const notes = await listNotes();
  const kw = keyword.toLowerCase();
  return notes.filter((n) => n.content.toLowerCase().includes(kw));
}
export async function getCounts() {
  const [tasks, notes] = await Promise.all([listTasks({ status: "pending" }), listNotes()]);
  return { tasks: tasks.length, notes: notes.length };
}
export async function searchAll(keyword) {
  const [tasks, notes] = await Promise.all([searchTasks(keyword), searchNotes(keyword)]);
  return { tasks, notes };
}
