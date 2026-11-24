import { ChevronRight, CircleX, Pause, Play, RotateCcw, SkipForward, Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "./ui.tsx";
import type { RecordingStep } from "../types.ts";

const STEP_MS = 900; // ponytail: fixed pace per step; real gaps are shown as +ms labels instead of waited out

/** A step's text split into the request it names and what came back, so the row can show the outcome as a chip.
 *  The API writes "<where> → <status>" for a client step and "<where>: <story>" for a lost reply. */
function parts(step: RecordingStep): [string, string] {
  if (step.actor === "check") {
    const found = step.text.match(/\((expected .*)\)$/s); // the statement is already the page title; keep the numbers
    return [found ? `Pledge broken: ${found[1]}` : step.text, ""];
  }
  const arrow = step.text.lastIndexOf(" → ");
  if (step.actor === "client" && arrow > 0) return [step.text.slice(0, arrow), step.text.slice(arrow + 3)];
  const colon = step.text.indexOf(": ");
  return colon > 0 ? [step.text.slice(0, colon), step.text.slice(colon + 2)] : [step.text, ""];
}

function Outcome({ step, rest }: { step: RecordingStep; rest: string }) {
  if (step.actor === "fault") {
    const got = rest.match(/answered (\d+).*got (\d+)/);
    return got ? <span className="whitespace-nowrap rounded-md bg-amber-wash px-1.5 font-mono text-[11px] leading-5 text-amber">app {got[1]} · client got {got[2]}</span> : null;
  }
  if (!rest) return null;
  const ok = /^[23]/.test(rest);
  return <span className={`whitespace-nowrap rounded-md px-1.5 font-mono text-[11px] leading-5 ${ok ? "bg-kept-wash text-kept" : "bg-seal-wash text-seal"}`}>{rest}</span>;
}

const ICON = {
  client: <ChevronRight className="size-3.5 text-mute" />,
  fault: <Unplug className="size-3.5 text-amber" />,
  check: <CircleX className="size-3.5 text-seal" />,
};

interface RecordingProps {
  steps: RecordingStep[];
  journey: string;
  seed: number;
}

/** One broken journey played back request by request, as the fault proxy saw it. */
export function Recording({ steps, journey, seed }: RecordingProps) {
  const [shown, setShown] = useState(steps.length);
  const [playing, setPlaying] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    if (!playing) return;
    if (shown >= steps.length) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, shown, steps.length]);

  const play = () => {
    setShown(shown >= steps.length ? 0 : shown);
    setPlaying(true);
  };
  const done = shown >= steps.length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-y border-line bg-paper-2/50 px-5 py-2.5">
        {playing
          ? <Button size="sm" onClick={() => setPlaying(false)}><Pause className="size-3.5" />Pause</Button>
          : <Button size="sm" variant="default" onClick={play}>{done ? <RotateCcw className="size-3.5" /> : <Play className="size-3.5" />}{done ? "Replay" : "Play"}</Button>}
        <Button size="sm" variant="ghost" disabled={playing || done} onClick={() => setShown((n) => n + 1)}><SkipForward className="size-3.5" />Step</Button>
        <div className="ml-auto flex min-w-[160px] items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full bg-ink transition-[width]" style={{ width: `${(100 * Math.min(shown, steps.length)) / steps.length}%` }} /></div>
          <span className="text-xs text-mute tabular-nums">{Math.min(shown, steps.length)}/{steps.length}</span>
        </div>
      </div>
      <ol aria-live="polite">
        {steps.slice(0, shown).map((step, index) => {
          const [where, rest] = parts(step);
          const look = step.actor === "fault" ? "shadow-[inset_2px_0_0_var(--amber)]" : step.actor === "check" ? "bg-seal-wash shadow-[inset_2px_0_0_var(--seal)]" : "";
          return (
            <li key={index} className={`border-b border-line last:border-b-0 ${look}`}>
              <button type="button" disabled={!step.detail} aria-expanded={step.detail ? open === index : undefined} onClick={() => setOpen(open === index ? null : index)} className="grid w-full grid-cols-[58px_16px_minmax(0,1fr)] items-start gap-x-3 gap-y-1 px-5 py-2 text-left hover:bg-paper-2/50 disabled:cursor-default disabled:hover:bg-transparent">
                <span className="pt-px text-right font-mono text-[11px] text-mute tabular-nums">+{step.at}ms</span>
                <span className="pt-0.5">{ICON[step.actor]}</span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className={step.actor === "check" ? "text-[13px] font-medium text-seal [overflow-wrap:anywhere]" : "break-all font-mono text-xs"}>{where}</span>
                  <Outcome step={step} rest={rest} />
                </span>
              </button>
              {open === index && step.detail ? (
                <div className="grid gap-2 px-5 pb-3 pl-[109px] sm:grid-cols-2">
                  {[["Sent", step.detail.request], ["App replied", step.detail.reply]].map(([label, body]) => (
                    <div key={label}>
                      <p className="mb-1 text-[11px] font-medium text-mute">{label}</p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-paper-2 p-2.5 font-mono text-[11px] text-ink-2">{body || "(empty)"}</pre>
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line bg-paper-2/50 px-5 py-2.5 text-xs text-mute">Journey <span className="font-mono">{journey}</span> on seed {seed}. Amber rows are replies the proxy dropped after the app did the work. Bodies are cut to 300 characters, secret-looking fields masked; the app's own calls to its dependencies are not shown.</p>
    </div>
  );
}
