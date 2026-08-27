/**
 * The pure evaluator — done-spec-dsl.md §6.
 *
 * IT DOES NOT FETCH. The worker decides what was *observed*; this decides what the
 * observations *mean*. That split is what lets the same code run in the composer's browser
 * bundle and in `npx pledge-verify` against a receipt, with no network and no database
 * (CLAUDE.md I-6), and it is why the `error` boundary lives here rather than in the worker:
 * two places deciding it would eventually give two answers.
 *
 * §4.2: `and`/`or` are NOT short-circuiting at the fetch layer. That is the worker's business —
 * it collects every source the spec mentions, always — but it has a consequence here too:
 * every leaf is evaluated, even after the result is decided, because the subresults are the
 * evidence and a receipt that says "we stopped at the first failure" is worth much less than
 * one that says what each condition returned.
 *
 * ---------------------------------------------------------------------------------------
 * INVARIANT I-7, and §6.1's exception, are one mechanism
 * ---------------------------------------------------------------------------------------
 * A leaf whose source was not observed — or whose field could not be derived from what came
 * back — is `unknown`, never `false`. `unknown` propagates through Kleene's strong three-valued
 * logic, which has exactly the property §6.1 asks for: a formula evaluates to FALSE under
 * Kleene only if it is false under *every* assignment of its unknowns. So
 *
 *   · root FALSE   → the spec would fail even assuming every unobservable source returned its
 *                    most favourable value. That is §6.1's exception, and it is what stops an
 *                    adversary DoSing one source to escape a certain miss.
 *   · root TRUE, but some leaf unknown → `error`. §6.1 is explicit that `error` dominates a
 *                    would-be pass "regardless of whether the other conjuncts would have
 *                    decided it": nothing resolves `kept` on incomplete evidence.
 *   · root UNKNOWN → `error`.
 *
 * Kleene is a sound *under*-approximation — it calls `x or not x` unknown when a leaf is
 * unknown, where a SAT-complete check would call it true — and it errs towards `error`, which
 * is the safe direction. It is also fifteen lines.
 */
import type { Accessor, CompareOp, Operand, SpecNode } from "./ast";
import { type ValueType, resolveFieldPath } from "./catalogue";
import { compileGlob, globMatches } from "./glob";
import { type Instants, fieldKey, resolveInstant, targetKey } from "./keys";
import { compareVersions } from "./version";

/**
 * What a probe run hands over, structurally. Deliberately looser than the worker's own
 * `Observation`: this package must not know how a fetch failed, only that it did.
 *
 * A key present in `values` with the value `null` means the target answered and the field is
 * genuinely absent — a header that was not sent, a release that has no body. A key that is
 * MISSING means the field could not be derived from what came back, which is not an
 * observation at all (I-7).
 */
export type Observation =
  | {
      readonly source: string;
      readonly observed: true;
      readonly values: Readonly<Record<string, unknown>>;
    }
  | { readonly source: string; readonly observed: false };

export interface EvaluationInput extends Instants {
  readonly observations: readonly Observation[];
}

export interface Subresult {
  /** `$`, `$.left`, `$.left.right`, … — the path from the root of the canonical AST. */
  readonly nodePath: string;
  readonly value: boolean;
}

export interface Evaluation {
  readonly outcome: "pass" | "fail" | "error";
  /**
   * One entry per node that reached a definite answer, in pre-order. A node whose value is
   * unknown is omitted rather than given a third state: the receipt says what was decided,
   * and `outcome: "error"` says the rest could not be.
   */
  readonly subresults: readonly Subresult[];
}

/** Kleene's third value. `undefined` would be silently swallowed by `??`; this cannot be. */
const UNKNOWN = "unknown" as const;
type Tri = boolean | typeof UNKNOWN;

export function evaluate(node: SpecNode, input: EvaluationInput): Evaluation {
  const byKey = new Map<string, Observation>();
  for (const observation of input.observations) byKey.set(observation.source, observation);

  const subresults: Subresult[] = [];
  const root = walk(node, "$", byKey, input, subresults);

  if (root === false) return { outcome: "fail", subresults };
  if (root === true) return { outcome: "pass", subresults };
  return { outcome: "error", subresults };
}

function walk(
  node: SpecNode,
  path: string,
  byKey: ReadonlyMap<string, Observation>,
  instants: Instants,
  out: Subresult[],
): Tri {
  const value = ((): Tri => {
    switch (node.kind) {
      case "and": {
        // Both sides always, never short-circuited: the subresults are the evidence.
        const left = walk(node.left, `${path}.left`, byKey, instants, out);
        const right = walk(node.right, `${path}.right`, byKey, instants, out);
        if (left === false || right === false) return false;
        if (left === true && right === true) return true;
        return UNKNOWN;
      }
      case "or": {
        const left = walk(node.left, `${path}.left`, byKey, instants, out);
        const right = walk(node.right, `${path}.right`, byKey, instants, out);
        if (left === true || right === true) return true;
        if (left === false && right === false) return false;
        return UNKNOWN;
      }
      case "not": {
        const operand = walk(node.operand, `${path}.operand`, byKey, instants, out);
        return operand === UNKNOWN ? UNKNOWN : !operand;
      }
      case "compare":
        return leaf(node.left, byKey, instants, (observed, type) =>
          compareValue(node.op, observed, node.right, type, instants),
        );
      case "truthy":
        // A bare accessor is boolean-typed by the type check. `null` — the field is genuinely
        // absent — is FALSE, not unknown: "there is no release" is an observation.
        return leaf(node.accessor, byKey, instants, (observed) => observed === true);
    }
  })();

  if (value !== UNKNOWN) out.push({ nodePath: path, value });
  return value;
}

/**
 * The one place `unknown` is produced. Everything downstream of a successful read yields a
 * definite boolean — including a value the operator cannot interpret, which is FALSE rather
 * than unknown, because we *did* observe the target and what we saw does not satisfy the
 * condition. Returning `error` there would make a spec permanently unresolvable against a
 * server that answers perfectly well with something unexpected.
 */
function leaf(
  accessor: Accessor,
  byKey: ReadonlyMap<string, Observation>,
  instants: Instants,
  decide: (observed: unknown, type: ValueType | undefined) => boolean,
): Tri {
  const observation = byKey.get(targetKey(accessor, instants));
  if (observation === undefined || !observation.observed) return UNKNOWN;

  const key = fieldKey(accessor.field);
  if (!Object.hasOwn(observation.values, key)) return UNKNOWN;

  return decide(observation.values[key], resolveFieldPath(accessor.source.kind, accessor.field.path)?.type);
}

// -------------------------------------------------------------------------------------------
// Operators (§4.1)
// -------------------------------------------------------------------------------------------

function compareValue(
  op: CompareOp,
  observed: unknown,
  right: Operand,
  type: ValueType | undefined,
  instants: Instants,
): boolean {
  switch (op) {
    case "==":
      return equal(observed, right, type, instants);
    case "!=":
      return !equal(observed, right, type, instants);
    case ">":
    case ">=":
    case "<":
    case "<=": {
      const ordering = order(observed, right, type, instants);
      if (ordering === undefined) return false;
      return op === ">"
        ? ordering > 0
        : op === ">="
          ? ordering >= 0
          : op === "<"
            ? ordering < 0
            : ordering <= 0;
    }
    case "contains":
      if (typeof observed === "string") return right.type === "string" && observed.includes(right.value);
      // §3.4/§3.2: `.a`, `.txt` and `.label_names` are lists, compared with `contains`.
      if (Array.isArray(observed)) {
        return right.type === "string" && (observed as readonly unknown[]).includes(right.value);
      }
      return false;
    case "starts_with":
      return typeof observed === "string" && right.type === "string" && observed.startsWith(right.value);
    case "ends_with":
      return typeof observed === "string" && right.type === "string" && observed.endsWith(right.value);
    case "matches":
      // The pattern was compiled once already, at parse time, so a GlobError cannot reach here
      // for a spec that came through `parse`. One that arrived some other way is not a match.
      if (typeof observed !== "string" || right.type !== "string") return false;
      try {
        return globMatches(compileGlob(right.value), observed);
      } catch {
        return false;
      }
  }
}

function equal(
  observed: unknown,
  right: Operand,
  type: ValueType | undefined,
  instants: Instants,
): boolean {
  // A timestamp field is an ISO string on the wire, so equality on it is equality of instants
  // and not of spelling: `...T12:00:00Z` and `...T12:00:00.000+00:00` are the same moment.
  if (right.type === "instant" || type === "timestamp") {
    return order(observed, right, type, instants) === 0;
  }
  switch (right.type) {
    case "version":
      return typeof observed === "string" && compareVersions(observed, right.value, right.compare) === 0;
    case "string":
      return typeof observed === "string" && observed === right.value;
    case "int":
    case "decimal":
      return typeof observed === "number" && observed === right.value;
    case "bool":
      return observed === right.value;
  }
}

/** `undefined` means "these two are not orderable", which every ordering operator reads as false. */
function order(
  observed: unknown,
  right: Operand,
  type: ValueType | undefined,
  instants: Instants,
): number | undefined {
  const left = right.type === "instant" || type === "timestamp" ? millis(observed) : undefined;

  if (right.type === "instant") {
    // Comparing a field we could not read as a time against an instant is a category error,
    // not an ordering — and `published_at` being null IS the observation that there is none.
    return left === undefined ? undefined : sign(left - resolveInstant(right.name, instants).getTime());
  }
  if (type === "timestamp") {
    const rightMillis = right.type === "string" ? millis(right.value) : undefined;
    return left === undefined || rightMillis === undefined ? undefined : sign(left - rightMillis);
  }
  if (right.type === "version") {
    return typeof observed === "string" ? compareVersions(observed, right.value, right.compare) : undefined;
  }
  if (right.type === "int" || right.type === "decimal") {
    return typeof observed === "number" && Number.isFinite(observed) ? sign(observed - right.value) : undefined;
  }
  return undefined;
}

/** ISO 8601 string → epoch millis. Anything else, `null` included, is not a time. */
function millis(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function sign(delta: number): number {
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}
