/**
 * Writes one receipt to stdout. `pnpm --filter @pledge/db receipt <commitment-id> > receipt.json`
 *
 * The only way to get a receipt out of pledge today: apps/web has no download route yet, and
 * the v1 exit criterion is that a receipt built here verifies on a machine with no pledge
 * credentials. This script is the producing half of that demonstration; `npx pledge-verify` is
 * the consuming half and shares nothing with it but the file.
 *
 * The receipt is printed to stdout and nothing else is, so it can be piped straight into the
 * verifier. Diagnostics go to stderr.
 */
import { closeDb, createDb } from "./client";
import { loadDevEnv, requireEnv } from "./env";
import { buildReceipt } from "./receipt";

async function main(): Promise<void> {
  const commitmentId = process.argv[2];
  if (commitmentId === undefined) {
    console.error("usage: receipt <commitment-id>");
    process.exitCode = 2;
    return;
  }

  loadDevEnv();
  const db = createDb(requireEnv("DATABASE_URL"), { max: 1 });
  try {
    const receipt = await buildReceipt(db, commitmentId);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error("receipt failed:", error);
  process.exitCode = 1;
});
