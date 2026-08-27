/**
 * Public reads for the witness layer. Reads only — every witness write goes through
 * ./witness.ts, which is the only file that opens a transaction against these tables.
 *
 * ONLY ATTESTED WITNESSES ARE PUBLIC, and the distinction is not cosmetic:
 *
 *   · An *attestation* is a public act. security.md T-02 makes the witness's identity public
 *     and permanent on purpose — that is the mitigation that makes an accountless vouch
 *     tolerable at all, because it makes a careless one cost the voucher something.
 *   · An *invitation* is not. It is an address the committer typed into a form. The invited
 *     person may never click, and ADR-0006 says plainly that non-response is the common case
 *     and is not a failure. Publishing the address of someone who did nothing would expose a
 *     third party for a decision they never made.
 *
 * So the invitation list is private and the attestation list is public. Do not "improve" this
 * into a roster of everyone who was asked.
 */
import { desc, eq } from "drizzle-orm";
import { account, commitment, doneSpec, getDb, witness, witnessAttestation } from "@pledge/db";
import type { CommitmentStatus, StoredDoneSpec } from "@pledge/db/types";
import type { WitnessVerdict } from "@pledge/ledger";

export interface PublicAttestation {
  readonly attestationId: string;
  readonly witnessId: string;
  /**
   * The identity the vouch is attached to. Rendered in full and never masked: an unmaskable
   * name is the entire point (security.md T-02), and `r****n@example.com` would keep the PII
   * exposure while throwing away the attributability it is exposed for.
   */
  readonly email: string;
  readonly verdict: WitnessVerdict;
  readonly note: string | null;
  readonly signedAt: Date;
  /** The chain entry this attestation is recorded in. Shown so it can be looked up. */
  readonly ledgerSeq: number;
}

/** Attestations on one commitment, newest first. Empty is the normal case. */
export async function listAttestations(
  commitmentId: string,
): Promise<readonly PublicAttestation[]> {
  const rows = await getDb()
    .select({
      attestationId: witnessAttestation.id,
      witnessId: witness.id,
      email: witness.email,
      verdict: witnessAttestation.verdict,
      note: witnessAttestation.note,
      signedAt: witnessAttestation.signedAt,
      ledgerSeq: witnessAttestation.ledgerSeq,
    })
    .from(witnessAttestation)
    .innerJoin(witness, eq(witness.id, witnessAttestation.witnessId))
    .where(eq(witness.commitmentId, commitmentId))
    .orderBy(desc(witnessAttestation.signedAt));

  return rows;
}

export interface WitnessLinkState {
  readonly witnessId: string;
  readonly email: string;
  readonly commitmentId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  /** Enough of the commitment to decide honestly, including the criterion (security.md T-04). */
  readonly claim: string;
  readonly spec: StoredDoneSpec;
  readonly deadline: Date;
  readonly status: CommitmentStatus;
  readonly handle: string;
  /** Present once this witness has attested. */
  readonly attestation:
    | {
        readonly verdict: WitnessVerdict;
        readonly note: string | null;
        readonly signedAt: Date;
      }
    | undefined;
}

/**
 * What `/w/<token>` needs to render, keyed on the hash of the presented token.
 *
 * Keyed on the hash and not on the id: the caller has already verified the token's signature,
 * but keying on the stored hash means a bug in id extraction finds nothing rather than finding
 * somebody else's invitation.
 *
 * Deliberately not filtered on `visibility`. A witness holds a signed, scoped, single-use link
 * to this one commitment, which is the committer's explicit decision to show it to them; the
 * public-page filter in lib/queries.ts answers a different question.
 */
export async function getWitnessByTokenHash(
  tokenHash: string,
): Promise<WitnessLinkState | undefined> {
  const [row] = await getDb()
    .select({
      witnessId: witness.id,
      email: witness.email,
      commitmentId: witness.commitmentId,
      expiresAt: witness.expiresAt,
      usedAt: witness.usedAt,
      claim: commitment.claim,
      deadline: commitment.deadline,
      status: commitment.status,
      spec: doneSpec.ast,
      handle: account.handle,
      verdict: witnessAttestation.verdict,
      note: witnessAttestation.note,
      signedAt: witnessAttestation.signedAt,
    })
    .from(witness)
    .innerJoin(commitment, eq(commitment.id, witness.commitmentId))
    .innerJoin(account, eq(account.id, commitment.accountId))
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .leftJoin(witnessAttestation, eq(witnessAttestation.witnessId, witness.id))
    .where(eq(witness.tokenHash, tokenHash))
    .limit(1);

  if (row === undefined) return undefined;

  return {
    witnessId: row.witnessId,
    email: row.email,
    commitmentId: row.commitmentId,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
    claim: row.claim,
    spec: row.spec,
    deadline: row.deadline,
    status: row.status,
    handle: row.handle,
    attestation:
      row.verdict === null || row.signedAt === null
        ? undefined
        : { verdict: row.verdict, note: row.note, signedAt: row.signedAt },
  };
}

/**
 * Everyone who should hear about an outcome on this commitment, with their link re-derived.
 *
 * Used by the resolution notifier (./notify.ts). Expired links are excluded — mailing a link
 * that cannot work is worse than not mailing — and so are spent ones, which get an outcome
 * notice with no call to action.
 */
export interface WitnessContact {
  readonly witnessId: string;
  readonly email: string;
  readonly expiresAt: Date;
  readonly hasAttested: boolean;
}

export async function listWitnessContacts(
  commitmentId: string,
): Promise<readonly WitnessContact[]> {
  const rows = await getDb()
    .select({
      witnessId: witness.id,
      email: witness.email,
      expiresAt: witness.expiresAt,
      usedAt: witness.usedAt,
    })
    .from(witness)
    .where(eq(witness.commitmentId, commitmentId));

  return rows.map((row) => ({
    witnessId: row.witnessId,
    email: row.email,
    expiresAt: row.expiresAt,
    hasAttested: row.usedAt !== null,
  }));
}
