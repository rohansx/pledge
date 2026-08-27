/**
 * Crash safety and ledger atomicity — the v1 exit criterion that says killing the worker
 * mid-probe must leave no partial state (roadmap.md v1).
 *
 * The crash here is REAL. Not a mocked rejection and not a thrown error at a seam we chose: a
 * separate worker process is started, allowed to reach the middle of its resolution
 * transaction — `probe_run` inserted, chain lock not yet acquired — and then SIGKILLed. That is
 * the exact shape of an OOM kill or a container eviction at the worst possible instant, and it
 * is the only version of this test that proves the database rolls the work back rather than
 * proving our error handling agrees with itself.
 *
 * INVARIANT I-3 is what is being checked: the ledger append and the state change it records
 * share one transaction. If the append does not happen, neither does the observation, and
 * neither does the resolution.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  account,
  chainHead,
  closeDb,
  commitment,
  createDb,
  hashDoneSpec,
  insertCommitment,
  ledgerEntry,
  loadDevEnv,
  probeRun,
  requireEnv,
  type Db,
  type ProbeResult,
} from "@pledge/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleProbeJob, type WorkerDeps } from "./handlers";

let owner: Db;
let probeDb: Db;

/** Passed to the child so we terminate its backend and nobody else's. */
const APPLICATION_NAME = "pledge-crash-child";

beforeAll(() => {
  loadDevEnv();
  owner = createDb(requireEnv("DATABASE_URL"), { max: 3 });
  probeDb = createDb(requireEnv("DATABASE_URL_PROBE"), { max: 1 });
});

afterAll(async () => {
  await closeDb(owner);
  await closeDb(probeDb);
});

async function seedCommitment(deadline: Date): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [acct] = await owner
    .insert(account)
    .values({
      handle: `crash-${suffix}`,
      email: `crash-${suffix}@example.test`,
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
    claim: "crash safety",
    spec,
    doneSpecHash: hash,
    deadline,
  });
  return row.id;
}

function passing(ranAt: Date): ProbeResult {
  return {
    probeKind: "http_status",
    outcome: "pass",
    evidence: { status: 200, matches: ["200"] },
    ranAt,
    durationMs: 4,
  };
}

function deps(db: Db, now: Date): WorkerDeps {
  return {
    db,
    enqueue: async () => {},
    runProbe: () => Promise.resolve(passing(now)),
    now: () => now,
    log: { info: () => {}, warn: () => {} },
  };
}

const state = async (id: string) => {
  const [row] = await owner
    .select({ status: commitment.status, resolvedAt: commitment.resolvedAt })
    .from(commitment)
    .where(eq(commitment.id, id))
    .limit(1);
  return row!;
};

const runCount = async (id: string): Promise<number> => {
  const [row] = await owner
    .select({ n: sql<number>`count(*)::int` })
    .from(probeRun)
    .where(eq(probeRun.commitmentId, id));
  return row!.n;
};

/**
 * This commitment's entries, in chain order. `commitment_created` is already there — apps/web
 * appended it in the transaction that made the commitment — so the probe path's contribution
 * is whatever follows it.
 */
const ledgerStory = async (id: string): Promise<string[]> => {
  const rows = await owner
    .select({ entryType: ledgerEntry.entryType })
    .from(ledgerEntry)
    .where(sql`${ledgerEntry.payload}->>'commitmentId' = ${id}`)
    .orderBy(ledgerEntry.seq);
  return rows.map((row) => row.entryType);
};

/**
 * The chain is global (ADR-0003), so its head moves whenever anything else appends — including
 * another test file running in parallel. Only ever assert that it moved FORWARD; "by exactly
 * two" is a per-commitment claim, and ./ledgerStory is what makes it.
 */
const chainSeq = async (): Promise<number> => {
  const [head] = await owner.select({ seq: chainHead.seq }).from(chainHead).limit(1);
  return head!.seq;
};

/**
 * Waits until a `pledge_probe` backend is blocked on a lock, which is how we know the child is
 * inside the transaction: it has inserted its `probe_run` row and is waiting for the global
 * chain lock to append the entry that records it. Killing it anywhere else would prove less.
 */
async function waitForBlockedProbe(timeoutMs = 20_000): Promise<boolean> {
  return waitFor(timeoutMs, async () => {
    const rows = await owner.execute<{ pid: number }>(sql`
      select pid from pg_stat_activity
      where application_name = ${APPLICATION_NAME} and wait_event_type = 'Lock'
    `);
    return rows[0]?.pid !== undefined;
  });
}

/**
 * The child is gone when its backend is. Waiting on the *connection* rather than on the
 * process exit is what makes this test deterministic: a killed process's socket closes and
 * Postgres rolls the transaction back a moment later, and reading the tables before that
 * happens would be reading a transaction still in flight.
 */
async function waitForProbeBackendGone(timeoutMs = 20_000): Promise<boolean> {
  return waitFor(timeoutMs, async () => {
    const rows = await owner.execute<{ pid: number }>(sql`
      select pid from pg_stat_activity where application_name = ${APPLICATION_NAME}
    `);
    return rows.length === 0;
  });
}

async function waitFor(timeoutMs: number, check: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

describe("a forced crash mid-probe", () => {
  it("leaves the commitment open with no observation and no ledger entry, and a re-run resolves it", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));

    // Hold the global chain lock (ADR-0003) so the child stops with the probe_run row inserted
    // and the ledger append not yet made — the one instant where a non-atomic implementation
    // would leave an observation with no entry behind it.
    const blocker = createDb(requireEnv("DATABASE_URL"), { max: 1 });
    let releaseLock = (): void => {};
    const held = blocker.transaction(async (tx) => {
      await tx.execute(sql`select seq from chain_head where id = 1 for update`);
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });

    // Its own process group, so the SIGKILL reaches the whole `npx → tsx → node` chain.
    // Signalling only the npx wrapper leaves the node process alive to finish its transaction
    // the moment the lock is released — which is not a crash, and would make this test lie.
    const child = spawn(
      "npx",
      ["tsx", "apps/worker/src/crash-child.ts", id, APPLICATION_NAME],
      { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"], detached: true },
    );
    const exited = new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(await waitForBlockedProbe()).toBe(true);
    process.kill(-child.pid!, "SIGKILL");
    await exited;

    // Release the lock BEFORE waiting for the backend to go away, and not the other way
    // round. A backend blocked on a heavyweight lock is not reading from its client, so
    // Postgres does not notice the socket died until it gets back to the client-read loop
    // (`client_connection_check_interval` is 0 by default). Waiting first would wait for
    // something that cannot happen while we hold the lock it is queued on.
    releaseLock();
    await held;
    await closeDb(blocker);

    // Now the dead backend wakes, finds nobody to answer to, and Postgres rolls it back.
    // The transaction is only gone when the connection is: reading the tables any earlier
    // would be reading a transaction still in flight.
    expect(await waitForProbeBackendGone()).toBe(true);

    // Nothing survived. Not the observation, not the entry, not a resolution — the story is
    // still just the commitment being made.
    expect(await state(id)).toMatchObject({ status: "open", resolvedAt: null });
    expect(await runCount(id)).toBe(0);
    expect(await ledgerStory(id)).toEqual(["commitment_created"]);

    // And the work is not lost: the re-delivered job resolves it.
    await handleProbeJob(deps(probeDb, now), { commitmentId: id, authoritative: false });

    expect((await state(id)).status).toBe("kept");
    // One observation, and the two entries it earned.
    expect(await runCount(id)).toBe(1);
    expect(await ledgerStory(id)).toEqual(["commitment_created", "probe_result", "resolved"]);
  }, 60_000);
});

describe("ledger append atomicity", () => {
  it("appends the observation and the resolution in one transaction, advancing the chain by two", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));
    const before = await chainSeq();

    await handleProbeJob(deps(probeDb, now), { commitmentId: id, authoritative: false });

    expect((await state(id)).status).toBe("kept");
    expect(await runCount(id)).toBe(1);
    // Exactly two appends for one probe: the observation, and the resolution it earned.
    expect(await ledgerStory(id)).toEqual(["commitment_created", "probe_result", "resolved"]);
    expect(await chainSeq()).toBeGreaterThanOrEqual(before + 2);
  });

  it("does not append a second resolution entry on a duplicate delivery", async () => {
    const now = new Date();
    const id = await seedCommitment(new Date(now.getTime() + 86_400_000));
    const job = { commitmentId: id, authoritative: false };

    await handleProbeJob(deps(probeDb, now), job);
    await handleProbeJob(deps(probeDb, now), job);
    await handleProbeJob(deps(probeDb, now), job);

    // The re-deliveries stop at the "is it still open?" guard, so there is one of each.
    expect(await runCount(id)).toBe(1);
    expect(await ledgerStory(id)).toEqual(["commitment_created", "probe_result", "resolved"]);
  });
});
