import { defineConfig } from "drizzle-kit";
import { loadDevEnv, requireEnv } from "./src/env";

// drizzle-kit runs with cwd = packages/db; loadDevEnv walks up to the repo-root .env.local.
loadDevEnv();

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // Migrations are forward-only. Never `drizzle-kit push` against anything but a scratch
  // database, and never edit an already-applied migration — a dropped or redefined column
  // silently changes what old rows mean.
  strict: true,
  dbCredentials: { url: requireEnv("DATABASE_URL") },
});
