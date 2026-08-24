/**
 * The two job handlers, kept free of pg-boss and of `postgres` so they can be tested with a
 * real database and a fake queue (or neither).
 *
 * Scheduling in v0 is deliberately flat: a daily sweep enqueues one routine probe per open
 * commitment, plus the single authoritative run at `deadline+0`. The tightening backoff curve
 * (hourly at T-72h, 5-minutely in the final hour) is on the roadmap's deferred list — it
 * changes how *early* a `kept` is observed, not whether resolution is correct.
 */
import {
  listOpenCommitments,
  recordProbeRun,
  type Db,
  type DoneSpecV0,
  type ProbeResult,
} from "@pledge/db";
import { z } from "zod";
import { QUEUE_PROBE } from "@pledge/db";
import { loadOpenCommitment } from "./queries";

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

/** Daily sweep. The window has to exceed the sweep interval or a deadline falls between runs. */
const DEADLINE_LOOKAHEAD_MS = 25 * 60 * 60 * 1000;
/** architecture.md §8: retry an unobservable target for an hour before giving up on it. */
export const GRACE_WINDOW_MS = 60 * 60 * 1000;
const GRACE_RETRY_MS = 10 * 60 * 1000;

/**
 * Recorded in the finalising run's evidence message. There is no `dispute_reason` column in
 * v0, and the reason must survive somewhere a human can read it — the alternative is a
 * `disputed` commitment with no stated cause, which is worse than a slightly stringy field.
 */
export const UNREACHABLE_AT_DEADLINE = "target_unreachable_at_deadline";

export const ProbeJobSchema = z.object({
  commitmentId: z.uuid(),
  /**
   * True only for the run at `deadline+0` and its grace-window retries. An intermediate probe
   * observing FALSE means nothing — a repo without its release at T-48h is not a miss.
   */
  authoritative: z.boolean(),
  /** Set once the first authoritative run comes back unobservable; carried across retries. */
  graceUntil: z.iso.datetime().optional(),
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
  startAfterSeconds?: number,
) => Promise<void>;

export interface WorkerDeps {
  readonly db: Db;
  readonly enqueue: Enqueue;
  readonly runProbe: (spec: DoneSpecV0) => Promise<ProbeResult>;
  readonly now: () => Date;
  readonly log: Logger;
}

// -----------------------------------------------------------------------------------------
// Sweep
// -----------------------------------------------------------------------------------------

export async function handleSweep(deps: WorkerDeps): Promise<void> {
  const open = await listOpenCommitments(deps.db);
  const now = deps.now().getTime();

  for (const c of open) {
    await deps.enqueue(QUEUE_PROBE, { commitmentId: c.id, authoritative: false });

    const untilDeadline = c.deadline.getTime() - now;
    if (untilDeadline <= DEADLINE_LOOKAHEAD_MS) {
      // A deadline inside two sweep windows gets enqueued twice. That is fine and cheaper than
      // deduplication state: a duplicate delivery inserts a second observation and resolves
      // nothing twice (architecture.md §6.2).
      await deps.enqueue(
        QUEUE_PROBE,
        { commitmentId: c.id, authoritative: true },
        Math.max(0, untilDeadline) / 1000,
      );
    }
  }

  deps.log.info(`sweep enqueued probes for ${open.length} open commitment(s)`);
}

// -----------------------------------------------------------------------------------------
// Probe
// -----------------------------------------------------------------------------------------

export interface GraceDecision {
  /** May this run resolve the commitment on a non-pass outcome? */
  readonly finalize: boolean;
  /** Present when the run must be retried inside the grace window. */
  readonly retryInSeconds?: number;
  readonly graceUntil: Date;
}

/**
 * The `error`-at-the-deadline rule, as a pure function (architecture.md §8, security.md T-07).
 *
 *   not authoritative        → never finalises. A pass still resolves; nothing else does.
 *   authoritative + pass     → kept.
 *   authoritative + fail     → missed. This is an OBSERVATION that the condition is false.
 *   authoritative + error    → retry every 10 minutes until deadline+60m, then `disputed`.
 *                              Never `missed`. We did not see the target; saying someone
 *                              missed because their host was down is the bug this whole
 *                              product cannot afford.
 */
export function decideGrace(input: {
  readonly authoritative: boolean;
  readonly outcome: ProbeResult["outcome"];
  readonly deadline: Date;
  readonly graceUntil?: Date;
  readonly now: Date;
}): GraceDecision {
  const graceUntil = input.graceUntil ?? new Date(input.deadline.getTime() + GRACE_WINDOW_MS);

  if (!input.authoritative) return { finalize: false, graceUntil };
  if (input.outcome !== "error") return { finalize: true, graceUntil };

  const remainingMs = graceUntil.getTime() - input.now.getTime();
  if (remainingMs <= 0) return { finalize: true, graceUntil };

  return {
    finalize: false,
    retryInSeconds: Math.min(GRACE_RETRY_MS, remainingMs) / 1000,
    graceUntil,
  };
}

export async function handleProbeJob(deps: WorkerDeps, job: ProbeJob): Promise<void> {
  const target = await loadOpenCommitment(deps.db, job.commitmentId);
  if (target === undefined) {
    // Already resolved by an earlier run, or gone. Nothing to observe — and no reason to send
    // a stranger's server another request.
    deps.log.info(`probe skipped: commitment ${job.commitmentId} is no longer open`);
    return;
  }

  const result = await deps.runProbe(target.spec);
  const decision = decideGrace({
    authoritative: job.authoritative,
    outcome: result.outcome,
    deadline: target.deadline,
    graceUntil: job.graceUntil === undefined ? undefined : new Date(job.graceUntil),
    now: deps.now(),
  });

  const recorded = await recordProbeRun(deps.db, {
    commitmentId: job.commitmentId,
    result: annotateIfGivingUp(result, decision.finalize),
    authoritative: decision.finalize,
  });

  if (decision.retryInSeconds !== undefined) {
    deps.log.warn(
      `target for ${job.commitmentId} unobservable at deadline (${result.evidence.error?.code ?? "unknown"}); ` +
        `retrying until ${decision.graceUntil.toISOString()}`,
    );
    await deps.enqueue(
      QUEUE_PROBE,
      {
        commitmentId: job.commitmentId,
        authoritative: true,
        graceUntil: decision.graceUntil.toISOString(),
      },
      decision.retryInSeconds,
    );
    return;
  }

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
