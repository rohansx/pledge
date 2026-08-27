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
import { sendResolutionMail, sendWitnessOutcomeMail } from "./mail";
import { listWitnessContacts } from "./witness-queries";
import { mintWitnessToken } from "./witness-token";

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
    const url = `${baseUrl()}/c/${notice.commitmentId}`;
    sendResolutionMail({
      to: notice.email,
      handle: notice.handle,
      claim: notice.claim,
      status: notice.status,
      url,
    });
    await pingWitnesses(notice, url);
    await completeJob(db, notice.jobId);
  }

  return notices.length;
}

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000";
}

/**
 * The second and last time a witness hears from us (product-overview.md §7): invited at
 * commit, told at outcome, never in between.
 *
 * SWALLOWS ITS OWN ERRORS ON PURPOSE, and this is the one place in the codebase where that is
 * correct rather than lazy. Resolution has already happened — in the worker's transaction,
 * long before this job existed. Letting a missing WITNESS_LINK_SECRET or a Resend outage
 * throw here would leave the committer's own mail sent, the job uncompleted, and the notice
 * redelivered forever. Nothing in the notification path may affect a record
 * (architecture.md §8), and that includes this function's ability to fail.
 */
async function pingWitnesses(notice: ResolutionNotice, url: string): Promise<void> {
  try {
    const contacts = await listWitnessContacts(notice.commitmentId);
    const now = Date.now();

    for (const contact of contacts) {
      // A link that cannot work is worse than no link: it invites a click that lands on a
      // refusal page. Spent and expired links get the outcome with no call to action.
      const live = !contact.hasAttested && contact.expiresAt.getTime() > now;
      const attestUrl = live
        ? `${baseUrl()}/w/${mintWitnessToken(contact.witnessId, contact.expiresAt).token}`
        : undefined;

      sendWitnessOutcomeMail({
        to: contact.email,
        handle: notice.handle,
        claim: notice.claim,
        status: notice.status,
        commitmentUrl: url,
        ...(attestUrl === undefined ? {} : { attestUrl }),
      });
    }
  } catch (error: unknown) {
    console.warn(`[notify] witness ping failed for ${notice.commitmentId}:`, error);
  }
}
