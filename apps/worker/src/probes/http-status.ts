/**
 * `http(url).status == expectedStatus`.
 *
 * The URL is user-supplied and therefore hostile (architecture.md §4, zone 0), so it goes
 * through @pledge/safe-fetch and nothing else — no bare fetch, no axios, no raw undici
 * (CLAUDE.md I-5). A second HTTP path around safe-fetch is how the SSRF defence dies.
 */
import type { HttpStatusSpec, ProbeResult } from "@pledge/db/types";
import { SafeFetchError, type SafeFetch, type SafeFetchResponse } from "@pledge/safe-fetch";
import { notObserved, observed, type ObservationErrorCode, type Timing } from "./result";

const KIND = "http_status" as const;

export async function probeHttpStatus(
  spec: HttpStatusSpec,
  safeFetch: SafeFetch,
  timing: Timing,
): Promise<ProbeResult> {
  let response: SafeFetchResponse;
  try {
    response = await safeFetch(spec.url, { method: "GET" });
  } catch (error: unknown) {
    // Everything safe-fetch throws means "we did not see the target": a blocked address, a
    // timeout, a refused connection, a body over the cap. None of them say anything about
    // whether the done-condition holds, so none of them may become `fail`.
    return notObserved(
      KIND,
      errorCodeOf(error),
      errorMessageOf(error),
      partialFrom(error),
      timing,
    );
  }

  // We have a status line. From here on the outcome is an observation either way.
  const holds = response.status === spec.expectedStatus;
  return observed(
    KIND,
    holds,
    {
      status: response.status,
      headers: response.headers,
      bodySha256: response.bodySha256,
      bodyBytes: response.bodyBytes,
      resolvedIp: response.resolvedIp,
      finalUrl: response.finalUrl,
      ...(holds ? { matches: [String(response.status)] } : {}),
    },
    timing,
  );
}

function errorCodeOf(error: unknown): ObservationErrorCode {
  return error instanceof SafeFetchError ? error.code : "unexpected";
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A resolved IP is a fact about the attempt worth keeping even when nothing was observed. */
function partialFrom(error: unknown): { resolvedIp?: string } {
  return error instanceof SafeFetchError && error.resolvedIp !== undefined
    ? { resolvedIp: error.resolvedIp }
    : {};
}
