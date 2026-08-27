import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

// The repo's `.env.local` lives at the workspace root, next to docker-compose.yml, but Next
// only looks beside its own next.config. Without this, `next dev` and `next start` come up
// with no DATABASE_URL and every page 500s on the first query.
//
// Unconditional, and not gated on NODE_ENV: `next start` runs as NODE_ENV=production even on
// a laptop, so a dev-only guard here would switch itself off in exactly the case that needs
// it. Silent when no .env.local exists, which is every real deployment — .env.local is
// gitignored and never shipped.
//
// WHY THIS IS SPELLED OUT HERE rather than calling `loadDevEnv` from @pledge/db, which is the
// same eight lines: this file is loaded by Next's config loader, which is not the app bundle
// and does not honour `transpilePackages`. Importing the @pledge/db barrel drags whatever that
// barrel currently re-exports through that loader — today that reaches @pledge/spec and its
// ESM-only parser, and the build dies at config load with a resolution error nowhere near the
// cause. A config file has no business importing the server-side database package to read one
// file. It stays dependency-free.
function loadRootEnvLocal(startDir: string): void {
  for (let dir = startDir; ; ) {
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

loadRootEnvLocal(import.meta.dirname);

const config: NextConfig = {
  // Workspace packages are shipped as TypeScript source so no package needs a build step
  // before another can import it. Next has to compile them itself.
  transpilePackages: ["@pledge/db", "@pledge/ledger", "@pledge/spec"],
  typedRoutes: true,
};

export default config;
