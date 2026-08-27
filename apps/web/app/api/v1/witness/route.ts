/**
 * POST /api/v1/witness — invite witnesses to one of your own commitments.
 *
 * INVARIANT I-1: no status field anywhere in this file. Inviting someone to look at a
 * commitment cannot change its outcome, and neither can anything they do afterwards beyond
 * making it contested (see lib/witness.ts).
 *
 * Authorisation is ownership, not merely a session: you may invite witnesses to your own
 * commitment and to nobody else's. Without that check, any signed-in account could mail
 * anybody in the name of any handle on the platform — a spam relay wearing the product's
 * From: address.
 */
import { getCommitmentWithSpec, getDb } from "@pledge/db";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { toFieldErrors } from "@/lib/commitment-input";
import { formatInZone } from "@/lib/deadline";
import { sendWitnessInviteMail } from "@/lib/mail";
import { inviteWitnesses, TooManyWitnessesError } from "@/lib/witness";
import { WitnessInviteInputSchema } from "@/lib/witness-input";

export async function POST(request: Request): Promise<NextResponse> {
  const session = await auth();
  if (session === null) {
    return NextResponse.json({ error: "sign in to invite a witness" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  const parsed = WitnessInviteInputSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid invitation", fields: toFieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const found = await getCommitmentWithSpec(getDb(), input.commitmentId);
  // One response for "does not exist" and for "is not yours". The difference is only useful to
  // someone enumerating commitment ids.
  if (found === undefined || found.commitment.accountId !== session.user.accountId) {
    return NextResponse.json({ error: "no such commitment" }, { status: 404 });
  }

  let invitations;
  try {
    invitations = await inviteWitnesses({
      commitmentId: input.commitmentId,
      accountId: session.user.accountId,
      emails: input.emails,
    });
  } catch (error: unknown) {
    if (error instanceof TooManyWitnessesError) {
      return NextResponse.json(
        { error: "invalid invitation", fields: { emails: [error.message] } },
        { status: 400 },
      );
    }
    throw error;
  }

  const commitmentUrl = `${baseUrl()}/c/${input.commitmentId}`;
  // Fire and forget, and outside any transaction: the rows are already committed, and a mail
  // failure must never undo an invitation (architecture.md §8).
  for (const invitation of invitations) {
    sendWitnessInviteMail({
      to: invitation.email,
      handle: session.user.handle,
      claim: found.commitment.claim,
      // UTC rendering: this endpoint has no zone from the caller, and a wrong local time is
      // worse than an explicit UTC one.
      deadline: formatInZone(found.commitment.deadline, "UTC"),
      attestUrl: `${baseUrl()}/w/${invitation.token}`,
      commitmentUrl,
    });
  }

  // The token is NOT in the response. It goes to the invited inbox and nowhere else — echoing
  // it here would let the committer hold their own witnesses' links.
  return NextResponse.json(
    {
      invited: invitations.map((invitation) => ({
        witnessId: invitation.witnessId,
        email: invitation.email,
        expiresAt: invitation.expiresAt.toISOString(),
      })),
    },
    { status: 201 },
  );
}

function baseUrl(): string {
  return process.env["NEXT_PUBLIC_BASE_URL"] ?? "http://localhost:3000";
}
