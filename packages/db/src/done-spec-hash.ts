/**
 * Content-addressing for done-specs (CLAUDE.md I-4).
 *
 * `done_spec.hash` is the contract. Any change to a spec yields a different hash and is
 * therefore a different commitment — you cannot silently redefine done. This module is the
 * only thing permitted to produce that value.
 */
import { createHash } from "node:crypto";
import { DoneSpecV0Schema, type DoneSpecV0 } from "./types";

/**
 * Canonical form: object keys sorted, no insignificant whitespace.
 *
 * v1 replaces this with RFC 8785 JCS once the DSL lands. For the v0 shapes — flat objects of
 * strings and small integers — sorted-key `JSON.stringify` and JCS produce identical bytes,
 * so nothing has to be rehashed at that point. Anything with a float or a non-ASCII escape
 * would diverge; the v0 schemas admit neither.
 */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalise(v)]),
    );
  }
  return value;
}

export function canonicalDoneSpecJson(spec: DoneSpecV0): string {
  return JSON.stringify(canonicalise(spec));
}

/**
 * Validates then hashes. Validation is not optional: the spec arrives from a user-submitted
 * form (zone 1 → 2, architecture.md §4), and hashing an unvalidated shape would content-
 * address garbage.
 *
 * @returns the parsed spec and its lowercase hex sha256 — pass both to `insertCommitment`.
 */
export function hashDoneSpec(input: unknown): { spec: DoneSpecV0; hash: string } {
  const spec = DoneSpecV0Schema.parse(input);
  const hash = createHash("sha256").update(canonicalDoneSpecJson(spec), "utf8").digest("hex");
  return { spec, hash };
}
