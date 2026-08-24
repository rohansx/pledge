/**
 * POST /api/v1/commitments — the one write the web tier is allowed to make.
 *
 * INVARIANT I-1. There is no status field anywhere in this file, no `resolvedAt`, and no
 * sibling endpoint that marks something done. `insertCommitment` takes neither, so there is no
 * shape of call from here that reaches `kept` or `missed` — those are written only by the
 * probe worker (architecture.md §5.3). scripts/check-invariants.mjs fails the build if this
 * ever stops being true. If you are here to add a mark-as-done route, the product does not
 * have one.
 *
 * The flow follows architecture.md §6.1, minus the parts v0 does not have (no DSL parse, no
 * ledger append, no forecast, no baseline snapshot):
 *
 *     BEGIN
 *       upsert done_spec        content-addressed, conflicts are expected and ignored
 *       insert commitment       status defaults to 'open', committed_at to Postgres now()
 *       enqueue probe schedule  pg-boss, SAME transaction
 *     COMMIT
 *     → commit mail, fire and forget, outside the transaction
 */
import { enqueueProbeJob, getDb, hashDoneSpec, insertCommitment, type Db } from "@pledge/db";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  CommitmentInputSchema,
  toFieldErrors,
  type CreatedCommitment,
} from "@/lib/commitment-input";
import { InvalidDeadlineError, endOfDayInZone, formatInZone } from "@/lib/deadline";
import { sendCommitMail } from "@/lib/mail";

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (session === null) {
    return NextResponse.json({ error: "sign in to commit" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  // Zone 1 → 2 (architecture.md §4). The client validated against this same schema; that pass
  // was for the error messages, this one is the control.
  const parsed = CommitmentInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid commitment", fields: toFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // The committer picked a calendar day in their own zone; storage is the UTC instant of that
  // day's last millisecond (CLAUDE.md I-9).
  let deadline: Date;
  try {
    deadline = endOfDayInZone(input.deadlineDate, input.timeZone);
  } catch (error: unknown) {
    if (error instanceof InvalidDeadlineError) {
      return NextResponse.json(
        { error: "invalid commitment", fields: { deadlineDate: [error.message] } },
        { status: 400 },
      );
    }
    throw error;
  }

  // Re-validates and canonicalises before hashing. The hash IS the contract: an edited spec is
  // a different hash and therefore a different commitment (CLAUDE.md I-4).
  const { spec, hash } = hashDoneSpec(input.spec);

  const db = getDb();
  const created = await db.transaction(async (tx) => {
    // `insertCommitment` is typed against `Db` because it opens a transaction of its own.
    // Drizzle turns that into a SAVEPOINT when it is handed an open transaction, which is
    // what we want: a failing enqueue below rolls the whole thing back. The cast is the
    // documented boundary — the runtime shapes are identical, only the declared type is
    // narrower than it needs to be.
    const row = await insertCommitment(tx as unknown as Db, {
      accountId: session.user.accountId,
      claim: input.claim,
      spec,
      doneSpecHash: hash,
      deadline,
      estimatedDays: input.estimatedDays,
    });

    // Same transaction, deliberately unguarded: "job enqueued but commitment rolled back" is
    // impossible, and so is its mirror image (architecture.md §6.1).
    await enqueueProbeJob(tx, row.id);
    return row;
  });

  const url = `${baseUrl()}/c/${created.id}`;
  if (session.user.email != null) {
    sendCommitMail({
      to: session.user.email,
      handle: session.user.handle,
      claim: created.claim,
      deadline: formatInZone(created.deadline, input.timeZone),
      url,
    });
  }

  const payload: CreatedCommitment = {
    id: created.id,
    handle: session.user.handle,
    deadline: created.deadline.toISOString(),
    doneSpecHash: created.doneSpecHash,
  };
  return NextResponse.json(payload, { status: 201, headers: { Location: url } });
}

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000";
}
