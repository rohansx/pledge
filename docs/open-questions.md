# Open technical questions

These are unverified and could change the design. Each one names the doc it would change
and the [plan](./plan.md) phase that should answer it.

| # | Question | Would change | Answer in |
|---|---|---|---|
| Q-3 | **Non-HTTP dependencies.** Queues, gRPC and background workers do not pass through an HTTP proxy. Which of these matter for the first ten customers? | [Sandbox](./sandbox-design.md) fault proxy | Phase 1, with design partners |
| Q-5 | **Reading state.** Is direct database access enough, or do some apps keep the truth in a third-party system? Phase 1 read only the fake provider's log; the database reader is not built. | [Sandbox](./sandbox-design.md) observing the data | Phase 2 |
| Q-6 | **Flake rate.** How often does a clean app show a broken pledge because of sandbox noise? | Verdict counting, adaptive seeds | Phase 3 |
| Q-7 | **Shrinking.** What is the simplest way to reduce a failing fault plan to the one fault that matters? | Explain phase, findings | Phase 3 |
| Q-8 | **Planted bugs.** Do bugs written by Claude resemble real ones closely enough for the proof to mean something? | [Agent](./agent-design.md) prove phase, the meaning of "proven" | Phase 3 |

## Answered

By the [Phase 0 spikes](./spikes/phase-0.md), 23 November 2026.

| # | Question | Answer |
|---|---|---|
| Q-1 | Can Docker Compose run inside an E2B sandbox? | Yes, and running containers survive a fork. The base template ships Docker and needs at least 2 GiB of RAM. |
| Q-2 | How long does a fork take with a loaded Postgres, and how is snapshot storage billed? | About 3 to 5 seconds for one fork or five, with a 226 MB database. Snapshot storage billing is not stated by E2B; disk is listed as free. Confirm before pricing depends on it. |
| Q-4 | Do SDKs that hard-code the provider's address need DNS or TLS interception? | No. A hosts entry and a certificate authority created in the sandbox are enough. Trust must be installed in the system store, in three environment variables, and in any CA file a library ships; Stripe's Python SDK needed the last. |

New questions the spikes raised:

| # | Question | Would change | Answer in |
|---|---|---|---|
| Q-9 | **Trust inside containers.** An app under Compose needs the hosts entry and the sandbox CA inside its container. Does injecting them work without editing the customer's Compose file? | [Sandbox](./sandbox-design.md) fakes | Phase 1 |
| Q-10 | **Runtimes with their own trust.** Java keeps its own trust store, and a binary with pinned certificates cannot be redirected at all. Which of the first customers' stacks hit this? | [Sandbox](./sandbox-design.md) fakes | Phase 1, with design partners |
| Q-11 | **Snapshot storage.** Is it billed, and are snapshots ever deleted automatically? | [Cost](./cost-and-performance.md) | Ask E2B |

Two checks that are not design questions but must happen before anything is promised:

- Current Claude models and pricing, before fixing model choices per phase.
- Anthropic's current data retention terms, before the security page says anything about
  source code sent to the API.
