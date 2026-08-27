/**
 * Amending a commitment: move the deadline, or withdraw it.
 *
 * A separate route rather than a panel on `/c/[id]` for one structural reason: `auth()` makes
 * a page dynamic, and `/c/[id]` is an ISR'd public record page that has to stay a 200 to
 * `curl` with JS disabled. Owner controls belong on an owner's page.
 *
 * Not indexed, and 404 for anyone who is not the committer — including for a commitment that
 * exists but is someone else's, so this route cannot be used to test whether an id is real.
 *
 * INVARIANT I-1: nothing on this page or under it can mark a commitment done. The two things
 * it offers are a later (or earlier) deadline and a withdrawal, both of which are recorded,
 * both of which stay visible, and neither of which is a success.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCommitmentWithSpec, getDb } from "@pledge/db";
import { auth } from "@/auth";
import { AmendmentHistory } from "@/components/amendment-history";
import { formatInZone } from "@/lib/deadline";
import { amendmentsFor } from "@/lib/queries";
import { describeSpec } from "@/lib/spec-display";
import { AmendForm } from "./amend-form";

export const metadata: Metadata = {
  title: "Amend a commitment — pledge",
  robots: { index: false },
};

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AmendPage({ params }: PageProps) {
  const { id } = await params;

  const session = await auth();
  if (session === null) redirect(`/c/${id}`);

  const found = await getCommitmentWithSpec(getDb(), id);
  // One 404 for "no such commitment" and for "not yours". Distinguishing them would make this
  // route an existence oracle for ids the caller cannot otherwise see.
  if (found === undefined || found.commitment.accountId !== session.user.accountId) notFound();

  const { commitment, spec } = found;
  const amendments = (await amendmentsFor([id])).get(id) ?? [];

  return (
    <main className="page narrow">
      <p className="crumb">
        <Link href={`/c/${id}` as const}>{commitment.claim}</Link>
      </p>

      <h1>Amend this commitment</h1>

      {commitment.status === "open" ? (
        <>
          <p className="lede">
            Both of these are recorded with your reason and shown on the record beside the
            outcome. Nothing is deleted and nothing is edited in place.
          </p>

          <section>
            <h2>What was promised</h2>
            {/* The done-spec is shown here, unchanged and unchangeable. An amendment moves
                when this is checked; it never changes what is checked (CLAUDE.md I-4). */}
            <code className="spec block">{describeSpec(spec)}</code>
            <p className="muted">
              The done-spec cannot be amended. A different criterion is a different hash, and
              therefore a different commitment — make a new one.
            </p>
          </section>

          <AmendForm
            commitmentId={id}
            currentDeadlineIso={commitment.deadline.toISOString()}
            currentDeadlineUtc={formatInZone(commitment.deadline, "UTC")}
          />
        </>
      ) : (
        <p className="note">
          This commitment has already resolved. Its record does not change — a deadline moved
          after the fact would be the revision this product exists to prevent.
        </p>
      )}

      {amendments.length > 0 ? (
        <section>
          <h2>Already on the record</h2>
          <AmendmentHistory amendments={amendments} />
        </section>
      ) : null}
    </main>
  );
}
