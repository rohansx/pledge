import { defineConfig } from "vitest/config";

// One root config, workspace-aware: `pnpm test` discovers a project per workspace
// package so every package's tests run in one pass without per-package config files.
// A package with no tests yet is simply an empty project — that is fine.
export default defineConfig({
  test: {
    // Parallel agents share one `pnpm test`; without this the run is red until the last
    // of them lands a test file, which trains everyone to ignore a red test run.
    passWithNoTests: true,
    // Test FILES run one at a time. Not a preference — ADR-0003 puts every ledger append
    // behind one global `chain_head FOR UPDATE`, and apps/worker/src/crash.test.ts holds
    // that lock for seconds on purpose to open the mid-transaction window it exists to
    // test. Any DB-touching file running beside it queues on that lock and blows its
    // 5s timeout. Serialising is the fix; raising the timeouts would only make the
    // failure intermittent.
    // ponytail: whole-suite serial because it is one line. If the run gets slow, split the
    // pure packages (spec, ledger, safe-fetch — no database, no lock) into their own
    // parallel project and keep only the DB projects here.
    fileParallelism: false,
    projects: ["packages/*", "apps/*"],
  },
});
