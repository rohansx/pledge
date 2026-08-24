/**
 * The status of a commitment, always with its criterion one click away.
 *
 * `specHref` is REQUIRED, not optional. security.md T-04: a context-free green check is the
 * gaming vector, and an optional prop is an invitation to omit it on the surface where it
 * matters most. If you are rendering a status somewhere that has no page to link to, that
 * surface is the problem.
 */
import Link from "next/link";
import type { CommitmentStatus } from "@pledge/db/types";
import type { Route } from "next";

/** Past tense, no encouragement, no streaks (ADR-0009, CLAUDE.md copy rules). */
const LABEL: Record<CommitmentStatus, string> = {
  open: "open",
  kept: "kept",
  missed: "missed",
  abandoned: "withdrawn",
  disputed: "unverified",
};

/** What the state actually means, in the tooltip. `disputed` is the one people misread. */
const TITLE: Record<CommitmentStatus, string> = {
  open: "Not yet resolved. No probe has observed the done-condition true.",
  kept: "A probe observed the done-condition true.",
  missed: "The authoritative probe observed the done-condition false.",
  abandoned: "Withdrawn by the committer before the deadline.",
  disputed: "The target could not be observed at the deadline. Nothing was concluded.",
};

interface StatusBadgeProps {
  status: CommitmentStatus;
  /** Where the done-spec is readable. Required — see the note above. */
  specHref: Route;
}

export function StatusBadge({ status, specHref }: StatusBadgeProps) {
  return (
    <Link className={`badge badge-${status}`} href={specHref} title={TITLE[status]}>
      {LABEL[status]}
      <span className="badge-spec">spec</span>
    </Link>
  );
}
