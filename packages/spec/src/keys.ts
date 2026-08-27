/**
 * Stable keys for one fetch and for one field read.
 *
 * These strings are the join between "what was observed" and "what the spec asked for". The
 * worker labels each Observation with `targetKey(...)` and each entry of `values` with
 * `fieldKey(...)`; the evaluator looks both up by recomputing them. They also end up in
 * `probe_run.evidence` and therefore in a receipt, so they are written the way the spec is
 * written — `github.commits:o/r+since=2026-09-01T00:00:00.000Z` reads back as the accessor a
 * human authored (done-spec-dsl.md §6.2 uses exactly this shape).
 *
 * This is the ONLY implementation. apps/worker/src/observe/keys.ts is a re-export of this
 * module and exists only so the observation layer's imports read locally — two implementations
 * would be free to drift, and a key that differs by one character makes every field read
 * unresolvable, which the evaluator reports as `error`: I-7 held, and nothing ever resolving.
 *
 * A modifier segment is `+name=value`, concatenated with NO escaping, because §6.2 wants a key
 * that reads back as the accessor a human authored. The values are kept separator-free instead,
 * at parse time (`normaliseKeyArgument`), and that restriction is what makes this format
 * injective. Loosening the charset without escaping here lets two specs name one observation.
 */
import type { Accessor, Field, InstantName, Modifier, Operand, Source } from "./ast";

/** Resolved named instants (§3.5). `deadline` is the ORIGINAL deadline, never the amended one. */
export interface Instants {
  readonly commitTime: Date;
  readonly deadline: Date;
}

export function resolveInstant(name: InstantName, instants: Instants): Date {
  return name === "commit_time" ? instants.commitTime : instants.deadline;
}

/** `["text","length"]` → `text.length`; `["header"]` + `"etag"` → `header("etag")`. */
export function fieldKey(field: Field): string {
  const path = field.path.join(".");
  return field.arg === undefined ? path : `${path}(${JSON.stringify(field.arg)})`;
}

function operandKey(operand: Operand, instants: Instants): string {
  if (operand.type === "instant") return resolveInstant(operand.name, instants).toISOString();
  return String(operand.value);
}

/**
 * Modifiers are keyword arguments, so their authored order is noise and canonicalisation has
 * already sorted them. Sorting again costs nothing and means the key does not depend on having
 * been handed a canonical AST.
 *
 * `+`, `=` and `,` are structural here and cannot appear in a value — see normalise.ts's
 * KEY_SAFE. If that ever stops being true, this function has to escape, and escaping changes
 * the evidence shape §6.2 pins.
 */
function modifierKey(modifiers: readonly Modifier[], instants: Instants): string {
  return [...modifiers]
    .map((m) => `+${m.name}=${m.args.map((a) => operandKey(a, instants)).join(",")}`)
    .sort()
    .join("");
}

export function sourceKey(source: Source): string {
  switch (source.kind) {
    case "http":
      return `http:${source.url}`;
    case "github.release":
    case "github.commits":
      return `${source.kind}:${source.repo}`;
    case "github.pr":
    case "github.issue":
      return `${source.kind}:${source.repo}#${source.number}`;
    case "github.file":
      return `github.file:${source.repo}:${source.path}`;
    case "github.workflow":
      return `github.workflow:${source.repo}:${source.workflow}`;
    case "npm":
    case "crates":
    case "pypi":
      return `${source.kind}:${source.package}`;
    case "dns":
      return `dns:${source.name}`;
  }
}

/** One distinct fetch: the source, narrowed by whatever modifiers the accessor carried. */
export function targetKey(accessor: Accessor, instants: Instants): string {
  return `${sourceKey(accessor.source)}${modifierKey(accessor.modifiers, instants)}`;
}
