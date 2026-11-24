import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

import { Empty, ErrorNote, FindingStatusBadge, Loading, RunStrip, Section, SeedCount, Seeds, VerdictBadge } from "../components/ui.tsx";
import { thousands, when } from "../format.ts";
import { overviewQuery } from "../queries.ts";
import type { Finding, Overview, Run } from "../types.ts";

export function RunRow({ run }: { run: Run }) {
  const state = run.phase === "failed" ? "failed" : run.phase === "done" ? run.verdict : "running";
  return (
    <Link to="/r/$repoId/runs/$runId" params={{ repoId: run.repoId, runId: run.id }} className={`grid grid-cols-1 items-center gap-x-5 gap-y-1.5 border-b border-line px-3 py-3.5 hover:bg-glass sm:grid-cols-[112px_minmax(0,1fr)_auto_84px] ${run.summary && run.summary.pledgesBroken > 0 ? "shadow-[inset_2px_0_0_var(--seal)]" : ""}`}>
      <span><VerdictBadge verdict={state} /></span>
      <span className="min-w-0">
        <span className="block truncate font-medium tracking-[-.01em]">{run.scenario ?? "first scan"} <span className="font-normal text-mute">{run.faults ? `under ${run.faults}` : run.phase === "done" ? "with no faults" : ""}</span></span>
        <span className="mt-0.5 block">{run.summary ? <RunStrip summary={run.summary} /> : <span className="font-mono text-xs text-mute">{run.failure ?? `in progress: ${run.phase}`}</span>}</span>
      </span>
      <Seeds marks={run.seedVerdicts} />
      <span className="font-mono text-[11.5px] text-mute sm:text-right">{when(run.createdAt)}</span>
    </Link>
  );
}

export function FindingRow({ finding }: { finding: Finding }) {
  return (
    <Link to="/r/$repoId/findings/$findingId" params={{ repoId: finding.repoId, findingId: finding.id }} className="grid grid-cols-1 items-center gap-x-5 gap-y-1.5 border-b border-line px-3 py-3.5 hover:bg-glass sm:grid-cols-[minmax(0,1fr)_auto_auto_84px]">
      <span className="min-w-0">
        <span className="block font-medium leading-snug tracking-[-.01em]">{finding.statement}</span>
        <span className="mt-1 block font-mono text-[11.5px] text-mute">{finding.pledgeKey}{finding.faults ? `, under ${finding.faults}` : ""}</span>
      </span>
      <SeedCount broken={finding.brokenSeeds.length} total={finding.totalSeeds} />
      <FindingStatusBadge status={finding.status} />
      <span className="font-mono text-[11.5px] text-mute sm:text-right">{when(finding.firstSeen)}</span>
    </Link>
  );
}

function Counter({ value, label, tone = "" }: { value: number; label: string; tone?: string }) {
  return (
    <div>
      <b className={`block font-mono text-2xl font-semibold leading-none tracking-[-.03em] tabular-nums ${tone || "text-[#F6F1EB]"}`}>{thousands(value)}</b>
      <span className="font-mono text-[11px] text-[#8E8781]">{label}</span>
    </div>
  );
}

function Headline({ data }: { data: Overview }) {
  const { headline, counters } = data;
  const state = headline.blocking > 0 ? "broken" : headline.broken.length === 0 && headline.approved > 0 ? "kept" : "inconclusive";
  const sentence =
    headline.blocking > 0
      ? `${headline.blocking} approved ${headline.blocking === 1 ? "pledge is" : "pledges are"} broken. A pull request check would fail.`
      : headline.broken.length > 0
        ? "Broken, but not approved yet, so nothing blocks. Review them under Findings."
        : headline.approved === 0
          ? "Nothing is broken, and no pledge is approved yet, so nothing can block. Approve the ones you rely on under Pledges."
          : `Held under ${thousands(counters.faultsInjected)} injected faults across ${thousands(counters.seedsRun)} seeds.`;
  return (
    <section className="texture ticks grid grid-cols-1 items-start gap-x-10 gap-y-7 rounded-md px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div>
        <VerdictBadge verdict={state} />
        <h1 className="mt-4 text-[clamp(26px,3.4vw,38px)] font-semibold leading-[1.08] tracking-[-.04em] text-[#F6F1EB]">
          {headline.kept} of {headline.total} pledges kept
        </h1>
        <p className="mt-3 max-w-[58ch] text-[15px] text-[#D9D4CE]">{sentence}</p>
        {headline.broken.length > 0 ? (
          <ul className="mt-3 space-y-1">
            {headline.broken.map((pledge) => (
              <li key={pledge.id} className="text-sm">
                <Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId: pledge.repoId, pledgeId: pledge.id }} className="text-[#F8A08C] underline underline-offset-[3px]">{pledge.statement}</Link>
              </li>
            ))}
          </ul>
        ) : null}
        {data.latestRun ? <div className="mt-5 border-t border-white/10 pt-4"><span className="font-mono text-[11px] text-[#8E8781]">Latest run, {when(data.latestRun.createdAt)}</span><RunStrip summary={data.latestRun.summary} dark /></div> : null}
      </div>
      <div className="grid grid-cols-2 gap-x-9 gap-y-5 self-center">
        <Counter value={counters.bugsCaught} label="bugs caught" tone={counters.bugsCaught > 0 ? "text-[#F47C62]" : ""} />
        <Counter value={counters.pullRequestsChecked} label="pull requests checked" />
        <Counter value={counters.faultsInjected} label="faults injected" />
        <Counter value={counters.approvedPledges} label="approved pledges" />
      </div>
    </section>
  );
}

function Trend({ trend }: { trend: Overview["trend"] }) {
  if (trend.length < 2) {
    return <p className="mt-4 text-sm text-ink-2">A trend needs runs in at least two different weeks. So far there {trend.length === 1 ? `is one week, ${trend[0]!.week}, with ${trend[0]!.kept} kept and ${trend[0]!.broken} broken pledge results` : "are none"}.</p>;
  }
  return (
    <div className="mt-5 h-52" role="img" aria-label={`Pledge results kept per week: ${trend.map((point) => `${point.week} ${point.kept} kept, ${point.broken} broken`).join("; ")}`}>
      <ResponsiveContainer>
        <LineChart data={trend} margin={{ top: 6, right: 12, bottom: 0, left: -18 }}>
          <CartesianGrid stroke="var(--line)" vertical={false} />
          <XAxis dataKey="week" tick={{ fontSize: 11, fill: "var(--mute)" }} stroke="var(--line)" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "var(--mute)" }} stroke="var(--line)" />
          <Tooltip contentStyle={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 3, fontSize: 12 }} />
          <Line type="monotone" dataKey="kept" stroke="var(--kept)" strokeWidth={2} dot={{ r: 3 }} name="kept" />
          <Line type="monotone" dataKey="broken" stroke="var(--seal)" strokeWidth={2} dot={{ r: 3 }} name="broken" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

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
  return (
    <>
      {data.runningRunId ? (
        <Link to="/r/$repoId/runs/$runId" params={{ repoId, runId: data.runningRunId }} className="mb-5 flex items-center gap-3 rounded-sm border border-line bg-card px-4 py-3 text-sm hover:border-mute">
          <span className="live-dot" /><span>A scan is running.</span><span className="ml-auto font-mono text-xs text-ink-2 underline underline-offset-[3px]">Watch it live</span>
        </Link>
      ) : null}
      {data.headline.total === 0 ? <Empty title="A scan is recorded, but no pledge has been checked yet." /> : <Headline data={data} />}
      <Section title="Trend" note="pledge results kept and broken per week, last 12 weeks"><Trend trend={data.trend} /></Section>
      <Section title="Latest findings" action={<Link to="/r/$repoId/findings" params={{ repoId }} className="text-ink-2 underline underline-offset-[3px]">all findings</Link>}>
        {data.latestFindings.length === 0 ? <p className="mt-4 text-sm text-ink-2">No pledge has broken in any scan of this repo.</p> : data.latestFindings.map((finding) => <FindingRow key={finding.id} finding={finding} />)}
      </Section>
      <Section title="Latest runs" action={<Link to="/r/$repoId/runs" params={{ repoId }} className="text-ink-2 underline underline-offset-[3px]">all runs</Link>}>
        {data.latestRuns.map((run) => <RunRow key={run.id} run={run} />)}
      </Section>
    </>
  );
}
