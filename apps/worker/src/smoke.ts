/**
 * v0 exit criterion #1, as a runnable script: `pnpm smoke`.
 *
 *   "A commitment created through the UI resolves to `kept` from an actual probe against a
 *    real repo, with zero manual DB edits."  — roadmap.md, Phase v0
 *
 * What this actually exercises, in order, with no shortcuts around any of it:
 *
 *   1. the web tier's transaction — `insertCommitment` + `enqueueProbeJob` against
 *      DATABASE_URL (role `pledge_web`), which is the exact body of POST /api/v1/commitments
 *   2. pg-boss — the job is fetched back out of `pgboss.job` by pg-boss itself, connected as
 *      `pledge_probe`, exactly as apps/worker does at runtime
 *   3. the real probe — `runProbe` with the real @pledge/safe-fetch against a real public
 *      URL over the real network. Nothing is stubbed; if the network is down this script
 *      fails and says so rather than reporting a pass.
 *   4. resolution — `handleProbeJob` → `recordProbeRun`, which is the only code in the repo
 *      permitted to write `kept`
 *
 * It does NOT drive the browser. Sign-in needs real GitHub OAuth credentials, which do not
 * exist locally; step 1 is the handler's body called directly, which is the closest honest
 * approximation and is stated here rather than glossed.
 *
 * Zero manual DB edits: the only writes are the account row (the equivalent of signing in)
 * and whatever the code under test does. Nothing sets `status` by hand — it could not, the
 * grep in scripts/check-invariants.mjs and the shape of `insertCommitment` both forbid it.
 *
 * Re-runnable: every run creates a fresh commitment and leaves earlier ones alone.
 */
import {
  createDb,
  enqueueProbeJob,
  hashDoneSpec,
  insertCommitment,
  loadDevEnv,
  requireEnv,
  QUEUE_PROBE,
  account as accountTable,
  commitment as commitmentTable,
  probeRun as probeRunTable,
  type Db,
  type DoneSpecV0,
} from "@pledge/db";
import { safeFetch } from "@pledge/safe-fetch";
import { desc, eq } from "drizzle-orm";
import { PgBoss, type Job } from "pg-boss";
import {
  baselineStore,
  handleProbeJob,
  ProbeJobSchema,
  QUEUE_NOTIFY,
  QUEUE_SWEEP,
  type WorkerDeps,
} from "./handlers";
import { nodeDnsDeps } from "./observe";
import { runProbe } from "./probes";

/**
 * A stable public URL that answers 200 and is explicitly maintained for exactly this purpose.
 * The done-condition is genuinely satisfiable and genuinely externally observed — the point
 * of the criterion is that nothing here is self-reported.
 */
const TARGET_URL = "https://example.com";

const SPEC: DoneSpecV0 = { kind: "http_status", url: TARGET_URL, expectedStatus: 200 };

const HANDLE = "smoke-committer";
const DAY_MS = 86_400_000;

function step(message: string): void {
  console.log(`  → ${message}`);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAILED: ${message}`);
}

/**
 * The sign-in equivalent. `upsertAccountFromGithub` needs a GitHub numeric id; this stands in
 * for one deterministically so re-runs reuse the same account instead of piling up handles.
 */
async function ensureAccount(webDb: Db): Promise<string> {
  const [existing] = await webDb
    .select({ id: accountTable.id })
    .from(accountTable)
    .where(eq(accountTable.handle, HANDLE))
    .limit(1);
  if (existing !== undefined) return existing.id;

  const [created] = await webDb
    .insert(accountTable)
    .values({
      handle: HANDLE,
      email: `${HANDLE}@users.noreply.github.com`,
      githubId: 999_000_001,
    })
    .returning({ id: accountTable.id });
  assert(created !== undefined, "account insert returned no row");
  return created.id;
}

async function main(): Promise<void> {
  loadDevEnv();

  const webUrl = requireEnv("DATABASE_URL");
  const probeUrl = requireEnv("DATABASE_URL_PROBE");
  const webDb = createDb(webUrl, { max: 2 });
  const probeDb = createDb(probeUrl, { max: 2 });

  // Same connection string, same schema, same client the worker uses. Starting pg-boss is
  // also what creates the queue the web tier's INSERT has a foreign key to — the ordering
  // constraint documented in packages/db/src/queue.ts, proven here rather than asserted.
  const boss = new PgBoss({ connectionString: probeUrl, schema: "pgboss" });
  boss.on("error", (error: unknown) => console.error("pg-boss error", error));

  try {
    step("starting pg-boss and creating queues (what `pnpm worker` does on boot)");
    await boss.start();
    for (const queue of [QUEUE_PROBE, QUEUE_SWEEP, QUEUE_NOTIFY]) await boss.createQueue(queue);

    step("seeding the committer account (stands in for GitHub sign-in)");
    const accountId = await ensureAccount(webDb);

    // ---- 1. the web tier's write, verbatim ------------------------------------------------
    step("creating the commitment — insertCommitment + enqueueProbeJob, one transaction");
    const { spec, hash } = hashDoneSpec(SPEC);
    const created = await webDb.transaction(async (tx) => {
      const row = await insertCommitment(tx as unknown as Db, {
        accountId,
        claim: `Keep ${TARGET_URL} answering 200`,
        spec,
        doneSpecHash: hash,
        deadline: new Date(Date.now() + DAY_MS),
        estimatedDays: 1,
      });
      await enqueueProbeJob(tx, row.id);
      return row;
    });
    assert(created.status === "open", `new commitment should be open, was ${created.status}`);
    step(`commitment ${created.id} is open, done_spec ${hash.slice(0, 12)}…`);

    // ---- 2. the worker fetches the job the web tier wrote ---------------------------------
    step("fetching the job back out of pg-boss as `pledge_probe`");
    const jobs = (await boss.fetch(QUEUE_PROBE, { batchSize: 25 })) as Job<unknown>[] | null;
    const mine = (jobs ?? []).filter(
      (job) => ProbeJobSchema.safeParse(job.data).data?.commitmentId === created.id,
    );
    assert(
      mine.length === 1,
      `expected exactly one queued probe for ${created.id}, got ${mine.length} ` +
        `(of ${jobs?.length ?? 0} fetched). A payload the worker cannot parse looks like this.`,
    );

    // ---- 3 + 4. real probe, real resolution ----------------------------------------------
    const enqueued: string[] = [];
    const deps: WorkerDeps = {
      db: probeDb,
      enqueue: async (queue) => {
        enqueued.push(queue);
      },
      runProbe: (target) =>
        runProbe(target, {
          safeFetch,
          // Unused by an http_status spec; a placeholder token would be a silent downgrade
          // for a github spec, so this refuses rather than pretending (architecture.md §8).
          github: {
            token: process.env["GITHUB_APP_TOKEN"] ?? "",
            fetchImpl: fetch,
          },
          registryFetch: fetch,
          dns: nodeDnsDeps(),
          now: () => new Date(),
          baseline: baselineStore(probeDb),
        }),
      now: () => new Date(),
      log: { info: (m) => console.log(`     ${m}`), warn: (m) => console.warn(`     ${m}`) },
    };

    step(`probing ${TARGET_URL} over the real network via @pledge/safe-fetch`);
    for (const job of mine) {
      await handleProbeJob(deps, ProbeJobSchema.parse(job.data));
      await boss.complete(QUEUE_PROBE, job.id);
    }

    // ---- assertions ----------------------------------------------------------------------
    const [resolved] = await webDb
      .select({
        status: commitmentTable.status,
        resolvedAt: commitmentTable.resolvedAt,
      })
      .from(commitmentTable)
      .where(eq(commitmentTable.id, created.id))
      .limit(1);
    assert(resolved !== undefined, "commitment vanished");

    const [run] = await webDb
      .select({
        outcome: probeRunTable.outcome,
        probeKind: probeRunTable.probeKind,
        evidence: probeRunTable.evidence,
        ranAt: probeRunTable.ranAt,
      })
      .from(probeRunTable)
      .where(eq(probeRunTable.commitmentId, created.id))
      .orderBy(desc(probeRunTable.ranAt))
      .limit(1);

    assert(run !== undefined, "no probe_run row was written");
    assert(
      run.outcome === "pass",
      `probe outcome was ${run.outcome}, expected pass. ` +
        `evidence: ${JSON.stringify(run.evidence)}. ` +
        `An 'error' here means the target could not be observed — check network access; ` +
        `it is deliberately NOT a failure of the done-condition (CLAUDE.md I-7).`,
    );
    assert(run.probeKind === "http_status", `probe_kind was ${run.probeKind}`);

    const evidence = run.evidence;
    assert(evidence.status === 200, `evidence.status was ${String(evidence.status)}`);
    assert(
      typeof evidence.bodySha256 === "string" && evidence.bodySha256.length === 64,
      "evidence carries no body hash — the observation is not inspectable",
    );
    assert(
      typeof evidence.resolvedIp === "string",
      "evidence carries no resolved IP — the SSRF audit trail is missing",
    );

    assert(
      resolved.status === "kept",
      `commitment status was ${resolved.status}, expected kept`,
    );
    assert(resolved.resolvedAt !== null, "kept commitment has no resolved_at");
    assert(
      enqueued.includes(QUEUE_NOTIFY),
      "resolution did not enqueue a notification — the mail path is not wired",
    );

    console.log("");
    console.log(`  SMOKE PASSED — commitment ${created.id}`);
    console.log(`    status      ${resolved.status}`);
    console.log(`    resolved_at ${resolved.resolvedAt?.toISOString() ?? "-"}`);
    console.log(
      `    observed    ${TARGET_URL} → ${String(evidence.status)} @ ${evidence.resolvedIp}`,
    );
    console.log(`    body sha256 ${evidence.bodySha256}`);
    console.log(`    profile     ${process.env["NEXT_PUBLIC_BASE_URL"] ?? ""}/${HANDLE}`);
  } finally {
    await boss.stop().catch(() => undefined);
    await webDb.$client.end();
    await probeDb.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
