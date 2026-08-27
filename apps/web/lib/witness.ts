/**
 * The witness handlers: invite, and attest.
 *
 * THE CONSTRAINT THAT DEFINES THIS FILE (ADR-0006, security.md T-02, architecture.md §6.3):
 *
 *     A WITNESS ATTESTATION CAN NEVER PRODUCE `kept`.
 *
 * Only a probe produces `kept`. A witness whose verdict contradicts the probe's outcome
 * produces `disputed` — a terminal, publicly-rendered display state, not a workflow and not
 * something an operator quietly clears. That is what keeps the no-self-report invariant intact
 * once a human is in the loop: the worst thing an intercepted or colluding link can do is make
 * an outcome *visibly contested*, never manufacture a success.
 *
 * If you are here to add a path where a witness marks something done, the product does not
 * have one, and scripts/check-invariants.mjs will fail the build if you write it anyway.
 *
 * What a `disputed` outcome does NOT mean: that pledge adjudicated anything. Both records stay
 * visible, the probe evidence stays visible, and the witness's identity stays attached to their
 * verdict forever — which is the only thing that makes a careless vouch cost the voucher
 * something (security.md T-02).
 *
 * INVARIANT I-3 — every state change here appends its ledger entry inside the same
 * transaction, via `appendLedgerEntry`, which only accepts a transaction handle. If the append
 * fails, the attestation fails with it.
 *
 * INVARIANT I-8 — no timestamp in this file is read from the application clock and written to
 * the database. `signed_at`, `used_at` and `ledger_entry.created_at` are all Postgres `now()`.
 * `expires_at` is the one computed value, and it is a future domain deadline rather than a
 * record of when something happened.
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appendLedgerEntry, commitment, getDb, witness, witnessAttestation } from "@pledge/db";
import type { CommitmentStatus } from "@pledge/db/types";
import type { WitnessVerdict } from "@pledge/ledger";
import { MAX_WITNESSES_PER_COMMITMENT } from "./witness-input";
import { mintWitnessToken, WITNESS_LINK_TTL_MS } from "./witness-token";

// ---------------------------------------------------------------------------------------
// Invite
// ---------------------------------------------------------------------------------------

export interface WitnessInvitation {
  readonly witnessId: string;
  readonly email: string;
  /** The magic-link token. Mail it; never log it, never store it. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface InviteWitnessesInput {
  readonly commitmentId: string;
  /** Must already be the session account's own commitment — checked by the caller. */
  readonly accountId: string;
  readonly emails: readonly string[];
}

/**
 * Creates invitation rows and returns the links to mail.
 *
 * Not a ledger event, deliberately: `ledger_entry_type` has no `witness_invited` member, and
 * adding one would put an invitation — a private act, involving an email address the committer
 * typed — into a payload served publicly at `/v1/accounts/:handle/ledger`. The *attestation* is
 * the public fact; the invitation is not.
 *
 * Already-invited addresses are skipped rather than re-invited, so a double-submitted composer
 * cannot mail the same person twice or burn their outstanding link.
 */
export async function inviteWitnesses(
  input: InviteWitnessesInput,
): Promise<readonly WitnessInvitation[]> {
  const db = getDb();

  const existing = await db
    .select({ email: witness.email })
    .from(witness)
    .where(eq(witness.commitmentId, input.commitmentId));

  const already = new Set(existing.map((row) => row.email.toLowerCase()));
  const fresh = input.emails
    .map((email) => email.trim())
    .filter((email) => email.length > 0 && !already.has(email.toLowerCase()));

  if (fresh.length === 0) return [];
  if (already.size + fresh.length > MAX_WITNESSES_PER_COMMITMENT) {
    throw new TooManyWitnessesError(MAX_WITNESSES_PER_COMMITMENT);
  }

  const expiresAt = new Date(Date.now() + WITNESS_LINK_TTL_MS);

  // The id is generated here rather than by `defaultRandom()` because the token signs the
  // row's own id, and the row's `token_hash` is that token's hash. Letting the database pick
  // the id would mean inserting first and updating the hash afterwards — a window in which the
  // row exists with a `token_hash` nothing hashes to.
  return db.transaction(async (tx) => {
    const invitations: WitnessInvitation[] = [];

    for (const email of fresh) {
      const id = randomUUID();
      const minted = mintWitnessToken(id, expiresAt);
      await tx.insert(witness).values({
        id,
        commitmentId: input.commitmentId,
        email,
        tokenHash: minted.tokenHash,
        expiresAt: minted.expiresAt,
        // Dispatched, not delivered. Mail is fire-and-forget by design (architecture.md §8):
        // nothing in the notification path may affect a record.
        notifiedAt: sql`now()`,
      });
      invitations.push({
        witnessId: id,
        email,
        token: minted.token,
        expiresAt: minted.expiresAt,
      });
    }

    return invitations;
  });
}

export class TooManyWitnessesError extends Error {
  constructor(readonly limit: number) {
    super(`a commitment may have at most ${limit} witnesses`);
    this.name = "TooManyWitnessesError";
  }
}

// ---------------------------------------------------------------------------------------
// Attest
// ---------------------------------------------------------------------------------------

/**
 * `disputes` contradicts a `kept`; `confirms` contradicts a `missed`. Anything else is
 * agreement, or an outcome there is nothing yet to contradict.
 *
 * Note what is NOT here. `open` is not a contradiction: there is no probe outcome yet, so an
 * early verdict is recorded and changes nothing. `abandoned` and `disputed` are terminal and
 * were not produced by a probe, so there is no observation to contradict either.
 *
 * And note the asymmetry that is not an asymmetry: `confirms` on a `missed` does not make the
 * commitment kept. It cannot. It makes it *contested*, which is a strictly weaker claim and
 * the only one an accountless link is allowed to reach.
 */
export function contradictsProbe(status: CommitmentStatus, verdict: WitnessVerdict): boolean {
  return (
    (status === "kept" && verdict === "disputes") ||
    (status === "missed" && verdict === "confirms")
  );
}

export type AttestRefusal = "unknown" | "expired" | "used";

export type AttestResult =
  | {
      readonly ok: true;
      readonly commitmentId: string;
      readonly verdict: WitnessVerdict;
      /** True when this attestation moved the commitment to `disputed`. */
      readonly contested: boolean;
    }
  | { readonly ok: false; readonly reason: AttestRefusal };

export interface AttestInput {
  /** sha256 of the presented token — from `parseWitnessToken`, never from the request body. */
  readonly tokenHash: string;
  readonly verdict: WitnessVerdict;
  readonly note: string | null;
}

/**
 * Records one attestation, and — only on a contradiction — moves the commitment to `disputed`.
 *
 * One transaction, in this order:
 *
 *   1. lock the witness row and its commitment (FOR UPDATE)
 *   2. refuse an unknown, expired or already-spent link
 *   3. append `witness_attested`
 *   4. insert `witness_attestation` pointing at that entry
 *   5. on a contradiction: append `resolved` (resolvedBy: 'witness') and set `disputed`
 *   6. spend the link
 *
 * Step 1 is what makes "cannot attest twice" a property rather than a race: two clicks on the
 * same link serialise on the row lock, and the second one reads `used_at` set by the first.
 * The unique index on `witness_attestation.witness_id` is the belt to that braces — if this
 * ordering is ever broken, the database still refuses the second row.
 */
export async function recordAttestation(input: AttestInput): Promise<AttestResult> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx
      .select({
        witnessId: witness.id,
        usedAt: witness.usedAt,
        expiresAt: witness.expiresAt,
        commitmentId: commitment.id,
        accountId: commitment.accountId,
        status: commitment.status,
        resolvedAt: commitment.resolvedAt,
        // Postgres time, not the app's: the expiry decision and the row it is about are read
        // in one snapshot.
        now: sql<Date>`now()`,
      })
      .from(witness)
      .innerJoin(commitment, eq(commitment.id, witness.commitmentId))
      .where(eq(witness.tokenHash, input.tokenHash))
      .for("update", { of: witness })
      .limit(1);

    if (row === undefined) return { ok: false, reason: "unknown" };
    if (row.usedAt !== null) return { ok: false, reason: "used" };
    if (row.expiresAt.getTime() <= new Date(row.now).getTime()) {
      return { ok: false, reason: "expired" };
    }

    // Generated here because `witness_attestation.ledger_seq` is NOT NULL and the ledger entry
    // has to name the attestation: one of the two ids must exist before either row does.
    const attestationId = randomUUID();

    const attested = await appendLedgerEntry(tx, {
      accountId: row.accountId,
      entryType: "witness_attested",
      payload: {
        commitmentId: row.commitmentId,
        // The id, never the address. This payload is served publicly (payloads.ts rule 2).
        witnessId: row.witnessId,
        attestationId,
        verdict: input.verdict,
        note: input.note,
      },
    });

    await tx.insert(witnessAttestation).values({
      id: attestationId,
      witnessId: row.witnessId,
      verdict: input.verdict,
      note: input.note,
      ledgerSeq: attested.seq,
      // signed_at: column default, Postgres now() (I-8).
    });

    const contested = contradictsProbe(row.status, input.verdict);
    if (contested) {
      if (row.resolvedAt === null) {
        // Unreachable: `commitment_status_transitions_are_earned` forbids a resolved status
        // with no `resolved_at`. Loud rather than silently inventing a clock reading.
        throw new Error(`commitment ${row.commitmentId} is ${row.status} with no resolved_at`);
      }

      await appendLedgerEntry(tx, {
        accountId: row.accountId,
        entryType: "resolved",
        payload: {
          commitmentId: row.commitmentId,
          status: "disputed",
          // The instant the commitment was RESOLVED, which a dispute does not change — the
          // probe observed what it observed, at the time it observed it. When the dispute was
          // raised is `witness_attestation.signed_at` and `ledger_entry.created_at`, both
          // Postgres now().
          resolvedAt: row.resolvedAt.toISOString(),
          resolvedBy: "witness",
        },
      });

      // The ONLY status literal this file writes. `kept` and `missed` are the probe worker's
      // alone (I-1), and `disputed` is the ceiling an accountless caller can reach (ADR-0006).
      await tx
        .update(commitment)
        .set({ status: "disputed" })
        .where(eq(commitment.id, row.commitmentId));
    }

    // Single-use, spent last: if anything above threw, the link is still good and the witness
    // can click again rather than losing their one chance to a transient error.
    await tx
      .update(witness)
      .set({ usedAt: sql`now()` })
      .where(and(eq(witness.id, row.witnessId), isNull(witness.usedAt)));

    return { ok: true, commitmentId: row.commitmentId, verdict: input.verdict, contested };
  });
}
