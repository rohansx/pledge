/**
 * The receipt document, as a schema — docs/spec/receipt-format.md §2, §3, §7.
 *
 * This file is the trust boundary. Everything downstream of `ReceiptSchema.parse` is a
 * receipt; everything upstream is a stranger's JSON file. Fail closed (§4.1): an unknown
 * `format`, an unknown `alg`, a malformed hash or an unrecognised `status` is a rejection,
 * not a warning, and that is expressed here by the schema refusing to produce a value at all.
 *
 * §7's two rules about unknown fields, and how they are implemented:
 *
 *   · outside the signed subset — MUST ignore. The top level is `looseObject`, so a later
 *     additive v1 revision (a new sibling of `anchor`, say) does not break this verifier.
 *   · inside it — MUST reject. Every object the subset covers is `strictObject`, so a field
 *     smuggled in beside `claim` is a rejection rather than something a reader might mistake
 *     for signed data. The two exceptions are written down rather than tolerated:
 *     `outcome.censored` (§6) and `ledger.audit_path` / `ledger.checkpoint` (§2, §4.2) are
 *     specified by the format itself and are deliberately outside the signature.
 *
 * EVERY SUBSET FIELD IS REQUIRED, though many are nullable. That is not pedantry: JCS has no
 * representation for `undefined`, so an absent field and a null one would have to canonicalise
 * to the same bytes or to different ones, and either choice makes two documents that a reader
 * cannot tell apart hash differently. Requiring the key removes the question.
 */
import { z } from "zod";
import type { JsonValue } from "@pledge/ledger";

/** §2. Exact string match — a verifier MUST reject unknown values rather than guessing. */
export const RECEIPT_FORMAT = "pledge.receipt.v1";

/**
 * §3: `signed_bytes = "pledge.receipt.v1\x00" || JCS(subset)`.
 *
 * The domain-separation prefix is the format string itself, which is what stops a signature
 * over a ledger payload (`pledge.ledger.v1`) being replayed as a signature over a receipt.
 */
export const RECEIPT_SIGNING_CONTEXT = RECEIPT_FORMAT;

/** §2.1: all hashes are `<alg>:<lowercase-hex>`. sha256 is the only algorithm in v1. */
export const HASH_REF = /^sha256:[0-9a-f]{64}$/;
const hashRef = z.string().regex(HASH_REF, "expected sha256:<64 lowercase hex>");

/**
 * §2.1: RFC 3339 in UTC with a literal `Z`. An offset like `+05:30` is rejected rather than
 * normalised — the receipt is hashed as text, so a verifier that accepted both forms would
 * accept two different byte strings for one instant (CLAUDE.md I-9: store UTC, render local).
 */
const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/, "expected RFC 3339 UTC with a literal Z")
  .refine((value) => !Number.isNaN(Date.parse(value)), "not a real instant");

const finite = z.number().refine((n) => Number.isFinite(n), "must be a finite number");

/** §2.1 constrains the pairing with `status`; that check lives in ./verify.ts. */
export const resolvedByValues = ["probe", "witness", "withdrawal"] as const;
export const receiptStatuses = ["kept", "missed", "abandoned", "disputed"] as const;

export const CommitmentSchema = z.strictObject({
  id: z.string().min(1),
  handle: z.string().min(1),
  claim: z.string().min(1),
  committed_at: isoUtc,
  /** The deadline as first committed. §2.1: a consumer showing only one MUST show this one. */
  deadline_original: isoUtc,
  deadline_effective: isoUtc,
  visibility: z.enum(["public", "unlisted", "private"]),
  /** Cohorts are deferred; the field is in the signed subset, so it is present and null. */
  cohort_slug: z.string().min(1).nullable(),
});

export const DoneSpecSchema = z.strictObject({
  /** Pins evaluation semantics. `hash` is over spec_version N's canonical form, not over `source`. */
  spec_version: z.int().min(0),
  hash: hashRef,
  /** The criterion, in full. §1: never render an outcome without this within one click. */
  source: z.string().min(1),
  probe_class: z.enum(["trivial", "weak", "standard", "strong"]),
});

export const OutcomeSchema = z.strictObject({
  status: z.enum(receiptStatuses),
  resolved_at: isoUtc,
  resolved_by: z.enum(resolvedByValues),
  days_estimated: finite.nullable(),
  /** §6: `null` means the completion was never observed — right-censored, NOT zero. */
  days_actual: finite.nullable(),
  slip_ratio: finite.nullable(),
  unchanged_since_commitment: z.boolean(),
  /**
   * §6, and outside the signed subset because it is derived from `status` + `days_actual`.
   * ./verify.ts rejects a receipt where it disagrees with what it is derived from: a field
   * that exists to stop a skimming implementer from treating a censored null as a zero is
   * worse than useless if it can lie.
   */
  censored: z.boolean().optional(),
});

export const AmendmentSchema = z.strictObject({
  kind: z.enum(["deadline_moved", "abandoned"]),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  /** Required by the product, not merely by the schema: a silent revision is the thing pledge exists to prevent. */
  reason: z.string().min(1),
  created_at: isoUtc,
  ledger_seq: z.int().min(1),
});

/**
 * §2 shows match objects; this implementation's v0 evidence records the matched values as
 * strings. Both are accepted because both are what the field means — the verifier hashes it,
 * it does not interpret it — and neither shape is open-ended.
 */
const MatchSchema = z.union([
  z.string(),
  z.strictObject({ op: z.string().min(1), pattern: z.string(), value: z.string() }),
]);

export const EvidenceSchema = z.strictObject({
  /** Which target was observed, e.g. `github:release:owner/name`. */
  source: z.string().min(1),
  /** When the target was OBSERVED. Never when the record was written (CLAUDE.md copy rule). */
  observed_at: isoUtc,
  /** The IP the request was pinned to — the SSRF audit trail. Null when nothing was observed. */
  resolved_ip: z.string().nullable(),
  status: z.int().min(100).max(599).nullable(),
  headers: z.record(z.string(), z.string()),
  body_sha256: hashRef.nullable(),
  body_bytes: z.int().min(0).nullable(),
  matches: z.array(MatchSchema),
});

export const AttestationSchema = z.strictObject({
  /** An opaque witness id. Never an email: receipts are public (ADR-0006, security.md T-02). */
  witness_ref: z.string().min(1),
  verdict: z.enum(["confirms", "disputes"]),
  note: z.string().nullable(),
  signed_at: isoUtc,
  ledger_seq: z.int().min(1),
});

/**
 * The ledger entry this receipt is drawn from.
 *
 * `audit_path` and `checkpoint` are steps 3–5 material (v2, and ADR-0005 is Proposed). They
 * are typed loosely and NEVER interpreted here — this verifier states plainly that it did not
 * check them rather than parsing them into a shape that suggests it might have.
 */
export const LedgerSchema = z.strictObject({
  entry_seq: z.int().min(1),
  entry_hash: hashRef,
  prev_hash: hashRef,
  /** sha256(JCS(ledger payload)) — the entry's payload, not this receipt. See ./verify.ts. */
  payload_sha256: hashRef,
  audit_path: z.array(z.unknown()).optional(),
  checkpoint: z.unknown().optional(),
});

export const SignatureSchema = z.strictObject({
  /** Unknown alg is a rejection, not a warning (§4.1). */
  alg: z.literal("ed25519"),
  /** SPKI DER, standard base64 — `MCowBQYDK2VwAyEA…`. */
  public_key: z.string().min(1),
  key_id: hashRef,
  /** Unpadded base64url (§2.1). */
  value: z.string().min(1),
});

/**
 * Everything except the signature: the shape the builder assembles and the shape the subset is
 * extracted from. Loose at the top level, per §7.
 */
export const ReceiptBodySchema = z.looseObject({
  format: z.literal(RECEIPT_FORMAT),
  /** §2.1: informational, and MUST NOT be fetched during verification (§4.1). */
  issuer: z.string().optional(),
  commitment: CommitmentSchema,
  done_spec: DoneSpecSchema,
  outcome: OutcomeSchema,
  amendments: z.array(AmendmentSchema),
  evidence: z.array(EvidenceSchema),
  attestations: z.array(AttestationSchema),
  ledger: LedgerSchema,
  anchor: z.unknown().nullable(),
  anchor_pending: z.boolean().optional(),
  expected_anchor_by: isoUtc.optional(),
});

export const ReceiptSchema = ReceiptBodySchema.extend({ signature: SignatureSchema });

export type ReceiptBody = z.infer<typeof ReceiptBodySchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptOutcome = z.infer<typeof OutcomeSchema>;

/**
 * §3, normative. The exact subset the signature covers, in the exact shape.
 *
 * Fields are picked one at a time rather than spread. That is the whole point: a spread would
 * silently pull `outcome.censored` and `ledger.audit_path` into the signed bytes the day
 * someone adds them, and the receipts issued before that day would stop verifying with no
 * change to the format string. What is signed has to be a list, and this is the list.
 *
 * Array order is significant and is preserved verbatim: `evidence` in canonical AST source
 * order, `amendments` and `attestations` by ascending `ledger_seq`. This function does not
 * sort — re-sorting here would make a receipt whose arrays are out of order verify against
 * bytes that were never signed. ./verify.ts checks the ordering separately and rejects.
 */
export function signedSubset(body: ReceiptBody): JsonValue {
  const { commitment, done_spec, outcome, ledger } = body;
  return {
    commitment: {
      id: commitment.id,
      handle: commitment.handle,
      claim: commitment.claim,
      committed_at: commitment.committed_at,
      deadline_original: commitment.deadline_original,
      deadline_effective: commitment.deadline_effective,
      visibility: commitment.visibility,
      cohort_slug: commitment.cohort_slug,
    },
    done_spec: {
      spec_version: done_spec.spec_version,
      hash: done_spec.hash,
      source: done_spec.source,
      probe_class: done_spec.probe_class,
    },
    outcome: {
      status: outcome.status,
      resolved_at: outcome.resolved_at,
      resolved_by: outcome.resolved_by,
      days_estimated: outcome.days_estimated,
      days_actual: outcome.days_actual,
      slip_ratio: outcome.slip_ratio,
      unchanged_since_commitment: outcome.unchanged_since_commitment,
    },
    amendments: body.amendments.map((a) => ({
      kind: a.kind,
      old_value: a.old_value,
      new_value: a.new_value,
      reason: a.reason,
      created_at: a.created_at,
      ledger_seq: a.ledger_seq,
    })),
    evidence: body.evidence.map((e) => ({
      source: e.source,
      observed_at: e.observed_at,
      resolved_ip: e.resolved_ip,
      status: e.status,
      headers: e.headers,
      body_sha256: e.body_sha256,
      body_bytes: e.body_bytes,
      matches: e.matches,
    })),
    attestations: body.attestations.map((a) => ({
      witness_ref: a.witness_ref,
      verdict: a.verdict,
      note: a.note,
      signed_at: a.signed_at,
      ledger_seq: a.ledger_seq,
    })),
    ledger: {
      entry_seq: ledger.entry_seq,
      entry_hash: ledger.entry_hash,
      prev_hash: ledger.prev_hash,
      payload_sha256: ledger.payload_sha256,
    },
  };
}
