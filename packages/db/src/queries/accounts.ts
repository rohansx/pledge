import { eq } from "drizzle-orm";
import type { DbOrTx } from "../client";
import { account, type AccountRow } from "../schema";

export interface GithubIdentity {
  readonly githubId: number;
  readonly handle: string;
  readonly email: string;
}

/**
 * First sign-in creates the account and claims the handle from the GitHub login; later
 * sign-ins refresh the email only.
 *
 * The handle is deliberately NOT chased across GitHub renames. It is the public profile URL
 * and the identity a receipt points at — silently repointing it would break every link
 * someone shared, and `github_id` already carries the stable identity. A rename becomes a
 * user-initiated move when someone asks for one.
 */
export async function upsertAccountFromGithub(
  db: DbOrTx,
  identity: GithubIdentity,
): Promise<AccountRow> {
  const [row] = await db
    .insert(account)
    .values({
      githubId: identity.githubId,
      handle: identity.handle,
      email: identity.email,
    })
    .onConflictDoUpdate({
      target: account.githubId,
      set: { email: identity.email },
    })
    .returning();
  if (row === undefined) throw new Error("upsertAccountFromGithub returned no row");
  return row;
}

export async function getAccountByHandle(
  db: DbOrTx,
  handle: string,
): Promise<AccountRow | undefined> {
  const [row] = await db.select().from(account).where(eq(account.handle, handle)).limit(1);
  return row;
}
