/**
 * Local dev seed. `pnpm --filter @pledge/db seed`.
 *
 * Resolutions are produced by calling `recordProbeRun` with a fabricated observation, not by
 * writing `status` directly. A seed that hand-sets `kept` would be the only place in the repo
 * where a commitment resolves without an observation, and it would be the first thing copied
 * the next time someone needs test data.
 */
import { sql } from "drizzle-orm";
import { closeDb, createDb } from "./client";
import { hashDoneSpec } from "./done-spec-hash";
import { loadDevEnv, requireEnv } from "./env";
import { insertCommitment } from "./queries/commitments";
import { recordProbeRun } from "./queries/probes";
import { account as accountTable } from "./schema";
import type { DoneSpecV0, ProbeResult } from "./types";

const DAY_MS = 86_400_000;

/** Truncating a real database because a script had a bad day is not on the menu. */
function assertLocal(url: string): void {
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`seed refuses to run against ${host}; it truncates every table`);
  }
}

const observation = (spec: DoneSpecV0, outcome: ProbeResult["outcome"]): ProbeResult => ({
  probeKind: spec.kind,
  outcome,
  evidence:
    outcome === "error"
      ? { error: { code: "timeout", message: "seed: target unreachable" } }
      : { status: spec.kind === "http_status" ? spec.expectedStatus : 200, bodyBytes: 4096 },
  ranAt: new Date(),
  durationMs: 120,
});

async function main(): Promise<void> {
  loadDevEnv();
  const url = requireEnv("DATABASE_URL");
  assertLocal(url);
  const db = createDb(url, { max: 1 });

  try {
    // TRUNCATE, not DELETE: the append-only triggers on done_spec, probe_run, ledger_entry,
    // amendment and witness_attestation block row deletes by design, and a seed should not be
    // the reason to weaken them. TRUNCATE is statement-level and deliberately left uncovered
    // by those triggers so a scratch database can be reset; `cascade` reaches ledger_entry
    // through its account_id foreign key.
    await db.execute(
      sql`truncate probe_run, commitment, done_spec, account, ledger_entry, amendment, witness, witness_attestation cascade`,
    );
    // Truncating the entries without rewinding the head would leave chain_head pointing at an
    // entry that no longer exists, and `pnpm ledger:verify` would (correctly) call that a
    // broken chain. Back to genesis: seq 0, 32 zero bytes.
    await db.execute(sql`update chain_head set seq = 0, entry_hash = repeat('0', 64), updated_at = now() where id = 1`);

    const [account] = await db
      .insert(accountTable)
      .values({ handle: "rohansx", email: "rohan@example.test", githubId: 1 })
      .returning();
    if (account === undefined) throw new Error("seed: account insert returned no row");

    const specs = {
      site: hashDoneSpec({
        kind: "http_status",
        url: "https://pledge.sh",
        expectedStatus: 200,
      } satisfies DoneSpecV0),
      release: hashDoneSpec({
        kind: "github_release_tag",
        repo: "rohansx/tethr",
        tagPattern: "v0.2.*",
      } satisfies DoneSpecV0),
      overdue: hashDoneSpec({
        kind: "http_status",
        url: "https://example.com/launched",
        expectedStatus: 200,
      } satisfies DoneSpecV0),
    };

    const open = await insertCommitment(db, {
      accountId: account.id,
      claim: "Ship the pledge landing page",
      spec: specs.site.spec,
      doneSpecHash: specs.site.hash,
      deadline: new Date(Date.now() + 7 * DAY_MS),
      estimatedDays: 5,
    });

    const kept = await insertCommitment(db, {
      accountId: account.id,
      claim: "Tag tethr v0.2",
      spec: specs.release.spec,
      doneSpecHash: specs.release.hash,
      deadline: new Date(Date.now() + 2 * DAY_MS),
      estimatedDays: 3,
    });
    await recordProbeRun(db, {
      commitmentId: kept.id,
      result: observation(specs.release.spec, "pass"),
      authoritative: false,
    });

    const missed = await insertCommitment(db, {
      accountId: account.id,
      claim: "Launch the ordering flow",
      spec: specs.overdue.spec,
      doneSpecHash: specs.overdue.hash,
      deadline: new Date(Date.now() - DAY_MS),
      estimatedDays: 2,
    });
    // authoritative: the deadline+0 run. An `error` here would produce `disputed`, not this.
    await recordProbeRun(db, {
      commitmentId: missed.id,
      result: observation(specs.overdue.spec, "fail"),
      authoritative: true,
    });

    console.log(
      `seeded @${account.handle}: open=${open.id} kept=${kept.id} missed=${missed.id}`,
    );
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error("seed failed:", error);
  process.exitCode = 1;
});
