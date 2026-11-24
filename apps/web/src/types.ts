// The shapes the API returns. They mirror python/pledge/api/logic.py by hand: the API is Python, so there is
// no shared schema to import. A field that changes there must change here.

export type PledgeStatus = "proposed" | "proven" | "approved" | "retired";
export type PledgeSource = "code" | "template" | "inferred";
export type Verdict = "kept" | "broken" | "inconclusive";
export type FindingStatus = "open" | "fix_proposed" | "fixed_unverified" | "verified" | "reopened";
export type Phase = "boot" | "author" | "prove" | "run" | "done" | "failed";
export type SeedStatus = "pass" | "fail" | "unknown";
export type Severity = "money" | "duplicate" | "data";

/** The run strip. */
export interface RunSummary {
  requestsSent: number;
  requestsSucceeded: number;
  pledgesChecked: number;
  pledgesBroken: number;
  seeds: number;
  faultsInjected: number;
}

export interface Seed {
  seed: number;
  run_id: string;
  status: SeedStatus;
  expected?: unknown;
  actual?: unknown;
  failed?: number;
}

export interface Run {
  id: string;
  repoId: string;
  createdAt: string;
  finishedAt: string | null;
  trigger: "first_scan" | "pull_request" | "manual";
  commit: string | null;
  pullRequest: number | null;
  phase: Phase;
  scenario: string | null;
  faults: string | null;
  verdict: Verdict | null;
  summary: RunSummary | null;
  durationSeconds: number | null;
  costUsd: number | null;
  seedsPlanned: number | null;
  failure: string | null;
  seedVerdicts: string[];
  authored: boolean;
}

export interface RunResult {
  pledgeId: string;
  statement: string;
  status: PledgeStatus;
  result: Verdict;
  kept: number;
  broken: number;
  unknown: number;
  seeds: Seed[];
}

export interface FaultPlan {
  name: string;
  description: string;
  faults: { kind: string; target: string; params: Record<string, unknown> }[];
}

export interface Authoring {
  seconds: number;
  phases: { phase: string; model: string; requests: number; tokens: number; cache_read_tokens: number; output_tokens: number; commands: number; seconds: number; rejected_finishes: number }[];
  summary: string;
  open_questions: string[];
}

export interface RunDetail extends Run {
  results: RunResult[];
  faultPlan: FaultPlan | null;
  seedRuns: { seed: number; run_id: string; verdict: string; faults_injected: number; journeys: number; requests: number; unexpected_failures: number; limitations: string[] }[];
  sandbox: { template: string; outbound_blocked: boolean; seconds: Record<string, number> } | null;
  authoring: Authoring | null;
  env: Record<string, string>;
  findingIds: string[];
}

export interface Pledge {
  id: string;
  repoId: string;
  key: string;
  scenario: string;
  statement: string;
  status: PledgeStatus;
  source: PledgeSource;
  sourceRef: { file: string; line: number } | null;
  confidence: string;
  plantedBugsCaught: number;
  lastVerdict: Verdict | null;
  lastRunId: string | null;
  lastFaults: string | null;
  lastSeeds: SeedStatus[];
  decision: { action: "approve" | "reject" | "retire"; override: boolean; note: string; at: string } | null;
}

export interface PledgeDetail extends Pledge {
  assertion: string;
  file: string;
  seeds: Seed[];
  history: { runId: string; at: string; faults: string | null; result: Verdict }[];
  findingId: string | null;
  plantedBugs: unknown[];
}

export interface Finding {
  id: string;
  repoId: string;
  pledgeId: string;
  pledgeKey: string | null;
  pledgeStatus: PledgeStatus | null;
  statement: string;
  status: FindingStatus;
  runId: string;
  brokenSeeds: number[];
  totalSeeds: number;
  faults: string | null;
  firstSeen: string;
  updatedAt: string;
  severity: Severity;
  /** The first failing seed's checked values, so a list can show the damage. */
  expected: unknown;
  actual: unknown;
}

export interface RecordingStep {
  at: number;
  actor: "client" | "fault" | "check";
  text: string;
  detail: { request: string; reply: string } | null;
}

export interface FindingDetail extends Finding {
  seeds: Seed[];
  summary: RunSummary | null;
  faultPlan: FaultPlan | null;
  timeline: RecordingStep[];
  recording: { seed: number; journey: string; faults_hit: number } | null;
  browser: BrowserMedia | null;
  minimalFaultPlan: { fault: string; target: string }[];
  replayCommand: string;
  history: { at: string; status: FindingStatus; run_id: string | null }[];
  blocks: boolean;
}

export interface Repo {
  id: string;
  name: string;
  createdAt: string;
  pledges: number;
  openFindings: number;
  latestRun: Run | null;
  lastActivity: string;
}

export interface Overview {
  repo: { id: string; name: string };
  headline: { kept: number; total: number; broken: Pledge[]; blocking: number; approved: number };
  latestRun: Run | null;
  runningRunId: string | null;
  counters: { bugsCaught: number; pullRequestsChecked: number; faultsInjected: number; approvedPledges: number; seedsRun: number; awaitingReview: number; openFindings: number };
  trend: { week: string; kept: number; broken: number }[];
  latestRuns: Run[];
  latestFindings: Finding[];
}

export interface Me {
  user: { name: string; kind: string };
  repos: { id: string; name: string }[];
}

/** One event on a live run's stream. */
export interface RunEvent {
  seq: number;
  type: "phase_started" | "phase_step" | "pledge_proposed" | "pledge_proven" | "seed_finished" | "run_finished";
  data: Record<string, unknown> & { at?: string };
}

/** A browser recording stored for a run: which journey's user it shows and which files exist. */
export interface BrowserMedia {
  runId: string;
  seed: number;
  journey: string;
  files: string[];
}
