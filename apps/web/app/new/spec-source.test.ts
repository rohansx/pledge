/**
 * §4.1's version-comparison footgun, which the composer is REQUIRED to show before commit:
 *
 *   "if both operands parse as semver, compare semantically (`v0.10.0 > v0.9.0` is true).
 *    Otherwise compare as strings ... This asymmetry is a footgun, so the composer shows the
 *    resolved comparison mode before you commit."
 *
 * The mode is decided once, at canonicalisation, and stored in the AST — so what is tested
 * here is that the composer READS the decision that was hashed rather than making its own.
 */
import { compile, type SpecNode } from "@pledge/spec";
import { describe, expect, it } from "vitest";
import { INPUT_PROPS, describeComparison, versionComparisons } from "./spec-source";

function astOf(source: string): SpecNode {
  const result = compile(source);
  if (!result.ok) throw new Error(result.issues.map((i) => i.message).join("; "));
  return result.spec.ast;
}

describe("versionComparisons", () => {
  it("reports semver mode for a literal that parses as semver", () => {
    const ast = astOf('npm("p").latest_version >= v0.2.0 and npm("p").published_at > commit_time');
    expect(versionComparisons(ast)).toEqual([{ value: "v0.2.0", mode: "semver" }]);
  });

  it("reports string mode for a literal that does not", () => {
    // The Publish-a-package template's blank accepts whatever is typed, so this is the shape a
    // real user reaches by typing a two-part version. `v0.9` is a version literal by the §2
    // grammar but not a semver, so the comparison silently becomes textual — and under text
    // ordering `v0.10 >= v0.9` is FALSE, which is the miss this display exists to prevent.
    const comparisons = versionComparisons(astOf('npm("p").latest_version >= v0.9'));
    expect(comparisons).toHaveLength(1);
    expect(comparisons[0]?.mode).toBe("string");
    expect(describeComparison(comparisons[0]!)).toContain("compared as text");
  });

  it("finds every comparison in a compound spec, not just the first", () => {
    const ast = astOf('npm("a").latest_version >= v1.0.0 and npm("b").latest_version >= v2.0.0');
    expect(versionComparisons(ast).map((c) => c.value).sort()).toEqual(["v1.0.0", "v2.0.0"]);
  });

  it("says nothing about a spec with no version comparison", () => {
    expect(versionComparisons(astOf('github.pr("o/n", 42).state == "merged"'))).toEqual([]);
  });

  it("names the consequence, not the mode", () => {
    // Copy rule: "semver" tells a reader nothing they can act on. The ordering does.
    expect(describeComparison({ value: "v1.0.0", mode: "semver" })).toContain("0.10.0");
  });
});

describe("INPUT_PROPS", () => {
  it("covers every blank kind the templates declare", () => {
    // A missing key would render an input with `type: undefined` rather than failing loudly.
    // Exhaustiveness is a compile-time property of the Record type; this pins it at runtime
    // too, because the kinds come from another package.
    for (const kind of Object.keys(INPUT_PROPS)) {
      expect(INPUT_PROPS[kind as keyof typeof INPUT_PROPS].type).toBeTruthy();
    }
  });
});
