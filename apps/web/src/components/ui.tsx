import { Check, Copy, Inbox, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";

import { checkRows, thousands, type RunState } from "../format.ts";
import type { FindingStatus, PledgeStatus, RunSummary, Seed } from "../types.ts";

// shadcn's shapes (card, badge, button, table) on the landing page's colours: paper, ink, seal red, kept green,
// amber. Colour always comes with a word or an icon, never alone.

type Tone = "seal" | "kept" | "amber" | "ink" | "mute";

const TONE: Record<Tone, { badge: string; dot: string }> = {
  seal: { badge: "border-seal/25 bg-seal-wash text-seal", dot: "bg-seal" },
  kept: { badge: "border-kept/25 bg-kept-wash text-kept", dot: "bg-kept" },
  amber: { badge: "border-amber/25 bg-amber-wash text-amber", dot: "bg-amber" },
  ink: { badge: "border-ink bg-ink text-paper", dot: "bg-paper" },
  mute: { badge: "border-line bg-paper-2 text-ink-2", dot: "bg-mute" },
};

export function Badge({ tone = "mute", dot = true, pulse = false, children }: { tone?: Tone; dot?: boolean; pulse?: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium leading-5 ${TONE[tone].badge}`}>
      {dot ? <span aria-hidden="true" className={`size-1.5 rounded-full ${TONE[tone].dot} ${pulse ? "live-dot !size-1.5" : ""}`} /> : null}
      {children}
    </span>
  );
}

const VERDICT: Record<RunState, Tone> = { broken: "seal", kept: "kept", inconclusive: "mute", running: "ink", stalled: "amber", failed: "seal" };

/** Kept, broken or inconclusive, and for a run also running, stalled or failed. */
export function VerdictBadge({ verdict }: { verdict: RunState | null }) {
  const word = verdict ?? "inconclusive";
  return <Badge tone={VERDICT[word]} pulse={word === "running"}>{word}</Badge>;
}

const PLEDGE_TONE: Record<PledgeStatus, Tone> = { proposed: "amber", proven: "mute", approved: "kept", retired: "mute" };

export function PledgeStatusBadge({ status }: { status: PledgeStatus }) {
  return <Badge tone={PLEDGE_TONE[status]} dot={false}>{status}</Badge>;
}

const FINDING_WORDS: Record<FindingStatus, string> = { open: "open", fix_proposed: "fix proposed", fixed_unverified: "fixed, not verified", verified: "verified", reopened: "reopened" };
const FINDING_TONE: Record<FindingStatus, Tone> = { open: "seal", reopened: "seal", fix_proposed: "amber", fixed_unverified: "amber", verified: "kept" };

export function FindingStatusBadge({ status }: { status: FindingStatus }) {
  return <Badge tone={FINDING_TONE[status]}>{FINDING_WORDS[status]}</Badge>;
}

/** The run strip: the same three facts, in the same words, wherever a run is summarised. */
export function RunStrip({ summary }: { summary: RunSummary | null }) {
  if (!summary) return null;
  const share = summary.requestsSent === 0 ? 100 : Math.floor((100 * summary.requestsSucceeded) / summary.requestsSent);
  return (
    <p className="text-[13px] text-ink-2">
      <b className="font-medium text-ink tabular-nums">{thousands(summary.requestsSent)}</b> requests <span aria-hidden="true" className="text-mute">·</span>{" "}
      <b className="font-medium text-ink tabular-nums">{share}%</b> succeeded <span aria-hidden="true" className="text-mute">·</span>{" "}
      <b className={`font-medium tabular-nums ${summary.pledgesBroken > 0 ? "text-seal" : "text-ink"}`}>{summary.pledgesBroken}</b> {summary.pledgesBroken === 1 ? "pledge" : "pledges"} broken
    </p>
  );
}

/** One square per seed, the landing page's mark for "ran many times". */
export function Seeds({ marks, large = false }: { marks: string[]; large?: boolean }) {
  const failed = marks.filter((mark) => mark === "fail" || mark === "broken").length;
  const label = failed === 0 ? `${marks.length} of ${marks.length} seeds held` : `broke on ${failed} of ${marks.length} seeds`;
  const size = large ? "size-4 rounded-[3px]" : "size-2.5 rounded-[2px]";
  const tone = (mark: string) => (mark === "pass" || mark === "kept" ? "bg-kept" : mark === "fail" || mark === "broken" ? "bg-seal" : "bg-idle");
  return (
    <span role="img" aria-label={label} title={label} className="flex flex-wrap gap-[3px]">
      {marks.map((mark, index) => <i key={index} className={`${size} ${tone(mark)}`} />)}
    </span>
  );
}

export function SeedCount({ broken, total }: { broken: number; total: number }) {
  return <span className="whitespace-nowrap text-xs text-ink-2 tabular-nums">{broken === 0 ? `held on all ${total}` : `${broken} of ${total} seeds`}</span>;
}

/** A shadcn table: muted header row, hairline rows. */
export const TABLE = "w-full border-collapse text-[13px] [&_th]:h-9 [&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:text-left [&_th]:text-xs [&_th]:font-medium [&_th]:text-mute [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top [&_tr:last-child>td]:border-b-0";

/** Expected against actual for every seed, with the values that differ in red. */
export function ExpectedActual({ seeds }: { seeds: Seed[] }) {
  if (seeds.length === 0) return <p className="p-5 text-sm text-mute">No seed has checked this yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className={TABLE}>
        <thead><tr><th>Seed</th><th>Checked</th><th>Expected</th><th>Actual</th></tr></thead>
        <tbody>
          {seeds.flatMap((seed) => {
            const dot = <i className={`mr-2 inline-block size-2 rounded-[2px] ${seed.status === "pass" ? "bg-kept" : seed.status === "fail" ? "bg-seal" : "bg-idle"}`} />;
            if (seed.expected === undefined && seed.actual === undefined) {
              const note = seed.status === "pass" ? "held; values are kept only for checks that fail" : seed.status === "fail" ? (seed.failed ? `failed for ${seed.failed} journeys` : "failed") : "could not be judged on this seed";
              return [<tr key={seed.seed}><td className="whitespace-nowrap">{dot}seed {seed.seed}</td><td colSpan={3} className="text-ink-2">{note}</td></tr>];
            }
            return checkRows(seed.expected, seed.actual).map((row, index, rows) => (
              <tr key={`${seed.seed}-${index}`}>
                {index === 0 ? <td rowSpan={rows.length} className="whitespace-nowrap">{dot}seed {seed.seed}</td> : null}
                <td className="break-words font-mono text-xs text-ink-2">{row.key || (seed.failed ? `per journey; ${seed.failed} failed` : "value")}</td>
                <td className="font-mono text-xs tabular-nums">{row.expected}</td>
                <td className={`font-mono text-xs tabular-nums ${row.differs && seed.status === "fail" ? "font-semibold text-seal" : ""}`}>{row.actual}</td>
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
    <div>
      <p className="mb-1.5 text-xs text-mute">{label}</p>
      <div className="flex items-start gap-2 rounded-md border border-line bg-paper-2 py-2 pl-3 pr-1.5">
        <code className="min-w-0 flex-1 py-1 font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">{command}</code>
        <Button size="icon" variant="ghost" label={copied ? "Copied" : "Copy command"} onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}>
          {copied ? <Check className="size-3.5 text-kept" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

const BUTTON = {
  outline: "border border-line bg-card text-ink shadow-xs hover:bg-paper-2",
  default: "border border-ink bg-ink text-paper shadow-xs hover:opacity-90",
  ghost: "text-ink-2 hover:bg-paper-2 hover:text-ink",
  destructive: "border border-seal/30 bg-card text-seal shadow-xs hover:bg-seal hover:text-white",
};

export interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: keyof typeof BUTTON;
  size?: "sm" | "md" | "icon";
  type?: "button" | "submit";
  label?: string;
  className?: string;
}

export function Button({ children, onClick, disabled, variant = "outline", size = "md", type = "button", label, className = "" }: ButtonProps) {
  const sizing = size === "icon" ? "size-8 justify-center" : size === "sm" ? "h-8 px-3 text-xs" : "h-9 px-3.5 text-sm";
  return (
    <button type={type} onClick={onClick} disabled={disabled} aria-label={label} title={label} className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md font-medium transition-colors [&_svg]:shrink-0 ${sizing} ${BUTTON[variant]} ${className}`}>
      {children}
    </button>
  );
}

/** A shadcn card: title row, optional description and action, then the body flush to the edges. */
export function Card({ title, description, action, children, className = "", tone }: { title?: ReactNode; description?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; tone?: "seal" }) {
  const border = tone === "seal" ? "border-seal/30" : "border-line";
  return (
    <section className={`overflow-hidden rounded-xl border bg-card shadow-xs ${border} ${className}`}>
      {title ? (
        <header className="flex flex-wrap items-start gap-x-4 gap-y-1 px-5 pb-3 pt-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold tracking-[-.01em]">{title}</h2>
            {description ? <p className="mt-0.5 text-[13px] text-mute">{description}</p> : null}
          </div>
          {action ? <div className="text-[13px]">{action}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/** The old section heading, now a card. Pages pass their body as children; it gets the card's padding. */
export function Section({ title, note, action, children }: { title: string; note?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <Card title={title} description={note} action={action} className="mt-6">
      <div className="px-5 pb-5 [&>*:first-child]:mt-0">{children}</div>
    </Card>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "seal" }) {
  return (
    <div className="rounded-xl border border-line bg-card px-5 py-4 shadow-xs">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className={`mt-1.5 text-[28px] font-semibold leading-none tracking-[-.03em] tabular-nums ${tone === "seal" ? "text-seal" : ""}`}>{value}</p>
      {hint ? <p className="mt-2 text-xs text-mute">{hint}</p> : null}
    </div>
  );
}

export function PageTitle({ title, lede, action, children }: { title: ReactNode; lede?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <header>
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold tracking-[-.03em]">{title}</h1>
          {lede ? <p className="mt-1 max-w-[72ch] text-ink-2">{lede}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </header>
  );
}

/** What a tab shows when it has nothing: what is missing and what to do about it. */
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-line px-7 py-12 text-center text-ink-2 [&_code]:rounded-xs [&_code]:bg-paper-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:text-ink [&_p+p]:mt-2.5 [&_p]:max-w-[60ch]">
      <span className="mb-3 grid size-10 place-items-center rounded-lg border border-line bg-card"><Inbox className="size-5 text-mute" /></span>
      <p className="font-medium text-ink">{title}</p>
      {children}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <div role="status" aria-label={`Loading ${what}`} className="mt-6 space-y-3">
      <div className="h-7 w-48 animate-pulse rounded-md bg-paper-2" />
      <div className="h-24 animate-pulse rounded-xl bg-paper-2" />
      <div className="h-48 animate-pulse rounded-xl bg-paper-2" />
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="mt-6 flex flex-wrap items-center gap-3 rounded-xl border border-seal/30 bg-seal-wash px-4 py-3 text-sm">
      <TriangleAlert className="size-4 text-seal" />
      <span className="flex-1">{error instanceof Error ? error.message : "Something went wrong."}</span>
      {retry ? <Button size="sm" onClick={retry}>Try again</Button> : null}
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
