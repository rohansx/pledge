/**
 * Target and field keys — re-exported from @pledge/spec, which owns them.
 *
 * These strings are the join between "what was observed" and "what the spec asked for": the
 * worker labels each Observation with `targetKey` and each entry of `values` with `fieldKey`,
 * and the evaluator looks both up by recomputing them. A key that differs by one character
 * makes every field read unresolvable, which the evaluator reports as `error` — I-7 held, and
 * nothing ever resolving. So there is exactly one implementation, in the package the evaluator
 * lives in, and this file exists only so the observation layer's imports read locally.
 *
 * They also end up in `probe_run.evidence` and therefore in a receipt, which is why they are
 * written the way a spec is written rather than hashed (done-spec-dsl.md §6.2).
 */
export { fieldKey, resolveInstant, sourceKey, targetKey } from "@pledge/spec";
