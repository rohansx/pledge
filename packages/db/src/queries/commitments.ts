/**
 * Web-tier reads and the one write it is allowed to make: creating an `open` commitment.
 *
 * Nothing in this file can produce a resolution. `insertCommitment` takes no status argument
 * and no `resolvedAt`, so there is no shape of call that reaches `kept` or `missed` — the
 * build-time grep (scripts/check-invariants.mjs) is the enforcement, this is just not
 * handing anyone the gun.
 */
import { and, desc, eq } from "drizzle-orm";
import type { Db, DbOrTx } from "../client";
import { account, commitment, doneSpec, type CommitmentRow } from "../schema";
import { SPEC_VERSION_V0, type DoneSpecV0 } from "../types";

export interface NewCommitment {
  readonly accountId: string;
  readonly claim: string;
  /** Validated spec and its hash — both from `hashDoneSpec()`, never hand-built. */
  readonly spec: DoneSpecV0;
  readonly doneSpecHash: string;
  /** UTC instant. Resolve the committer's local end-of-day before calling (CLAUDE.md I-9). */
  readonly deadline: Date;
  readonly estimatedDays?: number;
}

/**
 * Inserts the done-spec (shared across users, so conflicts are expected and ignored) and the
 * commitment in one transaction.
 *
 * `committed_at` is left to the column default — Postgres `now()` inside this transaction,
 * never an application clock (CLAUDE.md I-8).
 */
export async function insertCommitment(db: Db, input: NewCommitment): Promise<CommitmentRow> {
  return db.transaction(async (tx) => {
    await tx
      .insert(doneSpec)
      .values({ hash: input.doneSpecHash, ast: input.spec, specVersion: SPEC_VERSION_V0 })
      // Immutable and content-addressed: an existing row with this hash is already exactly
      // this spec. Updating it would be a contradiction, not an optimisation (I-4).
      .onConflictDoNothing();

    const [row] = await tx
      .insert(commitment)
      .values({
        accountId: input.accountId,
        claim: input.claim,
        doneSpecHash: input.doneSpecHash,
        deadline: input.deadline,
        estimatedDays: input.estimatedDays?.toString(),
      })
      .returning();
    if (row === undefined) throw new Error("insertCommitment returned no row");
    return row;
  });
}

export interface CommitmentWithSpec {
  readonly commitment: CommitmentRow;
  readonly spec: DoneSpecV0;
}

/** The public profile at /[handle]. Unlisted and private commitments are not public. */
export async function listPublicCommitments(
  db: DbOrTx,
  handle: string,
): Promise<readonly CommitmentWithSpec[]> {
  const rows = await db
    .select({ commitment, spec: doneSpec.ast })
    .from(commitment)
    .innerJoin(account, eq(account.id, commitment.accountId))
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(and(eq(account.handle, handle), eq(commitment.visibility, "public")))
    .orderBy(desc(commitment.committedAt));

  return rows.map((r) => ({ commitment: r.commitment, spec: r.spec }));
}

export async function getCommitmentWithSpec(
  db: DbOrTx,
  id: string,
): Promise<CommitmentWithSpec | undefined> {
  const [row] = await db
    .select({ commitment, spec: doneSpec.ast })
    .from(commitment)
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(eq(commitment.id, id))
    .limit(1);

  return row === undefined ? undefined : { commitment: row.commitment, spec: row.spec };
}
