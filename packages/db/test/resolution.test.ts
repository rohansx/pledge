/**
 * The resolution transition table (technical-spec §6), asserted against a real database.
 *
 * The case that matters most is `error at deadline+0 → disputed, never missed` (CLAUDE.md
 * I-7). Everything else here is guarding that case's neighbours so a future refactor cannot
 * quietly merge the fail and error branches.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/client";
import { hashDoneSpec } from "../src/done-spec-hash";
import { loadDevEnv, requireEnv } from "../src/env";
import { insertCommitment } from "../src/queries/commitments";
import { recordProbeRun } from "../src/queries/probes";
import { account, commitment, probeRun } from "../src/schema";
import type { DoneSpecV0, ProbeOutcome, ProbeResult } from "../src/types";

const MINUTE_MS = 60_000;

let db: Db;
let accountId: string;

const { spec, hash } = hashDoneSpec({
  kind: "http_status",
  url: "https://example.test/shipped",
  expectedStatus: 200,
} satisfies DoneSpecV0);

beforeAll(async () => {
  loadDevEnv();
  db = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  // A unique account per run: these tests leave their rows behind, because probe_run is
  // append-only and cleaning up would mean weakening the trigger that makes it so.
  const suffix = randomUUID().slice(0, 8);
  const [row] = await db
    .insert(account)
    .values({
      handle: `test-${suffix}`,
      email: `test-${suffix}@example.test`,
      githubId: Number(BigInt(`0x${suffix}`)) * -1,
    })
    .returning();
  if (row === undefined) throw new Error("could not create test account");
  accountId = row.id;
});

afterAll(async () => {
  await closeDb(db);
});

async function newOpenCommitment(deadline: Date) {
  return insertCommitment(db, {
    accountId,
    claim: "test commitment",
    spec,
    doneSpecHash: hash,
    deadline,
  });
}

const result = (outcome: ProbeOutcome, ranAt = new Date()): ProbeResult => ({
  probeKind: "http_status",
  outcome,
  evidence:
    outcome === "error"
      ? { error: { code: "dns_failure", message: "NXDOMAIN" } }
      : { status: outcome === "pass" ? 200 : 404 },
  ranAt,
  durationMs: 42,
});

async function statusOf(id: string) {
  const [row] = await db
    .select({ status: commitment.status, resolvedAt: commitment.resolvedAt })
    .from(commitment)
    .where(eq(commitment.id, id))
    .limit(1);
  if (row === undefined) throw new Error("commitment vanished");
  return row;
}

describe("recordProbeRun", () => {
  it("a passing probe resolves to kept at the earliest passing observation", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    const observedAt = new Date(Date.now() - 10 * MINUTE_MS);

    const recorded = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("pass", observedAt),
      authoritative: false,
    });

    expect(recorded).toMatchObject({ status: "kept", transitioned: true });
    const { status, resolvedAt } = await statusOf(c.id);
    expect(status).toBe("kept");
    // Credited to when it was observed, not to when the worker noticed. If this ever reads
    // ~now, someone replaced min(ran_at) with now() and shipping at 2am stopped counting.
    expect(resolvedAt).not.toBeNull();
    expect(Math.abs(resolvedAt!.getTime() - observedAt.getTime())).toBeLessThan(MINUTE_MS);
  });

  it("is idempotent under duplicate delivery", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    const observedAt = new Date(Date.now() - 5 * MINUTE_MS);

    const first = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("pass", observedAt),
      authoritative: false,
    });
    const second = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("pass", new Date()),
      authoritative: false,
    });

    expect(first.transitioned).toBe(true);
    // The re-delivery observes the same fact again; it must not re-resolve.
    expect(second.transitioned).toBe(false);
    expect(second.status).toBe("kept");

    const runs = await db.select().from(probeRun).where(eq(probeRun.commitmentId, c.id));
    expect(runs).toHaveLength(2); // observations accumulate, resolutions do not

    const { resolvedAt } = await statusOf(c.id);
    expect(Math.abs(resolvedAt!.getTime() - observedAt.getTime())).toBeLessThan(MINUTE_MS);
  });

  it("an intermediate failing probe changes nothing", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    const recorded = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("fail"),
      authoritative: false,
    });
    expect(recorded).toMatchObject({ status: "open", transitioned: false });
  });

  it("an authoritative failing probe — an observation that the condition is false — misses", async () => {
    const c = await newOpenCommitment(new Date(Date.now() - MINUTE_MS));
    const recorded = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("fail"),
      authoritative: true,
    });
    expect(recorded).toMatchObject({ status: "missed", transitioned: true });
    expect((await statusOf(c.id)).resolvedAt).not.toBeNull();
  });

  it("an authoritative ERROR is disputed, never missed", async () => {
    const c = await newOpenCommitment(new Date(Date.now() - MINUTE_MS));
    const recorded = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("error"),
      authoritative: true,
    });
    // The commitment may be unresolvable, but it was never observed to be unmet. Marking
    // this `missed` would blame a person for a DNS failure.
    expect(recorded.status).toBe("disputed");
    expect(recorded.status).not.toBe("missed");
  });

  it("a non-authoritative error leaves the commitment open", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    const recorded = await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("error"),
      authoritative: false,
    });
    expect(recorded).toMatchObject({ status: "open", transitioned: false });
  });

  it("clamps a skewed worker clock so a resolution cannot be backdated", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    const longBeforeTheCommitmentExisted = new Date("2020-01-01T00:00:00Z");

    await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("pass", longBeforeTheCommitmentExisted),
      authoritative: false,
    });

    const { resolvedAt } = await statusOf(c.id);
    expect(resolvedAt!.getTime()).toBeGreaterThan(Date.now() - 16 * MINUTE_MS);
  });

  it("clamps a future-dated observation to now", async () => {
    const c = await newOpenCommitment(new Date(Date.now() + 86_400_000));
    await recordProbeRun(db, {
      commitmentId: c.id,
      result: result("pass", new Date(Date.now() + 86_400_000)),
      authoritative: false,
    });
    const { resolvedAt } = await statusOf(c.id);
    expect(resolvedAt!.getTime()).toBeLessThanOrEqual(Date.now() + MINUTE_MS);
  });
});
