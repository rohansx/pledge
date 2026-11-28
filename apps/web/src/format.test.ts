import assert from "node:assert/strict";
import { test } from "node:test";

import { checkRows, harmFigures, impact, title, plain, pledgeCount, plural, runState, satisfies, seconds, seedsCount, show, verdictSentence, when } from "./format.ts";

test("impact lists only the missed values of the first failing seed", () => {
  const seeds = [
    { status: "pass" },
    { status: "fail", expected: { "/charges": { lte: 20 }, "/orders": 20 }, actual: { "/charges": 29, "/orders": 20 } },
  ];
  assert.deepEqual(impact(seeds), [{ key: "charges", expected: "at most 20", actual: "29", differs: true }]);
  assert.deepEqual(impact([{ status: "fail" }]), []);
});

test("a run that never finished reads as stalled after three hours", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  assert.equal(runState({ phase: "run", verdict: null, createdAt: "2026-01-01T11:00:00Z" }, now), "running");
  assert.equal(runState({ phase: "run", verdict: null, createdAt: "2026-01-01T08:00:00Z" }, now), "stalled");
  assert.equal(runState({ phase: "done", verdict: "broken", createdAt: "2026-01-01T08:00:00Z" }, now), "broken");
});

test("satisfies follows the engine's matchers", () => {
  assert.equal(satisfies(0, 0), true);
  assert.equal(satisfies(0, 13), false);
  assert.equal(satisfies({ lte: 1 }, 1), true);
  assert.equal(satisfies({ lte: 1 }, 2), false);
  assert.equal(satisfies({ gte: 20 }, 20), true);
  assert.equal(satisfies({ len: 2 }, ["a", "b"]), true);
  assert.equal(satisfies({ exists: false }, undefined), true);
  assert.equal(satisfies({ exists: true }, null), false);
  assert.equal(satisfies({ a: 1 }, { a: 1 }), true);
  assert.equal(satisfies("paid", "pending"), false);
});

test("show writes matchers in words and leaves strings bare", () => {
  assert.equal(show({ lte: 1 }), "at most 1");
  assert.equal(show({ gte: 20 }), "at least 20");
  assert.equal(show({ exists: true }), "present");
  assert.equal(show("paid"), "paid");
  assert.equal(show([200, 201]), "[200,201]");
  assert.equal(show(undefined), "");
});

test("checkRows gives one row per checked field and marks the ones that differ", () => {
  const rows = checkRows(
    { "/orders_charged": 20, "/orders_charged_more_than_once": 0, "/max_charges_per_order": { lte: 1 } },
    { "/orders_charged": 20, "/orders_charged_more_than_once": 13, "/max_charges_per_order": 2 },
  );

  assert.deepEqual(rows, [
    { key: "orders_charged", expected: "20", actual: "20", differs: false },
    { key: "orders_charged_more_than_once", expected: "0", actual: "13", differs: true },
    { key: "max_charges_per_order", expected: "at most 1", actual: "2", differs: true },
  ]);
});

test("checkRows falls back to a single row for scalars, matchers and missing fields", () => {
  assert.deepEqual(checkRows(1, 2), [{ key: "", expected: "1", actual: "2", differs: true }]);
  assert.deepEqual(checkRows({ lte: 1 }, 1), [{ key: "", expected: "at most 1", actual: "1", differs: false }]);
  assert.deepEqual(checkRows({ "/a": 1 }, {}), [{ key: "a", expected: "1", actual: "missing", differs: true }]);
});

test("counts read as plain sentences", () => {
  assert.equal(pledgeCount(8, 2), "2 of 8 pledges broken");
  assert.equal(pledgeCount(1, 0), "no pledge broken");
  assert.equal(pledgeCount(0, 0), "no pledges");
  assert.equal(seedsCount(["fail", "pass", "fail"]), "failed on 2 of 3 seeds");
  assert.equal(seedsCount(["pass"]), "1 seed, none failed");
});

test("the verdict sentence says whether anything blocks", () => {
  assert.match(verdictSentence("broken", 2, 1, 2), /would block a merge/);
  assert.match(verdictSentence("kept", 2, 0, 2), /Every approved pledge held/);
  assert.match(verdictSentence("inconclusive", 8, 3, 0), /3 of 8 pledges broken, but none is approved yet/);
  assert.match(verdictSentence("inconclusive", 8, 0, 0), /No pledge is approved yet/);
});

test("when and seconds are short and human", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  assert.equal(when("2026-11-23T11:59:40Z", now), "just now");
  assert.equal(when("2026-11-23T11:20:00Z", now), "40 min ago");
  assert.equal(when("2026-11-23T07:00:00Z", now), "5 h ago");
  assert.equal(when("not a date", now), "");
  assert.equal(seconds(29.43), "29.4 s");
  assert.equal(seconds(126), "2 min 6 s");
});

test("plain drops markdown emphasis and code marks but keeps the words", () => {
  assert.equal(plain("**Scenarios** (under `.pledge/scenarios/`):"), "Scenarios (under .pledge/scenarios/):");
  assert.equal(plain("2 * 3 * 4 and a lone ` mark"), "2 * 3 * 4 and a lone ` mark");
  assert.equal(plural(1, "seed"), "1 seed");
  assert.equal(plural(3, "seed"), "3 seeds");
});

test("a pledge key reads as a short title", () => {
  assert.equal(title("psp-never-asked-to-charge-a-transaction-twice"), "PSP never asked to charge a transaction twice");
  assert.equal(title("one_order_per_checkout"), "One order per checkout");
});

test("harm shows journeys broken and the summed gap, worded for money", () => {
  assert.deepEqual(harmFigures({ failed: 79, samples: 100, seeds: 5, gap: 5481.5 }, "money"), [
    { value: "79 of 100", label: "journeys broke it, over 5 runs" },
    { value: "5,481.50", label: "of money charged wrongly, in the app's currency" },
  ]);
  assert.deepEqual(harmFigures({ failed: 1, samples: 20, seeds: 1, gap: null }, "duplicate"), [{ value: "1 of 20", label: "journeys broke it, over 1 run" }]);
  assert.deepEqual(harmFigures(null, "money"), []);
});
