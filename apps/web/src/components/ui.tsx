import { useState, type ReactNode } from "react";

import { checkRows, thousands } from "../format.ts";
import type { FindingStatus, PledgeStatus, RunSummary, Seed, Verdict } from "../types.ts";

const STAMP = "inline-block whitespace-nowrap rounded-xs px-[7px] py-[5px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.08em]";

/** Kept, broken or inconclusive. Always a word, never colour alone. */
export function VerdictBadge({ verdict }: { verdict: Verdict | "running" | "failed" | null }) {
  const look = { broken: "bg-seal text-white", kept: "bg-kept text-white", inconclusive: "text-ink-2 shadow-[inset_0_0_0_1px_var(--mute)]", running: "bg-ink text-paper", failed: "text-seal shadow-[inset_0_0_0_1px_var(--seal)]" };
  const word = verdict ?? "inconclusive";
  return <span className={`${STAMP} ${look[word]}`}>{word}</span>;
}

const PLEDGE_LOOK: Record<PledgeStatus, string> = { proposed: "text-amber bg-amber-wash", proven: "text-ink bg-paper-2", approved: "text-kept bg-kept-wash", retired: "text-mute line-through" };

export function PledgeStatusBadge({ status }: { status: PledgeStatus }) {
  return <span className={`w-fit rounded-xs px-1.5 py-0.5 font-mono text-[11px] ${PLEDGE_LOOK[status]}`}>{status}</span>;
}

const FINDING_WORDS: Record<FindingStatus, string> = { open: "open", fix_proposed: "fix proposed", fixed_unverified: "fixed, not verified", verified: "verified", reopened: "reopened" };
const FINDING_LOOK: Record<FindingStatus, string> = { open: "text-seal bg-seal-wash", reopened: "text-seal bg-seal-wash", fix_proposed: "text-amber bg-amber-wash", fixed_unverified: "text-amber bg-amber-wash", verified: "text-kept bg-kept-wash" };

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <span className={`w-fit whitespace-nowrap rounded-xs px-1.5 py-0.5 font-mono text-[11px] ${FINDING_LOOK[status]}`}>{FINDING_WORDS[status]}</span>;
}

/** The run strip: the same three facts, in the same words, wherever a run is summarised. */
export function RunStrip({ summary, dark = false }: { summary: RunSummary | null; dark?: boolean }) {
  if (!summary) return null;
  const share = summary.requestsSent === 0 ? 100 : Math.floor((100 * summary.requestsSucceeded) / summary.requestsSent);
  const strong = dark ? "text-[#F6F1EB]" : "text-ink";
  const broken = summary.pledgesBroken > 0 ? (dark ? "text-[#F47C62]" : "text-seal") : strong;
  return (
    <p className={`font-mono text-[13px] ${dark ? "text-[#8E8781]" : "text-ink-2"}`}>
      <b className={`font-medium ${strong}`}>{thousands(summary.requestsSent)}</b> requests sent <span aria-hidden="true">·</span>{" "}
      <b className={`font-medium ${strong}`}>{share}%</b> returned success <span aria-hidden="true">·</span>{" "}
      <b className={`font-medium ${broken}`}>{summary.pledgesBroken}</b> {summary.pledgesBroken === 1 ? "pledge" : "pledges"} broken
    </p>
  );
}

/** One square per seed, the landing page's mark for "ran many times". */
export function Seeds({ marks, large = false, dark = false }: { marks: string[]; large?: boolean; dark?: boolean }) {
  const failed = marks.filter((mark) => mark === "fail" || mark === "broken").length;
  const label = failed === 0 ? `${marks.length} of ${marks.length} seeds held` : `broke on ${failed} of ${marks.length} seeds`;
  const size = large ? "h-4 w-4" : "h-[11px] w-[11px]";
  const tone = (mark: string) => (mark === "pass" || mark === "kept" ? (dark ? "bg-[#4C9A64]" : "bg-kept") : mark === "fail" || mark === "broken" ? (dark ? "bg-[#E2482B]" : "bg-seal") : dark ? "bg-white/10" : "bg-idle");
  return (
    <span role="img" aria-label={label} title={label} className="flex flex-wrap gap-[3px]">
      {marks.map((mark, index) => <i key={index} className={`${size} rounded-[1px] ${tone(mark)}`} />)}
    </span>
  );
}

export function SeedCount({ broken, total }: { broken: number; total: number }) {
  return <span className="whitespace-nowrap font-mono text-xs text-ink-2">{broken === 0 ? `held on all ${total} ${total === 1 ? "seed" : "seeds"}` : `broke on ${broken} of ${total} ${total === 1 ? "seed" : "seeds"}`}</span>;
}

/** Expected against actual for every seed, with the values that differ in red. */
export function ExpectedActual({ seeds }: { seeds: Seed[] }) {
  if (seeds.length === 0) return <p className="font-mono text-xs text-mute">No seed has checked this yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs leading-normal">
        <thead>
          <tr className="text-left text-mute [&>th]:border-b [&>th]:border-line [&>th]:py-1.5 [&>th]:pr-3 [&>th]:font-medium">
            <th>Seed</th><th>Checked</th><th>Expected</th><th>Actual</th>
          </tr>
        </thead>
        <tbody className="[&_td]:border-b [&_td]:border-line [&_td]:py-[7px] [&_td]:pr-3 [&_td]:align-top">
          {seeds.flatMap((seed) => {
            const dot = <i className={`mr-2 inline-block h-[9px] w-[9px] rounded-[1px] ${seed.status === "pass" ? "bg-kept" : seed.status === "fail" ? "bg-seal" : "bg-idle"}`} />;
            const label = <td className="whitespace-nowrap">{dot}seed {seed.seed}</td>;
            if (seed.expected === undefined && seed.actual === undefined) {
              const note = seed.status === "pass" ? "held; values are kept only for checks that fail" : seed.status === "fail" ? (seed.failed ? `failed for ${seed.failed} journeys` : "failed") : "could not be judged on this seed";
              return [<tr key={seed.seed}>{label}<td colSpan={3} className="text-ink-2">{note}</td></tr>];
            }
            return checkRows(seed.expected, seed.actual).map((row, index, rows) => (
              <tr key={`${seed.seed}-${index}`}>
                {index === 0 ? <td rowSpan={rows.length} className="whitespace-nowrap">{dot}seed {seed.seed}</td> : null}
                <td className="break-words text-ink-2">{row.key || (seed.failed ? `per journey; ${seed.failed} failed` : "value")}</td>
                <td>{row.expected}</td>
                <td className={row.differs && seed.status === "fail" ? "font-medium text-seal" : ""}>{row.actual}</td>
              </tr>
            ));
          })}
        </tbody>
      </table>
    </div>
  );
}

export function CopyCommand({ label, command }: { label: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2.5 rounded-sm bg-paper-2 py-2 pl-3 pr-2">
      <span className="font-mono text-[11px] text-mute">{label}</span>
      <code className="min-w-[200px] flex-1 font-mono text-[12.5px] [overflow-wrap:anywhere]">{command}</code>
      <Button onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

export function Button({ children, onClick, disabled, kind = "quiet", type = "button" }: { children: ReactNode; onClick?: () => void; disabled?: boolean; kind?: "quiet" | "solid" | "danger"; type?: "button" | "submit" }) {
  const look = { quiet: "border-line text-ink-2 hover:border-mute hover:text-ink", solid: "border-ink bg-ink text-paper hover:opacity-90", danger: "border-seal text-seal hover:bg-seal hover:text-white" };
  return <button type={type} onClick={onClick} disabled={disabled} className={`inline-flex h-8 items-center whitespace-nowrap rounded-sm border px-3 font-mono text-[11.5px] ${look[kind]}`}>{children}</button>;
}

export function Section({ title, note, action, children }: { title: string; note?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-12">
      <h2 className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 border-b border-line pb-3 font-mono text-xs font-medium uppercase tracking-[.06em] text-ink-2">
        {title}
        {note ? <small className="text-xs font-normal normal-case tracking-normal text-mute">{note}</small> : null}
        {action ? <span className="ml-auto text-xs font-normal normal-case tracking-normal">{action}</span> : null}
      </h2>
      {children}
    </section>
  );
}

export function PageTitle({ title, lede, children }: { title: ReactNode; lede?: ReactNode; children?: ReactNode }) {
  return (
    <header>
      <h1 className="text-[clamp(26px,3.4vw,36px)] font-semibold leading-[1.08] tracking-[-.04em]">{title}</h1>
      {lede ? <p className="mt-2.5 max-w-[64ch] text-ink-2">{lede}</p> : null}
      {children}
    </header>
  );
}

/** What a tab shows when it has nothing: what is missing and what to do about it. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mt-7 rounded-md border border-dashed border-line px-7 py-9 text-ink-2 [&_code]:rounded-xs [&_code]:bg-paper-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-ink [&_p+p]:mt-2.5">
      <p className="font-medium text-ink">{title}</p>
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p role="status" className="mt-7 font-mono text-xs text-mute">Loading {what}…</p>;
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="mt-7 flex flex-wrap items-center gap-3 rounded-sm border border-line bg-seal-wash px-4 py-3.5 shadow-[inset_2px_0_0_var(--seal)]">
      <span>{error instanceof Error ? error.message : "Something went wrong."}</span>
      {retry ? <Button onClick={retry}>Try again</Button> : null}
    </div>
  );
}

/** The landing page's wordmark: the name with the asterisk as a superscript, in the seal red. */
export function Wordmark() {
  return (
    <span className="inline-flex items-start text-[19px] font-semibold leading-none tracking-[-.035em]">
      pledge
      <sup className="-mt-px ml-px leading-[0] text-seal">
        <svg className="logo-mark" width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" aria-hidden="true">
          <path d="M12 4v16" /><path d="M5.1 8l13.8 8" /><path d="M5.1 16L18.9 8" />
        </svg>
      </sup>
    </span>
  );
}
