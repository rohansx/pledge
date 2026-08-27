-- Hand-extended after `drizzle-kit generate`. Everything below the "MANUAL" banner at the
-- bottom of this file is not derived from src/schema.ts and drizzle-kit will never regenerate
-- it. Migrations are forward-only; a change goes in a NEW file.
CREATE TABLE "amendment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commitment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"old_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_seq" bigint NOT NULL,
	CONSTRAINT "amendment_kind_known" CHECK (kind IN ('deadline_moved', 'abandoned')),
	CONSTRAINT "amendment_reason_not_blank" CHECK (length(btrim("amendment"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "chain_head" (
	"id" smallint PRIMARY KEY NOT NULL,
	"seq" bigint NOT NULL,
	"entry_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_head_single_row" CHECK ("chain_head"."id" = 1),
	CONSTRAINT "chain_head_seq_nonneg" CHECK ("chain_head"."seq" >= 0),
	CONSTRAINT "chain_head_hash_is_sha256_hex" CHECK ("chain_head"."entry_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"entry_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"prev_hash" text NOT NULL,
	"entry_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entry_seq_positive" CHECK ("ledger_entry"."seq" >= 1),
	CONSTRAINT "ledger_entry_type_known" CHECK (entry_type IN ('commitment_created', 'probe_result', 'amended', 'resolved', 'witness_attested')),
	CONSTRAINT "ledger_entry_payload_hash_is_sha256_hex" CHECK ("ledger_entry"."payload_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_entry_prev_hash_is_sha256_hex" CHECK ("ledger_entry"."prev_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ledger_entry_hash_is_sha256_hex" CHECK ("ledger_entry"."entry_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "witness" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commitment_id" uuid NOT NULL,
	"account_id" uuid,
	"email" "citext" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "witness_attestation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"witness_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"note" text,
	"signed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ledger_seq" bigint NOT NULL,
	CONSTRAINT "witness_attestation_verdict_known" CHECK (verdict IN ('confirms', 'disputes'))
);
--> statement-breakpoint
ALTER TABLE "commitment" ADD COLUMN "baseline_sha256" text;--> statement-breakpoint
ALTER TABLE "commitment" ADD COLUMN "baseline_captured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "amendment" ADD CONSTRAINT "amendment_commitment_id_commitment_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "amendment" ADD CONSTRAINT "amendment_ledger_seq_ledger_entry_seq_fk" FOREIGN KEY ("ledger_seq") REFERENCES "public"."ledger_entry"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness" ADD CONSTRAINT "witness_commitment_id_commitment_id_fk" FOREIGN KEY ("commitment_id") REFERENCES "public"."commitment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness" ADD CONSTRAINT "witness_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness_attestation" ADD CONSTRAINT "witness_attestation_witness_id_witness_id_fk" FOREIGN KEY ("witness_id") REFERENCES "public"."witness"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "witness_attestation" ADD CONSTRAINT "witness_attestation_ledger_seq_ledger_entry_seq_fk" FOREIGN KEY ("ledger_seq") REFERENCES "public"."ledger_entry"("seq") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "amendment_commitment_created_idx" ON "amendment" USING btree ("commitment_id","created_at");--> statement-breakpoint
CREATE INDEX "ledger_entry_account_seq_idx" ON "ledger_entry" USING btree ("account_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entry_hash_key" ON "ledger_entry" USING btree ("entry_hash");--> statement-breakpoint
CREATE INDEX "witness_commitment_idx" ON "witness" USING btree ("commitment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "witness_token_hash_key" ON "witness" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "witness_attestation_witness_key" ON "witness_attestation" USING btree ("witness_id");--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_baseline_hash_is_sha256_hex" CHECK ("commitment"."baseline_sha256" IS NULL OR "commitment"."baseline_sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "commitment" ADD CONSTRAINT "commitment_baseline_is_whole" CHECK (("commitment"."baseline_sha256" IS NULL) = ("commitment"."baseline_captured_at" IS NULL));
--> statement-breakpoint
-- ======================================================================================
-- MANUAL — genesis row, append-only enforcement, role grants
-- (architecture.md §5.2, §7; ADR-0003; CLAUDE.md I-2, I-3)
--
-- Everything below is hand-written and drizzle-kit will never regenerate it. Migrations are
-- forward-only: a change goes in a NEW file. Never DROP COLUMN on ledger_entry, chain_head,
-- amendment or witness_attestation — a dropped column silently changes what old entries mean.
-- ======================================================================================

-- --------------------------------------------------------------------------------------
-- Genesis.
--
-- seq 0 and 32 zero bytes, so the first real append is seq 1 with prev_hash = genesis
-- (architecture.md §5.2 rule 3). The row is created exactly once, here. Application code
-- that finds it missing must fail loudly rather than create it: a second chain_head row is a
-- second chain, and its first entry would claim a prev_hash nobody can check.
-- --------------------------------------------------------------------------------------
INSERT INTO chain_head (id, seq, entry_hash)
VALUES (1, 0, repeat('0', 64))
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- INVARIANT I-2 — ledger_entry is append-only.
--
-- Two layers, because either one alone is a single point of failure:
--   · the grants below withhold UPDATE and DELETE from every role, and
--   · this trigger raises regardless of who is connected — including the database owner,
--     which is the role a migration runs as.
--
-- The second layer is the point. architecture.md §5.2 is explicit that this is not paranoia
-- about attackers; it is paranoia about a migration script written at 1am. Do not drop this
-- trigger "temporarily" to fix data. There is no data to fix: an entry that is wrong is
-- corrected by appending a new entry that says so, which is the entire idea.
--
-- pledge_raise_immutable() is the function migration 0000 created for done_spec and
-- probe_run. Same reason, same enforcement, one function.
--
-- TRUNCATE is deliberately not covered, exactly as in 0000, so the local seed can reset a
-- scratch database. src/seed.ts resets chain_head to genesis when it does.
-- --------------------------------------------------------------------------------------
CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION pledge_raise_immutable();--> statement-breakpoint

-- An amendment is a statement someone made, with a reason, at a time. You do not get to
-- revise the reason you gave last month — that is the silent revision the table exists to
-- prevent.
CREATE TRIGGER amendment_immutable
  BEFORE UPDATE OR DELETE ON amendment
  FOR EACH ROW EXECUTE FUNCTION pledge_raise_immutable();--> statement-breakpoint

-- An attestation is permanent and public. That permanence is the only thing that makes a
-- careless vouch cost the voucher anything (security.md T-02); a deletable attestation is a
-- vouch with an undo button.
CREATE TRIGGER witness_attestation_immutable
  BEFORE UPDATE OR DELETE ON witness_attestation
  FOR EACH ROW EXECUTE FUNCTION pledge_raise_immutable();--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- Grants — web tier.
--
-- INSERT on ledger_entry, never UPDATE or DELETE. That asymmetry is I-2 expressed as a
-- privilege rather than a convention.
--
-- chain_head gets SELECT + UPDATE and nothing else: `SELECT … FOR UPDATE` needs the UPDATE
-- privilege, and the append then advances the row. No INSERT and no DELETE — the row is
-- seeded above and must never be recreated (see Genesis).
-- --------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON ledger_entry TO pledge_web;--> statement-breakpoint
GRANT SELECT, UPDATE ON chain_head TO pledge_web;--> statement-breakpoint
GRANT SELECT, INSERT ON amendment TO pledge_web;--> statement-breakpoint
GRANT SELECT, INSERT ON witness TO pledge_web;--> statement-breakpoint
-- Column-level UPDATE: the handler marks a link notified and spent, and nothing else. The
-- email, the token hash and the expiry are what the link's security rests on; making them
-- unwritable after insert means a bug in the attestation route cannot extend an expiry or
-- retarget an invitation.
GRANT UPDATE (notified_at, used_at) ON witness TO pledge_web;--> statement-breakpoint
GRANT SELECT, INSERT ON witness_attestation TO pledge_web;--> statement-breakpoint

-- --------------------------------------------------------------------------------------
-- Grants — probe worker.
--
-- The worker appends `probe_result` and `resolved` entries in the same transaction as the
-- probe_run insert and the status change (I-3), so it needs the same ledger privileges as
-- the web tier and the same chain_head lock.
--
-- STILL NOT GRANTED, and this is the important part: anything at all on `account`, `witness`
-- or `witness_attestation`. The worker fetches attacker-chosen URLs; a compromise there must
-- not reach a single email address (architecture.md §4).
--
-- `commitment.account_id` is added to the worker's column list because ledger_entry.account_id
-- is NOT NULL and the worker writes entries. It is an opaque UUID: with no privilege on
-- `account`, the worker cannot turn it into a person, which is the property that matters.
-- --------------------------------------------------------------------------------------
GRANT SELECT, INSERT ON ledger_entry TO pledge_probe;--> statement-breakpoint
GRANT SELECT, UPDATE ON chain_head TO pledge_probe;--> statement-breakpoint
GRANT SELECT (account_id) ON commitment TO pledge_probe;--> statement-breakpoint

-- The baseline snapshot: captured by a worker job enqueued at commit time (architecture.md
-- §6.1), read back by every later probe for the novelty check. Column-level, so the worker
-- still cannot rewrite a claim or a deadline.
GRANT SELECT (baseline_sha256, baseline_captured_at) ON commitment TO pledge_probe;--> statement-breakpoint
GRANT UPDATE (baseline_sha256, baseline_captured_at) ON commitment TO pledge_probe;
