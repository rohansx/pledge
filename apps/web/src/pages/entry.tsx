import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { api, setToken } from "../api.ts";
import { TopBar } from "../components/layout.tsx";
import { Badge, Button, Empty, ErrorNote, Loading, PageTitle, RunStrip, VerdictBadge, Wordmark } from "../components/ui.tsx";
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
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-[400px] rounded-xl border border-line bg-card p-7 shadow-sm">
        <p><Wordmark /></p>
        <h1 className="mt-5 text-2xl font-semibold tracking-[-.03em]">Sign in</h1>
        <p className="mt-2 text-sm text-ink-2">Sign in with your team's access token, the PLEDGE_API_TOKEN the command line publishes with.</p>
        <label className="mt-5 block">
          <span className="text-[13px] font-medium">Access token</span>
          <input type="password" autoComplete="current-password" required value={token} onChange={(event) => setValue(event.target.value)} className="mt-1.5 h-9 w-full rounded-md border border-line bg-card px-3 font-mono text-[13px] shadow-xs" />
        </label>
        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" variant="default" className="w-full justify-center" disabled={busy || token.trim() === ""}>{busy ? "Checking…" : "Sign in"}</Button>
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
      <main className="mx-auto max-w-[1040px] px-4 pb-24 pt-10 sm:px-8">
        <PageTitle title="Repos" lede="Every repo that has published a scan." />
        {repos.isPending ? <Loading what="repos" /> : null}
        {repos.isError ? <ErrorNote error={repos.error} retry={() => void repos.refetch()} /> : null}
        {repos.data?.length === 0 ? (
          <Empty title="No repo has been scanned yet.">
            <p>Run a first scan and send it here with <code>pledge author &lt;repo&gt; --out &lt;dir&gt; --publish</code>.</p>
          </Empty>
        ) : null}
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {repos.data?.map((repo) => (
            <Link key={repo.id} to="/r/$repoId/overview" params={{ repoId: repo.id }} className="flex flex-col gap-3 rounded-xl border border-line bg-card p-5 shadow-xs transition-colors hover:border-mute">
              <span className="flex items-center gap-3">
                <span aria-hidden="true" className="grid size-9 place-items-center rounded-lg bg-ink text-sm font-semibold uppercase text-paper">{repo.name[0]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{repo.name}</span>
                  <span className="block text-xs text-mute">last run {when(repo.lastActivity)}</span>
                </span>
                {repo.openFindings > 0 ? <Badge tone="seal">{repo.openFindings} open</Badge> : <VerdictBadge verdict={repo.latestRun?.verdict ?? null} />}
              </span>
              <RunStrip summary={repo.latestRun?.summary ?? null} />
              <span className="border-t border-line pt-3 text-xs text-ink-2">{repo.pledges} {repo.pledges === 1 ? "pledge" : "pledges"} checked</span>
            </Link>
          ))}
        </div>
      </main>
    </div>
  );
}
