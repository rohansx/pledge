/**
 * The novelty digest (done-spec-dsl.md §6.3).
 *
 * DEVIATION, deliberate: §6.3 says `body_sha256`, and this hashes the *values the spec reads*
 * instead. For `http` the two are equivalent — `.text` is the body. For every other source the
 * raw response is a GitHub or registry JSON document carrying star counts, download totals and
 * a server-side `updated_at`, so a body hash would differ on every run and the flag would never
 * fire for the sources it matters most for. Hashing the read values asks the question §6.3
 * actually wants asked: has anything the promise depends on changed since it was made?
 *
 * A source that could not be observed contributes `null` rather than being skipped, so a run
 * cannot come out "unchanged" by virtue of having seen less than the baseline did.
 *
 * The flag it feeds does NOT change an outcome. It is rendered next to the commitment, because
 * "this passed against a page that has not changed one byte since you promised to build it" is
 * information the reader deserves and pledge should not silently swallow.
 */
import { createHash } from "node:crypto";
import { canonicalJson, type JsonValue } from "@pledge/ledger";
import type { Observation } from "./types";

export function targetDigest(observations: readonly Observation[]): string {
  const perSource: Record<string, JsonValue> = {};
  for (const observation of observations) {
    perSource[observation.source] = observation.observed
      ? sha256(canonicalJson(jsonSafe(observation.values)))
      : null;
  }
  return sha256(canonicalJson(perSource));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** jsonb drops `undefined`; canonicalJson refuses it. Round-trip so both agree. */
function jsonSafe(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
