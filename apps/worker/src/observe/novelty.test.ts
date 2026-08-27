/**
 * The novelty digest (done-spec-dsl.md §6.3).
 *
 * The claim being protected: `unchanged_since_commitment` must fire when the target has not
 * moved, and must NOT fire when it has. A digest that varied on something incidental would
 * make the flag never fire; a digest that ignored something substantive would make it always
 * fire. Both turn an anti-gaming signal into decoration.
 */
import { describe, expect, it } from "vitest";
import { targetDigest } from "./novelty";
import type { Observation } from "./types";

const observedAt = "2026-09-03T12:00:00.000Z";

const seen = (source: string, values: Record<string, unknown>): Observation => ({
  source,
  observed: true,
  observedAt,
  values,
  evidence: { status: 200 },
});

const missed = (source: string): Observation => ({
  source,
  observed: false,
  observedAt,
  error: { code: "timeout", message: "body timeout" },
  evidence: {},
});

describe("targetDigest", () => {
  it("is stable across runs of an unchanged target", () => {
    const a = targetDigest([seen("http:https://x.test", { status: 200, text: "coming soon" })]);
    const b = targetDigest([seen("http:https://x.test", { status: 200, text: "coming soon" })]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores observation time, which changes on every run and means nothing", () => {
    const first = seen("http:https://x.test", { status: 200, text: "x" });
    const second: Observation = { ...first, observedAt: "2026-09-04T01:02:03.000Z" };
    expect(targetDigest([first])).toBe(targetDigest([second]));
  });

  it("changes when a read value changes by one byte", () => {
    const before = targetDigest([seen("http:https://x.test", { text: "coming soon" })]);
    const after = targetDigest([seen("http:https://x.test", { text: "coming soon." })]);
    expect(after).not.toBe(before);
  });

  it("changes when one source of several changes", () => {
    const base = [
      seen("http:https://x.test", { status: 200 }),
      seen("github.release:o/r", { tag: "v0.1.0" }),
    ];
    const shipped = [base[0] as Observation, seen("github.release:o/r", { tag: "v0.2.0" })];
    expect(targetDigest(shipped)).not.toBe(targetDigest(base));
  });

  it("does not depend on the order sources came back in", () => {
    const a = seen("http:https://x.test", { status: 200 });
    const b = seen("npm:pledge", { latest_version: "0.2.0" });
    expect(targetDigest([a, b])).toBe(targetDigest([b, a]));
  });

  it("cannot look unchanged by virtue of having seen less", () => {
    const complete = [seen("http:https://x.test", { status: 200 }), seen("npm:p", { v: 1 })];
    const partial = [seen("http:https://x.test", { status: 200 }), missed("npm:p")];
    expect(targetDigest(partial)).not.toBe(targetDigest(complete));
  });
});
