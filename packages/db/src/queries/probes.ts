/**
 * Worker-tier queries. Run these as `pledge_probe` (getProbeDb()), which cannot read
 * `account` at all — the worker must not be able to learn who anyone is (architecture.md §4).
 *
 * This file owns every write that resolves a commitment. It is the only place in the repo
 * that does.
 */
import { and, eq, sql } from "drizzle-orm";
import { payloadSha256 } from "@pledge/ledger";
import type { Db } from "../client";
import { appendLedgerEntry, type LedgerTx } from "./ledger";
import { commitment, probeRun } from "../schema";
import type { CommitmentStatus, ProbeResult } from "../types";

export interface RecordProbeRunInput {
  readonly commitmentId: string;
  readonly result: ProbeResult;
  /**
   * True only for the one authoritative run at deadline+0 (technical-spec §6). An
   * intermediate failing probe means nothing — a repo without its release at T-48h is not a
   * miss — so only an authoritative run may move a commitment out of `open` on anything
   * other than a pass.
   */
  readonly authoritative: boolean;
}

export interface RecordedProbeRun {
  readonly probeRunId: string;
  /** Status after this run. Unchanged unless `transitioned`. */
  readonly status: CommitmentStatus;
  readonly transitioned: boolean;
}

/**
 * `ran_at` comes from the worker (it is an observation time), so it is clamped into
 * [now() - 15 min, now()] by Postgres on the way in.
 *
 * This is not defensive dressing: `resolved_at` for a `kept` commitment is `min(ran_at)` over
 * passing runs, so an unclamped value would let a skewed — or hostile — worker clock backdate
 * a resolution to before the commitment existed.
 */
const clampedRanAt = (ranAt: Date) =>
  sql`greatest(least(${ranAt.toISOString()}::timestamptz, now()), now() - interval '15 minutes')`;

/**
 * Insert the observation and apply whatever transition it earns, in one transaction.
 *
 * The transition table (technical-spec §6, architecture.md §6.3):
 *
 *   pass, any run          → kept     (resolved_at = earliest passing ran_at)
 *   fail, authoritative    → missed   — an OBSERVATION that the condition is false
 *   error, authoritative   → disputed — the target could not be observed
 *   anything else          → no transition
 *
 * CLAUDE.md I-7 lives in that table: `error` never produces `missed`. A DNS failure at the
 * deadline is "we do not know", and marking someone as having missed because of a network
 * blip is the most reputation-destroying bug this product could ship. If you are editing this
 * function and find yourself merging the fail and error branches, stop.
 *
 * Idempotent under duplicate pg-boss delivery: the UPDATE is guarded by `status = 'open'`, so
 * a re-delivery inserts a second `probe_run` (harmless — it is an observation log) and
 * changes nothing else (architecture.md §6.2).
 */
export async function recordProbeRun(
  db: Db,
  input: RecordProbeRunInput,
): Promise<RecordedProbeRun> {
  const { commitmentId, result, authoritative } = input;

  return db.transaction(async (tx) => {
    const [run] = await tx
      .insert(probeRun)
      .values({
        commitmentId,
        probeKind: result.probeKind,
        outcome: result.outcome,
        evidence: result.evidence,
        durationMs: result.durationMs,
        ranAt: clampedRanAt(result.ranAt),
      })
      .returning({ id: probeRun.id, ranAt: probeRun.ranAt });
    if (run === undefined) throw new Error("recordProbeRun inserted no probe_run row");

    // Every observation is recorded on the chain, whether or not it resolves anything. A
    // ledger that only carried resolutions would let the passing run be the only one anyone
    // ever sees, and the honest history is that a target was checked and found wanting
    // fourteen times first.
    //
    // The evidence enters by hash: `probe_run.evidence` holds the full object, and
    // re-hashing that row is how a reader checks it was not edited afterwards.
    const accountId = await accountIdOf(tx, commitmentId);
    await appendLedgerEntry(tx, {
      accountId,
      entryType: "probe_result",
      payload: {
        commitmentId,
        probeRunId: run.id,
        probeKind: result.probeKind,
        outcome: result.outcome,
        // The CLAMPED ran_at that Postgres actually stored, not the worker's claim. A
        // skewed worker clock must not be able to put a different time on the chain from
        // the one in the observation log.
        ranAt: run.ranAt.toISOString(),
        // Round-tripped through JSON first: `ProbeEvidence` has optional keys, and an
        // explicit `key: undefined` would make canonicalJson refuse (it refuses rather than
        // silently dropping, so that two payloads cannot share one hash). This drops them
        // exactly the way jsonb serialisation does, so the hash covers what is stored.
        evidenceSha256: payloadSha256(JSON.parse(JSON.stringify(result.evidence))),
      },
    });

    const transition = nextStatus(result.outcome, authoritative);
    if (transition === undefined) {
      return {
        probeRunId: run.id,
        status: await currentStatus(tx, commitmentId),
        transitioned: false,
      };
    }

    const resolvedAt =
      transition === "kept"
        ? // The earliest passing observation, not the moment the worker noticed. Someone who
          // ships at 02:00 and is probed at 03:00 is credited at 02:00 if a probe ran then.
          // The sub-select sees the row inserted above: same transaction, later statement.
          sql`(select min(${probeRun.ranAt}) from ${probeRun} where ${probeRun.commitmentId} = ${commitmentId} and ${probeRun.outcome} = 'pass')`
        : run.ranAt;

    const [updated] = await tx
      .update(commitment)
      .set({ status: transition, resolvedAt })
      .where(and(eq(commitment.id, commitmentId), eq(commitment.status, "open")))
      .returning({ status: commitment.status, resolvedAt: commitment.resolvedAt });

    if (updated !== undefined) {
      if (updated.resolvedAt === null) {
        // Unreachable while the commitment_status_transitions_are_earned CHECK stands. If it
        // ever is reached, failing is right: an unresolvable timestamp must not be papered
        // over with `new Date()`, which is exactly the application clock I-8 forbids.
        throw new Error(`commitment ${commitmentId} resolved to ${transition} with no resolved_at`);
      }
      await appendLedgerEntry(tx, {
        accountId: await accountIdOf(tx, commitmentId),
        entryType: "resolved",
        payload: {
          commitmentId,
          status: transition,
          resolvedAt: updated.resolvedAt.toISOString(),
          // Always "probe" here. This function is the probe path; a witness dispute and a
          // withdrawal are written by their own handlers and say so themselves. The payload
          // schema rejects any other pairing with kept/missed (ADR-0006).
          resolvedBy: "probe",
          probeRunId: run.id,
        },
      });
    }

    return updated === undefined
      ? // Lost the race to another delivery, or already resolved. Not an error.
        {
          probeRunId: run.id,
          status: await currentStatus(tx, commitmentId),
          transitioned: false,
        }
      : { probeRunId: run.id, status: updated.status, transitioned: true };
  });
}

/** The transition table above, as code. Deliberately total and deliberately boring. */
function nextStatus(
  outcome: ProbeResult["outcome"],
  authoritative: boolean,
): "kept" | "missed" | "disputed" | undefined {
  if (outcome === "pass") return "kept";
  if (!authoritative) return undefined;
  // Only reachable at deadline+0. `fail` is an observation that the condition is false;
  // `error` is the absence of an observation. They are not the same event.
  return outcome === "fail" ? "missed" : "disputed";
}

/**
 * `ledger_entry.account_id` is NOT NULL, so the worker has to read it. Migration 0001 grants
 * `pledge_probe` SELECT on exactly this one extra column — an opaque UUID that the worker
 * cannot resolve to a person, because it holds no privilege at all on `account`.
 */
async function accountIdOf(tx: LedgerTx, commitmentId: string): Promise<string> {
  const [row] = await tx
    .select({ accountId: commitment.accountId })
    .from(commitment)
    .where(eq(commitment.id, commitmentId))
    .limit(1);
  if (row === undefined) throw new Error(`commitment ${commitmentId} not found`);
  return row.accountId;
}

async function currentStatus(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  commitmentId: string,
): Promise<CommitmentStatus> {
  const [row] = await tx
    .select({ status: commitment.status })
    .from(commitment)
    .where(eq(commitment.id, commitmentId))
    .limit(1);
  if (row === undefined) throw new Error(`commitment ${commitmentId} not found`);
  return row.status;
}
