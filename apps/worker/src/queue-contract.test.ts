/**
 * The web tier and the worker have to agree about what a probe job looks like, and nothing
 * else checks that they do.
 *
 * They had already drifted: apps/web enqueued `{ commitmentId }` while `ProbeJobSchema`
 * required `authoritative` as well, so every job a real commit created was rejected at parse
 * time inside a `Promise.allSettled` and dropped. Nothing failed loudly — the commitment sat
 * `open` until the next daily sweep happened to pick it up. Typecheck could not catch it
 * because the payload crosses the boundary as jsonb.
 *
 * So the assertion is deliberately the round trip through Postgres, not a unit test of an
 * object literal: write the row the way apps/web writes it, read it back the way apps/worker
 * reads it, and require the consumer's schema to accept it.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { createDb, closeDb, enqueueProbeJob, loadDevEnv, requireEnv, type Db } from "@pledge/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ProbeJobSchema, QUEUE_PROBE } from "./handlers";

let owner: Db;

beforeAll(() => {
  loadDevEnv();
  owner = createDb(requireEnv("DATABASE_URL"), { max: 1 });
});

afterAll(async () => {
  await closeDb(owner);
});

it("a job enqueued by the web tier parses under the worker's schema", async () => {
  const commitmentId = randomUUID();

  // Rolled back: this asserts the payload shape, and leaving queue rows behind for the real
  // worker to pick up and probe would be a test with side effects on a running system.
  await expect(
    owner.transaction(async (tx) => {
      await enqueueProbeJob(tx, commitmentId);

      const rows = await tx.execute<{ data: unknown }>(
        sql`select data from pgboss.job where name = ${QUEUE_PROBE} and data ->> 'commitmentId' = ${commitmentId}`,
      );
      expect(rows).toHaveLength(1);

      const parsed = ProbeJobSchema.parse(rows[0]!.data);
      expect(parsed).toEqual({ commitmentId, authoritative: false });

      // The first probe must never be able to resolve on a non-pass: a target that is not
      // ready one second after the commit is not a miss (technical-spec §6).
      expect(parsed.authoritative).toBe(false);

      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
});
