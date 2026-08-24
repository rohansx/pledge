import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isPublicUnicastAddress } from "./policy";
import { createSafeFetch, type SafeFetch } from "./index";
import { SafeFetchError, type DnsResolver, type SafeFetchErrorCode } from "./types";

// --- stub DNS -------------------------------------------------------------------------
//
// Every hostname the tests use is mapped here. An unmapped name throws rather than falling
// through to the real resolver: a test that quietly reaches the network is a test that will
// pass in CI for the wrong reason, or fail there for an unrelated one.

const STUB_DNS: Readonly<Record<string, ReadonlyArray<{ address: string; family: number }>>> = {
  "metadata.google.internal": [{ address: "169.254.169.254", family: 4 }],
  "private-only.test": [{ address: "10.11.12.13", family: 4 }],
  // The interesting one: one public answer and one private answer. Picking the public one is
  // not a mitigation — which record the pin lands on is the attacker's choice, not ours.
  "split-horizon.test": [
    { address: "93.184.216.34", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ],
  "public.test": [{ address: "93.184.216.34", family: 4 }],
  "nat64.test": [{ address: "64:ff9b::7f00:1", family: 6 }],
  // Used by the pin test below. Deliberately a name the real resolver cannot answer: if
  // anything under us re-resolves it, the connect fails with ENOTFOUND and the test goes red.
  "pinned.test": [{ address: "127.0.0.1", family: 4 }],
};

const stubResolve: DnsResolver = async (hostname) => {
  const answers = STUB_DNS[hostname];
  if (answers === undefined) throw new Error(`ENOTFOUND (stub): ${hostname}`);
  return answers;
};

/** Production policy in every respect except that DNS is stubbed. */
const corpusFetch = createSafeFetch({ resolve: stubResolve });

async function expectRejection(
  promise: Promise<unknown>,
  code: SafeFetchErrorCode,
): Promise<SafeFetchError> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(SafeFetchError);
  const error = outcome as SafeFetchError;
  expect(error.code).toBe(code);
  return error;
}

// --- address policy -------------------------------------------------------------------

describe("isPublicUnicastAddress", () => {
  it.each([
    ["8.8.8.8", true],
    ["93.184.216.34", true],
    ["2001:4860:4860::8888", true],
    ["::ffff:8.8.8.8", true],
    ["127.0.0.1", false],
    ["10.0.0.1", false],
    ["172.16.0.1", false],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["255.255.255.255", false],
    ["224.0.0.1", false],
    ["192.0.2.1", false],
    ["::1", false],
    ["::", false],
    ["fe80::1", false],
    ["fc00::1", false],
    ["fd00::1", false],
    ["2001:db8::1", false],
    // v4-mapped: these classify as range "ipv4Mapped", so a range-name blocklist misses
    // every one of them. The whole point of the allowlist.
    ["::ffff:127.0.0.1", false],
    ["::ffff:10.0.0.1", false],
    ["::ffff:169.254.169.254", false],
    // Embedded-v4 transition ranges: NAT64, 6to4, Teredo.
    ["64:ff9b::7f00:1", false],
    ["2002:7f00:1::1", false],
    ["2001::1", false],
    // ::/96, the deprecated IPv4-compatible form (RFC 4291 §2.5.5.1). ipaddr.js 2.5.0 calls
    // ::a00:1 "unicast" while calling the identical ::10.0.0.1 "ipv4Mapped", and the WHATWG
    // URL parser normalises [::10.0.0.1] into the first form — so the range name alone let
    // the whole /96 through. Both spellings, both ways round.
    ["::10.0.0.1", false],
    ["::a00:1", false],
    ["::127.0.0.1", false],
    ["::7f00:1", false],
    ["::a9fe:a9fe", false],
    // Nothing in ::/96 is a public address, not even a public-looking one. (Only the hex
    // spelling can be asserted: ipaddr.js 2.5.0's parser silently rewrites the dotted-quad
    // form "::8.8.8.8" into ::ffff:8.8.8.8, parts[5] and all. That is why the range name for
    // "::10.0.0.1" differs from the one for the identical "::a00:1", and why the check in
    // isPublicUnicastAddress is on parts rather than on range() or isIPv4MappedAddress().)
    ["::808:808", false],
    ["::2", false],
    // rfc6145 (IPv4-translated) sits next door and must stay blocked too.
    ["::ffff:0:a00:1", false],
    // Unparseable is denied, not allowed.
    ["not-an-address", false],
    ["", false],
  ])("%s -> %s", (address, allowed) => {
    expect(isPublicUnicastAddress(address)).toBe(allowed);
  });
});

// --- the T-01 corpus ------------------------------------------------------------------
//
// docs/security.md T-01 lists these by name as a v0 exit criterion. One assertion each, so a
// regression names the exact vector it reopened.

describe("T-01 SSRF corpus (docs/security.md)", () => {
  it.each([
    ["127.0.0.1", "https://127.0.0.1/"],
    ["169.254.169.254 (cloud metadata)", "https://169.254.169.254/latest/meta-data/"],
    ["10.0.0.1 (RFC1918)", "https://10.0.0.1/"],
    ["[::1]", "https://[::1]/"],
    ["[::ffff:127.0.0.1] (v4-mapped loopback)", "https://[::ffff:127.0.0.1]/"],
    ["0.0.0.0 (unspecified)", "https://0.0.0.0/"],
    ["2130706433 (decimal-encoded 127.0.0.1)", "https://2130706433/"],
    ["0x7f000001 (hex-encoded 127.0.0.1)", "https://0x7f000001/"],
    // ::/96. The URL parser rewrites these to [::7f00:1] / [::a00:1] before the policy sees
    // them, which is the spelling ipaddr.js 2.5.0 classifies as plain "unicast".
    ["[::127.0.0.1] (IPv4-compatible loopback)", "https://[::127.0.0.1]/"],
    ["[::10.0.0.1] (IPv4-compatible RFC1918)", "https://[::10.0.0.1]/"],
    ["[::7f00:1] (same address, hex spelling)", "https://[::7f00:1]/"],
    ["[::ffff:0:a00:1] (rfc6145 IPv4-translated)", "https://[::ffff:0:a00:1]/"],
  ])("blocks the address literal %s", async (_name, url) => {
    await expectRejection(corpusFetch(url), "blocked_address");
  });

  it("blocks a name whose AAAA answer is in ::/96", async () => {
    // The literal path and the resolver path are different code; the bypass was reachable
    // from both. An attacker controls their own zone, so this is the cheaper half.
    const fetchWithV4Compat = createSafeFetch({
      resolve: async () => [{ address: "::a00:1", family: 6 }],
    });
    const error = await expectRejection(
      fetchWithV4Compat("https://attacker-zone.test/"),
      "blocked_address",
    );
    expect(error.resolvedIp).toBe("::a00:1");
  });

  it("blocks metadata.google.internal, which resolves to link-local", async () => {
    const error = await expectRejection(
      corpusFetch("https://metadata.google.internal/"),
      "blocked_address",
    );
    expect(error.resolvedIp).toBe("169.254.169.254");
  });

  it("blocks a DNS name resolving into private space", async () => {
    const error = await expectRejection(
      corpusFetch("https://private-only.test/"),
      "blocked_address",
    );
    expect(error.resolvedIp).toBe("10.11.12.13");
  });

  it("blocks a name with BOTH a public and a private A record — not 'use the public one'", async () => {
    const error = await expectRejection(
      corpusFetch("https://split-horizon.test/"),
      "blocked_address",
    );
    expect(error.resolvedIp).toBe("10.0.0.5");
  });

  it("blocks a name resolving into the NAT64 prefix", async () => {
    await expectRejection(corpusFetch("https://nat64.test/"), "blocked_address");
  });

  it("blocks a URL with embedded credentials", async () => {
    const error = await expectRejection(
      corpusFetch("https://user:hunter2@public.test/"),
      "blocked_scheme",
    );
    // The message is going into worker logs. It must not carry the password.
    expect(error.message).not.toContain("hunter2");
  });

  it.each([
    ["file:", "file:///etc/passwd"],
    ["gopher:", "gopher://public.test/_secret"],
    ["ftp:", "ftp://public.test/"],
    ["data:", "data:text/plain,hello"],
    ["blob:", "blob:https://public.test/abc"],
    ["http: (https only)", "http://public.test/"],
  ])("blocks the %s scheme", async (_name, url) => {
    await expectRejection(corpusFetch(url), "blocked_scheme");
  });

  it("blocks a URL carrying a fragment", async () => {
    await expectRejection(corpusFetch("https://public.test/x#frag"), "blocked_scheme");
  });

  it("reports a resolver failure as dns_failure, never as a block or a fail", async () => {
    await expectRejection(corpusFetch("https://unmapped.test/"), "dns_failure");
  });
});

// --- behaviour against a real server ---------------------------------------------------
//
// The happy path, the body cap and the redirect walk need bytes on a socket. Loopback is
// blocked by the production policy (correctly), so these tests open exactly two holes —
// plaintext http, and 127.0.0.1 — and nothing else. The corpus above runs on the real policy.

const OK_BODY = "hello pledge";

describe("safeFetch against a local server", () => {
  let server: Server;
  let port: number;
  let loopbackFetch: SafeFetch;
  const receivedHeaders: IncomingHttpHeaders[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      receivedHeaders.push(req.headers);
      const path = new URL(req.url ?? "/", "http://placeholder").pathname;

      switch (path) {
        case "/ok":
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            etag: '"abc123"',
            server: "test-origin",
            // Neither of these is on the evidence allowlist. Both must be dropped.
            "x-secret": "must-not-leak",
            "set-cookie": "session=nope",
          });
          res.end(OK_BODY);
          return;

        case "/big-declared":
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": "65536",
          });
          res.end(Buffer.alloc(65536, 0x41));
          return;

        case "/big-chunked":
          // No content-length, so only the streaming cap can stop this one.
          res.writeHead(200, { "content-type": "application/octet-stream" });
          for (let i = 0; i < 64; i += 1) res.write(Buffer.alloc(1024, 0x42));
          res.end();
          return;

        case "/r1":
          res.writeHead(302, { location: "/ok" });
          res.end();
          return;

        // Three hops of redirect, the last of which lands in RFC1918.
        case "/hop1":
          res.writeHead(302, { location: "/hop2" });
          res.end();
          return;
        case "/hop2":
          res.writeHead(302, { location: "/hop3" });
          res.end();
          return;
        case "/hop3":
          res.writeHead(302, { location: `http://private-only.test:${port}/final` });
          res.end();
          return;

        case "/loop":
          res.writeHead(302, { location: "/loop" });
          res.end();
          return;

        case "/to-file":
          res.writeHead(302, { location: "file:///etc/passwd" });
          res.end();
          return;

        case "/slow":
          // Deliberately never responds; the total budget has to be what ends this.
          return;

        case "/drip": {
          // Headers arrive, then one byte every 300ms forever. Never idle long enough for
          // undici's 10s bodyTimeout and never large enough for the body cap — the total
          // budget is the only thing that can end it.
          res.writeHead(200, { "content-type": "text/plain" });
          const tick = setInterval(() => res.write("x"), 300);
          res.on("close", () => clearInterval(tick));
          return;
        }

        default:
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("nope");
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;

    loopbackFetch = createSafeFetch({
      resolve: stubResolve,
      allowedProtocols: ["http:", "https:"],
      isAddressAllowed: (ip) => ip === "127.0.0.1" || isPublicUnicastAddress(ip),
    });
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  const at = (path: string): string => `http://127.0.0.1:${port}${path}`;

  it("returns status, hashed body and the pinned IP on the happy path", async () => {
    const response = await loopbackFetch(at("/ok"));

    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe(OK_BODY);
    expect(response.bodyBytes).toBe(Buffer.byteLength(OK_BODY));
    expect(response.bodySha256).toBe(createHash("sha256").update(OK_BODY).digest("hex"));
    expect(response.resolvedIp).toBe("127.0.0.1");
    expect(response.finalUrl).toBe(at("/ok"));
    expect(response.redirectChain).toEqual([at("/ok")]);
    expect(response.truncated).toBe(false);
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps only the allowlisted response headers", async () => {
    const response = await loopbackFetch(at("/ok"));

    expect(response.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(response.headers["etag"]).toBe('"abc123"');
    expect(response.headers["server"]).toBe("test-origin");
    expect(Object.keys(response.headers).sort()).toEqual(["content-type", "etag", "server"]);
  });

  it("sends the identifiable UA and no ambient credentials", async () => {
    receivedHeaders.length = 0;
    await loopbackFetch(at("/ok"));

    const sent = receivedHeaders.at(-1);
    expect(sent?.["user-agent"]).toBe("pledge-probe/0.1 (+https://pledge.sh/probe)");
    expect(sent?.["accept-encoding"]).toBe("identity");
    expect(sent?.["cookie"]).toBeUndefined();
    expect(sent?.["authorization"]).toBeUndefined();
  });

  it("refuses to let a caller attach a credential header", async () => {
    const error = await expectRejection(
      loopbackFetch(at("/ok"), { headers: { Authorization: "Bearer sekrit" } }),
      "unexpected",
    );
    expect(error.message).toContain("authorization");
    expect(error.message).not.toContain("sekrit");
  });

  it("ignores a caller trying to override the UA", async () => {
    receivedHeaders.length = 0;
    await loopbackFetch(at("/ok"), { headers: { "User-Agent": "definitely-a-browser" } });

    expect(receivedHeaders.at(-1)?.["user-agent"]).toBe(
      "pledge-probe/0.1 (+https://pledge.sh/probe)",
    );
  });

  it("rejects a body whose declared Content-Length exceeds the cap, before reading it", async () => {
    await expectRejection(
      loopbackFetch(at("/big-declared"), { maxBodyBytes: 1024 }),
      "body_too_large",
    );
  });

  it("rejects a chunked body that grows past the cap mid-stream", async () => {
    await expectRejection(
      loopbackFetch(at("/big-chunked"), { maxBodyBytes: 1024 }),
      "body_too_large",
    );
  });

  it("accepts a body that fits under the cap", async () => {
    const response = await loopbackFetch(at("/big-chunked"), { maxBodyBytes: 128 * 1024 });
    expect(response.bodyBytes).toBe(64 * 1024);
  });

  it("follows a redirect manually and records the chain", async () => {
    const response = await loopbackFetch(at("/r1"));

    expect(response.status).toBe(200);
    expect(response.finalUrl).toBe(at("/ok"));
    expect(response.redirectChain).toEqual([at("/r1"), at("/ok")]);
  });

  it("blocks a 3-hop redirect whose final hop resolves into private space", async () => {
    const error = await expectRejection(loopbackFetch(at("/hop1")), "blocked_address");
    expect(error.resolvedIp).toBe("10.11.12.13");
  });

  it("blocks a Location header carrying a file: scheme", async () => {
    await expectRejection(loopbackFetch(at("/to-file")), "blocked_scheme");
  });

  it("stops at the redirect limit rather than looping", async () => {
    await expectRejection(loopbackFetch(at("/loop")), "too_many_redirects");
    await expectRejection(
      loopbackFetch(at("/loop"), { maxRedirects: 0 }),
      "too_many_redirects",
    );
  });

  it("enforces the total budget independently of undici's own timeouts", async () => {
    const error = await expectRejection(
      loopbackFetch(at("/slow"), { timeoutMs: 250 }),
      "timeout",
    );
    expect(error.message).toContain("250ms");
  });

  /**
   * Control 1 is the only control whose failure is invisible: if undici ignored
   * `connect.lookup` and resolved the hostname itself, every other test in this file would
   * still pass and the rebinding window would be wide open. So assert the two observable
   * consequences of the pin directly — the socket lands on the pinned IP, and the hostname is
   * resolved exactly once per hop.
   */
  it("connects to the pinned IP and resolves the hostname exactly once", async () => {
    const lookups: string[] = [];
    const countingFetch = createSafeFetch({
      resolve: async (hostname) => {
        lookups.push(hostname);
        return stubResolve(hostname);
      },
      allowedProtocols: ["http:"],
      isAddressAllowed: (ip) => ip === "127.0.0.1" || isPublicUnicastAddress(ip),
    });

    const response = await countingFetch(`http://pinned.test:${port}/ok`);

    expect(Buffer.from(response.body).toString("utf8")).toBe(OK_BODY);
    expect(response.resolvedIp).toBe("127.0.0.1");
    expect(lookups).toEqual(["pinned.test"]);
  });

  it("aborts a body that drips forever, at the total budget", async () => {
    const startedAt = Date.now();
    const error = await expectRejection(
      loopbackFetch(at("/drip"), { timeoutMs: 500 }),
      "timeout",
    );
    expect(error.message).toContain("500ms");
    // The point is that neither bodyTimeout (10s idle) nor the body cap (5 MB of 1-byte
    // writes) could ever have ended this.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("reports a refused connection as connection_failed, never as a fail", async () => {
    // Port 1 on loopback: nothing listens there.
    await expectRejection(loopbackFetch("http://127.0.0.1:1/"), "connection_failed");
  });
});
