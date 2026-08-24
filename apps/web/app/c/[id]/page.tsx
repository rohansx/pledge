/**
 * One commitment: the claim, the criterion in full, the countdown, and every observation.
 *
 * This page is what `StatusBadge` links to, and it is why the badge's link is not optional
 * (security.md T-04). The done-spec is rendered above the outcome, not below it — the reader
 * should know what was being checked before they are told the result.
 *
 * The probe history shows `error` runs as their own thing, never folded into failures. A run
 * that could not observe the target has observed nothing (CLAUDE.md I-7), and a page that
 * displayed a red row for a DNS blip would teach readers the exact wrong model.
 */
import type { Metadata, Route } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Countdown } from "@/components/countdown";
import { LocalTime } from "@/components/local-time";
import { StatusBadge } from "@/components/status-badge";
import { formatInZone } from "@/lib/deadline";
import { getPublicCommitmentDetail } from "@/lib/queries";
import { describeEvidence, describeSpec } from "@/lib/spec-display";

export const revalidate = 60;

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const detail = await getPublicCommitmentDetail(id);
  if (detail === undefined) return { title: "Not found — pledge" };

  const title = `${detail.commitment.claim} — ${detail.handle}`;
  return {
    title,
    description: `Resolved by: ${describeSpec(detail.spec)}`,
    alternates: { canonical: `/c/${detail.commitment.id}` },
  };
}

export default async function CommitmentPage({ params }: PageProps) {
  const { id } = await params;
  const detail = await getPublicCommitmentDetail(id);
  if (detail === undefined) notFound();

  const { commitment, spec, handle, runs } = detail;
  const href = `/c/${commitment.id}` as Route;

  return (
    <main className="page narrow">
      <p className="crumb">
        <Link href={`/${handle}` as const}>{handle}</Link>
      </p>

      <h1>{commitment.claim}</h1>

      <div className="commitment-head">
        <StatusBadge status={commitment.status} specHref={href} />
        {commitment.status === "open" ? (
          <span className="muted">
            <Countdown
              deadlineIso={commitment.deadline.toISOString()}
              fallback={`due ${formatInZone(commitment.deadline, "UTC")}`}
            />
          </span>
        ) : null}
      </div>

      <section>
        <h2>Done-spec</h2>
        <code className="spec block">{describeSpec(spec)}</code>
        <dl className="meta">
          <div>
            <dt>Hash</dt>
            {/* Content-addressed and immutable. This is what makes the criterion a contract
                rather than a description of one (CLAUDE.md I-4). */}
            <dd>
              <code>{commitment.doneSpecHash}</code>
            </dd>
          </div>
          <div>
            <dt>Committed</dt>
            <dd>
              <LocalTime
                iso={commitment.committedAt.toISOString()}
                fallback={formatInZone(commitment.committedAt, "UTC")}
              />
            </dd>
          </div>
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
        {commitment.resolvedAt !== null ? (
          <p className="muted">
            That is when a probe <em>observed</em> the condition, which is not necessarily when
            the work happened. pledge only knows what it saw and when it looked.
          </p>
        ) : null}
      </section>

      <section>
        <h2>Probe runs</h2>
        {runs.length === 0 ? (
          <p className="empty">No probe has run yet.</p>
        ) : (
          <ol className="runs">
            {runs.map((run) => (
              <li key={run.id} className={`run run-${run.outcome}`}>
                <span className="run-outcome">{OUTCOME_LABEL[run.outcome]}</span>
                <LocalTime
                  iso={run.ranAt.toISOString()}
                  fallback={formatInZone(run.ranAt, "UTC")}
                />
                <span className="run-detail">
                  {describeEvidence(run.outcome, run.evidence)}
                </span>
                <span className="muted">{run.durationMs}ms</span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

/**
 * `error` is labelled as its own category, deliberately verbose. "failed" would be a lie about
 * what happened and the lie the whole outcome enum exists to prevent.
 */
const OUTCOME_LABEL = {
  pass: "condition true",
  fail: "condition false",
  error: "not observed",
} as const;
