/**
 * Resolution-mail dispatcher. `pnpm notify`.
 *
 * Runs in the app tier because that is the only tier that may read an email address, and as
 * its own process because a Next.js request handler is not a place to wait for a queue.
 *
 * ponytail: a poll loop, not a daemon framework and not a cron entry. Resolutions arrive a
 * handful a day at v0 volume; thirty seconds of latency on a notification is invisible and a
 * scheduler is one more thing to get wrong in a deployment that does not exist yet.
 */
import { getDb, loadDevEnv, requireEnv } from "@pledge/db";
import { drainResolutionNotices } from "../lib/notify";

const POLL_INTERVAL_MS = 30_000;

async function main(): Promise<void> {
  loadDevEnv();
  requireEnv("DATABASE_URL");
  const db = getDb();

  let running = true;
  const stop = (signal: string): void => {
    console.log(`${signal} received, stopping after the current drain`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.log("resolution notifier running");
  while (running) {
    try {
      const sent = await drainResolutionNotices(db);
      if (sent > 0) console.log(`dispatched ${sent} resolution notice(s)`);
    } catch (error: unknown) {
      // A bad drain is not a reason to stop draining — the next resolution still needs to be
      // told about. Loud, then keep going.
      console.error("drain failed:", error instanceof Error ? error.message : error);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  await db.$client.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
