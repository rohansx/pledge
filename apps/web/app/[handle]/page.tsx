/**
 * The public profile. The product's SEO surface and its sharing surface, and a v0 exit
 * criterion: server-rendered, 200 to `curl` with JS disabled, crawlable.
 *
 * Everything on this page is a server component. The only client code is `LocalTime`, which
 * upgrades an already-rendered UTC string — remove it and the page still says everything true.
 *
 * MISSES ARE SHOWN. Not collapsed, not below a fold, not behind a filter. A record that only
 * lists successes is self-reporting with extra steps, which is the thing this product exists
 * to replace. The counts line states the denominator first.
 */
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getAccountByHandle, getDb, listPublicCommitments } from "@pledge/db";
import type { CommitmentStatus } from "@pledge/db/types";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import { formatInZone } from "@/lib/deadline";
import { latestRunsFor } from "@/lib/queries";
import { describeEvidence, describeSpec } from "@/lib/spec-display";

/** technical-spec §10. Public reads are cached; the record changes at probe cadence. */
export const revalidate = 60;

interface PageProps {
  params: Promise<{ handle: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { handle } = await params;
  const account = await getAccountByHandle(getDb(), handle);
  if (account === undefined) return { title: "Not found — pledge" };

  const title = `${account.handle} — the record`;
  const description = `Commitments made by ${account.handle}, resolved by probes against external state. Kept and missed alike.`;
  return {
    title,
    description,
    alternates: { canonical: `/${account.handle}` },
    // No OG images. next/og cards are v1 (roadmap.md deferred list).
    openGraph: { title, description, type: "profile" },
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const { handle } = await params;
  const db = getDb();

  const account = await getAccountByHandle(db, handle);
  if (account === undefined) notFound();

  const commitments = await listPublicCommitments(db, account.handle);
  const latestRuns = await latestRunsFor(commitments.map((c) => c.commitment.id));

  const counts = tally(commitments.map((c) => c.commitment.status));

  return (
    <main className="page">
      <header className="profile-head">
        <h1>{account.handle}</h1>
        {/* Record first, in the past tense. No streak, no encouragement (ADR-0009). */}
        <p className="counts">
          {counts.total} {counts.total === 1 ? "commitment" : "commitments"} on the record
          {counts.total > 0 ? (
            <>
              {" · "}
              <span className="count-kept">{counts.kept} kept</span>
              {" · "}
              <span className="count-missed">{counts.missed} missed</span>
              {counts.open > 0 ? ` · ${counts.open} open` : null}
              {counts.disputed > 0 ? ` · ${counts.disputed} unverified` : null}
              {counts.abandoned > 0 ? ` · ${counts.abandoned} withdrawn` : null}
            </>
          ) : null}
        </p>
        <p className="muted">
          Every outcome below was resolved by a probe against the stated done-spec. None of it
          was reported by {account.handle}.
        </p>
      </header>

      {commitments.length === 0 ? (
        <p className="empty">Nothing on the record yet.</p>
      ) : (
        <ol className="commitments">
          {commitments.map(({ commitment, spec }) => {
            const run = latestRuns.get(commitment.id);
            const href = `/c/${commitment.id}` as Route;
            return (
              <li key={commitment.id} className="commitment">
                <div className="commitment-head">
                  <Link className="claim" href={href}>
                    {commitment.claim}
                  </Link>
                  <StatusBadge status={commitment.status} specHref={href} />
                </div>

                <code className="spec">{describeSpec(spec)}</code>

                <dl className="meta">
                  <div>
                    <dt>Deadline</dt>
                    <dd>
                      <LocalTime
                        iso={commitment.deadline.toISOString()}
                        fallback={formatInZone(commitment.deadline, "UTC")}
                      />
                    </dd>
                  </div>
                  {commitment.resolvedAt !== null ? (
                    <div>
                      {/* "Observed at", never "shipped at". The system knows when a probe saw
                          the condition true, not when the work happened (CLAUDE.md copy). */}
                      <dt>Observed at</dt>
                      <dd>
                        <LocalTime
                          iso={commitment.resolvedAt.toISOString()}
                          fallback={formatInZone(commitment.resolvedAt, "UTC")}
                        />
                      </dd>
                    </div>
                  ) : null}
                </dl>

                {run !== undefined ? (
                  <p className="evidence">
                    Last probe: {describeEvidence(run.outcome, run.evidence)}
                  </p>
                ) : (
                  <p className="evidence muted">No probe has run yet.</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </main>
  );
}

type Tally = Record<CommitmentStatus, number> & { total: number };

function tally(statuses: readonly CommitmentStatus[]): Tally {
  const counts: Tally = {
    total: statuses.length,
    open: 0,
    kept: 0,
    missed: 0,
    abandoned: 0,
    disputed: 0,
  };
  // Immutable would mean rebuilding the object per element for no benefit; the accumulator
  // never escapes this function.
  for (const s of statuses) counts[s] += 1;
  return counts;
}
