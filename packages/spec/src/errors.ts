/**
 * Diagnostics.
 *
 * Every issue carries a byte offset into the authored source, because the composer renders
 * these under a textarea and "syntax error" with no position is a support ticket.
 */

export const specIssueCodes = [
  "lex", // the lexer could not tokenise
  "parse", // the token stream is not a valid spec
  "unknown_source", // `htp(...)`, `github.tags(...)`
  "unknown_field", // `http(u).stats`
  "unknown_call", // `.singe(commit_time)`
  "bad_arity", // `github.pr("o/r")` — missing the number
  "bad_argument", // wrong argument type, malformed URL/repo/package/pointer/glob
  "type_error", // `http(u).status contains "x"`
  "unsupported", // grammatically valid, semantically out of scope for spec_version 1
] as const;
export type SpecIssueCode = (typeof specIssueCodes)[number];

export type SpecIssue = {
  readonly code: SpecIssueCode;
  readonly message: string;
  /** Byte offset of the offending token in the authored source; -1 when not from source text. */
  readonly offset: number;
  readonly length: number;
};

export const specWarningCodes = [
  /**
   * §4.1: a version comparison where the literal does not parse as semver falls back to
   * string comparison. This asymmetry is a footgun, so the composer shows it before you
   * commit rather than after you miss.
   */
  "string_version_compare",
  /** `.json(pointer)` has no static type; the comparison is resolved against the observation. */
  "dynamic_json_compare",
] as const;
export type SpecWarningCode = (typeof specWarningCodes)[number];

export type SpecWarning = {
  readonly code: SpecWarningCode;
  readonly message: string;
  readonly offset: number;
  readonly length: number;
};

export class SpecError extends Error {
  readonly issues: readonly SpecIssue[];

  constructor(issues: readonly SpecIssue[]) {
    const first = issues[0];
    super(first ? `${first.message} (at offset ${first.offset})` : "invalid done-spec");
    this.name = "SpecError";
    this.issues = issues;
  }
}

export function issue(
  code: SpecIssueCode,
  message: string,
  offset = -1,
  length = 0,
): SpecIssue {
  return { code, message, offset, length };
}
