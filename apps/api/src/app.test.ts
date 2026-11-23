import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp, type AppOptions } from "./app.ts";
import type { Scan } from "./schema.ts";
import { MemoryScanStore } from "./store.ts";

const TOKEN = "test-token";

export const SCAN: Scan = {
  schema_version: 1,
  app: "shop",
  scenario: "checkout",
  verdict: "broken",
  faults: { name: "lost-payment-reply", description: "Half the payment replies are lost.", faults: [{ kind: "retry", target: "app POST /payments", params: { rate: 0.5 } }] },
  env: {},
  pledges: [
    {
      id: "one-charge-per-order", statement: "An order is charged exactly once.", status: "approved", source: "domain_template", confidence: "high",
      assertion: "one_charge_per_order", result: "broken", kept: 0, broken: 1, unknown: 0,
      seeds: [{ seed: 1, run_id: "run_1", status: "fail", expected: { "/orders_charged_more_than_once": 0 }, actual: { "/orders_charged_more_than_once": 13 } }],
    },
  ],
  runs: [{ seed: 1, run_id: "run_1", verdict: "fail", faults_injected: 13, journeys: 20, limitations: [] }],
  sandbox: { template: "pledge-base", outbound_blocked: true, seconds: { total: 29.4 } },
  authoring: null,
};

interface Call {
  method?: string;
  token?: string | null;
  body?: unknown;
}

async function call(path: string, { method = "GET", token = TOKEN, body }: Call = {}, options: Partial<AppOptions> = {}) {
  const store = options.store ?? new MemoryScanStore();
  const server = createApp({ checkDb: async () => {}, version: "abc123", token: TOKEN, ...options, store }).listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, {
      method,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), store };
  } finally {
    server.close();
  }
}

test("healthz needs no token and reports the version when the database answers", async () => {
  const { status, body } = await call("/api/healthz", { token: null });

  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, data: { version: "abc123", db: "ok" }, error: null });
});

test("healthz is 503 and hides the cause when the database is unreachable", async (t) => {
  t.mock.method(console, "error", () => {});

  const { status, body } = await call("/api/healthz", {}, { checkDb: async () => { throw new Error("password authentication failed for user pledge"); } });

  assert.equal(status, 503);
  assert.deepEqual(body, { success: false, data: null, error: "database unreachable" });
});

test("unknown paths are 404 in the same envelope", async () => {
  const { status, body } = await call("/api/nope");

  assert.equal(status, 404);
  assert.deepEqual(body, { success: false, data: null, error: "not found" });
});

for (const [name, token] of [["no token", null], ["a wrong token", "nope"], ["a token that only shares a prefix", "test-toke"]] as const) {
  test(`scan routes refuse ${name}`, async () => {
    for (const request of [{ method: "GET" }, { method: "POST", body: SCAN }]) {
      const { status, body, store } = await call("/api/scans", { ...request, token });

      assert.equal(status, 401);
      assert.equal(body.error, "a valid token is required");
      assert.deepEqual(await store.list(), []);
    }
  });
}

test("scan routes are closed, not open, when no token is configured", async () => {
  const { status, body } = await call("/api/scans", {}, { token: undefined });

  assert.equal(status, 503);
  assert.equal(body.error, "scan routes are not configured");
});

test("a posted scan is stored, listed as a summary and returned whole by id", async () => {
  const created = await call("/api/scans", { method: "POST", body: SCAN });
  assert.equal(created.status, 201);
  const summary = created.body.data;
  assert.deepEqual({ ...summary, id: "", created_at: "" }, {
    id: "", created_at: "", app: "shop", scenario: "checkout", verdict: "broken", faults: "lost-payment-reply", authored: false, pledges: 1, broken: 1, run_verdicts: ["fail"],
  });

  const listed = await call("/api/scans", {}, { store: created.store });
  assert.deepEqual(listed.body.data, [summary]);

  const fetched = await call(`/api/scans/${summary.id}`, {}, { store: created.store });
  assert.equal(fetched.status, 200);
  assert.deepEqual(fetched.body.data.scan, SCAN);
});

test("an unknown scan id is 404", async () => {
  const { status } = await call("/api/scans/00000000-0000-4000-8000-000000000000");

  assert.equal(status, 404);
});

const invalid: [string, unknown, string][] = [
  ["a missing field", { ...SCAN, scenario: undefined }, "scenario"],
  ["an unknown field", { ...SCAN, extra: 1 }, "body"],
  ["an unknown verdict", { ...SCAN, verdict: "great" }, "verdict"],
  ["no runs", { ...SCAN, runs: [] }, "runs"],
  ["an over-long statement", { ...SCAN, pledges: [{ ...SCAN.pledges[0], statement: "x".repeat(1001) }] }, "pledges.0.statement"],
];
for (const [name, body, where] of invalid) {
  test(`a scan with ${name} is refused and not stored`, async () => {
    const { status, body: reply, store } = await call("/api/scans", { method: "POST", body });

    assert.equal(status, 422);
    assert.match(reply.error, new RegExp(`^invalid scan: ${where.replaceAll(".", "\\.")}`));
    assert.deepEqual(await store.list(), []);
  });
}

test("a body that is not JSON is 400 and an oversized one is 413", async () => {
  assert.equal((await call("/api/scans", { method: "POST", body: "not json" })).status, 400);
  assert.equal((await call("/api/scans", { method: "POST", body: "x".repeat(1024 * 1024 + 1) })).status, 413);
});
