import assert from "node:assert/strict";
import { test } from "node:test";

import type { Scan, ScanPledge, StoredScan } from "../../api/src/schema.ts";
import { appNames, buildApp, replayCommand, standing } from "./model.ts";

function pledge(id: string, result: ScanPledge["result"], status: ScanPledge["status"] = "proposed", seeds: ScanPledge["seeds"] = []): ScanPledge {
  return { id, statement: `${id} holds`, status, source: "inferred", confidence: "medium", assertion: id, result, kept: 0, broken: 0, unknown: 0, seeds };
}

let clock = 0;
function stored(app: string, scenario: string, faults: string | null, pledges: ScanPledge[], authoring: Scan["authoring"] = null): StoredScan {
  clock += 1;
  const scan: Scan = {
    schema_version: 1, app, scenario, verdict: "inconclusive", env: {}, pledges, sandbox: null, authoring,
    faults: faults ? { name: faults, description: "", faults: [] } : null,
    runs: [{ seed: 1, run_id: "r1", verdict: "pass", faults_injected: faults ? 7 : 0, journeys: 20, limitations: [] }],
  };
  return { id: `scan-${clock}`, created_at: `2026-11-23T10:${String(clock).padStart(2, "0")}:00Z`, app, scenario, verdict: "inconclusive", faults, authored: authoring !== null, pledges: pledges.length, broken: 0, run_verdicts: ["pass"], scan };
}

test("apps are listed with the most recently scanned first", () => {
  const scans = [stored("shop", "checkout", null, []), stored("leadecho", "signup", null, []), stored("shop", "checkout", "retry", [])];

  assert.deepEqual(appNames(scans), ["shop", "leadecho"]);
});

test("a pledge's standing comes from the scan under faults, not the baseline, even when the baseline is newer", () => {
  const faulted = stored("shop", "checkout", "retry", [pledge("one-charge", "broken")]);
  const baseline = stored("shop", "checkout", null, [pledge("one-charge", "kept")]);

  const model = buildApp("shop", [faulted, baseline]);

  assert.equal(model.pledges.length, 1);
  assert.equal(model.pledges[0]!.pledge.result, "broken");
  assert.equal(model.pledges[0]!.scanId, faulted.id);
  assert.deepEqual(model.pledges[0]!.history.map((point) => [point.faults, point.result]), [["retry", "broken"], [null, "kept"]]);
});

test("only the latest scan of each scenario and fault plan counts as current, and broken pledges sort first", () => {
  const old = stored("shop", "checkout", "retry", [pledge("one-charge", "broken"), pledge("pays", "kept")]);
  const fresh = stored("shop", "checkout", "retry", [pledge("one-charge", "kept"), pledge("pays", "broken")]);
  const other = stored("leadecho", "signup", null, [pledge("x", "broken")]);

  const model = buildApp("shop", [old, fresh, other]);

  assert.deepEqual(model.current.map((scan) => scan.id), [fresh.id]);
  assert.deepEqual(model.pledges.map((entry) => [entry.pledge.id, entry.pledge.result]), [["pays", "broken"], ["one-charge", "kept"]]);
  assert.deepEqual(model.findings.map((finding) => finding.pledge.id), ["pays"]);
  assert.equal(model.scans.length, 2);
  assert.deepEqual(model.counts, { pledges: 2, broken: 1, kept: 1, inconclusive: 0, approved: 0, proposed: 2, seeds: 1, faultsInjected: 7 });
});

test("the same pledge id in two scenarios is two pledges", () => {
  const model = buildApp("a", [stored("a", "one", null, [pledge("p", "kept")]), stored("a", "two", null, [pledge("p", "broken")])]);

  assert.deepEqual(model.pledges.map((entry) => [entry.scenario, entry.pledge.result]), [["two", "broken"], ["one", "kept"]]);
});

test("an authoring run shared by several scans is shown once, with every scenario it wrote", () => {
  const report = { seconds: 940, phases: [], summary: "three scenarios", open_questions: [] };
  const model = buildApp("leadecho", [stored("leadecho", "signup", null, [], report), stored("leadecho", "billing", null, [], report), stored("leadecho", "other", null, [], { ...report, seconds: 1268 })]);

  assert.equal(model.agentRuns.length, 2);
  assert.deepEqual(model.agentRuns.find((run) => run.authoring.seconds === 940)!.scenarios.sort(), ["billing", "signup"]);
});

test("standing says whether anything would block", () => {
  const word = (pledges: ScanPledge[]) => standing(buildApp("a", [stored("a", "s", "retry", pledges)])).word;

  assert.equal(word([]), "empty");
  assert.equal(word([pledge("p", "broken", "approved")]), "broken");
  assert.equal(word([pledge("p", "broken", "proposed"), pledge("q", "kept", "approved")]), "inconclusive");
  assert.equal(word([pledge("p", "kept", "proposed")]), "inconclusive");
  assert.equal(word([pledge("p", "kept", "approved")]), "kept");
  assert.match(standing(buildApp("a", [stored("a", "s", "retry", [pledge("p", "broken")])])).sentence, /1 pledge is broken but not approved yet/);
});

test("the replay command names the scenario, the faults file and a seed that broke", () => {
  const seeds = [{ seed: 1, run_id: "r1", status: "pass" as const }, { seed: 4, run_id: "r4", status: "fail" as const }];
  const model = buildApp("shop", [stored("shop", "checkout", "lost-reply", [pledge("one-charge", "broken", "approved", seeds)])]);

  assert.deepEqual(model.findings[0]!.brokenSeeds, [4]);
  assert.equal(replayCommand(model.findings[0]!), "pledge run . --scenario checkout --faults .pledge/faults/lost-reply.json --seed 4");
});
