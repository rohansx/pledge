/**
 * Create the pg-boss schema and the queues the app writes to.
 *
 * WHY THIS EXISTS
 *
 * `enqueueProbeJob` inserts straight into `pgboss.job`, inside the same transaction as the
 * commitment insert — that shared transaction is the whole reason the queue lives in Postgres
 * (ADR-0002). But the `pgboss` schema itself is created by pg-boss at `boss.start()`, which
 * only happens when apps/worker boots. So on any database where the worker has never run,
 * the first commit fails with `relation "pgboss.job" does not exist`.
 *
 * Every developer machine had run the worker at least once, so nobody saw it. CI never runs
 * the worker — PLEDGE_ROLE is deliberately never `worker` there, because a CI box must not
 * probe real targets from an unpinned egress IP (CLAUDE.md, Conventions) — so CI was the
 * first environment to hit it.
 *
 * This makes the schema an explicit, idempotent setup step instead of a side effect of
 * booting a process that CI must not boot.
 */
import { PgBoss } from "pg-boss";

import { QUEUE_PROBE, loadDevEnv, requireEnv } from "@pledge/db";

/** Queues the web tier can write to before any worker has ever run. */
const QUEUES = [QUEUE_PROBE] as const;

export async function initQueues(connectionString: string): Promise<void> {
  const boss = new PgBoss({ connectionString, schema: "pgboss" });
  await boss.start();
  try {
    for (const queue of QUEUES) {
      // createQueue is idempotent; re-running it on an initialised database is a no-op.
      await boss.createQueue(queue);
    }
  } finally {
    // pg-boss 12's stop() does not resolve without a registered worker, so it is not awaited
    // here — the same reason apps/worker's signal handler does not await it either.
    void boss.stop();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  loadDevEnv(import.meta.dirname);
  initQueues(requireEnv("DATABASE_URL"))
    .then(() => {
      console.log(`queues ready: ${QUEUES.join(", ")}`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error("queue init failed:", error);
      process.exit(1);
    });
}
