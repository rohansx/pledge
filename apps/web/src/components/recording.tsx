import { useEffect, useState } from "react";

import { Button } from "./ui.tsx";
import type { RecordingStep } from "../types.ts";

const STEP_MS = 900; // ponytail: fixed pace per step; real gaps are shown as +ms labels instead of waited out

const LOOK: Record<RecordingStep["actor"], { label: string; mark: string; row: string }> = {
  client: { label: "client", mark: "bg-idle", row: "" },
  fault: { label: "reply lost", mark: "bg-amber", row: "bg-amber-wash" },
  check: { label: "broken", mark: "bg-seal", row: "bg-seal-wash font-medium" },
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

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        {playing ? <Button onClick={() => setPlaying(false)}>Pause</Button> : <Button kind="solid" onClick={play}>{shown >= steps.length ? "Replay" : "Play"}</Button>}
        <Button disabled={playing || shown >= steps.length} onClick={() => setShown((n) => n + 1)}>Step</Button>
        <span className="font-mono text-xs text-mute">journey {journey} · seed {seed} · step {Math.min(shown, steps.length)} of {steps.length}</span>
      </div>
      <ol className="mt-3 border-t border-line">
        {steps.slice(0, shown).map((step, index) => (
          <li key={index} className={`border-b border-line ${LOOK[step.actor].row}`}>
            <button type="button" disabled={!step.detail} onClick={() => setOpen(open === index ? null : index)} className="grid w-full grid-cols-[64px_96px_1fr] items-baseline gap-3 px-2 py-2 text-left text-sm disabled:cursor-default">
              <span className="font-mono text-[11px] text-mute">+{step.at} ms</span>
              <span className="flex items-center gap-1.5 font-mono text-[11px] text-ink-2"><span className={`inline-block size-2 rounded-full ${LOOK[step.actor].mark}`} />{LOOK[step.actor].label}</span>
              <span className="break-words">{step.text}</span>
            </button>
            {open === index && step.detail ? (
              <div className="grid gap-2 px-2 pb-3 sm:grid-cols-2">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-line p-2 font-mono text-[11px] text-ink-2">sent {step.detail.request || "(empty)"}</pre>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-sm border border-line p-2 font-mono text-[11px] text-ink-2">app replied {step.detail.reply || "(empty)"}</pre>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <p className="mt-2 max-w-[70ch] font-mono text-[11px] text-mute">Recorded by the fault proxy in the sandbox. Bodies are cut to 300 characters and fields that look secret are masked. Calls the app made to its own dependencies are not in it.</p>
    </div>
  );
}
