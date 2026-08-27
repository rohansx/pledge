/**
 * RFC 8785 JSON Canonicalisation Scheme.
 *
 * This decides which bytes get hashed into `done_spec.hash`, so it decides whether two
 * independent implementations agree about what a commitment *is*.
 *
 * DELIBERATE DUPLICATION of packages/ledger/src/canonical-json.ts. That module is correct and
 * this one mirrors it line for line, but @pledge/spec must not depend on another workspace
 * package that may grow a Node-only import (CLAUDE.md I-6): this file runs in the composer's
 * browser bundle and in `npx pledge-verify` with no database. Sixty lines duplicated is the
 * cheaper failure than a transitive `node:crypto` reaching a browser. If either copy changes,
 * both change — there is a conformance test against the official RFC 8785 vectors on each.
 *
 * WHY IT IS HAND-WRITTEN: JCS is specified so most of it falls out of ECMAScript.
 *   · numbers  — §3.2.2.3 defers to `Number::toString`, which is what `JSON.stringify` emits.
 *   · strings  — §3.2.2.2 mandates the shortest escape form, which is what `JSON.stringify`
 *                emits, and has been well-formed since ES2019.
 *   · key order — §3.2.3 sorts by UTF-16 code unit, which is what `<` on strings does.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: you cannot sort keys, rebuild the object and hand it to
 * `JSON.stringify`. JavaScript puts integer-like keys first in ascending numeric order however
 * you inserted them, so `{"1":…, "\r":…}` comes back with `"1"` first while JCS requires `"\r"`
 * first (U+000D < U+0031). Concatenating the output here is what makes the order we computed
 * the order we emit.
 */

/** Values JCS can represent. Anything else is rejected rather than coerced. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** `path` exists only for the error message; a failure deep in an AST is unreadable without one. */
function serialise(value: unknown, path: string): string {
  if (value === null) return "null";

  if (Array.isArray(value)) {
    // Array order is significant and preserved — JCS sorts objects, never arrays.
    return `[${value.map((item, i) => serialise(item, `${path}[${i}]`)).join(",")}]`;
  }

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);

    case "boolean":
      return value ? "true" : "false";

    case "number":
      // NaN and ±Infinity have no JSON form; JSON.stringify turns them into `null`, which
      // would make two different specs hash identically.
      if (!Number.isFinite(value)) throw new TypeError(`jcs: non-finite number at ${path}`);
      return JSON.stringify(value);

    case "object": {
      if (value instanceof Date) {
        throw new TypeError(`jcs: Date at ${path} — pass an explicit ISO 8601 string instead`);
      }
      const members = Object.entries(value as Record<string, unknown>)
        .map(([key, member]): readonly [string, unknown] => {
          // Dropping `undefined` silently is what makes `{a:1,b:undefined}` and `{a:1}` hash
          // the same. Refuse it: callers who mean "absent" omit the key.
          if (member === undefined) throw new TypeError(`jcs: undefined at ${path}.${key}`);
          return [key, member];
        })
        // RFC 8785 §3.2.3: sort by UTF-16 code unit. `<` on strings is exactly that.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => `${JSON.stringify(key)}:${serialise(member, `${path}.${key}`)}`);
      return `{${members.join(",")}}`;
    }

    default:
      throw new TypeError(`jcs: ${typeof value} is not JSON at ${path}`);
  }
}

/** The canonical UTF-8 serialisation of `value`. Deterministic across implementations. */
export function jcs(value: JsonValue): string {
  return serialise(value, "$");
}
