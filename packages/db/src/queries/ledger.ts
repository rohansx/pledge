/**
 * The one way to write to the ledger, and the one way to read it back for verification.
 *
 * THREE INVARIANTS LIVE IN THIS FILE. Read them before changing anything here.
 *
 * I-3 — same transaction. `appendLedgerEntry` accepts a `LedgerTx` and nothing else. A
 *   `Db` is not assignable to it (drizzle's transaction type carries `rollback()`, a pool
 *   does not), so `appendLedgerEntry(db, …)` does not compile. That is deliberate: it makes
 *   "record it afterwards" a shape the API cannot express, rather than a rule in a document.
 *   If the append throws, the caller's transaction rolls back and the state change goes with
 *   it. There is no eventually-consistent ledger.
 *
 * I-8 — Postgres time. There is no `createdAt` field on the input type. The column default is
 *   `now()`, evaluated inside the transaction. An application clock here would let a skewed
 *   worker backdate the permanent record.
 *
 * ADR-0003 — one global chain. Every append takes `SELECT … FROM chain_head FOR UPDATE`,
 *   which serialises appends across the whole system. That is a known throughput ceiling
 *   (~ms of lock hold, three orders of magnitude of headroom at design volume) accepted in
 *   exchange for deleting every ordering bug a per-account chain would introduce. The
 *   scaling trigger is in architecture.md §12; do not pre-shard.
 */
import { asc, sql } from "drizzle-orm";
import {
  computeEntry,
  FIRST_SEQ,
  GENESIS_PREV_HASH,
  parseLedgerPayload,
  verifyChain,
  type ChainBreak,
  type JsonValue,
  type LedgerEntryInput,
  type StoredEntry,
} from "@pledge/ledger";
import type { Db, DbOrTx } from "../client";
import { chainHead, ledgerEntry } from "../schema";

/**
 * An open transaction. Not a pool.
 *
 * Exported because callers writing their own `db.transaction(async (tx) => …)` need to name
 * the handle they are threading through their helpers.
 */
export type LedgerTx = Exclude<DbOrTx, Db>;

/** What the caller learns about the entry it just appended. */
export interface LedgerAppend {
  readonly seq: number;
  readonly entryHash: string;
  readonly payloadSha256: string;
  readonly prevHash: string;
  /** Postgres `now()` from inside this transaction. */
  readonly createdAt: Date;
}

/**
 * Appends one entry to the global chain, inside the caller's transaction.
 *
 * The sequence of operations is not negotiable:
 *
 *   1. lock `chain_head` (FOR UPDATE) — serialises every concurrent append
 *   2. seq  = head.seq + 1, prev = head.entry_hash
 *   3. hash the payload, then the entry
 *   4. INSERT the entry
 *   5. UPDATE `chain_head` to point at it
 *
 * Step 1 before step 2 is what makes `seq` gapless. A `bigserial` would allocate outside the
 * transaction and burn a value on rollback, and a gap is indistinguishable from a deleted
 * entry — which is precisely the tampering the chain exists to expose (security.md T-03).
 *
 * The payload is validated against the schema for its `entry_type` before it is hashed. A
 * malformed payload therefore fails the transaction rather than becoming a permanent,
 * immutable, wrong record.
 */
export async function appendLedgerEntry(
  tx: LedgerTx,
  input: LedgerEntryInput & { readonly accountId: string },
): Promise<LedgerAppend> {
  const { accountId, entryType } = input;

  // Zod first: cheapest failure, and it happens before we take the global lock.
  const payload = parseLedgerPayload(entryType, input.payload) as JsonValue;

  // FOR UPDATE on the single row. Concurrent appends queue here, in arrival order, and each
  // one sees the previous one's committed head.
  const head = await tx
    .select({ seq: chainHead.seq, entryHash: chainHead.entryHash })
    .from(chainHead)
    .for("update")
    .limit(1);

  const current = head[0];
  if (current === undefined) {
    // The migration seeds row 1. Its absence means the chain has no origin, and inventing one
    // here would silently start a second chain whose first entry claims a prev_hash nobody
    // can check.
    throw new Error("chain_head row is missing — migration 0001 seeds it; do not create it here");
  }

  const computed = computeEntry({
    seq: current.seq + 1,
    prevHash: current.entryHash,
    payload,
  });

  const [inserted] = await tx
    .insert(ledgerEntry)
    .values({
      seq: computed.seq,
      accountId,
      entryType,
      payload,
      payloadSha256: computed.payloadSha256,
      prevHash: computed.prevHash,
      entryHash: computed.entryHash,
      // createdAt: deliberately absent — Postgres now(), inside this transaction (I-8).
    })
    .returning({ createdAt: ledgerEntry.createdAt });
  if (inserted === undefined) throw new Error("appendLedgerEntry inserted no ledger_entry row");

  await tx
    .update(chainHead)
    .set({ seq: computed.seq, entryHash: computed.entryHash, updatedAt: sql`now()` })
    .where(sql`${chainHead.id} = 1`);

  return {
    seq: computed.seq,
    entryHash: computed.entryHash,
    payloadSha256: computed.payloadSha256,
    prevHash: computed.prevHash,
    createdAt: inserted.createdAt,
  };
}

export interface ChainVerification {
  readonly entryCount: number;
  readonly breaks: readonly ChainBreak[];
  /** True when `chain_head` still points at the last entry. */
  readonly headMatches: boolean;
  readonly headSeq: number;
  readonly headHash: string;
}

/**
 * Walks the whole chain from genesis and recomputes every hash.
 *
 * Streamed in batches rather than one `SELECT *`: this runs in CI against a seeded database
 * today and against production later, and a walk that only works while the log fits in memory
 * is a walk that stops being run at exactly the point it starts mattering.
 *
 * Reads with any handle — verification is a read, and unlike the append it has no reason to
 * refuse a pool.
 */
export async function verifyLedgerChain(
  db: DbOrTx,
  batchSize = 1000,
): Promise<ChainVerification> {
  const breaks: ChainBreak[] = [];
  let entryCount = 0;
  let lastHash = GENESIS_PREV_HASH;
  let lastSeq = FIRST_SEQ - 1;

  for (;;) {
    const rows = await db
      .select({
        seq: ledgerEntry.seq,
        entryType: ledgerEntry.entryType,
        payload: ledgerEntry.payload,
        payloadSha256: ledgerEntry.payloadSha256,
        prevHash: ledgerEntry.prevHash,
        entryHash: ledgerEntry.entryHash,
      })
      .from(ledgerEntry)
      .where(sql`${ledgerEntry.seq} > ${lastSeq}`)
      .orderBy(asc(ledgerEntry.seq))
      .limit(batchSize);

    if (rows.length === 0) break;

    const batch: StoredEntry[] = rows.map((row) => ({
      seq: row.seq,
      payload: row.payload as JsonValue,
      payloadSha256: row.payloadSha256,
      prevHash: row.prevHash,
      entryHash: row.entryHash,
    }));

    // The previous page's tail seeds this one, so a break across a page boundary is found by
    // exactly the same code as a break inside a page.
    breaks.push(...verifyChain(batch, { seq: lastSeq + 1, prevHash: lastHash }));

    // `entry_type` is NOT part of the hash — the formula covers prev, payload and seq only —
    // so swapping a `probe_result` to `resolved` would leave the chain folding perfectly.
    // Re-validating the payload against its declared type closes that: the five payload
    // shapes are distinct enough that a swapped type fails its schema.
    for (const row of rows) {
      try {
        parseLedgerPayload(row.entryType, row.payload);
      } catch (error: unknown) {
        breaks.push({
          seq: row.seq,
          kind: "payload_schema_mismatch",
          expected: row.entryType,
          actual: error instanceof Error ? error.message.slice(0, 200) : "invalid payload",
        });
      }
    }

    entryCount += batch.length;
    const tail = batch[batch.length - 1];
    if (tail === undefined) break;
    lastSeq = tail.seq;
    lastHash = tail.entryHash;
  }

  const [head] = await db
    .select({ seq: chainHead.seq, entryHash: chainHead.entryHash })
    .from(chainHead)
    .limit(1);
  if (head === undefined) throw new Error("chain_head row is missing");

  return {
    entryCount,
    breaks,
    headMatches: head.seq === lastSeq && head.entryHash === lastHash,
    headSeq: head.seq,
    headHash: head.entryHash,
  };
}
