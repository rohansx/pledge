/**
 * `github.release(repo).tag matches pattern`.
 *
 * Two things this probe is careful about:
 *
 * 1. **Whose eyes.** The token is the App/PAT from the worker's environment, never a user's
 *    OAuth token. An observation made with the committer's own credentials is not an external
 *    observation, and this product is nothing but external observation. Nor do we ever fall
 *    back to unauthenticated for a resolution-critical run (architecture.md §8) — a missing
 *    token is a startup failure, not a silent downgrade.
 *
 * 2. **Which host.** `api.github.com` is a constant here. `repo` reaches only the *path*, and
 *    only after the `owner/name` charset check in GithubReleaseTagSpecSchema. Because the host
 *    is not user-supplied this does not need @pledge/safe-fetch's arbitrary-URL path — and it
 *    could not use it anyway, since safe-fetch refuses to carry an Authorization header
 *    (CLAUDE.md I-5 is about user-supplied URLs; this is not one).
 */
import type { GithubReleaseTagSpec, ProbeResult } from "@pledge/db/types";
import { z } from "zod";
import { matchGlob } from "../glob";
import {
  GITHUB_API_ORIGIN,
  callGithub,
  githubErrorCode,
  type GithubDeps,
} from "../observe/github-api";
import { notObserved, observed, type Timing } from "./result";

const KIND = "github_release_tag" as const;

const API_ORIGIN = GITHUB_API_ORIGIN;

export type { GithubDeps } from "../observe/github-api";

/** Only the field the done-condition reads. Unknown keys are ignored, not rejected. */
const LatestReleaseSchema = z.object({ tag_name: z.string() });

export async function probeGithubReleaseTag(
  spec: GithubReleaseTagSpec,
  deps: GithubDeps,
  timing: Timing,
): Promise<ProbeResult> {
  const [owner = "", name = ""] = spec.repo.split("/");
  const url = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/latest`;

  const latest = await callGithub(url, deps);
  if (latest.kind === "unreachable") {
    return notObserved(KIND, latest.code, latest.message, latest.partial, timing);
  }

  if (latest.status === 200) {
    const parsed = LatestReleaseSchema.safeParse(latest.json);
    if (!parsed.success) {
      // A 200 whose body we cannot read is not an observation of anything.
      return notObserved(
        KIND,
        "unexpected",
        `unreadable release payload from GitHub: ${parsed.error.message}`,
        { status: 200, finalUrl: url, ...latest.body },
        timing,
      );
    }
    const tag = parsed.data.tag_name;
    const holds = matchGlob(spec.tagPattern, tag);
    return observed(
      KIND,
      holds,
      {
        status: 200,
        headers: latest.headers,
        finalUrl: url,
        ...latest.body,
        // `matches` means "values that satisfied the condition", so a non-matching tag does
        // not belong in it — putting it there would read as though it had counted. On a fail
        // the body hash is what pins down what we actually saw (blob archival is v1).
        ...(holds ? { matches: [tag] } : {}),
      },
      timing,
    );
  }

  if (latest.status === 404) {
    return probeMissingRelease(spec, deps, timing, url);
  }

  return notObserved(
    KIND,
    githubErrorCode(latest),
    `GitHub API returned ${latest.status}`,
    latest.partial,
    timing,
  );
}

/**
 * GitHub answers 404 both for "this repo has no published release yet" and for "this repo is
 * private, renamed, or does not exist". Those are opposite outcomes — the first is an
 * observation that the done-condition is FALSE, the second is not an observation at all — so
 * the 404 is disambiguated with one extra request against the repo itself rather than guessed.
 *
 * Guessing `fail` here would mark someone missed for a repo we cannot even see; guessing
 * `error` would make "no release by the deadline" permanently unresolvable.
 */
async function probeMissingRelease(
  spec: GithubReleaseTagSpec,
  deps: GithubDeps,
  timing: Timing,
  releasesUrl: string,
): Promise<ProbeResult> {
  const [owner = "", name = ""] = spec.repo.split("/");
  const repoUrl = `${API_ORIGIN}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const repo = await callGithub(repoUrl, deps);

  if (repo.kind === "unreachable") {
    return notObserved(KIND, repo.code, repo.message, repo.partial, timing);
  }
  if (repo.status !== 200) {
    return notObserved(
      KIND,
      githubErrorCode(repo),
      `repo not observable (${repo.status}) — a 404 on releases cannot be read as "no release"`,
      repo.partial,
      timing,
    );
  }

  // The repo is visible and has no published latest release. That is an observation.
  return observed(
    KIND,
    false,
    { status: 404, headers: repo.headers, finalUrl: releasesUrl },
    timing,
  );
}
