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
| I-1 | No code path in `apps/web` may write `commitment.status IN ('kept','missed')`. Resolution is written only by the probe worker or the witness-attestation handler. A build-time grep check enforces this — do not disable it, narrow it, or exempt files from it. |
| I-2 | `ledger_entry` is append-only. No `UPDATE`, no `DELETE`, not in application code and not in a migration. A `BEFORE UPDATE OR DELETE` trigger raises; do not drop it "temporarily". |
| I-3 | A ledger append happens in the **same transaction** as the state change it records. If the append fails, the state change rolls back. There is no eventually-consistent ledger. |
| I-4 | `done_spec` rows are immutable and content-addressed. Never mutate one. An edited spec is a new hash and therefore a different commitment. |
| I-5 | Never fetch a user-supplied URL with bare `fetch`, `axios`, or a raw `undici` client. Use `@pledge/safe-fetch`. A second HTTP path around it is how the SSRF defence dies. |
| I-6 | `packages/spec` must not import from `packages/db`, or from anything Node-only. It runs in the browser for composer preview and in the verifier CLI with no database at all. |
| I-7 | A probe that could not observe the target is `error`, never `fail`. Only an observation that the done-condition is FALSE is a failure. Collapsing the two marks people as having missed because of a network blip. |
| I-8 | Never generate a ledger timestamp in application code. Postgres `now()`, inside the transaction. |
| I-9 | Store UTC, render in the committer's zone. Deadline arithmetic is tested against `Asia/Kolkata` — UTC+05:30, no DST, and half-hour offsets break naive date maths. |

## Before writing code

| Touching | Read first |
|---|---|
| the DSL — grammar, canonicalisation, evaluation | [`docs/spec/done-spec-dsl.md`](./docs/spec/done-spec-dsl.md) |
| probes — fetching, scheduling, evidence, anti-gaming | [`docs/technical-spec.md`](./docs/technical-spec.md) §5 and [`docs/security.md`](./docs/security.md) T-01 |
| the ledger, the chain head, any state transition | [`docs/architecture.md`](./docs/architecture.md) §5 — invariants in §5.2, no-self-report in §5.3 |
| the calibration fit | [`docs/calibration.md`](./docs/calibration.md) §4, the censoring section, before touching the likelihood |
| receipts, signing, verification | [`docs/spec/receipt-format.md`](./docs/spec/receipt-format.md) — §3, the signed subset, is normative; changing what it covers is a format break |

## Decisions already made

Do not "improve" these without a new ADR. One line each; the file carries the reasoning and
the rejected alternatives.

| ADR | Decision |
|---|---|
| [0001](./docs/adr/0001-typescript-over-rust.md) | TypeScript end to end, not Rust. v0.1's axum plan was a habit choice; nothing here is CPU-bound. |
| [0002](./docs/adr/0002-postgres-for-queue.md) | pg-boss on the same Postgres, not Redis or SQS. The queue and the ledger have to share a transaction. |
| [0003](./docs/adr/0003-global-chain-lock.md) | One global advisory lock serialises chain appends. A deliberate throughput ceiling, not an oversight. |
| [0004](./docs/adr/0004-python-sidecar-for-calibration.md) | Python exists only for the nightly fit. No request path may call it. |
| [0006](./docs/adr/0006-accountless-witnesses.md) | Witnesses need no account. Requiring signup before attestation kills witness adoption. |
| [0007](./docs/adr/0007-ast-derived-features.md) | Calibration features are derived from the spec AST, never from user-supplied tags or difficulty labels. |
| [0009](./docs/adr/0009-name-pledge-over-kept.md) | The name is forward-looking; the product is backward-looking. Every surface leads with the record, not the promise. This guard needs active defence at every copy review — it is the ADR most likely to be forgotten. |

[ADR-0005](./docs/adr/0005-defer-rekor-anchoring.md) (defer Rekor anchoring) and
[ADR-0008](./docs/adr/0008-calibration-over-all-visibilities.md) (calibrate over all
visibilities) are **PROPOSED, not accepted**. Do not write code that assumes either outcome,
and do not cite them as settled in comments or docs.

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

- Lead with the record, not the promise. The past tense is the product.
- The word **accountability** appears nowhere in the product. Neither does "hold yourself",
  "stay on track", or streak language.
- Never write "shipped at" when the system knows "observed at". That distinction is the whole
  trust argument; blurring it in copy blurs it in users' heads.
- Never render a kept badge without the spec source one click away. A badge whose criterion
  is not inspectable is the thing pledge exists to replace.
