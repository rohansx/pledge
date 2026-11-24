import { useSyncExternalStore } from "react";

import type { RunEvent } from "./types.ts";

const TOKEN_KEY = "pledge-token";
const listeners = new Set<() => void>();

/** The API said the session is missing or no longer valid. The app answers by asking to sign in. */
export class Unauthorized extends Error {}

// Sign-in is one shared token kept in localStorage until GitHub sign-in replaces it with a session cookie.
// Everything that needs the session goes through this module, so that swap touches nothing else.
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY);
    else localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Private windows may refuse storage; the session then lasts until the page is reloaded.
  }
  for (const listener of listeners) listener();
}

export function useSignedIn(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => getToken() !== null,
  );
}

function headers(token: string | null, json = false): Record<string, string> {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json ? { "content-type": "application/json" } : {}) };
}

export async function api<T>(path: string, options: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = options.token ?? getToken();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { method: options.method ?? "GET", headers: headers(token, options.body !== undefined), body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  } catch {
    throw new Error("The Pledge API could not be reached. Check your connection and try again.");
  }
  if (response.status === 401) {
    if (!options.token) setToken(null); // a stored token that stopped working signs the browser out
    throw new Unauthorized("That token was not accepted.");
  }
  const body = (await response.json().catch(() => null)) as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !body?.success) throw new Error(body?.error ? `${body.error[0]!.toUpperCase()}${body.error.slice(1)}.` : `The API answered HTTP ${response.status}.`);
  return body.data as T;
}

/** Read a run's Server-Sent Events from `after` until it finishes or the stream drops. EventSource cannot
 *  send the token, so the stream is read with fetch. Resolves true when the run finished, false on a drop. */
export async function streamRun(runId: string, after: number, onEvent: (event: RunEvent) => void, signal: AbortSignal): Promise<boolean> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}`, { headers: headers(getToken()), signal });
  if (!response.ok || !response.body) return false;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return false;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      const type = field("event");
      const data = field("data");
      if (!type || !data) continue; // a keep-alive comment
      let parsed: RunEvent["data"];
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      onEvent({ seq: Number(field("id") ?? 0), type: type as RunEvent["type"], data: parsed });
      if (type === "run_finished") return true;
    }
  }
}
