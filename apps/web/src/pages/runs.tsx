import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { streamRun } from "../api.ts";
import { Empty, ErrorNote, ExpectedActual, Loading, PageTitle, PledgeStatusBadge, RunStrip, Section, Seeds, VerdictBadge } from "../components/ui.tsx";
import { plain, seconds, thousands, when } from "../format.ts";
import { commentQuery, runQuery, runsQuery } from "../queries.ts";
import type { RunDetail, RunEvent } from "../types.ts";
import { RunRow } from "./overview.tsx";

export function RunsPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const runs = useQuery(runsQuery(repoId));
  return (
    <>
      <PageTitle title="Runs" lede="Every scan of this repo. A run boots the app once in a sandbox, forks it per seed, and runs each fork under the fault plan." />
      {runs.isPending ? <Loading what="runs" /> : null}
      {runs.isError ? <ErrorNote error={runs.error} retry={() => void runs.refetch()} /> : null}
      {runs.data?.length === 0 ? <Empty title="No run yet."><p>Start one with <code>pledge scan &lt;app&gt; --scenario &lt;name&gt; --faults &lt;file&gt; --publish</code>.</p></Empty> : null}
      {runs.data && runs.data.length > 0 ? <div className="mt-6 border-t border-line">{runs.data.map((run) => <RunRow key={run.id} run={run} />)}</div> : null}
    </>
  );
}

/** Follow a run's event stream from the start. If it drops while the run is live, refetch and reconnect. */
function useRunEvents(runId: string): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const client = useQueryClient();
  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    setEvents([]);
    void (async () => {
      while (!controller.signal.aborted) {
        const finished = await streamRun(runId, cursor, (event) => { cursor = event.seq; setEvents((seen) => [...seen, event]); }, controller.signal).catch(() => false);
        if (controller.signal.aborted) return;
        await client.invalidateQueries({ queryKey: ["run", runId] });
        const run = client.getQueryData<RunDetail>(["run", runId]);
        if (finished || !run || run.phase === "done" || run.phase === "failed") {
          void client.invalidateQueries({ queryKey: ["repo"] });
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    })();
    return () => controller.abort();
  }, [runId, client]);
  return events;
}

const PHASES = [
  ["boot", "Boot", "Install what the app needs and get it answering behind the fault proxy."],
  ["author", "Author", "Write scenarios and propose pledges from the code."],
  ["prove", "Prove", "Plant a bug per pledge to show the pledge can break."],
  ["run", "Run", "Run every seed under the fault plan and count."],
  ["verdict", "Verdict", "Which pledges held."],
] as const;

/** The five phases of a scan, with what has happened in each so far. */
function PhaseProgress({ run, events }: { run: RunDetail; events: RunEvent[] }) {
  const started = new Set(events.filter((event) => event.type === "phase_started").map((event) => String(event.data.phase)));
  const current = run.phase === "done" ? "verdict" : run.phase === "failed" ? "failed" : run.phase;
  const order = PHASES.map(([name]) => name as string);
  const steps = (phase: string) => events.filter((event) => event.type === "phase_step" && event.data.phase === phase);
  const proposed = events.filter((event) => event.type === "pledge_proposed");
  const seeds = events.filter((event) => event.type === "seed_finished");

  return (
    <ol className="mt-5 border-t border-line">
      {PHASES.map(([name, label, what]) => {
        const reached = started.has(name) || (name === "verdict" && run.phase === "done");
        const live = current === name;
        const passed = order.indexOf(name) < order.indexOf(current) || run.phase === "done";
        const skipped = !reached && passed;
        return (
          <li key={name} className={`grid grid-cols-[92px_minmax(0,1fr)] gap-4 border-b border-line px-3 py-4 ${live ? "bg-card" : ""}`}>
            <span className="flex items-start gap-2 pt-0.5 font-mono text-xs">
              {live && run.phase !== "done" ? <span className="live-dot mt-1" /> : <span className={`mt-1 h-2 w-2 rounded-full ${reached ? "bg-kept" : "bg-idle"}`} />}
              <span className={reached || live ? "font-medium text-ink" : "text-mute"}>{label}</span>
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-ink-2">{skipped ? (name === "prove" ? "Skipped: the prove step is not built yet, so no pledge is proven." : "Not part of this run.") : what}</p>
              {(name === "boot" || name === "author") && steps(name).length > 0 ? (
                <details className="mt-2" open={live}>
                  <summary className="font-mono text-xs text-mute">{steps(name).length} steps</summary>
                  <ul className="mt-1.5 max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11.5px] text-ink-2">
                    {steps(name).map((event) => <li key={event.seq} className={`truncate ${event.data.ok === false ? "text-seal" : ""}`}>{String(event.data.label)}</li>)}
                  </ul>
                </details>
              ) : null}
              {name === "author" && proposed.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {proposed.map((event) => <li key={event.seq} className="flex gap-2"><PledgeStatusBadge status="proposed" /><span>{String(event.data.statement)}</span></li>)}
                </ul>
              ) : null}
              {name === "run" && (seeds.length > 0 || live) ? (
                <p className="mt-2 font-mono text-xs text-ink-2">
                  {seeds.length} of {run.seedsPlanned ?? "?"} seeds finished. Checks kept so far: {seeds.reduce((sum, event) => sum + Number(event.data.kept ?? 0), 0)}, broken: <b className="font-medium text-seal">{seeds.reduce((sum, event) => sum + Number(event.data.broken ?? 0), 0)}</b>
                </p>
              ) : null}
              {name === "verdict" && run.phase === "done" ? <div className="mt-2"><RunStrip summary={run.summary} /></div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Comment({ runId }: { runId: string }) {
  const comment = useQuery(commentQuery(runId));
  if (!comment.data) return null;
  return <pre className="mt-4 overflow-x-auto whitespace-pre-wrap rounded-sm border border-line bg-card p-4 font-mono text-xs leading-relaxed">{comment.data.markdown}</pre>;
}

export function RunPage() {
  const { repoId, runId } = useParams({ strict: false }) as { repoId: string; runId: string };
  const query = useQuery(runQuery(runId));
  const events = useRunEvents(runId);
  if (query.isPending) return <Loading what="the run" />;
  if (query.isError) return <ErrorNote error={query.error} retry={() => void query.refetch()} />;
  const run = query.data;
  const running = run.phase !== "done" && run.phase !== "failed";
  const facts: [string, string][] = [["trigger", run.trigger.replace("_", " ")], ["started", when(run.createdAt)]];
  if (run.commit) facts.push(["commit", run.commit.slice(0, 7)]);
  if (run.durationSeconds !== null) facts.push(["took", seconds(run.durationSeconds)]);
  if (run.sandbox) facts.push(["outbound network", run.sandbox.outbound_blocked ? "closed" : "open"]);
  for (const [name, value] of Object.entries(run.env)) facts.push([name, value]);

  return (
    <>
      <Link to="/r/$repoId/runs" params={{ repoId }} className="mb-4 block w-fit font-mono text-xs text-mute hover:text-ink">← All runs</Link>
      <section className="texture ticks rounded-md px-6 py-7 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge verdict={run.phase === "failed" ? "failed" : running ? "running" : run.verdict} />
          {running ? <span className="flex items-center gap-2 font-mono text-xs text-[#D9D4CE]"><span className="live-dot" />live</span> : null}
          <span className="ml-auto"><Seeds marks={run.seedVerdicts} large dark /></span>
        </div>
        <h1 className="mt-4 text-[clamp(24px,3.2vw,36px)] font-semibold leading-[1.08] tracking-[-.04em] text-[#F6F1EB]">
          {run.scenario ?? "First scan"} <span className="font-normal text-[#8E8781]">{run.faults ? `under ${run.faults}` : running ? "" : "with no faults"}</span>
        </h1>
        {run.failure ? <p className="mt-3 text-[15px] text-[#F8A08C]">This run stopped: {run.failure}</p> : null}
        <div className="mt-3"><RunStrip summary={run.summary} dark /></div>
        <p className="mt-5 flex flex-wrap gap-x-7 gap-y-2 border-t border-white/10 pt-4 font-mono text-[11.5px] text-[#8E8781]">
          {facts.map(([name, value]) => <span key={name}>{name} <b className="font-medium text-[#E4DED8]">{value}</b></span>)}
        </p>
      </section>

      <Section title={running ? "Live progress" : "How the run went"} note={running ? "updates as the run works" : undefined}><PhaseProgress run={run} events={events} /></Section>

      {run.results.length > 0 ? (
        <Section title="Pledges" note="results over this run's seeds">
          {run.results.map((result) => (
            <details key={result.pledgeId} className={`border-b border-line ${result.result === "broken" ? "bg-seal-wash shadow-[inset_2px_0_0_var(--seal)]" : ""}`} open={result.result === "broken"}>
              <summary className="grid grid-cols-1 items-center gap-x-5 gap-y-2 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_auto_110px]">
                <span className="min-w-0">
                  <span className="block text-[15.5px] font-medium leading-snug tracking-[-.01em]">{result.statement}</span>
                  <span className="mt-1.5 flex items-center gap-3 font-mono text-[11.5px] text-mute"><PledgeStatusBadge status={result.status} /><Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId, pledgeId: result.pledgeId }} className="underline underline-offset-[3px]">open the pledge</Link></span>
                </span>
                <Seeds marks={result.seeds.map((seed) => seed.status)} />
                <span className={`font-mono text-xs sm:text-right ${result.result === "broken" ? "font-semibold text-seal" : result.result === "kept" ? "text-kept" : "text-ink-2"}`}>{result.result === "broken" ? `broken ${result.broken} of ${result.seeds.length}` : result.result}</span>
              </summary>
              <div className="px-3 pb-5"><ExpectedActual seeds={result.seeds} /></div>
            </details>
          ))}
        </Section>
      ) : null}

      {run.phase === "done" ? (
        <Section title="Fault plan" note={run.faultPlan ? "the same faults on every seed; the seed picks which requests they hit" : undefined}>
          {run.faultPlan ? (
            <div className="mt-4 grid grid-cols-1 overflow-hidden rounded-md border border-line md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="bg-paper-2 p-6 text-[14.5px] text-ink-2"><b className="mb-2 block font-mono text-[13px] font-medium text-ink">{run.faultPlan.name}</b>{run.faultPlan.description || "No description."}</div>
              <pre className="texture overflow-x-auto border-0 px-5 py-5 font-mono text-[12.5px] leading-[1.8] text-[#CFC9C3]">{JSON.stringify(run.faultPlan.faults, null, 2)}</pre>
            </div>
          ) : <p className="mt-4 text-sm text-ink-2">None. This was a baseline: the scenario ran with no faults injected.</p>}
        </Section>
      ) : null}

      {run.seedRuns.length > 0 ? (
        <Section title="Seeds" note="one sandbox fork each">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12.5px]">
              <thead><tr className="text-left text-mute [&>th]:border-b [&>th]:border-line [&>th]:py-2.5 [&>th]:pr-4 [&>th]:font-medium"><th>Seed</th><th>Engine verdict</th><th className="text-right">Requests</th><th className="text-right">Faults injected</th><th>Run directory</th><th>Limitations</th></tr></thead>
              <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:py-2.5 [&_td]:pr-4 [&_td]:align-top">
                {run.seedRuns.map((seed) => (
                  <tr key={seed.seed}>
                    <td>{seed.seed}</td>
                    <td className={seed.verdict === "fail" ? "text-seal" : seed.verdict === "pass" ? "text-kept" : ""}>{seed.verdict}</td>
                    <td className="text-right tabular-nums">{thousands(seed.requests)}</td>
                    <td className="text-right tabular-nums">{seed.faults_injected}</td>
                    <td>{seed.run_id}</td>
                    <td>{seed.limitations.join("; ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 max-w-[70ch] font-mono text-[11.5px] text-mute">Logs and the standalone report stay in each run directory on the machine that ran the scan. Storing them here is not built yet.</p>
        </Section>
      ) : null}

      {run.authoring ? (
        <Section title="Written by Claude" note={`scenario, pledges and faults authored in ${seconds(run.authoring.seconds)}; checks in the sandbox accepted each phase`}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse font-mono text-[12.5px]">
              <thead><tr className="text-left text-mute [&>th]:border-b [&>th]:border-line [&>th]:py-2.5 [&>th]:pr-4 [&>th]:font-medium"><th>Phase</th><th>Model</th><th className="text-right">Requests</th><th className="text-right">Tokens</th><th className="text-right">From cache</th><th className="text-right">Commands</th><th className="text-right">Time</th></tr></thead>
              <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:py-2.5 [&_td]:pr-4">
                {run.authoring.phases.map((phase) => <tr key={phase.phase}><td>{phase.phase}</td><td>{phase.model}</td><td className="text-right">{phase.requests}</td><td className="text-right">{thousands(phase.tokens)}</td><td className="text-right">{thousands(phase.cache_read_tokens)}</td><td className="text-right">{phase.commands}</td><td className="text-right">{seconds(phase.seconds)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-[72ch] whitespace-pre-wrap text-ink-2">{plain(run.authoring.summary)}</p>
          {run.authoring.open_questions.length > 0 ? <ul className="mt-4 max-w-[72ch] list-disc space-y-1.5 pl-5 text-ink-2">{run.authoring.open_questions.map((question, index) => <li key={index}>{plain(question)}</li>)}</ul> : null}
        </Section>
      ) : null}

      {run.phase === "done" ? <Section title="Pull request comment" note="what this run would post; pull request checks need the GitHub App, which is not set up"><Comment runId={run.id} /></Section> : null}
    </>
  );
}
