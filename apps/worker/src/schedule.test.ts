/**
 * The backoff curve, at its boundaries.
 *
 * Boundaries are the whole test: an off-by-one band means either a deadline probe that never
 * runs or a daily probe that runs every five minutes against someone else's server. Both are
 * silent until they are not.
 */
import { describe, expect, it } from "vitest";
import {
  FINAL_HOUR_MS,
  GRACE_RETRY_MS,
  GRACE_WINDOW_MS,
  PRIORITY_DEADLINE,
  PRIORITY_ROUTINE,
  SWEEP_INTERVAL_MS,
  graceExpired,
  planProbe,
  probeIntervalMs,
} from "./schedule";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A deadline at 23:30 Asia/Kolkata, which is 18:00 UTC the same day. IST is UTC+05:30 with no
 * DST, and the half-hour offset is what breaks naive date arithmetic (CLAUDE.md I-9). Every
 * time in this file is derived from it rather than from a round UTC number, so an
 * implementation that quietly assumed whole-hour offsets would fail here.
 */
const DEADLINE = new Date("2026-09-05T18:00:00.000Z");
const before = (ms: number): Date => new Date(DEADLINE.getTime() - ms);

const open = (lastRanAt: Date | null) => ({
  commitmentId: "11111111-1111-4111-8111-111111111111",
  deadline: DEADLINE,
  lastRanAt,
});

describe("probeIntervalMs", () => {
  it("is daily while more than 72h remain", () => {
    expect(probeIntervalMs(10 * DAY)).toBe(DAY);
    expect(probeIntervalMs(72 * HOUR + 1)).toBe(DAY);
  });

  it("switches to hourly AT T-72h, not one interval later", () => {
    expect(probeIntervalMs(72 * HOUR)).toBe(HOUR);
    expect(probeIntervalMs(6 * HOUR + 1)).toBe(HOUR);
  });

  it("tightens at T-6h", () => {
    expect(probeIntervalMs(6 * HOUR)).toBe(15 * MINUTE);
    expect(probeIntervalMs(HOUR + 1)).toBe(15 * MINUTE);
  });

  it("is five-minutely for the whole final hour, T-1h included", () => {
    expect(probeIntervalMs(HOUR)).toBe(5 * MINUTE);
    expect(probeIntervalMs(1)).toBe(5 * MINUTE);
  });
});

describe("planProbe — routine runs", () => {
  it("probes a never-observed commitment immediately", () => {
    const planned = planProbe(open(null), before(10 * DAY));
    expect(planned).toMatchObject({
      authoritative: false,
      startAfterSeconds: 0,
      priority: PRIORITY_ROUTINE,
    });
  });

  it("says nothing is due while the last observation is still inside the band", () => {
    const now = before(10 * DAY);
    expect(planProbe(open(new Date(now.getTime() - 23 * HOUR)), now)).toBeUndefined();
    expect(planProbe(open(new Date(now.getTime() - 25 * HOUR)), now)).toBeDefined();
  });

  it("applies the hourly band between T-72h and T-6h", () => {
    const now = before(48 * HOUR);
    expect(planProbe(open(new Date(now.getTime() - 59 * MINUTE)), now)).toBeUndefined();
    expect(planProbe(open(new Date(now.getTime() - 61 * MINUTE)), now)).toBeDefined();
  });

  it("raises priority inside the final hour so a backlog delays daily probes instead", () => {
    const now = before(FINAL_HOUR_MS - MINUTE);
    const planned = planProbe(open(new Date(now.getTime() - 10 * MINUTE)), now);
    expect(planned?.priority).toBe(PRIORITY_DEADLINE);
    expect(planned?.authoritative).toBe(false);

    const earlier = before(48 * HOUR);
    expect(planProbe(open(new Date(earlier.getTime() - 2 * HOUR)), earlier)?.priority).toBe(
      PRIORITY_ROUTINE,
    );
  });

  it("never marks a pre-deadline run authoritative — a fail at T-48h is not a miss", () => {
    for (const remaining of [10 * DAY, 72 * HOUR, 6 * HOUR, 30 * MINUTE]) {
      const now = before(remaining);
      expect(planProbe(open(null), now)?.authoritative).toBe(false);
    }
  });
});

describe("planProbe — the authoritative run", () => {
  it("is scheduled FOR deadline+0, not for the tick that noticed it", () => {
    const now = before(SWEEP_INTERVAL_MS - MINUTE);
    const planned = planProbe(open(new Date(now.getTime() - MINUTE)), now);
    expect(planned).toMatchObject({ authoritative: true, priority: PRIORITY_DEADLINE });
    expect(planned?.startAfterSeconds).toBeCloseTo((SWEEP_INTERVAL_MS - MINUTE) / 1000, 3);
  });

  it("is planned even when a routine probe ran seconds ago", () => {
    const now = before(MINUTE);
    expect(planProbe(open(new Date(now.getTime() - 1000)), now)?.authoritative).toBe(true);
  });

  it("is not re-planned while the previous attempt is still fresh", () => {
    const now = new Date(DEADLINE.getTime() + 2 * MINUTE);
    expect(planProbe(open(DEADLINE), now)).toBeUndefined();
  });

  it("is re-planned on the grace cadence once the previous attempt has aged", () => {
    const now = new Date(DEADLINE.getTime() + GRACE_RETRY_MS + MINUTE);
    const planned = planProbe(open(DEADLINE), now);
    expect(planned).toMatchObject({
      authoritative: true,
      startAfterSeconds: 0,
      priority: PRIORITY_DEADLINE,
    });
  });

  it("keeps re-planning past the grace window, so the run that finalises disputed happens", () => {
    const now = new Date(DEADLINE.getTime() + GRACE_WINDOW_MS + GRACE_RETRY_MS);
    expect(
      planProbe(open(new Date(DEADLINE.getTime() + GRACE_WINDOW_MS)), now)?.authoritative,
    ).toBe(true);
  });
});

describe("graceExpired", () => {
  it("is false during the window and true at its close", () => {
    expect(graceExpired(DEADLINE, new Date(DEADLINE.getTime() + GRACE_WINDOW_MS - 1))).toBe(
      false,
    );
    expect(graceExpired(DEADLINE, new Date(DEADLINE.getTime() + GRACE_WINDOW_MS))).toBe(true);
  });
});

describe("IST deadline arithmetic", () => {
  /**
   * 00:15 IST on 6 September is 18:45 UTC on 5 September — the deadline and its local calendar
   * date are on opposite sides of the UTC date boundary, in both directions across the two
   * cases here. The curve must not care, and this is where it would show if it did.
   */
  it("bands correctly across a UTC date boundary in both directions", () => {
    const lateEvening = new Date("2026-09-05T18:00:00.000Z"); // 23:30 IST, 5 Sept
    const justAfterMidnight = new Date("2026-09-05T18:45:00.000Z"); // 00:15 IST, 6 Sept

    // 23:00 IST on 5 Sept. Thirty minutes from the 23:30 deadline — inside the final hour —
    // and seventy-five from the 00:15 one, which is not. A half-hour offset mishandled as a
    // whole hour puts both in the same band, which is exactly the bug I-9 is about.
    const now = new Date("2026-09-05T17:30:00.000Z");
    expect(
      planProbe({ commitmentId: "a", deadline: lateEvening, lastRanAt: null }, now)?.priority,
    ).toBe(PRIORITY_DEADLINE);
    expect(
      planProbe({ commitmentId: "b", deadline: justAfterMidnight, lastRanAt: null }, now)
        ?.priority,
    ).toBe(PRIORITY_ROUTINE);

    // 23:46 IST: now inside the final hour of the after-midnight deadline, whose local
    // calendar date is the following day while the instant is still the previous one in UTC.
    const later = new Date("2026-09-05T17:46:00.000Z");
    expect(
      planProbe({ commitmentId: "b", deadline: justAfterMidnight, lastRanAt: null }, later)
        ?.priority,
    ).toBe(PRIORITY_DEADLINE);
    // Fourteen minutes from the earlier deadline: still a routine run at deadline priority.
    // The authoritative one is planned only once the deadline is within a sweep tick.
    expect(
      planProbe({ commitmentId: "a", deadline: lateEvening, lastRanAt: null }, later),
    ).toMatchObject({ authoritative: false, priority: PRIORITY_DEADLINE });
  });
});
