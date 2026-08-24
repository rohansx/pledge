/**
 * Forward-only migration runner. `pnpm db:migrate` from the repo root.
 *
 * Runs as the database owner (DATABASE_URL). The grants in migration 0000 create
 * `pledge_web` and `pledge_probe` NOLOGIN — a password belongs in an environment, not in a
 * migration — so locally this then attaches a login to whichever of those roles the
 * connection strings actually name.
 */
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { closeDb, createDb, type Db } from "./client";
import { loadDevEnv, requireEnv } from "./env";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/** Roles migration 0000 creates. A URL naming anything else is not ours to touch. */
const MANAGED_ROLES = new Set(["pledge_web", "pledge_probe"]);

/**
 * Dev convenience, and only that. Deployed environments provision role passwords out of band
 * — the whole point of creating the roles NOLOGIN is that this file never has to know one.
 */
async function attachDevRoleLogins(
  db: Db,
  urls: readonly (string | undefined)[],
): Promise<void> {
  if (process.env.NODE_ENV === "production") return;

  for (const raw of urls) {
    if (raw === undefined || raw === "") continue;
    const url = new URL(raw);
    const role = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!MANAGED_ROLES.has(role) || password === "") continue;

    // DDL cannot be parameterised, so the password is interpolated. Refuse anything that
    // isn't obviously a literal rather than escaping cleverly — a dev password with a quote
    // in it is a five-second fix, a DDL injection is not.
    if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(password)) {
      throw new Error(
        `Refusing to set a local password for ${role}: use only [A-Za-z0-9_.:-] in .env.local.`,
      );
    }
    await db.execute(sql.raw(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${password}'`));
    console.log(`  login attached: ${role}`);
  }
}

async function main(): Promise<void> {
  loadDevEnv();
  // max: 1 — a migration is one serial thing, and a pool here only makes the advisory lock
  // drizzle takes harder to reason about.
  const db = createDb(requireEnv("DATABASE_URL"), { max: 1 });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log("migrations applied");
    await attachDevRoleLogins(db, [process.env.DATABASE_URL, process.env.DATABASE_URL_PROBE]);
  } finally {
    await closeDb(db);
  }
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exitCode = 1;
});
