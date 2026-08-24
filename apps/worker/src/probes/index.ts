/**
 * Probe dispatch. Two kinds in v0, both plain functions — no DSL, no parser (roadmap v0).
 */
import type { DoneSpecV0, ProbeResult } from "@pledge/db/types";
import type { SafeFetch } from "@pledge/safe-fetch";
import { probeGithubReleaseTag, type GithubDeps } from "./github-release";
import { probeHttpStatus } from "./http-status";
import type { Timing } from "./result";

export * from "./result";
export { probeGithubReleaseTag } from "./github-release";
export { probeHttpStatus } from "./http-status";
export type { GithubDeps } from "./github-release";

export interface ProbeDeps {
  readonly safeFetch: SafeFetch;
  readonly github: GithubDeps;
  /** Injected clock. `ran_at` is an observation time; Postgres clamps it on insert. */
  readonly now: () => Date;
}

/**
 * Runs the spec's probe. Never throws for a target-side problem: an unreachable target is a
 * ProbeResult with outcome `error`, which is a different thing from a bug in this worker
 * (which should still throw and let pg-boss retry the job).
 */
export async function runProbe(spec: DoneSpecV0, deps: ProbeDeps): Promise<ProbeResult> {
  const timing: Timing = { startedAtMs: Date.now(), now: deps.now };

  switch (spec.kind) {
    case "http_status":
      return probeHttpStatus(spec, deps.safeFetch, timing);
    case "github_release_tag":
      return probeGithubReleaseTag(spec, deps.github, timing);
  }
}
