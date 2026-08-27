/**
 * The two job handlers, kept free of pg-boss and of `postgres` so they can be tested with a
 * real database and a fake queue (or neither).
 *
 * Scheduling lives in ./schedule.ts as a pure function of (deadline, last observation, now).
 * The sweep is a heartbeat that applies it; the probe handler makes one observation and
 * records it. Neither knows anything about the other's timing, which is why killing the
 * process between them cannot leave a half-scheduled commitment.
 */
import { recordProbeRun, type Db, type ProbeResult } from "@pledge/db";
import { QUEUE_PROBE } from "@pledge/db";
import { z } from "zod";
import {
  captureBaseline,
  listDueCommitments,
  loadOpenCommitment,
  type ProbeTarget,
} from "./queries";
import { decideGrace, UNREACHABLE_AT_DEADLINE } from "./grace";
import { planProbe, SWEEP_INTERVAL_MS } from "./schedule";

// Re-exported, not redeclared: apps/web inserts jobs under this name inside the commitment's
// own transaction, so a second string literal here is a way for the two tiers to disagree
// about which queue they are talking on and for nobody to notice until a probe never runs.
export { QUEUE_PROBE } from "@pledge/db";
export const QUEUE_SWEEP = "probe.sweep";
/**
 * Resolution notices. The worker enqueues and never consumes: `pledge_probe` has zero
 * privileges on `account`, so this process structurally cannot learn an email address
 * (architecture.md §4). The app tier, which can, drains this queue.
 */
export const QUEUE_NOTIFY = "notify.resolution";

export { GRACE_WINDOW_MS, SWEEP_INTERVAL_MS } from "./schedule";
export { decideGrace, UNREACHABLE_AT_DEADLINE, type GraceDecision } from "./grace";

export const ProbeJobSchema = z.object({
  commitmentId: z.uuid(),
  /**
   * True only for the run at `deadline+0` and its grace-window retries. An intermediate probe
   * observing FALSE means nothing — a repo without its release at T-48h is not a miss.
   */
  authoritative: z.boolean(),
});
export type ProbeJob = z.infer<typeof ProbeJobSchema>;

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
}

/** Enqueue is injected so a test can assert what was scheduled without running pg-boss. */
export type Enqueue = (
  queue: string,
  data: Record<string, unknown>,
  options?: { readonly startAfterSeconds?: number; readonly priority?: number },
) => Promise<void>;

export interface WorkerDeps {
  readonly db: Db;
  readonly enqueue: Enqueue;
  readonly runProbe: (target: ProbeTarget) => Promise<ProbeResult>;
  readonly now: () => Date;
  readonly log: Logger;
}

// -----------------------------------------------------------------------------------------
// Sweep — the only scheduler
// -----------------------------------------------------------------------------------------

/**
 * One heartbeat: ask every open commitment when it was last observed and enqueue whatever the
 * backoff curve says is due.
 *
 * Planning is a pure function over rows the sweep just read, so a sweep that runs twice, or
 * two sweeps that overlap, plan the same work and the second one enqueues nothing new. There
 * is no claimed state, no lease, and therefore nothing to clean up if this process dies
 * halfway through the loop.
 */
export async function handleSweep(deps: WorkerDeps): Promise<void> {
  const open = await listDueCommitments(deps.db);
  const now = deps.now();
  let enqueued = 0;

  for (const row of open) {
    const planned = planProbe(row, now, SWEEP_INTERVAL_MS);
    if (planned === undefined) continue;
    await deps.enqueue(
      QUEUE_PROBE,
      { commitmentId: planned.commitmentId, authoritative: planned.authoritative },
      { startAfterSeconds: planned.startAfterSeconds, priority: planned.priority },
    );
    enqueued += 1;
  }

  deps.log.info(`sweep: ${open.length} open commitment(s), ${enqueued} probe(s) enqueued`);
}

// -----------------------------------------------------------------------------------------
// Probe
// -----------------------------------------------------------------------------------------

export async function handleProbeJob(deps: WorkerDeps, job: ProbeJob): Promise<void> {
  const target = await loadOpenCommitment(deps.db, job.commitmentId);
  if (target === undefined) {
    // Already resolved by an earlier run, or gone. Nothing to observe — and no reason to send
    // a stranger's server another request.
    deps.log.info(`probe skipped: commitment ${job.commitmentId} is no longer open`);
    return;
  }

  const result = await deps.runProbe(target);
  const decision = decideGrace({
    authoritative: job.authoritative,
    outcome: result.outcome,
    deadline: target.deadline,
    now: deps.now(),
  });

  if (!decision.finalize && job.authoritative && result.outcome === "error") {
    deps.log.warn(
      `target for ${job.commitmentId} unobservable at deadline ` +
        `(${result.evidence.error?.code ?? "unknown"}); grace window closes ${decision.graceUntil.toISOString()}`,
    );
  }

  // INVARIANT I-3: `recordProbeRun` inserts the observation, appends the `probe_result` ledger
  // entry, applies whatever transition the outcome earns and appends the `resolved` entry —
  // all in ONE transaction. If any append fails the state change rolls back with it. Killing
  // this process anywhere inside that call leaves the commitment exactly as it was, and the
  // re-delivered job resolves it (roadmap v1 exit criterion; see ./crash.test.ts).
  const recorded = await recordProbeRun(deps.db, {
    commitmentId: job.commitmentId,
    result: annotateIfGivingUp(result, decision.finalize),
    authoritative: decision.finalize,
  });

  if (recorded.transitioned) {
    // Outside the resolution transaction, by construction: recordProbeRun has already
    // committed. Nothing in the notification path may affect resolution (architecture.md §8).
    await notifyResolution(deps, job.commitmentId, recorded.status);
  }
}

/**
 * Marks the one error that actually costs the committer something: the last unobservable run
 * of the grace window, which resolves the commitment `disputed`.
 *
 * The evidence is otherwise untouched — it is a record of what was seen, and this only names
 * the decision taken because of what was not.
 */
function annotateIfGivingUp(result: ProbeResult, finalising: boolean): ProbeResult {
  if (!finalising || result.outcome !== "error" || result.evidence.error === undefined) {
    return result;
  }
  return {
    ...result,
    evidence: {
      ...result.evidence,
      error: {
        ...result.evidence.error,
        message: `${UNREACHABLE_AT_DEADLINE}: ${result.evidence.error.message}`,
      },
    },
  };
}

async function notifyResolution(
  deps: WorkerDeps,
  commitmentId: string,
  status: string,
): Promise<void> {
  try {
    await deps.enqueue(QUEUE_NOTIFY, { commitmentId, status });
  } catch (error: unknown) {
    // A resolution that happened is not un-happened by a queue hiccup. Log and move on.
    deps.log.warn(
      `could not enqueue resolution notice for ${commitmentId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Binds the database-backed baseline store to the probe layer. Kept here so ./probes stays
 * free of @pledge/db and can be exercised with no database at all.
 */
export function baselineStore(db: Db) {
  return (commitmentId: string, digest: string): Promise<string | null> =>
    captureBaseline(db, commitmentId, digest);
}
