/**
 * Tokens for the grammar in done-spec-dsl.md §2.
 *
 * Only operators, combinators, booleans and the two named instants are keywords. Source and
 * field names stay plain identifiers and are resolved against catalogue.ts in the visitor,
 * which keeps the token set small and turns `github.releases(...)` into "unknown field
 * 'releases' on github" instead of a bare syntax error.
 *
 * Chevrotain takes the FIRST pattern in this array that matches at a position, not the
 * longest, so the numeric tokens must run Version → Decimal → Integer, and every keyword
 * needs `longer_alt: Identifier` so that `andrew` lexes as an identifier and not `and` + `rew`.
 */
import { createToken, Lexer } from "chevrotain";

export const Identifier = createToken({
  name: "Identifier",
  pattern: /[A-Za-z][A-Za-z0-9_]*/,
});

const keyword = (name: string, pattern: RegExp) =>
  createToken({ name, pattern, longer_alt: Identifier });

export const WhiteSpace = createToken({
  name: "WhiteSpace",
  pattern: /\s+/,
  group: Lexer.SKIPPED,
});

/**
 * §2: `string = '"' { char } '"'` — no interpolation, ever. JSON escapes only. Raw control
 * characters lex but are rejected when the escape sequence is decoded, which yields "control
 * character in string literal" rather than a positionless syntax error: a spec containing a
 * raw newline is a mistake or an attempt to make a rendered spec lie about what it says, and
 * the author deserves to be told which.
 */
export const StringLiteral = createToken({
  name: "StringLiteral",
  pattern: /"(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"/,
});

/**
 * §2 `version = "v"? digit { digit | "." | "-" | ident }`, tightened so it can never overlap
 * Decimal or Identifier: a `v`-prefixed form must contain a dot (`v0.2.0`, never `v0`), and
 * a bare numeric form needs three or more components (`1.2.3`, while `0.4` stays a decimal).
 */
export const VersionLiteral = createToken({
  name: "VersionLiteral",
  pattern: /v\d+(?:\.[0-9A-Za-z][0-9A-Za-z.-]*)+|\d+\.\d+\.[0-9A-Za-z][0-9A-Za-z.-]*/,
});

export const DecimalLiteral = createToken({ name: "DecimalLiteral", pattern: /\d+\.\d+/ });
export const IntegerLiteral = createToken({ name: "IntegerLiteral", pattern: /\d+/ });

export const Equals = createToken({ name: "Equals", pattern: /==/ });
export const NotEquals = createToken({ name: "NotEquals", pattern: /!=/ });
export const GreaterEq = createToken({ name: "GreaterEq", pattern: />=/ });
export const LessEq = createToken({ name: "LessEq", pattern: /<=/ });
export const Greater = createToken({ name: "Greater", pattern: />/ });
export const Less = createToken({ name: "Less", pattern: /</ });

export const LParen = createToken({ name: "LParen", pattern: /\(/ });
export const RParen = createToken({ name: "RParen", pattern: /\)/ });
export const Comma = createToken({ name: "Comma", pattern: /,/ });
export const Dot = createToken({ name: "Dot", pattern: /\./ });

export const And = keyword("And", /and/);
export const Or = keyword("Or", /or/);
export const Not = keyword("Not", /not/);
export const All = keyword("All", /all/);
export const Any = keyword("Any", /any/);
export const Contains = keyword("Contains", /contains/);
export const Matches = keyword("Matches", /matches/);
export const StartsWith = keyword("StartsWith", /starts_with/);
export const EndsWith = keyword("EndsWith", /ends_with/);
export const True = keyword("True", /true/);
export const False = keyword("False", /false/);
export const CommitTime = keyword("CommitTime", /commit_time/);
export const Deadline = keyword("Deadline", /deadline/);

/** Order matters — see the note at the top of the file. */
export const allTokens = [
  WhiteSpace,
  StringLiteral,
  VersionLiteral,
  DecimalLiteral,
  IntegerLiteral,
  Equals,
  NotEquals,
  GreaterEq,
  LessEq,
  Greater,
  Less,
  LParen,
  RParen,
  Comma,
  Dot,
  And,
  Or,
  Not,
  All,
  Any,
  Contains,
  Matches,
  StartsWith,
  EndsWith,
  True,
  False,
  CommitTime,
  Deadline,
  Identifier,
];

export const specLexer = new Lexer(allTokens, { positionTracking: "onlyOffset" });
