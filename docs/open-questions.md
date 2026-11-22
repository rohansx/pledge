# Open technical questions

These are unverified and could change the design. Each one names the doc it would change
and the [plan](./plan.md) phase that should answer it.

| # | Question | Would change | Answer in |
|---|---|---|---|
| Q-1 | **Containers inside the sandbox.** Can Docker Compose run inside an E2B sandbox reliably? If not, every service must run natively from the template, which narrows the stacks supported. | [Sandbox](./sandbox-design.md) base template | Phase 0 |
| Q-2 | **Snapshot cost and speed.** How long does a fork take with a loaded Postgres, and how is snapshot storage billed? | [Cost](./cost-and-performance.md), "boot once, fork many" | Phase 0 |
| Q-3 | **Non-HTTP dependencies.** Queues, gRPC and background workers do not pass through an HTTP proxy. Which of these matter for the first ten customers? | [Sandbox](./sandbox-design.md) fault proxy | Phase 1, with design partners |
| Q-4 | **Outbound calls that ignore base URLs.** Some SDKs hard-code the provider's address. Does this need DNS or TLS interception inside the sandbox? | [Sandbox](./sandbox-design.md) network and fakes | Phase 0 |
| Q-5 | **Reading state.** Is direct database access enough, or do some apps keep the truth in a third-party system? | [Sandbox](./sandbox-design.md) observing the data | Phase 1 |
| Q-6 | **Flake rate.** How often does a clean app show a broken pledge because of sandbox noise? | Verdict counting, adaptive seeds | Phase 3 |
| Q-7 | **Shrinking.** What is the simplest way to reduce a failing fault plan to the one fault that matters? | Explain phase, findings | Phase 3 |
| Q-8 | **Planted bugs.** Do bugs written by Claude resemble real ones closely enough for the proof to mean something? | [Agent](./agent-design.md) prove phase, the meaning of "proven" | Phase 3 |

Two checks that are not design questions but must happen before anything is promised:

- Current Claude models and pricing, before fixing model choices per phase.
- Anthropic's current data retention terms, before the security page says anything about
  source code sent to the API.
