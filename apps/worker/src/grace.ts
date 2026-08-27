/**
 * The `error`-at-the-deadline rule (architecture.md §8, technical-spec.md §6), as a pure
 * function.
 *
 *   not authoritative        → never finalises. A pass still resolves; nothing else does.
 *   authoritative + pass     → kept.
 *   authoritative + fail     → missed. This is an OBSERVATION that the condition is false.
 *   authoritative + error    → do not resolve, until the grace window has closed. Then
 *                              `disputed` with reason `target_unreachable_at_deadline`.
 *                              NEVER `missed`. We did not see the target; saying someone
 *                              missed because their host was down is the bug this whole
 *                              product cannot afford (CLAUDE.md I-7).
 *
 * There is no retry bookkeeping here and no retry state on the job. `graceUntil` is a pure
 * function of the deadline, so a re-attempt needs to carry nothing forward — the sweep
 * re-enqueues an authoritative run on the grace cadence and each one recomputes the same
 * window. State that a crash could lose is state this decision does not have.
 */
import { GRACE_WINDOW_MS } from "./schedule";
import type { ProbeResult } from "@pledge/db/types";

/**
 * Recorded in the finalising run's evidence message. There is no `dispute_reason` column, and
 * the reason must survive somewhere a human can read it — the alternative is a `disputed`
 * commitment with no stated cause, which is worse than a slightly stringy field.
 */
export const UNREACHABLE_AT_DEADLINE = "target_unreachable_at_deadline";

export interface GraceDecision {
  /** May this run resolve the commitment on a non-pass outcome? */
  readonly finalize: boolean;
  readonly graceUntil: Date;
}

export function decideGrace(input: {
  readonly authoritative: boolean;
  readonly outcome: ProbeResult["outcome"];
  readonly deadline: Date;
  readonly now: Date;
}): GraceDecision {
  const graceUntil = new Date(input.deadline.getTime() + GRACE_WINDOW_MS);
  if (!input.authoritative) return { finalize: false, graceUntil };
  if (input.outcome !== "error") return { finalize: true, graceUntil };
  return { finalize: input.now.getTime() >= graceUntil.getTime(), graceUntil };
}
