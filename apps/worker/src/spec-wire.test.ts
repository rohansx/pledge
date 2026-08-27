/**
 * The v1 seams, round-tripped through the REAL database.
 *
 * Two payloads cross a tier boundary as jsonb, where typecheck cannot see them and a rename or
 * a dropped key fails silently at runtime rather than loudly at build time:
 *
 *   done_spec.ast        apps/web `compile()` → jsonb → apps/worker `SpecNodeSchema.parse`
 *   probe_run.evidence   apps/worker `SpecProbeEvidence` → jsonb → the receipt builder,
 *                        AND its digest onto the permanent chain
 *
 * This is the same class of bug ./queue-contract.test.ts was written for: the probe job payload
 * had drifted between the tiers, nothing failed loudly, and commitments sat `open`. So the
 * assertions are the round trip through Postgres, never an object literal compared to itself.
 *
 * The third thing proved here is smaller and was a hard blocker until migration 0002: a
 * `probe_run` row with `probe_kind = 'spec'` is accepted by `probe_run_kind_known` at all.
 * Before it, every v1 commitment ever created was unresolvable — the insert raised, the job
 * retried, and the commitment stayed `open` forever.
 *
 * Requires the local Postgres and an applied migration: `pnpm db:up && pnpm db:migrate`.
 */
import { randomUUID } from "node:crypto";
import {
  account,
  closeDb,
  createDb,
  insertCommitment,
  ledgerEntry,
  loadDevEnv,
  probeRun,
  recordProbeRun,
  requireEnv,
  type Db,
} from "@pledge/db";
import { payloadSha256 } from "@pledge/ledger";
import { SPEC_VERSION, SpecNodeSchema, compile, print } from "@pledge/spec";
import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOpenCommitment } from "./queries";
import { SPEC_PROBE_KIND, type SpecProbeEvidence } from "./spec-probe";

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

/**
 * Deliberately not a one-liner: nested boolean structure, a modifier carrying a named instant,
 * two different sources, a string literal and an int literal. Those are the shapes jsonb could
 * mangle — key order inside `compare`, an int that comes back as a string, a dropped empty
 * `modifiers` array — and a single `http(...).status == 200` would exercise none of them.
 */
const SOURCE = (suffix: string): string =>
  `http("https://${suffix}.example.test/ship").status == 200 and ` +
  `github.commits("pledge/${suffix}").since(commit_time).count > 3`;

async function seedV1Commitment(suffix: string): Promise<{ id: string; source: string }> {
  const [acct] = await owner
    .insert(account)
    .values({
      handle: `specwire-${suffix}`,
      email: `specwire-${suffix}@example.test`,
      githubId: -Number.parseInt(suffix, 16),
    })
    .returning({ id: account.id });

  const compiled = compile(SOURCE(suffix));
  if (!compiled.ok) throw new Error(`fixture does not compile: ${JSON.stringify(compiled.issues)}`);

  const row = await insertCommitment(owner, {
    accountId: acct!.id,
    claim: "spec wire contract",
    spec: compiled.spec.ast,
    doneSpecHash: compiled.spec.hash,
    // The one field that must come from the same variable as the AST. A v1 AST stored under
    // spec_version 0 would be handed to the v0 evaluator forever.
    specVersion: SPEC_VERSION,
    deadline: new Date(Date.now() + 86_400_000),
  });
  return { id: row.id, source: compiled.spec.dslSource };
}

describe("done_spec.ast — apps/web writes it, apps/worker reads it", () => {
  it("survives jsonb intact: the worker's parse succeeds and prints the same source", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { id, source } = await seedV1Commitment(suffix);

    // Read as `pledge_probe`, the column-restricted role the worker actually connects with —
    // reading it back as the owner would prove less than the production path proves.
    const target = await loadOpenCommitment(probeDb, id);
    expect(target?.specVersion).toBe(SPEC_VERSION);

    // The parse the probe path does. A dropped or renamed key fails right here.
    const ast = SpecNodeSchema.parse(target!.spec);

    // And the strong form: not merely parseable, but the SAME spec. `print` is the fixed point
    // of §5.1, so equal source means equal canonical bytes means equal hash — which is the
    // thing the commitment is actually bound to (I-4).
    expect(print(ast)).toBe(source);
  });

  it("the stored hash still addresses the stored AST", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { id } = await seedV1Commitment(suffix);
    const target = await loadOpenCommitment(probeDb, id);

    // Re-compiling the printed form must land on the hash the row is keyed by. If jsonb had
    // reordered an object or widened a number, this is where a content-addressed row would
    // stop being addressed by its own content.
    const recompiled = compile(print(SpecNodeSchema.parse(target!.spec)));
    expect(recompiled.ok).toBe(true);
    expect(recompiled.ok && recompiled.spec.hash).toBe(target!.doneSpecHash);
  });
});

describe("probe_run.evidence — apps/worker writes it, the receipt builder reads it", () => {
  /** A two-source v1 evidence record, the shape ./spec-probe.ts actually produces. */
  const evidenceFor = (): SpecProbeEvidence => ({
    specVersion: SPEC_VERSION,
    observations: [
      {
        source: "http:https://example.test/ship",
        observed: true,
        observedAt: "2026-08-27T10:00:00.000Z",
        values: { status: 200, "text.length": 4096 },
        evidence: {
          status: 200,
          headers: { "content-type": "text/html" },
          bodySha256: "a".repeat(64),
          bodyBytes: 4096,
          resolvedIp: "93.184.216.34",
        },
      },
      {
        source: "github.commits:pledge/x+since=2026-08-01T00:00:00.000Z",
        observed: false,
        observedAt: "2026-08-27T10:00:01.000Z",
        error: { code: "connection_failed", message: "ECONNREFUSED" },
        evidence: {},
      },
    ],
    subresults: [
      { nodePath: "and.0", value: true },
      { nodePath: "and.1", value: false },
    ],
    targetDigest: "b".repeat(64),
    status: 200,
    headers: { "content-type": "text/html" },
  });

  it("stores under probe_kind 'spec' and comes back with every observation", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { id } = await seedV1Commitment(suffix);
    const evidence = evidenceFor();

    // The real writer, including its ledger append — not a hand-rolled INSERT. `error` and not
    // `fail`: one source could not be observed (I-7), so nothing resolves.
    const recorded = await recordProbeRun(probeDb, {
      commitmentId: id,
      result: {
        probeKind: SPEC_PROBE_KIND,
        outcome: "error",
        evidence,
        ranAt: new Date(),
        durationMs: 12,
      },
      authoritative: false,
    });
    expect(recorded.transitioned).toBe(false);
    expect(recorded.status).toBe("open");

    const [stored] = await owner
      .select({ kind: probeRun.probeKind, evidence: probeRun.evidence })
      .from(probeRun)
      .where(eq(probeRun.id, recorded.probeRunId));

    expect(stored?.kind).toBe("spec");
    // Structural equality after a jsonb round trip. Nested arrays of mixed-shape objects are
    // exactly what a naive column type or an over-strict Zod schema would flatten.
    expect(stored?.evidence).toEqual(JSON.parse(JSON.stringify(evidence)));
  });

  it("the chain's evidence digest covers the bytes that are actually stored", async () => {
    const suffix = randomUUID().slice(0, 8);
    const { id } = await seedV1Commitment(suffix);

    const recorded = await recordProbeRun(probeDb, {
      commitmentId: id,
      result: {
        probeKind: SPEC_PROBE_KIND,
        outcome: "pass",
        evidence: evidenceFor(),
        ranAt: new Date(),
        durationMs: 12,
      },
      authoritative: false,
    });

    const [stored] = await owner
      .select({ evidence: probeRun.evidence })
      .from(probeRun)
      .where(eq(probeRun.id, recorded.probeRunId));

    const [entry] = await owner
      .select({ payload: ledgerEntry.payload })
      .from(ledgerEntry)
      .where(
        sql`${ledgerEntry.entryType} = 'probe_result' and ${ledgerEntry.payload}->>'probeRunId' = ${recorded.probeRunId}`,
      )
      .orderBy(desc(ledgerEntry.seq))
      .limit(1);

    const payload = entry!.payload as { evidenceSha256: string; probeKind: string };
    expect(payload.probeKind).toBe("spec");
    // THE assertion. `evidenceSha256` is computed from the in-memory object before the INSERT;
    // if jsonb stored anything different, re-hashing the row would disagree and every "the
    // evidence was not edited afterwards" check a reader can run would be a check of nothing.
    expect(payload.evidenceSha256).toBe(payloadSha256(stored!.evidence));
  });
});
