"use client";

/**
 * An instant, rendered in the reader's zone.
 *
 * Server-rendered as UTC with the zone stated, then upgraded in place after hydration. Doing
 * it in that order rather than client-only is what keeps `/[handle]` a 200 with JS disabled
 * and crawlable — a v0 exit criterion — while still showing a human their own clock.
 *
 * The committer's zone is not stored in v0 (no column for it), so "the reader's zone" is the
 * committer's zone for the person who made the commitment and an honest local rendering for
 * everyone else. The `<time dateTime>` attribute always carries the unambiguous instant.
 */
import { useEffect, useState } from "react";

interface LocalTimeProps {
  /** ISO 8601 with offset. */
  iso: string;
  /** Server-rendered text. Shown until hydration, and forever without JS. */
  fallback: string;
}

export function LocalTime({ iso, fallback }: LocalTimeProps) {
  const [local, setLocal] = useState<string | undefined>(undefined);

  useEffect(() => {
    setLocal(
      new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short",
      }).format(new Date(iso)),
    );
  }, [iso]);

  return <time dateTime={iso}>{local ?? fallback}</time>;
}
