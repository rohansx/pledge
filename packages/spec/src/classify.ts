/**
 * Probe classes — done-spec-dsl.md §7.
 *
 * The class is computed at commit time from the AST and stored on the commitment, so the rules
 * that applied are frozen alongside the spec. Reclassifying old commitments retroactively
 * would be exactly the kind of silent redefinition the product exists to prevent — which is
 * why this function takes an AST and nothing else: no clock, no config, no feature flag.
 *
 * ADR-0007: derived from the AST, never from user-supplied tags or difficulty labels. There is
 * no input here a committer can set directly.
 *
 * > Honest limitation, from §7 and repeated here because it will otherwise be forgotten:
 * > class is a proxy for effort, not a measure of it.
 * > `http("https://my-landing-page.com").text contains "coming soon"` is `standard` and took
 * > four minutes. See security.md T-04 and open-questions Q-02 — the DSL cannot close this gap
 * > and should not pretend to.
 */
import type { Accessor, SpecNode } from "./ast";
import { resolveFieldPath, sourceDef } from "./catalogue";
import { sourceKey } from "./keys";

export const probeClasses = ["trivial", "weak", "standard", "strong"] as const;
export type ProbeClass = (typeof probeClasses)[number];

export function classify(node: SpecNode): ProbeClass {
  const leaves = accessors(node);
  // Distinct SOURCES, not distinct fetches: two accessors differing only in a modifier read
  // the same target and are not two independent pieces of evidence.
  const distinct = new Set(leaves.map((a) => sourceKey(a.accessor.source)));
  const thirdParty = leaves.some((a) => sourceDef(a.accessor.source.kind)?.thirdParty === true);
  const content = leaves.some(
    (a) => resolveFieldPath(a.accessor.source.kind, a.accessor.field.path)?.content === true,
  );

  if ((distinct.size >= 2 && thirdParty) || leaves.some(sustained)) return "strong";
  if (content || distinct.size >= 2) return "standard";
  // Single source, no content assertion. `trivial` is the narrower of the two: exactly one
  // comparison, and it only asks whether the target answered at all.
  return leaves.length === 1 ? "trivial" : "weak";
}

/**
 * §7's "a `.since(commit_time)` count". A count taken over a window that opens when the promise
 * was made is evidence of work done *after* committing, which is the one thing a single source
 * can say that a snapshot cannot — so it is strong on its own.
 *
 * The field is required to be an int so `.since(commit_time).latest_sha` — a snapshot with a
 * narrowing that does not change what it says — does not get the same weight.
 */
function sustained(leaf: { readonly accessor: Accessor }): boolean {
  const { accessor } = leaf;
  const since = accessor.modifiers.some(
    (m) => m.name === "since" && m.args.some((a) => a.type === "instant" && a.name === "commit_time"),
  );
  return since && resolveFieldPath(accessor.source.kind, accessor.field.path)?.type === "int";
}

function accessors(node: SpecNode): readonly { readonly accessor: Accessor }[] {
  switch (node.kind) {
    case "and":
    case "or":
      return [...accessors(node.left), ...accessors(node.right)];
    case "not":
      return accessors(node.operand);
    case "compare":
      return [{ accessor: node.left }];
    case "truthy":
      return [{ accessor: node.accessor }];
  }
}
