/**
 * Deadline arithmetic. Store UTC, accept and render in the committer's zone (CLAUDE.md I-9).
 *
 * A committer picks a calendar DAY, not an instant. "Sept 5" means "any time up to the end of
 * September 5th where I live", so the stored deadline is that day's last millisecond resolved
 * through the committer's IANA zone. In `Asia/Kolkata` that is 2026-09-05T18:29:59.999Z — a
 * different calendar day in UTC, which is precisely the off-by-one this module exists to get
 * right.
 *
 * TRAP, verified empirically against @date-fns/tz 1.5.0 and the reason this file does not use
 * the obvious API: `new TZDate("2026-09-05T23:59:59.999", "Asia/Kolkata")` parses the naive
 * string in the *system* zone and only then labels it, so it silently returns a different
 * instant on a server in UTC than on a laptop in IST. The component constructor
 * `new TZDate(y, m, d, h, ...)` does interpret the components in the given zone. Only the
 * component form is correct here; deadline.test.ts pins that by running under four TZ values.
 */
import { TZDate } from "@date-fns/tz";

/** Last millisecond of a calendar day. 23:59:59.999, not 23:59:00. */
const END_OF_DAY = { hours: 23, minutes: 59, seconds: 59, ms: 999 } as const;

export class InvalidDeadlineError extends Error {}

/** `true` if the runtime's ICU data knows this IANA zone. Used on both sides of the wire. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * `"2026-09-05"` + `"Asia/Kolkata"` → the UTC instant of that day's last millisecond there.
 *
 * @throws InvalidDeadlineError on a malformed date, an unknown zone, or a date that is not a
 * real calendar day (`2026-02-30`). The last one matters: Date rolls 02-30 forward to 03-02
 * without complaint, which would store a deadline two days after the one the user chose.
 */
export function endOfDayInZone(isoDate: string, timeZone: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (match === null) throw new InvalidDeadlineError(`not a YYYY-MM-DD date: ${isoDate}`);
  if (!isValidTimeZone(timeZone))
    throw new InvalidDeadlineError(`unknown time zone: ${timeZone}`);

  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];

  const zoned = new TZDate(
    year,
    month - 1,
    day,
    END_OF_DAY.hours,
    END_OF_DAY.minutes,
    END_OF_DAY.seconds,
    END_OF_DAY.ms,
    timeZone,
  );

  // Read the components back out of the zoned value. If Date rolled the date forward, they
  // will not match what was asked for.
  if (
    zoned.getFullYear() !== year ||
    zoned.getMonth() !== month - 1 ||
    zoned.getDate() !== day
  ) {
    throw new InvalidDeadlineError(`not a real calendar date: ${isoDate}`);
  }

  return new Date(zoned.getTime());
}

/** The calendar day an instant falls on in a zone, as `YYYY-MM-DD`. Inverse of the above. */
export function dayInZone(instant: Date, timeZone: string): string {
  // `en-CA` is the shortest route to ISO-ordered date parts; `formatToParts` would be the
  // same value with more code.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** Human rendering of an instant in a zone, e.g. `5 Sep 2026, 23:59 IST`. */
export function formatInZone(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(instant);
}
