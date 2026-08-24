/**
 * Probe worker entrypoint.
 *
 * The role gate is the whole reason this file starts the way it does: a preview deployment
 * that ran probes would double-probe live commitments from an unpinned egress IP and race the
 * `kept` transition (architecture.md §9). PLEDGE_ROLE=worker is set in production and nowhere
 * else.
 *
 * This process connects with DATABASE_URL_PROBE (the column-restricted `pledge_probe` role),
 * never DATABASE_URL. That isolation is the control that survives an SSRF bypass
 * (security.md T-01, control 7) — do not "temporarily" point it at the full role.
 */
import { createDb, loadDevEnv, requireEnv } from "@pledge/db";
import { safeFetch } from "@pledge/safe-fetch";
import { PgBoss, type Job } from "pg-boss";
import {
  handleProbeJob,
  handleSweep,
  ProbeJobSchema,
  QUEUE_NOTIFY,
  QUEUE_PROBE,
  QUEUE_SWEEP,
  type Enqueue,
  type WorkerDeps,
} from "./handlers";
import { runProbe } from "./probes";

/** 03:00 UTC daily. Fixed, not a backoff curve — the curve is v1 (roadmap deferred list). */
const SWEEP_CRON = "0 3 * * *";

export function assertWorkerRole(role: string | undefined): void {
  if (role !== "worker") {
    throw new Error(
      `Refusing to start: PLEDGE_ROLE is ${role ?? "unset"}, expected "worker". ` +
        `Probe workers must never run outside production (architecture.md §9).`,
    );
  }
}

async function main(): Promise<void> {
  loadDevEnv();
  assertWorkerRole(process.env.PLEDGE_ROLE);

  const databaseUrl = requireEnv("DATABASE_URL_PROBE");
  // Required, not optional: architecture.md §8 forbids falling back to unauthenticated GitHub
  // for a resolution-critical run, so a missing token has to be a loud startup failure rather
  // than a silent downgrade discovered at someone's deadline.
  const githubToken = requireEnv("GITHUB_APP_TOKEN");

  const db = createDb(databaseUrl);
  const boss = new PgBoss({ connectionString: databaseUrl, schema: "pgboss" });
  boss.on("error", (error: unknown) => {
    console.error("pg-boss error", error);
  });
  await boss.start();

  for (const queue of [QUEUE_PROBE, QUEUE_SWEEP, QUEUE_NOTIFY]) {
    await boss.createQueue(queue);
  }

  const enqueue: Enqueue = async (queue, data, startAfterSeconds) => {
    await boss.send(
      queue,
      data,
      startAfterSeconds === undefined ? {} : { startAfter: Math.ceil(startAfterSeconds) },
    );
  };

  const deps: WorkerDeps = {
    db,
    enqueue,
    runProbe: (spec) =>
      runProbe(spec, {
        safeFetch,
        github: { token: githubToken, fetchImpl: fetch },
        now: () => new Date(),
      }),
    now: () => new Date(),
    log: {
      info: (message) => console.log(message),
      warn: (message) => console.warn(message),
    },
  };

  await boss.schedule(QUEUE_SWEEP, SWEEP_CRON, {}, { tz: "UTC" });
  await boss.work(QUEUE_SWEEP, async () => {
    await handleSweep(deps);
  });

  await boss.work(QUEUE_PROBE, { batchSize: 8 }, async (jobs: Job<unknown>[]) => {
    // Jobs are independent observations of different targets; one unreachable host must not
    // take the batch down with it. A rejected job is retried by pg-boss on its own.
    const outcomes = await Promise.allSettled(
      jobs.map((job) => handleProbeJob(deps, ProbeJobSchema.parse(job.data))),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") console.error("probe job failed", outcome.reason);
    }
  });

  console.log(`pledge worker running against ${new URL(databaseUrl).host}`);

  const stop = async (signal: string): Promise<void> => {
    console.log(`${signal} received, draining`);
    await boss.stop();
    await db.$client.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
