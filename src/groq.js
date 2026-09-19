import "./env.js"; // ensures .env is loaded before we read process.env below
import { describeNowForPrompt } from "./time.js";

// AI provider for the owner-facing productivity assistant (tasks, reminders,
// notes, links, search, natural-language routing, and normal conversation —
// see ownerAssistant.js). Deliberately separate from nvidia.js, which keeps
// powering the existing contact-facing auto-reply/summary flow unchanged —
// this file only ever talks to Groq's OpenAI-compatible Chat Completions API.
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CHAT_TIMEOUT_MS = 20_000;
const LINK_TITLE_TIMEOUT_MS = 8_000;

function groqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

// Low-level helper: sends a chat messages array to Groq and returns the
// reply text. Mirrors nvidia.js's callNvidiaChat shape (throws on any
// failure — network, timeout, non-2xx, missing key — and leaves the fallback
// decision to the caller) so both AI call sites in this project behave the
// same way to whatever calls them.
async function callGroqChat(messages, { timeoutMs = CHAT_TIMEOUT_MS, jsonMode = false } = {}) {
  if (!groqConfigured()) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const body = { model: process.env.GROQ_MODEL, messages };
  if (jsonMode) body.response_format = { type: "json_object" };

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new Error("Groq API request timed out");
    }
    throw err;
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Groq API request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

const INTENT_ENUM = [
  "TASK_CREATE",
  "TASK_LIST",
  "TASK_COMPLETE",
  "REMINDER_CREATE",
  "REMINDER_LIST",
  "NOTE_CREATE",
  "NOTE_LIST",
  "LINK_SAVE",
  "LINK_LIST",
  "SEARCH",
  "SUMMARY",
  "HELP",
  "STATUS",
  "CHAT",
];

function routingSystemPrompt() {
  return (
    "You are the natural-language router AND conversational voice for the owner's own personal WhatsApp " +
    "assistant — the owner is chatting with their own assistant, not a customer. Their message may be in " +
    "English, Tamil, or Tanglish (mixed Tamil+English). Classify it into EXACTLY ONE intent and reply with ONLY " +
    "a single JSON object — no other text, no markdown, no code fences.\n\n" +
    "Possible replies (pick exactly one shape):\n" +
    '{"intent":"TASK_CREATE","title":"<task text>"}\n' +
    '{"intent":"TASK_LIST"}\n' +
    '{"intent":"TASK_COMPLETE","taskId":<number mentioned by the owner>}\n' +
    '{"intent":"REMINDER_CREATE","message":"<reminder text>","remindAt":"<UTC ISO 8601 datetime>"}\n' +
    '{"intent":"REMINDER_LIST"}\n' +
    '{"intent":"NOTE_CREATE","content":"<note text>"}\n' +
    '{"intent":"NOTE_LIST"}\n' +
    '{"intent":"LINK_SAVE","url":"<url>"}\n' +
    '{"intent":"LINK_LIST"}\n' +
    '{"intent":"SEARCH","keyword":"<keyword>"}\n' +
    '{"intent":"SUMMARY"}\n' +
    '{"intent":"HELP"}\n' +
    '{"intent":"STATUS"}\n' +
    '{"intent":"CHAT","reply":"<warm, concise 1-4 sentence conversational reply to the owner, using the ' +
    'conversation context given>"}\n\n' +
    "Use CHAT for anything that isn't clearly one of the other intents — normal questions, advice, small talk, " +
    "coding help, etc. Never invent a taskId the owner didn't mention.\n\n" +
    `Current time: ${describeNowForPrompt()}. Resolve any relative time (e.g. "tomorrow 10am", "naalaikku 10 ` +
    'manikku", "30 minutes later") against the owner\'s LOCAL time above, then output "remindAt" as a UTC ISO ' +
    "8601 datetime. Never reveal API keys, environment variables, or internal implementation details in a CHAT " +
    "reply. Output JSON only."
  );
}

// The single AI call for any owner message that isn't a recognized slash
// command (see ownerAssistant.js's deterministic parser, which handles
// slash commands locally with zero AI calls). One Groq round-trip both
// classifies the intent AND, for plain conversation, produces the actual
// reply text — avoiding a second call for the common "just chatting" case.
// Never throws on a malformed/unexpected model response (falls back to
// CHAT with no reply, which the caller turns into a friendly message) —
// DOES throw on a real request failure (network/timeout/non-2xx/missing
// key), which the caller must catch.
export async function routeOwnerMessage(text, context = []) {
  const messages = [
    { role: "system", content: routingSystemPrompt() },
    ...context.slice(-6).map((m) => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
    { role: "user", content: text },
  ];

  const raw = await callGroqChat(messages, { jsonMode: true });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { intent: "CHAT", reply: null };
  }

  if (!parsed || typeof parsed !== "object" || !INTENT_ENUM.includes(parsed.intent)) {
    return { intent: "CHAT", reply: null };
  }
  return parsed;
}

// Optional, best-effort short title for a saved link — guessed by Groq from
// the URL text alone. Never fetches/scrapes the page (see productivityStore
// .js's addLink callers). Callers must treat any failure as non-fatal: the
// link still gets saved without a title.
export async function generateLinkTitle(url) {
  const reply = await callGroqChat(
    [
      {
        role: "system",
        content:
          "Given a URL, reply with ONLY a short (2-6 word) descriptive title guessed from the URL itself — no " +
          "quotes, no trailing punctuation, no explanation.",
      },
      { role: "user", content: url },
    ],
    { timeoutMs: LINK_TITLE_TIMEOUT_MS }
  );
  const title = reply.replace(/^["']|["']$/g, "").trim();
  return title || null;
}

export { groqConfigured };
