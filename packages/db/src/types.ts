/**
 * Shared v0 contracts.
 *
 * apps/web and apps/worker both import from here. These types are the seam between agents
 * working in parallel: implement AGAINST them, do not edit them. If one is wrong, report it
 * rather than changing it — a silent edit here desynchronises everyone who already built on
 * the old shape.
 *
 * This module is types + Zod schemas only. It must not import Drizzle, a database client, or
 * anything Node-only, so it can be pulled into a browser bundle for form validation.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------
// Commitment status
// ---------------------------------------------------------------------------------------

/**
 * technical-spec.md §6.
 *
 * `kept` and `missed` may only ever be written by the probe worker. No code path in
 * apps/web may assign them — scripts/check-invariants.mjs fails the build if one does
 * (CLAUDE.md I-1). Reading and rendering them in apps/web is expected and fine.
 */
export const commitmentStatuses = ["open", "kept", "missed", "abandoned", "disputed"] as const;
export const CommitmentStatusSchema = z.enum(commitmentStatuses);
export type CommitmentStatus = (typeof commitmentStatuses)[number];

// ---------------------------------------------------------------------------------------
// Probe outcome
// ---------------------------------------------------------------------------------------

/**
 * INVARIANT I-2 / I-7 — the one that matters most in this file.
 *
 *   pass  — the target was observed AND the done-condition is TRUE
 *   fail  — the target was observed AND the done-condition is FALSE
 *   error — the target could NOT be observed (DNS failure, timeout, connection refused,
 *           5xx from the API we query, SSRF block, anything at all that means "we do not
 *           know"). An error is not a fail. It never resolves a commitment.
 *
 * Collapsing `error` into `fail` marks people as having missed because of a network blip.
 * That is the single most reputation-destroying bug this product could ship. When in doubt
 * between the two, it is `error`.
 */
export const probeOutcomes = ["pass", "fail", "error"] as const;
export const ProbeOutcomeSchema = z.enum(probeOutcomes);
export type ProbeOutcome = (typeof probeOutcomes)[number];

// ---------------------------------------------------------------------------------------
// Probe kinds — v0 has exactly two, hardcoded. No DSL, no parser (roadmap.md v0).
// ---------------------------------------------------------------------------------------

export const probeKinds = ["http_status", "github_release_tag"] as const;
export const ProbeKindSchema = z.enum(probeKinds);
export type ProbeKind = (typeof probeKinds)[number];

// ---------------------------------------------------------------------------------------
// DoneSpecV0 — the machine-checkable done-condition
// ---------------------------------------------------------------------------------------

/**
 * `http(url).status == expectedStatus`.
 *
 * `url` is user-supplied and therefore hostile input (architecture.md §4, zone 0). It is
 * https-only here because that is the first SSRF control (security.md T-01, control 4); the
 * remaining controls live in @pledge/safe-fetch and are not optional because this passed.
 */
export const HttpStatusSpecSchema = z.object({
  kind: z.literal("http_status"),
  url: z.url({ protocol: /^https$/ }),
  expectedStatus: z.int().min(100).max(599),
});
export type HttpStatusSpec = z.infer<typeof HttpStatusSpecSchema>;

/**
 * `github.release(repo).tag matches pattern`.
 *
 * `repo` is `owner/name`. `tagPattern` is a glob with `*` as the only wildcard — NOT a
 * regex. A user-supplied regex is a ReDoS primitive and v0 has no reason to accept one.
 * Match semantics belong to the worker; this schema only fixes the wire shape.
 *
 * A segment of `.` or `..` is rejected, and that refusal is an I-7 control rather than
 * tidiness. The probe interpolates these two segments into an api.github.com path, and
 * `encodeURIComponent` leaves dots alone, so `../..` survives into the URL and the WHATWG
 * parser then collapses it: `/repos/../..` becomes `/`, which answers 200. The probe reads
 * that 200 as "the repo is visible and has no release" and records `fail` — a target it never
 * observed, resolved as a miss. GitHub has no such owner or repository, so nothing legitimate
 * is lost; `owner/.github` and other dot-prefixed names still pass.
 */
export const GithubReleaseTagSpecSchema = z.object({
  kind: z.literal("github_release_tag"),
  repo: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, {
      message: "repo must be in owner/name form",
    })
    .refine((repo) => !repo.split("/").some((segment) => /^\.+$/.test(segment)), {
      message: "repo segments must not be . or ..",
    }),
  tagPattern: z.string().min(1).max(200),
});
export type GithubReleaseTagSpec = z.infer<typeof GithubReleaseTagSpecSchema>;

/**
 * The v0 done-spec. Discriminated on `kind`, which is also `probe_run.probe_kind`.
 *
 * done_spec rows are immutable and content-addressed (CLAUDE.md I-4): the row's primary key
 * is a hash over the canonical form of one of these. Never mutate a stored spec — an edited
 * spec is a different hash and therefore a different commitment.
 */
export const DoneSpecV0Schema = z.discriminatedUnion("kind", [
  HttpStatusSpecSchema,
  GithubReleaseTagSpecSchema,
]);
export type DoneSpecV0 = z.infer<typeof DoneSpecV0Schema>;

/** Pins evaluation semantics. v0 specs always evaluate under v0 rules. */
export const SPEC_VERSION_V0 = 0 as const;

// ---------------------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------------------

/**
 * What a probe run recorded about the observation, stored in `probe_run.evidence`.
 *
 * Everything here is a fact about what was seen, never a conclusion. Present on a `pass` or
 * a `fail`; on an `error` most fields are absent and `error` carries the reason — that
 * asymmetry is the point, an error observed nothing.
 *
 * Only whitelisted headers are kept: a target's response is bytes + status + a header
 * subset, never something we deserialise into a typed object (architecture.md §4).
 */
export const EVIDENCE_HEADER_ALLOWLIST = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
  "location",
  "server",
] as const;

export const ProbeEvidenceSchema = z.object({
  /** HTTP status observed, when a response was received at all. */
  status: z.int().min(100).max(599).optional(),
  /** Response headers narrowed to EVIDENCE_HEADER_ALLOWLIST, lowercased keys. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Lowercase hex sha256 of the response body as received. */
  bodySha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Byte length of the body actually read (capped by the fetch budget). */
  bodyBytes: z.int().min(0).optional(),
  /** The specific substrings/values that satisfied the done-condition, verbatim. */
  matches: z.array(z.string()).optional(),
  /** The IP the request was actually pinned to. The SSRF audit trail. */
  resolvedIp: z.string().optional(),
  /** Final URL after manual redirects, if it differs from the requested one. */
  finalUrl: z.string().optional(),
  /**
   * Set ONLY on outcome 'error'. A machine-readable reason we could not observe the target.
   * Its presence must never be read as "the condition was false".
   */
  error: z
    .object({
      code: z.enum([
        "dns_failure",
        "blocked_address",
        "blocked_scheme",
        "too_many_redirects",
        "timeout",
        "connection_failed",
        "body_too_large",
        "upstream_unavailable",
        "rate_limited",
        "unexpected",
      ]),
      message: z.string(),
    })
    .optional(),
});
export type ProbeEvidence = z.infer<typeof ProbeEvidenceSchema>;

/** What the worker produces for one probe run, before it is written to `probe_run`. */
export interface ProbeResult {
  readonly probeKind: ProbeKind;
  readonly outcome: ProbeOutcome;
  readonly evidence: ProbeEvidence;
  /** Wall-clock observation time. Bounded against Postgres now() to reject clock skew. */
  readonly ranAt: Date;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------------------
// @pledge/safe-fetch public interface
// ---------------------------------------------------------------------------------------

/**
 * Declared here so apps/worker and packages/safe-fetch agree without either importing the
 * other's internals.
 *
 * packages/safe-fetch MUST NOT import this module (CLAUDE.md I-6 / invariant I4): it depends
 * on nothing in packages/db. It declares its own structurally identical types and this stays
 * the contract both sides are checked against.
 */
export interface SafeFetchOptions {
  /** Total budget across all redirect hops. Default 10_000ms. */
  readonly timeoutMs?: number;
  /** Hard cap on bytes read from the body. Default 5 * 1024 * 1024. */
  readonly maxBodyBytes?: number;
  /** Manual redirects only. Default 3. Every hop revalidates the resolved IP. */
  readonly maxRedirects?: number;
  /** Request headers. safe-fetch never adds credentials, cookies, or auth of its own. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: "GET" | "HEAD";
  readonly signal?: AbortSignal;
}

/** A completed observation. Reaching this value means bytes came back from the target. */
export interface SafeFetchResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly bodySha256: string;
  readonly truncated: boolean;
  readonly resolvedIp: string;
  readonly finalUrl: string;
  readonly durationMs: number;
}

/** Reasons safe-fetch could not observe the target. Every one of these maps to `error`. */
export type SafeFetchErrorCode = NonNullable<ProbeEvidence["error"]>["code"];

/**
 * Thrown when the target could not be observed. Callers map this to ProbeOutcome 'error' —
 * NEVER to 'fail'. A blocked address, a timeout and a DNS failure are all "we do not know".
 */
export interface SafeFetchFailure extends Error {
  readonly code: SafeFetchErrorCode;
  /** Populated when the failure happened after DNS resolution. */
  readonly resolvedIp?: string;
}

/**
 * The only permitted way to fetch a user-supplied URL (CLAUDE.md I-5).
 *
 * Rejects (throws SafeFetchFailure) rather than returning a status for: non-https schemes,
 * credentials in the URL, any hostname resolving into a blocked range, a redirect chain
 * longer than maxRedirects, and a redirect hop whose IP is blocked.
 */
export type SafeFetch = (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResponse>;
