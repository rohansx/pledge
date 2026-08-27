/**
 * Drizzle schema.
 *
 * v0: `account`, `done_spec`, `commitment`, `probe_run`.
 * v1: `chain_head`, `ledger_entry`, `amendment`, `witness`, `witness_attestation`, plus the
 *     baseline-snapshot columns on `commitment`. All additive — v0's shapes were designed so
 *     the ledger could arrive insert-only, and nothing above had to change to gain a
 *     `ledger_seq`.
 *
 * Still deliberately absent: `checkpoint`, `cohort`, `calibration_fit`. Checkpoints and Rekor
 * anchoring are v2 and ADR-0005 is *Proposed, not accepted* — a table here would be code that
 * assumes an outcome. Cohorts and calibration are later phases.
 *
 * Column definitions follow docs/technical-spec.md §3. Deviations are commented where they
 * occur; every one of them is narrowing, never widening.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  amendmentKinds,
  ledgerEntryTypes,
  witnessVerdicts,
  type AmendmentKind,
  type LedgerEntryType,
  type WitnessVerdict,
} from "@pledge/ledger";
import type {
  CommitmentStatus,
  DoneSpecV0,
  ProbeEvidence,
  ProbeKind,
  ProbeOutcome,
} from "./types";
import { commitmentStatuses, probeKinds, probeOutcomes } from "./types";

/**
 * Case-insensitive text. Handles and emails are compared case-insensitively everywhere, so
 * the database is the right place to say so once rather than every call site remembering
 * `lower()`. The extension is created in migration 0000.
 */
const citext = customType<{ data: string }>({ dataType: () => "citext" });

/** `timestamptz`, always. Store UTC, render in the committer's zone (CLAUDE.md I-9). */
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/** Renders a `text` column's CHECK against a const tuple, so schema and types can't drift. */
const oneOf = (column: string, values: readonly string[]) =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(", ")})`);

// ---------------------------------------------------------------------------------------
// account
// ---------------------------------------------------------------------------------------

export const account = pgTable(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Claimed from the GitHub login at first sign-in. Also the public profile URL. */
    handle: citext("handle").notNull(),
    email: citext("email").notNull(),
    /** GitHub's numeric user id — stable across a rename, unlike the login. */
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`now()`),
    plan: text("plan").notNull().default("free"),
  },
  (t) => [
    uniqueIndex("account_handle_key").on(t.handle),
    uniqueIndex("account_github_id_key").on(t.githubId),
  ],
);

// ---------------------------------------------------------------------------------------
// done_spec — immutable, content-addressed (CLAUDE.md I-4)
// ---------------------------------------------------------------------------------------

/**
 * One row per distinct done-condition. Two users committing to the same spec share the row,
 * which is what makes the hash a *contract* rather than a per-commitment detail.
 *
 * NEVER UPDATE A ROW HERE. An edited spec has a different hash and is therefore a different
 * commitment. Migration 0000 installs a `BEFORE UPDATE OR DELETE` trigger that raises, for
 * the same reason architecture.md §5.2 wants one on the ledger: not paranoia about
 * attackers, paranoia about a migration script written at 1am.
 *
 * DEVIATION from technical-spec §3: `hash` is lowercase hex `text` with a CHECK, not `bytea`. The hash
 * is a primary key, a foreign key and a URL segment; every one of those wants a string, and
 * drizzle has no first-class `bytea`, so `bytea` would mean a custom type plus Buffer
 * juggling at every call site to store the same 256 bits.
 *
 * DEVIATION: no `dsl_source`. v0 has no DSL (roadmap v0: "No DSL, no parser"), so the column
 * would be NULL on every row and every reader would have to handle that. It arrives with the
 * parser in v1 as a nullable column add.
 */
export const doneSpec = pgTable(
  "done_spec",
  {
    /** sha256 of the canonical JSON of the spec. See ./done-spec-hash.ts — that is the only
     * thing permitted to produce this value. */
    hash: text("hash").primaryKey(),
    /** The spec itself. Named `ast` because v1 stores a parsed AST here under the same key. */
    ast: jsonb("ast").$type<DoneSpecV0>().notNull(),
    /** Pins evaluation semantics: a v0 spec always evaluates under v0 rules. */
    specVersion: smallint("spec_version").notNull(),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    check("done_spec_hash_is_sha256_hex", sql`${t.hash} ~ '^[0-9a-f]{64}$'`),
    check("done_spec_version_known", sql`${t.specVersion} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------
// commitment
// ---------------------------------------------------------------------------------------

export const commitment = pgTable(
  "commitment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    claim: text("claim").notNull(),
    doneSpecHash: text("done_spec_hash")
      .notNull()
      .references(() => doneSpec.hash),
    /** Postgres `now()` at insert, never an application clock (CLAUDE.md I-8). */
    committedAt: tz("committed_at")
      .notNull()
      .default(sql`now()`),
    /** UTC instant. The committer's local end-of-day is resolved to UTC before it lands. */
    deadline: tz("deadline").notNull(),
    /** The committer's own estimate. Input to the v2 forecast; unused in v0. */
    estimatedDays: numeric("estimated_days"),
    visibility: text("visibility")
      .$type<"public" | "unlisted" | "private">()
      .notNull()
      .default("public"),
    status: text("status").$type<CommitmentStatus>().notNull().default("open"),
    /**
     * For `kept`: the ran_at of the EARLIEST passing probe, not the time the worker noticed
     * (architecture.md §6.2). For `missed`/`disputed`: the authoritative run's time. Never
     * an application clock.
     */
    resolvedAt: tz("resolved_at"),
    /**
     * What the target looked like BEFORE the work: sha256 of the target body, captured by a
     * job enqueued at commit time, not at first probe (architecture.md §6.1).
     *
     * This is the whole basis of the novelty check. A probe that passes against a
     * byte-identical page is flagged `unchanged_since_commitment` and rendered as such
     * (technical-spec §5, anti-gaming). Nullable because the capture can legitimately fail —
     * the target may be down at commit time — and a missing baseline means "we cannot say",
     * never "unchanged".
     */
    baselineSha256: text("baseline_sha256"),
    /** When the baseline was observed. Null iff `baseline_sha256` is null. */
    baselineCapturedAt: tz("baseline_captured_at"),
  },
  (t) => [
    index("commitment_account_committed_idx").on(t.accountId, t.committedAt.desc()),
    /** The worker's due-scan: open commitments ordered by deadline. */
    index("commitment_open_deadline_idx").on(t.status, t.deadline),
    check("commitment_status_known", oneOf("status", commitmentStatuses)),
    check(
      "commitment_visibility_known",
      oneOf("visibility", ["public", "unlisted", "private"]),
    ),
    /**
     * architecture.md §5.3, verbatim in intent: a resolved commitment must carry the instant
     * it was resolved at.
     *
     * Be honest about what this does NOT do: it cannot tell *who* set the status, so it is
     * not what enforces the no-self-report claim. That enforcement is
     * scripts/check-invariants.mjs — a build-time grep over apps/web — plus the grants in
     * migration 0000. The constraint only rules out a resolution with no timestamp.
     */
    check(
      "commitment_status_transitions_are_earned",
      sql`
        ${t.status} = 'open'
        OR (${t.status} IN ('kept','missed','disputed') AND ${t.resolvedAt} IS NOT NULL)
        OR ${t.status} = 'abandoned'
      `,
    ),
    check(
      "commitment_open_is_unresolved",
      sql`${t.status} <> 'open' OR ${t.resolvedAt} IS NULL`,
    ),
    check(
      "commitment_baseline_hash_is_sha256_hex",
      sql`${t.baselineSha256} IS NULL OR ${t.baselineSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    /** A hash with no capture time is unattributable; a capture time with no hash is noise. */
    check(
      "commitment_baseline_is_whole",
      sql`(${t.baselineSha256} IS NULL) = (${t.baselineCapturedAt} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------------------
// probe_run — append-only observation log
// ---------------------------------------------------------------------------------------

/**
 * One row per probe execution. Rows are observations, never conclusions: a duplicate pg-boss
 * delivery inserting a second row is harmless by design (architecture.md §6.2).
 *
 * DEVIATION from technical-spec §3: no `evidence_blob_key`. That is an R2 object key and v0
 * has no R2 bucket; the archived-body flow arrives with the novelty check in v1.
 */
export const probeRun = pgTable(
  "probe_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitment.id),
    probeKind: text("probe_kind").$type<ProbeKind>().notNull(),
    /**
     * When the target was observed. Supplied by the worker (it is an observation time, not a
     * state-change time) but clamped against Postgres `now()` on insert — see
     * ./queries/probes.ts. `resolved_at` is derived from this column, so an unclamped value
     * would let worker clock skew backdate a resolution.
     */
    ranAt: tz("ran_at").notNull(),
    /**
     * CLAUDE.md I-7, the invariant most worth restating at the storage layer:
     *   pass  — observed, done-condition TRUE
     *   fail  — observed, done-condition FALSE
     *   error — NOT observed. Never resolves anything as missed.
     */
    outcome: text("outcome").$type<ProbeOutcome>().notNull(),
    evidence: jsonb("evidence").$type<ProbeEvidence>().notNull(),
    durationMs: integer("duration_ms").notNull(),
  },
  (t) => [
    index("probe_run_commitment_ran_idx").on(t.commitmentId, t.ranAt),
    check("probe_run_outcome_known", oneOf("outcome", probeOutcomes)),
    check("probe_run_kind_known", oneOf("probe_kind", probeKinds)),
    check("probe_run_duration_nonneg", sql`${t.durationMs} >= 0`),
  ],
);

export type AccountRow = typeof account.$inferSelect;
export type DoneSpecRow = typeof doneSpec.$inferSelect;
export type CommitmentRow = typeof commitment.$inferSelect;
export type ProbeRunRow = typeof probeRun.$inferSelect;

// =======================================================================================
// v1 — the ledger and the tables that write to it
// =======================================================================================

/**
 * The single-row serialisation point for every chain append (ADR-0003).
 *
 * `SELECT ... FOR UPDATE` on this row is a global write lock on the append path. That is a
 * deliberate throughput ceiling, not an oversight: at the design volume the lock is held for
 * about a millisecond, which leaves three orders of magnitude of headroom, and it removes
 * every ordering bug a per-account chain would introduce (architecture.md §7).
 *
 * It also exists because `bigserial` cannot do this job. A sequence hands out its next value
 * outside the transaction, so a rollback burns it and the chain gets a gap — and a gapless
 * `seq` is precisely the property that makes a deleted entry detectable
 * (architecture.md §5.2 rule 1, security.md T-03).
 *
 * Starts at seq 0 / 32 zero bytes, seeded by the migration, so the first real append is
 * seq 1 with `prev_hash` = genesis.
 */
export const chainHead = pgTable(
  "chain_head",
  {
    /** Always 1. The CHECK is what makes "single row" a property rather than a convention. */
    id: smallint("id").primaryKey(),
    /** The seq of the most recent entry. 0 before the first append. */
    seq: bigint("seq", { mode: "number" }).notNull(),
    /** The most recent entry's `entry_hash`, or GENESIS_PREV_HASH before the first append. */
    entryHash: text("entry_hash").notNull(),
    updatedAt: tz("updated_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    check("chain_head_single_row", sql`${t.id} = 1`),
    check("chain_head_seq_nonneg", sql`${t.seq} >= 0`),
    check("chain_head_hash_is_sha256_hex", sql`${t.entryHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

/**
 * The append-only hash chain. One global chain; per-account views are filtered projections,
 * which is itself an anti-backdating property — your entries are provably interleaved with
 * everyone else's (architecture.md §7).
 *
 * INVARIANT I-2: no UPDATE, no DELETE, ever, in application code or in a migration. The
 * migration installs a `BEFORE UPDATE OR DELETE` trigger that raises, and the grants withhold
 * both privileges from every role. Do not drop the trigger "temporarily".
 *
 * INVARIANT I-3: a row here is written in the same transaction as the state change it
 * records. `appendLedgerEntry` in ./queries/ledger.ts accepts a transaction handle and
 * nothing else, so "append it afterwards" is not a shape the API can express.
 *
 * DEVIATION from technical-spec §3, the same one done_spec made and for the same reasons:
 * hashes are lowercase hex `text` with a CHECK, not `bytea`. They are compared, logged, put
 * in URLs and serialised into receipts as hex; drizzle has no first-class `bytea`, so `bytea`
 * would mean Buffer juggling at every call site to store the same 256 bits.
 *
 * DEVIATION: `seq` is a plain `bigint`, not `bigserial` — see chain_head above.
 */
export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    /** Gapless and monotonic from 1. Allocated by chain_head under FOR UPDATE. */
    seq: bigint("seq", { mode: "number" }).primaryKey(),
    /** Whose story this entry belongs to. The per-account ledger view filters on it. */
    accountId: uuid("account_id")
      .notNull()
      .references(() => account.id),
    entryType: text("entry_type").$type<LedgerEntryType>().notNull(),
    /**
     * The claim itself, validated against the schema for `entry_type` before it was hashed
     * (@pledge/ledger payloads.ts). Public: this is served at /v1/accounts/:handle/ledger,
     * so no email and no token ever goes in here.
     */
    payload: jsonb("payload").notNull(),
    /** sha256(JCS(payload)). Step 1 of verification recomputes it. */
    payloadSha256: text("payload_sha256").notNull(),
    /** The previous entry's `entry_hash`; 32 zero bytes for seq 1. */
    prevHash: text("prev_hash").notNull(),
    /** sha256(prev_hash || payload_sha256 || u64le(seq)). */
    entryHash: text("entry_hash").notNull(),
    /**
     * Postgres `now()` inside the transaction — CLAUDE.md I-8, no exceptions. There is no way
     * to pass a timestamp to the append helper, which is the point: an application clock here
     * would let a skewed worker or a hostile process backdate the permanent record.
     */
    createdAt: tz("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("ledger_entry_account_seq_idx").on(t.accountId, t.seq),
    /** A repeated entry_hash means a repeated (prev, payload, seq) — i.e. a broken chain. */
    uniqueIndex("ledger_entry_hash_key").on(t.entryHash),
    check("ledger_entry_seq_positive", sql`${t.seq} >= 1`),
    check("ledger_entry_type_known", oneOf("entry_type", ledgerEntryTypes)),
    check("ledger_entry_payload_hash_is_sha256_hex", sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`),
    check("ledger_entry_prev_hash_is_sha256_hex", sql`${t.prevHash} ~ '^[0-9a-f]{64}$'`),
    check("ledger_entry_hash_is_sha256_hex", sql`${t.entryHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

// ---------------------------------------------------------------------------------------
// amendment — deadline moves and withdrawals, recorded rather than applied silently
// ---------------------------------------------------------------------------------------

/**
 * `commitment.deadline` holds the *current* deadline for query convenience; this table holds
 * the authoritative history. A commitment whose deadline moved twice and then landed on time
 * is a materially different signal from one that never moved, and hiding that would make
 * pledge exactly the thing it criticises (architecture.md §5.1).
 *
 * `reason` is NOT NULL and CHECKed non-empty. A deadline that moves without a stated reason
 * is the silent revision this whole table exists to prevent.
 *
 * Append-only, by the same trigger as done_spec and probe_run: you do not get to revise the
 * reason you gave last month.
 */
export const amendment = pgTable(
  "amendment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitment.id),
    kind: text("kind").$type<AmendmentKind>().notNull(),
    /** For `deadline_moved`: `{ deadline: <ISO> }`. For `abandoned`: null. */
    oldValue: jsonb("old_value").$type<string>(),
    newValue: jsonb("new_value").$type<string>(),
    reason: text("reason").notNull(),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`now()`),
    /** The ledger entry recording this amendment. NOT NULL: I-3 means it always exists. */
    ledgerSeq: bigint("ledger_seq", { mode: "number" })
      .notNull()
      .references(() => ledgerEntry.seq),
  },
  (t) => [
    index("amendment_commitment_created_idx").on(t.commitmentId, t.createdAt),
    check("amendment_kind_known", oneOf("kind", amendmentKinds)),
    check("amendment_reason_not_blank", sql`length(btrim(${t.reason})) > 0`),
  ],
);

// ---------------------------------------------------------------------------------------
// witness / witness_attestation — accountless, magic-link (ADR-0006)
// ---------------------------------------------------------------------------------------

/**
 * An invitation to attest. The witness has no account and never gets one (ADR-0006): the
 * link is scoped to one `witness.id`, single-use, and expires.
 *
 * `token_hash`, not `token`. What is emailed is a secret; what is stored is a hash of it, so
 * a database leak does not hand out working attestation links. The HMAC and the token format
 * belong to apps/web — this column only says "never store the plaintext".
 *
 * `account_id` is nullable and is the *rare* case: it is set only when the witness happens to
 * already have a pledge account. Do not make it required — that is the design ADR-0006
 * rejected, and the reason is adoption, not convenience.
 *
 * NOT granted to pledge_probe, at all: this table holds email addresses and the probe worker
 * fetches hostile URLs (architecture.md §4).
 */
export const witness = pgTable(
  "witness",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    commitmentId: uuid("commitment_id")
      .notNull()
      .references(() => commitment.id),
    /** Set only if the witness already had an account. Usually null. */
    accountId: uuid("account_id").references(() => account.id),
    email: citext("email").notNull(),
    /** Hash of the magic-link token. Never the token itself. */
    tokenHash: text("token_hash").notNull(),
    /** ADR-0006: 14 days. Enforced by the handler; stored here so it is auditable. */
    expiresAt: tz("expires_at").notNull(),
    notifiedAt: tz("notified_at"),
    /** Single-use. Set when the link is spent; a spent link cannot attest again. */
    usedAt: tz("used_at"),
    createdAt: tz("created_at")
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("witness_commitment_idx").on(t.commitmentId),
    uniqueIndex("witness_token_hash_key").on(t.tokenHash),
  ],
);

/**
 * The attestation itself. Append-only and permanent — the witness's identity sits on the
 * public profile forever, which is the only thing that makes a careless vouch cost the
 * voucher anything (security.md T-02).
 *
 * One per witness, enforced by the unique index on `witness_id`. That is half of "cannot
 * attest twice"; the other half is `witness.used_at`.
 *
 * A `disputes` verdict can push a commitment to `disputed`. Nothing here can produce `kept`
 * — only a probe does that (ADR-0006, architecture.md §6.3). That is not enforceable by a
 * constraint on this table; it is enforced by the resolved-payload schema in @pledge/ledger
 * and by there being no such code path.
 */
export const witnessAttestation = pgTable(
  "witness_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    witnessId: uuid("witness_id")
      .notNull()
      .references(() => witness.id),
    verdict: text("verdict").$type<WitnessVerdict>().notNull(),
    note: text("note"),
    signedAt: tz("signed_at")
      .notNull()
      .default(sql`now()`),
    ledgerSeq: bigint("ledger_seq", { mode: "number" })
      .notNull()
      .references(() => ledgerEntry.seq),
  },
  (t) => [
    uniqueIndex("witness_attestation_witness_key").on(t.witnessId),
    check("witness_attestation_verdict_known", oneOf("verdict", witnessVerdicts)),
  ],
);

export type ChainHeadRow = typeof chainHead.$inferSelect;
export type LedgerEntryRow = typeof ledgerEntry.$inferSelect;
export type AmendmentRow = typeof amendment.$inferSelect;
export type WitnessRow = typeof witness.$inferSelect;
export type WitnessAttestationRow = typeof witnessAttestation.$inferSelect;
