/**
 * Witness attestations, rendered publicly.
 *
 * This component IS the mitigation. Accountless attestation is only tolerable because the vouch
 * is attributable and permanent (security.md T-02, ADR-0006) — a name attached forever is what
 * makes a careless vouch cost the voucher something. Hide the identity and the feature becomes
 * exactly the anonymous honor-system referee the product criticises in StickK.
 *
 * Three copy rules that are load-bearing rather than stylistic:
 *
 *  · Never call an attestation "verification". A witness cannot verify anything; the probe
 *    does that. Blurring the two in copy blurs it in readers' heads.
 *  · A `disputes` verdict is shown as plainly as a `confirms`. A list that quietly demoted
 *    dissent would be self-reporting with extra steps.
 *  · Say that a human said it. The rest of the page is machine observation; this is the one
 *    part that is somebody's word, and the reader has to be able to tell.
 *
 * Consumed by the commitment page and the profile. It is a server component with no state and
 * no client JavaScript.
 */
import { LocalTime } from "@/components/local-time";
import { formatInZone } from "@/lib/deadline";
import type { PublicAttestation } from "@/lib/witness-queries";

interface WitnessListProps {
  readonly attestations: readonly PublicAttestation[];
}

export function WitnessList({ attestations }: WitnessListProps) {
  // The common case is nobody. ADR-0006: non-response is normal and is not a failure, so an
  // empty list renders nothing at all rather than an accusing "0 witnesses".
  if (attestations.length === 0) return null;

  return (
    <section className="witnesses">
      <h2>What people said</h2>
      <p className="muted">
        Attestations by people the committer invited. These are human statements, not
        observations — the probe evidence above is what decided the outcome.
      </p>

      <ul className="runs">
        {attestations.map((attestation) => (
          <li
            key={attestation.attestationId}
            className={attestation.verdict === "confirms" ? "run run-pass" : "run run-fail"}
          >
            <span className="run-outcome">
              {attestation.verdict === "confirms" ? "said it was done" : "said it was not done"}
            </span>
            <span className="run-detail">
              {/* In full, never masked: an unmaskable name is the whole point. */}
              {attestation.email} ·{" "}
              <LocalTime
                iso={attestation.signedAt.toISOString()}
                fallback={`${formatInZone(attestation.signedAt, "UTC")} UTC`}
              />{" "}
              · ledger #{attestation.ledgerSeq}
            </span>
            {attestation.note === null ? null : <p className="note">{attestation.note}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
