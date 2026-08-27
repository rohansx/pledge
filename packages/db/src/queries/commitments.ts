/**
 * Web-tier reads and the one write it is allowed to make: creating an `open` commitment.
 *
 * Nothing in this file can produce a resolution. `insertCommitment` takes no status argument
 * and no `resolvedAt`, so there is no shape of call that reaches `kept` or `missed` — the
 * build-time grep (scripts/check-invariants.mjs) is the enforcement, this is just not
 * handing anyone the gun.
 */
import { and, desc, eq } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { appendLedgerEntry } from "./ledger";
import { account, commitment, doneSpec, type CommitmentRow } from "../schema";
import { SPEC_VERSION_V0, type StoredDoneSpec } from "../types";

export interface NewCommitment {
  readonly accountId: string;
  readonly claim: string;
  /**
   * The validated spec and its hash. Both come from the one thing allowed to produce them for
   * that era — `hashDoneSpec()` for v0, `compile()` in @pledge/spec for v1 — never hand-built.
   */
  readonly spec: StoredDoneSpec;
  readonly doneSpecHash: string;
  /**
   * Which era the spec belongs to, written into the row AND into the `commitment_created`
   * payload from the same variable. Defaults to v0 so every existing caller keeps its meaning.
   *
   * Two values, one source: a v1 AST stored under `spec_version = 0` would be handed to the v0
   * evaluator forever, and the permanent record would claim a promise nobody made.
   */
  readonly specVersion?: number;
  /** UTC instant. Resolve the committer's local end-of-day before calling (CLAUDE.md I-9). */
  readonly deadline: Date;
  readonly estimatedDays?: number;
}

/**
 * Inserts the done-spec (shared across users, so conflicts are expected and ignored), the
 * commitment, and the `commitment_created` ledger entry — in ONE transaction.
 *
 * The ledger append is not optional and not deferrable (CLAUDE.md I-3): if it fails, the
 * commitment fails with it. A commitment that exists without a ledger entry is a record with
 * no provenance, which is the one thing this product cannot ship.
 *
 * `committed_at` and the entry's `created_at` are both left to the column default — Postgres
 * `now()` inside this transaction, never an application clock (CLAUDE.md I-8).
 *
 * Takes a `DbOrTx`, not a `Db`, so a caller that needs one more write in the SAME transaction
 * — apps/web has to enqueue the first probe job there (architecture.md §6.1) — can hand its
 * own `tx` in and get a savepoint. This is the one writer for a new commitment: a caller that
 * re-implements the insert + ledger append to get that is a second copy of I-3 and I-4 that
 * will drift.
 */
export async function insertCommitment(
  db: DbOrTx,
  input: NewCommitment,
): Promise<CommitmentRow> {
  const specVersion = input.specVersion ?? SPEC_VERSION_V0;
  return db.transaction(async (tx) => {
    await tx
      .insert(doneSpec)
      .values({ hash: input.doneSpecHash, ast: input.spec, specVersion })
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

    await appendLedgerEntry(tx, {
      accountId: row.accountId,
      entryType: "commitment_created",
      payload: {
        commitmentId: row.id,
        claim: row.claim,
        doneSpecHash: row.doneSpecHash,
        specVersion,
        // The ORIGINAL deadline. Every later move is an `amended` entry; this value is what
        // makes "moved twice and landed on time" reconstructible from the chain alone.
        deadline: row.deadline.toISOString(),
        visibility: row.visibility,
      },
    });

    return row;
  });
}

export interface CommitmentWithSpec {
  readonly commitment: CommitmentRow;
  readonly spec: StoredDoneSpec;
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
