/**
 * The verification algorithm — docs/spec/receipt-format.md §4, steps 1–2 only.
 *
 * THE THREE NON-NEGOTIABLES (§4.1), and where each one lives:
 *
 *   · Never contact the issuer. There is no network import in this package, and no code path
 *     reads `receipt.issuer` for anything but display. A verifier that phones home has
 *     recreated the trust dependency the format exists to remove; that is the whole point of
 *     the artifact, so the absence of a fetch here is load-bearing, not incidental.
 *   · Fail closed. Every check below produces a rejection, never a warning. ./receipt.ts
 *     rejects an unknown `format`, an unknown `alg`, a malformed hash or an unrecognised
 *     `status` before this file sees the document at all.
 *   · Report each step separately. This returns a per-step report, never one boolean. A
 *     signed-but-unanchored receipt and a fully anchored one are genuinely different claims
 *     and a single "VERIFIED" would erase the difference.
 *
 * STEPS 3–5 ARE NOT IMPLEMENTED, deliberately (roadmap v1: "steps 1–2 only. Inclusion proofs
 * land in v2"). They are reported as `not_performed` — never as passed, never omitted.
 * ADR-0005 (Rekor anchoring) is PROPOSED, not accepted, so this package assumes no outcome.
 *
 * ---------------------------------------------------------------------------------------
 * A KNOWN DEFECT IN THE SPEC, AND WHAT THIS IMPLEMENTATION DOES ABOUT IT
 * ---------------------------------------------------------------------------------------
 * §4.2 step 1 says: "Extract the subset from §3, serialise with JCS, prefix, sha256. Compare
 * to `ledger.payload_sha256`." That cannot be implemented as written, because §3 puts
 * `ledger.payload_sha256` INSIDE the signed subset: a hash of the subset can never equal a
 * field of the subset it hashes. One of the two sections has to give.
 *
 * §3 wins, because it is the normative one and because the alternative reading is worse:
 * `ledger.payload_sha256` is the hash of the LEDGER ENTRY's payload — the same value stored
 * in `ledger_entry.payload_sha256` and folded into `entry_hash` — which is what makes the
 * receipt point at a specific position in a specific chain, cross-checkable against the public
 * per-account ledger. Redefining it as a digest of the receipt would sever that link.
 *
 * So step 1 here is "the canonical form recomputes and the ledger triple folds":
 *
 *   1a. Rebuild the §3 subset, canonicalise it with RFC 8785 JCS, prefix it with
 *       `"pledge.receipt.v1\x00"`, sha256 it. This is the exact byte string step 2 verifies a
 *       signature over, and its digest is reported so two parties can compare receipts without
 *       comparing files.
 *   1b. Recompute `entry_hash = sha256(prev_hash || payload_sha256 || u64le(entry_seq))` with
 *       @pledge/ledger's own formula and compare. This is the only redundancy inside a receipt
 *       — the only thing it can be internally inconsistent about — and it catches an issuer
 *       that signed a malformed ledger reference.
 *
 * Be honest about the consequence: in an UNANCHORED receipt every signed field is covered by
 * step 2, so step 1 cannot fail where step 2 succeeds except in case 1b. That is a property of
 * a self-contained artifact, not a weakness of this implementation — it is exactly why steps
 * 3–5 exist, and exactly why this verifier says "signed but not independently timestamped"
 * rather than "verified".
 */
import { createHash } from "node:crypto";
import { entryHashFrom, signedBytes, verifySignature, type JsonValue } from "@pledge/ledger";
import {
  RECEIPT_SIGNING_CONTEXT,
  ReceiptSchema,
  signedSubset,
  type Receipt,
  type ReceiptBody,
} from "./receipt.ts";

export type StepOutcome = "ok" | "failed" | "not_performed";

export interface StepReport {
  readonly step: 1 | 2 | 3 | 4 | 5;
  readonly title: string;
  readonly outcome: StepOutcome;
  /** Lines printed under the step. Facts about what was checked, never a conclusion. */
  readonly detail: readonly string[];
}

/**
 * §4.2 step 2. `sigstore` is not reachable in v1 — there is no certificate to chain and
 * ADR-0005 is Proposed — so the honest values are `pinned` (the caller supplied the key it
 * expects) and `none` (the signature verifies against the key the receipt carries, which
 * proves internal consistency and nothing about who issued it).
 */
export type KeyTrust = "pinned" | "none";

export interface VerifyOptions {
  /**
   * SPKI DER in standard base64 — the same shape as `signature.public_key`. Supplied by the
   * caller, never fetched. §4.2: a verifier MAY accept a pinned key and MUST then report
   * `key_trust: "pinned"`.
   */
  readonly pinnedPublicKey?: string;
}

export interface VerifyResult {
  /** True only when every check passed AND steps 1 and 2 both passed. Never a summary of one. */
  readonly accepted: boolean;
  readonly steps: readonly StepReport[];
  /** Why the receipt was rejected. Empty when it was not. */
  readonly rejections: readonly string[];
  readonly keyTrust: KeyTrust;
  /** True iff the receipt carries an anchor. Always false in v1 — nothing anchors yet. */
  readonly anchored: boolean;
  /** sha256 over `"pledge.receipt.v1\x00" || JCS(subset)`. Absent when the document did not parse. */
  readonly digest?: string;
  /** Absent when the document did not parse. */
  readonly receipt?: Receipt;
}

const sha256Hex = (input: Uint8Array | string): string =>
  createHash("sha256").update(input).digest("hex");

/** `sha256:<hex>` → `<hex>`. The schema has already checked the shape. */
const hex = (hashRef: string): string => hashRef.slice("sha256:".length);

const notPerformed = (step: 3 | 4 | 5, title: string, why: string): StepReport => ({
  step,
  title,
  outcome: "not_performed",
  detail: [why],
});

/**
 * The three steps this build does not do. Listed every run, in every output, with the reason.
 *
 * Omitting them would let a reader assume a clean run covered all five, which is the precise
 * misreading §4.1's third rule exists to prevent.
 */
function deferredSteps(anchored: boolean): readonly StepReport[] {
  const why = anchored
    ? "NOT CHECKED — this build implements steps 1-2 only; the anchor in this receipt was ignored"
    : "not performed — this receipt carries no anchor, and this build implements steps 1-2 only";
  return [
    notPerformed(3, "inclusion proof (audit path -> merkle root)", why),
    notPerformed(4, "transparency log entry", why),
    notPerformed(5, "log signed tree head", why),
  ];
}

/**
 * §2.1's pairing rule, which is the no-self-report invariant in wire form: **`kept` and
 * `missed` require `probe`** — nothing a human asserts can produce either. `witness` may
 * accompany only `disputed`, `withdrawal` only `abandoned`.
 *
 * A violation is a rejection and not a warning, because a receipt that says `kept` /
 * `withdrawal` is claiming exactly the thing pledge promises is impossible
 * (architecture.md §6.3, ADR-0006).
 */
const ALLOWED_RESOLVED_BY: Readonly<Record<string, readonly string[]>> = {
  kept: ["probe"],
  missed: ["probe"],
  abandoned: ["withdrawal"],
  disputed: ["probe", "witness"],
};

/** Structural rules from §2.1, §5.1 and §6 that are checkable without any key. */
function structuralRejections(body: ReceiptBody, signatureKeyId: string, publicKey: string): string[] {
  const rejections: string[] = [];
  const { commitment, outcome, amendments, attestations } = body;

  const allowed = ALLOWED_RESOLVED_BY[outcome.status] ?? [];
  if (!allowed.includes(outcome.resolved_by)) {
    rejections.push(
      `§2.1 pairing rule: status '${outcome.status}' cannot be resolved by '${outcome.resolved_by}'` +
        ` (allowed: ${allowed.join(", ")})`,
    );
  }

  // §6. `censored` is derived, so it can only ever be redundant or wrong — and wrong here means
  // a consumer computing statistics treats a right-censored null as a zero, which biases every
  // derived figure in pledge's favour. That is the one direction of error the format cannot
  // tolerate silently.
  const shouldBeCensored =
    outcome.days_actual === null && (outcome.status === "missed" || outcome.status === "abandoned");
  if (outcome.censored !== undefined && outcome.censored !== shouldBeCensored) {
    rejections.push(
      `§6: outcome.censored is ${String(outcome.censored)} but status '${outcome.status}' with ` +
        `days_actual ${outcome.days_actual === null ? "null" : String(outcome.days_actual)} is ` +
        `${shouldBeCensored ? "" : "not "}censored`,
    );
  }

  // §2.1 says the deadlines differ iff `amendments` is non-empty. Only the safe half of that is
  // enforced: a deadline that moved with no amendment to account for it is the silent revision
  // the ledger exists to expose. The converse is legitimate — an `abandoned` amendment is a
  // recorded amendment that does not move a deadline — and rejecting it would reject honest
  // receipts, which is how a fail-closed check gets switched off.
  if (amendments.length === 0 && commitment.deadline_original !== commitment.deadline_effective) {
    rejections.push(
      "§2.1: deadline_effective differs from deadline_original but the receipt records no amendment",
    );
  }

  // §3: `amendments` and `attestations` are ordered by ascending ledger_seq, and the order is
  // signed. Checking it matters because a reordered array still verifies — against bytes that
  // say something else about when things happened.
  for (const [name, seqs] of [
    ["amendments", amendments.map((a) => a.ledger_seq)],
    ["attestations", attestations.map((a) => a.ledger_seq)],
  ] as const) {
    for (let i = 1; i < seqs.length; i += 1) {
      const previous = seqs[i - 1] as number;
      const current = seqs[i] as number;
      if (current <= previous) {
        rejections.push(`§3: ${name} must be ordered by ascending ledger_seq (${previous} then ${current})`);
        break;
      }
    }
  }

  // §5.1, the half of it that applies without a checkpoint: a record cannot be resolved before
  // it was committed.
  if (Date.parse(outcome.resolved_at) < Date.parse(commitment.committed_at)) {
    rejections.push(
      `§5.1: resolved_at (${outcome.resolved_at}) precedes committed_at (${commitment.committed_at})`,
    );
  }

  // §4.2 step 2: "Confirm key_id == sha256(public_key)". A mismatch means the receipt names a
  // key it was not signed with, whatever the signature does.
  const computedKeyId = `sha256:${sha256Hex(Buffer.from(publicKey, "base64"))}`;
  if (computedKeyId !== signatureKeyId) {
    rejections.push(`§4.2: signature.key_id does not match sha256(public_key) — expected ${computedKeyId}`);
  }

  const pending = body.anchor_pending === true;
  if (body.anchor !== null && pending) {
    rejections.push("§5.3: anchor is present and anchor_pending is true — the receipt contradicts itself");
  }

  return rejections;
}

/**
 * Verifies a receipt. Pure: no clock, no network, no filesystem, no environment.
 *
 * Takes `unknown` because its input is a stranger's JSON file. Never throws for a bad
 * receipt — a rejection is an answer, and a verifier that crashes on hostile input is a
 * verifier whose output nobody can script around.
 */
export function verifyReceipt(input: unknown, options: VerifyOptions = {}): VerifyResult {
  const parsed = ReceiptSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 8)
      .map((issue) => `  ${issue.path.length === 0 ? "<root>" : issue.path.join(".")}: ${issue.message}`);
    return {
      accepted: false,
      rejections: ["not a well-formed pledge.receipt.v1 document:", ...issues],
      keyTrust: "none",
      anchored: false,
      steps: [
        { step: 1, title: "canonical hash", outcome: "failed", detail: ["not evaluated — the document did not parse"] },
        { step: 2, title: "ed25519 signature", outcome: "failed", detail: ["not evaluated — the document did not parse"] },
        ...deferredSteps(false),
      ],
    };
  }

  const receipt = parsed.data;
  const anchored = receipt.anchor !== null && receipt.anchor !== undefined;
  const rejections = structuralRejections(receipt, receipt.signature.key_id, receipt.signature.public_key);

  // ---- step 1 --------------------------------------------------------------------------
  const subset: JsonValue = signedSubset(receipt);
  const bytes = signedBytes(RECEIPT_SIGNING_CONTEXT, subset);
  const digest = `sha256:${sha256Hex(bytes)}`;

  const { ledger } = receipt;
  let entryHashOk: boolean;
  let entryHashDetail: string;
  try {
    const recomputed = entryHashFrom({
      seq: ledger.entry_seq,
      prevHash: hex(ledger.prev_hash),
      payloadSha256: hex(ledger.payload_sha256),
    });
    entryHashOk = recomputed === hex(ledger.entry_hash);
    entryHashDetail = entryHashOk
      ? `ledger entry ${ledger.entry_seq} folds: sha256(prev_hash || payload_sha256 || u64le(seq)) == entry_hash`
      : `ledger entry ${ledger.entry_seq} does NOT fold: entry_hash should be sha256:${recomputed}`;
  } catch (error: unknown) {
    entryHashOk = false;
    entryHashDetail = `ledger triple is not usable: ${error instanceof Error ? error.message : "unknown error"}`;
  }

  const step1: StepReport = {
    step: 1,
    title: "canonical hash",
    outcome: entryHashOk ? "ok" : "failed",
    detail: [
      `signed subset canonicalised (RFC 8785 JCS), ${bytes.length} bytes with the "pledge.receipt.v1\\x00" prefix`,
      `receipt digest ${digest}`,
      entryHashDetail,
      `ledger payload_sha256 ${ledger.payload_sha256} — the entry's payload, checkable against the public ledger`,
    ],
  };

  // ---- step 2 --------------------------------------------------------------------------
  const pinned = options.pinnedPublicKey;
  const keyMatchesPin = pinned === undefined ? undefined : pinned === receipt.signature.public_key;
  const signatureValid = verifySignature(RECEIPT_SIGNING_CONTEXT, subset, {
    publicKey: receipt.signature.public_key,
    value: receipt.signature.value,
  });

  const keyTrust: KeyTrust = keyMatchesPin === true ? "pinned" : "none";
  const step2Detail = [
    `signature verified over "pledge.receipt.v1\\x00" || JCS(signed subset)`,
    `key_id    ${receipt.signature.key_id}`,
  ];
  if (keyMatchesPin === true) {
    step2Detail.push("key_trust pinned — matches the key supplied by the caller");
  } else if (keyMatchesPin === false) {
    step2Detail.push("key_trust REJECTED — the receipt is signed by a different key than the one pinned");
  } else {
    // The honest v1 statement. Sigstore/Fulcio chaining is step 2's second half in §4.2 and it
    // is not reachable yet; claiming any identity for this key would be the exact overstatement
    // the format exists to prevent.
    step2Detail.push(
      "key_trust none — no key was pinned and this build does not do Sigstore chaining,",
      "          so this proves internal consistency, NOT that pledge issued the receipt",
    );
  }

  const step2Ok = signatureValid && keyMatchesPin !== false;
  if (!signatureValid) step2Detail.push("the signature does NOT verify against signature.public_key");

  const step2: StepReport = {
    step: 2,
    title: "ed25519 signature",
    outcome: step2Ok ? "ok" : "failed",
    detail: step2Detail,
  };

  return {
    accepted: rejections.length === 0 && step1.outcome === "ok" && step2.outcome === "ok",
    steps: [step1, step2, ...deferredSteps(anchored)],
    rejections,
    keyTrust,
    anchored,
    digest,
    receipt,
  };
}
