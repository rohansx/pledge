/**
 * Reads for the OG cards.
 *
 * PUBLIC ONLY. A card URL is unauthenticated by nature — that is the whole point of it, a
 * crawler with no session fetches it — so anything these queries return is world-readable in
 * practice. Both filter on `visibility = 'public'` for the same reason lib/queries.ts does,
 * and an unlisted or private commitment renders no card rather than a redacted one.
 *
 * Separate from lib/queries.ts because a card needs one thing the pages do not — the amendment
 * count — and does not need the probe history they do.
 */
import { and, count, eq } from "drizzle-orm";
import { account, amendment, commitment, doneSpec, getDb } from "@pledge/db";
import type { CommitmentStatus, DoneSpecV0 } from "@pledge/db/types";

export interface CommitmentCardData {
  readonly handle: string;
  readonly claim: string;
  readonly status: CommitmentStatus;
  readonly spec: DoneSpecV0;
  readonly amendmentCount: number;
}

export async function getCommitmentCardData(
  id: string,
): Promise<CommitmentCardData | undefined> {
  const db = getDb();

  const [row] = await db
    .select({
      handle: account.handle,
      claim: commitment.claim,
      status: commitment.status,
      spec: doneSpec.ast,
      visibility: commitment.visibility,
    })
    .from(commitment)
    .innerJoin(account, eq(account.id, commitment.accountId))
    .innerJoin(doneSpec, eq(doneSpec.hash, commitment.doneSpecHash))
    .where(eq(commitment.id, id))
    .limit(1);

  if (row === undefined || row.visibility !== "public") return undefined;

  const [amendments] = await db
    .select({ n: count() })
    .from(amendment)
    .where(eq(amendment.commitmentId, id));

  return {
    handle: row.handle,
    claim: row.claim,
    status: row.status,
    spec: row.spec,
    amendmentCount: amendments?.n ?? 0,
  };
}

export interface ProfileCardData {
  readonly handle: string;
  readonly total: number;
  readonly kept: number;
  readonly missed: number;
}

/**
 * Counted in SQL rather than by loading the rows: the card needs three integers and a profile
 * with a long record is exactly the one whose card gets fetched most.
 */
export async function getProfileCardData(handle: string): Promise<ProfileCardData | undefined> {
  const db = getDb();

  const [found] = await db
    .select({ handle: account.handle })
    .from(account)
    .where(eq(account.handle, handle))
    .limit(1);

  if (found === undefined) return undefined;

  const rows = await db
    .select({ status: commitment.status, n: count() })
    .from(commitment)
    .innerJoin(account, eq(account.id, commitment.accountId))
    .where(and(eq(account.handle, handle), eq(commitment.visibility, "public")))
    .groupBy(commitment.status);

  const by = new Map(rows.map((row) => [row.status, row.n]));
  const total = rows.reduce((sum, row) => sum + row.n, 0);

  return {
    handle: found.handle,
    total,
    kept: by.get("kept") ?? 0,
    missed: by.get("missed") ?? 0,
  };
}
