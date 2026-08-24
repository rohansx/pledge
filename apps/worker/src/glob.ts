/**
 * Glob matching for `github_release_tag` patterns, e.g. `v0.2.*`.
 *
 * `*` is the only metacharacter and matches any run of characters, including none. Everything
 * else — `?`, `[`, `.`, `\` — is a literal. There is deliberately no regex anywhere near this:
 * `tagPattern` is user-supplied and matched against a remote-controlled tag, which is a ReDoS
 * primitive if it ever reaches a regex engine (docs/security.md T-01, technical-spec §5).
 *
 * ponytail: classic two-pointer wildcard match with one backtrack point. Worst case is
 * O(pattern × value) on adversarial patterns like `a*a*a*b`, but both are bounded (pattern
 * ≤ 200 chars by the Zod schema, tags are short), so it never gets near the exponential
 * blow-up a backtracking regex would. If patterns ever grow, swap in a DP table.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  // Where the most recent `*` sat, and how much of `value` it had consumed at that point.
  let star = -1;
  let consumed = 0;

  while (v < value.length) {
    if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p += 1;
      consumed = v;
    } else if (star !== -1) {
      // Give the last `*` one more character and retry from just after it.
      consumed += 1;
      v = consumed;
      p = star + 1;
    } else {
      return false;
    }
  }

  // Trailing `*`s may match the empty string; anything else left over is a mismatch.
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}
