/**
 * The observation layer.
 *
 * Two things are being pinned here, and both are structural claims rather than behaviours:
 *
 *   · memoisation — two fields read off one source cost ONE request. Asserted by counting
 *     calls, because a comment saying "memoised" survives a refactor that isn't.
 *   · I-7 — every path that did not see the target produces `observed: false`, and no path
 *     that did see it produces an error. A source added later that gets this wrong marks
 *     someone as having missed because of a network blip.
 */
import { describe, expect, it, vi } from "vitest";
import type { SpecNode } from "@pledge/spec";
import { SafeFetchError, type SafeFetch, type SafeFetchResponse } from "@pledge/safe-fetch";
import { collectTargets } from "./collect";
import { observeAll, type ObserveDeps } from "./index";
import type { ObserveContext } from "./types";

const URL_A = "https://example.test/status";
const URL_B = "https://other.test/";

const ctx: ObserveContext = {
  commitTime: new Date("2026-09-01T00:00:00.000Z"),
  deadline: new Date("2026-09-05T18:00:00.000Z"),
  now: () => new Date("2026-09-03T12:00:00.000Z"),
};

const httpAccessor = (url: string, path: string[], arg?: string) => ({
  source: { kind: "http", url } as const,
  modifiers: [],
  field: arg === undefined ? { path } : { path, arg },
});

const compare = (
  accessor: ReturnType<typeof httpAccessor>,
  op: "==" | "contains" | ">",
  right: { type: "int"; value: number } | { type: "string"; value: string },
): SpecNode => ({ kind: "compare", op, left: accessor, right });

function fakeResponse(body: string, status = 200): SafeFetchResponse {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: { "content-type": "text/html", etag: '"abc"', "x-secret": "leak" },
    body: bytes,
    bodySha256: "a".repeat(64),
    bodyBytes: bytes.byteLength,
    truncated: false,
    resolvedIp: "203.0.113.7",
    finalUrl: URL_A,
    redirectChain: [URL_A],
    durationMs: 12,
  };
}

function deps(safeFetch: SafeFetch): ObserveDeps {
  return {
    safeFetch,
    github: { token: "unused", fetchImpl: vi.fn() as unknown as typeof fetch },
    registryFetch: vi.fn() as unknown as typeof fetch,
    dns: {
      resolve4: () => Promise.reject(new Error("unused")),
      resolveCname: () => Promise.reject(new Error("unused")),
      resolveTxt: () => Promise.reject(new Error("unused")),
    },
  };
}

describe("memoisation", () => {
  it("fetches one URL once for two fields read off it", async () => {
    const ast: SpecNode = {
      kind: "and",
      left: compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 200 }),
      right: compare(httpAccessor(URL_A, ["text"]), "contains", {
        type: "string",
        value: "Verify a receipt",
      }),
    };

    const safeFetch = vi.fn(async () => fakeResponse("<p>Verify a receipt</p>"));
    const requests = collectTargets(ast, ctx);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.fields).toHaveLength(2);

    const observations = await observeAll(
      requests,
      deps(safeFetch as unknown as SafeFetch),
      ctx,
    );
    expect(safeFetch).toHaveBeenCalledTimes(1);
    expect(observations).toHaveLength(1);

    const [only] = observations;
    if (only?.observed !== true) throw new Error("expected an observation");
    expect(only.values.status).toBe(200);
    expect(only.values.text).toContain("Verify a receipt");
    // §3.1: length in BYTES off the wire, not UTF-16 code units.
    expect(only.values["text.length"]).toBe(
      new TextEncoder().encode("<p>Verify a receipt</p>").byteLength,
    );
  });

  it("counts a third field on the same URL as the same fetch, and a second URL as another", async () => {
    const ast: SpecNode = {
      kind: "and",
      left: compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 200 }),
      right: {
        kind: "and",
        left: compare(httpAccessor(URL_A, ["text", "length"]), ">", {
          type: "int",
          value: 2000,
        }),
        right: compare(httpAccessor(URL_B, ["status"]), "==", { type: "int", value: 200 }),
      },
    };
    const safeFetch = vi.fn(async () => fakeResponse("x".repeat(3000)));
    await observeAll(collectTargets(ast, ctx), deps(safeFetch as unknown as SafeFetch), ctx);
    expect(safeFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches every source even when an earlier conjunct already decided the result (§4.2)", async () => {
    const ast: SpecNode = {
      kind: "and",
      // This one cannot hold — the fake answers 200 — and the second source is fetched anyway.
      left: compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 418 }),
      right: compare(httpAccessor(URL_B, ["status"]), "==", { type: "int", value: 200 }),
    };
    const safeFetch = vi.fn(async () => fakeResponse("body"));
    const observations = await observeAll(
      collectTargets(ast, ctx),
      deps(safeFetch as unknown as SafeFetch),
      ctx,
    );
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(observations).toHaveLength(2);
  });
});

describe("http evidence", () => {
  it("keeps only whitelisted headers (§6.2)", async () => {
    const ast = compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 200 });
    const [observation] = await observeAll(
      collectTargets(ast, ctx),
      deps((async () => fakeResponse("body")) as unknown as SafeFetch),
      ctx,
    );
    if (observation?.observed !== true) throw new Error("expected an observation");
    expect(observation.evidence.headers).toEqual({
      "content-type": "text/html",
      etag: '"abc"',
    });
    expect(observation.evidence.resolvedIp).toBe("203.0.113.7");
  });

  it("reads a whitelisted header and refuses one outside the list", async () => {
    const ast: SpecNode = {
      kind: "and",
      left: compare(httpAccessor(URL_A, ["header"], "ETag"), "==", {
        type: "string",
        value: '"abc"',
      }),
      right: compare(httpAccessor(URL_A, ["header"], "x-secret"), "==", {
        type: "string",
        value: "leak",
      }),
    };
    const [observation] = await observeAll(
      collectTargets(ast, ctx),
      deps((async () => fakeResponse("body")) as unknown as SafeFetch),
      ctx,
    );
    if (observation?.observed !== true) throw new Error("expected an observation");
    expect(observation.values['header("ETag")']).toBe('"abc"');
    expect(observation.values).not.toHaveProperty('header("x-secret")');
  });

  it("resolves a JSON pointer, and reports a non-JSON body as unreadable rather than null", async () => {
    const ast = compare(httpAccessor(URL_A, ["json"], "/deploy/status"), "==", {
      type: "string",
      value: "live",
    });

    const json = await observeAll(
      collectTargets(ast, ctx),
      deps((async () => fakeResponse('{"deploy":{"status":"live"}}')) as unknown as SafeFetch),
      ctx,
    );
    if (json[0]?.observed !== true) throw new Error("expected an observation");
    expect(json[0].values['json("/deploy/status")']).toBe("live");

    const html = await observeAll(
      collectTargets(ast, ctx),
      deps((async () => fakeResponse("<html>error</html>")) as unknown as SafeFetch),
      ctx,
    );
    if (html[0]?.observed !== true) throw new Error("expected an observation");
    // Absent, NOT null: "the server sent HTML" and "the server sent null" are different
    // observations, and flattening them lets a 500 page satisfy `.json("/x") != "y"`.
    expect(html[0].values).not.toHaveProperty('json("/deploy/status")');
  });
});

describe("INVARIANT I-7 at the source level", () => {
  it.each([
    ["blocked_address", "SSRF: blocked address range"],
    ["dns_failure", "getaddrinfo ENOTFOUND"],
    ["timeout", "body timeout"],
    ["body_too_large", "body exceeded 5MB"],
  ] as const)("maps a safe-fetch %s to observed: false", async (code, message) => {
    const ast = compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 200 });
    const failing: SafeFetch = () => {
      const error = new SafeFetchError(code, message);
      return Promise.reject(error);
    };
    const [observation] = await observeAll(collectTargets(ast, ctx), deps(failing), ctx);
    expect(observation?.observed).toBe(false);
    if (observation?.observed !== false) throw new Error("unreachable");
    expect(observation.error.code).toBe(code);
  });

  it("turns an observer that throws into observed: false rather than losing its siblings", async () => {
    const ast: SpecNode = {
      kind: "and",
      left: compare(httpAccessor(URL_A, ["status"]), "==", { type: "int", value: 200 }),
      right: compare(httpAccessor(URL_B, ["status"]), "==", { type: "int", value: 200 }),
    };
    const safeFetch: SafeFetch = (url) =>
      url === URL_A
        ? Promise.reject(new TypeError("a bug, not a target problem"))
        : Promise.resolve(fakeResponse("fine"));

    const observations = await observeAll(collectTargets(ast, ctx), deps(safeFetch), ctx);
    expect(observations).toHaveLength(2);
    expect(observations.filter((o) => o.observed)).toHaveLength(1);
    const failed = observations.find((o) => !o.observed);
    if (failed?.observed !== false) throw new Error("expected a failed observation");
    expect(failed.error.code).toBe("unexpected");
  });
});
