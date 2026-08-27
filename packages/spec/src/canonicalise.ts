/**
 * done-spec-dsl.md §5 — canonicalisation and the hash. **This section is normative and any
 * deviation is a breaking change.** The hash is the contract; if it changes, every stored
 * commitment silently becomes a different commitment (CLAUDE.md I-4).
 *
 * The seven steps, and where each one happens:
 *
 *   1. Desugar `all()`/`any()` to nested binary and/or, left-associated; fold `not not`.
 *                                                     → visit.ts, at CST→AST time
 *   2. Normalise sources.                             → visit.ts (normalise.ts), at parse time
 *   3. Normalise literals.                            → visit.ts (normalise.ts), at parse time
 *   4. Sort commutative operand pairs — and/or ONLY.  → here, `canonicalise`
 *   5. Drop `dsl_source`.                             → here, by construction: `toJson` emits
 *                                                        the AST and the AST has no source text
 *   6. Serialise with RFC 8785 JCS.                   → here, `canonicalJson`
 *   7. sha256("pledge.donespec.v1\x00" || bytes).     → here, `hash`
 *
 * Steps 2 and 3 run at parse time so a rejection still has a token offset to point at. That
 * makes `canonicalise` total on an already-parsed AST — it never fails, it only reorders —
 * which is what lets the verifier re-hash a spec loaded from a receipt with no parser in play.
 *
 * WHY COMPARISON OPERANDS ARE NOT SORTED (§5 step 4): `x > 5` and `5 < x` are different ASTs
 * by design. Normalising them would make the error messages incomprehensible — a probe that
 * reports "5 < status was false" is telling the author about a spec they did not write. Only
 * the two operands of `and`/`or` are commutative, and only those are ordered.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { Accessor, Field, Modifier, Operand, Source, SpecNode } from "./ast";
import { type JsonValue, jcs } from "./jcs";
import { sortModifiers } from "./visit";

/**
 * §5 step 7. The domain-separation prefix means a done-spec hash can never be confused with a
 * ledger payload hash or a receipt hash, even if the JSON happened to coincide.
 */
const DOMAIN = "pledge.donespec.v1\u0000";

/**
 * §5 steps 1 and 4. Idempotent: `canonicalise(canonicalise(x))` is `canonicalise(x)`, which is
 * half of why the round-trip is a fixed point.
 */
export function canonicalise(node: SpecNode): SpecNode {
  switch (node.kind) {
    case "and":
    case "or": {
      const left = canonicalise(node.left);
      const right = canonicalise(node.right);
      // "order the two operands by their own canonical serialisation" — literally that, so the
      // ordering is decided by the same bytes that get hashed and not by some proxy for them.
      // ponytail: re-serialises each subtree on every comparison, O(n²) on tree depth. A spec
      // is capped at 4000 characters, so this is microseconds; memoise if that cap ever moves.
      return jcs(toJson(left)) <= jcs(toJson(right))
        ? { kind: node.kind, left, right }
        : { kind: node.kind, left: right, right: left };
    }
    case "not": {
      const operand = canonicalise(node.operand);
      // Folding here too, so an AST that arrived from somewhere other than the parser gets the
      // same treatment as one that came through it.
      return operand.kind === "not" ? operand.operand : { kind: "not", operand };
    }
    case "compare":
      return { kind: "compare", op: node.op, left: canonicalAccessor(node.left), right: node.right };
    case "truthy":
      return { kind: "truthy", accessor: canonicalAccessor(node.accessor) };
  }
}

function canonicalAccessor(accessor: Accessor): Accessor {
  return {
    source: accessor.source,
    modifiers: sortModifiers(accessor.modifiers),
    field: accessor.field,
  };
}

/**
 * §5 step 5, by construction: this is the complete list of what is hashed, and `dsl_source` is
 * not on it. Written out longhand rather than reflected off the object so that adding a field
 * to the AST cannot silently change every existing hash — a new key here is a spec_version
 * bump (§8), and it has to be typed to happen.
 *
 * `Field.arg` is omitted when absent rather than emitted as `null`: JCS refuses `undefined`,
 * and `{"path":["status"]}` and `{"path":["status"],"arg":null}` must not be two spellings of
 * one spec.
 */
export function toJson(node: SpecNode): JsonValue {
  switch (node.kind) {
    case "and":
    case "or":
      return { kind: node.kind, left: toJson(node.left), right: toJson(node.right) };
    case "not":
      return { kind: "not", operand: toJson(node.operand) };
    case "compare":
      return {
        kind: "compare",
        op: node.op,
        left: accessorJson(node.left),
        right: operandJson(node.right),
      };
    case "truthy":
      return { kind: "truthy", accessor: accessorJson(node.accessor) };
  }
}

function accessorJson(accessor: Accessor): JsonValue {
  return {
    source: sourceJson(accessor.source),
    modifiers: sortModifiers(accessor.modifiers).map(modifierJson),
    field: fieldJson(accessor.field),
  };
}

function sourceJson(source: Source): JsonValue {
  switch (source.kind) {
    case "http":
      return { kind: source.kind, url: source.url };
    case "github.release":
    case "github.commits":
      return { kind: source.kind, repo: source.repo };
    case "github.pr":
    case "github.issue":
      return { kind: source.kind, repo: source.repo, number: source.number };
    case "github.file":
      return { kind: source.kind, repo: source.repo, path: source.path };
    case "github.workflow":
      return { kind: source.kind, repo: source.repo, workflow: source.workflow };
    case "npm":
    case "crates":
    case "pypi":
      return { kind: source.kind, package: source.package };
    case "dns":
      return { kind: source.kind, name: source.name };
  }
}

function modifierJson(modifier: Modifier): JsonValue {
  return { name: modifier.name, args: modifier.args.map(operandJson) };
}

function fieldJson(field: Field): JsonValue {
  return field.arg === undefined
    ? { path: [...field.path] }
    : { path: [...field.path], arg: field.arg };
}

function operandJson(operand: Operand): JsonValue {
  switch (operand.type) {
    case "instant":
      return { type: "instant", name: operand.name };
    case "version":
      // The comparison mode is part of what was promised (§5 step 3), so it is part of the
      // hash. Two specs that read identically but resolve `>=` differently are two specs.
      return { type: "version", value: operand.value, compare: operand.compare };
    case "string":
    case "int":
    case "decimal":
    case "bool":
      return { type: operand.type, value: operand.value };
  }
}

/** §5 step 6. The exact bytes that get hashed. */
export function canonicalJson(node: SpecNode): string {
  return jcs(toJson(canonicalise(node)));
}

/** §5 step 7. Lowercase hex, the form `done_spec.hash` stores. */
export function hash(node: SpecNode): string {
  return bytesToHex(sha256(utf8ToBytes(DOMAIN + canonicalJson(node))));
}
