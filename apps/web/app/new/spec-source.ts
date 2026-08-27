/**
 * The composer's pure half: turning what the user picked into done-spec source, and reading
 * back out of the compiled AST the two things §4.1 and §7 say must be visible *before* commit.
 *
 * Nothing here renders and nothing here fetches, so all of it is testable without a DOM.
 *
 * The §9 template table is NOT here. It lives in `@pledge/spec` — one table, one place — and
 * this module holds only what a browser form needs on top of it (`INPUT_PROPS`), which is
 * presentation and has no business sitting in the package a third party reads to learn what a
 * pledge means.
 */
import type { BlankKind, ProbeClass, SpecNode } from "@pledge/spec";

/**
 * How each blank is rendered. Presentation only — deliberately NOT validation.
 *
 * `type="url"` and `type="number"` buy a sensible mobile keyboard and nothing else here: the
 * form never gates submission on them, because the only opinion that may decide whether a spec
 * is legal is the parser's. Two validators would be two answers to one question, and the one
 * the user never sees would be the one that silently wins.
 */
export const INPUT_PROPS: Readonly<
  Record<BlankKind, { readonly type: string; readonly inputMode?: "numeric"; readonly spellCheck: boolean }>
> = {
  repo: { type: "text", spellCheck: false },
  glob: { type: "text", spellCheck: false },
  url: { type: "url", spellCheck: false },
  text: { type: "text", spellCheck: true },
  package: { type: "text", spellCheck: false },
  version: { type: "text", spellCheck: false },
  int: { type: "number", inputMode: "numeric", spellCheck: false },
};

/**
 * done-spec-dsl.md §7, as a sentence rather than a label.
 *
 * Stated as what the probe will *observe*, never as praise or difficulty. §7 is explicit that
 * class is a proxy for effort and not a measure of it, so copy that implied "strong = hard"
 * would be putting a claim on the record that the DSL cannot support.
 */
export const PROBE_CLASS_NOTE: Readonly<Record<ProbeClass, string>> = {
  trivial: "One source, and it only asks whether the target answered. Does not count toward calibration.",
  weak: "One source, with no assertion about content. Counts only with a witness co-signature.",
  standard: "Asserts something about content, or reads two or more distinct sources.",
  strong: "Two or more distinct sources including a third party, or a count taken since you committed.",
};

/**
 * §4.1's footgun, extracted from the compiled AST so the composer can show it.
 *
 * The comparison mode is decided at canonicalisation time from the literal and stored in the
 * node (§5 step 3), so this reads a decision that has already been made and is already part of
 * the hash. It does not re-derive it — a second opinion here could disagree with the one that
 * was hashed, which is the exact failure the composer exists to prevent.
 */
export interface VersionComparison {
  readonly value: string;
  readonly mode: "semver" | "string";
}

export function versionComparisons(node: SpecNode): readonly VersionComparison[] {
  switch (node.kind) {
    case "and":
    case "or":
      return [...versionComparisons(node.left), ...versionComparisons(node.right)];
    case "not":
      return versionComparisons(node.operand);
    case "truthy":
      return [];
    case "compare":
      return node.right.type === "version"
        ? [{ value: node.right.value, mode: node.right.compare }]
        : [];
  }
}

/** The sentence shown next to a version comparison. Both halves state a consequence. */
export function describeComparison(comparison: VersionComparison): string {
  return comparison.mode === "semver"
    ? `compared as a version — 0.10.0 counts as later than 0.9.0`
    : `compared as text — “${comparison.value}” does not parse as a version, so 0.10.0 sorts BEFORE 0.9.0`;
}
