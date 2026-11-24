// Everything the dashboard shows is derived here from the stored scans. No DOM, so it is tested with node --test.

import type { Scan, ScanPledge, StoredScan } from "../../api/src/schema.ts";

export interface HistoryPoint {
  scanId: string;
  at: string;
  faults: string | null;
  result: ScanPledge["result"];
}

/** One pledge as the app currently stands: its latest result, and how it did in every scan that checked it. */
export interface PledgeEntry {
  pledge: ScanPledge;
  scenario: string;
  scanId: string;
  faults: string | null;
  history: HistoryPoint[]; // oldest first
}

export interface Finding {
  pledge: ScanPledge;
  scan: StoredScan;
  brokenSeeds: number[];
}

export interface AgentRun {
  scanId: string;
  at: string;
  scenarios: string[];
  authoring: NonNullable<Scan["authoring"]>;
}

export interface AppModel {
  app: string;
  scans: StoredScan[]; // newest first
  current: StoredScan[]; // the latest scan of each scenario and fault plan
  pledges: PledgeEntry[];
  findings: Finding[];
  agentRuns: AgentRun[];
  counts: { pledges: number; broken: number; kept: number; inconclusive: number; approved: number; proposed: number; seeds: number; faultsInjected: number };
}

const newestFirst = (a: StoredScan, b: StoredScan) => b.created_at.localeCompare(a.created_at);

/** App names, the one scanned most recently first. */
export function appNames(scans: StoredScan[]): string[] {
  return [...new Set([...scans].sort(newestFirst).map((stored) => stored.app))];
}

/** A scan under faults says more about a pledge than a baseline does, so it wins; then the newer one. */
function moreTelling(a: StoredScan, b: StoredScan): StoredScan {
  if ((a.scan.faults === null) !== (b.scan.faults === null)) return a.scan.faults === null ? b : a;
  return a.created_at >= b.created_at ? a : b;
}

export function buildApp(app: string, all: StoredScan[]): AppModel {
  const scans = all.filter((stored) => stored.app === app).sort(newestFirst);

  const latest = new Map<string, StoredScan>();
  for (const stored of scans) {
    const key = `${stored.scenario}\n${stored.scan.faults?.name ?? ""}`;
    if (!latest.has(key)) latest.set(key, stored); // scans are newest first
  }
  const current = [...latest.values()];

  // A pledge's standing comes from the most telling current scan of its scenario that checks it.
  const entries = new Map<string, PledgeEntry>();
  const standing = new Map<string, StoredScan>();
  for (const stored of current) {
    for (const pledge of stored.scan.pledges) {
      const key = `${stored.scenario}\n${pledge.id}`;
      const best = standing.has(key) ? moreTelling(standing.get(key)!, stored) : stored;
      standing.set(key, best);
      if (best === stored) entries.set(key, { pledge, scenario: stored.scenario, scanId: stored.id, faults: stored.scan.faults?.name ?? null, history: [] });
    }
  }
  for (const stored of [...scans].reverse()) {
    for (const pledge of stored.scan.pledges) {
      entries.get(`${stored.scenario}\n${pledge.id}`)?.history.push({ scanId: stored.id, at: stored.created_at, faults: stored.scan.faults?.name ?? null, result: pledge.result });
    }
  }
  const order = { broken: 0, inconclusive: 1, kept: 2 };
  const pledges = [...entries.values()].sort((a, b) => order[a.pledge.result] - order[b.pledge.result] || a.scenario.localeCompare(b.scenario) || a.pledge.id.localeCompare(b.pledge.id));

  const findings: Finding[] = [];
  for (const stored of current) {
    for (const pledge of stored.scan.pledges) {
      if (pledge.result === "broken") findings.push({ pledge, scan: stored, brokenSeeds: pledge.seeds.filter((seed) => seed.status === "fail").map((seed) => seed.seed) });
    }
  }

  // Every scan of one authoring run carries the same report; show each run once.
  const runs = new Map<string, AgentRun>();
  for (const stored of scans) {
    const authoring = stored.scan.authoring;
    if (!authoring) continue;
    const key = `${authoring.seconds}\n${authoring.summary}`;
    const run = runs.get(key) ?? { scanId: stored.id, at: stored.created_at, scenarios: [], authoring };
    if (!run.scenarios.includes(stored.scenario)) run.scenarios.push(stored.scenario);
    if (stored.created_at < run.at) run.at = stored.created_at;
    runs.set(key, run);
  }

  const count = (test: (entry: PledgeEntry) => boolean) => pledges.filter(test).length;
  return {
    app,
    scans,
    current,
    pledges,
    findings,
    agentRuns: [...runs.values()],
    counts: {
      pledges: pledges.length,
      broken: count((entry) => entry.pledge.result === "broken"),
      kept: count((entry) => entry.pledge.result === "kept"),
      inconclusive: count((entry) => entry.pledge.result === "inconclusive"),
      approved: count((entry) => entry.pledge.status === "approved"),
      proposed: count((entry) => entry.pledge.status === "proposed"),
      seeds: current.reduce((sum, stored) => sum + stored.scan.runs.length, 0),
      faultsInjected: current.reduce((sum, stored) => sum + stored.scan.runs.reduce((inner, run) => inner + run.faults_injected, 0), 0),
    },
  };
}

/** Where the app stands, in one word and one sentence. Only approved pledges can make it "broken". */
export function standing(model: AppModel): { word: "broken" | "kept" | "inconclusive" | "empty"; sentence: string } {
  const { counts } = model;
  if (counts.pledges === 0) return { word: "empty", sentence: "No pledges have been checked for this app yet." };
  const blocking = model.pledges.filter((entry) => entry.pledge.status === "approved" && entry.pledge.result === "broken").length;
  if (blocking > 0) return { word: "broken", sentence: `${blocking} approved ${blocking === 1 ? "pledge is" : "pledges are"} broken. A pull request check would fail.` };
  if (counts.broken > 0) return { word: "inconclusive", sentence: `${counts.broken} ${counts.broken === 1 ? "pledge is" : "pledges are"} broken but not approved yet, so nothing blocks. Review ${counts.broken === 1 ? "it" : "them"} under Findings.` };
  if (counts.approved === 0) return { word: "inconclusive", sentence: "Every pledge held, but none is approved yet, so there is nothing to block on." };
  if (counts.inconclusive > 0) return { word: "inconclusive", sentence: "No pledge is broken, but some could not be judged on every seed." };
  return { word: "kept", sentence: "Every approved pledge held on every seed of its latest scan." };
}

/** The command that reproduces a finding on one seed, run from the app's directory. */
export function replayCommand(finding: Finding): string {
  const faults = finding.scan.scan.faults ? ` --faults .pledge/faults/${finding.scan.scan.faults.name}.json` : "";
  return `pledge run . --scenario ${finding.scan.scenario}${faults} --seed ${finding.brokenSeeds[0] ?? 1}`;
}
