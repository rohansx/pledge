/**
 * What each kind of ledger entry says.
 *
 * These schemas are a CONTRACT, not an implementation detail. A payload is hashed, chained,
 * and eventually signed and handed to a third party who verifies it without talking to us
 * (docs/spec/receipt-format.md). Adding a field to one of these changes the bytes that hash,
 * so old entries and new entries stop being comparable — which is fine, because each entry
 * carries its own hash, but it means a *rename* is a format break and must be treated as one.
 *
 * Three rules that all of these obey:
 *
 * 1. **No clock readings from application code.** Every timestamp here is a domain value —
 *    a deadline the user chose, the instant a probe observed a target — never "now". The
 *    ledger's own time is `ledger_entry.created_at`, written by Postgres `now()` inside the
 *    transaction (CLAUDE.md I-8), and it is deliberately not in the payload.
 * 2. **No PII.** The ledger is served publicly at `/v1/accounts/:handle/ledger`. Emails,
 *    magic-link tokens and session data never enter a payload. `witness_attested` carries a
 *    `witnessId`, not an address.
 * 3. **Strict objects.** An unknown key would be silently hashed into the permanent record.
 *    Better to fail the append.
 *
 * This module is browser-safe on purpose: the composer previews what it is about to commit,
 * and the verifier CLI has no database.
 */
import { z } from "zod";

/** docs/technical-spec.md §3. The complete set; there is no `other`. */
export const ledgerEntryTypes = [
  "commitment_created",
  "probe_result",
  "amended",
  "resolved",
  "witness_attested",
] as const;
export const LedgerEntryTypeSchema = z.enum(ledgerEntryTypes);
export type LedgerEntryType = (typeof ledgerEntryTypes)[number];

/** RFC 3339 in UTC with a literal `Z` — receipt-format §2.1 requires exactly this. */
const isoUtc = z.iso.datetime();

/** Lowercase hex sha256, the shape every hash takes in this codebase. */
const hashHex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A commitment was made. The first entry in any commitment's story.
 *
 * `doneSpecHash` is the load-bearing field: it pins *what done means* at the moment of
 * committing, so a later spec edit is provably a different commitment (CLAUDE.md I-4).
 */
export const CommitmentCreatedPayloadSchema = z.strictObject({
  commitmentId: z.uuid(),
  // No handle. `ledger_entry.account_id` already carries the link, and a handle is mutable —
  // GitHub renames happen — so hashing one would freeze a name that later stops being true
  // while claiming to be part of an immutable record.
  claim: z.string().min(1).max(2000),
  doneSpecHash: hashHex,
  specVersion: z.int().min(0),
  /** The ORIGINAL deadline. Later moves are `amended` entries; this one never changes. */
  deadline: isoUtc,
  visibility: z.enum(["public", "unlisted", "private"]),
});

/**
 * One observation. Not a conclusion — a `probe_result` with outcome `fail` is a record that
 * the condition was observed false at that instant, and on its own it resolves nothing
 * (CLAUDE.md I-7, docs/technical-spec.md §6).
 *
 * The evidence is committed to by hash rather than inlined: it can be a few kB of headers and
 * match text per run, and the ledger is walked in full by the verification script. The full
 * evidence lives in `probe_run.evidence`; `payloadSha256(evidence)` from ./chain is what
 * produces this field, and re-running it over the stored row is how a reader checks that the
 * evidence was not edited after the fact.
 */
export const ProbeResultPayloadSchema = z.strictObject({
  commitmentId: z.uuid(),
  probeRunId: z.uuid(),
  probeKind: z.string().min(1).max(64),
  outcome: z.enum(["pass", "fail", "error"]),
  /** When the target was OBSERVED. Never "when we wrote this down" (copy rule, CLAUDE.md). */
  ranAt: isoUtc,
  evidenceSha256: hashHex,
});

/**
 * A deadline moved, or the commitment was withdrawn. `reason` is required by the product,
 * not merely by the schema: a deadline that moves without a stated reason is exactly the
 * silent revision the ledger exists to prevent, and it is rendered in the timeline.
 */
export const amendmentKinds = ["deadline_moved", "abandoned"] as const;
export type AmendmentKind = (typeof amendmentKinds)[number];

export const AmendedPayloadSchema = z.strictObject({
  commitmentId: z.uuid(),
  amendmentId: z.uuid(),
  kind: z.enum(amendmentKinds),
  /** ISO instant for a deadline move, `null` for an abandonment. */
  oldValue: z.union([isoUtc, z.null()]),
  newValue: z.union([isoUtc, z.null()]),
  reason: z.string().min(1).max(2000),
});

/**
 * The commitment left `open`. Terminal.
 *
 * `resolvedBy` is constrained against `status` below, and the constraint is the no-self-report
 * invariant written down in one more place: **nothing but a probe can produce `kept` or
 * `missed`** (docs/architecture.md §6.3, ADR-0006, receipt-format §2.1). A witness reaches
 * `disputed` and nothing else; a withdrawal reaches `abandoned` and nothing else. An append
 * that claims otherwise fails validation and takes its transaction down with it.
 */
export const ResolvedPayloadSchema = z
  .strictObject({
    commitmentId: z.uuid(),
    status: z.enum(["kept", "missed", "abandoned", "disputed"]),
    /** For `kept`: the EARLIEST passing observation, not when the worker noticed (§6.2). */
    resolvedAt: isoUtc,
    resolvedBy: z.enum(["probe", "witness", "withdrawal"]),
    /** The run that produced the resolution. Absent for withdrawals and witness disputes. */
    probeRunId: z.uuid().optional(),
  })
  .superRefine((payload, ctx) => {
    const allowed: Record<string, readonly string[]> = {
      kept: ["probe"],
      missed: ["probe"],
      abandoned: ["withdrawal"],
      disputed: ["probe", "witness"],
    };
    if (!allowed[payload.status]?.includes(payload.resolvedBy)) {
      ctx.addIssue({
        code: "custom",
        path: ["resolvedBy"],
        message: `status '${payload.status}' cannot be resolved by '${payload.resolvedBy}'`,
      });
    }
  });

/**
 * A witness attested. Recorded whether or not it changes the outcome, because an attestation
 * that agrees with the probe is still part of the public record — and the witness's identity
 * is public and permanent, which is the only thing that makes a careless vouch cost anything
 * (docs/security.md T-02).
 *
 * `witnessId` and not an email: this payload is served publicly.
 */
export const witnessVerdicts = ["confirms", "disputes"] as const;
export type WitnessVerdict = (typeof witnessVerdicts)[number];

export const WitnessAttestedPayloadSchema = z.strictObject({
  commitmentId: z.uuid(),
  witnessId: z.uuid(),
  attestationId: z.uuid(),
  verdict: z.enum(witnessVerdicts),
  note: z.union([z.string().max(2000), z.null()]),
});

export type CommitmentCreatedPayload = z.infer<typeof CommitmentCreatedPayloadSchema>;
export type ProbeResultPayload = z.infer<typeof ProbeResultPayloadSchema>;
export type AmendedPayload = z.infer<typeof AmendedPayloadSchema>;
export type ResolvedPayload = z.infer<typeof ResolvedPayloadSchema>;
export type WitnessAttestedPayload = z.infer<typeof WitnessAttestedPayloadSchema>;

/**
 * The append API's input, as a discriminated union: picking an `entryType` picks the payload
 * type. A caller cannot pass a `probe_result` payload under `entry_type = 'resolved'` and
 * find out at runtime.
 */
export type LedgerEntryInput =
  | { readonly entryType: "commitment_created"; readonly payload: CommitmentCreatedPayload }
  | { readonly entryType: "probe_result"; readonly payload: ProbeResultPayload }
  | { readonly entryType: "amended"; readonly payload: AmendedPayload }
  | { readonly entryType: "resolved"; readonly payload: ResolvedPayload }
  | { readonly entryType: "witness_attested"; readonly payload: WitnessAttestedPayload };

/** Runtime half of the union above. Used by the append helper and the verification walk. */
export const LEDGER_PAYLOAD_SCHEMAS = {
  commitment_created: CommitmentCreatedPayloadSchema,
  probe_result: ProbeResultPayloadSchema,
  amended: AmendedPayloadSchema,
  resolved: ResolvedPayloadSchema,
  witness_attested: WitnessAttestedPayloadSchema,
} as const satisfies Record<LedgerEntryType, z.ZodType>;

/**
 * Validates a payload against its entry type. Throws `ZodError` on a mismatch.
 *
 * Called on the way in (so a malformed payload never becomes a permanent record) and again
 * by the verification walk (so a payload that was valid at write time and has since been
 * edited to something invalid is caught even before its hash is recomputed).
 */
export function parseLedgerPayload(entryType: LedgerEntryType, payload: unknown): unknown {
  return LEDGER_PAYLOAD_SCHEMAS[entryType].parse(payload);
}
