/**
 * The observation layer: distinct fetches in, Observations out.
 *
 * Every source kind routes through exactly one of the two Observation shapes in ./types.ts.
 * That is invariant I-7 held structurally rather than by review: there is no `observed: true`
 * value carrying an error, and no error shape carrying values, so a new source added here
 * cannot invent a third answer that means "we did not see it, mark them missed".
 *
 * Requests run concurrently and are deduplicated by target key first — the memoisation the
 * technical spec asks for (§5), asserted by a test that counts fetches rather than trusting
 * this comment.
 */
import type { SafeFetch } from "@pledge/safe-fetch";
import { observeDns, type DnsDeps } from "./dns";
import { observeGithub } from "./github";
import type { GithubDeps } from "./github-api";
import { observeHttp } from "./http";
import { observeRegistry } from "./registry";
import type { TargetRequest } from "./collect";
import type { Observation, ObserveContext } from "./types";

export * from "./types";
export { collectTargets, type TargetRequest } from "./collect";
export { fieldKey, targetKey } from "./keys";
export { targetDigest } from "./novelty";
export type { GithubDeps } from "./github-api";
export type { DnsDeps } from "./dns";
export { nodeDnsDeps } from "./dns";

export interface ObserveDeps {
  /** The ONLY way a user-supplied URL is fetched (CLAUDE.md I-5). */
  readonly safeFetch: SafeFetch;
  readonly github: GithubDeps;
  /** Registries are fixed origins, so they take a plain fetch and carry no credentials. */
  readonly registryFetch: typeof fetch;
  readonly dns: DnsDeps;
}

export async function observeAll(
  requests: readonly TargetRequest[],
  deps: ObserveDeps,
  ctx: ObserveContext,
): Promise<readonly Observation[]> {
  const distinct = new Map<string, TargetRequest>();
  for (const request of requests) {
    const existing = distinct.get(request.key);
    distinct.set(
      request.key,
      existing === undefined
        ? request
        : { ...existing, fields: [...existing.fields, ...request.fields] },
    );
  }

  return Promise.all([...distinct.values()].map((request) => observeOne(request, deps, ctx)));
}

async function observeOne(
  request: TargetRequest,
  deps: ObserveDeps,
  ctx: ObserveContext,
): Promise<Observation> {
  const { key, target, fields } = request;
  const { source } = target;
  try {
    switch (source.kind) {
      case "http":
        return await observeHttp(key, source.url, fields, deps.safeFetch, ctx.now);
      case "github.release":
      case "github.pr":
      case "github.issue":
      case "github.commits":
      case "github.file":
      case "github.workflow":
        return await observeGithub(key, source, target.modifiers, deps.github, ctx);
      case "npm":
      case "crates":
      case "pypi":
        return await observeRegistry(key, source.kind, source.package, deps.registryFetch, ctx);
      case "dns":
        return await observeDns(key, source.name, deps.dns, ctx);
    }
  } catch (error: unknown) {
    // A bug in an observer is still not an observation. Letting it throw would fail the whole
    // job and lose the sibling observations that DID succeed; turning it into a false value
    // would be the I-7 violation. So: not observed, with the reason attached.
    return {
      source: key,
      observed: false,
      observedAt: ctx.now().toISOString(),
      error: {
        code: "unexpected",
        message: error instanceof Error ? error.message : String(error),
      },
      evidence: {},
    };
  }
}
