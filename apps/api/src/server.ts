import pg from "pg";

import { createApp } from "./app.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const version = process.env.PLEDGE_VERSION ?? "dev";

const pool = new pg.Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 3000 });
pool.on("error", (error) => console.error("postgres pool error:", error));

const server = createApp(async () => {
  await pool.query("select 1");
}, version);
server.listen(port, () => console.info(`pledge api ${version} listening on :${port}`));

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
  });
}
