import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { api, setToken } from "../api.ts";
import { TopBar } from "../components/layout.tsx";
import { Button, Empty, ErrorNote, Loading, PageTitle, RunStrip, VerdictBadge, Wordmark } from "../components/ui.tsx";
import { when } from "../format.ts";
import { reposQuery } from "../queries.ts";
import type { Me } from "../types.ts";

export function LoginPage() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [token, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<Me>("/me", { token: token.trim() });
      setToken(token.trim());
      client.clear();
      await navigate({ to: "/repos" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center p-4">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-[440px] rounded-md border border-line bg-glass p-7 shadow-[inset_0_1px_0_var(--glass-hi)]">
        <p><Wordmark /></p>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-.03em]">Sign in</h1>
        <p className="mt-2 text-sm text-ink-2">GitHub sign-in is not set up yet. Until it is, the dashboard opens with the shared access token.</p>
        <label className="mt-5 block">
          <span className="font-mono text-[11px] text-mute">Access token</span>
          <input type="password" autoComplete="current-password" required value={token} onChange={(event) => setValue(event.target.value)} className="mt-1.5 w-full rounded-sm border border-line bg-card px-3 py-2.5 font-mono text-[13px]" />
        </label>
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" kind="solid" disabled={busy || token.trim() === ""}>{busy ? "Checking…" : "Sign in"}</Button>
          {error ? <span role="alert" className="font-mono text-xs text-seal">{error}</span> : null}
        </div>
      </form>
    </div>
  );
}

/** The repo picker. */
export function ReposPage() {
  const repos = useQuery(reposQuery());
  return (
    <div className="min-h-screen">
      <TopBar />
      <main className="mx-auto max-w-[920px] px-4 pb-24 pt-10 sm:px-8">
        <PageTitle title="Repos" lede="Every repo that has had a scan. Connecting a repo through GitHub is not built yet: a repo appears here when the command line publishes its first run." />
        {repos.isPending ? <Loading what="repos" /> : null}
        {repos.isError ? <ErrorNote error={repos.error} retry={() => void repos.refetch()} /> : null}
        {repos.data?.length === 0 ? (
          <Empty title="No repo has been scanned yet.">
            <p>Run a first scan and send it here with <code>pledge author &lt;repo&gt; --out &lt;dir&gt; --publish</code>.</p>
          </Empty>
        ) : null}
        <div className="mt-7 border-t border-line">
          {repos.data?.map((repo) => (
            <Link key={repo.id} to="/r/$repoId/overview" params={{ repoId: repo.id }} className={`grid grid-cols-1 items-center gap-x-5 gap-y-2 border-b border-line px-3 py-4 hover:bg-glass sm:grid-cols-[110px_minmax(0,1fr)_auto] ${repo.openFindings > 0 ? "shadow-[inset_2px_0_0_var(--seal)]" : ""}`}>
              <span><VerdictBadge verdict={repo.latestRun?.verdict ?? null} /></span>
              <span className="min-w-0">
                <span className="block text-[17px] font-medium tracking-[-.01em]">{repo.name}</span>
                <span className="mt-1 block"><RunStrip summary={repo.latestRun?.summary ?? null} /></span>
              </span>
              <span className="font-mono text-xs text-mute sm:text-right">
                {repo.pledges} {repo.pledges === 1 ? "pledge" : "pledges"}, {repo.openFindings} open {repo.openFindings === 1 ? "finding" : "findings"}
                <span className="block">last run {when(repo.lastActivity)}</span>
              </span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
