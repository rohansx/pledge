import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";

import { setToken } from "../api.ts";
import { meQuery, overviewQuery } from "../queries.ts";
import { Button, Mark } from "./ui.tsx";

export function toggleTheme(): void {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try {
    localStorage.setItem("pledge-theme", root.dataset.theme);
  } catch {
    // The choice then lasts for this page only.
  }
}

const TABS = [
  ["overview", "Overview"],
  ["findings", "Findings"],
  ["pledges", "Pledges"],
  ["coverage", "Coverage"],
  ["runs", "Runs"],
  ["settings", "Settings"],
] as const;

export function TopBar({ repoId }: { repoId?: string }) {
  const me = useQuery(meQuery());
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-2.5 border-b border-line bg-paper/80 px-3 backdrop-blur-md sm:gap-4 sm:px-6">
      <Link to="/repos" aria-label="Pledge, all repos" className="flex items-center gap-2 font-mono text-[15px] font-semibold tracking-[.02em]">
        <Mark />pledge
      </Link>
      {repoId && me.data ? (
        <label className="flex items-center gap-2">
          <span className="sr-only">Repo</span>
          <span aria-hidden="true" className="hidden text-mute sm:inline">/</span>
          <select
            value={repoId}
            onChange={(event) => void navigate({ to: "/r/$repoId/overview", params: { repoId: event.target.value } })}
            className="max-w-[30vw] rounded-sm border border-line bg-card py-1.5 pl-2.5 pr-7 text-sm font-medium sm:max-w-[46vw]"
          >
            {me.data.repos.map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
          </select>
        </label>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {me.data ? (
          <span className="hidden items-center gap-2 pr-1 sm:flex" title="One shared token until GitHub sign-in is set up">
            <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-sm bg-ink font-mono text-xs font-semibold text-paper">{me.data.user.name[0]}</span>
            <span className="text-[13px] text-ink-2">{me.data.user.name}</span>
          </span>
        ) : null}
        <Button onClick={toggleTheme}><span className="sr-only">Switch between light and dark</span><span aria-hidden="true" className="theme-sun">☀</span><span aria-hidden="true" className="theme-moon">☾</span></Button>
        <Button onClick={() => { setToken(null); void navigate({ to: "/login" }); }}>Sign out</Button>
      </div>
    </header>
  );
}

function Badge({ count, alert }: { count: number; alert: boolean }) {
  if (count === 0) return null;
  return <span className={`rounded-xs px-1.5 py-0.5 font-mono text-[11px] ${alert ? "bg-seal text-white" : "bg-amber-wash text-amber"}`}>{count}</span>;
}

/** The frame around every repo page: top bar, the six tabs, and the page. */
export function RepoShell() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const overview = useQuery(overviewQuery(repoId));
  const open = overview.data?.counters.openFindings ?? 0;
  const review = overview.data?.counters.awaitingReview ?? 0;
  return (
    <div className="min-h-screen">
      <TopBar repoId={repoId} />
      <div className="mx-auto grid max-w-[1320px] grid-cols-1 md:grid-cols-[208px_minmax(0,1fr)]">
        <nav aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 md:sticky md:top-14 md:block md:h-[calc(100vh-3.5rem)] md:space-y-px md:border-b-0 md:border-r md:px-3 md:py-5">
          {TABS.map(([path, label]) => (
            <Link
              key={path}
              to={`/r/$repoId/${path}`}
              params={{ repoId }}
              className="flex shrink-0 items-center justify-between gap-2 rounded-sm px-3 py-2 text-sm text-ink-2 hover:bg-glass hover:text-ink"
              activeProps={{ className: "bg-card font-medium !text-ink shadow-[inset_0_0_0_1px_var(--line)]", "aria-current": "page" }}
            >
              {label}
              {path === "findings" ? <Badge count={open} alert /> : null}
              {path === "pledges" ? <Badge count={review} alert={false} /> : null}
            </Link>
          ))}
        </nav>
        <main className="min-w-0 px-4 pb-24 pt-8 sm:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
