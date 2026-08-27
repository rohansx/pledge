import type { NextConfig } from "next";
import { loadDevEnv } from "@pledge/db";

// The repo's `.env.local` lives at the workspace root, next to docker-compose.yml, but Next
// only looks beside its own next.config. Without this, `next dev` and `next start` come up
// with no DATABASE_URL and every page 500s on the first query.
//
// Unconditional, and not gated on NODE_ENV: `next start` runs as NODE_ENV=production even on
// a laptop, so a dev-only guard here would switch itself off in exactly the case that needs
// it. loadDevEnv is silent when no .env.local exists, which is every real deployment —
// .env.local is gitignored and never shipped.
loadDevEnv(import.meta.dirname);

const config: NextConfig = {
  // Workspace packages are shipped as TypeScript source so no package needs a build step
  // before another can import it. Next has to compile them itself.
  transpilePackages: ["@pledge/db", "@pledge/ledger"],
  typedRoutes: true,
};

export default config;
