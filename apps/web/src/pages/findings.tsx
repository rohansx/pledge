import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowLeft, Bot, Check, ExternalLink } from "lucide-react";
import { useState } from "react";

import { Button, Card, CopyCommand, Empty, ErrorNote, ExpectedActual, FindingStatusBadge, Loading, PageTitle, PledgeStatusBadge, RunStrip, Seeds, SeverityBadge } from "../components/ui.tsx";
import { BrowserRecording } from "../components/browser-recording.tsx";
import { Recording } from "../components/recording.tsx";
import { fieldName, harmFigures, impact, title, when } from "../format.ts";
import { findingQuery, findingsQuery, useSetFindingStatus } from "../queries.ts";
import type { FindingDetail } from "../types.ts";
import { FindingRow } from "./overview.tsx";

const FILTERS = [
  [undefined, "All"],
  ["open", "Open"],
  ["fixed_unverified", "Fixed, not verified"],
  ["verified", "Verified"],
  ["reopened", "Reopened"],
] as const;

/** shadcn's segmented tabs, used as a status filter. */
export function Chips<T extends string | undefined>({ options, value, onChange, label }: { options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="mt-5 inline-flex max-w-full flex-wrap gap-0.5 rounded-lg bg-paper-2 p-1">
      {options.map(([option, text]) => (
        <button key={text} type="button" aria-pressed={option === value} onClick={() => onChange(option)} className={`h-7 rounded-md px-3 text-[13px] font-medium transition-colors ${option === value ? "bg-card text-ink shadow-xs" : "text-ink-2 hover:text-ink"}`}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function FindingsPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const { status } = useSearch({ strict: false }) as { status?: string };
  const navigate = useNavigate();
  const findings = useQuery(findingsQuery(repoId, status));
  return (
    <>
      <PageTitle title="Findings" lede="Every pledge that broke in a scan. A finding stays until a later run, under the same faults, keeps the pledge on every seed." />
      <Chips label="Filter by status" options={FILTERS} value={status as (typeof FILTERS)[number][0]} onChange={(next) => void navigate({ to: "/r/$repoId/findings", params: { repoId }, search: next ? { status: next } : {} })} />
      {findings.isPending ? <Loading what="findings" /> : null}
      {findings.isError ? <ErrorNote error={findings.error} retry={() => void findings.refetch()} /> : null}
      {findings.data?.length === 0 ? (
        <Empty title={status ? "No finding has that status." : "No pledge has broken in any scan of this repo."}>
          {status ? null : <p>That covers only the faults those scans injected. A scan under a different fault plan may find something.</p>}
        </Empty>
      ) : null}
      {findings.data && findings.data.length > 0 ? (
        <Card className="mt-4">
          <div className="-mt-px">{findings.data.map((finding) => <FindingRow key={finding.id} finding={finding} />)}</div>
        </Card>
      ) : null}
    </>
  );
}

function agentPrompt(finding: FindingDetail): string {
  return [
    `A Pledge scan found that this must-hold statement about the data is broken:`,
    `"${finding.statement}"`,
    ``,
    `It broke on ${finding.brokenSeeds.length} of ${finding.totalSeeds} seeds${finding.faultPlan ? ` under this fault: ${finding.faultPlan.description}` : ""}.`,
    `Expected: ${JSON.stringify(finding.expected)}`,
    `Actual: ${JSON.stringify(finding.actual)}`,
    ``,
    `Reproduce it from the repo root with: ${finding.replayCommand}`,
    `Find the cause and fix it so the statement holds when requests are retried, duplicated or delayed. Do not change the pledge or the scenario.`,
  ].join("\n");
}

/** The rail: where the finding stands and what to do with it. */
function Rail({ finding }: { finding: FindingDetail }) {
  const mutation = useSetFindingStatus(finding.repoId, finding.id);
  const [copied, setCopied] = useState(false);
  const set = (status: "open" | "fix_proposed" | "fixed_unverified") => mutation.mutate(status);
  const busy = mutation.isPending;
  return (
    <div className="space-y-4 lg:sticky lg:top-8">
      <Card title="Status">
        <div className="space-y-4 border-t border-line px-5 py-4">
          <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-y-2.5 text-[13px] [&_dt]:text-mute">
            <dt>Finding</dt><dd><FindingStatusBadge status={finding.status} /></dd>
            <dt>Pledge</dt><dd className="flex flex-wrap items-center gap-2"><PledgeStatusBadge status={finding.pledgeStatus ?? "proposed"} />{finding.blocks ? <span className="text-seal">blocks merges</span> : <span className="text-mute">does not block</span>}</dd>
            <dt>Seeds</dt><dd className="flex items-center gap-2"><Seeds marks={finding.seeds.map((seed) => seed.status)} /><span className="tabular-nums">{finding.brokenSeeds.length}/{finding.totalSeeds}</span></dd>
            <dt>First seen</dt><dd>{when(finding.firstSeen)}</dd>
          </dl>
          {finding.status === "verified" ? (
            <p className="text-[13px] text-ink-2">Verified by a later run. It changes only if a run breaks the pledge again.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {finding.status !== "fixed_unverified" ? <Button variant="default" disabled={busy} onClick={() => set("fixed_unverified")} className="justify-center"><Check className="size-4" />Mark fixed</Button> : null}
              {finding.status !== "fix_proposed" ? <Button disabled={busy} onClick={() => set("fix_proposed")} className="justify-center">Mark fix proposed</Button> : null}
              {finding.status !== "open" && finding.status !== "reopened" ? <Button variant="ghost" disabled={busy} onClick={() => set("open")} className="justify-center">Back to open</Button> : null}
            </div>
          )}
          {mutation.isError ? <ErrorNote error={mutation.error} /> : null}
          <p className="text-xs leading-relaxed text-mute">Marking it fixed does not close it. A later scan that keeps the pledge on every seed under the same faults verifies it.</p>
        </div>
      </Card>
      <Card title="Reproduce">
        <div className="space-y-3 border-t border-line px-5 py-4">
          <CopyCommand label="Run one breaking seed again" command={finding.replayCommand} />
          <Button className="w-full justify-center" onClick={() => void navigator.clipboard?.writeText(agentPrompt(finding)).then(() => setCopied(true))}>
            {copied ? <Check className="size-4 text-kept" /> : <Bot className="size-4" />}{copied ? "Prompt copied" : "Copy prompt for a coding agent"}
          </Button>
        </div>
      </Card>
    </div>
  );
}

/** The damage in the app's own numbers, large, before any table. */
function Impact({ finding }: { finding: FindingDetail }) {
  const rows = impact(finding.seeds);
  const figures = harmFigures(finding.harm, finding.severity);
  if (rows.length === 0 && figures.length === 0) return null;
  const seed = finding.seeds.find((candidate) => candidate.status === "fail" && candidate.actual !== undefined);
  return (
    <Card tone="seal" title="What went wrong" description={figures.length > 0 ? "Counted from every journey the check read, on every run that broke it" : `Read from the app's own data after seed ${seed?.seed} finished`}>
      {figures.length > 0 ? (
        <div className="grid grid-cols-1 gap-px border-t border-seal/20 bg-seal/15 sm:grid-cols-2">
          {figures.map((figure) => (
            <div key={figure.label} className="bg-card px-5 py-5">
              <p className="text-4xl font-semibold tracking-[-.03em] text-seal tabular-nums">{figure.value}</p>
              <p className="mt-1 text-[13px] text-ink-2">{figure.label}</p>
            </div>
          ))}
        </div>
      ) : null}
      {rows.length > 0 ? <p className="border-t border-seal/20 px-5 pt-3 text-xs text-mute">{figures.length > 0 ? `One broken journey, seed ${seed?.seed}:` : null}</p> : null}
      <div className="grid grid-cols-1 gap-px border-t border-seal/20 bg-seal/15 sm:grid-cols-2">
        {rows.slice(0, 4).map((row) => (
          <div key={row.key} className="bg-card px-5 py-4">
            <p className="text-[13px] text-ink-2 first-letter:uppercase">{fieldName(row.key) || "value"}</p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-[-.03em] text-seal tabular-nums">{row.actual === "null" ? "none" : row.actual}</span>
              <span className="text-[13px] text-mute">expected {row.expected}</span>
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function FindingPage() {
  const { repoId, findingId } = useParams({ strict: false }) as { repoId: string; findingId: string };
  const query = useQuery(findingQuery(findingId));
  if (query.isPending) return <Loading what="the finding" />;
  if (query.isError) return <ErrorNote error={query.error} retry={() => void query.refetch()} />;
  const finding = query.data;
  return (
    <>
      <Link to="/r/$repoId/findings" params={{ repoId }} className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft className="size-3.5" />Findings</Link>
      <header className="max-w-[80ch]">
        <div className="flex flex-wrap items-center gap-2">
          <SeverityBadge severity={finding.severity} />
          <FindingStatusBadge status={finding.status} />
          {finding.faults ? <span className="font-mono text-xs text-mute">under {finding.faults}</span> : null}
        </div>
        <h1 className="mt-2.5 text-2xl font-semibold tracking-[-.03em]">{finding.pledgeKey ? title(finding.pledgeKey) : "Broken pledge"}</h1>
        <p className="mt-1.5 text-[15px] leading-relaxed text-ink-2">{finding.statement}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          <RunStrip summary={finding.summary} />
          <Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId, pledgeId: finding.pledgeId }} className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink">Open the pledge <ExternalLink className="size-3" /></Link>
        </div>
      </header>

      <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">
          <Impact finding={finding} />

          <Card title="How it happened" description={finding.recording ? `One journey that broke it, as the fault proxy saw it: ${finding.recording.faults_hit} lost ${finding.recording.faults_hit === 1 ? "reply" : "replies"}` : "No recording for this run"}>
            {finding.recording && finding.timeline.length > 0 ? (
              <Recording steps={finding.timeline} journey={finding.recording.journey} seed={finding.recording.seed} />
            ) : (
              <p className="border-t border-line px-5 py-4 text-sm text-ink-2">It was made before the proxy recorded each request, or its scenario does not tag requests with their journey. What is known: {finding.faultPlan ? finding.faultPlan.description : "the scenario ran with no faults injected."}</p>
            )}
          </Card>

          {finding.browser ? <BrowserRecording browser={finding.browser} /> : null}

          <Card title="Expected versus actual" description={`Every seed. A seed fixes the traffic and which requests the faults hit, not the timing inside the app, so a race can show on some seeds and not others.`}>
            <div className="border-t border-line"><ExpectedActual seeds={finding.seeds} /></div>
          </Card>

          <Card title="Fault injected" description={finding.minimalFaultPlan.length === 0 ? "The fault plan the run used" : "The smallest plan that still breaks it"}>
            <div className="border-t border-line px-5 py-4">
              {finding.faultPlan?.description ? <p className="mb-3 text-sm text-ink-2">{finding.faultPlan.description}</p> : null}
              <ul className="space-y-1 font-mono text-xs">
                {finding.minimalFaultPlan.length > 0
                  ? finding.minimalFaultPlan.map((fault, index) => <li key={index}>{fault.fault} on {fault.target}</li>)
                  : finding.faultPlan?.faults.map((fault, index) => <li key={index} className="rounded-md bg-paper-2 px-3 py-2">{fault.kind} on {fault.target} <span className="text-mute">{JSON.stringify(fault.params)}</span></li>)}
              </ul>
            </div>
          </Card>

          <Card title="History">
            <ol className="border-t border-line px-5 py-2">
              {[...finding.history].reverse().map((point, index) => (
                <li key={index} className="flex flex-wrap items-center gap-3 py-2 text-[13px]">
                  <FindingStatusBadge status={point.status} />
                  <span className="text-mute">{when(point.at)}</span>
                  {point.run_id ? <Link to="/r/$repoId/runs/$runId" params={{ repoId, runId: point.run_id }} className="text-ink-2 underline underline-offset-[3px] hover:text-ink">from a run</Link> : <span className="text-mute">set by hand</span>}
                </li>
              ))}
            </ol>
          </Card>
        </div>
        <Rail finding={finding} />
      </div>
    </>
  );
}
