import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { createApp } from "./app.ts";

async function get(checkDb: () => Promise<void>, path: string) {
  const server = createApp(checkDb, "abc123").listen(0);
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test("healthz reports the version when the database answers", async () => {
  const { status, body } = await get(async () => {}, "/api/healthz");

  assert.equal(status, 200);
  assert.deepEqual(body, { success: true, data: { version: "abc123", db: "ok" }, error: null });
});

test("healthz is 503 and hides the cause when the database is unreachable", async (t) => {
  t.mock.method(console, "error", () => {});

  const { status, body } = await get(async () => {
    throw new Error("password authentication failed for user pledge");
  }, "/api/healthz");

  assert.equal(status, 503);
  assert.deepEqual(body, { success: false, data: null, error: "database unreachable" });
});

test("unknown paths are 404 in the same envelope", async () => {
  const { status, body } = await get(async () => {}, "/api/nope");

  assert.equal(status, 404);
  assert.deepEqual(body, { success: false, data: null, error: "not found" });
});
