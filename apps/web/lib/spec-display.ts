/**
 * Rendering a done-spec as the sentence it means.
 *
 * security.md T-04, the last mitigation in its table: "raw spec source shown next to every
 * outcome". It stops nothing technically — it shifts judgement to the reader, which is the
 * only honest answer to "does this probe mean anything". A badge whose criterion is not
 * inspectable is precisely the thing pledge exists to replace, so every surface that renders a
 * status renders this too, or links to it in one click.
 */
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
