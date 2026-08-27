/**
 * CST → AST, with the catalogue check and the type check done on the way down.
 *
 * Everything here reports through `SpecIssue` rather than throwing, because the composer
 * renders these under a textarea: a spec that names a field that does not exist should say
 * *which* field and *where*, not "syntax error". The one exception is an internal shape
 * mismatch in the CST, which is a bug in parser.ts and not a user error.
 *
 * Canonicalisation steps 2 and 3 (done-spec-dsl.md §5) run here, at the point where a
 * rejection still has a token offset to point at — see normalise.ts. What is left for
 * canonicalise.ts is the parts that are properties of the tree rather than of a leaf.
 *
 * INVARIANT I-6: no Node-only imports.
 */
import type { CstNode, IToken } from "chevrotain";

import {
  type Accessor,
  type CompareOp,
  type Field,
  type Instant,
  type Literal,
  type Modifier,
  type Operand,
  type Source,
  type SpecNode,
} from "./ast";
import {
  ALLOWED_HEADERS,
  type FieldDef,
  type Param,
  type SourceDef,
  type ValueType,
  resolveFieldPath,
  sourceDef,
} from "./catalogue";
import { type SpecIssue, type SpecWarning, issue } from "./errors";
import { GlobError, compileGlob } from "./glob";
import {
  NormaliseError,
  decodeStringLiteral,
  normaliseHostname,
  normaliseJsonPointer,
  normalisePackage,
  normalisePath,
  normaliseRepo,
  normaliseString,
  normaliseUrl,
} from "./normalise";
import { parseSemver } from "./version";

/** Collects diagnostics so one pass reports every problem, not just the first. */
export class Collector {
  readonly issues: SpecIssue[] = [];
  readonly warnings: SpecWarning[] = [];

  add(next: SpecIssue): void {
    this.issues.push(next);
  }

  warn(next: SpecWarning): void {
    this.warnings.push(next);
  }
}

/** Thrown when a subtree cannot produce a node at all; the issue is already collected. */
class Abort extends Error {}

// -------------------------------------------------------------------------------------------
// CST access. Chevrotain types children as `(CstNode | IToken)[]`, so the narrowing happens
// once, here, rather than at every use site.
// -------------------------------------------------------------------------------------------

type Children = Readonly<Record<string, readonly (CstNode | IToken)[] | undefined>>;

const kids = (node: CstNode): Children => node.children as Children;

function nodes(node: CstNode, key: string): readonly CstNode[] {
  return (kids(node)[key] ?? []) as readonly CstNode[];
}

function tokens(node: CstNode, key: string): readonly IToken[] {
  return (kids(node)[key] ?? []) as readonly IToken[];
}

function only(node: CstNode, key: string): CstNode {
  const found = nodes(node, key)[0];
  if (found === undefined) throw new Error(`parser bug: ${node.name} has no ${key}`);
  return found;
}

const span = (token: IToken) => ({ offset: token.startOffset, length: token.image.length });

/** `issue` with the offsets filled in from the token the message points at. */
const tokenIssue = (code: Parameters<typeof issue>[0], message: string, token: IToken): SpecIssue =>
  issue(code, message, token.startOffset, token.image.length);

// -------------------------------------------------------------------------------------------
// Expressions
// -------------------------------------------------------------------------------------------

export function visitSpec(cst: CstNode, collector: Collector): SpecNode | undefined {
  try {
    return visitOr(only(cst, "orExpr"), collector);
  } catch (error: unknown) {
    if (error instanceof Abort) return undefined;
    throw error;
  }
}

/**
 * §5 step 1: binary and left-associated. `a or b or c` is `(a or b) or c`, and so is
 * `any(a, b, c)` — which is what makes the combinator form and the operator form share a hash.
 */
function visitOr(cst: CstNode, collector: Collector): SpecNode {
  const parts = [
    ...nodes(cst, "lhs").map((n) => visitAnd(n, collector)),
    ...nodes(cst, "rhs").map((n) => visitAnd(n, collector)),
  ];
  return foldLeft("or", parts);
}

function visitAnd(cst: CstNode, collector: Collector): SpecNode {
  const parts = [
    ...nodes(cst, "lhs").map((n) => visitNot(n, collector)),
    ...nodes(cst, "rhs").map((n) => visitNot(n, collector)),
  ];
  return foldLeft("and", parts);
}

function foldLeft(kind: "and" | "or", parts: readonly SpecNode[]): SpecNode {
  const first = parts[0];
  if (first === undefined) throw new Error("parser bug: empty operand list");
  return parts.slice(1).reduce<SpecNode>((left, right) => ({ kind, left, right }), first);
}

function visitNot(cst: CstNode, collector: Collector): SpecNode {
  const inner = visitPrimary(only(cst, "primary"), collector);
  // §5 step 1: `not not x` → `x`. Folding here rather than in canonicalise keeps the AST free
  // of a shape that has no meaning of its own.
  return tokens(cst, "Not").length % 2 === 0 ? inner : { kind: "not", operand: inner };
}

function visitPrimary(cst: CstNode, collector: Collector): SpecNode {
  const combinator = nodes(cst, "combinator")[0];
  if (combinator !== undefined) return visitCombinator(combinator, collector);
  const grouped = nodes(cst, "grouped")[0];
  if (grouped !== undefined) return visitOr(grouped, collector);
  return visitComparison(only(cst, "comparison"), collector);
}

function visitCombinator(cst: CstNode, collector: Collector): SpecNode {
  const kind = tokens(cst, "All").length > 0 ? "and" : "or";
  const args = nodes(cst, "arg").map((n) => visitOr(n, collector));
  return foldLeft(kind, args);
}

// -------------------------------------------------------------------------------------------
// Comparisons
// -------------------------------------------------------------------------------------------

const OP_BY_TOKEN: Readonly<Record<string, CompareOp>> = {
  Equals: "==",
  NotEquals: "!=",
  GreaterEq: ">=",
  LessEq: "<=",
  Greater: ">",
  Less: "<",
  Contains: "contains",
  Matches: "matches",
  StartsWith: "starts_with",
  EndsWith: "ends_with",
};

function visitComparison(cst: CstNode, collector: Collector): SpecNode {
  const accessorCst = only(cst, "accessor");
  const resolved = visitAccessor(accessorCst, collector);
  const opCst = nodes(cst, "compOp")[0];

  if (opCst === undefined) {
    // §2: a bare accessor is legal only where the field is boolean-typed.
    if (resolved.def.type !== "bool" && resolved.def.type !== "json") {
      collector.add(
        issue(
          "type_error",
          `a bare accessor must be boolean, but this one is ${resolved.def.type}`,
          resolved.offset,
          resolved.length,
        ),
      );
    }
    if (resolved.def.type === "json") warnDynamicJson(collector, resolved);
    return { kind: "truthy", accessor: resolved.accessor };
  }

  const [opToken] = Object.entries(kids(opCst)).flatMap(([name, list]) =>
    list === undefined || list.length === 0 ? [] : [[name, list[0] as IToken] as const],
  );
  if (opToken === undefined) throw new Error("parser bug: compOp with no operator");
  const op = OP_BY_TOKEN[opToken[0]];
  if (op === undefined) throw new Error(`parser bug: unmapped operator ${opToken[0]}`);

  const rhsCst = nodes(cst, "rhs")[0];
  if (rhsCst === undefined) throw new Error("parser bug: comparison with an operator and no rhs");
  const right = visitOperand(rhsCst, collector);

  checkComparison(op, resolved, right, opToken[1], collector);
  return { kind: "compare", op, left: resolved.accessor, right };
}

function warnDynamicJson(collector: Collector, resolved: ResolvedAccessor): void {
  collector.warn({
    code: "dynamic_json_compare",
    message: ".json(...) has no static type; the comparison is resolved against what is observed",
    offset: resolved.offset,
    length: resolved.length,
  });
}

/**
 * §4.1's type table. `json` is the wildcard row — a JSON pointer's type is only known once
 * something has been observed — and every use of it warns rather than passing silently.
 */
function checkComparison(
  op: CompareOp,
  left: ResolvedAccessor,
  right: Operand,
  opToken: IToken,
  collector: Collector,
): void {
  const leftType = left.def.type;
  const rightType = operandType(right);
  const at = span(opToken);
  const reject = (message: string) => collector.add(issue("type_error", message, at.offset, at.length));

  // §4.3, and it has to happen BEFORE the `json` escape below. A glob that does not compile
  // is not a condition that is false — but `compareValue` has nowhere to put "uninterpretable"
  // and returns FALSE, which resolves the commitment `missed` without anything having been
  // evaluated (§6.1, I-7). `json` skips the type table, not the pattern check.
  if (op === "matches" && right.type === "string") {
    // The glob is compiled now, so a pattern that would blow the alternation cap is rejected
    // while the author is looking at it rather than when the probe runs.
    try {
      compileGlob(right.value);
    } catch (error: unknown) {
      if (!(error instanceof GlobError)) throw error;
      collector.add(issue("bad_argument", error.message, at.offset, at.length));
    }
  }

  if (leftType === "json") {
    warnDynamicJson(collector, left);
    return;
  }

  switch (op) {
    case "==":
    case "!=":
      if (!accepts(leftType, rightType)) {
        reject(`cannot compare ${leftType} with ${rightType}`);
      }
      break;

    case ">":
    case ">=":
    case "<":
    case "<=":
      if (leftType !== "int" && leftType !== "decimal" && leftType !== "version" && leftType !== "timestamp") {
        reject(`${op} needs an ordered left side, but this one is ${leftType}`);
      } else if (!accepts(leftType, rightType)) {
        reject(`cannot compare ${leftType} with ${rightType}`);
      }
      break;

    case "contains":
      if (leftType !== "string" && leftType !== "list") {
        reject(`contains needs a string or a list on the left, but this one is ${leftType}`);
      } else if (rightType !== "string") {
        reject(`contains needs a string on the right, but this one is ${rightType}`);
      }
      break;

    case "starts_with":
    case "ends_with":
    case "matches":
      if (leftType !== "string") {
        reject(`${op} needs a string on the left, but this one is ${leftType}`);
      } else if (rightType !== "string") {
        reject(`${op} needs a string on the right, but this one is ${rightType}`);
      }
      break;
  }

  // §4.1: a version literal that does not parse as semver falls back to string comparison,
  // where `"v0.10.0" > "v0.9.0"` is false. The composer shows this before you commit.
  if (right.type === "version" && right.compare === "string") {
    collector.warn({
      code: "string_version_compare",
      message: `"${right.value}" is not semver, so this comparison is textual: "v0.10.0" < "v0.9.0"`,
      offset: at.offset,
      length: at.length,
    });
  }
}

function operandType(operand: Operand): ValueType | "instant" {
  return operand.type === "instant" ? "instant" : operand.type;
}

/** Which operand types a field of each type will accept on the other side of a comparison. */
function accepts(field: ValueType, operand: ValueType | "instant"): boolean {
  switch (field) {
    case "int":
      return operand === "int";
    case "decimal":
      return operand === "decimal" || operand === "int";
    case "bool":
      return operand === "bool";
    case "string":
      return operand === "string";
    case "version":
      return operand === "version" || operand === "string";
    // §3.5: the two named instants are the only way to speak about time, so a timestamp field
    // compares against one of them or against a literal ISO string.
    case "timestamp":
      return operand === "instant" || operand === "string";
    case "list":
    case "json":
      return false;
  }
}

// -------------------------------------------------------------------------------------------
// Accessors
// -------------------------------------------------------------------------------------------

type ResolvedAccessor = {
  readonly accessor: Accessor;
  readonly def: FieldDef;
  readonly offset: number;
  readonly length: number;
};

type Segment = {
  readonly name: string;
  readonly args: readonly Operand[];
  readonly called: boolean;
  readonly token: IToken;
};

function visitAccessor(cst: CstNode, collector: Collector): ResolvedAccessor {
  const segments = nodes(cst, "segment").map((n) => visitSegment(n, collector));
  const first = segments[0];
  if (first === undefined) throw new Error("parser bug: accessor with no segments");
  const last = segments[segments.length - 1] as Segment;
  const offset = first.token.startOffset;
  const length = last.token.startOffset + last.token.image.length - offset;

  const { source, def, consumed } = resolveSource(segments, collector);
  const rest = segments.slice(consumed);

  const modifiers: Modifier[] = [];
  const seenModifiers = new Set<string>();
  let i = 0;
  while (i < rest.length) {
    const segment = rest[i] as Segment;
    const params = def.modifiers[segment.name];
    if (params === undefined || !segment.called) break;
    // Canonicalisation SORTS modifiers, so a repeated one loses its authored order — and with
    // it any answer to "which window did you mean?". `.since(commit_time).since(deadline)` and
    // `.since(deadline).since(commit_time)` would otherwise be one hash naming two different
    // windows, which is a commitment to A judged on B. Reject instead of picking a winner.
    if (seenModifiers.has(segment.name)) {
      collector.add(
        tokenIssue("bad_arity", `.${segment.name}() is given twice; it may only appear once`, segment.token),
      );
      throw new Abort();
    }
    seenModifiers.add(segment.name);
    modifiers.push({ name: segment.name as Modifier["name"], args: checkParams(segment, params, collector) });
    i += 1;
  }

  const fieldSegments = rest.slice(i);
  const head = fieldSegments[0];
  if (head === undefined) {
    collector.add(
      issue("unknown_field", `${source.kind} needs a field — see the catalogue in §3`, offset, length),
    );
    throw new Abort();
  }
  for (const segment of fieldSegments.slice(1)) {
    if (def.modifiers[segment.name] !== undefined) {
      collector.add(
        tokenIssue("unknown_call", `.${segment.name}() narrows the fetch and must come before the field, not after it`, segment.token),
      );
      throw new Abort();
    }
  }

  const path = fieldSegments.map((s) => s.name);
  const fieldDef = resolveFieldPath(source.kind, path);
  if (fieldDef === undefined) {
    collector.add(
      issue(
        "unknown_field",
        `${source.kind} has no field .${path.join(".")}`,
        head.token.startOffset,
        length - (head.token.startOffset - offset),
      ),
    );
    throw new Abort();
  }

  const field = buildField(path, fieldSegments, fieldDef, collector);
  return {
    accessor: { source, modifiers: sortModifiers(modifiers), field },
    def: fieldDef,
    offset,
    length,
  };
}

/**
 * `.header(name)` and `.json(pointer)` are the only parameterised reads (§3.1). Their argument
 * is validated by name rather than by the catalogue's generic `arg` kind, because "a string"
 * is not the constraint: a header outside the §6.2 whitelist is never stored and so could
 * never be evaluated, and a malformed JSON pointer would silently never resolve. Both are
 * better rejected while the author can still see them.
 */
function buildField(
  path: readonly string[],
  segments: readonly Segment[],
  def: FieldDef,
  collector: Collector,
): Field {
  const called = segments.filter((s) => s.called);
  const leaf = segments[segments.length - 1] as Segment;

  if (def.arg === undefined) {
    for (const segment of called) {
      collector.add(
        tokenIssue("bad_arity", `.${segment.name} takes no arguments`, segment.token),
      );
    }
    return { path: [...path] };
  }

  if (called.length !== 1 || called[0] !== leaf || leaf.args.length !== 1) {
    collector.add(
      tokenIssue("bad_arity", `.${leaf.name}(...) takes exactly one string argument`, leaf.token),
    );
    throw new Abort();
  }

  const [arg] = leaf.args;
  if (arg === undefined || arg.type !== "string") {
    collector.add(
      tokenIssue("bad_argument", `.${leaf.name}(...) takes a string argument`, leaf.token),
    );
    throw new Abort();
  }

  const at = span(leaf.token);
  try {
    if (leaf.name === "header") {
      const name = arg.value.toLowerCase();
      if (!(ALLOWED_HEADERS as readonly string[]).includes(name)) {
        collector.add(
          issue(
            "bad_argument",
            `.header("${arg.value}") is not readable — §6.2 allows only ${ALLOWED_HEADERS.join(", ")}`,
            at.offset,
            at.length,
          ),
        );
        throw new Abort();
      }
      return { path: [...path], arg: name };
    }
    return { path: [...path], arg: normaliseJsonPointer(arg.value) };
  } catch (error: unknown) {
    if (error instanceof Abort) throw error;
    if (!(error instanceof NormaliseError)) throw error;
    collector.add(issue("bad_argument", error.message, at.offset, at.length));
    throw new Abort();
  }
}

/**
 * §5 step 4 sorts commutative *operand pairs*; modifiers are keyword arguments, so their
 * authored order carries no meaning either and sorting them here means `.since(t).by(x)` and
 * `.by(x).since(t)` are one commitment rather than two.
 */
export function sortModifiers(modifiers: readonly Modifier[]): Modifier[] {
  return [...modifiers].sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    const left = JSON.stringify(a.args);
    const right = JSON.stringify(b.args);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function visitSegment(cst: CstNode, collector: Collector): Segment {
  const token = tokens(cst, "Identifier")[0];
  if (token === undefined) throw new Error("parser bug: segment with no identifier");
  return {
    name: token.image,
    args: nodes(cst, "arg").map((n) => visitOperand(n, collector)),
    called: tokens(cst, "LParen").length > 0,
    token,
  };
}

// -------------------------------------------------------------------------------------------
// Sources (§3) and their arguments (§5 step 2)
// -------------------------------------------------------------------------------------------

const ROOT_SOURCES = ["http", "npm", "crates", "pypi", "dns"] as const;

function resolveSource(
  segments: readonly Segment[],
  collector: Collector,
): { source: Source; def: SourceDef; consumed: number } {
  const first = segments[0] as Segment;

  const kind = (() => {
    if (first.name === "github") {
      const second = segments[1];
      if (second === undefined || !second.called) {
        collector.add(
          tokenIssue("unknown_source", "github needs a source: release, pr, issue, commits, file or workflow", first.token),
        );
        throw new Abort();
      }
      return `github.${second.name}`;
    }
    return first.name;
  })();

  const consumed = first.name === "github" ? 2 : 1;
  const carrier = segments[consumed - 1] as Segment;
  const def = sourceDef(kind);

  if (def === undefined || (consumed === 1 && !(ROOT_SOURCES as readonly string[]).includes(kind))) {
    collector.add(
      tokenIssue("unknown_source", `unknown source ${kind}`, carrier.token),
    );
    throw new Abort();
  }
  if (!carrier.called) {
    collector.add(
      tokenIssue("bad_arity", `${kind} is a source and must be called: ${kind}(...)`, carrier.token),
    );
    throw new Abort();
  }

  const args = checkParams(carrier, def.params, collector);
  return { source: buildSource(kind, args, carrier, collector), def, consumed };
}

function checkParams(segment: Segment, params: readonly Param[], collector: Collector): Operand[] {
  const at = span(segment.token);
  if (segment.args.length !== params.length) {
    collector.add(
      issue(
        "bad_arity",
        `${segment.name} takes ${params.length} argument(s), got ${segment.args.length}`,
        at.offset,
        at.length,
      ),
    );
    throw new Abort();
  }
  return params.map((param, i) => normaliseParam(param, segment.args[i] as Operand, at, collector));
}

function normaliseParam(
  param: Param,
  operand: Operand,
  at: { offset: number; length: number },
  collector: Collector,
): Operand {
  const bad = (message: string): never => {
    collector.add(issue("bad_argument", message, at.offset, at.length));
    throw new Abort();
  };

  try {
    switch (param.kind) {
      case "int":
        if (operand.type !== "int") return bad(`${param.name} must be an integer`);
        return operand;
      case "instant":
        if (operand.type !== "instant") return bad(`${param.name} must be commit_time or deadline`);
        return operand;
      case "url":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normaliseUrl(operand.value) };
      case "repo":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normaliseRepo(operand.value) };
      case "package":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normalisePackage(operand.value) };
      case "hostname":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normaliseHostname(operand.value) };
      case "path":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normalisePath(operand.value) };
      case "string":
        if (operand.type !== "string") return bad(`${param.name} must be a string`);
        return { type: "string", value: normaliseString(operand.value) };
    }
  } catch (error: unknown) {
    if (error instanceof Abort) throw error;
    if (!(error instanceof NormaliseError)) throw error;
    return bad(error.message);
  }
}

function buildSource(
  kind: string,
  args: readonly Operand[],
  carrier: Segment,
  collector: Collector,
): Source {
  const text = (i: number): string => {
    const arg = args[i];
    if (arg === undefined || arg.type !== "string") {
      collector.add(tokenIssue("bad_argument", `${kind} argument ${i + 1} must be a string`, carrier.token));
      throw new Abort();
    }
    return arg.value;
  };
  const number = (i: number): number => {
    const arg = args[i];
    if (arg === undefined || arg.type !== "int") {
      collector.add(tokenIssue("bad_argument", `${kind} argument ${i + 1} must be an integer`, carrier.token));
      throw new Abort();
    }
    return arg.value;
  };

  switch (kind) {
    case "http":
      return { kind: "http", url: text(0) };
    case "github.release":
      return { kind: "github.release", repo: text(0) };
    case "github.pr":
      return { kind: "github.pr", repo: text(0), number: number(1) };
    case "github.issue":
      return { kind: "github.issue", repo: text(0), number: number(1) };
    case "github.commits":
      return { kind: "github.commits", repo: text(0) };
    case "github.file":
      return { kind: "github.file", repo: text(0), path: text(1) };
    case "github.workflow":
      return { kind: "github.workflow", repo: text(0), workflow: text(1) };
    case "npm":
      return { kind: "npm", package: text(0) };
    case "crates":
      return { kind: "crates", package: text(0) };
    case "pypi":
      return { kind: "pypi", package: text(0) };
    case "dns":
      return { kind: "dns", name: text(0) };
    default:
      throw new Error(`parser bug: unhandled source ${kind}`);
  }
}

// -------------------------------------------------------------------------------------------
// Operands (§5 step 3)
// -------------------------------------------------------------------------------------------

function visitOperand(cst: CstNode, collector: Collector): Operand {
  const children = kids(cst);

  const string = tokens(cst, "StringLiteral")[0];
  if (string !== undefined) return literalString(string, collector);

  const version = tokens(cst, "VersionLiteral")[0];
  if (version !== undefined) {
    return {
      type: "version",
      value: version.image,
      // §5 step 3: the comparison MODE is decided here and stored, not inferred at eval time.
      compare: parseSemver(version.image) === null ? "string" : "semver",
    };
  }

  const decimal = tokens(cst, "DecimalLiteral")[0];
  if (decimal !== undefined) return literalDecimal(decimal, collector);

  const integer = tokens(cst, "IntegerLiteral")[0];
  if (integer !== undefined) return literalInt(integer, collector);

  if (children["True"] !== undefined) return { type: "bool", value: true };
  if (children["False"] !== undefined) return { type: "bool", value: false };

  const instant: Instant = {
    type: "instant",
    name: children["CommitTime"] !== undefined ? "commit_time" : "deadline",
  };
  if (children["CommitTime"] === undefined && children["Deadline"] === undefined) {
    throw new Error("parser bug: operand with no token");
  }
  return instant;
}

function literalString(token: IToken, collector: Collector): Literal {
  const at = span(token);
  try {
    return { type: "string", value: decodeStringLiteral(token.image) };
  } catch (error: unknown) {
    if (!(error instanceof NormaliseError)) throw error;
    collector.add(issue("bad_argument", error.message, at.offset, at.length));
    throw new Abort();
  }
}

/**
 * §5 step 3: "decimals to shortest round-tripping form". `Number::toString` reaches for
 * exponent notation outside roughly 1e-7…1e21, and the grammar's DecimalLiteral (`\d+\.\d+`)
 * cannot read one back — so `0.0000001` would print as `1e-7` and stop being a fixed point
 * (§5.1), and a 320-digit literal would become Infinity and make `hash` throw instead of
 * returning a diagnostic. Both are rejected at the token, where the author can see them.
 */
function literalDecimal(token: IToken, collector: Collector): Literal {
  const value = Number(token.image);
  if (!Number.isFinite(value) || !/^\d+(\.\d+)?$/.test(String(value))) {
    const at = span(token);
    collector.add(
      issue("bad_argument", `${token.image} is outside the range a decimal literal can represent`, at.offset, at.length),
    );
    throw new Abort();
  }
  return { type: "decimal", value };
}

function literalInt(token: IToken, collector: Collector): Literal {
  const value = Number(token.image);
  // §5 step 3 wants a JSON number. Beyond 2^53 one stops round-tripping, and a hash over a
  // number that changed on the way through is not a hash of what was written.
  if (!Number.isSafeInteger(value)) {
    const at = span(token);
    collector.add(issue("bad_argument", `${token.image} is too large to represent exactly`, at.offset, at.length));
    throw new Abort();
  }
  return { type: "int", value };
}
