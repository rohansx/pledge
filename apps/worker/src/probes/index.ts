/**
 * Probe dispatch.
 *
 * Two eras coexist here and always will. `spec_version` pins evaluation semantics permanently
 * (done-spec-dsl.md §8): a v0 commitment made before the DSL existed keeps being evaluated by
 * the v0 functions, forever, because retroactively reinterpreting what someone promised is the
 * silent redefinition this product exists to prevent. There is no migration and no plan for
 * one — the v0 branch is not legacy, it is the record.
 */
import type { ProbeResult } from "@pledge/db/types";
import type { ObserveDeps } from "../observe";
import type { ProbeTarget } from "../queries";
import { runSpecProbe } from "../spec-probe";
import { probeGithubReleaseTag } from "./github-release";
import { probeHttpStatus } from "./http-status";
import type { Timing } from "./result";

export * from "./result";
export { probeGithubReleaseTag } from "./github-release";
export { probeHttpStatus } from "./http-status";
export type { GithubDeps } from "../observe/github-api";

export interface ProbeDeps extends ObserveDeps {
  /** Injected clock. `ran_at` is an observation time; Postgres clamps it on insert. */
  readonly now: () => Date;
  /**
   * Resolves — and, first time round, stores — the novelty baseline. Injected so the probe
   * layer stays free of the database; see ../queries.ts `captureBaseline`.
   */
  readonly baseline: (commitmentId: string, runDigest: string) => Promise<string | null>;
}

/**
 * Runs the target's probe. Never throws for a target-side problem: an unreachable target is a
 * ProbeResult with outcome `error`, which is a different thing from a bug in this worker
 * (which should still throw and let pg-boss retry the job).
 */
export async function runProbe(target: ProbeTarget, deps: ProbeDeps): Promise<ProbeResult> {
  const timing: Timing = { startedAtMs: Date.now(), now: deps.now };

  if (target.specVersion === 0) {
    switch (target.spec.kind) {
      case "http_status":
        return probeHttpStatus(target.spec, deps.safeFetch, timing);
      case "github_release_tag":
        return probeGithubReleaseTag(target.spec, deps.github, timing);
    }
  }

  return runSpecProbe(
    {
      ast: target.spec,
      commitTime: target.committedAt,
      deadline: target.deadline,
      baseline: (digest) => deps.baseline(target.id, digest),
    },
    deps,
    timing,
  );
}
