/**
 * The one way this worker talks to api.github.com.
 *
 * Extracted from the v0 release probe rather than copied, because a second GitHub call site
 * with its own auth and its own error mapping is how "a 403 is a rate limit, not a false
 * observation" gets forgotten in exactly one of them.
 *
 * Two things it is careful about:
 *
 * 1. **Whose eyes.** The token is the App/PAT from the worker's environment, never a user's
 *    OAuth token. An observation made with the committer's own credentials is not an external
 *    observation, and this product is nothing but external observation. Nor do we ever fall
 *    back to unauthenticated for a resolution-critical run (architecture.md §8) — a missing
 *    token is a startup failure, not a silent downgrade.
 *
 * 2. **Which host.** `api.github.com` is a constant here. User input reaches only the *path*,
 *    and only after the `owner/name` and path-segment checks in @pledge/spec's normaliser
 *    (which reject `.` and `..` for this reason). Because the host is not user-supplied this
 *    does not need @pledge/safe-fetch's arbitrary-URL path — and it could not use it anyway,
 *    since safe-fetch refuses to carry an Authorization header. CLAUDE.md I-5 is about
 *    user-supplied URLs; this is not one.
 */
import { createHash } from "node:crypto";
import { allowlistHeaders, type ObservationErrorCode } from "../probes/result";

export const GITHUB_API_ORIGIN = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "pledge-probe/0.1 (+https://pledge.sh/probe)";
const REQUEST_TIMEOUT_MS = 10_000;

export interface GithubDeps {
  /** App installation token or PAT. Required — see the "whose eyes" note above. */
  readonly token: string;
  /** Injected so tests never touch the network. Production passes the global `fetch`. */
  readonly fetchImpl: typeof fetch;
}

export type GithubCall =
  | {
      readonly kind: "answered";
      readonly status: number;
      readonly headers: Record<string, string>;
      readonly json: unknown;
      readonly body: { readonly bodySha256: string; readonly bodyBytes: number };
      readonly partial: { readonly status: number; readonly headers: Record<string, string> };
      readonly rateLimited: boolean;
      /**
       * The raw `Link` header, kept out of `headers` because it is not on the §6.2 evidence
       * whitelist and therefore must not be stored. It is read, not recorded: paginated
       * counts come from `rel="last"` rather than from walking every page.
       */
      readonly link: string | null;
    }
  | {
      readonly kind: "unreachable";
      readonly code: ObservationErrorCode;
      readonly message: string;
      readonly partial: Record<string, never>;
    };

export async function callGithub(url: string, deps: GithubDeps): Promise<GithubCall> {
  return callJsonApi(url, deps.fetchImpl, {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${deps.token}`,
    "x-github-api-version": API_VERSION,
  });
}

/**
 * The same call against a registry, with no credentials.
 *
 * npm, crates.io and PyPI are fixed origins reached over a path built from an already
 * validated package name, so they are not the user-supplied-URL case CLAUDE.md I-5 governs —
 * and they must not carry an Authorization header, which is why this is a separate entry
 * point rather than `callGithub` with an empty token.
 */
export async function callJsonApi(
  url: string,
  fetchImpl: typeof fetch,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<GithubCall> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...extraHeaders },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error: unknown) {
    const timedOut =
      error instanceof Error && /abort|timeout/i.test(error.name + error.message);
    return {
      kind: "unreachable",
      code: timedOut ? "timeout" : "connection_failed",
      message: error instanceof Error ? error.message : String(error),
      partial: {},
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error: unknown) {
    return {
      kind: "unreachable",
      code: "connection_failed",
      message: `response body could not be read: ${error instanceof Error ? error.message : String(error)}`,
      partial: {},
    };
  }

  const headers = allowlistHeaders(response.headers);
  return {
    kind: "answered",
    status: response.status,
    headers,
    json: safeJson(text),
    body: {
      bodySha256: createHash("sha256").update(text, "utf8").digest("hex"),
      bodyBytes: Buffer.byteLength(text, "utf8"),
    },
    partial: { status: response.status, headers },
    rateLimited:
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.get("retry-after") !== null,
    link: response.headers.get("link"),
  };
}

/**
 * Total item count from a `per_page=1` listing, read off `Link: <...&page=N>; rel="last"`.
 *
 * One request instead of walking pages, and — the reason it matters — an EXACT count. Reading
 * `items.length` off a capped page under-reports, and an under-reported count turns
 * `count >= 150` into an observation that the condition is false when it is true. That is a
 * false `missed` produced by pagination, which is the I-7 failure mode wearing a different hat.
 *
 * Returns `undefined` when the header is present but unparseable, so the caller reports the
 * field as unreadable rather than guessing a number.
 */
export function totalFromLink(link: string | null, itemsOnPage: number): number | undefined {
  if (link === null) return itemsOnPage;
  const last = /[?&]page=(\d+)>\s*;\s*rel="last"/.exec(link);
  if (last === null) return itemsOnPage;
  const page = Number(last[1]);
  return Number.isSafeInteger(page) && page >= 0 ? page : undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Every branch here is an `error` code, because every one of them means the API did not tell
 * us about the target. There is deliberately no status that maps to a false observation: only
 * a call site that actually read a value, or confirmed a visible resource that lacks one, may
 * produce that.
 */
export function githubErrorCode(
  call: Extract<GithubCall, { kind: "answered" }>,
): ObservationErrorCode {
  const throttled = call.status === 429 || (call.status === 403 && call.rateLimited);
  return throttled ? "rate_limited" : "upstream_unavailable";
}

/** `owner/repo` → the two path segments, already encoded. */
export function repoPath(repo: string): string {
  const [owner = "", name = ""] = repo.split("/");
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}
