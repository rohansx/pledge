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
import { createHash } from "node:crypto";
import type { GithubReleaseTagSpec, ProbeResult } from "@pledge/db/types";
import { z } from "zod";
import { matchGlob } from "../glob";
import {
  allowlistHeaders,
  notObserved,
  observed,
  type ObservationErrorCode,
  type Timing,
} from "./result";

const KIND = "github_release_tag" as const;

const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "pledge-probe/0.1 (+https://pledge.sh/probe)";
const REQUEST_TIMEOUT_MS = 10_000;

export interface GithubDeps {
  /** App installation token or PAT. Required — see the "whose eyes" note above. */
  readonly token: string;
  /** Injected so tests never touch the network. Production passes the global `fetch`. */
  readonly fetchImpl: typeof fetch;
}

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

  return notObserved(KIND, codeForStatus(latest), describe(latest), latest.partial, timing);
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
      codeForStatus(repo),
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

type GithubCall =
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly json: unknown;
      readonly body: { readonly bodySha256: string; readonly bodyBytes: number };
      readonly partial: { readonly status: number; readonly headers: Record<string, string> };
      readonly rateLimited: boolean;
    }
  | {
      readonly kind: "unreachable";
      readonly code: ObservationErrorCode;
      readonly message: string;
      readonly partial: Record<string, never>;
    };

async function callGithub(url: string, deps: GithubDeps): Promise<GithubCall> {
  let response: Response;
  try {
    response = await deps.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${deps.token}`,
        "x-github-api-version": API_VERSION,
        "user-agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && /abort|timeout/i.test(error.name + error.message);
    return {
      kind: "unreachable",
      code: timedOut ? "timeout" : "connection_failed",
      message: error instanceof Error ? error.message : String(error),
      partial: {},
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error: unknown) {
    return {
      kind: "unreachable",
      code: "connection_failed",
      message: `response body from GitHub could not be read: ${error instanceof Error ? error.message : String(error)}`,
      partial: {},
    };
  }

  const headers = allowlistHeaders(response.headers);
  return {
    kind: "answered",
    status: response.status,
    headers,
    json: safeJson(text),
    body: {
      bodySha256: createHash("sha256").update(text, "utf8").digest("hex"),
      bodyBytes: Buffer.byteLength(text, "utf8"),
    },
    partial: { status: response.status, headers },
    rateLimited:
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.get("retry-after") !== null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Every branch here is an `error` code, because every one of them means the API did not tell
 * us about the release. There is deliberately no status that maps to `fail`: only the two
 * paths above, which actually read a tag or confirm a visible repo with no release, can.
 */
function codeForStatus(call: Extract<GithubCall, { kind: "answered" }>): ObservationErrorCode {
  const throttled = call.status === 429 || (call.status === 403 && call.rateLimited);
  return throttled ? "rate_limited" : "upstream_unavailable";
}

function describe(call: Extract<GithubCall, { kind: "answered" }>): string {
  return `GitHub API returned ${call.status}`;
}
