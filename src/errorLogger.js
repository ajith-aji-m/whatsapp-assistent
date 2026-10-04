import { writeLatestErrorLog } from "./driveStore.js";

let errorNotifier = null;

export function setErrorNotifier(notifier) {
  errorNotifier = typeof notifier === "function" ? notifier : null;
}

function normalizeError(error = {}) {
  return {
    type: String(error.type || "Application Error"),
    message: String(error.message || "Unknown error"),
    context: error.context ? String(error.context) : "",
  };
}

export async function recordLatestError(error = {}) {
  const normalized = normalizeError(error);

  try {
    const written = await writeLatestErrorLog(normalized);
    if (written) return { logged: true, notified: false };
  } catch (driveError) {
    console.error("❌ Failed to write latest error log to Google Drive:", driveError.message);
    normalized.context = [normalized.context, `Drive error-log write failed: ${driveError.message}`]
      .filter(Boolean)
      .join(" | ");
  }

  if (!errorNotifier) return { logged: false, notified: false };

  try {
    await errorNotifier(normalized);
    return { logged: false, notified: true };
  } catch (notifyError) {
    console.error("❌ Failed to send error notification to owner self-chat:", notifyError.message);
    return { logged: false, notified: false };
  }
}
