/**
 * Amended deadlines, in `Asia/Kolkata` — CLAUDE.md I-9, extended from deadline.test.ts.
 *
 * An amended deadline is not a different kind of value from the original one. It goes through
 * `endOfDayInZone` exactly the same way, and these tests exist to keep that true: the failure
 * this guards against is a second, subtly different path for the "new" deadline that lands on
 * midnight-UTC or on the wrong side of the +05:30 offset, so that a commitment moved by one
 * day resolves against an instant 5h30m from where the committer put it.
 *
 * The reason field is asserted as hard as the arithmetic. A reason is required by the product
 * before it is required by a schema (architecture.md §5.1), and this is the layer where a
 * blank one gets rejected before it reaches an append-only table.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { AmendmentRow } from "@pledge/db";
import { AmendmentInputSchema } from "./amendment-input";
import { deadlineWasMoved, originalDeadline } from "./amendments";
import { dayInZone, endOfDayInZone } from "./deadline";

const IST = "Asia/Kolkata";
const SYSTEM_ZONES = ["UTC", "Asia/Kolkata", "America/New_York", "Pacific/Kiritimati"] as const;

const originalTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalTz;
});

function underEverySystemZone(fn: () => void): void {
  for (const zone of SYSTEM_ZONES) {
    process.env.TZ = zone;
    fn();
  }
}

/** A `deadline_moved` row as `recordAmendment` writes one: both ends, as ISO strings. */
function move(from: Date, to: Date, at: string, seq: number): AmendmentRow {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    commitmentId: "11111111-1111-4111-8111-111111111111",
    kind: "deadline_moved",
    oldValue: from.toISOString(),
    newValue: to.toISOString(),
    reason: "The upstream API changed its auth model.",
    createdAt: new Date(at),
    ledgerSeq: seq,
  };
}

function withdraw(at: string, seq: number): AmendmentRow {
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    commitmentId: "11111111-1111-4111-8111-111111111111",
    kind: "abandoned",
    oldValue: null,
    newValue: null,
    reason: "Descoped; not shipping this.",
    createdAt: new Date(at),
    ledgerSeq: seq,
  };
}

describe("amended deadlines — Asia/Kolkata", () => {
  it("resolves a moved deadline through the same arithmetic as the original", () => {
    underEverySystemZone(() => {
      const original = endOfDayInZone("2026-09-05", IST);
      const moved = endOfDayInZone("2026-09-12", IST);

      expect(original.toISOString()).toBe("2026-09-05T18:29:59.999Z");
      expect(moved.toISOString()).toBe("2026-09-12T18:29:59.999Z");
      // Exactly seven civil days, to the millisecond. A path that resolved one end at
      // midnight UTC and the other at end-of-day IST would be 5h30m out here.
      expect(moved.getTime() - original.getTime()).toBe(7 * 86_400_000);
    });
  });

  it("moves LATER across a UTC date boundary and stays on the intended IST day", () => {
    underEverySystemZone(() => {
      // 31 Dec 2025 IST → 1 Jan 2026 IST. Both are stored on the SAME UTC calendar day as
      // their IST day here, but the instants straddle the year boundary, and the 23:30 IST
      // reading below is the one that lands on the previous UTC day.
      const before = endOfDayInZone("2025-12-31", IST);
      const after = endOfDayInZone("2026-01-01", IST);

      expect(dayInZone(before, IST)).toBe("2025-12-31");
      expect(dayInZone(after, IST)).toBe("2026-01-01");
      expect(after.getTime()).toBeGreaterThan(before.getTime());

      // 23:30 IST on the amended day = 18:00Z the SAME UTC day; 00:15 IST = 18:45Z the day
      // BEFORE. Both are inside the amended deadline, and both are on a UTC date that a naive
      // UTC-truncating comparison would get wrong.
      const halfPastEleven = new Date(after.getTime() - 29 * 60_000 - 59_999);
      expect(halfPastEleven.toISOString()).toBe("2026-01-01T18:00:00.000Z");
      expect(dayInZone(halfPastEleven, IST)).toBe("2026-01-01");
      expect(halfPastEleven.getTime()).toBeLessThan(after.getTime());
    });
  });

  it("moves EARLIER across a UTC date boundary — 00:15 IST is the previous UTC day", () => {
    underEverySystemZone(() => {
      const original = endOfDayInZone("2026-01-05", IST);
      // Pulled in to 1 Jan. Moving a deadline earlier is a legitimate amendment and must go
      // through the same path; nothing in the product requires a move to be a delay.
      const moved = endOfDayInZone("2026-01-01", IST);
      expect(moved.getTime()).toBeLessThan(original.getTime());

      const startOfMovedDay = new Date(moved.getTime() - 86_399_999);
      const quarterPast = new Date(startOfMovedDay.getTime() + 15 * 60_000);
      expect(quarterPast.toISOString()).toBe("2025-12-31T18:45:00.000Z");
      // The committer's clock says 1 January; UTC says 31 December. The amended deadline has
      // to be read in the committer's zone or this instant looks like it is a day early.
      expect(dayInZone(quarterPast, IST)).toBe("2026-01-01");
      expect(dayInZone(quarterPast, "UTC")).toBe("2025-12-31");
      expect(quarterPast.getTime()).toBeLessThan(moved.getTime());
    });
  });

  it("keeps the amended deadline 5h30m ahead of the same civil day in UTC", () => {
    const ist = endOfDayInZone("2026-09-12", IST).getTime();
    const utc = endOfDayInZone("2026-09-12", "UTC").getTime();
    expect(utc - ist).toBe(5.5 * 60 * 60 * 1000);
  });
});

describe("originalDeadline", () => {
  it("returns the current deadline when nothing moved", () => {
    const current = endOfDayInZone("2026-09-05", IST);
    expect(originalDeadline(current, []).toISOString()).toBe(current.toISOString());
    expect(deadlineWasMoved([])).toBe(false);
  });

  it("recovers the ORIGINAL deadline after two moves, not the intermediate one", () => {
    // architecture.md §5.1: "moved twice and landed on time" has to be reconstructible. The
    // failure mode is showing the second move's old_value, which is itself already an amended
    // value and makes the record look like it moved once.
    const first = endOfDayInZone("2026-09-05", IST);
    const second = endOfDayInZone("2026-09-12", IST);
    const third = endOfDayInZone("2026-09-19", IST);

    const history = [
      move(first, second, "2026-09-04T10:00:00Z", 10),
      move(second, third, "2026-09-11T10:00:00Z", 11),
    ];

    expect(originalDeadline(third, history).toISOString()).toBe(first.toISOString());
    expect(deadlineWasMoved(history)).toBe(true);
  });

  it("ignores withdrawals when looking for the original deadline", () => {
    const first = endOfDayInZone("2026-09-05", IST);
    const second = endOfDayInZone("2026-09-12", IST);
    // A withdrawal carries no deadline. Reading its null old_value as an instant would yield
    // an Invalid Date rendered as the "original" deadline.
    const history = [withdraw("2026-09-03T10:00:00Z", 9), move(first, second, "2026-09-04T10:00:00Z", 10)];

    expect(originalDeadline(second, history).toISOString()).toBe(first.toISOString());
    expect(deadlineWasMoved([withdraw("2026-09-03T10:00:00Z", 9)])).toBe(false);
  });
});

describe("AmendmentInputSchema — the reason is required", () => {
  const base = { kind: "deadline_moved", deadlineDate: "2026-09-12", timeZone: IST } as const;

  it("rejects a missing, empty or whitespace-only reason", () => {
    expect(AmendmentInputSchema.safeParse({ ...base }).success).toBe(false);
    expect(AmendmentInputSchema.safeParse({ ...base, reason: "" }).success).toBe(false);
    expect(AmendmentInputSchema.safeParse({ ...base, reason: "    " }).success).toBe(false);
    expect(AmendmentInputSchema.safeParse({ kind: "abandoned", reason: "   " }).success).toBe(
      false,
    );
  });

  it("trims the reason it stores, so the DB's non-blank CHECK cannot be smuggled past", () => {
    const parsed = AmendmentInputSchema.parse({ ...base, reason: "  ran out of time  " });
    expect(parsed.reason).toBe("ran out of time");
  });

  it("accepts a withdrawal with a reason and no date", () => {
    const parsed = AmendmentInputSchema.parse({
      kind: "abandoned",
      reason: "Descoped; not shipping this.",
    });
    expect(parsed.kind).toBe("abandoned");
  });

  it("rejects a malformed date", () => {
    expect(
      AmendmentInputSchema.safeParse({ ...base, deadlineDate: "12-09-2026", reason: "later" })
        .success,
    ).toBe(false);
  });

  it("carries no done-spec field — an amendment never changes what was promised (I-4)", () => {
    // A client that tries anyway gets its extra key dropped rather than honoured. If this ever
    // starts passing a spec through, the composer and the amendment path have merged and the
    // hash has stopped being the contract.
    const parsed = AmendmentInputSchema.parse({
      ...base,
      reason: "slipped a week",
      spec: { kind: "http_status", url: "https://example.com", expectedStatus: 200 },
    });
    expect(parsed).not.toHaveProperty("spec");
    expect(parsed).not.toHaveProperty("doneSpecHash");
  });
});
