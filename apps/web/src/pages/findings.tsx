import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";

import { Button, CopyCommand, Empty, ErrorNote, ExpectedActual, FindingStatusBadge, Loading, PageTitle, PledgeStatusBadge, RunStrip, Section, Seeds } from "../components/ui.tsx";
import { when } from "../format.ts";
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

export function Chips<T extends string | undefined>({ options, value, onChange, label }: { options: readonly (readonly [T, string])[]; value: T; onChange: (value: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="mt-5 flex flex-wrap gap-1.5">
      {options.map(([option, text]) => (
        <button key={text} type="button" aria-pressed={option === value} onClick={() => onChange(option)} className={`rounded-sm border px-3 py-1.5 font-mono text-xs ${option === value ? "border-ink bg-ink text-paper" : "border-line text-ink-2 hover:border-mute hover:text-ink"}`}>
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
      {findings.data && findings.data.length > 0 ? <div className="mt-5 border-t border-line">{findings.data.map((finding) => <FindingRow key={finding.id} finding={finding} />)}</div> : null}
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

function Actions({ finding }: { finding: FindingDetail }) {
  const mutation = useSetFindingStatus(finding.repoId, finding.id);
  const set = (status: "open" | "fix_proposed" | "fixed_unverified") => mutation.mutate(status);
  const busy = mutation.isPending;
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-2">
        {finding.status === "verified" ? (
          <span className="text-sm text-ink-2">Verified by a later run. It changes only if a run breaks the pledge again.</span>
        ) : (
          <>
            {finding.status !== "fix_proposed" ? <Button disabled={busy} onClick={() => set("fix_proposed")}>Mark fix proposed</Button> : null}
            {finding.status !== "fixed_unverified" ? <Button kind="solid" disabled={busy} onClick={() => set("fixed_unverified")}>Mark fixed</Button> : null}
            {finding.status !== "open" && finding.status !== "reopened" ? <Button disabled={busy} onClick={() => set("open")}>Back to open</Button> : null}
          </>
        )}
        <Button onClick={() => void navigator.clipboard?.writeText(agentPrompt(finding))}>Copy as a prompt for a coding agent</Button>
      </div>
      {mutation.isError ? <ErrorNote error={mutation.error} /> : null}
      <p className="mt-3 max-w-[70ch] font-mono text-[11.5px] text-mute">Marking it fixed does not verify it. Run the scan again on the fixing commit: if the pledge holds on every seed under the same faults, the finding becomes verified. Rerunning from here is not built yet.</p>
    </div>
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
      <Link to="/r/$repoId/findings" params={{ repoId }} className="mb-4 block w-fit font-mono text-xs text-mute hover:text-ink">← All findings</Link>
      <div className="flex flex-wrap items-center gap-3">
        <FindingStatusBadge status={finding.status} />
        <span className="font-mono text-xs text-mute">first seen {when(finding.firstSeen)}</span>
        <span className="ml-auto"><Seeds marks={finding.seeds.map((seed) => seed.status)} large /></span>
      </div>
      <h1 className="mt-4 max-w-[30ch] text-[clamp(24px,3vw,34px)] font-semibold leading-[1.1] tracking-[-.035em]">{finding.statement}</h1>
      <p className="mt-3 max-w-[70ch] text-ink-2">
        This pledge broke on {finding.brokenSeeds.length} of {finding.totalSeeds} seeds. {finding.blocks ? "It is approved, so a pull request check would fail." : <>It is <PledgeStatusBadge status={finding.pledgeStatus ?? "proposed"} />, not approved, so it does not block anything yet.</>}{" "}
        <Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId, pledgeId: finding.pledgeId }} className="underline underline-offset-[3px]">Open the pledge</Link>
      </p>
      <div className="mt-4"><RunStrip summary={finding.summary} /></div>
      <Actions finding={finding} />

      <Section title="Expected versus actual" note="read from the app's data after each run"><div className="mt-2"><ExpectedActual seeds={finding.seeds} /></div></Section>

      <Section title="How it happened">
        {finding.timeline.length === 0 ? (
          <p className="mt-4 max-w-[70ch] text-sm text-ink-2">
            An ordered timeline is not recorded yet. What is known: {finding.faultPlan ? finding.faultPlan.description : "the scenario ran with no faults injected."}
          </p>
        ) : (
          <ol className="mt-4 space-y-2">{finding.timeline.map((step, index) => <li key={index} className="grid grid-cols-[110px_1fr] gap-3 text-sm"><span className="font-mono text-xs text-mute">{step.actor}</span><span>{step.text}</span></li>)}</ol>
        )}
      </Section>

      <Section title="How often">
        <p className="mt-4 text-sm text-ink-2">Broke on {finding.brokenSeeds.map((seed) => `seed ${seed}`).join(", ")} of {finding.totalSeeds}. A seed fixes the traffic and which requests the faults hit, not the timing inside the app, so a race can show on some seeds and not others.</p>
      </Section>

      <Section title="Smallest cause">
        {finding.minimalFaultPlan.length === 0 ? (
          <div className="mt-4 text-sm text-ink-2">
            <p>Reducing a fault plan to the one fault that matters is not built yet. This is the whole plan the run used:</p>
            {finding.faultPlan ? <ul className="mt-2 space-y-1 font-mono text-xs">{finding.faultPlan.faults.map((fault, index) => <li key={index}>{fault.kind} on {fault.target} {JSON.stringify(fault.params)}</li>)}</ul> : null}
          </div>
        ) : (
          <ul className="mt-4 space-y-1 font-mono text-xs">{finding.minimalFaultPlan.map((fault, index) => <li key={index}>{fault.fault} on {fault.target}</li>)}</ul>
        )}
      </Section>

      <Section title="Replay"><div className="mt-4"><CopyCommand label="Run one breaking seed again" command={finding.replayCommand} /></div></Section>

      <Section title="History">
        <ul className="mt-2">
          {[...finding.history].reverse().map((point, index) => (
            <li key={index} className="flex flex-wrap items-center gap-3 border-b border-line py-2.5 text-sm">
              <FindingStatusBadge status={point.status} />
              <span className="font-mono text-xs text-mute">{when(point.at)}</span>
              {point.run_id ? <Link to="/r/$repoId/runs/$runId" params={{ repoId, runId: point.run_id }} className="font-mono text-xs text-ink-2 underline underline-offset-[3px]">the run</Link> : <span className="font-mono text-xs text-mute">set by hand</span>}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
