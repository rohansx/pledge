# Pledge

Pledge runs a customer's app inside an isolated sandbox, drives synthetic users through it
while a proxy injects retries, duplicates, delays and restarts, and then checks the app's
data against a set of **pledges**: statements about the data that must always hold
("one charge per payment", "stock never goes below zero").

Claude writes the scenarios, the pledges and the planted bugs that prove each pledge can
fail. Deterministic checks on the app's data decide the verdict. A model never does.

> **Status: proposed design.** Only the deploy pipeline and a skeleton API and dashboard
> exist; nothing in the design has been built or measured. The
> [open questions](./docs/open-questions.md) list what could change it. The previous
> product that lived in this repository is archived on the `obsolete` branch.

## Docs

| Doc | What it covers |
|---|---|
| [Architecture](./docs/architecture.md) | Design choices, the twelve components, the first-scan and pull-request lifecycles |
| [Agent design](./docs/agent-design.md) | The four Claude phases, the tool set, where pledges come from, guardrails |
| [Sandbox design](./docs/sandbox-design.md) | E2B template, network rules, fault proxy, fake services, observing data |
| [Engine boundary](./docs/engine.md) | What Pledge needs from LiteTraffic, what exists, what was added |
| [Data model](./docs/data-model.md) | The seven objects, where each lives, the pledge state machine |
| [Security](./docs/security.md) | Risks and controls, deployment options, data handling |
| [Cost and performance](./docs/cost-and-performance.md) | Cost controls and the metrics to instrument from the first scan |
| [Deployment](./docs/deployment.md) | Where it runs, the build-and-deploy pipeline, what is on hold |
| [Plan and phases](./docs/plan.md) | Build order, exit criteria per phase, decisions still to make |
| [Phase 0 spike results](./docs/spikes/phase-0.md) | What was measured on E2B: Compose, fork speed, closed network, SDK redirection |
| [Open questions](./docs/open-questions.md) | Unverified assumptions that could change the design |

## The four design choices

1. **Claude writes, code decides.** The verdict comes from deterministic checks on the app's
   data, never from a model's opinion.
2. **The agent stays outside the sandbox.** Customer code is untrusted. API keys, the GitHub
   token and the orchestrator never enter the machine that runs it.
3. **Everything is a file.** Scenarios, pledges, fault plans and evidence are plain files, so
   a human can review them and a coding agent can read them.
4. **LiteTraffic stays the engine.** The open-source CLI keeps doing traffic, fixtures,
   assertions and reports. Pledge adds authoring, sandboxes, faults and proof on top.
