/**
 * `pnpm ledger:verify` — walk the chain from genesis and recompute every hash.
 *
 * This is a v1 exit criterion and it runs in CI against a seeded database. Its job is to fail
 * the build if any entry_hash no longer folds, which is what makes "we cannot quietly edit
 * the record" an enforced property rather than a promise on a marketing page.
 *
 * It reads only. It has no way to repair anything, and it must never grow one: a "fix the
 * chain" flag is a tool for rewriting history with a clean conscience.
 */
import { closeDb, createDb } from "./client";
import { loadDevEnv, requireEnv } from "./env";
import { verifyLedgerChain } from "./queries/ledger";

async function main(): Promise<void> {
  loadDevEnv();
  const db = createDb(requireEnv("DATABASE_URL"), { max: 1 });

  try {
    const result = await verifyLedgerChain(db);

    if (result.entryCount === 0) {
      // Not a failure: a fresh database has an empty chain. But say so, because "verified 0
      // entries" printed as a success is how a broken CI step passes for a month.
      console.log("ledger: chain is empty (0 entries) — nothing to verify");
    } else {
      console.log(`ledger: walked ${result.entryCount} entries from genesis`);
    }

    for (const chainBreak of result.breaks) {
      console.error(
        `  seq ${chainBreak.seq}  ${chainBreak.kind}\n    expected ${chainBreak.expected}\n    actual   ${chainBreak.actual}`,
      );
    }

    if (!result.headMatches) {
      console.error(
        `  chain_head points at seq ${result.headSeq} / ${result.headHash}, which is not the last entry`,
      );
    }

    if (result.breaks.length > 0 || !result.headMatches) {
      console.error(`\n  LEDGER CHAIN BROKEN — ${result.breaks.length} break(s).`);
      console.error("  Do not repair it. Find out what wrote to ledger_entry.\n");
      process.exitCode = 1;
      return;
    }

    console.log(`ledger: chain verified, head at seq ${result.headSeq}`);
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error("ledger verification failed to run:", error);
  process.exitCode = 1;
});
