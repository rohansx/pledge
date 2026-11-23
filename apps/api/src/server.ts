import pg from "pg";

import { createApp } from "./app.ts";
import { migrate, PgScanStore } from "./store.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const version = process.env.PLEDGE_VERSION ?? "dev";
const token = process.env.PLEDGE_API_TOKEN || undefined;
if (!token) console.warn("PLEDGE_API_TOKEN is not set: /api/scans will answer 503");

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
pool.on("error", (error) => console.error("postgres pool error:", error));

try {
  await migrate(pool);
} catch (error) {
  // Keep serving so the health check can report the database problem instead of the container flapping.
  console.error("schema setup failed:", error);
}

const server = createApp({
  checkDb: async () => {
    await pool.query("select 1");
  },
  version,
  store: new PgScanStore(pool),
  token,
});
server.listen(port, () => console.info(`pledge api ${version} listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
