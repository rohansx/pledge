import { z } from "zod";

// One schema per shape: the route validates with it and the dashboard imports the inferred types.
// Everything here arrives from outside (the CLI, and through it from a sandbox that ran untrusted code),
// so every string and list is bounded.

const text = (max: number) => z.string().max(max);
const count = z.number().int().min(0).max(1_000_000);
const result = z.enum(["kept", "broken", "inconclusive"]);
const json = z.unknown();

const seedSchema = z.strictObject({
  seed: z.number().int(),
  run_id: text(80),
  status: z.enum(["pass", "fail", "unknown"]),
  expected: json.optional(),
  actual: json.optional(),
  failed: count.optional(), // journeys whose check failed, for per-journey assertions
});

const pledgeSchema = z.strictObject({
  id: text(120),
  statement: text(1000),
  status: z.enum(["proposed", "proven", "approved", "retired"]),
  source: text(40),
  confidence: text(20),
  assertion: text(120),
  result,
  kept: count,
  broken: count,
  unknown: count,
  seeds: z.array(seedSchema).max(64),
});

const runSchema = z.strictObject({
  seed: z.number().int(),
  run_id: text(80),
  verdict: z.enum(["pass", "fail", "inconclusive", "error"]),
  faults_injected: count,
  journeys: count,
  limitations: z.array(text(500)).max(20),
});

const faultSchema = z.strictObject({ kind: text(40), target: text(200), params: z.record(text(40), json) });

const phaseSchema = z.strictObject({
  phase: text(40),
  model: text(80),
  requests: count,
  tokens: z.number().int().min(0),
  cache_read_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  commands: count,
  seconds: z.number().min(0),
  rejected_finishes: count,
});

export const scanSchema = z.strictObject({
  schema_version: z.literal(1),
  app: text(120),
  scenario: text(120),
  verdict: result,
  faults: z.strictObject({ name: text(120), description: text(1000), faults: z.array(faultSchema).max(32) }).nullable(),
  env: z.record(text(80), text(200)),
  pledges: z.array(pledgeSchema).max(200),
  runs: z.array(runSchema).min(1).max(64),
  sandbox: z.strictObject({ template: text(80), outbound_blocked: z.boolean(), seconds: z.record(text(60), z.number().min(0)) }).nullable(),
  // Present when Claude wrote the scenario and pledges for this scan.
  authoring: z.strictObject({ seconds: z.number().min(0), phases: z.array(phaseSchema).max(8), summary: text(6000), open_questions: z.array(text(1000)).max(20) }).nullable(),
});

export type Scan = z.infer<typeof scanSchema>;
export type ScanPledge = z.infer<typeof pledgeSchema>;
export type ScanSeed = z.infer<typeof seedSchema>;
export type ScanRun = z.infer<typeof runSchema>;

/** What the scan list shows, derived from a scan when it is stored. */
export interface ScanSummary {
  id: string;
  created_at: string;
  app: string;
  scenario: string;
  verdict: Scan["verdict"];
  faults: string | null;
  authored: boolean;
  pledges: number;
  broken: number;
  run_verdicts: ScanRun["verdict"][];
}

export interface StoredScan extends ScanSummary {
  scan: Scan;
}

export function summarize(scan: Scan): Omit<ScanSummary, "id" | "created_at"> {
  return {
    app: scan.app,
    scenario: scan.scenario,
    verdict: scan.verdict,
    faults: scan.faults?.name ?? null,
    authored: scan.authoring !== null,
    pledges: scan.pledges.length,
    broken: scan.pledges.filter((pledge) => pledge.result === "broken").length,
    run_verdicts: scan.runs.map((run) => run.verdict),
  };
}
