/**
 * v0 Drizzle schema — `account`, `done_spec`, `commitment`, `probe_run`. Nothing else.
 *
 * `ledger_entry`, `chain_head`, `checkpoint`, `amendment`, `witness`, `cohort` and
 * `calibration_fit` are deliberately absent. They are v1/v2 and the roadmap's v0 anti-goal
 * says so explicitly: the ledger feels foundational, and building it eats the phase. The
 * shapes here are designed so adding it later is insert-only — no column in this file has to
 * change to gain a `ledger_seq`.
 *
 * Column definitions follow docs/technical-spec.md §3. Deviations are commented where they
 * occur; there are three and they are all narrowing, never widening.
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
