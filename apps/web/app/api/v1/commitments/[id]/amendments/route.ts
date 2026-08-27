/**
 * POST /api/v1/commitments/:id/amendments — move a deadline, or withdraw.
 *
 * INVARIANT I-1. There is no status literal in this file. The one status an amendment can
 * produce is `abandoned`, written inside `recordAmendment`, and architecture.md §6.3 lists
 * the amendment handler as its only legitimate writer. Nothing reachable from here produces
 * `kept` or `missed` — a probe does that, and there is no endpoint that asks it to.
 *
 * INVARIANT I-4. The body has no `spec` field. Changing the done-spec is a different hash and
 * therefore a different commitment; the composer makes one of those, this route does not.
 *
 * The reason is required, and it is required HERE, server-side, on a schema the client cannot
 * skip — the browser's pass over the same schema is for the error messages.
 */
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import {
  AmendmentInputSchema,
  type RecordedAmendment,
} from "@/lib/amendment-input";
import { recordAmendment, type AmendmentRefusal } from "@/lib/amendments";
import { toFieldErrors } from "@/lib/commitment-input";
import { InvalidDeadlineError, endOfDayInZone } from "@/lib/deadline";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const session = await auth();
  if (session === null) {
    return NextResponse.json({ error: "sign in to amend" }, { status: 401 });
  }

  const { id } = await context.params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = AmendmentInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid amendment", fields: toFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;

  // The same arithmetic the original deadline went through (CLAUDE.md I-9). An amended
  // deadline that resolved a calendar day differently from the original would be a different
  // kind of instant wearing the same name.
  let newDeadline: Date | undefined;
  if (input.kind === "deadline_moved") {
    try {
      newDeadline = endOfDayInZone(input.deadlineDate, input.timeZone);
    } catch (error: unknown) {
      if (error instanceof InvalidDeadlineError) {
        return NextResponse.json(
          { error: "invalid amendment", fields: { deadlineDate: [error.message] } },
          { status: 400 },
        );
      }
      throw error;
    }
  }

  const result = await recordAmendment({
    commitmentId: id,
    accountId: session.user.accountId,
    input,
    newDeadline,
  });

  if (!result.ok) {
    const { status, message, field } = REFUSALS[result.refusal];
    return NextResponse.json(
      field === undefined ? { error: message } : { error: message, fields: { [field]: [message] } },
      { status },
    );
  }

  const payload: RecordedAmendment = {
    amendmentId: result.amendmentId,
    ledgerSeq: result.ledgerSeq,
    deadline: result.deadline.toISOString(),
  };
  return NextResponse.json(payload, { status: 201 });
}

/**
 * `not_owner` answers 404 rather than 403 on purpose: a commitment can be unlisted, and
 * distinguishing "exists but is not yours" from "does not exist" would turn this route into
 * an existence oracle for ids the caller cannot otherwise see.
 */
const REFUSALS: Record<
  AmendmentRefusal,
  { readonly status: number; readonly message: string; readonly field?: string }
> = {
  not_found: { status: 404, message: "no such commitment" },
  not_owner: { status: 404, message: "no such commitment" },
  not_open: {
    status: 409,
    message: "this commitment has already resolved — its record does not change",
  },
  deadline_unchanged: {
    status: 400,
    message: "that is the deadline it already has",
    field: "deadlineDate",
  },
};
