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
    dayOfWeek: shifted.getUTCDay(), // 0=Sunday..6=Saturday, in the owner's local timezone
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

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Parses an "HH:MM" 24-hour string into minutes-since-midnight, or null if
// it's missing/malformed — every schedule field this feeds (see config.js's
// optional profile.scheduleProfile) is itself optional, so callers must
// treat null as "this field wasn't set/valid" and simply skip it rather than
// erroring.
function parseHHMM(value) {
  const match = typeof value === "string" && /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatHHMMLabel(value) {
  const totalMinutes = parseHHMM(value);
  if (totalMinutes === null) return value;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hour12 = ((hours + 11) % 12) + 1;
  const ampm = hours >= 12 ? "PM" : "AM";
  return `${hour12}:${String(minutes).padStart(2, "0")} ${ampm}`;
}

// Best-effort, human-readable description of where "now" falls relative to
// the owner's OPTIONAL working schedule (see config.js's
// profile.scheduleProfile, filled in via the web setup wizard/dashboard —
// see web.js). Every field on scheduleProfile is independently optional, so
// this only describes whatever was actually provided and returns null the
// moment there's nothing usable — assistant.js treats null the same as "no
// schedule configured at all", so a partially filled-in profile never
// invents facts about fields the owner left blank.
export function describeScheduleStatus(scheduleProfile, now = new Date()) {
  if (!scheduleProfile) return null;

  const local = toLocalParts(now);
  const nowMinutes = local.hours * 60 + local.minutes;
  const todayName = WEEKDAY_NAMES[local.dayOfWeek];
  const lines = [];

  if (Array.isArray(scheduleProfile.workingDays) && scheduleProfile.workingDays.length > 0) {
    const isWorkingDay = scheduleProfile.workingDays.includes(todayName);
    lines.push(
      isWorkingDay
        ? `Today (${todayName}) is one of the owner's working days.`
        : `Today (${todayName}) is NOT one of the owner's working days.`
    );
  }

  const workStart = parseHHMM(scheduleProfile.workingHoursStart);
  const workEnd = parseHHMM(scheduleProfile.workingHoursEnd);
  if (workStart !== null && workEnd !== null) {
    const withinHours = nowMinutes >= workStart && nowMinutes < workEnd;
    lines.push(
      withinHours
        ? `It is currently within the owner's working hours (${formatHHMMLabel(scheduleProfile.workingHoursStart)}–${formatHHMMLabel(scheduleProfile.workingHoursEnd)}).`
        : `It is currently outside the owner's working hours (${formatHHMMLabel(scheduleProfile.workingHoursStart)}–${formatHHMMLabel(scheduleProfile.workingHoursEnd)}).`
    );
  }

  const breakStart = parseHHMM(scheduleProfile.breakStart);
  const breakEnd = parseHHMM(scheduleProfile.breakEnd);
  if (breakStart !== null && breakEnd !== null && nowMinutes >= breakStart && nowMinutes < breakEnd) {
    lines.push(`The owner is currently on a break, until ${formatHHMMLabel(scheduleProfile.breakEnd)}.`);
  }

  const prefStart = parseHHMM(scheduleProfile.preferredStart);
  const prefEnd = parseHHMM(scheduleProfile.preferredEnd);
  if (prefStart !== null && prefEnd !== null) {
    const withinPreferred = nowMinutes >= prefStart && nowMinutes < prefEnd;
    lines.push(
      withinPreferred
        ? `Now is within the owner's preferred time to be contacted (${formatHHMMLabel(scheduleProfile.preferredStart)}–${formatHHMMLabel(scheduleProfile.preferredEnd)}).`
        : `Now is outside the owner's preferred contact hours (${formatHHMMLabel(scheduleProfile.preferredStart)}–${formatHHMMLabel(scheduleProfile.preferredEnd)}).`
    );
  }

  return lines.length > 0 ? lines.join(" ") : null;
}

// Structured counterpart to describeScheduleStatus, for the dashboard's
// "Today's Overview" card — that function returns a prose sentence meant for
// the Groq prompt; the UI needs discrete fields to render instead. Reuses
// the exact same parsing/formatting helpers so the two never disagree about
// what "within working hours" or "on a break" means.
export function getScheduleSnapshot(scheduleProfile, now = new Date()) {
  if (!scheduleProfile) return null;

  const local = toLocalParts(now);
  const nowMinutes = local.hours * 60 + local.minutes;
  const todayName = WEEKDAY_NAMES[local.dayOfWeek];

  const hasWorkingDays = Array.isArray(scheduleProfile.workingDays) && scheduleProfile.workingDays.length > 0;
  const isWorkingDay = hasWorkingDays ? scheduleProfile.workingDays.includes(todayName) : null;

  const workStart = parseHHMM(scheduleProfile.workingHoursStart);
  const workEnd = parseHHMM(scheduleProfile.workingHoursEnd);
  const breakStart = parseHHMM(scheduleProfile.breakStart);
  const breakEnd = parseHHMM(scheduleProfile.breakEnd);

  const onBreak = breakStart !== null && breakEnd !== null && nowMinutes >= breakStart && nowMinutes < breakEnd;
  const withinWorkingHours = workStart !== null && workEnd !== null && nowMinutes >= workStart && nowMinutes < workEnd;

  let currentStatus = null; // "working" | "break" | "off" | null (not enough info)
  if (isWorkingDay === false) currentStatus = "off";
  else if (onBreak) currentStatus = "break";
  else if (workStart !== null && workEnd !== null) currentStatus = withinWorkingHours ? "working" : "off";

  const boundaries = [];
  if (workStart !== null) boundaries.push({ minutes: workStart, label: `Working hours start at ${formatHHMMLabel(scheduleProfile.workingHoursStart)}` });
  if (breakStart !== null) boundaries.push({ minutes: breakStart, label: `Break starts at ${formatHHMMLabel(scheduleProfile.breakStart)}` });
  if (breakEnd !== null) boundaries.push({ minutes: breakEnd, label: `Back from break at ${formatHHMMLabel(scheduleProfile.breakEnd)}` });
  if (workEnd !== null) boundaries.push({ minutes: workEnd, label: `Working hours end at ${formatHHMMLabel(scheduleProfile.workingHoursEnd)}` });
  boundaries.sort((a, b) => a.minutes - b.minutes);
  const next = boundaries.find((b) => b.minutes > nowMinutes) || null;

  return {
    todayName,
    isWorkingDay,
    workingHoursLabel:
      workStart !== null && workEnd !== null
        ? `${formatHHMMLabel(scheduleProfile.workingHoursStart)} – ${formatHHMMLabel(scheduleProfile.workingHoursEnd)}`
        : null,
    currentStatus,
    onBreak,
    breakUntilLabel: onBreak ? formatHHMMLabel(scheduleProfile.breakEnd) : null,
    nextChangeLabel: next ? next.label : null,
  };
}
