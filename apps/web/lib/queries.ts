/**
 * Reads the pages need that @pledge/db does not already provide. Reads only — every write the
 * web tier makes goes through `insertCommitment`.
 *
 * `pledge_web` holds SELECT on `probe_run` (migration 0000) precisely so the commitment page
 * can show the observation history. What is rendered from it is facts about what was seen,
 * never a conclusion.
 */
import { account, commitment, doneSpec, getDb, probeRun } from "@pledge/db";
import type { CommitmentRow, DoneSpecV0, ProbeRunRow } from "@pledge/db";
import { desc, eq, inArray } from "drizzle-orm";

export interface CommitmentDetail {
  readonly commitment: CommitmentRow;
  readonly spec: DoneSpecV0;
  readonly handle: string;
  readonly runs: readonly ProbeRunRow[];
}

/** The commitment page. `undefined` when the id is unknown or the commitment is not public. */
export async function getPublicCommitmentDetail(
  id: string,
): Promise<CommitmentDetail | undefined> {
  const db = getDb();

  const [row] = await db
    .select({ commitment, spec: doneSpec.ast, handle: account.handle })
    .from(commitment)
    .innerJoin(account, eq(account.id, commitment.accountId))
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(eq(commitment.id, id))
    .limit(1);

  if (row === undefined || row.commitment.visibility !== "public") return undefined;

  const runs = await db
    .select()
    .from(probeRun)
    .where(eq(probeRun.commitmentId, id))
    .orderBy(desc(probeRun.ranAt));

  return { commitment: row.commitment, spec: row.spec, handle: row.handle, runs };
}

/** Most recent observation per commitment, for the evidence summary on the profile. */
export async function latestRunsFor(
  commitmentIds: readonly string[],
): Promise<ReadonlyMap<string, ProbeRunRow>> {
  if (commitmentIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(probeRun)
    .where(inArray(probeRun.commitmentId, [...commitmentIds]))
    .orderBy(desc(probeRun.ranAt));

  // ponytail: fold in JS rather than DISTINCT ON. A profile is tens of commitments with a
  // handful of runs each; the window function earns its keep when that stops being true.
  const latest = new Map<string, ProbeRunRow>();
  for (const row of rows) {
    if (!latest.has(row.commitmentId)) latest.set(row.commitmentId, row);
  }
  return latest;
}
