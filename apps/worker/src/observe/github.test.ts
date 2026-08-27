/**
 * The GitHub sources, and the 404 fork that is the whole reason this file is careful.
 *
 * GitHub answers 404 both for "no release yet" and for "this repository is private, renamed,
 * or gone". The first licenses an observation that the done-condition is FALSE; the second
 * licenses nothing at all. Every assertion below is about which of the two we decided we were
 * looking at, because getting it wrong marks someone missed for a repo we could not see.
 */
import { describe, expect, it, vi } from "vitest";
import type { Source } from "@pledge/spec";
import { observeGithub } from "./github";
import { totalFromLink } from "./github-api";
import type { ObserveContext } from "./types";

const ctx: ObserveContext = {
  commitTime: new Date("2026-09-01T00:00:00.000Z"),
  deadline: new Date("2026-09-05T18:00:00.000Z"),
  now: () => new Date("2026-09-03T12:00:00.000Z"),
};

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

/** A fetch that answers by URL suffix, and records the order it was asked. */
function fakeApi(routes: Record<string, Reply>) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    const match = Object.entries(routes).find(([suffix]) => url.includes(suffix));
    const reply: Reply = match?.[1] ?? { status: 404, body: { message: "Not Found" } };
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  });
  return { calls, deps: { token: "t", fetchImpl: fetchImpl as unknown as typeof fetch } };
}

const RELEASE: Extract<Source, { kind: "github.release" }> = {
  kind: "github.release",
  repo: "rohansx/pledge",
};

describe("github.release", () => {
  it("reads the tag off a published release", async () => {
    const { deps } = fakeApi({
      "/releases/latest": {
        status: 200,
        body: {
          tag_name: "v0.2.0",
          name: "v0.2.0",
          published_at: "2026-09-02T10:00:00Z",
          prerelease: false,
          assets: [{}, {}],
        },
      },
    });
    const observation = await observeGithub("k", RELEASE, [], deps, ctx);
    if (observation.observed !== true) throw new Error("expected an observation");
    expect(observation.values).toMatchObject({
      tag: "v0.2.0",
      is_prerelease: false,
      asset_count: 2,
      published_at: "2026-09-02T10:00:00.000Z",
    });
  });

  it("reads a 404 as 'no release' ONLY after confirming the repo is visible", async () => {
    const { calls, deps } = fakeApi({
      "/releases/latest": { status: 404 },
      "/repos/rohansx/pledge": { status: 200, body: { full_name: "rohansx/pledge" } },
    });
    const observation = await observeGithub("k", RELEASE, [], deps, ctx);
    expect(observation.observed).toBe(true);
    if (observation.observed !== true) throw new Error("unreachable");
    expect(observation.values.tag).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("refuses to read a 404 as 'no release' when the repo itself is not visible", async () => {
    const { deps } = fakeApi({ "/releases/latest": { status: 404 } });
    const observation = await observeGithub("k", RELEASE, [], deps, ctx);
    expect(observation.observed).toBe(false);
    if (observation.observed !== false) throw new Error("unreachable");
    expect(observation.error.code).toBe("upstream_unavailable");
    expect(observation.error.message).toContain("cannot be read as an absence");
  });

  it("calls a rate limit a rate limit, never a false observation", async () => {
    const { deps } = fakeApi({
      "/releases/latest": {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      },
    });
    const observation = await observeGithub("k", RELEASE, [], deps, ctx);
    if (observation.observed !== false) throw new Error("expected no observation");
    expect(observation.error.code).toBe("rate_limited");
  });

  it("treats a 200 it cannot parse as not-observed", async () => {
    const { deps } = fakeApi({
      "/releases/latest": { status: 200, body: { unexpected: true } },
    });
    const observation = await observeGithub("k", RELEASE, [], deps, ctx);
    if (observation.observed !== false) throw new Error("expected no observation");
    expect(observation.error.code).toBe("unexpected");
  });
});

describe("github.pr", () => {
  it("surfaces a merged PR as state 'merged', which is what the template compares against", async () => {
    const { deps } = fakeApi({
      "/pulls/12/reviews": {
        status: 200,
        body: [{}],
        headers: { link: '<https://api.github.com/x?per_page=1&page=3>; rel="last"' },
      },
      "/pulls/12": {
        status: 200,
        body: {
          state: "closed",
          merged_at: "2026-09-03T09:00:00Z",
          additions: 40,
          deletions: 3,
        },
      },
    });
    const observation = await observeGithub(
      "k",
      { kind: "github.pr", repo: "rohansx/pledge", number: 12 },
      [],
      deps,
      ctx,
    );
    if (observation.observed !== true) throw new Error("expected an observation");
    expect(observation.values.state).toBe("merged");
    expect(observation.values.review_count).toBe(3);
  });

  it("leaves review_count absent when the review listing could not be read", async () => {
    const { deps } = fakeApi({
      "/pulls/12/reviews": { status: 500 },
      "/pulls/12": { status: 200, body: { state: "open", merged_at: null } },
    });
    const observation = await observeGithub(
      "k",
      { kind: "github.pr", repo: "rohansx/pledge", number: 12 },
      [],
      deps,
      ctx,
    );
    if (observation.observed !== true) throw new Error("expected an observation");
    expect(observation.values.state).toBe("open");
    // Absent, not zero. `review_count >= 1` must not be decided against a number we never read.
    expect(observation.values).not.toHaveProperty("review_count");
  });
});

describe("github.commits", () => {
  it("passes .since(commit_time) to the API and counts via the Link header", async () => {
    const { calls, deps } = fakeApi({
      "/commits": {
        status: 200,
        body: [{ sha: "abc123", commit: { committer: { date: "2026-09-03T08:00:00Z" } } }],
        headers: { link: '<https://api.github.com/x?per_page=1&page=17>; rel="last"' },
      },
    });
    const observation = await observeGithub(
      "k",
      { kind: "github.commits", repo: "rohansx/pledge" },
      [{ name: "since", args: [{ type: "instant", name: "commit_time" }] }],
      deps,
      ctx,
    );
    if (observation.observed !== true) throw new Error("expected an observation");
    expect(calls[0]).toContain(`since=${encodeURIComponent(ctx.commitTime.toISOString())}`);
    // 17 pages of one item each is 17 commits — not the 1 on this page.
    expect(observation.values.count).toBe(17);
    expect(observation.values.latest_sha).toBe("abc123");
  });

  it("reads an empty repository (409) as zero commits", async () => {
    const { deps } = fakeApi({ "/commits": { status: 409 } });
    const observation = await observeGithub(
      "k",
      { kind: "github.commits", repo: "rohansx/pledge" },
      [],
      deps,
      ctx,
    );
    if (observation.observed !== true) throw new Error("expected an observation");
    expect(observation.values.count).toBe(0);
  });
});

describe("totalFromLink", () => {
  it("prefers rel=last over the page it was handed", () => {
    expect(totalFromLink('<https://x?per_page=1&page=42>; rel="last"', 1)).toBe(42);
  });

  it("falls back to the items on the page when there is no Link header", () => {
    expect(totalFromLink(null, 7)).toBe(7);
  });

  it("returns undefined rather than a guess when rel=last is unparseable", () => {
    expect(totalFromLink('<https://x?page=notanumber>; rel="last"', 1)).toBe(1);
    expect(
      totalFromLink('<https://x?page=99999999999999999999>; rel="last"', 1),
    ).toBeUndefined();
  });
});
