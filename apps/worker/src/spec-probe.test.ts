/**
 * A v1 probe end to end, minus the database: AST in, ProbeResult out.
 *
 * What is being pinned:
 *   · a template spec evaluates against real observations and costs one request per source
 *   · `unchanged_since_commitment` fires when the target has not moved, and only then, and
 *     never changes the outcome (done-spec-dsl.md §6.3)
 *   · an unobservable source produces `error`, never `fail` (CLAUDE.md I-7)
 */
import { describe, expect, it, vi } from "vitest";
import type { SpecNode } from "@pledge/spec";
import { SafeFetchError, type SafeFetch, type SafeFetchResponse } from "@pledge/safe-fetch";
import { runSpecProbe, SPEC_PROBE_KIND, type SpecProbeEvidence } from "./spec-probe";
import type { ObserveDeps } from "./observe";
import type { Timing } from "./probes/result";

const URL = "https://pledge.test/";
const COMMIT_TIME = new Date("2026-09-01T00:00:00.000Z");
const DEADLINE = new Date("2026-09-05T18:00:00.000Z");
const NOW = new Date("2026-09-03T12:00:00.000Z");

const timing: Timing = { startedAtMs: Date.now(), now: () => NOW };

const accessor = (path: string[]) => ({
  source: { kind: "http", url: URL } as const,
  modifiers: [],
  field: { path },
});

/** §9's "URL is live with content" template, canonicalised. */
const LIVE_WITH_CONTENT: SpecNode = {
  kind: "and",
  left: {
    kind: "compare",
    op: "==",
    left: accessor(["status"]),
    right: { type: "int", value: 200 },
  },
  right: {
    kind: "and",
    left: {
      kind: "compare",
      op: "contains",
      left: accessor(["text"]),
      right: { type: "string", value: "Verify a receipt" },
    },
    right: {
      kind: "compare",
      op: ">",
      left: accessor(["text", "length"]),
      right: { type: "int", value: 2000 },
    },
  },
};

function response(body: string, status = 200): SafeFetchResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: { "content-type": "text/html" },
    body: bytes,
    bodySha256: "b".repeat(64),
    bodyBytes: bytes.byteLength,
    truncated: false,
    resolvedIp: "203.0.113.9",
    finalUrl: URL,
    redirectChain: [URL],
    durationMs: 8,
  };
}

function deps(safeFetch: SafeFetch): ObserveDeps {
  return {
    safeFetch,
    github: { token: "unused", fetchImpl: vi.fn() as unknown as typeof fetch },
    registryFetch: vi.fn() as unknown as typeof fetch,
    dns: {
      resolve4: () => Promise.reject(new Error("unused")),
      resolveCname: () => Promise.reject(new Error("unused")),
      resolveTxt: () => Promise.reject(new Error("unused")),
    },
  };
}

const SHIPPED = `<h1>pledge</h1>${"body ".repeat(500)}Verify a receipt`;
const PLACEHOLDER = `<h1>coming soon</h1>${"filler ".repeat(400)}`;

/** A baseline store with no database behind it: first digest in wins, like the real one. */
function memoryBaseline() {
  let stored: string | null = null;
  return {
    read: () => stored,
    resolve: (digest: string): Promise<string | null> => {
      stored ??= digest;
      return Promise.resolve(stored);
    },
  };
}

const evidenceOf = (evidence: unknown): SpecProbeEvidence => evidence as SpecProbeEvidence;

describe("evaluating a template spec", () => {
  it("passes when the page is live and has the content, with one request for three fields", async () => {
    const safeFetch = vi.fn(async () => response(SHIPPED));
    const result = await runSpecProbe(
      {
        ast: LIVE_WITH_CONTENT,
        commitTime: COMMIT_TIME,
        deadline: DEADLINE,
        baseline: memoryBaseline().resolve,
      },
      deps(safeFetch as unknown as SafeFetch),
      timing,
    );

    expect(result.outcome).toBe("pass");
    expect(result.probeKind).toBe(SPEC_PROBE_KIND);
    expect(safeFetch).toHaveBeenCalledTimes(1);

    const evidence = evidenceOf(result.evidence);
    expect(evidence.observations).toHaveLength(1);
    expect(evidence.specVersion).toBe(1);
    // A single-source spec still fills the v0 evidence fields, so the existing commitment page
    // keeps rendering a status without knowing about v1.
    expect(evidence.status).toBe(200);
    expect(evidence.resolvedIp).toBe("203.0.113.9");
  });

  it("fails — an observation, not an error — when the content is not there", async () => {
    const result = await runSpecProbe(
      {
        ast: LIVE_WITH_CONTENT,
        commitTime: COMMIT_TIME,
        deadline: DEADLINE,
        baseline: memoryBaseline().resolve,
      },
      deps((async () => response(PLACEHOLDER)) as unknown as SafeFetch),
      timing,
    );
    expect(result.outcome).toBe("fail");
    expect(result.evidence.error).toBeUndefined();
  });
});

describe("INVARIANT I-7 through the whole probe", () => {
  it("reports error, never fail, when the target could not be observed", async () => {
    const failing: SafeFetch = () =>
      Promise.reject(new SafeFetchError("dns_failure", "getaddrinfo ENOTFOUND pledge.test"));

    const result = await runSpecProbe(
      {
        ast: LIVE_WITH_CONTENT,
        commitTime: COMMIT_TIME,
        deadline: DEADLINE,
        baseline: memoryBaseline().resolve,
      },
      deps(failing),
      timing,
    );

    expect(result.outcome).toBe("error");
    expect(result.outcome).not.toBe("fail");
    expect(result.evidence.error?.code).toBe("dns_failure");
    // The unobservable source is named in the message: a `disputed` with no stated cause is
    // worse than a stringy one.
    expect(result.evidence.error?.message).toContain(`http:${URL}`);
  });

  it("does not record a novelty verdict on a run that observed nothing", async () => {
    const failing: SafeFetch = () =>
      Promise.reject(new SafeFetchError("timeout", "body timeout"));
    const baseline = memoryBaseline();
    const result = await runSpecProbe(
      {
        ast: LIVE_WITH_CONTENT,
        commitTime: COMMIT_TIME,
        deadline: DEADLINE,
        baseline: baseline.resolve,
      },
      deps(failing),
      timing,
    );
    expect(evidenceOf(result.evidence).unchangedSinceCommitment).toBeUndefined();
  });
});

describe("novelty (§6.3)", () => {
  it("flags a pass against a target that has not changed since the commitment", async () => {
    const baseline = memoryBaseline();
    const input = {
      ast: LIVE_WITH_CONTENT,
      commitTime: COMMIT_TIME,
      deadline: DEADLINE,
      baseline: baseline.resolve,
    };
    const alwaysShipped = deps((async () => response(SHIPPED)) as unknown as SafeFetch);

    // The first run captures the baseline — and it is the commit-time observation, so a spec
    // that already held when it was written is flagged from the very first pass. That is the
    // accidental false pass §9 warns about, surfaced rather than swallowed.
    const first = await runSpecProbe(input, alwaysShipped, timing);
    const second = await runSpecProbe(input, alwaysShipped, timing);

    expect(first.outcome).toBe("pass");
    expect(evidenceOf(first.evidence).unchangedSinceCommitment).toBe(true);
    expect(evidenceOf(second.evidence).unchangedSinceCommitment).toBe(true);
    // The flag does NOT change the outcome.
    expect(second.outcome).toBe("pass");
  });

  it("does not flag a pass against a target that changed after the commitment", async () => {
    const baseline = memoryBaseline();
    const input = {
      ast: LIVE_WITH_CONTENT,
      commitTime: COMMIT_TIME,
      deadline: DEADLINE,
      baseline: baseline.resolve,
    };

    const before = await runSpecProbe(
      input,
      deps((async () => response(PLACEHOLDER)) as unknown as SafeFetch),
      timing,
    );
    const after = await runSpecProbe(
      input,
      deps((async () => response(SHIPPED)) as unknown as SafeFetch),
      timing,
    );

    expect(before.outcome).toBe("fail");
    expect(after.outcome).toBe("pass");
    expect(evidenceOf(after.evidence).unchangedSinceCommitment).toBe(false);
    expect(evidenceOf(after.evidence).targetDigest).not.toBe(
      evidenceOf(before.evidence).targetDigest,
    );
  });

  it("says nothing at all when no baseline was ever captured", async () => {
    const result = await runSpecProbe(
      {
        ast: LIVE_WITH_CONTENT,
        commitTime: COMMIT_TIME,
        deadline: DEADLINE,
        // The capture legitimately failed — the target was down at commit time. A missing
        // baseline means "we cannot say", never "unchanged".
        baseline: () => Promise.resolve(null),
      },
      deps((async () => response(SHIPPED)) as unknown as SafeFetch),
      timing,
    );
    expect(result.outcome).toBe("pass");
    expect(evidenceOf(result.evidence).unchangedSinceCommitment).toBeUndefined();
  });
});
