import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { Button, Empty, ErrorNote, ExpectedActual, Loading, PageTitle, PledgeStatusBadge, Section, Seeds, VerdictBadge } from "../components/ui.tsx";
import { when } from "../format.ts";
import { pledgeQuery, pledgesQuery, useDecidePledge } from "../queries.ts";
import type { Pledge, PledgeDetail } from "../types.ts";
import { Chips } from "./findings.tsx";

const FILTERS = [
  [undefined, "All"],
  ["proposed", "Proposed"],
  ["proven", "Proven"],
  ["approved", "Approved"],
  ["retired", "Retired"],
] as const;

const SOURCE = { code: "stated in code", template: "domain template", inferred: "inferred" };

function Row({ pledge }: { pledge: Pledge }) {
  return (
    <Link to="/r/$repoId/pledges/$pledgeId" params={{ repoId: pledge.repoId, pledgeId: pledge.id }} className={`grid grid-cols-1 items-center gap-x-5 gap-y-2 border-b border-line px-5 py-3.5 transition-colors last:border-b-0 hover:bg-paper-2/60 sm:grid-cols-[minmax(0,1fr)_auto_104px] ${pledge.lastVerdict === "broken" ? "shadow-[inset_2px_0_0_var(--seal)]" : ""}`}>
      <span className="min-w-0">
        <span className="line-clamp-2 text-sm font-medium leading-snug">{pledge.statement}</span>
        <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-mute">
          <PledgeStatusBadge status={pledge.status} />
          <span>{SOURCE[pledge.source]}</span>
          {pledge.confidence ? <span>confidence: {pledge.confidence}</span> : null}
          <span>proof: {pledge.plantedBugsCaught === 0 ? "none yet" : `${pledge.plantedBugsCaught} planted bugs caught`}</span>
          <span className="font-mono">{pledge.scenario}</span>
        </span>
      </span>
      <Seeds marks={pledge.lastSeeds} />
      <span className="sm:text-right">{pledge.lastVerdict ? <VerdictBadge verdict={pledge.lastVerdict} /> : <span className="text-xs text-mute">not run</span>}</span>
    </Link>
  );
}

export function PledgesPage() {
  const { repoId } = useParams({ strict: false }) as { repoId: string };
  const { status } = useSearch({ strict: false }) as { status?: string };
  const navigate = useNavigate();
  const pledges = useQuery(pledgesQuery(repoId, status));
  return (
    <>
      <PageTitle title="Pledges" lede="Every statement about this repo's data that a scan checks. Proposed pledges wait for your review: only an approved pledge can fail a pull request check." />
      <Chips label="Filter by status" options={FILTERS} value={status as (typeof FILTERS)[number][0]} onChange={(next) => void navigate({ to: "/r/$repoId/pledges", params: { repoId }, search: next ? { status: next } : {} })} />
      {pledges.isPending ? <Loading what="pledges" /> : null}
      {pledges.isError ? <ErrorNote error={pledges.error} retry={() => void pledges.refetch()} /> : null}
      {pledges.data?.length === 0 ? <Empty title={status ? `No pledge is ${status}.` : "No pledge has been checked for this repo yet."} /> : null}
      {pledges.data && pledges.data.length > 0 ? <div className="mt-4 overflow-hidden rounded-xl border border-line bg-card shadow-xs">{pledges.data.map((pledge) => <Row key={pledge.id} pledge={pledge} />)}</div> : null}
    </>
  );
}

function Review({ pledge }: { pledge: PledgeDetail }) {
  const mutation = useDecidePledge(pledge.repoId, pledge.id);
  const [overriding, setOverriding] = useState(false);
  const [note, setNote] = useState("");
  const proven = pledge.status === "proven";

  if (pledge.status === "retired") {
    return <p className="mt-5 text-sm text-ink-2">Retired{pledge.decision ? ` ${when(pledge.decision.at)}` : ""}. Scans still report it, but it never blocks. To bring it back, propose it again from the repo.</p>;
  }
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-2">
        {pledge.status !== "approved" ? (
          proven ? <Button variant="default" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "approve" })}>Approve</Button> : <Button variant="default" disabled={overriding} onClick={() => setOverriding(true)}>Approve…</Button>
        ) : null}
        {pledge.status !== "approved" ? <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "reject" })}>Reject</Button> : null}
        {pledge.status === "approved" ? <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate({ action: "retire" })}>Retire</Button> : null}
      </div>
      {overriding && pledge.status !== "approved" ? (
        <div className="mt-4 max-w-[640px] rounded-sm border border-line bg-amber-wash p-4">
          <p className="text-sm"><b className="font-medium">This pledge has no proof.</b> No planted bug has shown that it can break, so approving it is an override, and the override is recorded with your note.</p>
          <label className="mt-3 block">
            <span className="font-mono text-[11px] text-ink-2">Why approve it without proof?</span>
            <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={1000} className="mt-1.5 w-full rounded-sm border border-line bg-card px-3 py-2 text-sm" />
          </label>
          <div className="mt-3 flex gap-2">
            <Button variant="default" disabled={mutation.isPending || note.trim() === ""} onClick={() => mutation.mutate({ action: "approve", override: true, note: note.trim() })}>Approve without proof</Button>
            <Button onClick={() => setOverriding(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {mutation.isError ? <ErrorNote error={mutation.error} /> : null}
      {pledge.decision ? (
        <p className="mt-3 text-xs text-mute">
          Last decision: {pledge.decision.action}{pledge.decision.override ? " (override, no proof)" : ""} {when(pledge.decision.at)}{pledge.decision.note ? `. Note: ${pledge.decision.note}` : ""}
        </p>
      ) : null}
    </div>
  );
}

export function PledgePage() {
  const { repoId, pledgeId } = useParams({ strict: false }) as { repoId: string; pledgeId: string };
  const query = useQuery(pledgeQuery(pledgeId));
  if (query.isPending) return <Loading what="the pledge" />;
  if (query.isError) return <ErrorNote error={query.error} retry={() => void query.refetch()} />;
  const pledge = query.data;
  const facts: [string, string][] = [["source", SOURCE[pledge.source]], ["confidence", pledge.confidence || "not given"], ["scenario", pledge.scenario], ["engine assertion", pledge.assertion], ["file in the repo", pledge.file]];
  return (
    <>
      <Link to="/r/$repoId/pledges" params={{ repoId }} className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink">← Pledges</Link>
      <div className="flex flex-wrap items-center gap-3">
        <PledgeStatusBadge status={pledge.status} />
        {pledge.lastVerdict ? <VerdictBadge verdict={pledge.lastVerdict} /> : null}
        {pledge.findingId ? <Link to="/r/$repoId/findings/$findingId" params={{ repoId, findingId: pledge.findingId }} className="font-mono text-xs text-ink-2 underline underline-offset-[3px]">its finding</Link> : null}
      </div>
      <h1 className="mt-3 max-w-[80ch] text-xl font-semibold leading-snug tracking-[-.02em] sm:text-[22px]">{pledge.statement}</h1>
      <dl className="mt-5 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 rounded-xl border border-line bg-card px-5 py-4 text-[13px] shadow-xs">
        {facts.flatMap(([name, value]) => [<dt key={name} className="capitalize text-mute">{name}</dt>, <dd key={`${name}-value`} className="font-mono text-xs leading-5 [overflow-wrap:anywhere]">{value}</dd>])}
      </dl>
      <p className="mt-3 max-w-[70ch] text-xs text-mute">The check itself lives in the repo and changes through a pull request. Approving or retiring here changes only whether it can block.</p>
      <Review pledge={pledge} />

      <Section title="Proof" note="planted bugs this pledge caught">
        <p className="mt-4 max-w-[70ch] text-sm text-ink-2">None yet. The prove step, where a bug is planted to show the pledge can break, is not built, so no pledge can be proven and approval needs an override.</p>
      </Section>

      <Section title="Latest check" note={pledge.lastRunId ? <Link to="/r/$repoId/runs/$runId" params={{ repoId, runId: pledge.lastRunId }} className="underline underline-offset-[3px]">{pledge.lastFaults ? `the run under ${pledge.lastFaults}` : "the baseline run"}</Link> : undefined}>
        <div className="mt-2"><ExpectedActual seeds={pledge.seeds} /></div>
      </Section>

      <Section title="History" note={`kept or broken across the last ${pledge.history.length} ${pledge.history.length === 1 ? "run" : "runs"}`}>
        {pledge.history.map((point) => (
          <Link key={point.runId} to="/r/$repoId/runs/$runId" params={{ repoId, runId: point.runId }} className="-mx-5 grid grid-cols-[110px_minmax(0,1fr)_80px] items-center gap-4 border-t border-line px-5 py-2.5 text-[13px] text-ink-2 hover:bg-paper-2/60">
            <span><VerdictBadge verdict={point.result} /></span>
            <span>{point.faults ? `under ${point.faults}` : "no faults (baseline)"}</span>
            <span className="text-right text-mute">{when(point.at)}</span>
          </Link>
        ))}
      </Section>
    </>
  );
}
