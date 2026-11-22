# pledge

**A verifiable shipping ledger for builders. Say what you'll ship, when. We verify it with receipts, not selfies.**

**Status: v0 & v1 built (locally), v0.1 MVP design phase** · `pledge.sh` · Rohan Sharma ([@rohansx](https://github.com/rohansx))

The whole loop runs end to end locally: a commitment written in the done-spec DSL, witnessed, amended, resolved by a real probe against a real target, recorded on a hash-chained ledger, and exported as a signed receipt that `pledge-verify` checks in a process holding no credentials — with no manual database edits. `pnpm smoke` is that sentence as a script. See [`DEVELOPMENT.md`](./DEVELOPMENT.md) to run it, and **Current phase** below for what is and is not done.

---

## What it is

pledge produces a **record**: an append-only, hash-chained, externally-anchored history of execution claims and their observed outcomes. A *pledge* is a claim plus a machine-checkable done-spec (a small DSL predicate over external state) plus a deadline plus a confidence estimate. A *probe* resolves it by observing GitHub, HTTP, or a service API — never by asking the committer. Each resolution emits a portable signed **receipt** that a third party can verify offline, with no access to pledge and no trust in its operator.

The differentiators are:

1. **Verification tiers.** Machine-verified > peer-attested > self-reported. The north-star metric is % machine-verified (not self-reported).
2. **Calibration identity.** A Bayesian model of your estimate-vs-actual slip and your confidence-vs-outcome accuracy. Produces a calibration curve, a forecast, and a difficulty-weighted leaderboard (Calibration Rank) that cannot be gamed by committing to trivial work.
3. **Scope Negotiator.** An LLM at pledge time that converts a fuzzy intention into a checkable contract, surfaces your historical slip for this category, and suggests a calibrated deadline.

Distribution is via **individual builders** (Pro subscriptions) and **covenants** (3–8 builders toward a shared deadline, for pods and hackathons).

---

## The one invariant

> **Machine-verified outcomes are authoritative. Self-reported outcomes are recorded and visible, but excluded from calibration fits.**
>
> There is no "mark as done" endpoint. `kept` is written only by a probe worker. A witness who is not the committer can contradict a probe into `disputed`; a witness can never produce `kept` ([ADR-0006](./docs/adr/0006-accountless-witnesses.md)). For self-reported outcomes (v0.3+), a `status IN ('kept', 'missed')` marker exists, but self-reported rows are filtered from the calibration pipeline. Enforcement is a build-time check backed by restricted DB roles.
>
> Every design decision in these docs follows from that sentence.
> ([`technical-spec.md` §1](./docs/technical-spec.md), [`architecture.md` §5.3](./docs/architecture.md), [`product-overview.md` § What changed](./docs/product-overview.md))

---

## Docs map

| Doc | Read this when you want to |
|---|---|
| [`docs/product-overview.md`](./docs/product-overview.md) | Understand the problem, the credential-not-nag reframe, the new direction (§ What changed), calibration identity, gamification, the Scope Negotiator, and what could kill this. **Start here.** |
| [`docs/technical-spec.md`](./docs/technical-spec.md) | Pick up the stack table, the SQL data model, the probe engine, the SSRF posture, and the state machine |
| [`docs/architecture.md`](./docs/architecture.md) | See how the pieces fit: trust zones, the DB role split, the five flows, failure modes, package layout |
| [`docs/roadmap.md`](./docs/roadmap.md) | Know what ships in which phase and what the exit criteria are |
| [`docs/calibration.md`](./docs/calibration.md) | Work on the statistical model — the two-axis specification, priors, censoring, hierarchical logistic recalibration, and display rules. **Updated for v0.3+ (two-axis model).** |
| [`docs/security.md`](./docs/security.md) | Review the threat model T-01..T-10, ranked by damage to the core claim |
| [`docs/spec/done-spec-dsl.md`](./docs/spec/done-spec-dsl.md) | Implement or extend the DSL: EBNF grammar, sources, canonicalisation, probe classes |
| [`docs/spec/receipt-format.md`](./docs/spec/receipt-format.md) | Write a verifier — receipt wire format and the 5-step verification algorithm |
| [`docs/open-questions.md`](./docs/open-questions.md) | Look up Q-00..Q-06, the decisions that are genuinely still open |
| [`docs/adr/`](./docs/adr) | Read why a decision went the way it did. **New pivots:** ADR-0010 (self-reported tier), ADR-0011 (calibration rank & seasons), ADR-0012 (LLM in request path), ADR-0013 (individual GTM). **Proposed, not accepted.** |

Four ADRs are **Proposed, not Accepted**:
- [ADR-0010](./docs/adr/0010-self-reported-verification-tier.md) — self-reported tier (reversal of v0.2 position)
- [ADR-0011](./docs/adr/0011-calibration-rank-and-seasons.md) — calibration rank & seasonal leaderboard (reversal of v0.2 position)
- [ADR-0012](./docs/adr/0012-llm-in-the-pledge-creation-path.md) — Scope Negotiator LLM at creation time (reversal of v0.2 position)
- [ADR-0013](./docs/adr/0013-individual-pro-over-organizer-gtm.md) — individual builders primary GTM (reversal of v0.2 position)
- [ADR-0005](./docs/adr/0005-defer-rekor-anchoring.md) — defer Rekor anchoring
- [ADR-0008](./docs/adr/0008-calibration-over-all-visibilities.md) — calibrate over all visibilities

Nothing anywhere should read as if any of these are settled.

### Reading order

- **Newcomer:** [product-overview](./docs/product-overview.md) → [architecture](./docs/architecture.md) → [roadmap](./docs/roadmap.md).
- **Implementer:** [technical-spec](./docs/technical-spec.md) → [architecture](./docs/architecture.md) → whichever of [`spec/`](./docs/spec) you are about to touch.

---

## Current phase

**v0 — prove the loop** and **v1 — make the record real** ([`roadmap.md`](./docs/roadmap.md)) are both built and green locally. Nothing is deployed.

The **v0.1 MVP design** (from the new direction) specifies what ships first for public testing. It is a subset of v0 & v1 functionality focused on the core loop: commit, resolve, calibrate, share.

### What is built

v0 & v1 together implement:

| Component | Status | Notes |
|---|---|---|
| **Done-spec DSL** | ✓ v1 | Chevrotain lexer/parser, Zod AST, RFC 8785 JCS canonicalisation, sha256, pure evaluator, 5 templates, browser + CLI |
| **Ledger** | ✓ v1 | Append-only hash chain, chain_head serialisation, append-only trigger, ed25519 signing |
| **safe-fetch** | ✓ v0.1 | SSRF-hardened undici dispatcher (resolve-then-pin, per-hop redirect revalidation, streamed body cap) |
| **Probe engine** | ✓ v0 | `http_status`, `github_release_tag`, `spec` probes; backoff curve; baseline snapshot + novelty check; resolution state machine |
| **Web app** | ✓ v0–v1 | Auth.js/GitHub, composer with template picker + DSL escape, live parsing, SSR profile at `/[handle]`, commitment detail, amendments, accountless witness magic-link attestation, OG cards |
| **Worker** | ✓ v0–v1 | Webhook listener, probe scheduling, state machine, failed-crash recovery |
| **Receipts** | ✓ v1 | Evidence bundle, ed25519 signing, wire format |
| **pledge-verify CLI** | ✓ v1 | Offline receipt verification, steps 1–2 (signature + hash validation). Steps 3–5 (Rekor inclusion) deferred. |
| **Calibration** | ⚠️ v0.2-spec | One-axis model (slip) fully designed and in calibration.md. Two-axis model (self-calibration) is newly designed in calibration.md §2 but not yet implemented. |
| **Scope Negotiator** | ❌ | Not yet scoped. DSL is designed to be its output; the LLM that generates it is separate work (ADR-0012). |
| **Calibration Rank** | ❌ | Not yet implemented. Specification in calibration.md §3 and product-overview.md §3.1. |
| **Seasons / leaderboard** | ❌ | Designed in product-overview.md §3.2. Database model TBD. |
| **Gamification** (duels, covenants, graveyard) | ❌ | Designed in product-overview.md §3.3–3.6. Database model TBD. |

### Exit criteria for v0.1 MVP

The first public release will focus on the core loop: commit → resolve → calibrate → share.

| Criterion | Status |
|---|---|
| **Scope Negotiator** | LLM at pledge creation, converts fuzzy intent → checkable contract + suggested deadline |
| **Calibration basics** | On-time rate, slip stats, simple calibration curve (one-axis slip model) |
| **Machine-verified probes** | GitHub release, HTTP status, DNS check, with evidence bundle capture |
| **Ship cards** | Auto-generated shareable cards with keeper, outcome, verification tier |
| **Public profiles** | `/[handle]` shows ledger, calibration, OG cards |
| **Peer attestation** | Named witnesses, magic-link attestation, no signup required |
| **Amendments** | Move deadline with reason, recorded as ledger entry |
| **README badge** | Embeddable HTML/markdown |

Explicitly deferred out of v0.1:
- Two-axis calibration (self-calibration / confidence-vs-outcome)
- Calibration Rank (will ship with two-axis model)
- Seasons / leaderboard
- Duels, covenants, graveyard
- Private pledges
- Money stakes
- API / PATs
- Rekor anchoring / inclusion proofs

---

## Repo layout

The target tree is [`architecture.md` §10](./docs/architecture.md). What exists today is the v0 subset — marked, so the gap between the design and the code is visible rather than inferred.

```
pledge/
  apps/
    web/                  ✓ Next.js — profile, commitment page, DSL composer, witnesses,
                            amendments, OG cards, /api/v1
    worker/               ✓ probe worker: pg-boss, backoff curve, observation layer,
                            the spec evaluator and the two v0 probe kinds
    calibration/          ✗ v2 — Python: fit.py, features.py, Dockerfile (one-axis only; 
                            two-axis spec is new in v0.3)
  packages/
    db/                   ✓ Drizzle schema + migrations + role grants + shared contracts
                            + the receipt builder
    safe-fetch/           ✓ @pledge/safe-fetch — SSRF-hardened undici dispatcher
    spec/                 ✓ lexer, parser, AST, canonicalise, print, classify, evaluate,
                            the five templates
    ledger/               ✓ chain append, canonical JSON, payload schemas, ed25519 signing
                            (Merkle and audit paths are v2)
    verify/               ✓ pledge-verify CLI — steps 1-2 of five, no network, no credentials
  scripts/
    check-invariants.mjs  ✓ the build-time no-self-report check (tightened in v0.3 to allow
                            self-reported tier but exclude from calibration)
  docs/                   ✓ design documentation + four new Proposed ADRs
```

**Two eras coexist in the data, permanently.** `done_spec.spec_version` pins evaluation semantics: a v0 commitment made before the DSL existed is still evaluated by the v0 function that existed when it was made, and always will be. There is no migration and no plan for one — retroactively reinterpreting what someone promised is the silent redefinition this product exists to prevent. The v0 branch in `apps/worker/src/probes/index.ts` is not legacy, it is the record.

**Boundary rule:** `packages/spec` may not depend on `packages/db`. The parser and evaluator must run in a browser (composer preview) and in the verifier CLI (no database at all). The same rule already holds for `packages/safe-fetch`, which declares its own structurally identical types rather than importing them.

Run it: [`DEVELOPMENT.md`](./DEVELOPMENT.md).

---

## Open source split

| Component | Licence | Why |
|---|---|---|
| `@pledge/spec` | MIT | A third party must be able to confirm a done-spec means what the receipt claims |
| `@pledge/safe-fetch` | MIT | Solves a real, widely-botched Node problem; useful independent of pledge |
| `pledge-verify` CLI | MIT | Verification that requires our binary to be trusted is not verification |
| Receipt format spec | Open spec ([`spec/receipt-format.md`](./docs/spec/receipt-format.md)) | Anyone should be able to write a competing verifier |
| Web app, probe worker, ledger service, calibration fit, gamification | Hosted / closed | The service, not the primitives |

---

## Known open problems

These are the things most likely to sink the product. They are on the front page deliberately.

- **The effort-vs-output gap (Q-02).** Every probe is satisfiable by something smaller than what was promised. Novelty checks and semantic templates raise the cost of faking; they do not close the gap.
- **Evaluator-side adoption (Q-03).** Cryptographic verifiability answers "did pledge fabricate this", which nobody is currently asking. Evaluators have no account and no reason to visit.
- **Commit-ritual friction (Q-04).** Writing a done-spec before starting work self-selects for people who already ship — the people who need this least. The likely answer is passive derivation from existing planning artifacts.
- **Self-reported outcomes abused (NEW).** If self-reported tier is introduced (ADR-0010), it must be excluded from calibration fits, visibly marked as weaker, and never ranked. This is mathematically non-negotiable; the ADR proposes how.

Tracked in [`docs/open-questions.md`](./docs/open-questions.md), alongside:
- Q-00 (prior-inventions disclosure — the only hard blocker, gates public launch not development)
- Q-01 (private pledges laundering calibration — must be settled before Pro ships)
- Q-05 (bad-faith probing — gaming on targets you don't control)
- Q-06 (evidence retention — how long to keep webhook bodies and probe logs)

---

## Not yet built

v0 & v1 run locally; everything past them is still design documentation. Not built:

- **Calibration Rank & Seasons** (ADR-0011) — the database model for seasonal leaderboards and rank computation
- **Two-axis calibration** — self-calibration / confidence-vs-outcome axis (designed in calibration.md §2, not implemented)
- **Scope Negotiator** (ADR-0012) — the LLM that converts fuzzy intent into a contract at pledge-creation time
- **Gamification** — duels, covenants, graveyard, slip-honesty marks, evidence trophies
- **Private pledges** — visibility model for Pro tier
- **API & PATs** — public API and personal access tokens
- **Rekor anchoring & inclusion proofs** — pledge-verify steps 3–5 (deferred by ADR-0005)
- **MCP server** — agent-readable ledger for coding agents

Nothing is deployed. Clone it expecting a local loop and a design foundation for v0.1+, not a service.

---

## Testing & verification

v0 & v1 are green:
- `pnpm test` — 464 tests across all packages
- `pnpm typecheck` — full TypeScript coverage
- `pnpm lint` — code style
- `pnpm build` — both apps and all packages
- `pnpm ledger:verify` — walk the chain from genesis, verify every entry_hash
- `pnpm smoke` — end-to-end loop: commit → resolve → attest → verify

---

## Contributing

This project is in design phase (v0.1 MVP spec) following a major pivot (v0.2 → v0.3+). Four Proposed ADRs record the changes; nothing is settled yet.

**Before contributing code:** read [`CLAUDE.md`](./CLAUDE.md) (the invariants that cannot be broken) and [`technical-spec.md`](./docs/technical-spec.md).

**Before opening an issue on an open design question:** check [`docs/open-questions.md`](./docs/open-questions.md) and the four Proposed ADRs.

**Before changing how calibration works:** read [`docs/calibration.md`](./docs/calibration.md) in full. The two-axis model is newly designed and the implications are not trivial.

---

## License

Dual: MIT (for the open-source primitives: `@pledge/spec`, `@pledge/safe-fetch`, `pledge-verify`, receipt format) and proprietary (for the hosted service: web app, worker, calibration engine, gamification layer).
