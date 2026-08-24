/**
 * Auth.js v5 + GitHub OAuth. The handle is claimed from the GitHub login at first sign-in
 * (roadmap.md v0) and never chased across a GitHub rename — see upsertAccountFromGithub.
 *
 * NO DATABASE ADAPTER, deliberately. @auth/drizzle-adapter needs its own `users` / `accounts`
 * / `sessions` / `verificationTokens` tables, and migration 0000 has none of them: v0's
 * identity is the `account` row, keyed on `github_id`. A JWT session carries the two things
 * every request needs — `accountId` and `handle` — so those four tables would be dead weight
 * whose only reader is the adapter itself. Sessions become stateful when something actually
 * needs revocation.
 *
 * Cookies: Auth.js sets the session cookie httpOnly, SameSite=Lax, Secure in production, and
 * `cookies` below restates that rather than relying on the default staying put.
 *
 * Credentials come from AUTH_GITHUB_ID / AUTH_GITHUB_SECRET, which Auth.js reads on its own.
 * Nothing here touches them at module scope, so a placeholder value blocks sign-in at the
 * OAuth redirect and leaves the rest of the app booting and rendering normally.
 */
import { getDb, upsertAccountFromGithub } from "@pledge/db";
import NextAuth from "next-auth";
// Imported for its side effect only: a `declare module` augmentation needs the module to be
// resolvable from this file, and next-auth/jwt exports no value we use.
import type {} from "next-auth/jwt";
import GitHub from "next-auth/providers/github";

/** The fields we add to the token and the session. */
declare module "next-auth" {
  interface Session {
    user: {
      accountId: string;
      handle: string;
      email?: string | null;
      name?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accountId?: string;
    handle?: string;
  }
}

/**
 * GitHub's user payload, narrowed to the three fields we claim an identity from. The OAuth
 * profile is zone 1 input (architecture.md §4) and arrives as `unknown`-shaped JSON, so it is
 * checked rather than cast.
 */
interface GithubProfileFields {
  readonly id: number;
  readonly login: string;
  readonly email: string | null;
}

function readGithubProfile(profile: unknown): GithubProfileFields | undefined {
  if (typeof profile !== "object" || profile === null) return undefined;
  const p = profile as Record<string, unknown>;
  if (typeof p["id"] !== "number" || typeof p["login"] !== "string") return undefined;
  return {
    id: p["id"],
    login: p["login"],
    email: typeof p["email"] === "string" ? p["email"] : null,
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [GitHub],
  session: { strategy: "jwt" },
  /**
   * Auth.js will not derive its own origin from the Host header unless told to, because a
   * forged Host is an open-redirect and callback-hijack primitive.
   *
   * DEPLOYMENT REQUIREMENT: set AUTH_URL to the real origin in production. AUTH_URL takes
   * precedence over the Host header entirely, so with it set this flag never has an effect
   * and the attack it guards against is unreachable. Without it, this trusts the incoming
   * Host, which is only safe behind a proxy that normalises it.
   *
   * Not gated on NODE_ENV: `next start` is NODE_ENV=production on a laptop, and a dev-only
   * value here would leave local sign-in broken while claiming to be the safe choice.
   */
  trustHost: true,
  cookies: {
    sessionToken: {
      name: "pledge.session",
      options: {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: process.env.NODE_ENV === "production",
      },
    },
  },
  pages: { signIn: "/" },
  callbacks: {
    /**
     * Runs on sign-in (when `profile` is present) and on every subsequent token read. The
     * account upsert happens here rather than in `signIn` because this is the callback whose
     * return value is persisted — the handle has to survive into the token or every request
     * re-queries.
     */
    async jwt({ token, profile }) {
      if (profile === undefined) return token;

      const github = readGithubProfile(profile);
      if (github === undefined) {
        throw new Error("GitHub returned a profile without a numeric id and a login");
      }

      const row = await upsertAccountFromGithub(getDb(), {
        githubId: github.id,
        handle: github.login,
        // `account.email` is NOT NULL and GitHub omits the address when the user keeps it
        // private. The noreply address is GitHub's own documented stand-in and is routable,
        // so commit mail still lands rather than the sign-in failing.
        email: github.email ?? `${github.login}@users.noreply.github.com`,
      });

      return { ...token, accountId: row.id, handle: row.handle };
    },

    session({ session, token }) {
      if (token.accountId === undefined || token.handle === undefined) return session;
      return {
        ...session,
        user: { ...session.user, accountId: token.accountId, handle: token.handle },
      };
    },
  },
});
