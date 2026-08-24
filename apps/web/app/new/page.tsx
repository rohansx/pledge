import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import { Composer } from "./composer";

export const metadata: Metadata = {
  title: "New commitment — pledge",
  // Not indexed: it is a form behind a session, and the record is the SEO surface.
  robots: { index: false },
};

export default async function NewCommitmentPage() {
  const session = await auth();

  if (session === null) {
    return (
      <main className="page narrow">
        <h1>Sign in to commit</h1>
        <p>
          The handle on your record is your GitHub login. Sign-in exists so a commitment has an
          owner — it is not what resolves one.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/new" });
          }}
        >
          <button type="submit">Continue with GitHub</button>
        </form>
      </main>
    );
  }

  // A session that never reached the jwt callback has no handle, which means the account row
  // was never written. Nothing downstream can work; send them back through sign-in.
  if (session.user.handle === undefined) redirect("/");

  return (
    <main className="page narrow">
      <h1>A new commitment</h1>
      <p className="lede">
        It becomes part of <a href={`/${session.user.handle}`}>your record</a> the moment it is
        created, and stays there whichever way it resolves.
      </p>
      <Composer />
    </main>
  );
}
