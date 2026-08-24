# pledge

**A verifiable record of what you said you'd ship and whether you shipped it.**

**Status: v0 built, not yet deployed** · `pledge.sh` · Rohan Sharma ([@rohansx](https://github.com/rohansx))

The loop runs end to end locally: a commitment created through the app is resolved to `kept` by
a real probe against a real target, with no manual database edits. See
[`DEVELOPMENT.md`](./DEVELOPMENT.md) to run it, and **Current phase** below for what is and is
not done.

---

## What it is

pledge produces a **record**: an append-only, hash-chained, externally anchored history of
execution claims and their observed outcomes. A *commitment* is a claim plus a
machine-checkable done-spec (a small DSL predicate over external state) plus a deadline. A
*probe* resolves it by observing GitHub, an HTTP endpoint, or a package registry — never by
asking the committer. Each resolution emits a portable signed **receipt** that a third party
can verify offline, with no access to pledge and no trust in its operator.

The differentiator is **calibration**: a hierarchical Bayesian model of your
estimate-vs-actual slip distribution, shown as a forecast while you are still picking the
deadline. Distribution is via cohorts — hackathons and accelerators, where organizers are
the paid unit.

---

## The one invariant

> **Nothing self-reported is ever authoritative.**
>
> There is no "mark as done" endpoint. `kept` is written only by a probe worker. A witness who
> is not the committer can contradict a probe into `disputed`; a witness can never produce
> `kept` ([ADR-0006](./docs/adr/0006-accountless-witnesses.md)). Enforcement is a build-time
> check that no route handler can write `status IN ('kept','missed')`, backed by restricted DB
> roles — `pledge_web`'s grant on `commitment` is table-level, so the build-time check, not the
> grant, is the thing that actually holds.
>
> Every design decision in these docs follows from that sentence.
> ([`technical-spec.md` §1](./docs/technical-spec.md), [`architecture.md` §5.3](./docs/architecture.md))

---

## Docs map

| Doc | Read this when you want to |
|---|---|
| [`docs/product-overview.md`](./docs/product-overview.md) | Understand the problem, the credential-not-nag reframe, cohorts, business model, and what could kill this |
| [`docs/technical-spec.md`](./docs/technical-spec.md) | Pick up the stack table, the SQL data model, the probe engine, the SSRF posture, and the state machine |
| [`docs/architecture.md`](./docs/architecture.md) | See how the pieces fit: trust zones, the DB role split, the five flows, failure modes, package layout |
| [`docs/roadmap.md`](./docs/roadmap.md) | Know what ships in which phase and what the exit criteria are |
| [`docs/calibration.md`](./docs/calibration.md) | Work on the statistical model — priors, censoring, and the display rules that keep it honest |
| [`docs/security.md`](./docs/security.md) | Review the threat model T-01..T-10, ranked by damage to the core claim |
| [`docs/spec/done-spec-dsl.md`](./docs/spec/done-spec-dsl.md) | Implement or extend the DSL: EBNF grammar, sources, canonicalisation, probe classes |
| [`docs/spec/receipt-format.md`](./docs/spec/receipt-format.md) | Write a verifier — receipt wire format and the 5-step verification algorithm |
| [`docs/open-questions.md`](./docs/open-questions.md) | Look up Q-00..Q-06, the decisions that are genuinely still open |
| [`docs/adr/`](./docs/adr) | Read why a decision went the way it did (ADR-0001 TypeScript over Rust, ADR-0005 defer Rekor, ADR-0009 the rename) |

Two ADRs are **Proposed, not Accepted** — [ADR-0005](./docs/adr/0005-defer-rekor-anchoring.md)
(defer Rekor anchoring) and
[ADR-0008](./docs/adr/0008-calibration-over-all-visibilities.md) (calibrate over all
visibilities). Nothing anywhere should read as if either outcome is settled.

### Reading order

- **Newcomer:** [product-overview](./docs/product-overview.md) → [architecture](./docs/architecture.md) → [roadmap](./docs/roadmap.md).
- **Implementer:** [technical-spec](./docs/technical-spec.md) → [architecture](./docs/architecture.md) → whichever of [`spec/`](./docs/spec) you are about to touch.

---

## Current phase

**v0 — prove the loop** ([`roadmap.md`](./docs/roadmap.md)) is built and green locally.
Nothing is deployed. Its exit criteria are the definition of done:

| Exit criterion | |
|---|---|
| A commitment created through the UI resolves to `kept` from a real probe, zero manual DB edits | met — `pnpm smoke`, against a live target over the real network |
| A test asserts no route handler can write `status IN ('kept','missed')` | met — `scripts/check-invariants.mjs`, run by both `pnpm build` and `pnpm test` |
| `@pledge/safe-fetch` rejects `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`, a DNS name resolving private, and a redirect whose third hop is private | met — one test each, plus decimal/octal/IPv4-mapped/NAT64 forms |
| `/[handle]` is server-rendered, 200s to `curl` with JS disabled, Lighthouse SEO ≥ 90 | SSR half met; **Lighthouse not yet run** — it needs a deployed instance |
| Deadline arithmetic is correct in `Asia/Kolkata` | met — explicit tests at 23:30 and 00:15 IST across a UTC date boundary |
| One commitment on the deployed instance, made by the author, publicly visible | **not met** — there is no deployed instance yet |

The two open criteria are both blocked on deployment, not on code. Real GitHub OAuth
credentials and a real Resend key are likewise unexercised: the app boots, renders and
completes the loop on placeholders by design, so neither has been proven against the real
service.

Deferred out of v0 and not to be smuggled in: DSL · witnesses · amendments · ledger ·
calibration · receipts · OG images · cohorts.

---

## Repo layout

The target tree is [`architecture.md` §10](./docs/architecture.md). What exists today is the
v0 subset of it — marked, so the gap between the design and the code is visible rather than
inferred.

```
pledge/
  apps/
    web/                  ✓ Next.js — profile, commitment page, composer, /api/v1
    worker/               ✓ probe worker: pg-boss, sweep, the two v0 probe kinds
    calibration/          ✗ v2 — Python: fit.py, features.py, Dockerfile
  packages/
    db/                   ✓ Drizzle schema + migrations + role grants + shared contracts
    safe-fetch/           ✓ @pledge/safe-fetch — SSRF-hardened undici dispatcher
    spec/                 ✗ v1 — lexer, parser, AST, canonicalise, evaluate
    ledger/               ✗ v1 — chain append, Merkle, audit path
    verify/               ✗ v1 — pledge-verify CLI
  scripts/
    check-invariants.mjs  ✓ the build-time no-self-report check
  docs/                   ✓ design documentation
```

v0 has **no DSL**. The two probe kinds — `http(url).status` and `github.release(repo).tag` —
are plain TypeScript functions over a small discriminated union, content-addressed the same
way a parsed AST will be, so `packages/spec` replaces the union in v1 without a migration.
The ledger is deliberately absent: it is v1, and the schema is designed so adding it is
insert-only ([`roadmap.md`](./docs/roadmap.md) v0 anti-goal).

**Boundary rule:** `packages/spec` may not depend on `packages/db`. The parser and evaluator
must run in a browser (composer preview) and in the verifier CLI (no database at all). The
same rule already holds for `packages/safe-fetch`, which declares its own structurally
identical types rather than importing them.

Run it: [`DEVELOPMENT.md`](./DEVELOPMENT.md).

---

## Open source split

| Component | Licence | Why |
|---|---|---|
| `@pledge/spec` | MIT | A third party must be able to confirm a done-spec means what the receipt claims |
| `@pledge/safe-fetch` | MIT | Solves a real, widely-botched Node problem; useful independent of pledge |
| `pledge-verify` CLI | MIT | Verification that requires our binary to be trusted is not verification |
| Receipt format spec | Open spec ([`spec/receipt-format.md`](./docs/spec/receipt-format.md)) | Anyone should be able to write a competing verifier |
| Web app, probe worker, ledger service, calibration fit, cohort tooling | Hosted / closed | The service, not the primitives |

---

## Known open problems

These are the things most likely to sink the product. They are on the front page deliberately.

- **The effort-vs-output gap (Q-02).** Every probe is satisfiable by something smaller than
  what was promised. A release tag can be cut over an empty diff. Novelty checks and semantic
  templates raise the cost of faking; they do not close the gap, and the DSL cannot.
- **Evaluator-side adoption (Q-03).** Cryptographic verifiability answers "did pledge
  fabricate this", which nobody is currently asking. Evaluators have no account and no reason
  to visit. Any design that needs them to sign up has already failed.
- **Commit-ritual friction (Q-04).** Writing a done-spec before starting work self-selects
  for people who already ship — i.e. the people who need this least. The likely answer is
  passive derivation from existing planning artifacts, which would rewrite the commit flow.

Tracked in [`docs/open-questions.md`](./docs/open-questions.md), alongside Q-00 (the only hard
blocker — the prior-inventions disclosure), Q-05 (bad-faith probing) and Q-06 (evidence
retention), all three of which gate public launch rather than development.

---

## Not yet built

v0 runs; everything past it is still design documentation. Not built, and not stubbed for:
the DSL and parser · witnesses · amendments · the hash-chained ledger · Merkle checkpoints and
Rekor anchoring · calibration and the forecast · signed receipts and `pledge-verify` · OG
images · cohorts · badges · chat notifications · private commitments · the public API and PATs.

Nothing is deployed. Clone it expecting a local loop, not a service.
