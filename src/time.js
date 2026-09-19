import "./env.js"; // ensures .env is loaded before we read process.env below

// Timezone handling for the owner-facing reminder feature (see
// reminderScheduler.js and ownerAssistant.js). Deliberately NOT using a full
// IANA timezone database/library — that's more than this lightweight,
// no-dependency project needs. Instead this is a fixed UTC offset, which is
// exactly correct for any timezone that doesn't observe DST — including the
// default, Asia/Kolkata/IST (UTC+5:30), which never has. If the owner is in
// a DST-observing timezone, ASSISTANT_TIMEZONE_OFFSET_MINUTES would need to
// be adjusted twice a year — an acceptable limitation here, called out in
// .env.example.
export const TIMEZONE_OFFSET_MINUTES = Number(process.env.ASSISTANT_TIMEZONE_OFFSET_MINUTES ?? 330); // default: IST, UTC+5:30

function toLocalParts(date) {
  const shifted = new Date(date.getTime() + TIMEZONE_OFFSET_MINUTES * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    date: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

function fromLocalParts({ year, month, date, hours, minutes }) {
  const utcMs = Date.UTC(year, month, date, hours, minutes) - TIMEZONE_OFFSET_MINUTES * 60_000;
  return new Date(utcMs);
}

// Resolves "today HH:MM" / "tomorrow HH:MM" (in the owner's local timezone)
// to a real Date. "today" that has already passed rolls forward to tomorrow
// — a reminder command should never silently create an already-due reminder.
export function resolveTodayOrTomorrowAt(day, hours, minutes, now = new Date()) {
  const local = toLocalParts(now);
  let target = fromLocalParts({ ...local, hours, minutes });

  if (day === "tomorrow") {
    target = new Date(target.getTime() + 24 * 3_600_000);
  } else if (target.getTime() <= now.getTime()) {
    target = new Date(target.getTime() + 24 * 3_600_000);
  }
  return target;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Human-friendly "3 Oct, 10:00 AM" in the owner's local timezone, for
// reminder confirmations/listings — never raw ISO/UTC shown to the owner.
export function formatLocalDateTime(date) {
  const p = toLocalParts(date);
  const hour12 = ((p.hours + 11) % 12) + 1;
  const ampm = p.hours >= 12 ? "PM" : "AM";
  const mm = String(p.minutes).padStart(2, "0");
  return `${p.date} ${MONTHS[p.month]}, ${hour12}:${mm} ${ampm}`;
}

// Description of "now" in the owner's local timezone, for the Groq routing
// prompt to resolve relative times ("tomorrow 10am", "naalaikku 10 manikku")
// against the right day/time instead of the server's own (likely UTC) clock.
export function describeNowForPrompt(now = new Date()) {
  const offsetHours = TIMEZONE_OFFSET_MINUTES / 60;
  const sign = offsetHours >= 0 ? "+" : "-";
  return `${now.toISOString()} UTC (owner's local time is UTC${sign}${Math.abs(offsetHours)}: ${formatLocalDateTime(now)})`;
}
