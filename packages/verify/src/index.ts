/**
 * pledge-verify — the reference verifier for `pledge.receipt.v1`
 * (docs/spec/receipt-format.md §8).
 *
 * Importable as a library as well as a CLI, because the receipt BUILDER uses it: @pledge/db
 * assembles a receipt, calls `signedSubset` from here to get the bytes to sign, and validates
 * its own output against `ReceiptSchema` before signing it. One implementation of "what is
 * signed", two consumers — the same argument that keeps `computeEntry` in @pledge/ledger
 * rather than one copy in the writer and another in the verifier. A builder with its own idea
 * of the signed subset would produce receipts that only its own verifier accepts, and the
 * failure would surface in a stranger's terminal.
 *
 * The dependency runs one way and must stay that way: this package knows nothing about
 * @pledge/db, Postgres, or any credential. It imports @pledge/ledger for JCS, the chain
 * formula and ed25519 — that package has no database import and no environment read on the
 * verification path.
 *
 * SCOPE: steps 1-2 of the five in §4. Steps 3-5 (audit path, transparency log, signed tree
 * head) are v2; ADR-0005 is Proposed, not accepted, and nothing here assumes an outcome.
 */
export {
  HASH_REF,
  RECEIPT_FORMAT,
  RECEIPT_SIGNING_CONTEXT,
  ReceiptBodySchema,
  ReceiptSchema,
  receiptStatuses,
  resolvedByValues,
  signedSubset,
  type Receipt,
  type ReceiptBody,
  type ReceiptOutcome,
} from "./receipt.ts";

export { verifyReceipt, type KeyTrust, type StepOutcome, type StepReport, type VerifyOptions, type VerifyResult } from "./verify.ts";

export { formatReport } from "./report.ts";
