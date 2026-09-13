import "./env.js";

// Low-level helper: sends a full chat messages array to the NVIDIA Chat
// Completions API and returns the reply text. Shared by anything that needs
// an AI call (for now, just the conversation summarizer).
export async function callNvidiaChat(messages) {
  const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.NVIDIA_MODEL,
      messages,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`NVIDIA API request failed (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "";
}

const PROMPT_GENERATION_SYSTEM =
  "detailed thinking off\n" +
  "You write system prompts for WhatsApp AI assistants. Given an owner's name, the assistant's name, its role, " +
  "and behavior/instructions, write ONE clear system prompt (plain text, no headings, no markdown, no quotes " +
  "around it) that makes the assistant behave exactly as described for that role. The prompt must tell the " +
  "assistant to speak in first person as the assistant, never claim to be the owner, stay strictly within the " +
  "given role, and follow the given instructions. Keep it concise — 4 to 8 sentences. Output ONLY the system " +
  "prompt text, nothing else (no preamble, no explanation).";

// Uses the same NVIDIA chat completion call as everything else in this app —
// generates a system prompt for the WhatsApp assistant from the setup
// wizard's role + instructions, instead of requiring the owner to write one
// by hand. Reused by web.js for the "Generate Prompt"/"Regenerate Prompt"
// setup step. Never throws on empty NVIDIA config elsewhere — callers here
// let a failure propagate so the web UI can show a real error instead of
// silently producing a broken assistant prompt.
export async function generateSystemPrompt({ ownerName, assistantName, role, instructions }) {
  const userPrompt =
    `Owner name: ${ownerName}\n` +
    `Assistant name: ${assistantName}\n` +
    `Assistant role: ${role}\n` +
    `Behavior / instructions: ${instructions}\n\n` +
    "Write the system prompt now.";

  const reply = await callNvidiaChat([
    { role: "system", content: PROMPT_GENERATION_SYSTEM },
    { role: "user", content: userPrompt },
  ]);

  return reply.trim();
}
