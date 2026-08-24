/**
 * Database clients.
 *
 * There are two, and which one you get is a security property, not a convenience:
 *
 *   getDb()      → DATABASE_URL,       role `pledge_web`   — the app tier
 *   getProbeDb() → DATABASE_URL_PROBE, role `pledge_probe` — the worker
 *
 * `pledge_probe` cannot read `account` at all, so the worker structurally cannot learn who
 * anyone is (architecture.md §4). Using getDb() in apps/worker throws that away — the code
 * would still work, which is exactly why it is worth stating here.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { requireEnv } from "./env";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema> & { $client: postgres.Sql };

/** A `Db` or an open transaction. Query helpers accept either so callers can compose. */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(
  connectionString: string,
  options: postgres.Options<Record<string, postgres.PostgresType>> = {},
): Db {
  const client = postgres(connectionString, {
    // A probe worker holding connections open against a queue-shaped workload is the classic
    // way to exhaust a small Postgres. Ten is plenty for v0's volume.
    max: 10,
    // postgres.js parses `numeric` to string by default, which is right — numeric is exact
    // and Number is not. Callers that want a number convert explicitly.
    ...options,
  });
  return drizzle(client, { schema });
}

/**
 * Cached on globalThis because Next.js dev recreates modules on every hot reload, and a fresh
 * connection pool per reload exhausts Postgres within a few edits.
 */
const cache = globalThis as unknown as { __pledgeDb?: Db; __pledgeProbeDb?: Db };

export function getDb(): Db {
  return (cache.__pledgeDb ??= createDb(requireEnv("DATABASE_URL")));
}

export function getProbeDb(): Db {
  return (cache.__pledgeProbeDb ??= createDb(requireEnv("DATABASE_URL_PROBE")));
}

/** Scripts and tests only. Long-lived processes should keep their pool. */
export async function closeDb(db: Db): Promise<void> {
  await db.$client.end();
}
