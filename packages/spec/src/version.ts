/**
 * Version comparison (done-spec-dsl.md §4.1).
 *
 * If both operands parse as semver, compare semantically — `v0.10.0 > v0.9.0` is true. If
 * not, compare as strings, which gets that example wrong. §4.1 calls this asymmetry a
 * footgun and requires the composer to show the resolved mode before you commit, so the mode
 * is decided at canonicalisation time from the literal and stored in the AST (§5 step 3)
 * rather than inferred at evaluation time from whatever the registry happened to return.
 */

export type Semver = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Dot-separated identifiers; empty means a release, which outranks any prerelease. */
  readonly prerelease: readonly string[];
};

const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:[0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

const NUMERIC = /^(0|[1-9]\d*)$/;

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  // semver 2.0.0 §11.3: a release outranks a prerelease of the same core version.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = NUMERIC.test(left);
    const rightNumeric = NUMERIC.test(right);
    if (leftNumeric && rightNumeric) {
      if (Number(left) !== Number(right)) return Number(left) < Number(right) ? -1 : 1;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1; // numeric identifiers rank below alphanumeric ones
    } else if (left !== right) {
      return left < right ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/**
 * Compares an observed version string against the literal that was promised.
 *
 * `mode` is the AST's recorded mode. Semver mode still falls back to a string comparison
 * when the OBSERVED value does not parse — a registry can return anything, and the
 * alternative would be to report `error` for a target we observed perfectly well. The result
 * remains a pure function of the observation, so determinism (§1.3) holds.
 */
export function compareVersions(
  observed: string,
  literal: string,
  mode: "semver" | "string",
): number {
  if (mode === "semver") {
    const a = parseSemver(observed);
    const b = parseSemver(literal);
    if (a && b) return compareSemver(a, b);
  }
  return observed < literal ? -1 : observed > literal ? 1 : 0;
}
