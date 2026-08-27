/**
 * `github.*` — done-spec-dsl.md §3.2.
 *
 * Every one of these six sources faces the same fork, and it is the fork invariant I-7 is
 * about: GitHub answers 404 both for "this thing does not exist yet" and for "this repository
 * is private, renamed, or gone". The first is an observation that the done-condition is FALSE;
 * the second is not an observation at all. So a 404 is never read directly — it costs one
 * extra request against the repository itself, and only a *visible* repository licenses
 * reading an absence as an absence.
 *
 * Guessing "false" there would mark someone missed for a repo we cannot even see. Guessing
 * "error" would make "no release by the deadline" permanently unresolvable. Neither guess is
 * available, so we ask.
 */
import { z } from "zod";
import type { Modifier, Source } from "@pledge/spec";
import type { ObservationErrorCode } from "../probes/result";
import {
  GITHUB_API_ORIGIN,
  callGithub,
  githubErrorCode,
  repoPath,
  totalFromLink,
  type GithubCall,
  type GithubDeps,
} from "./github-api";
import { resolveInstant } from "./keys";
import type { Observation, ObservedValue, ObserveContext } from "./types";

type Answered = Extract<GithubCall, { kind: "answered" }>;

/** Unknown keys are ignored, not rejected — GitHub adds fields and we read a handful. */
const Release = z.object({
  tag_name: z.string(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  prerelease: z.boolean().optional(),
  assets: z.array(z.unknown()).optional(),
});
const PullRequest = z.object({
  state: z.string(),
  merged_at: z.string().nullable().optional(),
  additions: z.number().optional(),
  deletions: z.number().optional(),
});
const Issue = z.object({
  state: z.string(),
  closed_at: z.string().nullable().optional(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).optional(),
});
const Commit = z.object({
  sha: z.string(),
  commit: z
    .object({ committer: z.object({ date: z.string() }).partial().optional() })
    .optional(),
});
const Contents = z.object({
  sha: z.string(),
  size: z.number(),
  content: z.string().optional(),
});
const WorkflowRuns = z.object({
  workflow_runs: z.array(
    z.object({ conclusion: z.string().nullable(), updated_at: z.string() }),
  ),
});

export async function observeGithub(
  key: string,
  source: Extract<Source, { kind: `github.${string}` }>,
  modifiers: readonly Modifier[],
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  switch (source.kind) {
    case "github.release":
      return releaseFields(key, source.repo, deps, ctx);
    case "github.pr":
      return prFields(key, source.repo, source.number, deps, ctx);
    case "github.issue":
      return issueFields(key, source.repo, source.number, deps, ctx);
    case "github.commits":
      return commitFields(key, source.repo, modifiers, deps, ctx);
    case "github.file":
      return fileFields(key, source.repo, source.path, deps, ctx);
    case "github.workflow":
      return workflowFields(key, source.repo, source.workflow, modifiers, deps, ctx);
  }
}

// -----------------------------------------------------------------------------------------
// Per-source readers
// -----------------------------------------------------------------------------------------

async function releaseFields(
  key: string,
  repo: string,
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const url = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/releases/latest`;
  const call = await callGithub(url, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);

  if (call.status === 404) {
    // No published release. Every field is legitimately absent — `tag` is null, not missing,
    // because we did observe that there is no tag.
    return absence(key, repo, url, deps, ctx, {
      tag: null,
      name: null,
      body: null,
      published_at: null,
      is_prerelease: null,
      asset_count: 0,
    });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const parsed = Release.safeParse(call.json);
  if (!parsed.success) return unparseable(key, call, parsed.error.message, ctx);
  const r = parsed.data;
  return answered(key, call, ctx, {
    tag: r.tag_name,
    name: r.name ?? null,
    body: r.body ?? null,
    published_at: isoOrNull(r.published_at),
    is_prerelease: r.prerelease ?? false,
    asset_count: r.assets?.length ?? 0,
  });
}

async function prFields(
  key: string,
  repo: string,
  number: number,
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const url = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/pulls/${number}`;
  const call = await callGithub(url, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);
  if (call.status === 404) {
    return absence(key, repo, url, deps, ctx, {
      state: null,
      merged_at: null,
      additions: null,
      deletions: null,
      review_count: null,
    });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const parsed = PullRequest.safeParse(call.json);
  if (!parsed.success) return unparseable(key, call, parsed.error.message, ctx);
  const pr = parsed.data;

  // §9's "Merge a PR" template is `state == "merged"`, but GitHub's `state` is open/closed and
  // merged-ness is a separate timestamp. Reporting the raw `state` would make the normative
  // template unsatisfiable, so `merged` is surfaced as the state it plainly is.
  const state = pr.merged_at != null ? "merged" : pr.state;

  const reviews = await callGithub(`${url}/reviews?per_page=1`, deps);
  const reviewCount =
    reviews.kind === "answered" && reviews.status === 200
      ? totalFromLink(reviews.link, Array.isArray(reviews.json) ? reviews.json.length : 0)
      : undefined;

  return answered(key, call, ctx, {
    state,
    merged_at: isoOrNull(pr.merged_at),
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    // Absent rather than null when the review listing failed: we did not observe it, and a
    // `review_count >= 1` must not be decided against a number we could not read.
    ...(reviewCount === undefined ? {} : { review_count: reviewCount }),
  });
}

async function issueFields(
  key: string,
  repo: string,
  number: number,
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const url = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/issues/${number}`;
  const call = await callGithub(url, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);
  if (call.status === 404) {
    return absence(key, repo, url, deps, ctx, {
      state: null,
      closed_at: null,
      label_names: [],
    });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const parsed = Issue.safeParse(call.json);
  if (!parsed.success) return unparseable(key, call, parsed.error.message, ctx);
  const issue = parsed.data;
  return answered(key, call, ctx, {
    state: issue.state,
    closed_at: isoOrNull(issue.closed_at),
    label_names: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).sort(),
  });
}

async function commitFields(
  key: string,
  repo: string,
  modifiers: readonly Modifier[],
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const query = new URLSearchParams({ per_page: "1" });
  const since = instantArg(modifiers, "since", ctx);
  if (since !== undefined) query.set("since", since);
  const branch = stringArg(modifiers, "on_branch");
  if (branch !== undefined) query.set("sha", branch);
  const author = stringArg(modifiers, "by");
  if (author !== undefined) query.set("author", author);

  const url = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/commits?${query.toString()}`;
  const call = await callGithub(url, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);
  // 409 is GitHub for "this repository is empty". That is an observation: zero commits.
  if (call.status === 409) {
    return answered(key, call, ctx, { count: 0, latest_sha: null, latest_at: null });
  }
  if (call.status === 404) {
    return absence(key, repo, url, deps, ctx, { count: 0, latest_sha: null, latest_at: null });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const list = z.array(Commit).safeParse(call.json);
  if (!list.success) return unparseable(key, call, list.error.message, ctx);
  const count = totalFromLink(call.link, list.data.length);
  if (count === undefined) {
    return unreachable(
      key,
      "unexpected",
      "unparseable Link header from GitHub",
      call.partial,
      ctx,
    );
  }
  const latest = list.data[0];
  return answered(key, call, ctx, {
    count,
    latest_sha: latest?.sha ?? null,
    latest_at: isoOrNull(latest?.commit?.committer?.date),
  });
}

async function fileFields(
  key: string,
  repo: string,
  path: string,
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/contents/${encoded}`;
  const call = await callGithub(url, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);
  if (call.status === 404) {
    return absence(key, repo, url, deps, ctx, {
      exists: false,
      sha: null,
      size: null,
      text: null,
    });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const parsed = Contents.safeParse(call.json);
  // A directory answers 200 with an array, which `Contents` rejects. That is not a file, and
  // saying so as "unreadable" is more honest than reporting `exists: true` for a folder.
  if (!parsed.success) return unparseable(key, call, parsed.error.message, ctx);
  const file = parsed.data;
  return answered(key, call, ctx, {
    exists: true,
    sha: file.sha,
    size: file.size,
    text:
      file.content === undefined ? null : Buffer.from(file.content, "base64").toString("utf8"),
  });
}

async function workflowFields(
  key: string,
  repo: string,
  workflow: string,
  modifiers: readonly Modifier[],
  deps: GithubDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const base = `${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`;
  const since = instantArg(modifiers, "since", ctx);
  const window: Record<string, string> = since === undefined ? {} : { created: `>=${since}` };

  const latestUrl = `${base}?${new URLSearchParams({ per_page: "1", ...window }).toString()}`;
  const call = await callGithub(latestUrl, deps);
  if (call.kind === "unreachable") return unreachable(key, call.code, call.message, {}, ctx);
  if (call.status === 404) {
    return absence(key, repo, latestUrl, deps, ctx, {
      latest_conclusion: null,
      latest_at: null,
      success_count: 0,
    });
  }
  if (call.status !== 200) return fromStatus(key, call, ctx);

  const parsed = WorkflowRuns.safeParse(call.json);
  if (!parsed.success) return unparseable(key, call, parsed.error.message, ctx);
  const latest = parsed.data.workflow_runs[0];

  const successUrl = `${base}?${new URLSearchParams({ per_page: "1", status: "success", ...window }).toString()}`;
  const successes = await callGithub(successUrl, deps);
  const successCount =
    successes.kind === "answered" && successes.status === 200
      ? totalFromLink(successes.link, runsOnPage(successes.json))
      : undefined;

  return answered(key, call, ctx, {
    latest_conclusion: latest?.conclusion ?? null,
    latest_at: isoOrNull(latest?.updated_at),
    ...(successCount === undefined ? {} : { success_count: successCount }),
  });
}

// -----------------------------------------------------------------------------------------
// The 404 fork, and the observation constructors
// -----------------------------------------------------------------------------------------

/**
 * A 404 on a sub-resource. Confirm the repository is visible first: only then is "it is not
 * there" something we saw rather than something we assumed.
 */
async function absence(
  key: string,
  repo: string,
  requestedUrl: string,
  deps: GithubDeps,
  ctx: ObserveContext,
  values: Readonly<Record<string, ObservedValue>>,
): Promise<Observation> {
  const repoCall = await callGithub(`${GITHUB_API_ORIGIN}/repos/${repoPath(repo)}`, deps);
  if (repoCall.kind === "unreachable") {
    return unreachable(key, repoCall.code, repoCall.message, {}, ctx);
  }
  if (repoCall.status !== 200) {
    return unreachable(
      key,
      githubErrorCode(repoCall),
      `repository not observable (${repoCall.status}) — a 404 on ${requestedUrl} cannot be read as an absence`,
      repoCall.partial,
      ctx,
    );
  }
  return {
    source: key,
    observed: true,
    observedAt: ctx.now().toISOString(),
    values,
    evidence: { status: 404, headers: repoCall.headers, finalUrl: requestedUrl },
  };
}

function answered(
  key: string,
  call: Answered,
  ctx: ObserveContext,
  values: Readonly<Record<string, ObservedValue>>,
): Observation {
  return {
    source: key,
    observed: true,
    observedAt: ctx.now().toISOString(),
    values,
    evidence: {
      status: call.status,
      headers: call.headers,
      bodySha256: call.body.bodySha256,
      bodyBytes: call.body.bodyBytes,
    },
  };
}

function unreachable(
  key: string,
  code: ObservationErrorCode,
  message: string,
  evidence: { status?: number; headers?: Record<string, string> },
  ctx: ObserveContext,
): Observation {
  return {
    source: key,
    observed: false,
    observedAt: ctx.now().toISOString(),
    error: { code, message },
    evidence,
  };
}

function fromStatus(key: string, call: Answered, ctx: ObserveContext): Observation {
  return unreachable(
    key,
    githubErrorCode(call),
    `GitHub API returned ${call.status}`,
    call.partial,
    ctx,
  );
}

/** A 200 whose body we cannot read is not an observation of anything. */
function unparseable(
  key: string,
  call: Answered,
  detail: string,
  ctx: ObserveContext,
): Observation {
  return unreachable(
    key,
    "unexpected",
    `unreadable GitHub payload: ${detail}`,
    call.partial,
    ctx,
  );
}

function runsOnPage(json: unknown): number {
  const parsed = WorkflowRuns.safeParse(json);
  return parsed.success ? parsed.data.workflow_runs.length : 0;
}

function isoOrNull(value: string | null | undefined): string | null {
  if (value == null) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function instantArg(
  modifiers: readonly Modifier[],
  name: string,
  ctx: ObserveContext,
): string | undefined {
  const arg = modifiers.find((m) => m.name === name)?.args[0];
  if (arg === undefined) return undefined;
  return arg.type === "instant"
    ? resolveInstant(arg.name, ctx).toISOString()
    : String(arg.value);
}

function stringArg(modifiers: readonly Modifier[], name: string): string | undefined {
  const arg = modifiers.find((m) => m.name === name)?.args[0];
  if (arg === undefined || arg.type === "instant") return undefined;
  return String(arg.value);
}
