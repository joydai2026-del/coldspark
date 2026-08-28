// Time-zone aware business-day scheduling.
//
// A send window means nothing without a zone: "09:00 to 17:00" has to be the
// recipient's morning, not the server's. Everything here converts through the
// profile's IANA time zone with Intl, so a run from a UTC container and a run
// from a laptop in another zone schedule the same instant.
//
// The clock is injectable so a dry run is byte-for-byte reproducible and the
// tests do not depend on the day they happen to run.

export interface Clock {
  now(): Date;
}

export function fixedClock(iso: string): Clock {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) throw new Error(`invalid fixed clock time: ${iso}`);
  return { now: () => new Date(t) };
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday, 1 = Monday .. 7 = Sunday. */
  weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** Wall-clock reading of an instant in a given IANA zone. */
export function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayIndex = WEEKDAYS.indexOf(get("weekday"));
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayIndex >= 0 ? weekdayIndex + 1 : 1,
  };
}

/** Offset between the zone's wall clock and UTC at a given instant, in ms. */
function offsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime();
}

/**
 * The instant at which the given wall-clock time occurs in a zone.
 * Two passes so a date on the far side of a DST change still lands right.
 */
export function fromZoned(
  y: number,
  m: number,
  d: number,
  hour: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(y, m - 1, d, hour, 0, 0, 0);
  let ts = naive - offsetMs(new Date(naive), timeZone);
  ts = naive - offsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/** ISO weekday of an instant in a zone, 1 = Monday .. 7 = Sunday. */
export function isoWeekday(at: Date, timeZone = "UTC"): number {
  return zonedParts(at, timeZone).weekday;
}

export function isSendDay(at: Date, sendDays: number[], timeZone = "UTC"): boolean {
  return sendDays.includes(isoWeekday(at, timeZone));
}

/** Move an instant forward to the next moment inside an allowed send window. */
export function clampToWindow(
  at: Date,
  sendDays: number[],
  windowStartHour: number,
  windowEndHour = 24,
  timeZone = "UTC",
): Date {
  let cursor = at;
  for (let guard = 0; guard < 14; guard += 1) {
    const p = zonedParts(cursor, timeZone);
    if (!sendDays.includes(p.weekday) || p.hour >= windowEndHour) {
      cursor = fromZoned(p.year, p.month, p.day + 1, windowStartHour, timeZone);
      continue;
    }
    if (p.hour < windowStartHour) {
      return fromZoned(p.year, p.month, p.day, windowStartHour, timeZone);
    }
    return cursor;
  }
  return cursor;
}

/**
 * Advance by `days` sending days, then clamp into the send window. A delay of 0
 * means "the next moment inside the window", which is what makes step 1 go out
 * today when today is a working day.
 */
export function addSendDays(
  from: Date,
  days: number,
  sendDays: number[],
  windowStartHour: number,
  windowEndHour = 24,
  timeZone = "UTC",
): Date {
  let cursor = from;
  let remaining = days;
  while (remaining > 0) {
    const p = zonedParts(cursor, timeZone);
    cursor = fromZoned(p.year, p.month, p.day + 1, windowStartHour, timeZone);
    if (sendDays.includes(zonedParts(cursor, timeZone).weekday)) remaining -= 1;
  }
  return clampToWindow(cursor, sendDays, windowStartHour, windowEndHour, timeZone);
}

/** Calendar date in the given zone, as YYYY-MM-DD. */
export function zonedDate(at: Date, timeZone = "UTC"): string {
  const p = zonedParts(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
