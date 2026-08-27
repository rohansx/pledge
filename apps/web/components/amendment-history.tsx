/**
 * The amendment history, rendered wherever a commitment is.
 *
 * architecture.md §5.1: "a commitment whose deadline moved twice and landed on time is a
 * materially different signal from one that never moved; hiding that would make pledge
 * exactly the thing it criticises." So this is not a collapsed panel, not a tooltip, and not
 * behind a "show details" toggle. It sits next to the outcome, with the reason in full.
 *
 * The reason is the load-bearing part. A moved deadline with a stated reason is a record; a
 * moved deadline without one is the silent revision the whole table exists to prevent.
 */
import type { AmendmentRow } from "@pledge/db";
import { LocalTime } from "@/components/local-time";
import { AMENDMENT_LABEL } from "@/lib/amendment-input";
import { formatInZone } from "@/lib/deadline";

interface AmendmentHistoryProps {
  /** Oldest first. `amendmentsFor` and `getPublicCommitmentDetail` both return that order. */
  amendments: readonly AmendmentRow[];
}

export function AmendmentHistory({ amendments }: AmendmentHistoryProps) {
  if (amendments.length === 0) return null;

  return (
    <ol className="amendments">
      {amendments.map((row) => (
        <li key={row.id} className={`amendment amendment-${row.kind}`}>
          <div className="amendment-head">
            <span className="amendment-kind">{AMENDMENT_LABEL[row.kind]}</span>
            <LocalTime
              iso={row.createdAt.toISOString()}
              fallback={formatInZone(row.createdAt, "UTC")}
            />
          </div>

          {row.kind === "deadline_moved" ? (
            <p className="amendment-move">
              <MovedDeadline from={row.oldValue} to={row.newValue} />
            </p>
          ) : null}

          {/* The committer's own words, verbatim. Not summarised and not truncated — a
              shortened reason is a reason someone else rewrote. */}
          <blockquote className="amendment-reason">{row.reason}</blockquote>
        </li>
      ))}
    </ol>
  );
}

/**
 * Both ends of the move. Rendering only the new value would make the history a list of
 * timestamps that say nothing, which is the tidied version of this record.
 */
function MovedDeadline({ from, to }: { from: string | null; to: string | null }) {
  if (from === null || to === null) return <>Deadline changed.</>;
  const before = new Date(from);
  const after = new Date(to);
  return (
    <>
      <LocalTime iso={before.toISOString()} fallback={formatInZone(before, "UTC")} />
      {" → "}
      <LocalTime iso={after.toISOString()} fallback={formatInZone(after, "UTC")} />
      {after.getTime() > before.getTime() ? " · later" : " · earlier"}
    </>
  );
}
