/**
 * @pledge/safe-fetch — the only permitted way to fetch a user-supplied URL (CLAUDE.md I-5).
 *
 * Required controls (security.md T-01, technical-spec.md §5) — all of them, not a subset:
 *   1. Resolve DNS, validate EVERY returned A/AAAA, connect to the validated IP rather than
 *      the hostname. This is what closes the rebinding window. See policy.resolveAndPin.
 *   2. Allowlist of address ranges, v4 and v6, incl. v4-mapped and NAT64. See policy.ts.
 *   3. Manual redirects, max 3, full re-resolution + revalidation at every hop.
 *   4. https only; no credentials in the URL; no fragment.
 *   5. Never attach cookies, tokens, or auth headers — and refuse to let a caller add one.
 *   6. 5 MB body cap streamed, headersTimeout 5s, bodyTimeout 10s, and a 10s total budget
 *      enforced by us, independently of undici's own timers.
 *   7. Identifiable UA.
 *
 * security.md is blunt that controls 1-6 will eventually have a bypass and that the worker's
 * isolation is what contains it. That is a reason to make the bypass expensive, not cheap.
 */

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import type { Readable } from "node:stream";

import { Agent, request } from "undici";

import {
  DEFAULT_ALLOWED_PROTOCOLS,
  isPublicUnicastAddress,
  parseTargetUrl,
  resolveAndPin,
  type AddressPolicy,
} from "./policy";
import {
  SafeFetchError,
  type DnsResolver,
  type PinnedAddress,
  type SafeFetch,
  type SafeFetchResponse,
} from "./types";

export * from "./types";
export {
  isPublicUnicastAddress,
  parseTargetUrl,
  resolveAndPin,
  DEFAULT_ALLOWED_PROTOCOLS,
} from "./policy";
export type { AddressPolicy } from "./policy";

/** Control 7. An operator who wants us gone can identify and block one UA and one egress IP. */
const USER_AGENT = "pledge-probe/0.1 (+https://pledge.sh/probe)";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const HEADERS_TIMEOUT_MS = 5_000;
const BODY_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Response headers from an arbitrary third-party target are a PII surface with no upside, so
 * only these survive into evidence. Matches EVIDENCE_HEADER_ALLOWLIST in packages/db.
 */
const RESPONSE_HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "last-modified",
  "etag",
  "location",
  "server",
]);

/**
 * Control 5. undici attaches no cookies or auth of its own — this stops a caller from
 * reintroducing them through `options.headers`. Refusing loudly beats silently stripping:
 * a probe that needs a credential is a design mistake upstream, not something to paper over.
 */
const FORBIDDEN_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-api-key",
  "x-auth-token",
  "x-amz-security-token",
  "metadata-flavor",
]);

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/**
 * Test seam. Production code uses the exported `safeFetch`, which takes none of these.
 *
 * Tests need two holes and no more: a stub resolver (so the T-01 corpus runs with no
 * network), and — for the happy path, redirect and body-cap tests — permission to reach a
 * plaintext loopback server. The SSRF corpus tests use the real protocol list and the real
 * address policy; only DNS is stubbed there.
 */
export interface SafeFetchPolicy {
  readonly resolve?: DnsResolver;
  readonly allowedProtocols?: readonly string[];
  readonly isAddressAllowed?: AddressPolicy;
}

const defaultResolve: DnsResolver = (hostname) =>
  dnsLookup(hostname, { all: true, verbatim: true });

export function createSafeFetch(policy: SafeFetchPolicy = {}): SafeFetch {
  const resolve = policy.resolve ?? defaultResolve;
  const allowedProtocols = policy.allowedProtocols ?? DEFAULT_ALLOWED_PROTOCOLS;
  const isAddressAllowed = policy.isAddressAllowed ?? isPublicUnicastAddress;

  return async function safeFetchImpl(rawUrl, options = {}): Promise<SafeFetchResponse> {
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const method = assertSafeMethod(options.method);
    const headers = buildRequestHeaders(options.headers);

    // Control 6: our own budget, spanning every redirect hop. undici's headersTimeout and
    // bodyTimeout are per-hop and per-idle-gap; four hops that each answer in 4s would sail
    // past both while taking 16 seconds of a worker's life.
    const budget = new AbortController();
    const timer = setTimeout(() => budget.abort(), timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([budget.signal, options.signal])
      : budget.signal;

    try {
      let url = parseTargetUrl(rawUrl, allowedProtocols);
      const redirectChain: string[] = [url.href];

      for (let hop = 0; ; hop += 1) {
        if (hop > maxRedirects) {
          throw new SafeFetchError("too_many_redirects", `exceeded ${maxRedirects} redirects`);
        }

        // Every hop re-resolves and re-validates from scratch. Hop 2 inheriting hop 1's
        // verdict is exactly the rebinding-across-a-redirect hole.
        //
        // The resolve is raced against the budget. Without this it sits OUTSIDE the deadline
        // entirely — the AbortController only reaches undici — so a target whose nameserver
        // stalls holds a worker for `dns.timeout x attempts` per hop, no matter what
        // timeoutMs says. Honest residual: this stops the *caller* waiting, but the
        // underlying lookup keeps its libuv threadpool slot until the resolver gives up.
        // Bounding that needs a resolver with its own timeout, which is a dns.Resolver
        // change, not a change here.
        const pinned = await raceBudget(
          resolveAndPin(url.hostname, resolve, isAddressAllowed),
          budget.signal,
          timeoutMs,
        );
        const agent = createPinnedAgent(pinned);

        try {
          const response = await request(url, {
            dispatcher: agent,
            method,
            headers,
            signal,
            headersTimeout: HEADERS_TIMEOUT_MS,
            bodyTimeout: BODY_TIMEOUT_MS,
            // undici 8 does not follow redirects unless the redirect interceptor is added.
            // It is not added, deliberately — see the manual hop loop above.
          }).catch((cause: unknown) => {
            throw toSafeFetchError(cause, budget.signal.aborted, timeoutMs, pinned.address);
          });

          const safeHeaders = pickAllowedHeaders(response.headers);
          const location = safeHeaders["location"];

          if (REDIRECT_STATUSES.has(response.statusCode) && location !== undefined) {
            await response.body.dump().catch(() => undefined);
            const next = parseTargetUrl(location, allowedProtocols, url.href);
            url = next;
            redirectChain.push(next.href);
            continue;
          }

          const declaredLength = Number(safeHeaders["content-length"]);
          if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
            await response.body.dump().catch(() => undefined);
            throw new SafeFetchError(
              "body_too_large",
              `Content-Length ${declaredLength} exceeds the ${maxBodyBytes} byte cap`,
              pinned.address,
            );
          }

          const body = await readCappedBody(
            response.body,
            maxBodyBytes,
            pinned.address,
            budget.signal,
            timeoutMs,
          );

          return {
            status: response.statusCode,
            headers: safeHeaders,
            body: body.bytes,
            bodySha256: body.sha256,
            bodyBytes: body.bytes.byteLength,
            truncated: false,
            resolvedIp: pinned.address,
            finalUrl: url.href,
            redirectChain,
            durationMs: Date.now() - startedAt,
          };
        } finally {
          await agent.destroy().catch(() => undefined);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The production client. No policy holes. */
export const safeFetch: SafeFetch = createSafeFetch();

/**
 * One Agent — so one connection pool, so one socket — per hop, with DNS already decided.
 *
 * ponytail: no pooling across requests. Probe volume is a handful of requests per commitment
 * per day; a pooled agent keyed by pinned IP is the upgrade if that ever stops being true.
 * Not pooling is also a small security win: no socket is ever reused across hostnames.
 */
function createPinnedAgent(pinned: PinnedAddress): Agent {
  return new Agent({
    connect: {
      // The address is already resolved AND validated. This callback must never re-resolve:
      // a second lookup is a second chance for the answer to change (DNS rebinding), and it
      // would also be a lookup whose result nothing checks.
      //
      // Node calls back in two shapes depending on autoSelectFamily. We pin it off below, so
      // `all` should always be false — the array branch is here so a Node default flip is a
      // no-op rather than a silent connect failure.
      lookup: (_hostname, lookupOptions, callback) => {
        if (lookupOptions.all === true) {
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        } else {
          callback(null, pinned.address, pinned.family);
        }
      },
      autoSelectFamily: false,
      timeout: CONNECT_TIMEOUT_MS,
    },
    headersTimeout: HEADERS_TIMEOUT_MS,
    bodyTimeout: BODY_TIMEOUT_MS,
    connections: 1,
    pipelining: 0,
  });
}

/** Methods a probe is allowed to use. A probe observes; it never acts on the target. */
const SAFE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The `method` union in SafeFetchOptions is compile-time only, and safe-fetch is an exported
 * MIT package whose callers will not all be TypeScript. A probe that POSTs to a
 * user-supplied URL turns an observation tool into a request-forgery tool aimed at whatever
 * the committer nominated, so this is checked at runtime too.
 */
function assertSafeMethod(method: string | undefined): "GET" | "HEAD" {
  const resolved = (method ?? "GET").toUpperCase();
  if (!SAFE_METHODS.has(resolved)) {
    throw new SafeFetchError(
      "blocked_scheme",
      `method ${JSON.stringify(method)} is not permitted — probes may only GET or HEAD`,
    );
  }
  return resolved as "GET" | "HEAD";
}

/**
 * Await `promise`, but give up when the budget aborts. Used for work that happens outside
 * undici's reach — undici honours the signal itself, DNS resolution does not.
 */
function raceBudget<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new SafeFetchError("timeout", `exceeded the ${timeoutMs}ms total budget`),
    );
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new SafeFetchError("timeout", `exceeded the ${timeoutMs}ms total budget`));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function buildRequestHeaders(
  supplied?: Readonly<Record<string, string>>,
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [name, value] of Object.entries(supplied ?? {})) {
    const lower = name.toLowerCase();
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) {
      throw new SafeFetchError(
        "unexpected",
        `refusing to send credential header '${lower}' to a user-supplied target (control 5)`,
      );
    }
    headers[lower] = value;
  }

  return {
    ...headers,
    // Set last: neither of these is overridable by the caller.
    //
    // identity encoding keeps bodyBytes and bodySha256 honest — they describe the bytes the
    // target actually sent — and it means the body cap cannot be walked past with a
    // compression bomb, since undici does not decompress for us anyway.
    "accept-encoding": "identity",
    "user-agent": USER_AGENT,
  };
}

function pickAllowedHeaders(
  raw: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (!RESPONSE_HEADER_ALLOWLIST.has(lower) || value === undefined) continue;
    picked[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return picked;
}

interface CappedBody {
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

/**
 * Read the body, hashing as we go, refusing to accumulate past the cap.
 *
 * Over-cap is an error rather than a truncation on purpose: a truncated body can make a
 * content check observe FALSE for a reason unrelated to the done-condition, and that is the
 * `fail`-instead-of-`error` bug I-7 exists to prevent.
 */
async function readCappedBody(
  body: Readable,
  maxBodyBytes: number,
  resolvedIp: string,
  budgetSignal: AbortSignal,
  timeoutMs: number,
): Promise<CappedBody> {
  const hash = createHash("sha256");
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      total += buf.byteLength;
      if (total > maxBodyBytes) {
        body.destroy();
        throw new SafeFetchError(
          "body_too_large",
          `body exceeded the ${maxBodyBytes} byte cap`,
          resolvedIp,
        );
      }
      hash.update(buf);
      chunks.push(buf);
    }
  } catch (cause) {
    throw toSafeFetchError(cause, budgetSignal.aborted, timeoutMs, resolvedIp);
  }

  return { bytes: Buffer.concat(chunks, total), sha256: hash.digest("hex") };
}

/**
 * Map whatever came back into the typed taxonomy. Every code here is ProbeOutcome 'error' at
 * the call site, never 'fail' — the distinction the caller needs is *why*, so it can decide
 * whether to retry, not whether someone kept their word.
 */
function toSafeFetchError(
  cause: unknown,
  budgetExpired: boolean,
  timeoutMs: number,
  resolvedIp?: string,
): SafeFetchError {
  if (cause instanceof SafeFetchError) return cause;

  // Checked before the undici code, because an abort surfaces as a generic AbortError whose
  // real story is our budget running out.
  if (budgetExpired) {
    return new SafeFetchError(
      "timeout",
      `exceeded the ${timeoutMs}ms total budget`,
      resolvedIp,
      cause,
    );
  }

  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  const message = cause instanceof Error ? cause.message : String(cause);

  switch (code) {
    case "UND_ERR_HEADERS_TIMEOUT":
    case "UND_ERR_BODY_TIMEOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
    case "ETIMEDOUT":
      return new SafeFetchError("timeout", `target timed out: ${message}`, resolvedIp, cause);

    case "UND_ERR_RES_EXCEEDED_MAX_SIZE":
      return new SafeFetchError("body_too_large", message, resolvedIp, cause);

    case "ENOTFOUND":
    case "EAI_AGAIN":
      return new SafeFetchError("dns_failure", message, resolvedIp, cause);

    case "UND_ERR_ABORTED":
      return new SafeFetchError("timeout", `request aborted: ${message}`, resolvedIp, cause);

    case "UND_ERR_SOCKET":
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EPIPE":
    case "EPROTO":
      return new SafeFetchError("connection_failed", message, resolvedIp, cause);

    default:
      if (cause instanceof Error && cause.name === "AbortError") {
        return new SafeFetchError("timeout", `request aborted: ${message}`, resolvedIp, cause);
      }
      // A named undici failure we have not classified is still an upstream problem, not a
      // verdict about the done-condition.
      if (code.startsWith("UND_ERR_")) {
        return new SafeFetchError(
          "upstream_unavailable",
          `${code}: ${message}`,
          resolvedIp,
          cause,
        );
      }
      return new SafeFetchError("unexpected", message, resolvedIp, cause);
  }
}
