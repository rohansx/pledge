/**
 * The consumer for `notify.resolution` — the queue the probe worker writes to and cannot
 * itself drain.
 *
 * WHY THE HOP EXISTS. Resolution mail needs an email address, and `pledge_probe` has no
 * privilege at all on `account` (migration 0000; architecture.md §4). That is deliberate: the
 * tier that fetches strangers' URLs must not be able to learn who anyone is, so it cannot be
 * the tier that sends the mail. It enqueues a bare `{ commitmentId, status }` and the app
 * tier, which can read `account`, joins the two together here.
 *
 * ponytail: a hand-rolled poll rather than `boss.work()`. pg-boss is not a dependency of
 * apps/web and adding it to send one email is a poor trade at v0 volume — a claim, a status
 * and one `UPDATE ... RETURNING` under `FOR UPDATE SKIP LOCKED` is the whole consumer.
 * Ceiling: single consumer, at-most-once delivery, no retry on a Resend failure. Move it onto
 * `boss.work()` the moment either retries or a second consumer matters; the call site does
 * not change.
 *
 * INVARIANT I-1: this file reads `commitment.status` and never writes it. Resolution already
 * happened, in the worker's transaction, before the job that got us here existed.
 */
import { sql } from "drizzle-orm";
import type { Db } from "@pledge/db";
import { sendResolutionMail } from "./mail";

export const QUEUE_NOTIFY = "notify.resolution";

/** One row of the queue, after the join that gives it a recipient. */
interface ResolutionNotice {
  readonly jobId: string;
  readonly commitmentId: string;
  readonly claim: string;
  readonly status: string;
  readonly email: string;
  readonly handle: string;
}

/**
 * Claims up to `limit` pending notices and returns them with the recipient attached.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes a second copy of this process harmless rather than a
 * source of duplicate mail. Jobs are marked `active` here and `completed` only after the send
 * is dispatched, so a crash between the two leaves a job stuck `active` — pg-boss's own
 * maintenance expires those back to `created`, which is the retry this consumer does not
 * implement itself.
 */
async function claimNotices(db: Db, limit: number): Promise<readonly ResolutionNotice[]> {
  const rows = await db.execute<{
    id: string;
    commitment_id: string;
    claim: string;
    status: string;
    email: string;
    handle: string;
  }>(sql`
    with claimed as (
      update pgboss.job
         set state = 'active', started_on = now()
       where id in (
         select id from pgboss.job
          where name = ${QUEUE_NOTIFY}
            and state = 'created'
            and start_after <= now()
          order by created_on
            for update skip locked
          limit ${limit}
       )
       and name = ${QUEUE_NOTIFY}
      returning id, data
    )
    select claimed.id,
           c.id  as commitment_id,
           c.claim,
           c.status,
           a.email,
           a.handle
      from claimed
      join commitment c on c.id = (claimed.data ->> 'commitmentId')::uuid
      join account a on a.id = c.account_id
  `);

  return rows.map((row) => ({
    jobId: row.id,
    commitmentId: row.commitment_id,
    claim: row.claim,
    status: row.status,
    email: row.email,
    handle: row.handle,
  }));
}

async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.execute(sql`
    update pgboss.job
       set state = 'completed', completed_on = now()
     where id = ${jobId} and name = ${QUEUE_NOTIFY}
  `);
}

/**
 * Drains the queue once. Returns how many notices were sent.
 *
 * The status rendered in the mail is read back from `commitment` rather than taken from the
 * job payload: the payload is a hint about what happened, the row is what actually happened,
 * and mail that disagrees with the profile page is worse than no mail.
 */
export async function drainResolutionNotices(db: Db, limit = 50): Promise<number> {
  const notices = await claimNotices(db, limit);

  for (const notice of notices) {
    sendResolutionMail({
      to: notice.email,
      handle: notice.handle,
      claim: notice.claim,
      status: notice.status,
      url: `${process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000"}/c/${notice.commitmentId}`,
    });
    await completeJob(db, notice.jobId);
  }

  return notices.length;
}
