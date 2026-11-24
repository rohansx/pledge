import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { streamRun } from "../api.ts";
import { Empty, ErrorNote, ExpectedActual, Loading, PageTitle, PledgeStatusBadge, RunStrip, Section, Seeds, TABLE, VerdictBadge } from "../components/ui.tsx";
import { plain, runState, seconds, thousands, when } from "../format.ts";
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
      {runs.data && runs.data.length > 0 ? <div className="mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-xs [&>a:first-child]:border-t-0">{runs.data.map((run) => <RunRow key={run.id} run={run} />)}</div> : null}
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
    <ol className="-mx-5 -mb-5">
      {PHASES.map(([name, label, what]) => {
        const reached = started.has(name) || (name === "verdict" && run.phase === "done");
        const live = current === name;
        const passed = order.indexOf(name) < order.indexOf(current) || run.phase === "done";
        const skipped = !reached && passed;
        if (skipped) return null; // a phase this run did not use (the prove step is not built) is left out, not explained
        return (
          <li key={name} className={`grid grid-cols-[92px_minmax(0,1fr)] gap-4 border-t border-line px-5 py-3.5 ${live ? "bg-paper-2/60" : ""}`}>
            <span className="flex items-start gap-2 pt-0.5 text-[13px]">
              {live && run.phase !== "done" ? <span className="live-dot mt-1" /> : <span className={`mt-1 h-2 w-2 rounded-full ${reached ? "bg-kept" : "bg-idle"}`} />}
              <span className={reached || live ? "font-medium text-ink" : "text-mute"}>{label}</span>
            </span>
            <div className="min-w-0 text-sm">
              <p className="text-ink-2">{what}</p>
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
  return <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-line bg-paper-2/60 p-4 font-mono text-xs leading-relaxed">{comment.data.markdown}</pre>;
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
      <Link to="/r/$repoId/runs" params={{ repoId }} className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">← Runs</Link>
      <section className="rounded-xl border border-line bg-card px-5 py-5 shadow-xs sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <VerdictBadge verdict={runState(run)} />
          <span className="ml-auto"><Seeds marks={run.seedVerdicts} large /></span>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-.03em]">
          {run.scenario ?? "First scan"} <span className="font-normal text-mute">{run.faults ? <>under <span className="font-mono text-xl">{run.faults}</span></> : running ? "" : "with no faults"}</span>
        </h1>
        {run.failure ? <p className="mt-2 text-sm text-seal">This run stopped: {run.failure}</p> : null}
        <div className="mt-2"><RunStrip summary={run.summary} /></div>
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 border-t border-line pt-4 text-[13px]">
          {facts.map(([name, value]) => <div key={name}><dt className="text-xs capitalize text-mute">{name}</dt><dd className="font-medium">{value}</dd></div>)}
        </dl>
      </section>

      <Section title={running ? "Live progress" : "How the run went"} note={running ? "updates as the run works" : undefined}><PhaseProgress run={run} events={events} /></Section>

      {run.results.length > 0 ? (
        <Section title="Pledges" note="results over this run's seeds">
          {run.results.map((result) => (
            <details key={result.pledgeId} className={`-mx-5 border-t border-line ${result.result === "broken" ? "shadow-[inset_2px_0_0_var(--seal)]" : ""}`} open={result.result === "broken"}>
              <summary className="grid grid-cols-1 items-center gap-x-5 gap-y-2 px-5 py-3.5 hover:bg-paper-2/60 sm:grid-cols-[minmax(0,1fr)_auto_110px]">
                <span className="min-w-0">
                  <span className="line-clamp-2 text-sm font-medium leading-snug">{result.statement}</span>
                  <span className="mt-1.5 flex items-center gap-3 text-xs text-mute"><PledgeStatusBadge status={result.status} /><Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId, pledgeId: result.pledgeId }} className="underline underline-offset-[3px]">open the pledge</Link></span>
                </span>
                <Seeds marks={result.seeds.map((seed) => seed.status)} />
                <span className={`text-xs sm:text-right ${result.result === "broken" ? "font-semibold text-seal" : result.result === "kept" ? "text-kept" : "text-ink-2"}`}>{result.result === "broken" ? `broken ${result.broken} of ${result.seeds.length}` : result.result}</span>
              </summary>
              <div className="border-t border-line bg-paper-2/40"><ExpectedActual seeds={result.seeds} /></div>
            </details>
          ))}
        </Section>
      ) : null}

      {run.phase === "done" ? (
        <Section title="Fault plan" note={run.faultPlan ? "the same faults on every seed; the seed picks which requests they hit" : undefined}>
          {run.faultPlan ? (
            <div className="grid grid-cols-1 overflow-hidden rounded-lg border border-line md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
              <div className="p-5 text-sm text-ink-2"><b className="mb-2 block font-mono text-[13px] font-medium text-ink">{run.faultPlan.name}</b>{run.faultPlan.description || "No description."}</div>
              <pre className="overflow-x-auto border-t border-line bg-paper-2/60 px-5 py-5 font-mono text-xs leading-[1.8] md:border-l md:border-t-0">{JSON.stringify(run.faultPlan.faults, null, 2)}</pre>
            </div>
          ) : <p className="mt-4 text-sm text-ink-2">None. This was a baseline: the scenario ran with no faults injected.</p>}
        </Section>
      ) : null}

      {run.seedRuns.length > 0 ? (
        <Section title="Seeds" note="one sandbox fork each">
          <div className="-mx-5 overflow-x-auto border-t border-line">
            <table className={TABLE}>
              <thead><tr><th>Seed</th><th>Engine verdict</th><th className="text-right">Requests</th><th className="text-right">Faults injected</th><th>Run directory</th><th>Limitations</th></tr></thead>
              <tbody>
                {run.seedRuns.map((seed) => (
                  <tr key={seed.seed}>
                    <td>{seed.seed}</td>
                    <td className={seed.verdict === "fail" ? "text-seal" : seed.verdict === "pass" ? "text-kept" : ""}>{seed.verdict}</td>
                    <td className="text-right tabular-nums">{thousands(seed.requests)}</td>
                    <td className="text-right tabular-nums">{seed.faults_injected}</td>
                    <td className="font-mono text-xs">{seed.run_id}</td>
                    <td className="min-w-[280px] text-xs text-ink-2">{seed.limitations.join("; ") || "none"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}

      {run.authoring ? (
        <Section title="Written by Claude" note={`scenario, pledges and faults authored in ${seconds(run.authoring.seconds)}; checks in the sandbox accepted each phase`}>
          <div className="-mx-5 overflow-x-auto border-t border-line">
            <table className={TABLE}>
              <thead><tr><th>Phase</th><th>Model</th><th className="text-right">Requests</th><th className="text-right">Tokens</th><th className="text-right">From cache</th><th className="text-right">Commands</th><th className="text-right">Time</th></tr></thead>
              <tbody>
                {run.authoring.phases.map((phase) => <tr key={phase.phase}><td>{phase.phase}</td><td>{phase.model}</td><td className="text-right">{phase.requests}</td><td className="text-right">{thousands(phase.tokens)}</td><td className="text-right">{thousands(phase.cache_read_tokens)}</td><td className="text-right">{phase.commands}</td><td className="text-right">{seconds(phase.seconds)}</td></tr>)}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-[72ch] whitespace-pre-wrap text-ink-2">{plain(run.authoring.summary)}</p>
          {run.authoring.open_questions.length > 0 ? <ul className="mt-4 max-w-[72ch] list-disc space-y-1.5 pl-5 text-ink-2">{run.authoring.open_questions.map((question, index) => <li key={index}>{plain(question)}</li>)}</ul> : null}
        </Section>
      ) : null}

      {run.phase === "done" ? <Section title="Pull request comment" note="A preview of what this run would post on a pull request"><Comment runId={run.id} /></Section> : null}
    </>
  );
}
