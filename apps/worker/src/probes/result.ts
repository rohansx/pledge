/**
 * The only two ways to build a ProbeResult.
 *
 * INVARIANT I-7 lives here as a shape, not as a convention:
 *
 *   observed()    — we reached the target. It decides pass vs fail from a boolean the caller
 *                   computed from what came back. It cannot produce `error`.
 *   notObserved() — we did not reach the target. It always produces `error`, and there is no
 *                  argument that lets a caller ask for anything else.
 *
 * A probe therefore cannot accidentally turn "the DNS lookup failed" into "the done-condition
 * is false" without deleting one of these functions. Collapsing the two would mark people as
 * having missed because of a network blip — the most reputation-destroying bug this product
 * could ship (architecture.md §8, technical-spec §6).
 *
 * v1 keeps the property as the surface grows. The observation layer (../observe) applies the
 * same discipline one level down, per source: its Observation type has an observed shape with
 * no error field and an unobserved shape with no values, so a source added later cannot invent
 * a third answer. Every new source routes through it, and through these two functions.
 */
import {
  EVIDENCE_HEADER_ALLOWLIST,
  type ProbeEvidence,
  type ProbeKind,
  type ProbeResult,
} from "@pledge/db/types";

/** Reasons we could not observe. Mirrors ProbeEvidence["error"]["code"]. */
export type ObservationErrorCode = NonNullable<ProbeEvidence["error"]>["code"];

export interface Timing {
  /** `Date.now()`-style value captured before the request went out. */
  readonly startedAtMs: number;
  /** Injected clock so tests can pin `ran_at`. Postgres clamps it on insert anyway. */
  readonly now: () => Date;
}

/**
 * The target answered. `conditionHolds` is the done-condition evaluated against what it said.
 *
 * `matches` on the evidence is the value that satisfied the condition, verbatim — a badge is
 * worthless if the thing it is derived from is not inspectable (CLAUDE.md, copy rules).
 */
export function observed(
  probeKind: ProbeKind,
  conditionHolds: boolean,
  evidence: ProbeEvidence,
  timing: Timing,
): ProbeResult {
  return {
    probeKind,
    outcome: conditionHolds ? "pass" : "fail",
    evidence,
    ranAt: timing.now(),
    durationMs: Math.max(0, Date.now() - timing.startedAtMs),
  };
}

/**
 * The target could not be observed. Always `error`, never `fail`.
 *
 * Whatever partial facts we do have (a resolved IP, an upstream status) still go into the
 * evidence — they are facts about the failure, not evidence about the done-condition.
 */
export function notObserved(
  probeKind: ProbeKind,
  code: ObservationErrorCode,
  message: string,
  partial: Omit<ProbeEvidence, "error" | "matches">,
  timing: Timing,
): ProbeResult {
  return {
    probeKind,
    outcome: "error",
    evidence: { ...partial, error: { code, message } },
    ranAt: timing.now(),
    durationMs: Math.max(0, Date.now() - timing.startedAtMs),
  };
}

/**
 * Response headers from a third party are a PII surface with no upside, so only the
 * allowlisted ones survive into evidence. @pledge/safe-fetch already does this for `http`
 * targets; the GitHub probe does not go through safe-fetch, so it filters here.
 */
export function allowlistHeaders(
  headers: Iterable<readonly [string, string]>,
): Record<string, string> {
  const allowed = new Set<string>(EVIDENCE_HEADER_ALLOWLIST);
  const kept: Record<string, string> = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (allowed.has(key)) kept[key] = value;
  }
  return kept;
}
