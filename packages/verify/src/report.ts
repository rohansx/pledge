/**
 * The printed report — docs/spec/receipt-format.md §4.3, which is normative about the output
 * and not only about the algorithm.
 *
 * Two rules govern every line below:
 *
 *   · Each step is reported separately (§4.1). There is no single "VERIFIED" line that could
 *     be grepped for and mistaken for a full five-step run.
 *   · Nothing overstates. §4.3's closing note ends "it does not judge whether the done-spec was
 *     a fair test of the claim", and for an unanchored receipt the first half of that note —
 *     "was not backdated" — is not true yet either, so it is stated as what actually held.
 *
 * The result block prints the spec source next to the outcome, always. §1 is explicit that a
 * consuming UI must not render a receipt as a green checkmark alone, and CLAUDE.md says the
 * same thing about badges: a criterion that is not inspectable is the thing pledge exists to
 * replace.
 */
import type { Receipt } from "./receipt.ts";
import type { StepReport, VerifyResult } from "./verify.ts";

const MARK: Readonly<Record<StepReport["outcome"], string>> = {
  ok: "ok ",
  failed: "BAD",
  not_performed: "-- ",
};

const DAY_MS = 86_400_000;

/** Hashes are long and the eye needs a prefix, not 64 characters of hex. */
const short = (hashRef: string): string => `${hashRef.slice(0, 21)}...`;

/** `2026-09-04T14:21:07Z` → `2026-09-04 14:21Z`. UTC, always: the receipt has no other zone. */
const at = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;

function field(label: string, value: string): string {
  return `    ${label.padEnd(16)} ${value}`;
}

/**
 * The one-line verdict. `kept` earns no adjectives, and a censored `missed` says so in the
 * same breath — §6 exists because "no completion was observed" gets read as "zero days" by
 * anyone who skims.
 */
function resultLines(receipt: Receipt): readonly string[] {
  const { outcome, commitment } = receipt;
  const lines: string[] = [];
  const observedAt = at(outcome.resolved_at);

  switch (outcome.status) {
    case "kept": {
      const margin = (Date.parse(commitment.deadline_effective) - Date.parse(outcome.resolved_at)) / DAY_MS;
      const early =
        margin >= 0 ? `${margin.toFixed(1)} days early` : `${Math.abs(margin).toFixed(1)} days after the deadline`;
      lines.push(field("RESULT", `kept - the done-condition was observed TRUE at ${observedAt}, ${early}`));
      break;
    }
    case "missed":
      lines.push(field("RESULT", `missed - the done-condition was observed FALSE at ${observedAt}`));
      break;
    case "abandoned":
      lines.push(field("RESULT", `abandoned - withdrawn by the committer, recorded ${observedAt}`));
      break;
    case "disputed":
      lines.push(field("RESULT", `disputed - the record is contested; read the attestations below`));
      break;
  }

  if (outcome.days_actual === null && (outcome.status === "missed" || outcome.status === "abandoned")) {
    lines.push(
      field("", "days_actual is null: RIGHT-CENSORED at resolved_at, not zero and not never."),
      field("", "any statistic over receipts must treat this as a censored observation (§6)."),
    );
  } else if (outcome.days_actual !== null) {
    const estimated = outcome.days_estimated === null ? "not estimated" : `${outcome.days_estimated} estimated`;
    const slip = outcome.slip_ratio === null ? "" : `, slip ratio ${outcome.slip_ratio}`;
    lines.push(field("", `${outcome.days_actual} days actual, ${estimated}${slip}`));
  }

  if (outcome.unchanged_since_commitment) {
    lines.push(
      field("", "the target is byte-identical to the snapshot taken when this was committed:"),
      field("", "the condition was already true when the promise was made."),
    );
  }

  return lines;
}

function summary(receipt: Receipt): readonly string[] {
  const { commitment, done_spec, amendments, evidence, attestations } = receipt;
  const amended =
    amendments.length === 0
      ? "(never amended)"
      : `(amended ${amendments.length}x, original ${at(commitment.deadline_original)})`;

  const lines = [
    "",
    field("handle", commitment.handle),
    field("claim", `"${commitment.claim}"`),
    field("done when", done_spec.source),
    field("spec hash", `${short(done_spec.hash)}  (spec_version ${done_spec.spec_version})`),
    field("probe class", done_spec.probe_class),
    field("committed", `${at(commitment.committed_at)}    deadline ${at(commitment.deadline_effective)} ${amended}`),
    field(
      "evidence",
      evidence.length === 0
        ? "none recorded"
        : `${evidence.length} observation(s), latest ${at(evidence[evidence.length - 1]?.observed_at ?? commitment.committed_at)}`,
    ),
    ...resultLines(receipt),
  ];

  for (const amendment of amendments) {
    lines.push(field("amendment", `${at(amendment.created_at)} ${amendment.kind}: ${amendment.reason}`));
  }
  for (const attestation of attestations) {
    lines.push(
      field("attestation", `${at(attestation.signed_at)} witness ${attestation.witness_ref} ${attestation.verdict}`),
    );
  }
  return lines;
}

/**
 * §4.3's closing note, which "is part of the specified output".
 *
 * The unanchored wording is not the spec's, because the spec's wording is only true once steps
 * 3–5 have run: with no anchor, nothing in the receipt places it in time. Saying otherwise
 * would be the single most misleading line this tool could print.
 */
function scopeNote(anchored: boolean): readonly string[] {
  return anchored
    ? [
        "",
        "    note: this proves the record is authentic and was not backdated.",
        "          it does not judge whether the done-spec was a fair test of the claim.",
      ]
    : [
        "",
        "    note: this proves the record is authentic in the sense the steps above checked -",
        "          internally consistent, and signed by the key it names. it does NOT prove the",
        "          record was not backdated: that is steps 3-5, and they did not run.",
        "          it does not judge whether the done-spec was a fair test of the claim.",
      ];
}

export function formatReport(result: VerifyResult, sourceLabel: string): string {
  const lines: string[] = [`pledge-verify  ${sourceLabel}`, ""];

  for (const step of result.steps) {
    lines.push(`${MARK[step.outcome]} step ${step.step}  ${step.title}`);
    for (const detail of step.detail) lines.push(`           ${detail}`);
  }

  if (result.receipt !== undefined && !result.anchored) {
    lines.push(
      "",
      "--  not anchored. this receipt is signed but NOT independently timestamped.",
      "    steps 3-5 did not run. anchoring is not part of this format version's deployment;",
      "    re-verify with a later build if the receipt is reissued with an anchor.",
    );
  } else if (result.anchored) {
    lines.push(
      "",
      "!!  this receipt carries an anchor and this build DID NOT CHECK IT.",
      "    treat it as unanchored until a verifier that implements steps 3-5 says otherwise.",
    );
  }

  if (result.receipt !== undefined) {
    lines.push(...summary(result.receipt), ...scopeNote(result.anchored));
  }

  if (result.rejections.length > 0) {
    lines.push("", "REJECTED:");
    for (const rejection of result.rejections) lines.push(`    ${rejection}`);
  }

  lines.push(
    "",
    result.accepted
      ? `VERIFIED  steps 1-2 of 5 (signed${result.keyTrust === "pinned" ? " by the pinned key" : ", key not bound to any identity"}, not anchored)`
      : "REJECTED  this receipt did not verify",
    "",
  );

  return lines.join("\n");
}
