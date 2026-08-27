/**
 * The receipt builder, against a real database, checked with the real verifier.
 *
 * This is the v1 exit criterion in test form: a receipt built from rows in Postgres verifies
 * under `pledge-verify`, which knows nothing about Postgres. A builder tested only against its
 * own idea of the format would pass forever while producing receipts no third party accepts.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { SPEC_VERSION, compile } from "@pledge/spec";
import { verifyReceipt } from "pledge-verify";
import { closeDb, createDb, type Db } from "../src/client";
import { hashDoneSpec } from "../src/done-spec-hash";
import { loadDevEnv, requireEnv } from "../src/env";
import { insertCommitment } from "../src/queries/commitments";
import { recordProbeRun } from "../src/queries/probes";
import { buildReceipt } from "../src/receipt";
import { account } from "../src/schema";
import type { DoneSpecV0, ProbeEvidence, ProbeResult } from "../src/types";

const DAY_MS = 86_400_000;

let db: Db;
let accountId: string;
let handle: string;

const release = hashDoneSpec({
  kind: "github_release_tag",
  repo: "rohansx/tethr",
  tagPattern: "v0.2.*",
} satisfies DoneSpecV0);

const site = hashDoneSpec({
  kind: "http_status",
  url: "https://example.test/launched",
  expectedStatus: 200,
} satisfies DoneSpecV0);

beforeAll(async () => {
  loadDevEnv();
  db = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  const suffix = randomUUID().slice(0, 8);
  handle = `receipt-${suffix}`;
  const [row] = await db
    .insert(account)
    .values({ handle, email: `${handle}@example.test`, githubId: Number(BigInt(`0x${suffix}`)) * -1 })
    .returning();
  if (row === undefined) throw new Error("could not create test account");
  accountId = row.id;
});

afterAll(async () => {
  await closeDb(db);
});

const observation = (outcome: ProbeResult["outcome"], ranAt: Date): ProbeResult => ({
  probeKind: "github_release_tag",
  outcome,
  evidence:
    outcome === "error"
      ? { error: { code: "timeout", message: "target unreachable" } }
      : { status: 200, bodySha256: "a".repeat(64), bodyBytes: 3312, matches: ["v0.2.1"] },
  ranAt,
  durationMs: 42,
});

/**
 * What a v1 probe run stores in `probe_run.evidence` — `ProbeEvidence` plus the per-source
 * detail a multi-source spec needs, exactly as apps/worker/src/spec-probe.ts declares it.
 *
 * Restated here rather than imported because @pledge/db cannot depend on apps/worker, and
 * restating it is the assertion: this is the shape the builder is required to accept, and if
 * the worker's shape drifts away from it the round trip in
 * apps/worker/src/spec-wire.test.ts fails first.
 */
interface SpecEvidence extends ProbeEvidence {
  readonly specVersion: number;
  readonly observations: readonly Record<string, unknown>[];
  readonly subresults: readonly { readonly nodePath: string; readonly value: boolean }[];
  readonly targetDigest: string;
}

describe("buildReceipt", () => {
  it("produces a receipt for a kept commitment that pledge-verify accepts", async () => {
    const c = await insertCommitment(db, {
      accountId,
      claim: "Tag tethr v0.2",
      spec: release.spec,
      doneSpecHash: release.hash,
      deadline: new Date(Date.now() + 2 * DAY_MS),
      estimatedDays: 3,
    });
    await recordProbeRun(db, {
      commitmentId: c.id,
      result: observation("pass", new Date()),
      authoritative: false,
    });

    const receipt = await buildReceipt(db, c.id);
    const result = verifyReceipt(receipt);

    expect(result.rejections).toEqual([]);
    expect(result.accepted).toBe(true);
    expect(receipt.outcome.status).toBe("kept");
    // §2.1: `kept` requires a probe. Nothing else can produce it (CLAUDE.md I-1).
    expect(receipt.outcome.resolved_by).toBe("probe");
    expect(receipt.commitment.handle).toBe(handle);
    // §1: the criterion travels with the outcome, in full, as inspectable source.
    expect(receipt.done_spec.source).toBe('github.release("rohansx/tethr").tag matches "v0.2.*"');
    expect(receipt.done_spec.probe_class).toBe("standard");
    expect(receipt.evidence.length).toBe(1);
    // v1 has no anchoring, and the receipt says so rather than implying otherwise (§5.3).
    expect(receipt.anchor).toBeNull();
    expect(receipt.anchor_pending).toBe(true);
  });

  it("marks a missed commitment as right-censored, not zero (§6)", async () => {
    const c = await insertCommitment(db, {
      accountId,
      claim: "Launch the ordering flow",
      spec: site.spec,
      doneSpecHash: site.hash,
      deadline: new Date(Date.now() - DAY_MS),
      estimatedDays: 2,
    });
    await recordProbeRun(db, {
      commitmentId: c.id,
      result: { ...observation("fail", new Date()), probeKind: "http_status", evidence: { status: 404 } },
      authoritative: true,
    });

    const receipt = await buildReceipt(db, c.id);

    expect(receipt.outcome.status).toBe("missed");
    expect(receipt.outcome.days_actual).toBeNull();
    expect(receipt.outcome.censored).toBe(true);
    expect(receipt.outcome.slip_ratio).toBeNull();
    expect(verifyReceipt(receipt).accepted).toBe(true);
  });

  it("refuses to issue a receipt for an open commitment", async () => {
    const c = await insertCommitment(db, {
      accountId,
      claim: "Still in flight",
      spec: site.spec,
      doneSpecHash: site.hash,
      deadline: new Date(Date.now() + 7 * DAY_MS),
    });
    await expect(buildReceipt(db, c.id)).rejects.toThrow(/still open/);
  });

  it("keeps every observation, including the one that observed nothing (I-7)", async () => {
    const c = await insertCommitment(db, {
      accountId,
      claim: "Tag tethr v0.2, eventually",
      spec: release.spec,
      doneSpecHash: release.hash,
      deadline: new Date(Date.now() + 2 * DAY_MS),
    });
    await recordProbeRun(db, {
      commitmentId: c.id,
      result: observation("error", new Date(Date.now() - 60_000)),
      authoritative: false,
    });
    await recordProbeRun(db, {
      commitmentId: c.id,
      result: observation("pass", new Date()),
      authoritative: false,
    });

    const receipt = await buildReceipt(db, c.id);

    // The errored run is in the record. A receipt that showed only the run that resolved it
    // would be a tidied record, which is the thing this product exists to be distinct from.
    expect(receipt.evidence.length).toBe(2);
    expect(receipt.evidence[0]?.status).toBeNull();
    expect(verifyReceipt(receipt).accepted).toBe(true);
  });

  /**
   * A v1 spec takes a different path through the builder at both ends: the source and probe
   * class come from the AST itself rather than from a rendered-and-recompiled v0 spec, and one
   * run expands to one evidence entry PER SOURCE rather than one per run.
   *
   * The two-source spec is the point. A single-source v1 spec produces one evidence entry
   * either way and would pass even if the flatten were wrong.
   */
  it("builds a multi-source v1 receipt: one evidence entry per source, in AST order", async () => {
    const compiled = compile(
      'http("https://example.test/ship").status == 200 and ' +
        'github.release("rohansx/tethr").tag matches "v0.2.*"',
    );
    if (!compiled.ok) throw new Error(`fixture does not compile: ${JSON.stringify(compiled.issues)}`);

    const c = await insertCommitment(db, {
      accountId,
      claim: "Ship the page and tag the release",
      spec: compiled.spec.ast,
      doneSpecHash: compiled.spec.hash,
      specVersion: SPEC_VERSION,
      deadline: new Date(Date.now() + 2 * DAY_MS),
      estimatedDays: 4,
    });

    // The evidence shape apps/worker/src/spec-probe.ts writes, verbatim.
    //
    // Hoisted into a const rather than written inline because `ProbeEvidence` is the v0 shape
    // and TypeScript's excess-property check only fires on a fresh object literal. That is
    // exactly how the worker gets its `SpecProbeEvidence` past the same parameter: the column
    // is jsonb with no CHECK, the extra keys store and round-trip, and the receipt builder
    // Zod-parses them back at the boundary. Widening `ProbeEvidence` here would make
    // @pledge/db know about observations, which is the worker's business.
    const specEvidence: SpecEvidence = {
      specVersion: SPEC_VERSION,
      observations: [
        {
          source: "http:https://example.test/ship",
          observed: true,
          observedAt: "2026-08-27T10:00:00.000Z",
          values: { status: 200 },
          evidence: { status: 200, bodySha256: "a".repeat(64), bodyBytes: 4096 },
        },
        {
          source: "github.release:rohansx/tethr",
          observed: true,
          observedAt: "2026-08-27T10:00:01.000Z",
          values: { tag: "v0.2.1" },
          evidence: { status: 200, bodySha256: "b".repeat(64), bodyBytes: 3312 },
        },
      ],
      subresults: [
        { nodePath: "and.0", value: true },
        { nodePath: "and.1", value: true },
      ],
      targetDigest: "c".repeat(64),
    };

    await recordProbeRun(db, {
      commitmentId: c.id,
      result: {
        probeKind: "spec",
        outcome: "pass",
        evidence: specEvidence,
        ranAt: new Date(),
        durationMs: 90,
      },
      authoritative: false,
    });

    const receipt = await buildReceipt(db, c.id);

    expect(receipt.done_spec.spec_version).toBe(SPEC_VERSION);
    // The canonical source, not a rendering invented by the builder — `print` is the fixed
    // point of §5.1, so this is the text the committer saw and the text a verifier re-hashes.
    expect(receipt.done_spec.source).toBe(compiled.spec.dslSource);
    expect(receipt.done_spec.hash).toBe(`sha256:${compiled.spec.hash}`);
    expect(receipt.done_spec.probe_class).toBe(compiled.spec.probeClass);

    // One run, two sources, two entries — in the order the AST mentions them (§3).
    expect(receipt.evidence.map((e) => e.source)).toEqual([
      "http:https://example.test/ship",
      "github.release:rohansx/tethr",
    ]);
    // Per-source observation times, not the run's `ran_at`: a run's sources answer at
    // different instants and the receipt says when each target answered.
    expect(receipt.evidence[0]?.observed_at).toBe("2026-08-27T10:00:00.000Z");
    expect(receipt.evidence[1]?.observed_at).toBe("2026-08-27T10:00:01.000Z");
    expect(receipt.evidence[1]?.body_sha256).toBe(`sha256:${"b".repeat(64)}`);

    const result = verifyReceipt(receipt);
    expect(result.rejections).toEqual([]);
    expect(result.accepted).toBe(true);
  });
});
