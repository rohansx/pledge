/**
 * @pledge/safe-fetch — public contract.
 *
 * INVARIANT: this package imports nothing from @pledge/db and nothing from the app. The
 * types below intentionally duplicate the contract published in packages/db/src/types.ts —
 * that duplication is the boundary, not an oversight. If the two ever disagree,
 * packages/db is the source of truth and this file is wrong.
 */

export interface SafeFetchOptions {
  /** Total budget across all redirect hops. Default 10_000ms. */
  readonly timeoutMs?: number;
  /** Hard cap on bytes read from the body. Default 5 * 1024 * 1024. */
  readonly maxBodyBytes?: number;
  /** Manual redirects only. Default 3. Every hop revalidates the resolved IP. */
  readonly maxRedirects?: number;
  /**
   * Request headers. safe-fetch never adds credentials, cookies, or auth of its own, and
   * rejects any credential-bearing header supplied here (control 5). `user-agent` supplied
   * here is ignored — the probe UA is not overridable.
   */
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "HEAD";
  readonly signal?: AbortSignal;
}

/** A completed observation. Reaching this value means bytes came back from the target. */
export interface SafeFetchResponse {
  readonly status: number;
  /** Allowlisted response headers only — see RESPONSE_HEADER_ALLOWLIST. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly bodySha256: string;
  readonly bodyBytes: number;
  /**
   * Always false. safe-fetch errors on an over-cap body rather than truncating: a truncated
   * body can make a content check observe FALSE for a reason that has nothing to do with the
   * done-condition, which is precisely the `fail`-instead-of-`error` bug I-7 forbids.
   * Retained because the shared contract in packages/db declares it.
   */
  readonly truncated: boolean;
  /** The validated IP actually connected to on the final hop. */
  readonly resolvedIp: string;
  readonly finalUrl: string;
  /** Every URL requested, in order: [originalUrl, ...redirectTargets]. Length >= 1. */
  readonly redirectChain: readonly string[];
  readonly durationMs: number;
}

/** Every one of these maps to ProbeOutcome 'error' at the call site. Never to 'fail'. */
export type SafeFetchErrorCode =
  | "dns_failure"
  | "blocked_address"
  | "blocked_scheme"
  | "too_many_redirects"
  | "timeout"
  | "connection_failed"
  | "body_too_large"
  | "upstream_unavailable"
  | "rate_limited"
  | "unexpected";

/**
 * Thrown when the target could not be observed.
 *
 * A caller that catches this has learned nothing about the done-condition. Mapping it to
 * `fail` marks someone as having missed because of a network blip — see I-7.
 *
 * Code groups, for callers that want coarser buckets than the ten codes:
 *   BLOCKED   — blocked_address | blocked_scheme   (SSRF policy said no; never retry as-is)
 *   TIMEOUT   — timeout
 *   DNS       — dns_failure
 *   TOO_LARGE — body_too_large
 *   TRANSPORT — connection_failed | upstream_unavailable | too_many_redirects | rate_limited
 */
export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  readonly resolvedIp?: string;

  constructor(code: SafeFetchErrorCode, message: string, resolvedIp?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SafeFetchError";
    this.code = code;
    this.resolvedIp = resolvedIp;
  }
}

export const BLOCKED_CODES: readonly SafeFetchErrorCode[] = [
  "blocked_address",
  "blocked_scheme",
];

export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>;

/** One resolved, policy-approved address. The only thing safe-fetch will connect to. */
export interface PinnedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Injectable so the SSRF corpus can be tested without touching a real resolver. */
export type DnsResolver = (
  hostname: string,
) => Promise<ReadonlyArray<{ readonly address: string; readonly family: number }>>;
