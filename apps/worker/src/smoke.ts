/**
 * The v1 loop, end to end, as a runnable script: `pnpm smoke`.
 *
 * v0's criterion was "a commitment resolves to `kept` from an actual probe, with zero manual
 * DB edits". v1's is bigger, and this script is the whole of it in one pass:
 *
 *   1. a commitment created FROM A TEMPLATE, compiled through the real DSL, with a witness
 *      invited — the exact body of POST /api/v1/commitments plus POST /api/v1/witness
 *   2. its `commitment_created` ledger entry, with the chain step RECOMPUTED from the stored
 *      payload rather than trusted
 *   3. the baseline snapshot, over the real network, before anything can resolve
 *   4. a deadline amendment with a reason, and its `amended` entry
 *   5. the real probe → resolution, with `probe_result` and `resolved` entries
 *   6. the full chain walked from genesis (what `pnpm ledger:verify` runs)
 *   7. a signed receipt, verified by `pledge-verify` IN A SEPARATE PROCESS WITH NO
 *      CREDENTIALS — no DATABASE_URL, no signing key, no witness secret. That is the v1 exit
 *      criterion, and running it in this process with the environment already loaded would
 *      demonstrate nothing.
 *
 * Nothing is stubbed. The probe goes over the real network via @pledge/safe-fetch; if the
 * network is unavailable this script fails and says so rather than reporting a pass. An
 * `error` outcome is reported as "could not observe", never as a failed done-condition
 * (CLAUDE.md I-7) — the message says which.
 *
 * It does NOT drive the browser: sign-in needs real GitHub OAuth credentials, which do not
 * exist locally, so step 1 calls the handlers' bodies directly. That is the closest honest
 * approximation and is stated here rather than glossed.
 *
 * Zero manual DB edits. The only write not made by code under test is the account row, which
 * stands in for signing in. Nothing sets `status` by hand — it could not: the grep in
 * scripts/check-invariants.mjs and the shape of `insertCommitment` both forbid it.
 *
 * Re-runnable: every run creates a fresh commitment and leaves earlier ones alone.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  amendment as amendmentTable,
  buildReceipt,
  createDb,
  enqueueProbeJob,
  insertCommitment,
  ledgerEntry as ledgerEntryTable,
  loadDevEnv,
  requireEnv,
  verifyLedgerChain,
  witness as witnessTable,
  QUEUE_PROBE,
  account as accountTable,
  commitment as commitmentTable,
  probeRun as probeRunTable,
  type Db,
} from "@pledge/db";
import { computeEntry, type JsonValue } from "@pledge/ledger";
import { safeFetch } from "@pledge/safe-fetch";
import { SPEC_VERSION, SpecNodeSchema, compile, getTemplate } from "@pledge/spec";
import { recordAmendment } from "@pledge/web/lib/amendments";
import { dayInZone, endOfDayInZone } from "@pledge/web/lib/deadline";
import { inviteWitnesses } from "@pledge/web/lib/witness";
import { asc, desc, eq, sql } from "drizzle-orm";
import { PgBoss, type Job } from "pg-boss";
import {
  baselineStore,
  handleProbeJob,
  ProbeJobSchema,
  QUEUE_NOTIFY,
  QUEUE_SWEEP,
  type WorkerDeps,
} from "./handlers";
import { collectTargets, nodeDnsDeps, observeAll, targetDigest } from "./observe";
import { runProbe } from "./probes";

/**
 * A stable public page that answers 200, is comfortably over the template's 2000-byte floor,
 * and contains the phrase. Chosen because the done-condition has to be genuinely satisfiable
 * and genuinely externally observed — the whole point of the criterion is that nothing here is
 * self-reported.
 *
 * `url_live_with_content` is deliberately the template used: it is the only one of the five
 * whose sources need no GitHub token, and it expands to a THREE-clause `and` over one source,
 * which exercises multi-accessor collection and the evaluator's subresults rather than a
 * single trivial comparison.
 */
const TARGET_URL = "https://www.iana.org/help/example-domains";
const TARGET_PHRASE = "example.com";
const TEMPLATE_ID = "url_live_with_content" as const;

const HANDLE = "smoke-committer";
/**
 * The committer's zone, and not UTC on purpose: `Asia/Kolkata` is UTC+05:30 with no DST, so a
 * half-hour offset and a UTC date boundary are both in play (CLAUDE.md I-9). A deadline that
 * only ever round-trips through UTC in the smoke would not exercise the arithmetic the unit
 * tests care about.
 */
const ZONE = "Asia/Kolkata";
const WITNESS_EMAIL = "smoke-witness@example.test";
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

interface StoredEntryRow {
  readonly seq: number;
  readonly entryType: string;
  readonly payload: unknown;
  readonly prevHash: string;
  readonly entryHash: string;
}

/** Every ledger entry naming this commitment, oldest first. */
async function entriesFor(webDb: Db, commitmentId: string): Promise<readonly StoredEntryRow[]> {
  return webDb
    .select({
      seq: ledgerEntryTable.seq,
      entryType: ledgerEntryTable.entryType,
      payload: ledgerEntryTable.payload,
      prevHash: ledgerEntryTable.prevHash,
      entryHash: ledgerEntryTable.entryHash,
    })
    .from(ledgerEntryTable)
    .where(sql`${ledgerEntryTable.payload}->>'commitmentId' = ${commitmentId}`)
    .orderBy(asc(ledgerEntryTable.seq));
}

/**
 * Recomputes one entry's hash from its stored payload and asserts it matches.
 *
 * This is the check a stranger runs, done here on one entry at the moment it is written, so a
 * break is attributed to the append that caused it rather than surfacing later as "somewhere
 * in 1400 entries". Step 6 does the same thing over the whole chain.
 */
function assertChains(entry: StoredEntryRow, label: string): void {
  const recomputed = computeEntry({
    seq: entry.seq,
    prevHash: entry.prevHash,
    payload: entry.payload as JsonValue,
  });
  assert(
    recomputed.entryHash === entry.entryHash,
    `${label} entry at seq ${entry.seq} does not fold: stored ${entry.entryHash.slice(0, 16)}…, ` +
      `recomputed ${recomputed.entryHash.slice(0, 16)}…`,
  );
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

    // ---- 1. template → DSL → the web tier's write ------------------------------------------
    const template = getTemplate(TEMPLATE_ID);
    const source = template.expand({ url: TARGET_URL, content: TARGET_PHRASE });
    step(`template "${template.label}" expands to:`);
    console.log(`       ${source}`);

    const compiled = compile(source);
    assert(
      compiled.ok,
      `the template's own expansion does not compile: ${JSON.stringify(compiled.ok ? [] : compiled.issues)}`,
    );
    const spec = compiled.spec;
    step(`compiled: ${spec.probeClass} class, hash ${spec.hash.slice(0, 12)}…`);

    step("creating the commitment — insertCommitment + enqueueProbeJob, one transaction");
    // The composer resolves a calendar day in the committer's zone to that day's last instant;
    // this does the same, through the same function, so the smoke's deadline is the shape a
    // real one has rather than a round number of milliseconds.
    const originalDate = dayInZone(new Date(Date.now() + DAY_MS), ZONE);
    const originalDeadline = endOfDayInZone(originalDate, ZONE);
    const created = await webDb.transaction(async (tx) => {
      const row = await insertCommitment(tx, {
        accountId,
        claim: `Ship the changelog page at ${TARGET_URL}`,
        spec: spec.ast,
        doneSpecHash: spec.hash,
        specVersion: SPEC_VERSION,
        deadline: originalDeadline,
        estimatedDays: 1,
      });
      await enqueueProbeJob(tx, row.id);
      return row;
    });
    assert(created.status === "open", `new commitment should be open, was ${created.status}`);
    step(`commitment ${created.id} is open`);

    step(`inviting a witness (${WITNESS_EMAIL}) — accountless, ADR-0006`);
    const invitations = await inviteWitnesses({
      commitmentId: created.id,
      accountId,
      emails: [WITNESS_EMAIL],
    });
    assert(invitations.length === 1, `expected one invitation, got ${invitations.length}`);
    const [invited] = await webDb
      .select({ id: witnessTable.id, usedAt: witnessTable.usedAt })
      .from(witnessTable)
      .where(eq(witnessTable.commitmentId, created.id));
    assert(invited !== undefined, "witness row was not written");
    assert(invited.usedAt === null, "a freshly invited witness must not be marked used");
    // Deliberately NOT attested. An invitation is not a ledger event (there is no
    // `witness_invited` entry type, and adding one would put a private email into a payload
    // served publicly), and attesting would take the commitment to `disputed` or leave the
    // probe's outcome contested — neither of which is what this run is demonstrating.

    // ---- 2. the commitment_created entry, recomputed --------------------------------------
    step("recomputing the commitment_created entry's hash from its stored payload");
    const afterCreate = await entriesFor(webDb, created.id);
    const createdEntry = afterCreate.find((e) => e.entryType === "commitment_created");
    assert(createdEntry !== undefined, "no commitment_created ledger entry (I-3 would be broken)");
    assertChains(createdEntry, "commitment_created");
    const createdPayload = createdEntry.payload as { specVersion: number; doneSpecHash: string };
    assert(
      createdPayload.specVersion === SPEC_VERSION,
      `the permanent record says spec_version ${createdPayload.specVersion}, spec is v${SPEC_VERSION}`,
    );
    assert(
      createdPayload.doneSpecHash === spec.hash,
      "the ledger entry pins a different done_spec than the one that was compiled (I-4)",
    );
    step(`  seq ${createdEntry.seq} chains, pins ${spec.hash.slice(0, 12)}… at spec_version ${SPEC_VERSION}`);

    // ---- 3. the baseline snapshot ---------------------------------------------------------
    //
    // Standalone, and before anything can resolve. done-spec-dsl.md §6.3 captures the baseline
    // at commit time; running it here rather than letting the first probe do it is what makes
    // the amendment in step 4 reachable at all — a probe that passes resolves the commitment,
    // and a resolved commitment is not amendable.
    step("capturing the baseline snapshot over the real network");
    const observeDeps = {
      safeFetch,
      // Unused by an http spec. A placeholder token would be a silent downgrade for a github
      // spec, so this refuses rather than pretending (architecture.md §8).
      github: { token: process.env["GITHUB_APP_TOKEN"] ?? "", fetchImpl: fetch },
      // Registries are fixed origins and carry no credentials, so they take the plain global
      // fetch. A user-supplied URL never reaches this one (CLAUDE.md I-5).
      registryFetch: fetch,
      dns: nodeDnsDeps(),
    };
    const ctx = {
      commitTime: created.committedAt,
      deadline: created.deadline,
      now: () => new Date(),
    };
    const ast = SpecNodeSchema.parse(spec.ast);
    const baselineObservations = await observeAll(collectTargets(ast, ctx), observeDeps, ctx);
    const unreachable = baselineObservations.find((o) => !o.observed);
    assert(
      unreachable === undefined,
      `could not observe ${unreachable?.source ?? ""} for the baseline: ` +
        `${unreachable?.observed === false ? unreachable.error.message : ""}. ` +
        `This is a NETWORK failure, not a failed done-condition (I-7).`,
    );
    const capture = baselineStore(probeDb);
    const baseline = await capture(created.id, targetDigest(baselineObservations));
    assert(baseline !== null, "captureBaseline stored nothing");

    const [withBaseline] = await webDb
      .select({
        baselineSha256: commitmentTable.baselineSha256,
        baselineCapturedAt: commitmentTable.baselineCapturedAt,
      })
      .from(commitmentTable)
      .where(eq(commitmentTable.id, created.id));
    assert(withBaseline?.baselineSha256 === baseline, "baseline_sha256 is not what was captured");
    assert(
      withBaseline.baselineCapturedAt !== null,
      "baseline_captured_at is null — the capture time comes from Postgres now() (I-8)",
    );
    step(`  baseline ${baseline.slice(0, 12)}… captured at ${withBaseline.baselineCapturedAt.toISOString()}`);

    // ---- 4. the amendment -----------------------------------------------------------------
    const movedDate = dayInZone(new Date(originalDeadline.getTime() + 2 * DAY_MS), ZONE);
    const movedDeadline = endOfDayInZone(movedDate, ZONE);
    step("moving the deadline, with a reason (the reason is required by the product, not the schema)");
    const amended = await recordAmendment({
      commitmentId: created.id,
      accountId,
      // The route's own shape: a calendar day plus a zone, resolved by the caller so an amended
      // deadline goes through exactly the same arithmetic as the original one (I-9).
      input: {
        kind: "deadline_moved",
        deadlineDate: movedDate,
        timeZone: ZONE,
        reason: "upstream review slipped by two days",
      },
      newDeadline: movedDeadline,
    });
    assert(amended.ok, `amendment refused: ${amended.ok ? "" : amended.refusal}`);

    const afterAmend = await entriesFor(webDb, created.id);
    const amendedEntry = afterAmend.find((e) => e.entryType === "amended");
    assert(amendedEntry !== undefined, "no `amended` ledger entry");
    assertChains(amendedEntry, "amended");
    const amendedPayload = amendedEntry.payload as {
      oldValue: string;
      newValue: string;
      reason: string;
    };
    assert(
      amendedPayload.oldValue === originalDeadline.toISOString(),
      `amended entry's old_value is ${amendedPayload.oldValue}, expected ${originalDeadline.toISOString()}`,
    );
    assert(
      amendedPayload.newValue === movedDeadline.toISOString(),
      `amended entry's new_value is ${amendedPayload.newValue}`,
    );
    assert(amendedPayload.reason.length > 0, "an amendment with no reason reached the ledger");

    const [amendmentRow] = await webDb
      .select({ ledgerSeq: amendmentTable.ledgerSeq })
      .from(amendmentTable)
      .where(eq(amendmentTable.commitmentId, created.id));
    assert(
      amendmentRow?.ledgerSeq === amendedEntry.seq,
      "the amendment row points at a different ledger entry than the one that was appended",
    );
    step(`  seq ${amendedEntry.seq} chains; deadline ${originalDeadline.toISOString()} → ${movedDeadline.toISOString()}`);

    // ---- 5. the real probe, and resolution ------------------------------------------------
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

    const enqueued: string[] = [];
    const deps: WorkerDeps = {
      db: probeDb,
      enqueue: async (queue) => {
        enqueued.push(queue);
      },
      runProbe: (target) =>
        runProbe(target, { ...observeDeps, now: () => new Date(), baseline: baselineStore(probeDb) }),
      now: () => new Date(),
      log: { info: (m) => console.log(`     ${m}`), warn: (m) => console.warn(`     ${m}`) },
    };

    step(`probing ${TARGET_URL} over the real network via @pledge/safe-fetch`);
    for (const job of mine) {
      await handleProbeJob(deps, ProbeJobSchema.parse(job.data));
      await boss.complete(QUEUE_PROBE, job.id);
    }

    const [run] = await webDb
      .select({
        outcome: probeRunTable.outcome,
        probeKind: probeRunTable.probeKind,
        evidence: probeRunTable.evidence,
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
    assert(
      run.probeKind === "spec",
      `probe_kind was ${run.probeKind}, expected 'spec' — the v1 evaluator did not run`,
    );

    const [resolved] = await webDb
      .select({ status: commitmentTable.status, resolvedAt: commitmentTable.resolvedAt })
      .from(commitmentTable)
      .where(eq(commitmentTable.id, created.id))
      .limit(1);
    assert(resolved !== undefined, "commitment vanished");
    assert(resolved.status === "kept", `commitment status was ${resolved.status}, expected kept`);
    assert(resolved.resolvedAt !== null, "kept commitment has no resolved_at");
    assert(
      enqueued.includes(QUEUE_NOTIFY),
      "resolution did not enqueue a notification — the mail path is not wired",
    );

    const afterProbe = await entriesFor(webDb, created.id);
    const probeEntry = afterProbe.find((e) => e.entryType === "probe_result");
    const resolvedEntry = afterProbe.find((e) => e.entryType === "resolved");
    assert(probeEntry !== undefined, "no `probe_result` ledger entry — the observation is unrecorded");
    assert(resolvedEntry !== undefined, "no `resolved` ledger entry (I-3 would be broken)");
    assertChains(probeEntry, "probe_result");
    assertChains(resolvedEntry, "resolved");
    assert(
      (resolvedEntry.payload as { resolvedBy: string }).resolvedBy === "probe",
      "a `kept` resolution that did not come from a probe reached the ledger (I-1 / ADR-0006)",
    );
    step(`  probe_result at seq ${probeEntry.seq}, resolved at seq ${resolvedEntry.seq}, both chain`);

    // ---- 6. the whole chain, from genesis --------------------------------------------------
    step("walking the entire chain from genesis (what `pnpm ledger:verify` runs)");
    const chain = await verifyLedgerChain(webDb);
    assert(
      chain.breaks.length === 0,
      `chain has ${chain.breaks.length} break(s): ${JSON.stringify(chain.breaks.slice(0, 3))}`,
    );
    assert(chain.headMatches, "chain_head does not point at the last entry");
    step(`  ${chain.entryCount} entries verified, head at seq ${chain.headSeq}`);

    // ---- 7. the receipt, verified by a process with no credentials --------------------------
    step("building and signing the receipt");
    const receipt = await buildReceipt(webDb, created.id, { issuer: "https://pledge.sh" });
    const dir = mkdtempSync(join(tmpdir(), "pledge-smoke-"));
    const receiptPath = join(dir, "receipt.json");
    writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

    step("verifying it with pledge-verify in a separate process with NO credentials");
    // Every pledge secret is stripped, not merely unused: the exit criterion is that this runs
    // on a stranger's laptop, and a process that could read DATABASE_URL if it wanted to has
    // not demonstrated that. PATH and HOME survive because node needs them to start.
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(DATABASE_URL|PLEDGE_|WITNESS_|AUTH_|RESEND_|GITHUB_)/.test(key),
      ),
    ) as NodeJS.ProcessEnv;
    const verifier = spawnSync(
      process.execPath,
      [new URL("../../../packages/verify/src/cli.ts", import.meta.url).pathname, receiptPath],
      { env: cleanEnv, encoding: "utf8" },
    );
    process.stdout.write(
      verifier.stdout
        .split("\n")
        .map((line) => (line === "" ? "" : `     ${line}`))
        .join("\n"),
    );
    if (verifier.stderr !== "") process.stderr.write(verifier.stderr);
    assert(
      verifier.status === 0,
      `pledge-verify exited ${String(verifier.status)} — the receipt this build signed does not verify`,
    );

    const evidenceObserved = run.evidence as { status?: number; resolvedIp?: string };
    console.log("");
    console.log(`  SMOKE PASSED — commitment ${created.id}`);
    console.log(`    spec        ${spec.dslSource}`);
    console.log(`    class       ${spec.probeClass}, spec_version ${SPEC_VERSION}`);
    console.log(`    status      ${resolved.status} (resolved_by probe)`);
    console.log(`    resolved_at ${resolved.resolvedAt?.toISOString() ?? "-"}`);
    console.log(
      `    observed    ${TARGET_URL} → ${String(evidenceObserved.status)} @ ${String(evidenceObserved.resolvedIp)}`,
    );
    console.log(`    ledger      ${chain.entryCount} entries verified, head seq ${chain.headSeq}`);
    console.log(`    receipt     ${receiptPath} (verified with no credentials)`);
    console.log(`    profile     ${process.env["NEXT_PUBLIC_BASE_URL"] ?? ""}/${HANDLE}`);
  } finally {
    // NOT awaited. In pg-boss 12.27 `stop()` does not resolve here (no worker was registered,
    // so the `stopped` event it waits on never fires) and awaiting it hangs the script after
    // it has already passed. Ask it to close, then close our own pools and go.
    void boss.stop({ close: true, graceful: false }).catch(() => undefined);
    await webDb.$client.end();
    await probeDb.$client.end();
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  // Explicit, for the same reason: pg-boss leaves a handle the event loop will wait on
  // forever. src/index.ts's signal handler exits explicitly too. A script that has printed
  // its verdict must not sit there.
  .finally(() => process.exit(process.exitCode ?? 0));
