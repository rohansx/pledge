/**
 * The witness handler, against a real database.
 *
 * THE TEST THAT MATTERS is "a witness can never produce kept". Everything else here guards its
 * neighbours so a later refactor cannot quietly widen the ceiling (ADR-0006, security.md T-02,
 * architecture.md §6.3). If that assertion ever has to be relaxed, the product's core claim has
 * changed and this file is the wrong place to argue about it.
 *
 * Also covers both halves of the v1 exit criterion "cannot attest twice or after expiry" — the
 * spent-link half, which is a fact about a row and cannot be tested without one.
 *
 * Requires the local Postgres with migrations applied: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  account,
  closeDb,
  commitment,
  getDb,
  hashDoneSpec,
  insertCommitment,
  ledgerEntry,
  loadDevEnv,
  recordProbeRun,
  verifyLedgerChain,
  witness,
  witnessAttestation,
  type Db,
} from "@pledge/db";
import type { CommitmentStatus, DoneSpecV0, ProbeOutcome, ProbeResult } from "@pledge/db/types";

let db: Db;
let accountId: string;

let inviteWitnesses: typeof import("./witness").inviteWitnesses;
let recordAttestation: typeof import("./witness").recordAttestation;
let mintWitnessToken: typeof import("./witness-token").mintWitnessToken;
let parseWitnessToken: typeof import("./witness-token").parseWitnessToken;

const { spec, hash } = hashDoneSpec({
  kind: "http_status",
  url: "https://example.test/witnessed",
  expectedStatus: 200,
} satisfies DoneSpecV0);

beforeAll(async () => {
  loadDevEnv();
  // A deterministic key so the suite does not depend on a developer's .env.local having one.
  process.env["WITNESS_LINK_SECRET"] = "test-witness-secret";

  const witnessMod = await import("./witness");
  inviteWitnesses = witnessMod.inviteWitnesses;
  recordAttestation = witnessMod.recordAttestation;
  const tokenMod = await import("./witness-token");
  mintWitnessToken = tokenMod.mintWitnessToken;
  parseWitnessToken = tokenMod.parseWitnessToken;

  db = getDb();

  // Rows are left behind on purpose: ledger_entry and witness_attestation are append-only and
  // cleaning up would mean weakening the triggers that make them so.
  const suffix = randomUUID().slice(0, 8);
  const [row] = await db
    .insert(account)
    .values({
      handle: `wtest-${suffix}`,
      email: `wtest-${suffix}@example.test`,
      githubId: Number(BigInt(`0x${suffix}`)) * -1,
    })
    .returning();
  if (row === undefined) throw new Error("could not create test account");
  accountId = row.id;
});

afterAll(async () => {
  await closeDb(db);
});

async function newCommitment(claim = "test commitment") {
  return insertCommitment(db, {
    accountId,
    claim,
    spec,
    doneSpecHash: hash,
    deadline: new Date(Date.now() + 86_400_000),
  });
}

const probe = (outcome: ProbeOutcome): ProbeResult => ({
  probeKind: "http_status",
  outcome,
  evidence:
    outcome === "error" ? { error: { code: "timeout", message: "t" } } : { status: 200 },
  ranAt: new Date(Date.now() - 60_000),
  durationMs: 5,
});

/** Drives a commitment to a terminal probe outcome the way the worker would. */
async function resolveByProbe(commitmentId: string, outcome: ProbeOutcome): Promise<void> {
  await recordProbeRun(db, { commitmentId, result: probe(outcome), authoritative: true });
}

async function statusOf(id: string): Promise<CommitmentStatus> {
  const [row] = await db
    .select({ status: commitment.status })
    .from(commitment)
    .where(eq(commitment.id, id))
    .limit(1);
  if (row === undefined) throw new Error("commitment vanished");
  return row.status;
}

/** The one invitation for a commitment, with its usable token. */
async function inviteOne(commitmentId: string, email: string): Promise<string> {
  const invitations = await inviteWitnesses({ commitmentId, accountId, emails: [email] });
  const invitation = invitations[0];
  if (invitation === undefined) throw new Error("no invitation created");
  return invitation.token;
}

async function tokenHashOf(token: string): Promise<string> {
  const parsed = parseWitnessToken(token);
  if (!parsed.ok) throw new Error(`test token unusable: ${parsed.reason}`);
  return parsed.tokenHash;
}

describe("inviteWitnesses", () => {
  it("creates an invitation whose emailed token verifies and addresses that row", async () => {
    const c = await newCommitment();
    const token = await inviteOne(c.id, "friend@example.test");

    const parsed = parseWitnessToken(token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const [row] = await db
      .select()
      .from(witness)
      .where(eq(witness.tokenHash, parsed.tokenHash))
      .limit(1);

    expect(row?.commitmentId).toBe(c.id);
    expect(row?.id).toBe(parsed.witnessId);
    // The plaintext is never stored — a database leak hands out no working links.
    expect(row?.tokenHash).not.toBe(token);
    expect(row?.usedAt).toBeNull();
    expect(row?.accountId ?? null).toBeNull(); // accountless (ADR-0006)
  });

  it("skips an address already invited rather than burning its outstanding link", async () => {
    const c = await newCommitment();
    await inviteOne(c.id, "twice@example.test");
    const again = await inviteWitnesses({
      commitmentId: c.id,
      accountId,
      emails: ["TWICE@example.test"],
    });

    expect(again).toEqual([]);
    const rows = await db.select().from(witness).where(eq(witness.commitmentId, c.id));
    expect(rows).toHaveLength(1);
  });

  it("is not a ledger event — an invitation is private, an attestation is not", async () => {
    const c = await newCommitment();
    const before = await db.select().from(ledgerEntry);
    await inviteOne(c.id, "quiet@example.test");
    const after = await db.select().from(ledgerEntry);
    expect(after.length).toBe(before.length);
  });
});

describe("recordAttestation — the ceiling", () => {
  it("NEVER produces kept: confirming a missed commitment makes it contested, not kept", async () => {
    const c = await newCommitment();
    await resolveByProbe(c.id, "fail");
    expect(await statusOf(c.id)).toBe("missed");

    const token = await inviteOne(c.id, "vouch@example.test");
    const result = await recordAttestation({
      tokenHash: await tokenHashOf(token),
      verdict: "confirms",
      note: "I watched them do it",
    });

    expect(result).toMatchObject({ ok: true, contested: true });
    // The whole product in one assertion. A human said it was done and the record still does
    // not say kept, because only a probe can say that.
    expect(await statusOf(c.id)).toBe("disputed");
  });

  it("disputing a kept commitment makes it contested", async () => {
    const c = await newCommitment();
    await resolveByProbe(c.id, "pass");
    expect(await statusOf(c.id)).toBe("kept");

    const token = await inviteOne(c.id, "doubt@example.test");
    const result = await recordAttestation({
      tokenHash: await tokenHashOf(token),
      verdict: "disputes",
      note: null,
    });

    expect(result).toMatchObject({ ok: true, contested: true });
    expect(await statusOf(c.id)).toBe("disputed");
  });

  it("agreeing with the probe records the attestation and changes nothing", async () => {
    const c = await newCommitment();
    await resolveByProbe(c.id, "pass");

    const token = await inviteOne(c.id, "agree@example.test");
    const result = await recordAttestation({
      tokenHash: await tokenHashOf(token),
      verdict: "confirms",
      note: null,
    });

    expect(result).toMatchObject({ ok: true, contested: false });
    expect(await statusOf(c.id)).toBe("kept");
  });

  it("an open commitment has no probe outcome to contradict, so it stays open", async () => {
    const c = await newCommitment();
    const token = await inviteOne(c.id, "early@example.test");

    const result = await recordAttestation({
      tokenHash: await tokenHashOf(token),
      verdict: "disputes",
      note: "hasn't happened yet",
    });

    expect(result).toMatchObject({ ok: true, contested: false });
    expect(await statusOf(c.id)).toBe("open");
  });
});

describe("recordAttestation — the link", () => {
  it("cannot attest twice (v1 exit criterion)", async () => {
    const c = await newCommitment();
    const token = await inviteOne(c.id, "once@example.test");
    const tokenHash = await tokenHashOf(token);

    const first = await recordAttestation({ tokenHash, verdict: "confirms", note: null });
    expect(first.ok).toBe(true);

    const second = await recordAttestation({
      tokenHash,
      verdict: "disputes",
      note: "changed my mind",
    });
    expect(second).toEqual({ ok: false, reason: "used" });

    const parsed = parseWitnessToken(token);
    if (!parsed.ok) throw new Error("test token unusable");
    const rows = await db
      .select()
      .from(witnessAttestation)
      .where(eq(witnessAttestation.witnessId, parsed.witnessId));
    // One verdict per witness, forever. The second click changed nothing, including the note.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe("confirms");
    expect(rows[0]?.note).toBeNull();
  });

  it("cannot attest after expiry (v1 exit criterion)", async () => {
    const c = await newCommitment();
    // Built by hand rather than through inviteWitnesses: the invite path only ever mints a
    // 14-day link, and the expiry that matters here is the one in the row.
    const id = randomUUID();
    const expiresAt = new Date(Date.now() - 60_000);
    const minted = mintWitnessToken(id, expiresAt);
    await db.insert(witness).values({
      id,
      commitmentId: c.id,
      email: "late@example.test",
      tokenHash: minted.tokenHash,
      expiresAt: minted.expiresAt,
    });

    const result = await recordAttestation({
      tokenHash: minted.tokenHash,
      verdict: "confirms",
      note: null,
    });
    expect(result).toEqual({ ok: false, reason: "expired" });

    const rows = await db
      .select()
      .from(witnessAttestation)
      .where(eq(witnessAttestation.witnessId, id));
    expect(rows).toEqual([]);
  });

  it("refuses an unknown token hash without saying which part was wrong", async () => {
    const result = await recordAttestation({
      tokenHash: "0".repeat(64),
      verdict: "confirms",
      note: null,
    });
    expect(result).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("recordAttestation — the ledger (I-3)", () => {
  it("appends witness_attested in the same transaction, and resolved when contested", async () => {
    const c = await newCommitment();
    await resolveByProbe(c.id, "pass");

    const token = await inviteOne(c.id, "ledger@example.test");
    await recordAttestation({
      tokenHash: await tokenHashOf(token),
      verdict: "disputes",
      note: "not what I saw",
    });

    const entries = await db
      .select()
      .from(ledgerEntry)
      .where(eq(ledgerEntry.accountId, accountId));
    const mine = entries.filter(
      (entry) => (entry.payload as { commitmentId?: string }).commitmentId === c.id,
    );

    const attested = mine.filter((entry) => entry.entryType === "witness_attested");
    expect(attested).toHaveLength(1);
    // No email in a payload that is served publicly (payloads.ts rule 2).
    expect(JSON.stringify(attested[0]?.payload)).not.toContain("@");

    const resolved = mine.filter((entry) => entry.entryType === "resolved");
    // One from the probe, one from the witness.
    expect(resolved).toHaveLength(2);
    expect(
      resolved.map((entry) => (entry.payload as { resolvedBy: string }).resolvedBy),
    ).toContain("witness");
    // And no witness entry ever claims kept.
    for (const entry of resolved) {
      const payload = entry.payload as { status: string; resolvedBy: string };
      if (payload.resolvedBy === "witness") expect(payload.status).toBe("disputed");
    }
  });

  it("leaves the chain intact", async () => {
    const verification = await verifyLedgerChain(db);
    expect(verification.breaks).toEqual([]);
    expect(verification.headMatches).toBe(true);
  });
});
