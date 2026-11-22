import assert from "node:assert/strict";
import { test } from "node:test";

import { describeHealth } from "./health.ts";

test("a healthy response names the version", () => {
  const body = { success: true, data: { version: "abc123", db: "ok" }, error: null };

  assert.equal(describeHealth(200, body), "API ok · database ok · version abc123");
});

test("an unhealthy response shows the status and the API's error", () => {
  const body = { success: false, data: null, error: "database unreachable" };

  assert.equal(describeHealth(503, body), "API not healthy (HTTP 503: database unreachable)");
});

test("a body that is not the expected shape is not healthy", () => {
  assert.equal(describeHealth(200, "<html>"), "API not healthy (HTTP 200)");
  assert.equal(describeHealth(502, null), "API not healthy (HTTP 502)");
});
