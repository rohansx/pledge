/**
 * AST → DSL source. The other half of the fixed point.
 *
 * done-spec-dsl.md §5.1 requires `canonicalise(parse(s))` to be a fixed point: re-serialising
 * and re-parsing yields byte-identical output. That property is only testable if there is a
 * printer, and it is only *true* if the printer emits source that the lexer reads back as the
 * same tokens. Every choice below is in service of that:
 *
 *   · strings via `JSON.stringify`, which emits exactly the grammar's escape set (§2);
 *   · a decimal always carries a fractional part, so `2.0` does not come back as an integer;
 *   · parentheses wherever re-parsing would re-associate, because `(a and b) and c` and
 *     `a and (b and c)` are different ASTs and §5 step 1 left-associates rather than flattens.
 *
 * This is also what the composer and the profile render — the source text a reader inspects
 * when they click through from a kept badge (CLAUDE.md: never a badge without the spec source
 * one click away). It prints the canonical form, not what was typed, so what a reader sees is
 * what was hashed.
 */
import type { Accessor, Literal, Operand, SpecNode } from "./ast";

/** Binding power, loosest first. Mirrors the grammar's or_expr / and_expr / not_expr chain. */
const PRECEDENCE = { or: 1, and: 2, not: 3, leaf: 4 } as const;

function precedenceOf(node: SpecNode): number {
  switch (node.kind) {
    case "or":
      return PRECEDENCE.or;
    case "and":
      return PRECEDENCE.and;
    case "not":
      return PRECEDENCE.not;
    default:
      return PRECEDENCE.leaf;
  }
}

export function print(node: SpecNode): string {
  switch (node.kind) {
    case "and":
    case "or": {
      const op = node.kind;
      // The grammar is left-associative, so a child of the same kind on the RIGHT has to be
      // parenthesised or it re-parses into a different tree.
      const left = wrap(node.left, precedenceOf(node), false);
      const right = wrap(node.right, precedenceOf(node), true);
      return `${left} ${op} ${right}`;
    }
    case "not":
      return `not ${wrap(node.operand, PRECEDENCE.not, false)}`;
    case "compare":
      return `${printAccessor(node.left)} ${node.op} ${printOperand(node.right)}`;
    case "truthy":
      return printAccessor(node.accessor);
  }
}

function wrap(node: SpecNode, parent: number, rightOfSameLevel: boolean): string {
  const own = precedenceOf(node);
  const needed = own < parent || (rightOfSameLevel && own === parent);
  return needed ? `(${print(node)})` : print(node);
}

export function printAccessor(accessor: Accessor): string {
  const modifiers = accessor.modifiers
    .map((modifier) => `.${modifier.name}(${modifier.args.map(printOperand).join(", ")})`)
    .join("");
  const field = accessor.field.path.join(".");
  const arg = accessor.field.arg === undefined ? "" : `(${JSON.stringify(accessor.field.arg)})`;
  return `${printSource(accessor)}${modifiers}.${field}${arg}`;
}

function printSource(accessor: Accessor): string {
  const source = accessor.source;
  const q = JSON.stringify;
  switch (source.kind) {
    case "http":
      return `http(${q(source.url)})`;
    case "github.release":
    case "github.commits":
      return `${source.kind}(${q(source.repo)})`;
    case "github.pr":
    case "github.issue":
      return `${source.kind}(${q(source.repo)}, ${source.number})`;
    case "github.file":
      return `github.file(${q(source.repo)}, ${q(source.path)})`;
    case "github.workflow":
      return `github.workflow(${q(source.repo)}, ${q(source.workflow)})`;
    case "npm":
    case "crates":
    case "pypi":
      return `${source.kind}(${q(source.package)})`;
    case "dns":
      return `dns(${q(source.name)})`;
  }
}

export function printOperand(operand: Operand): string {
  return operand.type === "instant" ? operand.name : printLiteral(operand);
}

function printLiteral(literal: Literal): string {
  switch (literal.type) {
    case "string":
      return JSON.stringify(literal.value);
    case "int":
      return String(literal.value);
    case "decimal":
      // The lexer's DecimalLiteral is `\d+\.\d+`, so an integral decimal has to keep its
      // fractional part or it comes back as an int and the round-trip stops being a fixed point.
      return Number.isInteger(literal.value) ? `${literal.value}.0` : String(literal.value);
    case "bool":
      return literal.value ? "true" : "false";
    case "version":
      // Kept as authored (§5 step 3). It came from a VersionLiteral token, so it re-lexes as one.
      return literal.value;
  }
}
