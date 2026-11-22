# pledge — agent operating instructions

pledge issues verifiable credentials for execution: a commitment is a claim plus a
machine-checkable done-spec plus a deadline, resolved by probes against external state,
recorded in an append-only hash-chained ledger, and exported as a signed receipt a third party
can verify without trusting us. Start at [`README.md`](./README.md); the design lives in
[`docs/`](./docs/).

## Invariants

Violating one of these breaks the product's core claim, not a feature. Each is checkable.

| # | Rule |
|---|---|
| I-1 | **No code path in `apps/web` may write `commitment.status IN ('kept','missed')`**. Resolution is written only by the probe worker or the witness-attestation handler. A build-time grep check enforces this; do not disable, narrow, or exempt it. *Note: ADR-0010 (PROPOSED) suggests a self-reported tier with status `IN ('self_kept','self_missed')`, excluded from calibration fits. This invariant remains unchanged — `apps/web` still never writes the authoritative statuses. Do not assume ADR-0010 is accepted until it is.* |
| I-2 | `ledger_entry` is append-only. No `UPDATE`, no `DELETE`. A `BEFORE UPDATE OR DELETE` trigger raises; do not drop it. |
| I-3 | A ledger append happens in the **same transaction** as the state change it records. If append fails, state change rolls back. No eventually-consistent ledger. |
| I-4 | `done_spec` rows are immutable and content-addressed. Never mutate one. Edited spec = new hash = different commitment. |
| I-5 | Never fetch a user-supplied URL with bare `fetch`, `axios`, or raw `undici`. Use `@pledge/safe-fetch`. A second HTTP path is how SSRF dies. |
| I-6 | `packages/spec` must not import from `packages/db` or Node-only code. Runs in browser (composer) and verifier CLI (no database). |
| I-7 | A probe unable to observe the target is `error`, never `fail`. Only a FALSE done-condition is a failure. Collapsing them marks people as missed due to network blips. |
| I-8 | Never generate ledger timestamp in application code. Postgres `now()`, inside the transaction. |
| I-9 | Store UTC, render in committer's zone. Deadline arithmetic tested against Asia/Kolkata (UTC+05:30, no DST). |
| I-10 | LLM output is never trusted directly. It is parsed by `@pledge/spec` (I-6), content-addressed to a done-spec hash, and the hash becomes the contract. LLM can refuse or fail; the result is advisory only. |

## Before writing code

| Touching | Read first |
|---|---|
| the DSL — grammar, canonicalisation, evaluation | [`docs/spec/done-spec-dsl.md`](./docs/spec/done-spec-dsl.md) |
| probes — fetching, scheduling, evidence, anti-gaming | [`docs/technical-spec.md`](./docs/technical-spec.md) §5 and [`docs/security.md`](./docs/security.md) T-01 |
| the ledger, the chain head, any state transition | [`docs/architecture.md`](./docs/architecture.md) §5 — invariants in §5.2, no-self-report in §5.3 |
| the calibration fit | [`docs/calibration.md`](./docs/calibration.md) §4, the censoring section, before touching the likelihood |
| receipts, signing, verification | [`docs/spec/receipt-format.md`](./docs/spec/receipt-format.md) — §3, the signed subset, is normative; changing what it covers is a format break |

## Decisions already made

Do not "improve" these without a new ADR. One line each.

| ADR | Status | Decision |
|---|---|---|
| [0001](./docs/adr/0001-typescript-over-rust.md) | ACCEPTED | TypeScript end to end, not Rust. |
| [0002](./docs/adr/0002-postgres-for-queue.md) | ACCEPTED | pg-boss on same Postgres; queue and ledger share a transaction. |
| [0003](./docs/adr/0003-global-chain-lock.md) | ACCEPTED | One global advisory lock; deliberate throughput ceiling. |
| [0004](./docs/adr/0004-python-sidecar-for-calibration.md) | ACCEPTED | Python only for nightly fit; no request path calls it. |
| [0006](./docs/adr/0006-accountless-witnesses.md) | ACCEPTED | Witnesses need no account; signup before attestation kills adoption. |
| [0007](./docs/adr/0007-ast-derived-features.md) | ACCEPTED | Calibration features from AST; never user-supplied tags. |
| [0009](./docs/adr/0009-name-pledge-over-kept.md) | ACCEPTED | Name forward-looking; product backward-looking. Record always leads. |
| [0005](./docs/adr/0005-defer-rekor-anchoring.md) | PROPOSED | Defer Rekor anchoring past v2. Do not assume either outcome. |
| [0008](./docs/adr/0008-calibration-over-all-visibilities.md) | PROPOSED | Calibrate over all visibilities, not public-only. Do not assume either outcome. |
| [0010](./docs/adr/0010-self-reported-verification-tier.md) | **PROPOSED** | **Self-reported tier as 4th verification rung; excluded from calibration fits.** Reversal of v0.2 position. Do not write code assuming acceptance. |
| [0011](./docs/adr/0011-calibration-rank-and-seasons.md) | **PROPOSED** | **Calibration Rank (ungameable, on Brier Skill Score) + seasonal leaderboard.** Reversal of v0.2 "no leaderboard" position. Do not assume. |
| [0012](./docs/adr/0012-llm-in-the-pledge-creation-path.md) | **PROPOSED** | **Scope Negotiator LLM at pledge creation, outside transaction, output content-addressed.** Reversal of v0.2 "no LLM on request path" (ADR-0004). Do not assume. |
| [0013](./docs/adr/0013-individual-pro-over-organizer-gtm.md) | **PROPOSED** | **Individual Pro subscriptions primary; cohorts secondary (covenants).** Reversal of v0.2 "organizers pay" position. Do not assume. |
| [0014](./docs/adr/0014-charity-escrow-for-stakes.md) | **PROPOSED** | **Money stakes escrowed to charity/beneficiary, never the platform.** Do not assume acceptance. |

## Conventions

- Drizzle migrations are forward-only. Never `DROP COLUMN` on `ledger_entry`, `commitment`,
  `done_spec`, or `probe_run` — a dropped column silently changes what old entries mean.
- One Zod schema per shape, shared by the route handler and the client form. A second
  hand-written validator on either side is a divergence waiting to happen.
- DB role grants (`pledge_web`, `pledge_worker`, `pledge_anchor`) live in the first migration.
  Least privilege is not retrofitted later — a role added without explicit grants inherits
  more than it should, and nobody notices until it matters.
- The preview environment must never run probe workers. Worker entrypoints are gated on
  `PLEDGE_ROLE=worker`, which is set in production and nowhere else. Preview probing would
  hit real user targets from an unpinned egress IP.

## Tests that carry weight

| Test | Why |
|---|---|
| no-self-report grep | The one test whose failure invalidates the product rather than a feature (I-1). |
| SSRF corpus | `127.0.0.1`, `169.254.169.254`, `[::1]`, `0.0.0.0`, decimal and octal IP forms, redirect-to-private, DNS rebinding across a redirect hop. One assertion each. |
| DSL canonicalisation round-trip and semantic injectivity | `parse(print(ast)) == ast`, and two specs sharing a hash must mean the same thing. Property tests, not examples. |
| full-chain walk in CI | Recompute every `entry_hash` from genesis against the seeded DB; any mismatch fails the build. |
| calibration censoring, two-way | Fit with the censored likelihood, then again dropping censored rows. The drop-rows fit **must** show optimistic bias. If it does not, the test is not exercising censoring and the test is wrong. |
| IST deadline arithmetic | Deadlines at 23:30 and 00:15 IST, across a UTC date boundary, in both directions. |

## User-facing copy

- **Lead with receipts, not intentions.** "You shipped X on Sept 15" not "You promised X by Sept 15".
  The record is the credential.
- The word **accountability** appears nowhere. Neither does "hold yourself", "stay on track",
  streaks, or motivational framing.
- Never write "shipped at" when the system knows "observed at" (and by what proof). The
  distinction between intention and observation is the entire trust argument.
- Verification tier always visible: machine-verified > peer-attested > self-reported. Never
  hide the method.
- Never render a kept badge without the spec source and evidence link one click away. A badge
  whose criterion is not inspectable is the thing pledge exists to replace.
- Slip is a coaching diagnostic, not a shame label. "You slip ~8 days on release-sized work.
  Plan accordingly or adjust confidence."
