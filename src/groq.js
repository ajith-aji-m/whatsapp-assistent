import "./env.js"; // ensures .env is loaded before we read process.env below
import { describeNowForPrompt } from "./time.js";

// Sole AI provider for this app — everything that needs an AI call goes
// through Groq's OpenAI-compatible Chat Completions API: the owner-facing
// productivity assistant (tasks/reminders/notes/links/search/chat — see
// ownerAssistant.js), the contact-facing auto-reply/summary flow (see
// assistant.js/summary.js), and the setup wizard's prompt generation (see
// generateSystemPrompt below, used by web.js).
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const CHAT_TIMEOUT_MS = 20_000;
const LINK_TITLE_TIMEOUT_MS = 8_000;
const RATE_LIMIT_MAX_RETRIES = 2;
const RATE_LIMIT_MAX_WAIT_MS = 10_000;

function groqConfigured() {
  return !!process.env.GROQ_API_KEY;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq's 429 body includes a human-readable "Please try again in 4.32s"
// hint with the exact wait needed for the token bucket to refill. Returns
// null if the error text doesn't match (caller should not retry blindly).
function parseRetryAfterMs(errText) {
  const match = /try again in ([\d.]+)s/i.exec(errText);
  if (!match) return null;
  return Math.min(Math.ceil(parseFloat(match[1]) * 1000), RATE_LIMIT_MAX_WAIT_MS);
}

// Low-level helper: sends a chat messages array to Groq and returns the
// reply text. Throws on any failure — network, timeout, non-2xx, missing
// key — and leaves the fallback decision to the caller, so every AI call
// site in this project (owner assistant, contact auto-reply, pending-
// conversation summary, setup-wizard prompt generation) behaves the same
// way and degrades the same way on failure.
export async function callGroqChat(messages, { timeoutMs = CHAT_TIMEOUT_MS, jsonMode = false } = {}) {
  if (!groqConfigured()) {
    throw new Error("GROQ_API_KEY is not set");
  }

  const body = { model: process.env.GROQ_MODEL, messages };
  if (jsonMode) body.response_format = { type: "json_object" };

  for (let attempt = 0; ; attempt++) {
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

      // TPM/RPM rate limit: back off for exactly as long as Groq says the
      // token bucket needs to refill, then retry, instead of immediately
      // giving up (or hammering the API again right away).
      if (response.status === 429 && attempt < RATE_LIMIT_MAX_RETRIES) {
        const waitMs = parseRetryAfterMs(errText);
        if (waitMs !== null) {
          await sleep(waitMs);
          continue;
        }
      }

      throw new Error(`Groq API request failed (${response.status}): ${errText}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "";
    return stripReasoningArtifacts(content).trim();
  }
}

// Some reasoning-tuned models (e.g. Groq's openai/gpt-oss-*, qwen3 with
// thinking enabled) can inline their raw chain-of-thought in the response
// content itself — wrapped in <think>/<thinking> tags — when the caller
// doesn't explicitly separate reasoning from the final answer. This app
// never wants that leaking into a WhatsApp reply (it reads as broken/
// out-of-character), so strip it defensively regardless of model. A no-op
// for any model that doesn't do this.
function stripReasoningArtifacts(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<thinking>[\s\S]*?<\/thinking>/gi, "");
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
    'reply. The "reply" field must contain ONLY the message to send the owner — never include reasoning, ' +
    "analysis, or <think> content in it. Output JSON only, and nothing outside the JSON object itself."
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

const PROMPT_GENERATION_SYSTEM =
  "You write system prompts for a WhatsApp AI personal assistant. Given an owner's name, the assistant's name, " +
  "its role, and behavior/instructions, write ONE clear system prompt (plain text, no headings, no markdown, no " +
  "quotes around it) that makes the assistant behave exactly as described for that role. The prompt must instruct " +
  "the assistant to: speak in first person as the assistant and never claim to be the owner; communicate in a " +
  "warm, natural, human-like way — never like a stiff, robotic, scripted chatbot; understand and stay within the " +
  "owner's role/context; answer relevant questions appropriately; keep the conversation flowing naturally across " +
  "multiple messages instead of restarting each time; collect any important information the contact shares (who " +
  "they are, what they want, and any relevant details) for the owner; and never respond to or engage with " +
  "WhatsApp group messages. Follow the given instructions closely. Keep it concise — 4 to 8 sentences. Output " +
  "ONLY the system prompt text, nothing else (no preamble, no explanation).";

// Generates a system prompt for the WhatsApp assistant from the setup
// wizard's role + instructions, instead of requiring the owner to write one
// by hand. Used by web.js for the "Train Assistant"/"Regenerate Prompt"
// setup step. Lets a failure propagate (unlike the rest of this file) so the
// web UI can show a real error instead of silently producing a broken
// assistant prompt.
export async function generateSystemPrompt({ ownerName, assistantName, role, instructions }) {
  const userPrompt =
    `Owner name: ${ownerName}\n` +
    `Assistant name: ${assistantName}\n` +
    `Assistant role: ${role}\n` +
    `Behavior / instructions: ${instructions}\n\n` +
    "Write the system prompt now.";

  const reply = await callGroqChat([
    { role: "system", content: PROMPT_GENERATION_SYSTEM },
    { role: "user", content: userPrompt },
  ]);

  return reply.trim();
}

export { groqConfigured };
