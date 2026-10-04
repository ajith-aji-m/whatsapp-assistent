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

function emptyMemory() {
  return { version: 1, updatedAt: null, facts: {} };
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
  return emptyMemory();
}

export function updatePersonalMemory(key, value, source = "owner") {
  const normalizedKey = normalizeKey(key);
  const cleanValue = String(value ?? "").trim();
  if (!normalizedKey || !cleanValue) return loadPersonalMemory();

  const memory = loadPersonalMemory();
  const updatedAt = new Date().toISOString();
  memory.facts[normalizedKey] = {
    value: cleanValue.slice(0, 1000),
    source,
    updatedAt,
  };
  memory.updatedAt = updatedAt;

  try {
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2), "utf8");

    // Verify the persisted value immediately. A successful write call alone
    // is not enough to claim that the memory is actually available later.
    const persisted = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    const saved = persisted?.facts?.[normalizedKey]?.value;
    if (saved !== memory.facts[normalizedKey].value) {
      throw new Error("memory read-back verification failed");
    }
  } catch (err) {
    console.error("⚠️ Failed to persist personal memory:", err.message);
  }

  return loadPersonalMemory();
}

export function formatPersonalMemoryForPrompt() {
  const memory = loadPersonalMemory();
  const entries = Object.entries(memory.facts);
  if (entries.length === 0) return "No additional personal facts have been saved yet.";

  return entries
    .map(([key, item]) => `- ${key}: ${item.value}`)
    .join("\n");
}

function queryTerms(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3);
}

function expandedTerms(query) {
  const terms = new Set(queryTerms(query));
  const q = String(query || "").toLowerCase();

  // Stable semantic aliases make natural requests such as "portfolio link?"
  // resolve to a saved "portfolio_link", "my_portfolio", or similar fact even
  // when the exact words are not identical.
  if (/\bportfolio\b/.test(q)) {
    ["portfolio", "portfolio_link", "website", "link"].forEach((t) => terms.add(t));
  }
  if (/\b(email|mail)\b/.test(q)) {
    ["email", "mail", "email_address"].forEach((t) => terms.add(t));
  }
  if (/\b(address|location)\b/.test(q)) {
    ["address", "location", "office_address"].forEach((t) => terms.add(t));
  }

  return [...terms];
}

export function findRelevantPersonalMemory(query) {
  const memory = loadPersonalMemory();
  const terms = expandedTerms(query);
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
