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
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, createDb, type Db } from "../src/client";
import { hashDoneSpec } from "../src/done-spec-hash";
import { loadDevEnv, requireEnv } from "../src/env";
import { insertCommitment } from "../src/queries/commitments";
import { account, ledgerEntry, probeRun } from "../src/schema";

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

  /**
   * v1 widened this by exactly one column and no further. `ledger_entry.account_id` is NOT
   * NULL and the worker appends entries, so migration 0001 grants SELECT on this one column.
   * What keeps the property intact is that it stays an OPAQUE UUID: the worker holds no
   * privilege at all on `account`, which the tests above assert directly. Reading the id is
   * not attribution; resolving it to a person is, and that is still refused.
   */
  it("reads commitment.account_id as an opaque id it cannot resolve to a person", async () => {
    await expect(
      probeDb.$client.unsafe("select account_id from commitment limit 1"),
    ).resolves.toBeDefined();
    await expectPermissionDenied(
      "select a.handle from commitment c join account a on a.id = c.account_id limit 1",
    );
  });

  it("can read exactly the columns evaluating a spec and appending an entry need", async () => {
    await expect(
      probeDb.$client.unsafe(
        "select id, done_spec_hash, deadline, status, committed_at, account_id from commitment limit 1",
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

  /**
   * v1 exit criterion, stated in roadmap.md as its own line: "`UPDATE ledger_entry` and
   * `DELETE FROM ledger_entry` both raise, tested." (CLAUDE.md I-2, architecture.md §5.2
   * rule 4.)
   *
   * Two layers, asserted separately because either one alone is a single point of failure:
   * the trigger stops the OWNER — the role a migration script runs as, which is the hand
   * §5.2 says the trigger exists to stop — and the grants stop the application roles before
   * the trigger is ever reached.
   */
  it("refuses to update or delete a ledger entry, even as the owner", async () => {
    const owner = createDb(requireEnv("DATABASE_URL"), { max: 1 });
    try {
      // Append through the real helper, so the row under test is a real chain entry and not
      // a hand-built one that the trigger might treat differently.
      const suffix = randomUUID().slice(0, 8);
      const [acct] = await owner
        .insert(account)
        .values({
          handle: `ledger-${suffix}`,
          email: `ledger-${suffix}@example.test`,
          githubId: -Number.parseInt(suffix, 16),
        })
        .returning();
      const { spec, hash } = hashDoneSpec({
        kind: "http_status",
        url: `https://${suffix}.ledger.test`,
        expectedStatus: 200,
      });
      const c = await insertCommitment(owner, {
        accountId: acct!.id,
        claim: "ledger immutability",
        spec,
        doneSpecHash: hash,
        deadline: new Date(Date.now() + 86_400_000),
      });
      const [entry] = await owner
        .select({ seq: ledgerEntry.seq })
        .from(ledgerEntry)
        .where(sql`${ledgerEntry.payload}->>'commitmentId' = ${c.id}`)
        .limit(1);
      expect(entry).toBeDefined();

      await expect(
        owner.$client.unsafe(
          `update ledger_entry set payload = '{"tampered":true}'::jsonb where seq = ${entry!.seq}`,
        ),
      ).rejects.toThrow(/immutable/i);
      await expect(
        owner.$client.unsafe(`delete from ledger_entry where seq = ${entry!.seq}`),
      ).rejects.toThrow(/immutable/i);
      // A blanket DELETE, which is the shape a panicking cleanup script actually takes.
      await expect(owner.$client.unsafe("delete from ledger_entry")).rejects.toThrow(
        /immutable/i,
      );
    } finally {
      await closeDb(owner);
    }
  });

  it("withholds UPDATE and DELETE on ledger_entry from the application roles", async () => {
    // The worker appends; it may never revise. `pledge_web` is NOLOGIN, so it is exercised
    // through SET ROLE on the owner's connection rather than its own.
    await expectPermissionDenied("update ledger_entry set payload = '{}'::jsonb");
    await expectPermissionDenied("delete from ledger_entry");

    const owner = createDb(requireEnv("DATABASE_URL"), { max: 1 });
    try {
      for (const statement of [
        "update ledger_entry set payload = '{}'::jsonb",
        "delete from ledger_entry",
      ]) {
        await expect(
          owner.$client.unsafe(`set role pledge_web; ${statement}`),
        ).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      await closeDb(owner);
    }
  });
});
