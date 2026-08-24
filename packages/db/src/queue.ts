/**
 * The probe queue's wire contract, owned by neither tier.
 *
 * apps/web produces these rows and apps/worker consumes them, so the payload shape lives in
 * the package both already depend on. It used to live in apps/web alone, where nothing
 * type-checked it against the worker's Zod schema — and it had drifted: the web tier enqueued
 * `{ commitmentId }` while the worker required `authoritative` too, so every job the web tier
 * created was rejected at parse time and silently dropped. One definition, imported by both,
 * is what stops that happening again.
 *
 * WHY RAW SQL AND NOT `boss.send()`. pg-boss is the queue precisely because it lives in the
 * same Postgres, which is what makes "job enqueued but commitment rolled back" structurally
 * impossible (architecture.md §6.1, ADR-0002). Getting that guarantee through the pg-boss
 * client would mean handing it the open Drizzle transaction; a two-column INSERT is smaller,
 * adds no dependency, and is the same write pg-boss would make. Every other column on
 * `pgboss.job` has a default, and `pledge_web` is granted DML on the schema in migration 0000
 * for exactly this.
 *
 * PREREQUISITE, and it is a hard one: pg-boss owns its schema and self-migrates on start, and
 * `pgboss.job.name` has a foreign key to `pgboss.queue.name`. Until apps/worker has run once
 * and created the queue, this INSERT raises and takes the commitment down with it. That is the
 * correct failure — a commitment whose probe was never scheduled would sit `open` forever and
 * silently resolve to nothing — but it means the worker must have started once against a fresh
 * database before the first commit succeeds.
 */
import { sql } from "drizzle-orm";
import type { DbOrTx } from "./client";

/** Queue name. apps/worker must `createQueue` this before the first commit can land. */
export const QUEUE_PROBE = "probe";

/**
 * What the worker reads off a probe job.
 *
 * `authoritative` is the field that decides whether a non-passing observation is allowed to
 * resolve anything (technical-spec §6). It is required rather than defaulted: a producer that
 * forgot to think about it should not silently get the answer that resolves commitments.
 */
export interface ProbeJobPayload {
  readonly commitmentId: string;
  readonly authoritative: boolean;
}

/**
 * Schedules the first probe for a freshly-created commitment.
 *
 * v0 has a fixed daily schedule and no backoff curve (roadmap.md v0), so this enqueues one
 * non-authoritative job available immediately: it can observe a `pass` and resolve `kept`, but
 * an observation that the condition is FALSE this early means nothing and must not resolve
 * anything. The single authoritative run at deadline+0 is the worker's sweep's business.
 *
 * Must be called with the same `tx` that inserted the commitment. Throwing here rolls the
 * commitment back, which is the entire point — do not wrap this in a try/catch.
 */
export async function enqueueProbeJob(tx: DbOrTx, commitmentId: string): Promise<void> {
  const job: ProbeJobPayload = { commitmentId, authoritative: false };
  await tx.execute(
    sql`insert into pgboss.job (name, data) values (${QUEUE_PROBE}, ${JSON.stringify(job)}::jsonb)`,
  );
}
