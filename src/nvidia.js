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
