/**
 * Recording an amendment: a deadline move, or a withdrawal.
 *
 * Server only. This is the second write the web tier is allowed to make, and the only one
 * that changes an existing commitment.
 *
 * INVARIANT I-1 — read this before adding a branch. The only status this file writes is
 * `abandoned`, which architecture.md §6.3 lists as the amendment handler's one permitted
 * outcome. `kept` and `missed` come from the probe worker and nowhere else;
 * scripts/check-invariants.mjs fails the build if that stops being true. If you are here to
 * let someone mark their own commitment done, the product does not have that.
 *
 * INVARIANT I-3 — the ledger append and the state change share one transaction. If the
 * append throws, the deadline move rolls back with it. `appendLedgerEntry` only accepts a
 * transaction handle, so "append it afterwards" is not a shape this code could express even
 * by accident.
 *
 * INVARIANT I-4 — nothing here touches `done_spec_hash`. An amendment moves when a
 * commitment resolves; it never changes what was promised. Editing the spec is a different
 * hash and therefore a different commitment, which is a new row, not an update.
 *
 * INVARIANT I-8 — no timestamps are passed in. `amendment.created_at` and
 * `ledger_entry.created_at` are both Postgres `now()` inside this transaction.
 *
 * NOTHING IS DELETED AND NOTHING IS EDITED IN PLACE. `commitment.deadline` holds the current
 * value for query convenience; the `amendment` table holds the authoritative history, and the
 * timeline renders it. A commitment whose deadline moved twice and landed on time is a
 * materially different signal from one that never moved, and hiding that would make pledge
 * exactly the thing it criticises (architecture.md §5.1).
 */
import { amendment, appendLedgerEntry, commitment, getDb } from "@pledge/db";
import type { AmendmentRow, CommitmentRow } from "@pledge/db";
import { and, eq } from "drizzle-orm";
import type { AmendmentInput } from "./amendment-input";

/**
 * Why an amendment was refused. Each maps to a distinct HTTP status in the route handler —
 * "not yours" and "already resolved" are different facts and collapsing them would make the
 * form unable to say anything useful.
 */
export type AmendmentRefusal =
  | "not_found"
  | "not_owner"
  /** Terminal commitments are not amendable. Moving a deadline after a miss is revisionism. */
  | "not_open"
  /** A "move" to the deadline it already has: a ledger entry recording no change. */
  | "deadline_unchanged";

export type AmendmentResult =
  | { readonly ok: true; readonly amendmentId: string; readonly ledgerSeq: number; readonly deadline: Date }
  | { readonly ok: false; readonly refusal: AmendmentRefusal };

export interface RecordAmendmentArgs {
  readonly commitmentId: string;
  /** The signed-in account. Ownership is checked against the row, inside the transaction. */
  readonly accountId: string;
  readonly input: AmendmentInput;
  /**
   * For a deadline move: the already-resolved UTC instant, from `endOfDayInZone`. Resolved by
   * the caller so this module never has to know about time zones, and so an amended deadline
   * goes through exactly the same arithmetic as the original one (CLAUDE.md I-9).
   */
  readonly newDeadline?: Date;
}

export async function recordAmendment(args: RecordAmendmentArgs): Promise<AmendmentResult> {
  const { commitmentId, accountId, input } = args;

  // Generated here rather than left to the column default: the ledger payload names the
  // amendment, so the id has to exist before the append. An id is not a clock reading — I-8
  // is about timestamps, and there is none here.
  const amendmentId = crypto.randomUUID();

  return getDb().transaction(async (tx) => {
    // FOR UPDATE: two withdrawals racing must not both append. The loser re-reads a row that
    // is no longer `open` and is refused.
    const [row] = await tx
      .select()
      .from(commitment)
      .where(eq(commitment.id, commitmentId))
      .for("update")
      .limit(1);

    const refusal = refuse(row, accountId, input, args.newDeadline);
    if (refusal !== undefined) return { ok: false, refusal } as const;
    // `refuse` returns a reason for every falsy row, so the row exists past this point.
    const current = row as CommitmentRow;

    const { kind } = input;
    const deadline = kind === "deadline_moved" ? (args.newDeadline as Date) : current.deadline;

    if (kind === "deadline_moved") {
      await tx
        .update(commitment)
        .set({ deadline })
        // The status predicate is belt and braces next to FOR UPDATE, and it is free: it
        // also means a row that somehow left `open` between the read and the write updates
        // zero rows rather than silently moving a resolved commitment's deadline.
        .where(and(eq(commitment.id, commitmentId), eq(commitment.status, "open")));
    } else {
      await tx
        .update(commitment)
        // The one resolution status apps/web may write (architecture.md §6.3). `resolved_at`
        // stays null: a withdrawal is not an observation, and the
        // `commitment_status_transitions_are_earned` CHECK admits exactly this shape.
        .set({ status: "abandoned" })
        .where(and(eq(commitment.id, commitmentId), eq(commitment.status, "open")));
    }

    // Before the amendment insert, because `amendment.ledger_seq` references the entry. Same
    // transaction either way — the ordering is a foreign key, not a durability strategy.
    const append = await appendLedgerEntry(tx, {
      accountId: current.accountId,
      entryType: "amended",
      payload: {
        commitmentId,
        amendmentId,
        kind,
        // A withdrawal moves no value; a deadline move records both ends so the original is
        // reconstructible from the chain alone, without reading `commitment`.
        oldValue: kind === "deadline_moved" ? current.deadline.toISOString() : null,
        newValue: kind === "deadline_moved" ? deadline.toISOString() : null,
        reason: input.reason,
      },
    });

    await tx.insert(amendment).values({
      id: amendmentId,
      commitmentId,
      kind,
      oldValue: kind === "deadline_moved" ? current.deadline.toISOString() : null,
      newValue: kind === "deadline_moved" ? deadline.toISOString() : null,
      reason: input.reason,
      ledgerSeq: append.seq,
      // createdAt: deliberately absent — Postgres now(), inside this transaction (I-8).
    });

    return { ok: true, amendmentId, ledgerSeq: append.seq, deadline } as const;
  });
}

/** Every reason to refuse, in one place, so the transaction body reads as the happy path. */
function refuse(
  row: CommitmentRow | undefined,
  accountId: string,
  input: AmendmentInput,
  newDeadline: Date | undefined,
): AmendmentRefusal | undefined {
  if (row === undefined) return "not_found";
  if (row.accountId !== accountId) return "not_owner";
  if (row.status !== "open") return "not_open";
  if (input.kind === "deadline_moved") {
    if (newDeadline === undefined) return "deadline_unchanged";
    if (newDeadline.getTime() === row.deadline.getTime()) return "deadline_unchanged";
  }
  return undefined;
}

/**
 * The amendment history for one commitment, oldest first — the order it is rendered in, and
 * the order that makes "moved twice" legible.
 */
export function originalDeadline(
  current: Date,
  amendments: readonly AmendmentRow[],
): Date {
  // The first recorded move's `old_value` IS the original deadline: amendments are
  // append-only, so the earliest one carries the value nothing had yet overwritten.
  for (const row of amendments) {
    if (row.kind === "deadline_moved" && typeof row.oldValue === "string") {
      return new Date(row.oldValue);
    }
  }
  return current;
}

/** True when this commitment's deadline is not the one it was made with. */
export function deadlineWasMoved(amendments: readonly AmendmentRow[]): boolean {
  return amendments.some((row) => row.kind === "deadline_moved");
}
