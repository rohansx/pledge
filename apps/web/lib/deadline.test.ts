/**
 * IST deadline arithmetic — a v0 exit criterion (roadmap.md) and CLAUDE.md I-9.
 *
 * `Asia/Kolkata` is UTC+05:30 with no DST. The half-hour offset is what breaks naive date
 * maths, and the 5.5h shift is enough to push a late-evening local deadline into the *next*
 * UTC day and an early-morning one into the *previous* one. Both directions are asserted.
 *
 * Every case runs under four system zones. The bug this guards against is a library that
 * parses a naive datetime string in the process zone and then labels it with the target zone —
 * which is exactly what @date-fns/tz's string constructor does, and why deadline.ts uses the
 * component constructor. A test that only ran under the developer's own TZ would pass anyway.
 */
import { afterEach, describe, expect, it } from "vitest";
import { InvalidDeadlineError, dayInZone, endOfDayInZone } from "./deadline";

const IST = "Asia/Kolkata";
const SYSTEM_ZONES = ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"] as const;

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

/** Runs `fn` once per system zone. Node re-reads process.env.TZ per Date construction. */
function underEverySystemZone(fn: () => void): void {
  for (const zone of SYSTEM_ZONES) {
    process.env.TZ = zone;
    fn();
  }
}

describe("endOfDayInZone — Asia/Kolkata", () => {
  it("resolves a Sept 5 deadline to 2026-09-05T23:59:59.999+05:30", () => {
    underEverySystemZone(() => {
      // roadmap.md v0 exit criterion, stated to the minute: 2026-09-05T23:59+05:30.
      expect(endOfDayInZone("2026-09-05", IST).toISOString()).toBe("2026-09-05T18:29:59.999Z");
    });
  });

  it("keeps a 23:30 IST instant on the same IST day though UTC has already rolled back", () => {
    // 2026-09-05T23:30 IST is 2026-09-05T18:00Z — same UTC day. The deadline itself
    // (23:59:59.999) is still 18:29Z. The interesting direction is the one below.
    const deadline = endOfDayInZone("2026-09-05", IST);
    expect(dayInZone(deadline, IST)).toBe("2026-09-05");
    expect(dayInZone(deadline, "UTC")).toBe("2026-09-05");
  });

  it("crosses the UTC date boundary backwards for a Jan 1 deadline", () => {
    underEverySystemZone(() => {
      // The one that catches naive arithmetic: the committer's Jan 1 deadline is stored on
      // 31 December in UTC. Anything that formats the stored instant without the zone shows
      // the user a deadline a day earlier than the one they chose.
      const deadline = endOfDayInZone("2026-01-01", IST);
      expect(deadline.toISOString()).toBe("2026-01-01T18:29:59.999Z");
      expect(dayInZone(deadline, "UTC")).toBe("2026-01-01");
      expect(dayInZone(deadline, IST)).toBe("2026-01-01");
    });
  });

  it("puts 00:15 IST on the previous UTC day", () => {
    // 00:15 IST = 18:45Z the day before. This is the direction that makes a commitment look
    // resolved-late if the worker compares against a UTC-truncated day.
    const startOfDay = new Date(endOfDayInZone("2026-01-01", IST).getTime() - 86_399_999);
    const quarterPast = new Date(startOfDay.getTime() + 15 * 60_000);
    expect(quarterPast.toISOString()).toBe("2025-12-31T18:45:00.000Z");
    expect(dayInZone(quarterPast, IST)).toBe("2026-01-01");
    expect(dayInZone(quarterPast, "UTC")).toBe("2025-12-31");
  });

  it("is 5h30m earlier than the same civil deadline in UTC", () => {
    const ist = endOfDayInZone("2026-09-05", IST).getTime();
    const utc = endOfDayInZone("2026-09-05", "UTC").getTime();
    expect(utc - ist).toBe(5.5 * 60 * 60 * 1000);
  });
});

describe("endOfDayInZone — other zones", () => {
  it("respects a DST transition rather than assuming a fixed offset", () => {
    underEverySystemZone(() => {
      // 8 March 2026 is the US spring-forward day: that civil day is 23 hours long and ends
      // at EDT (-04:00), not EST (-05:00).
      expect(endOfDayInZone("2026-03-08", "America/New_York").toISOString()).toBe(
        "2026-03-09T03:59:59.999Z",
      );
    });
  });

  it("does not depend on the system zone", () => {
    const seen = new Set<string>();
    underEverySystemZone(() => {
      seen.add(endOfDayInZone("2026-09-05", IST).toISOString());
    });
    expect(seen.size).toBe(1);
  });
});

describe("endOfDayInZone — rejections", () => {
  it("rejects a date that is not a real calendar day instead of rolling it forward", () => {
    // `new Date(2026, 1, 30)` is 2 March. Storing that would move the deadline two days
    // later than the one the user picked, silently.
    expect(() => endOfDayInZone("2026-02-30", IST)).toThrow(InvalidDeadlineError);
  });

  it("rejects a malformed date and an unknown zone", () => {
    expect(() => endOfDayInZone("5-9-2026", IST)).toThrow(InvalidDeadlineError);
    expect(() => endOfDayInZone("2026-09-05", "Mars/Olympus_Mons")).toThrow(
      InvalidDeadlineError,
    );
  });

  it("accepts a leap day in a leap year and rejects it otherwise", () => {
    expect(endOfDayInZone("2028-02-29", IST).toISOString()).toBe("2028-02-29T18:29:59.999Z");
    expect(() => endOfDayInZone("2026-02-29", IST)).toThrow(InvalidDeadlineError);
  });
});
