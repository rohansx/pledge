/**
 * The queries the worker needs that @pledge/db does not already export.
 *
 * Every select here asks for exactly the columns `pledge_probe` is granted — asking for one
 * more is a runtime permission error, which is the point of the column-level grant
 * (architecture.md §4). In particular nothing here can reach `account`: the worker must not be
 * able to learn who anyone is.
 */
import { commitment, doneSpec, probeRun, type Db } from "@pledge/db";
import { DoneSpecV0Schema, type DoneSpecV0 } from "@pledge/db/types";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import type { ScheduleInput } from "./schedule";

/**
 * A commitment as the probe path sees it.
 *
 * `spec` is a discriminated union on `specVersion` because `spec_version` pins evaluation
 * semantics permanently (done-spec-dsl.md §8): a v0 spec always evaluates under v0 rules, and
 * the v1 evaluator is never asked to interpret one. There is no migration and there never
 * will be — an old row keeps meaning what it meant.
 */
export type ProbeTarget = {
  readonly id: string;
  readonly doneSpecHash: string;
  readonly deadline: Date;
  readonly committedAt: Date;
  readonly baselineDigest: string | null;
} & (
  | { readonly specVersion: 0; readonly spec: DoneSpecV0 }
  /**
   * Deliberately `unknown`. A v1 AST is validated by @pledge/spec's own schema at the point
   * of use (./spec-probe.ts), not here: this module is data access, and "what shapes are a
   * legal done-spec" is the language's question, asked once, by the package that answers it.
   * Parsing it in two places is how the parser and the evaluator drift apart.
   */
  | { readonly specVersion: 1; readonly spec: unknown }
);

/**
 * Re-reads the commitment as of *now*, rather than trusting the job payload.
 *
 * Returns undefined when it is no longer `open`: a deadline job that fires after an earlier
 * probe already resolved it has nothing left to observe, and probing anyway would be a request
 * to someone's server for no reason (security.md T-07).
 *
 * The stored spec is Zod-parsed even though we wrote it: `done_spec.ast` is jsonb holding
 * user-authored content, and the worker is the tier that must not trust its inputs.
 */
export async function loadOpenCommitment(
  db: Db,
  commitmentId: string,
): Promise<ProbeTarget | undefined> {
  const [row] = await db
    .select({
      id: commitment.id,
      doneSpecHash: commitment.doneSpecHash,
      deadline: commitment.deadline,
      committedAt: commitment.committedAt,
      baselineDigest: commitment.baselineSha256,
      specVersion: doneSpec.specVersion,
      ast: doneSpec.ast,
    })
    .from(commitment)
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(and(eq(commitment.id, commitmentId), eq(commitment.status, "open")))
    .limit(1);

  if (row === undefined) return undefined;
  const { specVersion, ast, ...rest } = row;

  if (specVersion === 0) return { ...rest, specVersion: 0, spec: DoneSpecV0Schema.parse(ast) };
  if (specVersion === 1) return { ...rest, specVersion: 1, spec: ast };
  // A spec_version this build does not implement is not something to guess at. Throwing fails
  // the job and leaves the commitment `open`, which is the only safe direction.
  throw new Error(
    `commitment ${commitmentId} has spec_version ${specVersion}, which this worker cannot evaluate`,
  );
}

/**
 * Every open commitment with the instant it was last observed, which is all the backoff curve
 * needs (see ./schedule.ts for why scheduling is stateless).
 *
 * `max(ran_at)` over a LEFT JOIN rather than a correlated sub-select so one query answers for
 * the whole population; at the design volume this is a sub-millisecond index scan on
 * `probe_run_commitment_ran_idx`.
 */
export async function listDueCommitments(
  db: Db,
  limit = 1000,
): Promise<readonly ScheduleInput[]> {
  const rows = await db
    .select({
      commitmentId: commitment.id,
      deadline: commitment.deadline,
      lastRanAt: max(probeRun.ranAt),
    })
    .from(commitment)
    .leftJoin(probeRun, eq(probeRun.commitmentId, commitment.id))
    .where(eq(commitment.status, "open"))
    .groupBy(commitment.id, commitment.deadline)
    .orderBy(commitment.deadline)
    .limit(limit);

  return rows.map((row) => ({ ...row, lastRanAt: row.lastRanAt ?? null }));
}

/**
 * Stores the baseline digest, once.
 *
 * `WHERE baseline_sha256 IS NULL` is what makes this safe to call from every probe run: the
 * first observation of a commitment wins and every later one is a no-op. A baseline that could
 * be overwritten would let a target that changed after the promise become the thing later runs
 * are compared against, which silently disables the novelty check (done-spec-dsl.md §6.3).
 *
 * `baseline_captured_at` is Postgres `now()`, never an application clock (CLAUDE.md I-8).
 *
 * Returns the digest now in force — this run's, or the one that was already there.
 */
export async function captureBaseline(
  db: Db,
  commitmentId: string,
  digest: string,
): Promise<string | null> {
  const [updated] = await db
    .update(commitment)
    .set({ baselineSha256: digest, baselineCapturedAt: sql`now()` })
    .where(and(eq(commitment.id, commitmentId), isNull(commitment.baselineSha256)))
    .returning({ baselineSha256: commitment.baselineSha256 });

  if (updated !== undefined) return updated.baselineSha256;

  const [existing] = await db
    .select({ baselineSha256: commitment.baselineSha256 })
    .from(commitment)
    .where(eq(commitment.id, commitmentId))
    .limit(1);
  return existing?.baselineSha256 ?? null;
}
