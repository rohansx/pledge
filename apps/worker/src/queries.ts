/**
 * The one query the worker needs that @pledge/db does not already export.
 *
 * Selects exactly the columns `pledge_probe` is granted on `commitment` (id, done_spec_hash,
 * deadline, status, committed_at) — asking for one more is a runtime permission error, which
 * is the point of the column-level grant (architecture.md §4).
 */
import { commitment, doneSpec, type Db, type DueCommitment } from "@pledge/db";
import { DoneSpecV0Schema } from "@pledge/db/types";
import { and, eq } from "drizzle-orm";

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
): Promise<DueCommitment | undefined> {
  const [row] = await db
    .select({
      id: commitment.id,
      doneSpecHash: commitment.doneSpecHash,
      deadline: commitment.deadline,
      committedAt: commitment.committedAt,
      status: commitment.status,
      spec: doneSpec.ast,
    })
    .from(commitment)
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(and(eq(commitment.id, commitmentId), eq(commitment.status, "open")))
    .limit(1);

  return row === undefined ? undefined : { ...row, spec: DoneSpecV0Schema.parse(row.spec) };
}
