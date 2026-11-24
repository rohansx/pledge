import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { getToken } from "../api.ts";
import type { BrowserMedia } from "../types.ts";

// Playwright's trace viewer, copied into the image at build time (see apps/web/Dockerfile).
const VIEWER = "/trace/index.html";
const VIEWER_START_MS = 300; // from the frame's load event to the viewer listening for messages

/** One file of a run's recording. Media elements and the viewer cannot send the token, so the file is
 *  fetched here and handed to them: as an object URL, and as the blob itself for the viewer. */
function useMedia(runId: string, name: string, enabled: boolean) {
  return useQuery({
    queryKey: ["media", runId, name],
    enabled,
    staleTime: Infinity,
    gcTime: Infinity, // the URL stays valid for the life of the page; a recording is a few MB
    queryFn: async () => {
      const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/media/${name}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
      if (!response.ok) throw new Error(`The recording could not be loaded (HTTP ${response.status}).`);
      const blob = await response.blob();
      return { blob, url: URL.createObjectURL(blob) };
    },
  });
}

/** The viewer ignores blob: addresses in its URL but takes a trace by message, once its page has started. */
function showTrace(frame: HTMLIFrameElement, trace: Blob): void {
  window.setTimeout(() => frame.contentWindow?.postMessage({ method: "load", params: { trace } }, window.location.origin), VIEWER_START_MS);
}

/** What the broken journey's user sees afterwards: a video, and the full recording with the page, every
 *  network call and the console at each moment. */
export function BrowserRecording({ browser }: { browser: BrowserMedia }) {
  const [inspect, setInspect] = useState(false);
  const has = (name: string) => browser.files.includes(name);
  const video = useMedia(browser.runId, "video.webm", has("video.webm"));
  const shot = useMedia(browser.runId, "screenshot.png", has("screenshot.png"));
  const trace = useMedia(browser.runId, "trace.zip", inspect && has("trace.zip"));
  const failed = video.error ?? shot.error ?? trace.error;
  return (
    <section className="rounded-xl border border-line bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">What the user sees</h2>
          <p className="mt-1 max-w-[70ch] text-sm text-ink-2">
            A browser signed in as the user of journey <span className="font-mono text-xs">{browser.journey}</span> on seed {browser.seed}, after the journey ran. It only looks: nothing in it causes the problem.
          </p>
        </div>
        {has("trace.zip") ? (
          <button type="button" onClick={() => setInspect(!inspect)} aria-expanded={inspect} className="h-8 rounded-md border border-line px-3 text-xs font-medium hover:border-mute">
            {inspect ? "Back to the video" : "Inspect page, network and console"}
          </button>
        ) : null}
      </div>
      {failed ? <p role="alert" className="mt-4 text-sm text-seal">{failed.message}</p> : null}
      {inspect ? (
        trace.data ? (
          <iframe title="Recording of the browser session" src={VIEWER} onLoad={(event) => showTrace(event.currentTarget, trace.data.blob)} className="mt-4 h-[720px] w-full rounded-md border border-line bg-white" />
        ) : (
          <p className="mt-4 text-sm text-mute">Loading the recording…</p>
        )
      ) : video.data ? (
        <video src={video.data.url} poster={shot.data?.url} controls muted playsInline className="mt-4 w-full rounded-md border border-line bg-black" />
      ) : shot.data ? (
        <img src={shot.data.url} alt="The last screen of the browser session" className="mt-4 w-full rounded-md border border-line" />
      ) : failed ? null : (
        <p className="mt-4 text-sm text-mute">Loading…</p>
      )}
    </section>
  );
}
