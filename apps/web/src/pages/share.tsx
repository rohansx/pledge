import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Check, Copy, ExternalLink, Github, Globe, Lock } from "lucide-react";
import { useState } from "react";

import { Recording } from "../components/recording.tsx";
import { Button, Card, ErrorNote, FindingStatusBadge, Loading, Seeds, SeverityBadge } from "../components/ui.tsx";
import { harmFigures, impact, newIssueUrl, reportMarkdown, reportsPrivately, title, when } from "../format.ts";
import { publicFindingQuery, publicIndexQuery, usePatchFinding } from "../queries.ts";
import type { FindingDetail, Harm, PublicFinding } from "../types.ts";

const FIELD = "w-full rounded-md border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-mute focus:border-ink focus:outline-none";
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const UPSTREAM_LINK = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/(issues|discussions|security\/advisories)\/[A-Za-z0-9-]+$/;

export const publicUrl = (token: string): string => `${location.origin}/p/${token}`;

/** Whether the repo publishes a security policy, which asks for private reports. Read from GitHub's public API.
 * Null when GitHub did not say (rate limit, network): the caller then treats money and data as private. */
async function securityPolicy(repo: string): Promise<boolean | null> {
  const answers = await Promise.all(["SECURITY.md", ".github/SECURITY.md", "docs/SECURITY.md"].map((path) => fetch(`https://api.github.com/repos/${repo}/contents/${path}`).then((response) => (response.ok ? true : response.status === 404 ? false : null), () => null)));
  return answers.includes(true) ? true : answers.includes(null) ? null : false;
}

function issueTitle(finding: { statement: string }): string {
  const first = finding.statement.split(/(?<=\.)\s/)[0] ?? finding.statement;
  return first.length <= 120 ? first.replace(/\.$/, "") : `${first.slice(0, 117)}...`;
}

/** On the finding page: write it up, confirm it, make it public, report it upstream. In that order, each needing the last. */
export function ReportCard({ finding }: { finding: FindingDetail }) {
  const mutation = usePatchFinding(finding.repoId, finding.id);
  const [cause, setCause] = useState(finding.cause);
  const [fix, setFix] = useState(finding.fix);
  const [repo, setRepo] = useState(finding.upstreamRepo ?? "");
  const [issue, setIssue] = useState(finding.issueUrl ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const busy = mutation.isPending;
  const dirty = cause !== finding.cause || fix !== finding.fix || repo !== (finding.upstreamRepo ?? "");
  const repoOk = GITHUB_REPO.test(repo);
  // Asked before the click, so opening GitHub stays a direct response to it and no popup blocker steps in.
  const policy = useQuery({ queryKey: ["security-policy", repo], queryFn: () => securityPolicy(repo), enabled: repoOk, staleTime: 3_600_000, retry: false });

  const save = () => mutation.mutate({ cause, fix, ...(repoOk ? { upstream_repo: repo } : {}) });

  function report() {
    const body = reportMarkdown({ ...finding, faults: finding.faultPlan?.description ?? null }, finding.shareToken ? publicUrl(finding.shareToken) : null);
    if (reportsPrivately(finding.severity, policy.data ?? null)) {
      // GitHub cannot pre-fill an advisory: the report goes to the clipboard and the form opens empty.
      void navigator.clipboard?.writeText(`${issueTitle(finding)}\n\n${body}`);
      setNote(policy.data ? `${repo} asks for security reports in private. The report is on your clipboard: paste it into the advisory form that just opened.` : `Could not read ${repo}'s security policy, so this money or data finding goes the private way. The report is on your clipboard for the advisory form; if the repo does not take advisories, file it as an issue yourself.`);
      window.open(`https://github.com/${repo}/security/advisories/new`, "_blank", "noopener");
      return;
    }
    setNote("GitHub opened with the issue filled in. Read it, then press Submit there. Paste the issue's link below once it is filed.");
    window.open(newIssueUrl(repo, issueTitle(finding), body), "_blank", "noopener");
  }

  return (
    <Card title="Report it" description="Write down why it happens, confirm it against the evidence, then share it or report it upstream.">
      <div className="space-y-4 border-t border-line px-5 py-4">
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">Why it happens</span>
          <textarea className={`${FIELD} min-h-24`} value={cause} onChange={(event) => setCause(event.target.value)} maxLength={4000} placeholder="Where in the app's code, and why the faults make it break." />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">What would stop it</span>
          <textarea className={`${FIELD} min-h-16`} value={fix} onChange={(event) => setFix(event.target.value)} maxLength={4000} placeholder="The fix, or what correct behaviour looks like." />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[13px] font-medium">GitHub repository</span>
          <input className={`${FIELD} font-mono`} value={repo} onChange={(event) => setRepo(event.target.value.trim())} placeholder="owner/name" maxLength={200} />
        </label>
        <Button disabled={busy || !dirty || (repo !== "" && !repoOk)} onClick={save}>Save write-up</Button>

        <label className="flex items-start gap-2.5 border-t border-line pt-4 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={finding.confirmed} disabled={busy} onChange={(event) => mutation.mutate({ confirmed: event.target.checked })} />
          <span>I checked this against the run's own evidence: the recorded requests and the values the check read. <span className="text-mute">A finding can be public only once confirmed.</span></span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          {finding.shareToken ? (
            <>
              <Button disabled={busy} onClick={() => void navigator.clipboard?.writeText(publicUrl(finding.shareToken!)).then(() => setCopied(true))}>{copied ? <Check className="size-4 text-kept" /> : <Copy className="size-4" />}Copy public link</Button>
              <a className="inline-flex items-center gap-1 text-[13px] text-ink-2 hover:text-ink" href={`/p/${finding.shareToken}`} target="_blank" rel="noopener">Open <ExternalLink className="size-3" /></a>
              <Button variant="ghost" disabled={busy} onClick={() => mutation.mutate({ public: false })}><Lock className="size-4" />Stop sharing</Button>
            </>
          ) : (
            <Button disabled={busy || !finding.confirmed || !finding.cause} onClick={() => mutation.mutate({ public: true })}><Globe className="size-4" />Make public</Button>
          )}
          <Button variant="default" disabled={busy || !repoOk || !finding.cause || dirty || policy.isPending} onClick={report}><Github className="size-4" />Report upstream</Button>
        </div>
        {note ? <p className="text-[13px] text-ink-2">{note}</p> : null}

        <label className="block space-y-1.5 border-t border-line pt-4">
          <span className="text-[13px] font-medium">Upstream issue or advisory</span>
          <span className="flex gap-2">
            <input className={`${FIELD} font-mono`} value={issue} onChange={(event) => setIssue(event.target.value.trim())} placeholder="https://github.com/owner/name/issues/123" maxLength={300} />
            <Button disabled={busy || issue === (finding.issueUrl ?? "") || (issue !== "" && !UPSTREAM_LINK.test(issue))} onClick={() => mutation.mutate({ issue_url: issue })}>Save</Button>
          </span>
        </label>
        {mutation.isError ? <ErrorNote error={mutation.error} /> : null}
      </div>
    </Card>
  );
}

function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-[960px] items-center justify-between px-4 py-3">
          <Link to="/found" className="text-[15px] font-semibold tracking-[-.03em]">pledge <span className="font-normal text-mute">found</span></Link>
          <a href="https://pledge.sh" className="text-[13px] text-ink-2 hover:text-ink">What is Pledge?</a>
        </div>
      </header>
      <main className="mx-auto max-w-[960px] px-4 py-8">{children}</main>
    </div>
  );
}

function HarmFigures({ harm, severity }: { harm: Harm | null; severity: string }) {
  const figures = harmFigures(harm, severity);
  if (figures.length === 0) return null;
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-seal/30 bg-seal/15 sm:grid-cols-2">
      {figures.map((figure) => (
        <div key={figure.label} className="bg-card px-5 py-5">
          <p className="text-4xl font-semibold tracking-[-.03em] text-seal tabular-nums">{figure.value}</p>
          <p className="mt-1 text-[13px] text-ink-2">{figure.label}</p>
        </div>
      ))}
    </div>
  );
}

function Prose({ heading, text }: { heading: string; text: string }) {
  if (!text) return null;
  return (
    <section>
      <h2 className="text-[15px] font-semibold">{heading}</h2>
      <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed text-ink-2">{text}</p>
    </section>
  );
}

function PublicFindingBody({ finding }: { finding: PublicFinding }) {
  const rows = impact([{ status: "fail", expected: finding.expected, actual: finding.actual }]);
  const repoLink = finding.upstreamRepo ? `https://github.com/${finding.upstreamRepo}` : null;
  return (
    <article className="space-y-7">
      <header>
        <p className="text-[13px] text-mute">{repoLink ? <a className="underline underline-offset-[3px] hover:text-ink" href={repoLink}>{finding.upstreamRepo}</a> : finding.repo} · found {when(finding.firstSeen)}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2"><SeverityBadge severity={finding.severity} /><FindingStatusBadge status={finding.status} /></div>
        <h1 className="mt-2.5 text-2xl font-semibold tracking-[-.03em]">{finding.title ? title(finding.title) : "Broken pledge"}</h1>
        <p className="mt-1.5 text-[15px] leading-relaxed text-ink-2">Should always hold: {finding.statement}</p>
        {finding.issueUrl ? <a className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-medium underline underline-offset-[3px]" href={finding.issueUrl}><Github className="size-3.5" />Reported upstream</a> : null}
      </header>

      <HarmFigures harm={finding.harm} severity={finding.severity} />
      <Prose heading="Why it happens" text={finding.cause} />
      <Prose heading="What would stop it" text={finding.fix} />
      <Prose heading="Conditions it ran under" text={finding.faults ?? ""} />

      {finding.timeline.length > 0 ? (
        <Card title="One broken journey, request by request" description="As the fault proxy saw it. Request and reply bodies are left out of public pages.">
          <Recording steps={finding.timeline.map((step) => ({ ...step, detail: null }))} journey="" seed={0} />
        </Card>
      ) : null}

      {rows.length > 0 ? (
        <Card title="Expected versus actual, one broken journey">
          <ul className="border-t border-line px-5 py-3 font-mono text-[13px]">
            {rows.map((row) => <li key={row.key} className="py-1">{row.key || "value"}: expected {row.expected}, found <span className="text-seal">{row.actual}</span></li>)}
          </ul>
        </Card>
      ) : null}

      <section className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-5 text-[13px] text-ink-2">
        <span className="inline-flex items-center gap-2">Runs <Seeds marks={finding.seeds.map((seed) => seed.status)} /></span>
        <span>Of this project's {finding.held.checked} pledges, {finding.held.kept} held under the same faults.</span>
      </section>
    </article>
  );
}

export function PublicFindingPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const query = useQuery(publicFindingQuery(token));
  return (
    <PublicShell>
      {query.isPending ? <Loading what="the finding" /> : query.isError ? <p className="text-ink-2">This link is not shared, or it was switched off.</p> : <PublicFindingBody finding={query.data} />}
    </PublicShell>
  );
}

export function PublicIndexPage() {
  const query = useQuery(publicIndexQuery());
  return (
    <PublicShell>
      <h1 className="text-2xl font-semibold tracking-[-.03em]">Bugs Pledge found in open source</h1>
      <p className="mt-1.5 max-w-[70ch] text-[15px] leading-relaxed text-ink-2">Each was found by running the project under lost replies, retries and concurrent requests, checked by a person against the recorded evidence, and reported to its maintainers. Alongside each project: how many of the rules we checked held.</p>
      {query.isPending ? <Loading what="findings" /> : query.isError ? <ErrorNote error={query.error} retry={() => void query.refetch()} /> : query.data.length === 0 ? <p className="mt-8 text-ink-2">Nothing is public yet.</p> : (
        <div className="mt-8 space-y-6">
          {query.data.map((group) => (
            <Card key={group.repo} title={group.upstreamRepo ?? group.repo} description={`${group.held.kept} of ${group.held.checked} pledges held`}>
              {group.findings.map((finding) => {
                const [journeys, gap] = harmFigures(finding.harm, finding.severity);
                return (
                  <Link key={finding.token} to="/p/$token" params={{ token: finding.token }} className="grid grid-cols-1 gap-x-5 gap-y-1 border-t border-line px-5 py-3 hover:bg-paper-2/60 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{finding.title ? title(finding.title) : finding.statement}</span><SeverityBadge severity={finding.severity} />{finding.issueUrl ? <span className="text-xs text-mute">reported</span> : null}</span>
                      <span className="mt-0.5 line-clamp-1 text-[13px] text-ink-2">{finding.statement}</span>
                    </span>
                    {journeys ? <span className="text-sm sm:text-right"><span className="font-semibold text-seal tabular-nums">{gap ? gap.value : journeys.value}</span> <span className="text-[13px] text-mute">{gap ? (finding.severity === "money" ? "charged wrongly" : "off") : "journeys"}</span></span> : null}
                  </Link>
                );
              })}
            </Card>
          ))}
        </div>
      )}
    </PublicShell>
  );
}
