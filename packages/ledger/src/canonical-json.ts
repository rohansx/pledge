/**
 * RFC 8785 JSON Canonicalisation Scheme (JCS).
 *
 * This is the function that decides what bytes get hashed and signed, so it is the function
 * that decides whether a receipt verifies on someone else's machine three years from now.
 * Two independent implementations must agree byte for byte or the whole verification story
 * is theatre.
 *
 * WHY THIS IS HAND-WRITTEN AND NOT A DEPENDENCY
 * ---------------------------------------------
 * JCS is deliberately specified so that most of it falls out of ECMAScript primitives:
 *
 *   · number formatting  — RFC 8785 §3.2.2.3 defers to ECMAScript `Number::toString`, which
 *                          is exactly what `JSON.stringify` emits for a number.
 *   · string escaping    — RFC 8785 §3.2.2.2 mandates the shortest form (\b \t \n \f \r \" \\
 *                          then lowercase \u00xx), which is exactly what `JSON.stringify`
 *                          emits for a string, and has since ES2019 been well-formed.
 *   · object key order   — RFC 8785 §3.2.3 sorts by UTF-16 code unit, which is exactly what
 *                          JavaScript's `<` on strings does.
 *
 * So leaves delegate to `JSON.stringify` and objects are emitted here.
 *
 * THE TRAP THIS FILE EXISTS TO AVOID: you cannot sort keys, rebuild the object, and hand it
 * to `JSON.stringify`. JavaScript objects put integer-like keys first in ascending numeric
 * order no matter what order you inserted them in, so `{"1":…, "\r":…}` comes back out with
 * `"1"` first while JCS requires `"\r"` first (U+000D < U+0031). The sort would silently do
 * nothing for exactly the payloads where it matters. Concatenating the output ourselves is
 * what makes the order we computed the order we emit. There is a test for this.
 *
 * NOTE ON DUPLICATION: packages/db/src/done-spec-hash.ts has a similar `canonicalise` — and
 * has that bug, harmlessly, because no v0 spec has a numeric key. It is deliberately not
 * refactored to call this one: its output is a stored primary key, and changing a hash means
 * changing what a commitment *is* (CLAUDE.md I-4). @pledge/spec should adopt this module when
 * it takes over spec hashing for v1.
 */

/** Values JCS can represent. Anything else is rejected rather than coerced. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * `path` exists only for the error message: a canonicalisation failure deep inside a probe
 * evidence object is unreadable without one.
 */
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
      // NaN and ±Infinity have no JSON representation; JSON.stringify turns them into `null`,
      // which would make two different payloads hash identically.
      if (!Number.isFinite(value)) {
        throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      }
      return JSON.stringify(value);

    case "object": {
      // A Date here is almost always a mistake: JSON.stringify would call toJSON() and the
      // caller would never learn that the ledger recorded a string. Timestamps enter a
      // payload as explicit ISO strings, at the call site, visibly.
      if (value instanceof Date) {
        throw new TypeError(
          `canonicalJson: Date at ${path} — pass an explicit ISO 8601 string instead`,
        );
      }
      const members = Object.entries(value as Record<string, unknown>)
        .map(([key, member]): readonly [string, unknown] => {
          // `undefined` is not a JSON value. Dropping it silently is what makes
          // `{a: 1, b: undefined}` and `{a: 1}` hash the same, so refuse it instead:
          // callers who mean "absent" omit the key.
          if (member === undefined) {
            throw new TypeError(
              `canonicalJson: undefined at ${path}.${key} — omit the key instead`,
            );
          }
          return [key, member];
        })
        // RFC 8785 §3.2.3: sort by UTF-16 code unit. `<` on strings is exactly that.
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, member]) => `${JSON.stringify(key)}:${serialise(member, `${path}.${key}`)}`);
      return `{${members.join(",")}}`;
    }

    default:
      // undefined, function, symbol, bigint. bigint would throw in JSON.stringify anyway;
      // the rest would vanish.
      throw new TypeError(`canonicalJson: ${typeof value} is not JSON at ${path}`);
  }
}

/** The canonical UTF-8 serialisation of `value`. Deterministic across implementations. */
export function canonicalJson(value: JsonValue): string {
  return serialise(value, "$");
}
