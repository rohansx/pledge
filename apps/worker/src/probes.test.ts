/**
 * The error/fail boundary (CLAUDE.md I-7) and the glob matcher.
 *
 * Every assertion below that says `outcome` is "error" is really asserting that a network
 * problem cannot mark someone as having missed. `expect(result.outcome).not.toBe("fail")` is
 * spelled out in the cases where the temptation to collapse the two is strongest.
 */
import type { GithubReleaseTagSpec, HttpStatusSpec } from "@pledge/db/types";
import { SafeFetchError, type SafeFetch, type SafeFetchResponse } from "@pledge/safe-fetch";
import { describe, expect, it } from "vitest";
import { matchGlob } from "./glob";
import { runProbe, type ProbeDeps } from "./probes";
import type { ProbeTarget } from "./queries";

/**
 * Wraps a v0 spec as the row the probe path actually receives. `spec_version` pins evaluation
 * semantics permanently (done-spec-dsl.md §8) — these commitments were made before the DSL
 * existed and are still evaluated by the v0 functions, which is what this file exercises.
 */
const v0 = (spec: HttpStatusSpec | GithubReleaseTagSpec): ProbeTarget => ({
  id: "11111111-1111-4111-8111-111111111111",
  doneSpecHash: "0".repeat(64),
  deadline: new Date("2026-09-05T18:00:00.000Z"),
  committedAt: new Date("2026-09-01T00:00:00.000Z"),
  baselineDigest: null,
  specVersion: 0,
  spec,
});

const NOW = new Date("2026-08-24T12:00:00.000Z");

const httpSpec: HttpStatusSpec = {
  kind: "http_status",
  url: "https://example.test/ship",
  expectedStatus: 200,
};

const githubSpec: GithubReleaseTagSpec = {
  kind: "github_release_tag",
  repo: "acme/widget",
  tagPattern: "v0.2.*",
};

function response(overrides: Partial<SafeFetchResponse> = {}): SafeFetchResponse {
  return {
    status: 200,
    headers: { "content-type": "text/html" },
    body: new Uint8Array(),
    bodySha256: "a".repeat(64),
    bodyBytes: 0,
    truncated: false,
    resolvedIp: "93.184.216.34",
    finalUrl: httpSpec.url,
    redirectChain: [httpSpec.url],
    durationMs: 12,
    ...overrides,
  };
}

function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    safeFetch: (() => {
      throw new Error("safeFetch not stubbed");
    }) as unknown as SafeFetch,
    github: {
      token: "test-token",
      fetchImpl: () => {
        throw new Error("fetch not stubbed");
      },
    },
    registryFetch: (() => {
      throw new Error("registryFetch not stubbed");
    }) as unknown as typeof fetch,
    dns: {
      resolve4: () => Promise.reject(new Error("dns not stubbed")),
      resolveCname: () => Promise.reject(new Error("dns not stubbed")),
      resolveTxt: () => Promise.reject(new Error("dns not stubbed")),
    },
    now: () => NOW,
    baseline: () => Promise.resolve(null),
    ...overrides,
  };
}

/** A fetch stub that answers each requested URL from a map, so the 404 fallback is visible. */
function githubFetch(routes: Record<string, Response>): typeof fetch {
  return ((url: string) => {
    const hit = routes[url];
    if (hit === undefined) throw new Error(`unexpected GitHub request: ${url}`);
    return Promise.resolve(hit.clone());
  }) as unknown as typeof fetch;
}

const RELEASES_URL = "https://api.github.com/repos/acme/widget/releases/latest";
const REPO_URL = "https://api.github.com/repos/acme/widget";

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

describe("http_status probe", () => {
  it("passes when the observed status is the expected one", async () => {
    const result = await runProbe(v0(httpSpec), deps({ safeFetch: async () => response() }));

    expect(result.outcome).toBe("pass");
    expect(result.evidence.status).toBe(200);
    expect(result.evidence.matches).toEqual(["200"]);
    expect(result.evidence.resolvedIp).toBe("93.184.216.34");
    expect(result.evidence.bodySha256).toBe("a".repeat(64));
    expect(result.ranAt).toEqual(NOW);
  });

  it("fails only on an observation — a wrong status, not a missing answer", async () => {
    const result = await runProbe(
      v0(httpSpec),
      deps({ safeFetch: async () => response({ status: 404 }) }),
    );

    expect(result.outcome).toBe("fail");
    expect(result.evidence.status).toBe(404);
    expect(result.evidence.matches).toBeUndefined();
    expect(result.evidence.error).toBeUndefined();
  });

  it.each([
    ["dns_failure", "getaddrinfo ENOTFOUND"],
    ["timeout", "budget exhausted"],
    ["connection_failed", "ECONNREFUSED"],
    ["blocked_address", "resolves into a blocked range"],
    ["blocked_scheme", "http: is not allowed"],
    ["too_many_redirects", "4 hops"],
    ["body_too_large", "over the 5MB cap"],
  ] as const)("records %s as error, never fail", async (code, message) => {
    const result = await runProbe(
      v0(httpSpec),
      deps({
        safeFetch: () => Promise.reject(new SafeFetchError(code, message, "10.0.0.7")),
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.outcome).not.toBe("fail");
    expect(result.evidence.error).toEqual({ code, message });
    // The attempt's facts survive; the done-condition's do not, because nothing was observed.
    expect(result.evidence.resolvedIp).toBe("10.0.0.7");
    expect(result.evidence.status).toBeUndefined();
    expect(result.evidence.matches).toBeUndefined();
  });

  it("treats an unrecognised throw as error rather than assuming anything", async () => {
    const result = await runProbe(
      v0(httpSpec),
      deps({ safeFetch: () => Promise.reject(new TypeError("boom")) }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("unexpected");
  });
});

describe("github_release_tag probe", () => {
  it("passes when the latest release tag matches the pattern", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({ [RELEASES_URL]: json({ tag_name: "v0.2.3" }) }),
        },
      }),
    );

    expect(result.outcome).toBe("pass");
    expect(result.evidence.matches).toEqual(["v0.2.3"]);
    expect(result.evidence.status).toBe(200);
    expect(result.evidence.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fails when a tag was observed and it does not match", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({ [RELEASES_URL]: json({ tag_name: "v0.3.0" }) }),
        },
      }),
    );

    expect(result.outcome).toBe("fail");
    expect(result.evidence.matches).toBeUndefined();
  });

  it("reads a 404 as 'no release yet' only when the repo itself is visible", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({
            [RELEASES_URL]: json({ message: "Not Found" }, { status: 404 }),
            [REPO_URL]: json({ full_name: "acme/widget" }),
          }),
        },
      }),
    );

    expect(result.outcome).toBe("fail");
    expect(result.evidence.status).toBe(404);
  });

  it("does NOT read a 404 as a miss when the repo is invisible too", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({
            [RELEASES_URL]: json({ message: "Not Found" }, { status: 404 }),
            [REPO_URL]: json({ message: "Not Found" }, { status: 404 }),
          }),
        },
      }),
    );

    // A private, renamed or deleted repo tells us nothing about whether the release exists.
    expect(result.outcome).toBe("error");
    expect(result.outcome).not.toBe("fail");
    expect(result.evidence.error?.code).toBe("upstream_unavailable");
  });

  it("records a rate limit as error", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({
            [RELEASES_URL]: json(
              { message: "rate limited" },
              {
                status: 403,
                headers: { "x-ratelimit-remaining": "0" },
              },
            ),
          }),
        },
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("rate_limited");
  });

  it("records a 5xx as error", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({ [RELEASES_URL]: json({}, { status: 502 }) }),
        },
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("upstream_unavailable");
  });

  it("records a transport failure as error", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: (() =>
            Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch,
        },
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("connection_failed");
  });

  it("records an aborted request as a timeout, not a fail", async () => {
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: (() => Promise.reject(abort)) as unknown as typeof fetch,
        },
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("timeout");
  });

  it("records an unreadable 200 body as error", async () => {
    const result = await runProbe(
      v0(githubSpec),
      deps({
        github: {
          token: "t",
          fetchImpl: githubFetch({ [RELEASES_URL]: json({ nope: true }) }),
        },
      }),
    );

    expect(result.outcome).toBe("error");
    expect(result.evidence.error?.code).toBe("unexpected");
  });

  it("sends the worker's own token and never a user's", async () => {
    let seen: Headers | undefined;
    const capturing = ((url: string, init: RequestInit) => {
      seen = new Headers(init.headers);
      return Promise.resolve(json({ tag_name: "v0.2.0" }));
    }) as unknown as typeof fetch;

    await runProbe(
      v0(githubSpec),
      deps({ github: { token: "app-token", fetchImpl: capturing } }),
    );

    expect(seen?.get("authorization")).toBe("Bearer app-token");
    expect(seen?.get("user-agent")).toMatch(/^pledge-probe\//);
  });
});

describe("matchGlob", () => {
  it.each([
    ["v0.2.*", "v0.2.0", true],
    ["v0.2.*", "v0.2.10-rc.1", true],
    ["v0.2.*", "v0.2.", true],
    ["v0.2.*", "v0.20.0", false],
    ["v0.2.*", "v0.2", false],
    ["*", "", true],
    ["*", "anything", true],
    ["**", "anything", true],
    ["", "", true],
    ["", "v1", false],
    ["v1.0.0", "v1.0.0", true],
    ["v1.0.0", "v1.0.00", false],
    ["v*.0", "v1.2.0", true],
    ["*beta*", "v1.0.0-beta.1", true],
    ["*beta*", "v1.0.0", false],
    ["a*a*b", "aaab", true],
    ["a*a*b", "aab", true],
    ["a*a*b", "ab", false],
    ["*.*.*", "1.2.3", true],
  ])("%s vs %s -> %s", (pattern, value, expected) => {
    expect(matchGlob(pattern, value)).toBe(expected);
  });

  it("treats regex metacharacters as literals — the pattern is a glob, not a regex", () => {
    expect(matchGlob("v1.0.0", "v1X0Y0")).toBe(false);
    expect(matchGlob("a?c", "abc")).toBe(false);
    expect(matchGlob("a?c", "a?c")).toBe(true);
    expect(matchGlob("v1+", "v1+")).toBe(true);
    expect(matchGlob("(v1)", "v1")).toBe(false);
  });

  it("does not blow up on a pattern built to make a backtracking engine cry", () => {
    const pattern = `${"a*".repeat(50)}b`;
    const value = "a".repeat(400);
    const started = Date.now();
    expect(matchGlob(pattern, value)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
