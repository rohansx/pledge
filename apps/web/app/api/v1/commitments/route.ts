/**
 * POST /api/v1/commitments — the one write the web tier is allowed to make.
 *
 * INVARIANT I-1. There is no status field anywhere in this file, no `resolvedAt`, and no
 * sibling endpoint that marks something done. Nothing here can reach a resolution status —
 * those are written only by the probe worker (architecture.md §5.3).
 * scripts/check-invariants.mjs fails the build if that ever stops being true. If you are here
 * to add a mark-as-done route, the product does not have one.
 *
 * The flow follows architecture.md §6.1:
 *
 *     compile the DSL source     @pledge/spec, the only thing that may produce a spec hash
 *     BEGIN
 *       upsert done_spec         content-addressed, conflicts are expected and ignored (I-4)
 *       insert commitment        status defaults to 'open', committed_at to Postgres now()
 *       append commitment_created  SAME transaction (I-3)
 *       enqueue probe schedule   pg-boss, SAME transaction — the first run is also the
 *                                commit-time baseline capture (done-spec-dsl.md §6.3)
 *     COMMIT
 *     → commit mail, fire and forget, outside the transaction
 *
 * NO FORECAST. That is v2 and needs `calibration_fit`, which does not exist.
 */
import { enqueueProbeJob, getDb, insertCommitment } from "@pledge/db";
import { SPEC_VERSION, compile } from "@pledge/spec";
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

  // Parse, canonicalise, hash — in that order, once, by the package that owns all three
  // (done-spec-dsl.md §5). The composer ran the same call on the same bytes, so the hash the
  // committer was shown is the hash that lands. The hash IS the contract: an edited spec is a
  // different hash and therefore a different commitment (CLAUDE.md I-4).
  const compiled = compile(input.specSource);
  if (!compiled.ok) {
    return NextResponse.json(
      {
        error: "invalid commitment",
        fields: { specSource: compiled.issues.map((issue) => issue.message) },
      },
      { status: 400 },
    );
  }
  const spec = compiled.spec;

  const db = getDb();
  const created = await db.transaction(async (tx) => {
    // One writer, in @pledge/db, holding I-3 (the ledger append is in this transaction) and
    // I-4 (done_spec is content-addressed and never updated). Re-implementing it here to get
    // the enqueue below into the same transaction would be a second copy of both.
    const row = await insertCommitment(tx, {
      accountId: session.user.accountId,
      claim: input.claim,
      spec: spec.ast,
      doneSpecHash: spec.hash,
      specVersion: SPEC_VERSION,
      deadline,
      ...(input.estimatedDays === undefined ? {} : { estimatedDays: input.estimatedDays }),
    });

    // Same transaction, deliberately unguarded: "job enqueued but commitment rolled back" is
    // impossible, and so is its mirror image (architecture.md §6.1). The first run is also the
    // commit-time baseline capture (done-spec-dsl.md §6.3).
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
