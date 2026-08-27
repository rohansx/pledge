-- v1: the done-spec evaluator writes probe_run rows with probe_kind = 'spec'.
--
-- Forward-only and additive: the CHECK is widened, never narrowed, so every row already in
-- probe_run stays legal and keeps meaning exactly what it meant. Dropping and re-adding a
-- CHECK is not a column drop — nothing in probe_run loses its meaning here (CLAUDE.md,
-- conventions).
--
-- `NOT VALID` is deliberately NOT used: the new predicate is strictly weaker than the old one,
-- so every existing row satisfies it and the full-table validation scan is free.
ALTER TABLE "probe_run" DROP CONSTRAINT "probe_run_kind_known";--> statement-breakpoint
ALTER TABLE "probe_run" ADD CONSTRAINT "probe_run_kind_known" CHECK (probe_kind IN ('http_status', 'github_release_tag', 'spec'));
