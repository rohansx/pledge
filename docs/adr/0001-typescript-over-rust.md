# ADR-0001: TypeScript over Rust for the v0/v1 stack

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`technical-spec.md`](../technical-spec.md),
[`architecture.md`](../architecture.md), [`roadmap.md`](../roadmap.md)

## Context

The v0.1 spec proposed Rust + axum for the API and probe engine, with a separate TypeScript
frontend. That choice was not derived from the workload. It was derived from the fact that
the author writes Rust for pleasure and had just finished two Rust projects. This ADR names
that bias on purpose: the reversal is worthless if the same pull recurs on the next
component, and the only reliable guard against "I picked the language I like" is writing down
that it happened.

The workload, looked at honestly, has no compute-bound component:

| Component | What it actually does | Bound by |
|---|---|---|
| Web/API | CRUD, SSR profiles, OG image render | Postgres round-trips, network |
| Probe worker | ~10 outbound HTTP fetches per run, 10s budget | remote hosts, DNS |
| Ledger append | one sha256 over a <2 KB JSON payload | the `chain_head` lock, not the hash |
| Anchor cron | Merkle over a few hundred hashes every 10 min | Rekor's response time |
| Calibration | a conjugate normal-normal fit, nightly | nothing; it runs in milliseconds |

At the design volume — thousands of probes per hour, tens of ledger appends per minute — none
of these is within two orders of magnitude of a language-speed problem. The Merkle build and
the sha256 chain are the only CPU in the system and they are microseconds against a ~1ms lock
hold ([ADR-0003](./0003-global-chain-lock.md)).

The binding constraint is build time. This is a nights-and-weekends product with a v0 target
of two days and a v3 target of a few weeks ([`roadmap.md`](../roadmap.md)). Anything that
doubles the number of places a feature has to be written spends the one resource that is
actually scarce.

And the growth engine is the public profile: SSR, SEO, dynamic OG cards per commitment
([`technical-spec.md` §10](../technical-spec.md)). That is a Next.js problem regardless of
what the backend is written in — so a Rust backend does not remove TypeScript from the
project, it adds a second language to it.

## Decision

v0 and v1 are written entirely in TypeScript: Next.js App Router for web and API, Drizzle
over Postgres 16, pg-boss for jobs, undici with a hardened dispatcher for probes, Chevrotain
for the done-spec DSL, Zod at every boundary, `@noble/*` and `sigstore-js` for crypto and
anchoring. A second language enters only at a clean, asynchronous seam and only when the math
demands it — the Python calibration sidecar in v2
([ADR-0004](./0004-python-sidecar-for-calibration.md)). Rust is not in the v0–v3 plan.

## Alternatives considered

| Option | Why not |
|---|---|
| **Rust + axum** (the v0.1 choice) | Genuinely better for the ledger: newtypes over `bytea`, exhaustive matching on the state machine, no implicit numeric coercion, and a single static binary that deploys anywhere for pennies. The author is also *fast* in it. But it does not touch the binding constraint — the frontend stays TypeScript either way, so this is a two-language stack that buys performance nobody needs, and `sigstore-rs` is less mature than `sigstore-js` for the one cryptographic dependency that matters. |
| **Go** | The best argument of the three: cosign, Rekor, and the whole Sigstore reference implementation are Go-native, goroutines are a fine fit for concurrent probes, compile times are trivial, and the deploy artifact is one binary. It loses for the same structural reason as Rust — the SSR/OG surface still needs Next — and it is worse than TypeScript at the parts we write most (route handlers, shared validation schemas). Go stays the right choice for one artifact: a standalone verifier binary, if anyone ever asks for one ([`technical-spec.md` §8](../technical-spec.md)). |
| **Split: TS frontend + Rust backend** | A real design with a clean seam, and it is how the v0.1 spec was drawn. It keeps Next where Next is good and puts the ledger in a language that can enforce its invariants at compile time. Rejected because every feature then crosses a wire: two repos or two workspaces, two deploy pipelines, hand-mirrored types on both sides of an HTTP boundary, and a local dev loop that needs both running. At two hours an evening that tax compounds into the difference between shipping v1 and not. |
| **Node + Fastify API + separate React SPA** | Same language, less framework magic, and Fastify's plugin/schema model is arguably a better fit for an API than Route Handlers. But a client-rendered SPA gives up SSR profiles and `next/og` cards, which are the organic distribution loop, not decoration. Losing that to gain framework taste is a bad trade. |

## Consequences

**Good:**
- One language for v0/v1: one toolchain, one test runner, one lockfile, one CI config.
- Zod schemas are shared literally — the same object validates the route handler input and
  the client form, so the two cannot drift.
- Milestone estimates roughly halve versus the v0.1 plan
  ([`technical-spec.md` §12](../technical-spec.md)). That is the whole argument.
- `sigstore-js` is the official JS client, so the anchoring path uses a first-party library
  rather than a community port.
- The DSL parser and evaluator (`@pledge/spec`) run unchanged in the browser for composer
  preview, in the worker, and in the verifier CLI — no cross-compilation, no wasm step.

**Bad:**
- **A real throughput ceiling on the probe worker.** A Node process is one event loop;
  scaling probes means more processes and more Postgres connections, and it hits that wall at
  a volume Rust or Go would absorb on one box. It is a ceiling we are choosing, not one we
  have argued away.
- **npm supply-chain surface.** A product whose claim is integrity now depends on hundreds of
  transitive packages, and a compromised dependency anywhere in the ledger or signing path
  forges receipts. Mitigations — `npm ci` against a committed lockfile, a deliberately tiny
  dependency set in `packages/ledger` and `packages/verify`, provenance checks — reduce this;
  they do not make it comparable to a Cargo tree of six audited crates. Tracked in
  [`security.md`](../security.md).
- **Less type rigour exactly where it is most wanted.** TypeScript's types are erased at
  runtime, `any` leaks in from untyped libraries, and there is no exhaustiveness guarantee on
  the resolution state machine unless it is hand-enforced. The ledger code is the code where
  Rust's guarantees would have paid, and we are declining them.
- **`bigserial` meets JavaScript numbers.** `ledger_entry.seq` is a bigint; reading it into a
  JS `number` is a silent correctness hazard past 2^53. Every `seq` must be handled as
  `bigint`/string end to end, and that is a discipline rather than a compiler error.
- Node's default `fetch` will happily connect to `169.254.169.254`. The SSRF defence has to
  be built by hand ([`technical-spec.md` §5](../technical-spec.md)); a Rust HTTP client would
  have needed the same work, but it is worth stating that the runtime gives us nothing here.

**Neutral:**
- "One language" is temporary by design: Python arrives in v2 for calibration only, at an
  asynchronous seam that is allowed to fail.
- Rust is not foreclosed. The probe worker is already a separate deployment with a restricted
  DB role and no shared state beyond Postgres
  ([`architecture.md` §3](../architecture.md)), so replacing it later is an isolated change,
  not a rewrite.

## Revisit when

- **Sustained probe volume exceeds ~1M/hour.** Extract the worker only — it is already a
  separate deployment with its own DB grants. The web tier stays TypeScript.
- **Event-loop lag in the worker exceeds 100ms p99 while CPU is under 60%**, meaning we are
  losing to the runtime rather than to remote hosts. Same response: worker only.
- **A third-party platform starts consuming receipts at scale.** Build the verifier as a Go
  binary in the Sigstore ecosystem. That is a new artifact, not a stack reversal.
- Anything that is not one of the above is not a reason to reopen this.
