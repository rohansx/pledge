import { defineConfig } from "vitest/config";

// One root config, workspace-aware: `pnpm test` discovers a project per workspace
// package so every package's tests run in one pass without per-package config files.
// A package with no tests yet is simply an empty project — that is fine.
export default defineConfig({
  test: {
    // Parallel agents share one `pnpm test`; without this the run is red until the last
    // of them lands a test file, which trains everyone to ignore a red test run.
    passWithNoTests: true,
    projects: ["packages/*", "apps/*"],
  },
});
