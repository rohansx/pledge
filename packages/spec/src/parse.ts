/**
 * Source text → AST. The front door of the package.
 *
 * `parse` returns a result rather than throwing, because both of its callers want the
 * diagnostics: the composer renders them under the textarea while the user is still typing,
 * and the verifier CLI prints them. `parseOrThrow` exists for the places where a failure is a
 * bug — a stored spec that no longer parses, a template expansion that produced garbage.
 */
import type { SpecNode } from "./ast";
import { SpecError, type SpecIssue, type SpecWarning, issue } from "./errors";
import { specLexer } from "./lexer";
import { specParser } from "./parser";
import { Collector, visitSpec } from "./visit";

export type ParseResult =
  | { readonly ok: true; readonly ast: SpecNode; readonly warnings: readonly SpecWarning[] }
  | { readonly ok: false; readonly issues: readonly SpecIssue[] };

const MAX_SOURCE_LENGTH = 4000;

export function parse(source: string): ParseResult {
  // A bound on the input is a bound on everything downstream: the parser is O(n), but the
  // composer re-parses on every keystroke and a megabyte pasted into a textarea should be a
  // message, not a frozen tab.
  if (source.length > MAX_SOURCE_LENGTH) {
    return {
      ok: false,
      issues: [issue("unsupported", `a done-spec must be under ${MAX_SOURCE_LENGTH} characters`, 0, 0)],
    };
  }

  const lexed = specLexer.tokenize(source);
  if (lexed.errors.length > 0) {
    return {
      ok: false,
      issues: lexed.errors.map((error) =>
        issue("lex", error.message, error.offset, error.length),
      ),
    };
  }
  if (lexed.tokens.length === 0) {
    return { ok: false, issues: [issue("parse", "a done-spec cannot be empty", 0, 0)] };
  }

  specParser.input = lexed.tokens;
  const cst = specParser.spec();
  if (specParser.errors.length > 0) {
    return {
      ok: false,
      issues: specParser.errors.map((error) => {
        const token = error.token;
        // The EOF token has no real offset; point at the end of the source instead of at -1,
        // so "unexpected end of input" underlines the end of what was written.
        const offset = Number.isInteger(token.startOffset) ? token.startOffset : source.length;
        return issue("parse", error.message, offset, token.image?.length ?? 0);
      }),
    };
  }

  const collector = new Collector();
  const ast = visitSpec(cst, collector);
  if (ast === undefined || collector.issues.length > 0) {
    return {
      ok: false,
      issues: collector.issues.length > 0 ? collector.issues : [issue("parse", "unparseable done-spec")],
    };
  }
  return { ok: true, ast, warnings: collector.warnings };
}

export function parseOrThrow(source: string): SpecNode {
  const result = parse(source);
  if (!result.ok) throw new SpecError(result.issues);
  return result.ast;
}
