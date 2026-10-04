import fs from "node:fs";
import path from "node:path";

const MEMORY_FILE = path.join(process.cwd(), "data", "personalMemory.json");

function normalizeKey(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

export function loadPersonalMemory() {
  try {
    const parsed = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.facts && typeof parsed.facts === "object") {
      return parsed;
    }
  } catch {
    // Missing/corrupt memory is treated as an empty memory.
  }
  return { version: 1, updatedAt: null, facts: {} };
}

export function updatePersonalMemory(key, value, source = "owner") {
  const normalizedKey = normalizeKey(key);
  const cleanValue = String(value ?? "").trim();
  if (!normalizedKey || !cleanValue) return loadPersonalMemory();

  const memory = loadPersonalMemory();
  memory.facts[normalizedKey] = {
    value: cleanValue.slice(0, 1000),
    source,
    updatedAt: new Date().toISOString(),
  };
  memory.updatedAt = memory.facts[normalizedKey].updatedAt;

  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } catch (err) {
    console.error("⚠️ Failed to persist personal memory:", err.message);
  }

  return memory;
}

export function formatPersonalMemoryForPrompt() {
  const memory = loadPersonalMemory();
  const entries = Object.entries(memory.facts);
  if (entries.length === 0) return "No additional personal facts have been saved yet.";

  return entries
    .map(([key, item]) => `- ${key}: ${item.value}`)
    .join("\n");
}

export function findRelevantPersonalMemory(query) {
  const memory = loadPersonalMemory();
  const terms = String(query || "").toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
  if (terms.length === 0) return {};
  const matches = {};
  for (const [key, item] of Object.entries(memory.facts)) {
    const haystack = (key + " " + item.value).toLowerCase();
    if (terms.some((term) => haystack.includes(term))) matches[key] = item;
  }
  return matches;
}

export function listPersonalMemory() {
  return loadPersonalMemory().facts;
}
