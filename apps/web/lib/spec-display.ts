/**
 * Rendering a done-spec as the sentence it means.
 *
 * security.md T-04, the last mitigation in its table: "raw spec source shown next to every
 * outcome". It stops nothing technically — it shifts judgement to the reader, which is the
 * only honest answer to "does this probe mean anything". A badge whose criterion is not
 * inspectable is precisely the thing pledge exists to replace, so every surface that renders a
 * status renders this too, or links to it in one click.
 */
import type { CommitmentRow, ProbeRunRow } from "@pledge/db";
import type { DoneSpecV0, ProbeEvidence, ProbeOutcome } from "@pledge/db/types";

/** One line, human-readable, exact. Not a paraphrase — this is what the probe checks. */
export function describeSpec(spec: DoneSpecV0): string {
  switch (spec.kind) {
    case "http_status":
      return `http(${spec.url}).status == ${spec.expectedStatus}`;
    case "github_release_tag":
      return `github.release(${spec.repo}).tag matches ${spec.tagPattern}`;
  }
}

/** The target the probe observes, for a compact profile line. */
export function specTarget(spec: DoneSpecV0): string {
  return spec.kind === "http_status" ? spec.url : spec.repo;
}

/**
 * A one-line summary of what a probe run saw.
 *
 * `error` is stated as "could not observe", never as a failure. An error is the ABSENCE of an
 * observation (CLAUDE.md I-7); copy that blurs the two blurs it in readers' heads exactly the
 * way collapsing the enum would blur it in the database.
 */
export function describeEvidence(outcome: ProbeOutcome, evidence: ProbeEvidence): string {
  if (outcome === "error") {
    const reason = evidence.error?.code ?? "unknown";
    return `could not observe the target (${reason})`;
  }

  const parts: string[] = [];
  if (evidence.status !== undefined) parts.push(`status ${evidence.status}`);
  if (evidence.matches !== undefined && evidence.matches.length > 0) {
    parts.push(`matched ${evidence.matches.join(", ")}`);
  }
  if (evidence.finalUrl !== undefined) parts.push(`final url ${evidence.finalUrl}`);
  if (evidence.bodyBytes !== undefined) parts.push(`${evidence.bodyBytes} bytes`);
  if (evidence.resolvedIp !== undefined) parts.push(`resolved ${evidence.resolvedIp}`);

  const seen = parts.length === 0 ? "no detail recorded" : parts.join(" · ");
  return outcome === "pass"
    ? `observed the done-condition true — ${seen}`
    : `observed the done-condition false — ${seen}`;
}

/**
 * The novelty check (done-spec-dsl.md §6.3, technical-spec.md §5 anti-gaming).
 *
 * A baseline snapshot of the target is captured at commit time, before the work. If a probe
 * later passes against a byte-identical target, the done-condition was already true when the
 * promise was made — the commitment did not cause anything. That is worth saying out loud
 * next to the outcome, because a `kept` badge earned that way is exactly the badge pledge
 * exists to be distinguishable from.
 *
 * THREE STATES, NOT TWO. A missing baseline means "we cannot say", never "unchanged": the
 * capture can legitimately fail because the target was down when the commitment was made
 * (schema.ts makes `baseline_sha256` nullable for precisely this reason). Returning `false`
 * there would quietly promote an unknown into a clean bill of health.
 */
export type Novelty = "changed" | "unchanged_since_commitment" | "unknown";

export function noveltyOf(
  commitment: Pick<CommitmentRow, "baselineSha256">,
  run: Pick<ProbeRunRow, "outcome" | "evidence"> | undefined,
): Novelty {
  if (commitment.baselineSha256 === null) return "unknown";
  // Only a passing observation says anything about novelty. A `fail` means the condition was
  // observed false, and an `error` observed nothing at all (CLAUDE.md I-7).
  if (run === undefined || run.outcome !== "pass") return "unknown";
  const observed = run.evidence.bodySha256;
  if (observed === undefined) return "unknown";
  return observed === commitment.baselineSha256 ? "unchanged_since_commitment" : "changed";
}

/**
 * The sentence shown beside a passing outcome. `null` in the ordinary case — a record that
 * annotated every healthy commitment would train readers to skim past the annotation on the
 * one that matters.
 */
export function describeNovelty(novelty: Novelty): string | null {
  return novelty === "unchanged_since_commitment"
    ? "The target is byte-identical to the snapshot taken when this was committed. The condition was already true when the promise was made."
    : null;
}
