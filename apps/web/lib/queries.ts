/**
 * Reads the pages need that @pledge/db does not already provide. Reads only — the web tier's
 * writes go through `insertCommitment` and `recordAmendment`.
 *
 * `pledge_web` holds SELECT on `probe_run` and on `amendment` (migrations 0000 and 0001)
 * precisely so the commitment page can show the observation history and the amendment
 * history. What is rendered from either is facts about what happened, never a conclusion.
 */
import { account, amendment, commitment, doneSpec, getDb, probeRun } from "@pledge/db";
import type {
  AmendmentRow,
  CommitmentRow,
  ProbeRunRow,
} from "@pledge/db";
import { asc, desc, eq, inArray } from "drizzle-orm";
import type { StoredSpec } from "./spec-display";

export interface CommitmentDetail {
  readonly commitment: CommitmentRow;
  /** Either era of stored spec — see `StoredSpec` in ./spec-display. */
  readonly spec: StoredSpec;
  readonly handle: string;
  readonly runs: readonly ProbeRunRow[];
  /** Oldest first: the order a history reads in, and the order "moved twice" is legible in. */
  readonly amendments: readonly AmendmentRow[];
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

  const amendments = await db
    .select()
    .from(amendment)
    .where(eq(amendment.commitmentId, id))
    .orderBy(asc(amendment.createdAt));

  return { commitment: row.commitment, spec: row.spec, handle: row.handle, runs, amendments };
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

/**
 * Amendments for a page of commitments, oldest first per commitment.
 *
 * The profile needs these, not just a count: "deadline moved" is only meaningful next to what
 * it moved from, and a reader who cannot see the original is being shown a tidied record.
 */
export async function amendmentsFor(
  commitmentIds: readonly string[],
): Promise<ReadonlyMap<string, readonly AmendmentRow[]>> {
  if (commitmentIds.length === 0) return new Map();

  const rows = await getDb()
    .select()
    .from(amendment)
    .where(inArray(amendment.commitmentId, [...commitmentIds]))
    .orderBy(asc(amendment.createdAt));

  const byCommitment = new Map<string, AmendmentRow[]>();
  for (const row of rows) {
    const list = byCommitment.get(row.commitmentId);
    if (list === undefined) byCommitment.set(row.commitmentId, [row]);
    else list.push(row);
  }
  return byCommitment;
}
