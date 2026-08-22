# pledge

**A verifiable record of what you said you'd ship and whether you shipped it.**

**Status: pre-build / design** · `pledge.sh` · Rohan Sharma ([@rohansx](https://github.com/rohansx))

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

Pre-build. No code exists. The next milestone is **v0 — prove the loop**
([`roadmap.md`](./docs/roadmap.md)), and its exit criteria are the definition of done:

- A commitment created through the UI resolves to `kept` from a real probe against a real
  repo, with zero manual DB edits.
- A test asserts no route handler can write `status IN ('kept','missed')`.
- `@pledge/safe-fetch` rejects `127.0.0.1`, `169.254.169.254`, `10.0.0.1`, `[::1]`, a DNS
  name resolving to a private IP, and a redirect chain whose third hop is private.
- `/[handle]` is server-rendered, 200s to `curl` with JS disabled, Lighthouse SEO ≥ 90.
- Deadline arithmetic is correct in `Asia/Kolkata`.
- One commitment on the deployed instance, made by the author, publicly visible.

Deferred out of v0 and not to be smuggled in: DSL · witnesses · amendments · ledger ·
calibration · receipts · OG images · cohorts.

---

## Planned repo layout

**Nothing below exists yet.** This is the target tree from
[`architecture.md` §10](./docs/architecture.md), reproduced here so it is the first thing
you see rather than the last.

```
pledge/
  apps/
    web/                  Next.js — UI + /api/v1 route handlers
    worker/               probe-worker + anchor-cron entrypoints
    calibration/          Python: fit.py, features.py, Dockerfile
  packages/
    spec/                 @pledge/spec       — lexer, parser, AST, canonicalise, evaluate
    safe-fetch/           @pledge/safe-fetch — SSRF-hardened undici dispatcher
    ledger/               chain append, Merkle, audit path
    db/                   Drizzle schema + migrations + role grants
    verify/               pledge-verify CLI
  docs/                   ← the only directory that currently exists
```

**Boundary rule:** `packages/spec` may not depend on `packages/db`. The parser and evaluator
must run in a browser (composer preview) and in the verifier CLI (no database at all).

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

There is no code in this repository. It is design documentation for a product that has not
started. Do not clone this expecting something runnable.
