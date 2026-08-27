/**
 * The baseline snapshot, against the real database.
 *
 * The property that matters is first-writer-wins. A baseline that could be overwritten would
 * let a target that changed *after* the promise become the thing later runs are compared
 * against — the novelty check would still run, still report a flag, and be silently wrong
 * about the only thing it exists to say (done-spec-dsl.md §6.3).
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import {
  account,
  closeDb,
  commitment,
  createDb,
  hashDoneSpec,
  insertCommitment,
  loadDevEnv,
  requireEnv,
  type Db,
} from "@pledge/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captureBaseline, loadOpenCommitment } from "./queries";

let owner: Db;
let probeDb: Db;

beforeAll(() => {
  loadDevEnv();
  owner = createDb(requireEnv("DATABASE_URL"), { max: 2 });
  probeDb = createDb(requireEnv("DATABASE_URL_PROBE"), { max: 2 });
});

afterAll(async () => {
  await closeDb(owner);
  await closeDb(probeDb);
});

const digest = (seed: string): string =>
  seed
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "0");

async function seedCommitment(): Promise<string> {
  const suffix = randomUUID().slice(0, 8);
  const [acct] = await owner
    .insert(account)
    .values({
      handle: `baseline-${suffix}`,
      email: `baseline-${suffix}@example.test`,
      githubId: -Number.parseInt(suffix, 16),
    })
    .returning({ id: account.id });

  const { spec, hash } = hashDoneSpec({
    kind: "http_status",
    url: `https://${suffix}.example.test/ship`,
    expectedStatus: 200,
  });

  const row = await insertCommitment(owner, {
    accountId: acct!.id,
    claim: "baseline capture",
    spec,
    doneSpecHash: hash,
    deadline: new Date(Date.now() + 86_400_000),
  });
  return row.id;
}

const stored = async (id: string) => {
  const [row] = await owner
    .select({
      baselineSha256: commitment.baselineSha256,
      baselineCapturedAt: commitment.baselineCapturedAt,
    })
    .from(commitment)
    .where(eq(commitment.id, id))
    .limit(1);
  return row!;
};

describe("captureBaseline", () => {
  it("stores the first digest and stamps the capture time from Postgres", async () => {
    const id = await seedCommitment();
    expect(await stored(id)).toMatchObject({ baselineSha256: null, baselineCapturedAt: null });

    const before = new Date();
    const returned = await captureBaseline(probeDb, id, digest("a"));

    expect(returned).toBe(digest("a"));
    const row = await stored(id);
    expect(row.baselineSha256).toBe(digest("a"));
    // I-8: the timestamp is Postgres `now()`, not a worker clock. All we can assert from here
    // is that it is real and recent.
    expect(row.baselineCapturedAt).not.toBeNull();
    expect(row.baselineCapturedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
  });

  it("refuses to overwrite, and reports the baseline that is actually in force", async () => {
    const id = await seedCommitment();
    await captureBaseline(probeDb, id, digest("a"));

    const second = await captureBaseline(probeDb, id, digest("b"));

    // The later run is told what the baseline IS, so it compares against the right thing
    // rather than against its own observation.
    expect(second).toBe(digest("a"));
    expect((await stored(id)).baselineSha256).toBe(digest("a"));
  });

  it("is safe under concurrent first captures — one wins and both are told which", async () => {
    const id = await seedCommitment();
    const [first, secondResult] = await Promise.all([
      captureBaseline(probeDb, id, digest("a")),
      captureBaseline(probeDb, id, digest("b")),
    ]);

    expect(first).toBe(secondResult);
    expect((await stored(id)).baselineSha256).toBe(first);
  });
});

describe("loadOpenCommitment", () => {
  it("hands the probe path the baseline it has to compare against", async () => {
    const id = await seedCommitment();
    expect((await loadOpenCommitment(probeDb, id))?.baselineDigest).toBeNull();

    await captureBaseline(probeDb, id, digest("c"));
    const target = await loadOpenCommitment(probeDb, id);
    expect(target?.baselineDigest).toBe(digest("c"));
    expect(target?.specVersion).toBe(0);
  });

  it("returns nothing once the commitment has left `open`", async () => {
    const id = await seedCommitment();
    await owner
      .update(commitment)
      .set({ status: "abandoned", resolvedAt: new Date() })
      .where(eq(commitment.id, id));

    expect(await loadOpenCommitment(probeDb, id)).toBeUndefined();
  });
});
