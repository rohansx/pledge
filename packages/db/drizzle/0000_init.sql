-- Hand-extended after `drizzle-kit generate`. Everything below the "MANUAL" banner at the
-- bottom of this file — the immutability triggers and the role grants — is not derived from
-- src/schema.ts and drizzle-kit will never regenerate it. Do not re-run generate expecting to
-- get it back; migrations are forward-only, so a change goes in a NEW file.
CREATE EXTENSION IF NOT EXISTS citext;--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"handle" "citext" NOT NULL,
	"email" "citext" NOT NULL,
	"github_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"claim" text NOT NULL,
	"done_spec_hash" text NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"estimated_days" numeric,
	"visibility" text DEFAULT 'public' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "commitment_status_known" CHECK (status IN ('open', 'kept', 'missed', 'abandoned', 'disputed')),
	CONSTRAINT "commitment_visibility_known" CHECK (visibility IN ('public', 'unlisted', 'private')),
	CONSTRAINT "commitment_status_transitions_are_earned" CHECK (
        "commitment"."status" = 'open'
        OR ("commitment"."status" IN ('kept','missed','disputed') AND "commitment"."resolved_at" IS NOT NULL)
        OR "commitment"."status" = 'abandoned'
      ),
	CONSTRAINT "commitment_open_is_unresolved" CHECK ("commitment"."status" <> 'open' OR "commitment"."resolved_at" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "done_spec" (
	"hash" text PRIMARY KEY NOT NULL,
	"ast" jsonb NOT NULL,
	"spec_version" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "done_spec_hash_is_sha256_hex" CHECK ("done_spec"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "done_spec_version_known" CHECK ("done_spec"."spec_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "probe_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commitment_id" uuid NOT NULL,
	"probe_kind" text NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	CONSTRAINT "probe_run_outcome_known" CHECK (outcome IN ('pass', 'fail', 'error')),
	CONSTRAINT "probe_run_kind_known" CHECK (probe_kind IN ('http_status', 'github_release_tag')),
	CONSTRAINT "probe_run_duration_nonneg" CHECK ("probe_run"."duration_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_done_spec_hash_done_spec_hash_fk" FOREIGN KEY ("done_spec_hash") REFERENCES "public"."done_spec"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_run" ADD CONSTRAINT "probe_run_commitment_id_commitment_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_handle_key" ON "account" USING btree ("handle");--> statement-breakpoint
CREATE UNIQUE INDEX "account_github_id_key" ON "account" USING btree ("github_id");--> statement-breakpoint
CREATE INDEX "commitment_account_committed_idx" ON "commitment" USING btree ("account_id","committed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "commitment_open_deadline_idx" ON "commitment" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "probe_run_commitment_ran_idx" ON "probe_run" USING btree ("commitment_id","ran_at");
--> statement-breakpoint
-- ======================================================================================
-- MANUAL — append-only triggers and role grants (architecture.md §4, §5.2)
-- ======================================================================================

-- done_spec and probe_run are immutable records, for different reasons:
--   done_spec  — content-addressed. An edited spec is a different hash, therefore a
--                different commitment. Mutating a row would make the hash a lie (I-4).
--   probe_run  — an observation log. You do not get to revise what was observed.
-- The trigger is not paranoia about attackers; it is paranoia about a migration script
-- written at 1am (architecture.md §5.2). Statement-level TRUNCATE is intentionally not
-- covered, so the dev seed can reset a scratch database.
CREATE OR REPLACE FUNCTION pledge_raise_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden: rows in this table are immutable', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER done_spec_immutable
  BEFORE UPDATE OR DELETE ON done_spec
  FOR EACH ROW EXECUTE FUNCTION pledge_raise_immutable();--> statement-breakpoint

CREATE TRIGGER probe_run_immutable
  BEFORE UPDATE OR DELETE ON probe_run
  FOR EACH ROW EXECUTE FUNCTION pledge_raise_immutable();--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- Roles.
--
-- Created NOLOGIN and passwordless: a password in a migration is a secret in source
-- control. Local dev attaches a login in src/migrate.ts from .env.local; deployed
-- environments provision the password out of band.
--
-- `pledge_calib` and `pledge_anchor` are absent — calibration and anchoring are v2, and a
-- role created without a live consumer is a role whose grants nobody reviews.
-- --------------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pledge_web') THEN
    CREATE ROLE pledge_web NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pledge_probe') THEN
    CREATE ROLE pledge_probe NOLOGIN;
  END IF;
END
$$;--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO pledge_web, pledge_probe;--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- Web tier.
--
-- Table-level UPDATE on `commitment` is deliberate and is NOT a hole being tolerated: the
-- web tier legitimately writes `visibility`, and v1 amendments write the deadline. A
-- column-level UPDATE grant here would look tighter while enforcing nothing extra, because
-- `status` would still have to be writable for `abandoned`.
--
-- Be honest about the limit: no grant can express "may set status to abandoned but not to
-- kept", because Postgres privileges cannot see the value being written. The enforcement of
-- the no-self-report invariant is scripts/check-invariants.mjs, a build-time grep over
-- apps/web (architecture.md §5.3 says this plainly). The grants below reduce blast radius;
-- they do not enforce I-1.
--
-- Narrower than architecture.md §4 in one place: no UPDATE on `done_spec`. Those rows are
-- immutable, so the grant would only ever be used by mistake.
-- --------------------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON account TO pledge_web;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON commitment TO pledge_web;--> statement-breakpoint
GRANT SELECT, INSERT ON done_spec TO pledge_web;--> statement-breakpoint
-- Read-only: the web tier renders evidence, it never records an observation.
GRANT SELECT ON probe_run TO pledge_web;--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- Probe worker. Cannot see who anyone is.
--
-- NOT GRANTED, deliberately: any privilege at all on `account`. Not SELECT, not on a
-- narrowed column list. The worker fetches hostile URLs; if that path is compromised it
-- must not be able to read a single email address. This is the grant whose absence is the
-- feature.
--
-- The column list on `commitment` is exactly what evaluating a done-spec needs. `claim` is
-- absent: it is user-authored prose that can name people, and the probe does not read it.
-- --------------------------------------------------------------------------------------
GRANT SELECT (id, done_spec_hash, deadline, status, committed_at) ON commitment TO pledge_probe;--> statement-breakpoint
-- Resolution. architecture.md §4's grant list omits this while §6.2 has the worker writing
-- `status`; §6.2 is the one that describes a working system. Narrowed to the two columns a
-- resolution touches, so the worker cannot rewrite a claim or a deadline.
GRANT UPDATE (status, resolved_at) ON commitment TO pledge_probe;--> statement-breakpoint
GRANT SELECT ON done_spec TO pledge_probe;--> statement-breakpoint
-- SELECT as well as INSERT: `resolved_at` is min(ran_at) over passing runs, and
-- INSERT ... RETURNING needs SELECT on the returned columns.
GRANT SELECT, INSERT ON probe_run TO pledge_probe;--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- pg-boss self-migrates on start, so whichever role runs the queue needs to own its schema.
-- The worker owns it (it is the only process that must drain the queue even if the web tier
-- is down); the web tier gets DML on the tables pg-boss creates, because the commit flow
-- enqueues the probe schedule inside the commitment's own transaction (architecture.md §6.1).
-- --------------------------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION pledge_probe;--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO pledge_probe', current_database());
END
$$;--> statement-breakpoint
GRANT USAGE ON SCHEMA pgboss TO pledge_web;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE pledge_probe IN SCHEMA pgboss
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pledge_web;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES FOR ROLE pledge_probe IN SCHEMA pgboss
  GRANT USAGE, SELECT ON SEQUENCES TO pledge_web;
