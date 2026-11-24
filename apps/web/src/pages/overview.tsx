import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowRight, CircleCheck, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Card, Empty, ErrorNote, FindingStatusBadge, Loading, PageTitle, RunStrip, SeedCount, Seeds, Stat, VerdictBadge } from "../components/ui.tsx";
import { runState, thousands, when } from "../format.ts";
import { overviewQuery } from "../queries.ts";
import type { Finding, Overview, Run } from "../types.ts";

const ROW = "grid grid-cols-1 items-center gap-x-5 gap-y-1.5 border-t border-line px-5 py-3 transition-colors hover:bg-paper-2/60";

export function RunRow({ run }: { run: Run }) {
  const state = runState(run);
  return (
    <Link to="/r/$repoId/runs/$runId" params={{ repoId: run.repoId, runId: run.id }} className={`${ROW} sm:grid-cols-[104px_minmax(0,1fr)_auto_72px]`}>
      <span><VerdictBadge verdict={state} /></span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium">{run.scenario ?? "First scan"} <span className="font-normal text-mute">{run.faults ? `under ${run.faults}` : run.phase === "done" ? "with no faults" : ""}</span></span>
        <span className="mt-0.5 block">{run.summary ? <RunStrip summary={run.summary} /> : <span className="text-[13px] text-mute">{run.failure ?? (state === "stalled" ? "Never reported an end. Its sandbox is gone." : `In progress: ${run.phase}`)}</span>}</span>
      </span>
      <Seeds marks={run.seedVerdicts} />
      <span className="text-xs text-mute sm:text-right">{when(run.createdAt)}</span>
    </Link>
  );
}

export function FindingRow({ finding }: { finding: Finding }) {
  return (
    <Link to="/r/$repoId/findings/$findingId" params={{ repoId: finding.repoId, findingId: finding.id }} className={`${ROW} sm:grid-cols-[minmax(0,1fr)_auto_auto_72px]`}>
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{finding.statement}</span>
        <span className="mt-1 block truncate font-mono text-xs text-mute">{finding.pledgeKey}{finding.faults ? ` · ${finding.faults}` : ""}</span>
      </span>
      <SeedCount broken={finding.brokenSeeds.length} total={finding.totalSeeds} />
      <FindingStatusBadge status={finding.status} />
      <span className="text-xs text-mute sm:text-right">{when(finding.firstSeen)}</span>
    </Link>
  );
}

/** One sentence on what to do next, in an alert the colour of the state. */
function Attention({ data }: { data: Overview }) {
  const { headline, counters } = data;
  const [Icon, tone, title, body]: [LucideIcon, "seal" | "amber" | "kept", string, string] =
    headline.blocking > 0
      ? [ShieldAlert, "seal", `${headline.blocking} approved ${headline.blocking === 1 ? "pledge is" : "pledges are"} broken`, "A pull request check would fail. Fix them or retire the pledge."]
      : headline.broken.length > 0
        ? [TriangleAlert, "seal", `${headline.broken.length} ${headline.broken.length === 1 ? "pledge breaks" : "pledges break"} under faults`, "None is approved yet, so nothing blocks a merge. Open the findings to see what went wrong."]
        : headline.approved === 0
          ? [TriangleAlert, "amber", "Nothing broke, and nothing is approved yet", "Approve the pledges you rely on so a pull request that breaks one fails its check."]
          : [CircleCheck, "kept", "Every approved pledge held", `Under ${thousands(counters.faultsInjected)} injected faults across ${thousands(counters.seedsRun)} seeds.`];
  const look = { seal: "border-seal/30 bg-seal-wash [&_svg]:text-seal", amber: "border-amber/30 bg-amber-wash [&_svg]:text-amber", kept: "border-kept/30 bg-kept-wash [&_svg]:text-kept" }[tone];
  return (
    <div role="status" className={`mt-6 flex items-start gap-3 rounded-xl border px-4 py-3.5 ${look}`}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-sm text-ink-2">{body}</p>
      </div>
      {headline.broken.length > 0 ? (
        <Link to="/r/$repoId/findings" params={{ repoId: data.repo.id }} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-card px-3 text-xs font-medium shadow-xs hover:bg-paper-2">
          Review findings <ArrowRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

function Trend({ trend }: { trend: Overview["trend"] }) {
  return (
    <div className="h-56 px-2 pb-4" role="img" aria-label={`Pledge results kept per week: ${trend.map((point) => `${point.week} ${point.kept} kept, ${point.broken} broken`).join("; ")}`}>
      <ResponsiveContainer>
        <LineChart data={trend} margin={{ top: 6, right: 16, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11, fill: "var(--mute)" }} stroke="var(--line)" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--mute)" }} stroke="var(--line)" />
          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 8, fontSize: 12 }} />
          <Line type="monotone" dataKey="kept" stroke="var(--kept)" strokeWidth={2} dot={{ r: 3 }} name="kept" />
          <Line type="monotone" dataKey="broken" stroke="var(--seal)" strokeWidth={2} dot={{ r: 3 }} name="broken" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

const ALL = "text-[13px] text-ink-2 hover:text-ink";

export function OverviewPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const overview = useQuery(overviewQuery(repoId));
  if (overview.isPending) return <Loading what="the overview" />;
  if (overview.isError) return <ErrorNote error={overview.error} retry={() => void overview.refetch()} />;
  const data = overview.data;

  if (data.latestRuns.length === 0) {
    return (
      <Empty title={`${data.repo.name} has not been scanned yet.`}>
        <p>Starting a scan from here needs the orchestrator, which is not built. Run the first scan from the command line: <code>pledge author &lt;repo&gt; --out &lt;dir&gt; --publish</code>.</p>
      </Empty>
    );
  }
  const { headline, counters, latestRun } = data;
  const live = data.latestRuns.find((run) => run.id === data.runningRunId);
  return (
    <>
      <PageTitle
        title={data.repo.name}
        lede={latestRun ? <>Last scan {when(latestRun.createdAt)}: {latestRun.scenario ?? "first scan"}{latestRun.faults ? <> under <span className="font-mono text-[13px]">{latestRun.faults}</span></> : null}</> : null}
        action={live && runState(live) === "running" ? (
          <Link to="/r/$repoId/runs/$runId" params={{ repoId, runId: live.id }} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-card px-3.5 text-sm font-medium shadow-xs hover:bg-paper-2">
            <span className="live-dot" /> Scan running <ArrowRight className="size-3.5" />
          </Link>
        ) : null}
      />
      {headline.total > 0 ? <Attention data={data} /> : null}

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Open findings" value={counters.openFindings} tone={counters.openFindings > 0 ? "seal" : undefined} hint={`${counters.bugsCaught} caught in total`} />
        <Stat label="Pledges kept" value={<>{headline.kept}<span className="text-lg text-mute">/{headline.total}</span></>} hint={`${counters.approvedPledges} approved`} />
        <Stat label="Faults injected" value={thousands(counters.faultsInjected)} hint={`across ${thousands(counters.seedsRun)} seeds`} />
        <Stat label="Pull requests checked" value={counters.pullRequestsChecked} hint="needs the GitHub App" />
      </div>

      <Card className="mt-6" title="Open findings" description="Pledges that broke in a scan, newest first" action={<Link to="/r/$repoId/findings" params={{ repoId }} className={ALL}>View all</Link>}>
        {data.latestFindings.length === 0 ? <p className="border-t border-line px-5 py-4 text-sm text-ink-2">No pledge has broken in any scan of this repo.</p> : data.latestFindings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
      </Card>

      <Card className="mt-6" title="Recent runs" description="One square per seed: green held, red broke" action={<Link to="/r/$repoId/runs" params={{ repoId }} className={ALL}>View all</Link>}>
        {data.latestRuns.map((run) => <RunRow key={run.id} run={run} />)}
      </Card>

      {data.trend.length >= 2 ? <Card className="mt-6" title="Trend" description="Pledge results kept and broken per week, last 12 weeks"><Trend trend={data.trend} /></Card> : null}
    </>
  );
}
