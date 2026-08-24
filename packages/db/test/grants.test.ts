/**
 * The probe worker must not be able to learn who anyone is (architecture.md §4).
 *
 * These are negative tests, and that is the whole point: a column-level grant is what turns
 * "the worker shouldn't read emails" from a code-review comment into a property of the
 * system, and a property nobody asserts is a property that quietly stops holding.
 *
 * Statements go through the raw postgres.js client rather than drizzle, so the assertion can
 * see Postgres's own SQLSTATE instead of drizzle's wrapper message.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/client";
import { hashDoneSpec } from "../src/done-spec-hash";
import { loadDevEnv, requireEnv } from "../src/env";
import { insertCommitment } from "../src/queries/commitments";
import { account, probeRun } from "../src/schema";

let probeDb: Db;

beforeAll(() => {
  loadDevEnv();
  probeDb = createDb(requireEnv("DATABASE_URL_PROBE"), { max: 1 });
});

afterAll(async () => {
  await closeDb(probeDb);
});

/**
 * Asserts SQLSTATE 42501 — insufficient_privilege — specifically. A test that accepted any
 * error would pass just as happily against a typo'd table name, which is exactly how a
 * security test rots into decoration.
 */
async function expectPermissionDenied(statement: string): Promise<void> {
  await expect(probeDb.$client.unsafe(statement)).rejects.toMatchObject({ code: "42501" });
}

describe("pledge_probe grants", () => {
  it("cannot read account.email", async () => {
    await expectPermissionDenied("select email from account");
  });

  it("cannot read the account table at all", async () => {
    await expectPermissionDenied("select * from account");
    await expectPermissionDenied("select handle from account");
    await expectPermissionDenied("select count(*) from account");
  });

  it("cannot join its way to an identity", async () => {
    await expectPermissionDenied(
      "select a.email from commitment c join account a on a.id = c.account_id limit 1",
    );
  });

  it("cannot read commitment.claim — user prose the probe has no use for", async () => {
    await expectPermissionDenied("select claim from commitment");
    await expectPermissionDenied("select * from commitment");
  });

  it("cannot read commitment.account_id, so runs are not attributable to a person", async () => {
    await expectPermissionDenied("select account_id from commitment");
  });

  it("can read exactly the five columns evaluating a spec needs", async () => {
    await expect(
      probeDb.$client.unsafe(
        "select id, done_spec_hash, deadline, status, committed_at from commitment limit 1",
      ),
    ).resolves.toBeDefined();
    await expect(
      probeDb.$client.unsafe("select hash, ast from done_spec limit 1"),
    ).resolves.toBeDefined();
  });

  it("cannot rewrite a claim or move a deadline", async () => {
    await expectPermissionDenied("update commitment set claim = 'rewritten'");
    await expectPermissionDenied("update commitment set deadline = now()");
  });

  it("cannot delete an observation or a commitment", async () => {
    await expectPermissionDenied("delete from probe_run");
    await expectPermissionDenied("delete from commitment");
  });

  it("cannot write a done_spec", async () => {
    await expectPermissionDenied(
      "insert into done_spec (hash, ast, spec_version) values (repeat('b', 64), '{}'::jsonb, 0)",
    );
  });
});

describe("immutability triggers", () => {
  it("refuses to update or delete a done_spec row, even as the owner", async () => {
    // If the owner cannot do it, no role can — and the owner is who a migration script runs
    // as, which is the hand this trigger exists to stop (architecture.md §5.2).
    const owner = createDb(requireEnv("DATABASE_URL"), { max: 1 });
    const hash = "a".repeat(64);
    try {
      await owner.$client.unsafe(`
        insert into done_spec (hash, ast, spec_version)
        values ('${hash}', '{"kind":"http_status","url":"https://x.test","expectedStatus":200}'::jsonb, 0)
        on conflict do nothing
      `);
      await expect(
        owner.$client.unsafe(`update done_spec set spec_version = 1 where hash = '${hash}'`),
      ).rejects.toThrow(/immutable/i);
      await expect(
        owner.$client.unsafe(`delete from done_spec where hash = '${hash}'`),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await closeDb(owner);
    }
  });

  it("refuses to revise an observation", async () => {
    const owner = createDb(requireEnv("DATABASE_URL"), { max: 1 });
    try {
      // Make its own row rather than assuming one exists: a `where` that matches nothing
      // never fires the trigger, and this test would then be asserting nothing.
      const suffix = randomUUID().slice(0, 8);
      const [acct] = await owner
        .insert(account)
        .values({
          handle: `trigger-${suffix}`,
          email: `trigger-${suffix}@example.test`,
          githubId: -Number.parseInt(suffix, 16),
        })
        .returning();
      const { spec, hash } = hashDoneSpec({
        kind: "http_status",
        url: `https://${suffix}.test`,
        expectedStatus: 200,
      });
      const c = await insertCommitment(owner, {
        accountId: acct!.id,
        claim: "trigger test",
        spec,
        doneSpecHash: hash,
        deadline: new Date(Date.now() + 86_400_000),
      });
      const [run] = await owner
        .insert(probeRun)
        .values({
          commitmentId: c.id,
          probeKind: "http_status",
          outcome: "error",
          evidence: { error: { code: "timeout", message: "trigger test" } },
          ranAt: new Date(),
          durationMs: 1,
        })
        .returning({ id: probeRun.id });

      await expect(
        owner.$client.unsafe(`update probe_run set outcome = 'fail' where id = '${run!.id}'`),
      ).rejects.toThrow(/immutable/i);
      await expect(
        owner.$client.unsafe(`delete from probe_run where id = '${run!.id}'`),
      ).rejects.toThrow(/immutable/i);
    } finally {
      await closeDb(owner);
    }
  });
});
