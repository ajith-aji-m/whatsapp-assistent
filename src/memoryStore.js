import { readPersonalMemoryFromDrive, writePersonalMemoryToDrive, isGoogleDriveConfigured } from "./driveStore.js";

function normalizeKey(key) {
  return String(key || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}
function emptyMemory() { return { version: 1, updatedAt: null, facts: {} }; }

export function loadPersonalMemory() {
  return emptyMemory();
}

export async function loadPersonalMemoryFresh() {
  if (!isGoogleDriveConfigured()) throw new Error("Google Drive is not connected. Connect Google Drive before using personal memory.");
  return (await readPersonalMemoryFromDrive()) || emptyMemory();
}

export async function savePersonalMemory(memory) {
  if (!isGoogleDriveConfigured()) throw new Error("Google Drive is not connected. Connect Google Drive before saving personal memory.");
  await writePersonalMemoryToDrive(memory);
  return memory;
}

export async function updatePersonalMemory(key, value, source = "owner") {
  const normalizedKey = normalizeKey(key);
  const cleanValue = String(value ?? "").trim();
  if (!normalizedKey || !cleanValue) return loadPersonalMemoryFresh();
  const memory = await loadPersonalMemoryFresh();
  const updatedAt = new Date().toISOString();
  memory.facts[normalizedKey] = { value: cleanValue.slice(0, 1000), source, updatedAt };
  memory.updatedAt = updatedAt;
  return savePersonalMemory(memory);
}

export async function formatPersonalMemoryForPromptFresh() {
  const memory = await loadPersonalMemoryFresh();
  const entries = Object.entries(memory.facts || {});
  if (entries.length === 0) return "No additional personal facts have been saved yet.";
  return entries.map(([key, item]) => `- ${key}: ${item.value}`).join("\n");
}

function queryTerms(query) {
  return String(query || "").toLowerCase().replace(/https?:\/\/\S+/g, " ").split(/[^a-z0-9]+/).filter((term) => term.length >= 3);
}
function expandedTerms(query) {
  const terms = new Set(queryTerms(query));
  const q = String(query || "").toLowerCase();
  if (/\bportfolio\b/.test(q)) ["portfolio", "portfolio_link", "website", "link"].forEach((t) => terms.add(t));
  if (/\b(email|mail)\b/.test(q)) ["email", "mail", "email_address"].forEach((t) => terms.add(t));
  if (/\b(address|location)\b/.test(q)) ["address", "location", "office_address"].forEach((t) => terms.add(t));
  return [...terms];
}
export function findRelevantPersonalMemory(query, memory = emptyMemory()) {
  const terms = expandedTerms(query);
  if (terms.length === 0) return {};
  const matches = {};
  for (const [key, item] of Object.entries(memory.facts || {})) {
    const haystack = (key + " " + item.value).toLowerCase();
    if (terms.some((term) => haystack.includes(term))) matches[key] = item;
  }
  return matches;
}
export function listPersonalMemory(memory = emptyMemory()) { return memory.facts || {}; }
