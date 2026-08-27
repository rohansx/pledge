/**
 * Test support for ./crash.test.ts. Not part of the worker and not started by anything else.
 *
 * A whole separate process exists here for one reason: the v1 exit criterion is "killing the
 * worker mid-probe leaves no partial state", and the only way to kill a worker is to kill a
 * worker. SIGKILL to this process, while it sits inside the resolution transaction with a
 * `probe_run` row inserted and the chain lock not yet acquired, is the real event — an OOM
 * kill, a container eviction, a `kill -9` from an operator — rather than a rejected promise we
 * arranged at a seam of our choosing.
 *
 * The parent passes an `application_name` tag so it can find THIS process's backend in
 * pg_stat_activity: other probe connections contend the same global chain lock, and killing
 * the wrong one would prove nothing about this run.
 */
import { closeDb, createDb, loadDevEnv, requireEnv } from "@pledge/db";
import { handleProbeJob } from "./handlers";

const [, , commitmentId, applicationName] = process.argv;
if (commitmentId === undefined || applicationName === undefined) {
  throw new Error("usage: crash-child.ts <commitment-id> <application-name>");
}

loadDevEnv();

const url = new URL(requireEnv("DATABASE_URL_PROBE"));
url.searchParams.set("application_name", applicationName);
const db = createDb(url.toString(), { max: 1 });

console.log("connected");

await handleProbeJob(
  {
    db,
    enqueue: () => Promise.resolve(),
    runProbe: () =>
      Promise.resolve({
        probeKind: "http_status" as const,
        outcome: "pass" as const,
        evidence: { status: 200, matches: ["200"] },
        ranAt: new Date(),
        durationMs: 3,
      }),
    now: () => new Date(),
    log: { info: () => {}, warn: () => {} },
  },
  { commitmentId, authoritative: false },
);

await closeDb(db);
console.log("resolved");
