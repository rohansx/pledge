import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import { Bug, ChevronsUpDown, FileCheck2, LayoutDashboard, LogOut, Moon, Play, Settings, Sun } from "lucide-react";

import { setToken } from "../api.ts";
import { meQuery, overviewQuery } from "../queries.ts";
import { Button, Wordmark } from "./ui.tsx";

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
  ["overview", "Overview", LayoutDashboard],
  ["findings", "Findings", Bug],
  ["pledges", "Pledges", FileCheck2],
  ["runs", "Runs", Play],
  ["settings", "Settings", Settings],
] as const;

function ThemeButton() {
  return (
    <Button size="icon" variant="ghost" label="Switch between light and dark" onClick={toggleTheme}>
      <Sun className="theme-sun size-4" /><Moon className="theme-moon size-4" />
    </Button>
  );
}

function Account() {
  const me = useQuery(meQuery());
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2">
      {me.data ? (
        <span className="flex min-w-0 flex-1 items-center gap-2" title="One shared token until GitHub sign-in is set up">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-md bg-ink text-xs font-semibold text-paper">{me.data.user.name[0]}</span>
          <span className="truncate text-[13px] font-medium">{me.data.user.name}</span>
        </span>
      ) : <span className="flex-1" />}
      <ThemeButton />
      <Button size="icon" variant="ghost" label="Sign out" onClick={() => { setToken(null); void navigate({ to: "/login" }); }}><LogOut className="size-4" /></Button>
    </div>
  );
}

/** The bar on pages outside a repo: the repo list. */
export function TopBar() {
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-line bg-paper/80 px-4 backdrop-blur-md sm:px-6">
      <Link to="/repos" aria-label="Pledge, all repos"><Wordmark /></Link>
      <div className="ml-auto w-64"><Account /></div>
    </header>
  );
}

function RepoSwitcher({ repoId }: { repoId: string }) {
  const me = useQuery(meQuery());
  const navigate = useNavigate();
  return (
    <label className="relative block">
      <span className="sr-only">Repo</span>
      <span aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md bg-ink text-paper text-[11px] font-semibold uppercase">{repoId[0]}</span>
      <select
        value={repoId}
        onChange={(event) => void navigate({ to: "/r/$repoId/overview", params: { repoId: event.target.value } })}
        className="h-11 w-full appearance-none rounded-lg border border-line bg-card pl-11 pr-8 text-sm font-medium shadow-xs hover:bg-paper-2"
      >
        {(me.data?.repos ?? [{ id: repoId, name: repoId }]).map((repo) => <option key={repo.id} value={repo.id}>{repo.name}</option>)}
      </select>
      <ChevronsUpDown aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-mute" />
    </label>
  );
}

function Count({ count, alert }: { count: number; alert: boolean }) {
  if (count === 0) return null;
  return <span className={`ml-auto rounded-md px-1.5 text-xs font-medium leading-5 tabular-nums ${alert ? "bg-seal text-white" : "bg-amber-wash text-amber"}`}>{count}</span>;
}

/** The frame around every repo page: the sidebar and the page. */
export function RepoShell() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const overview = useQuery(overviewQuery(repoId));
  const open = overview.data?.counters.openFindings ?? 0;
  const review = overview.data?.counters.awaitingReview ?? 0;
  return (
    <div className="min-h-screen md:grid md:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="z-30 flex flex-col gap-4 border-b border-line bg-paper-2/60 p-3 md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r">
        <div className="flex items-center justify-between px-2 pt-1 md:pb-1">
          <Link to="/repos" aria-label="Pledge, all repos"><Wordmark /></Link>
          <span className="md:hidden"><ThemeButton /></span>
        </div>
        <RepoSwitcher repoId={repoId} />
        <nav aria-label="Sections" className="-mx-1 flex gap-0.5 overflow-x-auto px-1 md:mx-0 md:flex-col md:px-0">
          <p className="hidden px-2.5 pb-1 pt-2 text-xs font-medium text-mute md:block">Repo</p>
          {TABS.map(([path, label, Icon]) => (
            <Link
              key={path}
              to={`/r/$repoId/${path}`}
              params={{ repoId }}
              className="flex h-9 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-sm text-ink-2 hover:bg-card hover:text-ink"
              activeProps={{ className: "bg-card font-medium !text-ink shadow-xs ring-1 ring-line", "aria-current": "page" }}
            >
              <Icon className="size-4" />
              {label}
              {path === "findings" ? <Count count={open} alert /> : null}
              {path === "pledges" ? <Count count={review} alert={false} /> : null}
            </Link>
          ))}
        </nav>
        <div className="mt-auto hidden border-t border-line pt-3 md:block"><Account /></div>
      </aside>
      <main className="mx-auto w-full min-w-0 max-w-[1180px] px-4 pb-24 pt-6 sm:px-8 sm:pt-8">
        <Outlet />
      </main>
    </div>
  );
}
