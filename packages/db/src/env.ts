/**
 * Environment access for the db package. Read it here or not at all — a `process.env.X ?? ""`
 * anywhere else turns a missing connection string into a confusing runtime error instead of a
 * loud startup one.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Throws at startup rather than failing mysteriously at first query. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Copy .env.example to .env.local (see docker-compose.yml for the local Postgres).`,
    );
  }
  return value;
}

/**
 * Loads the repo-root `.env.local` for things Next.js does not boot: migrations, the seed
 * script, tests. Next.js loads it on its own, so the web app must not call this.
 *
 * Silent when the file is absent — in CI and production the variables come from the
 * environment, and requireEnv is what complains if they are actually missing.
 */
export function loadDevEnv(startDir: string = process.cwd()): void {
  for (let dir = startDir; ;) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return;
    }
    const parent = join(dir, "..");
    if (parent === dir) return;
    dir = parent;
  }
}
