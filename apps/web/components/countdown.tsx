"use client";

/**
 * Time remaining until a deadline. Ticks once a minute — a per-second countdown on a
 * multi-day deadline is theatre, and the product has no interest in urgency.
 *
 * Renders the static server text until hydration so the page is complete without JS.
 */
import { useEffect, useState } from "react";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface CountdownProps {
  deadlineIso: string;
  /** Server-rendered text; also what shows with JS disabled. */
  fallback: string;
}

export function Countdown({ deadlineIso, fallback }: CountdownProps) {
  const [text, setText] = useState<string | undefined>(undefined);

  useEffect(() => {
    const deadline = new Date(deadlineIso).getTime();
    const tick = () => {
      setText(remaining(deadline - Date.now()));
    };
    tick();
    const id = setInterval(tick, MINUTE);
    return () => {
      clearInterval(id);
    };
  }, [deadlineIso]);

  return <span>{text ?? fallback}</span>;
}

function remaining(ms: number): string {
  if (ms <= 0) return "deadline passed";
  if (ms >= DAY) {
    const days = Math.floor(ms / DAY);
    return `${days} ${days === 1 ? "day" : "days"} left`;
  }
  if (ms >= HOUR) {
    const hours = Math.floor(ms / HOUR);
    return `${hours} ${hours === 1 ? "hour" : "hours"} left`;
  }
  const minutes = Math.max(1, Math.floor(ms / MINUTE));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} left`;
}
