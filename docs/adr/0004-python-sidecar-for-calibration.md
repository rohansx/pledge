# ADR-0004: Python sidecar for calibration

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`calibration.md`](../calibration.md),
[`technical-spec.md` §7](../technical-spec.md),
[`architecture.md` §3](../architecture.md),
[`roadmap.md`](../roadmap.md) (phase v2)

## Context

[`technical-spec.md` §1](../technical-spec.md) design constraint 5 says: one language for v0
and v1, and a second language must earn its place at a clean seam. This ADR is the argument
that calibration earns it, and the definition of the seam.

The calibration model ([`calibration.md` §2](../calibration.md)) is a hierarchical
normal-normal in log space with partial pooling across users, shared feature effects `beta`,
and — the part that actually matters — a **censored likelihood**. Abandoned, missed and
still-open commitments are right-censored observations, not missing rows
([`calibration.md` §4](../calibration.md)). Getting censoring wrong biases the fit optimistic,
which is precisely the bias the product exists to correct. The censored terms need
`log P(Y > y)` for a normal — `scipy.stats.norm.logsf` — a scaled complementary error function
that must stay numerically stable four or five sigma into the tail, exactly where a hand-rolled
`log(1 - cdf(z))` silently returns `-Infinity`.

The dominating constraint is nights-and-weekends build time. The second constraint is that
**statistical bugs do not throw**. A broken probe throws a stack trace. A broken fit returns a
plausible-looking number, gets rendered as "38% chance you make this date", and nobody notices
for months. The only real validation surface is a simulation test that recovers known
parameters ([`roadmap.md`](../roadmap.md), v2 exit criteria) — and that test is worth writing
only against numerics somebody else has already audited.

Against all that: this is a nightly batch job over thousands of rows. There is no latency
argument for Python, no throughput argument, and no argument at all for a second language on
the serving side — serving is arithmetic in TypeScript from a stored fit row
([`calibration.md` §6](../calibration.md)).

## Decision

Calibration runs as a **Python container on a nightly cron**, and that is the only Python in
the system. It connects to Postgres as `pledge_calib` (SELECT on `commitment`, `done_spec`,
`probe_run`; write on `calibration_fit` — see [`architecture.md` §4](../architecture.md)), has
no outbound network access, exposes no HTTP surface, and is never in a user-facing request
path. If it fails, the app serves yesterday's `calibration_fit` row, surfacing no error to the
user and an alert to the operator. The fit is the only thing that crosses the seam, and it
crosses as a database row.

## Alternatives considered

| Option | Why not |
|---|---|
| **Pure TypeScript, hand-rolled conjugate fit** | The closest call in this document, and genuinely viable for the v1 model: with `sigma_i` fixed to a pooled estimate and `beta = 0` the fit is a closed-form weighted average ([`calibration.md` §2.1](../calibration.md)) — roughly forty lines of arithmetic, no dependency, no container, no second toolchain, and it deletes an entire deployment target. It loses on two specifics. (a) There is no audited TS equivalent of `scipy.special`, and the censored terms live in the tail where a naive normal log-survival degrades quietly rather than loudly. (b) The moment `beta` goes non-zero or `sigma_i` is fitted per-user, the closed form is gone and the port has to happen anyway — under time pressure, with published numbers already depending on the old one |
| **Hosted stats API service** | Adds a network dependency and a vendor to a job whose defining property is that it may fail unnoticed. Also moves resolved-commitment data — the asset — outside the trust boundary for no capability gain |
| **Precomputed lookup tables** (bucket users by `n` and observed slip, ship a static table) | Honestly adequate for cold start and the first few hundred users, with zero infrastructure. Fails at the thing that makes the forecast a moat: shrinkage is continuous in `n_i`, and a table coarse enough to ship by hand gives a user with n=4 and a user with n=25 the same answer |
| **R or Stan** | A better statistics ecosystem than Python for exactly this model. Worse at everything else: heavier container, no shared tooling with the rest of the repo, and a language the author maintains nothing else in |
| **Defer calibration past v2** | Calibration *is* the differentiator ([`product-overview.md`](../product-overview.md)). Deferring it leaves a probe-and-ledger product, which is the commodity half |

## Consequences

**Good:**
- The censored likelihood is one audited call, correct in the tail, rather than a hand-rolled
  approximation nobody will ever re-derive.
- Upgrading to NumPyro when the feature vector earns it is a library swap inside an existing
  container, not a new architecture.
- The seam is a table, which makes the integration test trivial: assert a row appeared with a
  plausible `mu`, `sigma`, `n_effective`, `fitted_at`.
- Failure is genuinely non-blocking. Staleness ceiling is one day; nothing user-facing degrades
  except forecast freshness.

**Bad:**
- Two languages, two toolchains, two CI paths, two dependency-update streams. Reproducing a
  calibration bug locally now requires a Python environment.
- A Python container holding a live Postgres credential is a thing to keep patched forever. Its
  CVE churn is unrelated to whether the model ever changes.
- **The model is expressed twice.** Fitting is Python; serving — `normalCdf`, `probit`,
  `dot(beta, x)` — is TypeScript ([`calibration.md` §6](../calibration.md)). These can drift,
  and drift produces plausible wrong numbers rather than errors. Preventing that needs a
  cross-language golden-vector test (fixed inputs, fixed expected outputs, asserted in both CI
  paths), which is a permanent tax that would not exist in a single-language design.
- The seam stays clean only by discipline. One HTTP endpoint added to "just get a live fit"
  converts this from a batch job into a runtime dependency and voids every failure-mode
  guarantee above. Nothing in the system prevents that. It is a rule, not a mechanism.

**Neutral:**
- Feature extraction from the done-spec AST stays in TypeScript (`@pledge/spec`) and is
  persisted, so the Python side reads columns and never parses the DSL. Why features are
  AST-derived rather than user-supplied is [ADR-0007](./0007-ast-derived-features.md).
- The container is listed as a third service in [`architecture.md` §3](../architecture.md), which
  also states the standing rule: resist adding a fourth.

## Revisit when

- **Delete trigger.** Twelve months after v2 ships, `calibration_fit.model_version` is still the
  closed-form conjugate fit with `beta = 0` and pooled `sigma`. If the model never outgrew the
  closed form, this seam is deletable: port ~40 lines to TypeScript, drop the container, drop
  the golden-vector test, and design constraint 5 gets its exception back. That outcome
  supersedes this ADR and is a success, not an embarrassment.
- **Escalation trigger.** More than ~6 live features carry non-zero `beta`, or `sigma_i` is
  fitted per-user rather than pooled. Move to NumPyro inside the existing container; the seam
  does not change.
- **Scale trigger.** The nightly fit exceeds 10 minutes
  ([`architecture.md` §12](../architecture.md)). Response is an incremental fit over changed
  users only, still inside the container.
- **Void trigger.** Anyone proposes an HTTP endpoint on the sidecar, or a synchronous call to it
  from the composer. Re-read this ADR first: the forecast is a table lookup by design, and
  `p95 < 100ms` with no sidecar in the request path is a v2 exit criterion
  ([`roadmap.md`](../roadmap.md)).
