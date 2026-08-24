/**
 * SSRF policy: which addresses may be connected to, and which URLs may be requested.
 *
 * Pure functions, no I/O beyond the injected resolver — this is the part that has to be
 * exhaustively testable (security.md T-01 corpus is a v0 exit criterion).
 */

import ipaddr from "ipaddr.js";

import { SafeFetchError, type DnsResolver, type PinnedAddress } from "./types";

/**
 * Allowlist, not blocklist.
 *
 * The obvious implementation — block ["private","loopback","linkLocal","uniqueLocal",
 * "carrierGradeNat","reserved","unspecified"] — is wrong, and wrong in a way that is
 * invisible until someone exploits it. Verified empirically against ipaddr.js 2.5.0:
 *
 *   ::ffff:10.0.0.1   range() === "ipv4Mapped"   <- not "private". Whole RFC1918 space walks
 *                                                   straight through a name blocklist.
 *   64:ff9b::7f00:1   range() === "rfc6052"      <- NAT64 to 127.0.0.1
 *   2002:7f00:1::1    range() === "6to4"         <- 6to4 to 127.0.0.1
 *   2001::1           range() === "teredo"
 *   255.255.255.255   range() === "broadcast"
 *   224.0.0.1         range() === "multicast"
 *
 * Every one of those is a hole in the blocklist. An allowlist of the single range that means
 * "an ordinary address on the public internet" has no holes, and a future ipaddr.js that adds
 * a new range name fails closed rather than open.
 *
 * ONE range name is itself wrong, and the allowlist alone does not save us from it:
 *
 *   ::a00:1           range() === "unicast"       <- ::/96, RFC 4291 §2.5.5.1. Same address
 *                                                   as ::10.0.0.1, which ipaddr calls
 *                                                   "ipv4Mapped". See isPublicUnicastAddress.
 */
const ALLOWED_RANGE = "unicast";

/** True only for a globally-routable unicast address. Everything else — including anything
 *  ipaddr.js cannot parse — is denied. */
export function isPublicUnicastAddress(address: string): boolean {
  let parsed: ReturnType<typeof ipaddr.parse>;
  try {
    parsed = ipaddr.parse(address);
  } catch {
    return false;
  }

  if (parsed instanceof ipaddr.IPv6) {
    // ::/96 — the deprecated IPv4-compatible form, RFC 4291 §2.5.5.1. This one DOES need
    // handling here, because it is the single place ipaddr.js 2.5.0's range names go wrong:
    //
    //   ipaddr.parse("::10.0.0.1").range()  === "ipv4Mapped"   <- correct-ish, textual form
    //   ipaddr.parse("::a00:1").range()     === "unicast"      <- SAME ADDRESS, allowed
    //
    // and `new URL("https://[::10.0.0.1]/").hostname` is "[::a00:1]", i.e. the WHATWG parser
    // hands us precisely the form that classifies as unicast. The isIPv4MappedAddress()
    // unwrap below never fires for a URL-derived host and cannot be relied on.
    //
    // The whole /96 is reserved and must not appear on the wire, so deny it outright rather
    // than unwrap: ::8.8.8.8 is not a globally-routable unicast address either. `::` and
    // `::1` fall in here too, which is the same verdict they already had.
    if (parsed.parts.slice(0, 6).every((part) => part === 0)) return false;

    // ::ffff:x.y.z.w is an IPv4 address wearing a v6 hat; judge the address it actually is.
    // The other v4-embedding forms (rfc6052/6to4/teredo) need no unwrapping — their range
    // names are not "unicast", so the allowlist already denies them.
    if (parsed.isIPv4MappedAddress()) {
      return isPublicUnicastAddress(parsed.toIPv4Address().toString());
    }
  }

  return parsed.range() === ALLOWED_RANGE;
}

export type AddressPolicy = (address: string) => boolean;

/** `https:` in production. Widened only by tests, which need a plaintext loopback server. */
export const DEFAULT_ALLOWED_PROTOCOLS: readonly string[] = ["https:"];

/**
 * Parse and vet a target URL. `base` is set for a redirect hop so a relative `Location`
 * resolves — and so a `Location: file:///etc/passwd` is judged by the same rules as the
 * original URL.
 *
 * Rejections are `blocked_scheme` across the board: the shared error-code union is fixed by
 * packages/db and has no `blocked_url` member. All of them are BLOCKED-class either way.
 */
export function parseTargetUrl(
  raw: string,
  allowedProtocols: readonly string[] = DEFAULT_ALLOWED_PROTOCOLS,
  base?: string,
): URL {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new SafeFetchError("blocked_scheme", `not a valid absolute URL: ${redact(raw)}`);
  }

  if (!allowedProtocols.includes(url.protocol)) {
    throw new SafeFetchError("blocked_scheme", `scheme ${url.protocol} is not permitted`);
  }
  // Never interpolate href into a message from here on — it would echo the credentials.
  if (url.username !== "" || url.password !== "") {
    throw new SafeFetchError(
      "blocked_scheme",
      `URL carries embedded credentials: ${url.protocol}//${url.host}`,
    );
  }
  if (url.hash !== "") {
    throw new SafeFetchError(
      "blocked_scheme",
      "URL carries a fragment, which is never sent and never meaningful here",
    );
  }
  if (url.hostname === "") {
    throw new SafeFetchError("blocked_scheme", "URL has no host");
  }

  return url;
}

/**
 * Resolve-then-pin (control 1). Returns the one address the caller may connect to.
 *
 * The pin is what closes the rebinding window: the caller must hand this address to the
 * socket and must never let anything re-resolve the hostname. A second lookup is a second
 * chance for the answer to change.
 */
export async function resolveAndPin(
  hostname: string,
  resolve: DnsResolver,
  isAddressAllowed: AddressPolicy,
): Promise<PinnedAddress> {
  const literal = unbracket(hostname);

  // WHATWG URL already normalises 2130706433, 0x7f000001 and 0177.0.0.1 to 127.0.0.1, and
  // ipaddr.js parses those forms too. Checking the literal here means such a host never
  // reaches the resolver at all.
  if (ipaddr.isValid(literal)) {
    if (!isAddressAllowed(literal)) {
      throw new SafeFetchError(
        "blocked_address",
        `blocked address literal ${literal}`,
        literal,
      );
    }
    return pin(literal);
  }

  let answers: ReadonlyArray<{ readonly address: string }>;
  try {
    answers = await resolve(hostname);
  } catch (cause) {
    throw new SafeFetchError(
      "dns_failure",
      `DNS lookup failed for ${hostname}: ${describe(cause)}`,
      undefined,
      cause,
    );
  }

  if (answers.length === 0) {
    throw new SafeFetchError("dns_failure", `DNS returned no addresses for ${hostname}`);
  }

  // EVERY answer must pass, not merely one. A name with one public and one private A record
  // is blocked outright — "just use the public one" hands the attacker a retry loop, since
  // which record the pin lands on is their choice, not ours.
  const blocked = answers.find((a) => !isAddressAllowed(a.address));
  if (blocked !== undefined) {
    throw new SafeFetchError(
      "blocked_address",
      `${hostname} resolves to blocked address ${blocked.address}`,
      blocked.address,
    );
  }

  return pin(answers[0].address);
}

function pin(address: string): PinnedAddress {
  const parsed = ipaddr.parse(address);
  return { address: parsed.toString(), family: parsed.kind() === "ipv4" ? 4 : 6 };
}

/** `new URL("https://[::1]/").hostname` is "[::1]" — brackets and all. */
function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function redact(raw: string): string {
  return raw.length > 120 ? `${raw.slice(0, 120)}…` : raw;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
