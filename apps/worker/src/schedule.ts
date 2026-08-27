/**
 * The probe backoff curve, as a pure function of (deadline, last observation, now).
 *
 * roadmap.md v1 and technical-spec.md §5: daily until T-72h, hourly until T-6h, tightening in
 * the final hour to five-minutely, plus one authoritative run at deadline+0.
 *
 * WHY A HEARTBEAT AND NOT A CHAIN. The obvious design is for each probe to enqueue its own
 * successor. It is also the design that loses a commitment forever the first time a job is
 * dropped, and that doubles the schedule every time a sweep injects a recovery probe into a
 * chain that was not actually broken. So scheduling is stateless instead: a sweep runs on a
 * fixed cron, asks each open commitment "when were you last observed", and compares that
 * against the curve. Nothing to repair, nothing to deduplicate, and a worker that was down for
 * six hours catches up on its next tick rather than needing a backfill.
 *
 * The consequence, stated rather than hidden: the cadence is only as fine as the sweep tick.
 * `SWEEP_INTERVAL_MS` is the knob, and the deadline run is exempted from it — that job is
 * enqueued with `startAfter` equal to the remaining time, so it fires AT deadline+0 rather
 * than at the next tick after it. Being late to the authoritative run is the one lateness
 * that would change an outcome.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** How often the sweep looks. Also the granularity of every non-deadline probe. */
export const SWEEP_INTERVAL_MS = 5 * MINUTE_MS;

/** architecture.md §8: retry an unobservable target for an hour before giving up on it. */
export const GRACE_WINDOW_MS = 60 * MINUTE_MS;

/**
 * How often to re-attempt the authoritative run while the target is unobservable. Slower than
 * the sweep on purpose: a host that was down 10 seconds ago is unlikely to be up now, and
 * hammering it would be the bad-faith probing security.md T-07 is about.
 */
export const GRACE_RETRY_MS = 10 * MINUTE_MS;

/**
 * pg-boss orders by priority descending. architecture.md §8: a backlog must delay daily
 * probes, not deadline probes — so everything inside the final hour, and every authoritative
 * run, jumps the queue ahead of the routine sweep traffic.
 */
export const PRIORITY_ROUTINE = 0;
export const PRIORITY_DEADLINE = 100;

/** The final-hour band, exported because "is this urgent" is asked in more than one place. */
export const FINAL_HOUR_MS = HOUR_MS;

/**
 * The curve as data, coarsest band first: "while more than `remainingAboveMs` is left, probe
 * every `everyMs`".
 *
 * The 6h → 1h band is a bridge. roadmap.md names three bands (daily / hourly / five-minutely)
 * and technical-spec.md §5 names a boundary at T-6h without saying what happens between there
 * and T-1h; fifteen minutes is the interpolation, and it is a table entry precisely so that
 * changing it is a one-line change with a test that already covers the boundary.
 */
export const PROBE_CURVE: readonly {
  readonly remainingAboveMs: number;
  readonly everyMs: number;
}[] = [
  { remainingAboveMs: 72 * HOUR_MS, everyMs: DAY_MS },
  { remainingAboveMs: 6 * HOUR_MS, everyMs: HOUR_MS },
  { remainingAboveMs: FINAL_HOUR_MS, everyMs: 15 * MINUTE_MS },
  { remainingAboveMs: 0, everyMs: 5 * MINUTE_MS },
];

/**
 * Bands are half-open at the top: exactly 72h remaining is already in the hourly band, and
 * exactly one hour remaining is already in the final-hour band. "Daily UNTIL T-72h" is read
 * as ending at T-72h, not one interval later — the tighter reading is the one that cannot
 * cost someone an earlier `kept`.
 */
export function probeIntervalMs(remainingMs: number): number {
  for (const band of PROBE_CURVE) {
    if (remainingMs > band.remainingAboveMs) return band.everyMs;
  }
  // Past the deadline. Routine probing is over; the caller is in grace-window territory.
  return GRACE_RETRY_MS;
}

/** One open commitment, as the scheduler needs to see it. */
export interface ScheduleInput {
  readonly commitmentId: string;
  readonly deadline: Date;
  /** `max(ran_at)` over this commitment's probe runs, or null if it has never been probed. */
  readonly lastRanAt: Date | null;
}

export interface PlannedProbe {
  readonly commitmentId: string;
  /**
   * True only for the run at deadline+0 and its grace-window retries. An intermediate
   * observation that the condition is FALSE means nothing — a repo without its release at
   * T-48h is not a miss (technical-spec.md §6).
   */
  readonly authoritative: boolean;
  /** Delay before the job becomes available. Non-zero only for the deadline run. */
  readonly startAfterSeconds: number;
  readonly priority: number;
}

/**
 * What, if anything, to enqueue for one open commitment right now.
 *
 * Returns `undefined` when the curve says the last observation is still fresh. That is the
 * whole of the deduplication story: a sweep that fires twice, or two sweeps overlapping,
 * plan the same probe from the same rows and the second one is a no-op — no lock, no claimed
 * state, nothing to leak if the process dies between the two.
 */
export function planProbe(
  input: ScheduleInput,
  now: Date,
  sweepIntervalMs: number = SWEEP_INTERVAL_MS,
): PlannedProbe | undefined {
  const remainingMs = input.deadline.getTime() - now.getTime();
  const sinceLastMs =
    input.lastRanAt === null
      ? Number.POSITIVE_INFINITY
      : now.getTime() - input.lastRanAt.getTime();

  // The deadline is within reach of this tick — or has passed and the commitment is somehow
  // still open, which is the grace window. Either way the next run is the authoritative one.
  if (remainingMs <= sweepIntervalMs) {
    const observedSinceDeadline =
      input.lastRanAt !== null && input.lastRanAt.getTime() >= input.deadline.getTime();
    // The first authoritative run has not happened yet: schedule it FOR the deadline, not for
    // now, so `resolved_at` can be the deadline instant rather than a tick either side of it.
    if (!observedSinceDeadline) {
      return {
        commitmentId: input.commitmentId,
        authoritative: true,
        startAfterSeconds: Math.max(0, remainingMs) / 1000,
        priority: PRIORITY_DEADLINE,
      };
    }
    // It did happen, and the commitment is still open — so it came back `error` and we are
    // inside the grace window (a `pass` or a `fail` would have resolved it). Re-attempt on
    // the grace cadence until an attempt lands outside the window and finalises `disputed`.
    if (sinceLastMs < GRACE_RETRY_MS) return undefined;
    return {
      commitmentId: input.commitmentId,
      authoritative: true,
      startAfterSeconds: 0,
      priority: PRIORITY_DEADLINE,
    };
  }

  if (sinceLastMs < probeIntervalMs(remainingMs)) return undefined;

  return {
    commitmentId: input.commitmentId,
    authoritative: false,
    startAfterSeconds: 0,
    priority: remainingMs <= FINAL_HOUR_MS ? PRIORITY_DEADLINE : PRIORITY_ROUTINE,
  };
}

/**
 * Has the grace window closed? Separated from `planProbe` because the probe handler asks it
 * about a run it has just made, and the scheduler asks it about a run it is about to plan.
 */
export function graceExpired(deadline: Date, now: Date): boolean {
  return now.getTime() >= deadline.getTime() + GRACE_WINDOW_MS;
}
