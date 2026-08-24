/**
 * Resolution behaviour, against the real database — because the guarantees being asserted are
 * enforced by a guarded UPDATE and a `min(ran_at)` sub-select, and a mocked database would
 * assert only that this test agrees with itself.
 *
 * What is proved here:
 *   · a network failure at deadline+0 never produces `missed` (CLAUDE.md I-7)
 *   · an unobservable target is retried through a grace window, then `disputed`
 *   · a duplicate pg-boss delivery resolves nothing twice
 *   · `resolved_at` is the earliest PASSING observation, not the time the worker noticed
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import {
  account,
  closeDb,
  commitment,
  createDb,
  hashDoneSpec,
  insertCommitment,
  loadDevEnv,
  probeRun,
  recordProbeRun,
  requireEnv,
  type Db,
  type DoneSpecV0,
  type ProbeOutcome,
  type ProbeResult,
} from "@pledge/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  decideGrace,
  GRACE_WINDOW_MS,
  handleProbeJob,
  handleSweep,
  QUEUE_NOTIFY,
  QUEUE_PROBE,
  UNREACHABLE_AT_DEADLINE,
  type WorkerDeps,
} from "./handlers";

let owner: Db;
let probeDb: Db;

beforeAll(() => {
  loadDevEnv();
  owner = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  probeDb = createDb(requireEnv("DATABASE_URL_PROBE"), { max: 2 });
});

afterAll(async () => {
  await closeDb(owner);
  await closeDb(probeDb);
});

interface Enqueued {
  readonly queue: string;
  readonly data: Record<string, unknown>;
  readonly startAfterSeconds?: number;
}

/** A commitment nobody else's test can touch, so runs do not have to be cleaned up. */
async function seedCommitment(deadline: Date): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [acct] = await owner
    .insert(account)
    .values({
      handle: `worker-${suffix}`,
      email: `worker-${suffix}@example.test`,
      githubId: -Number.parseInt(suffix, 16),
    })
    .returning({ id: account.id });

  const { spec, hash } = hashDoneSpec({
    kind: "http_status",
    url: `https://${suffix}.example.test/ship`,
    expectedStatus: 200,
  });

  const row = await insertCommitment(owner, {
    accountId: acct!.id,
    claim: "worker resolution test",
    spec,
    doneSpecHash: hash,
    deadline,
  });
  return row.id;
}

function result(outcome: ProbeOutcome, ranAt: Date): ProbeResult {
  return {
    probeKind: "http_status",
    outcome,
    evidence:
      outcome === "error"
        ? { error: { code: "connection_failed", message: "ECONNREFUSED" } }
        : { status: outcome === "pass" ? 200 : 503 },
    ranAt,
    durationMs: 5,
  };
}

function deps(overrides: {
  readonly outcome: ProbeOutcome;
  readonly ranAt?: Date;
  readonly now?: Date;
  readonly sink: Enqueued[];
}): WorkerDeps {
  const now = overrides.now ?? new Date();
  return {
    db: probeDb,
    enqueue: async (queue, data, startAfterSeconds) => {
      overrides.sink.push({ queue, data, startAfterSeconds });
    },
    runProbe: (_spec: DoneSpecV0) =>
      Promise.resolve(result(overrides.outcome, overrides.ranAt ?? now)),
    now: () => now,
    log: { info: () => {}, warn: () => {} },
  };
}

async function statusOf(commitmentId: string) {
  const [row] = await owner
    .select({ status: commitment.status, resolvedAt: commitment.resolvedAt })
    .from(commitment)
    .where(eq(commitment.id, commitmentId))
    .limit(1);
  return row!;
}

async function runsFor(commitmentId: string) {
  return owner
    .select({ outcome: probeRun.outcome, ranAt: probeRun.ranAt, evidence: probeRun.evidence })
    .from(probeRun)
    .where(eq(probeRun.commitmentId, commitmentId))
    .orderBy(desc(probeRun.ranAt));
}

describe("deadline+0 with an unobservable target", () => {
  it("does not mark the commitment missed — it retries inside the grace window", async () => {
    const now = new Date();
    const deadline = new Date(now.getTime() - 60_000);
    const id = await seedCommitment(deadline);
    const sink: Enqueued[] = [];

    await handleProbeJob(deps({ outcome: "error", now, sink }), {
      commitmentId: id,
      authoritative: true,
    });

    const after = await statusOf(id);
    expect(after.status).not.toBe("missed");
    expect(after.status).toBe("open");
    expect(after.resolvedAt).toBeNull();

    // The observation is still logged — an error is a fact about the attempt.
    const runs = await runsFor(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("error");

    const retry = sink.find((e) => e.queue === QUEUE_PROBE);
    expect(retry?.data).toMatchObject({ commitmentId: id, authoritative: true });
    expect(retry?.data.graceUntil).toBe(
      new Date(deadline.getTime() + GRACE_WINDOW_MS).toISOString(),
    );
    expect(sink.some((e) => e.queue === QUEUE_NOTIFY)).toBe(false);
  });

  it("becomes disputed, never missed, once the grace window has run out", async () => {
    const now = new Date();
    const deadline = new Date(now.getTime() - GRACE_WINDOW_MS - 120_000);
    const id = await seedCommitment(deadline);
    const sink: Enqueued[] = [];

    await handleProbeJob(deps({ outcome: "error", now, sink }), {
      commitmentId: id,
      authoritative: true,
      graceUntil: new Date(now.getTime() - 60_000).toISOString(),
    });

    const after = await statusOf(id);
    expect(after.status).toBe("disputed");
    expect(after.status).not.toBe("missed");
    expect(after.resolvedAt).not.toBeNull();

    const runs = await runsFor(id);
    expect(runs[0]!.evidence.error?.message).toContain(UNREACHABLE_AT_DEADLINE);
    // No further retries once we have given up and said so.
    expect(sink.some((e) => e.queue === QUEUE_PROBE)).toBe(false);
    expect(sink.some((e) => e.queue === QUEUE_NOTIFY)).toBe(true);
  });

  it("still marks missed when the deadline run actually observed the condition to be false", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() - 60_000));
    const sink: Enqueued[] = [];

    await handleProbeJob(deps({ outcome: "fail", now, sink }), {
      commitmentId: id,
      authoritative: true,
    });

    expect((await statusOf(id)).status).toBe("missed");
  });

  it("ignores a failing probe that is not the authoritative run", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));
    const sink: Enqueued[] = [];

    await handleProbeJob(deps({ outcome: "fail", now, sink }), {
      commitmentId: id,
      authoritative: false,
    });

    // A repo without its release at T-24h is not a miss (technical-spec §6).
    expect((await statusOf(id)).status).toBe("open");
    expect(await runsFor(id)).toHaveLength(1);
  });
});

describe("earliest-pass stamping", () => {
  it("stamps resolved_at with the observation time, not the time the worker noticed", async () => {
    const now = new Date();
    const observedAt = new Date(now.getTime() - 10 * 60_000);
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));
    const sink: Enqueued[] = [];

    await handleProbeJob(deps({ outcome: "pass", ranAt: observedAt, now, sink }), {
      commitmentId: id,
      authoritative: false,
    });

    const after = await statusOf(id);
    expect(after.status).toBe("kept");
    // Within a second of the probe's ran_at, and nowhere near "now".
    expect(Math.abs(after.resolvedAt!.getTime() - observedAt.getTime())).toBeLessThan(1000);
    expect(after.resolvedAt!.getTime()).toBeLessThan(now.getTime() - 5 * 60_000);
    expect(sink.filter((e) => e.queue === QUEUE_NOTIFY)).toHaveLength(1);
  });

  it("keeps the earliest passing observation when a later pass arrives", async () => {
    const now = new Date();
    const first = new Date(now.getTime() - 10 * 60_000);
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));

    await recordProbeRun(probeDb, {
      commitmentId: id,
      result: result("pass", first),
      authoritative: false,
    });
    const afterFirst = await statusOf(id);

    // A second, later passing observation — the shape a duplicate delivery takes at the
    // storage layer, below the handler's "is it still open?" guard.
    await recordProbeRun(probeDb, {
      commitmentId: id,
      result: result("pass", now),
      authoritative: false,
    });
    const afterSecond = await statusOf(id);

    expect(afterSecond.status).toBe("kept");
    expect(afterSecond.resolvedAt!.getTime()).toBe(afterFirst.resolvedAt!.getTime());
    expect(await runsFor(id)).toHaveLength(2);
  });
});

describe("duplicate delivery", () => {
  it("resolves once, no matter how many times pg-boss delivers the job", async () => {
    const now = new Date();
    const observedAt = new Date(now.getTime() - 60_000);
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));
    const sink: Enqueued[] = [];
    const job = { commitmentId: id, authoritative: false };

    const d = deps({ outcome: "pass", ranAt: observedAt, now, sink });
    await handleProbeJob(d, job);
    const afterFirst = await statusOf(id);
    await handleProbeJob(d, job);
    await handleProbeJob(d, job);
    const afterThird = await statusOf(id);

    expect(afterFirst.status).toBe("kept");
    expect(afterThird.status).toBe("kept");
    expect(afterThird.resolvedAt!.getTime()).toBe(afterFirst.resolvedAt!.getTime());
    // Re-deliveries stop at the "still open?" check, so the target is not hit again either.
    expect(await runsFor(id)).toHaveLength(1);
    expect(sink.filter((e) => e.queue === QUEUE_NOTIFY)).toHaveLength(1);
  });

  it("does not re-resolve a commitment that a witness or amendment already moved", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() - 60_000));
    await owner
      .update(commitment)
      .set({ status: "abandoned", resolvedAt: now })
      .where(eq(commitment.id, id));

    const sink: Enqueued[] = [];
    await handleProbeJob(deps({ outcome: "fail", now, sink }), {
      commitmentId: id,
      authoritative: true,
    });

    expect((await statusOf(id)).status).toBe("abandoned");
    expect(await runsFor(id)).toHaveLength(0);
  });
});

describe("sweep", () => {
  it("enqueues a routine probe now and the authoritative run at the deadline", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 2 * 60 * 60_000));
    const sink: Enqueued[] = [];

    await handleSweep(deps({ outcome: "pass", now, sink }));

    const mine = sink.filter((e) => e.data.commitmentId === id);
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ queue: QUEUE_PROBE, data: { authoritative: false } });
    expect(mine[1]!.data.authoritative).toBe(true);
    expect(mine[1]!.startAfterSeconds).toBeGreaterThan(7000);
  });

  it("does not schedule a deadline run that is still weeks away", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 30 * 86_400_000));
    const sink: Enqueued[] = [];

    await handleSweep(deps({ outcome: "pass", now, sink }));

    const mine = sink.filter((e) => e.data.commitmentId === id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.data.authoritative).toBe(false);
  });
});

describe("decideGrace", () => {
  const deadline = new Date("2026-08-24T00:00:00.000Z");
  const atDeadline = deadline;

  it("never finalises a non-authoritative run", () => {
    for (const outcome of ["pass", "fail", "error"] as const) {
      expect(
        decideGrace({ authoritative: false, outcome, deadline, now: atDeadline }).finalize,
      ).toBe(false);
    }
  });

  it("finalises an observation immediately", () => {
    for (const outcome of ["pass", "fail"] as const) {
      const decision = decideGrace({ authoritative: true, outcome, deadline, now: atDeadline });
      expect(decision.finalize).toBe(true);
      expect(decision.retryInSeconds).toBeUndefined();
    }
  });

  it("retries an unobservable target instead of finalising it", () => {
    const decision = decideGrace({
      authoritative: true,
      outcome: "error",
      deadline,
      now: atDeadline,
    });

    expect(decision.finalize).toBe(false);
    expect(decision.retryInSeconds).toBe(600);
    expect(decision.graceUntil).toEqual(new Date(deadline.getTime() + GRACE_WINDOW_MS));
  });

  it("shortens the last retry so it lands inside the window, not after it", () => {
    const decision = decideGrace({
      authoritative: true,
      outcome: "error",
      deadline,
      now: new Date(deadline.getTime() + GRACE_WINDOW_MS - 60_000),
    });

    expect(decision.retryInSeconds).toBe(60);
  });

  it("finalises once the window is spent", () => {
    const decision = decideGrace({
      authoritative: true,
      outcome: "error",
      deadline,
      now: new Date(deadline.getTime() + GRACE_WINDOW_MS),
    });

    expect(decision.finalize).toBe(true);
    expect(decision.retryInSeconds).toBeUndefined();
  });
});
