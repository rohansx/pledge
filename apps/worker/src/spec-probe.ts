/**
 * A v1 probe run: load a done-spec AST, observe every distinct source once, hand the
 * observations to the pure evaluator, and turn the verdict into a ProbeResult.
 *
 * The division of labour matters and is not negotiable:
 *
 *   @pledge/spec   decides what the observations MEAN. Pure, browser-safe, no database, no
 *                  network (CLAUDE.md I-6). It is the same code `npx pledge-verify` runs.
 *   this worker    decides what was OBSERVED. All the I/O, none of the semantics.
 *
 * Which is also why the evaluator, not this file, owns the `error` boundary: an unobservable
 * source is handed over as an unobservable source, and the evaluator applies §6.1's rule
 * (including the one exception — a spec that would be `fail` even if the unobservable source
 * had returned its most favourable value IS a fail, so an adversary cannot DoS one source to
 * escape a certain miss). Re-deciding that here would give us two answers to the same
 * question.
 */
import { evaluate, SpecNodeSchema } from "@pledge/spec";
import type { ProbeEvidence, ProbeKind, ProbeResult } from "@pledge/db/types";
import {
  collectTargets,
  observeAll,
  targetDigest,
  type Observation,
  type ObserveContext,
  type ObserveDeps,
} from "./observe";
import { notObserved, observed, type Timing } from "./probes/result";

/**
 * BLOCKED ON packages/db — see the return note. `probeKinds` and the `probe_run_kind_known`
 * CHECK still admit only the two v0 kinds, so `"spec"` needs one additive migration and one
 * array entry before a v1 run can be written. The cast is the boundary marker, not a
 * workaround: nothing else in this file pretends the value is already legal.
 */
export const SPEC_PROBE_KIND = "spec" as ProbeKind;

/**
 * The v1 evidence record (done-spec-dsl.md §6.2), which is `ProbeEvidence` plus the per-source
 * detail a multi-source spec needs.
 *
 * It is a structural EXTENSION rather than an edit to `ProbeEvidenceSchema`: `probe_run.evidence`
 * is jsonb with no CHECK, so the extra keys store and round-trip cleanly, and the ledger's
 * `evidenceSha256` covers them because it hashes the whole object. apps/web renders the v0
 * subset and ignores the rest until it learns about them.
 */
export interface SpecProbeEvidence extends ProbeEvidence {
  readonly specVersion: number;
  /** One per distinct source, in the order the AST first mentions them. */
  readonly observations: readonly Observation[];
  readonly subresults: readonly { readonly nodePath: string; readonly value: boolean }[];
  /**
   * done-spec-dsl.md §6.3. Present only on a passing run, because "unchanged" is only
   * interesting when something passed against it. It does NOT change the outcome — it is
   * rendered next to the commitment, because "this passed against a page that has not changed
   * one byte since you promised to build it" is information the reader deserves.
   */
  readonly unchangedSinceCommitment?: boolean;
  /** This run's target digest. Compared against `commitment.baseline_sha256`. */
  readonly targetDigest: string;
}

export interface SpecProbeInput {
  /**
   * The stored `done_spec.ast`, unvalidated. It is jsonb holding user-authored content and the
   * worker is the tier that must not trust its inputs, so it is parsed here — once, by the
   * package that defines what a legal AST is (CLAUDE.md I-4, I-6).
   */
  readonly ast: unknown;
  readonly commitTime: Date;
  /** The ORIGINAL deadline. `deadline` in a spec never means the amended one (§3.5). */
  readonly deadline: Date;
  /**
   * Resolves the baseline in force for this commitment, capturing THIS run's digest if none
   * was stored yet (done-spec-dsl.md §6.3 captures a baseline at commit time, and the first
   * probe of a commitment IS at commit time — apps/web enqueues it inside the commit
   * transaction). Returns null when there is still no baseline, which means "we cannot say".
   *
   * Injected rather than done by the caller afterwards so the digest is computed, stored and
   * compared in one place: a flag patched onto the evidence after the fact is a flag that can
   * disagree with the digest sitting next to it.
   */
  readonly baseline: (runDigest: string) => Promise<string | null>;
}

export async function runSpecProbe(
  input: SpecProbeInput,
  deps: ObserveDeps,
  timing: Timing,
): Promise<ProbeResult> {
  const ctx: ObserveContext = {
    commitTime: input.commitTime,
    deadline: input.deadline,
    now: timing.now,
  };

  const ast = SpecNodeSchema.parse(input.ast);
  const requests = collectTargets(ast, ctx);
  const observations = await observeAll(requests, deps, ctx);
  const evaluation = evaluate(ast, {
    observations,
    commitTime: ctx.commitTime,
    deadline: ctx.deadline,
  });

  const digest = targetDigest(observations);
  const base = {
    specVersion: 1,
    observations,
    subresults: evaluation.subresults,
    targetDigest: digest,
    ...singleSourceEvidence(observations),
  } satisfies Omit<SpecProbeEvidence, "unchangedSinceCommitment">;

  if (evaluation.outcome === "error") {
    const cause = observations.find((o) => !o.observed);
    return notObserved(
      SPEC_PROBE_KIND,
      cause?.observed === false ? cause.error.code : "unexpected",
      cause?.observed === false
        ? `${cause.source}: ${cause.error.message}`
        : "the done-spec could not be evaluated against what was observed",
      base,
      timing,
    );
  }

  const holds = evaluation.outcome === "pass";
  // The baseline is recorded even on a `fail`: it is what this target looked like before the
  // work, and capturing it only on success would mean the first passing run is always its own
  // baseline and the flag could never be false.
  const baseline = await input.baseline(digest);
  return observed(
    SPEC_PROBE_KIND,
    holds,
    {
      ...base,
      // Only meaningful on a pass, and only decidable when a baseline exists. A missing
      // baseline means "we cannot say" — never "unchanged" (schema.ts, baseline columns).
      ...(holds && baseline !== null ? { unchangedSinceCommitment: digest === baseline } : {}),
    },
    timing,
  );
}

/**
 * A single-source spec fills the v0 evidence fields too, so the existing commitment page keeps
 * rendering a status and a body hash without knowing about v1. A multi-source spec leaves them
 * empty rather than picking a winner: there is no one status, and inventing one would put a
 * number on a receipt that no single observation supports.
 */
function singleSourceEvidence(observations: readonly Observation[]): ProbeEvidence {
  const [only] = observations;
  if (observations.length !== 1 || only === undefined || !only.observed) return {};
  return {
    ...(only.evidence.status === undefined ? {} : { status: only.evidence.status }),
    ...(only.evidence.headers === undefined ? {} : { headers: { ...only.evidence.headers } }),
    ...(only.evidence.bodySha256 === undefined ? {} : { bodySha256: only.evidence.bodySha256 }),
    ...(only.evidence.bodyBytes === undefined ? {} : { bodyBytes: only.evidence.bodyBytes }),
    ...(only.evidence.resolvedIp === undefined ? {} : { resolvedIp: only.evidence.resolvedIp }),
    ...(only.evidence.finalUrl === undefined ? {} : { finalUrl: only.evidence.finalUrl }),
  };
}
