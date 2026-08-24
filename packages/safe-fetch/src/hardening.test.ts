/**
 * Regression tests for two controls an adversarial review found unenforced.
 *
 * Both were reported CONFIRMED against the shipped code, so these tests are written to fail
 * against the pre-fix implementation rather than merely to describe the fix.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSafeFetch, type SafeFetch } from "./index";
import { SafeFetchError, type DnsResolver, type SafeFetchErrorCode } from "./types";

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

describe("method is enforced at runtime, not only by the type", () => {
  // safe-fetch is exported MIT and not every caller is TypeScript. A probe that can POST to a
  // committer-nominated URL is a request-forgery tool wearing an observation tool's clothes.
  const fetcher = createSafeFetch({
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    allowedProtocols: ["http:"],
    isAddressAllowed: (ip) => ip === "127.0.0.1",
  });

  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "TRACE"]) {
    it(`refuses ${method} before any socket is opened`, async () => {
      const error = await expectRejection(
        // Deliberately cast: this is exactly what a JS caller can do, and the point of the
        // test is that the compile-time union is not the only thing standing in the way.
        fetcher("http://127.0.0.1:1/", { method: method as "GET" }),
        "blocked_scheme",
      );
      expect(error.message).toContain(method);
      // connection_failed would mean it tried to connect first. Port 1 has nothing on it, so
      // reaching the socket at all would surface as connection_failed instead.
    });
  }

  it("still accepts GET and HEAD, case-insensitively", async () => {
    // Nothing listens on port 1, so connection_failed proves the method check let it through.
    await expectRejection(fetcher("http://127.0.0.1:1/", { method: "GET" }), "connection_failed");
    await expectRejection(fetcher("http://127.0.0.1:1/", { method: "HEAD" }), "connection_failed");
    await expectRejection(
      fetcher("http://127.0.0.1:1/", { method: "get" as "GET" }),
      "connection_failed",
    );
  });
});

describe("DNS resolution is inside the total budget", () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A resolver that takes far longer than any budget under test. */
  const stallingResolve: DnsResolver = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    return [{ address: "127.0.0.1", family: 4 }];
  };

  it("gives up at the budget instead of waiting for a stalled nameserver", async () => {
    const fetcher: SafeFetch = createSafeFetch({
      resolve: stallingResolve,
      allowedProtocols: ["http:"],
      isAddressAllowed: (ip) => ip === "127.0.0.1",
    });

    const startedAt = Date.now();
    const error = await expectRejection(
      fetcher(`http://slow-dns.test:${port}/`, { timeoutMs: 300 }),
      "timeout",
    );
    const elapsed = Date.now() - startedAt;

    expect(error.message).toContain("300ms");
    // Pre-fix this returned at ~10s because resolveAndPin was awaited outside the
    // AbortController's reach. The generous ceiling keeps the test honest on a loaded box
    // while still being an order of magnitude below the stall.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("does not charge the budget when DNS is fast", async () => {
    const fetcher: SafeFetch = createSafeFetch({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      allowedProtocols: ["http:"],
      isAddressAllowed: (ip) => ip === "127.0.0.1",
    });

    const response = await fetcher(`http://fast-dns.test:${port}/`, { timeoutMs: 2_000 });
    expect(response.status).toBe(200);
  });
});
