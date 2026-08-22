# ADR-0002: Postgres (pg-boss) as the job queue

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`architecture.md`](../architecture.md),
[`technical-spec.md`](../technical-spec.md), [`security.md`](../security.md)

## Context

Almost everything asynchronous in pledge is a job: the probe schedule for each open
commitment (daily → hourly → 5-minutely → one authoritative run at `deadline+0`), the
baseline snapshot taken at commit time, the 10-minute anchor cron, and every notification
send. Volume is bounded by open commitments: a few thousand active commitments produce
low thousands of probe jobs per hour, with a burst concentrated in the final hour before
popular deadlines.

The decisive property is atomicity at commit time, not throughput. The commit flow
([`architecture.md` §6.1](../architecture.md)) does, in one transaction: upsert `done_spec`,
lock `chain_head`, insert `commitment`, append `ledger_entry`, enqueue the probe schedule,
enqueue the baseline snapshot. With an external broker, the enqueue sits outside the database
transaction, which produces two failure modes that are both bad in a product about records:
a commitment that exists in the ledger with no probe schedule (silently never resolves), or
a probe schedule for a commitment that rolled back (probes an id that isn't there). The
standard fix is a transactional outbox plus a relay — which is a reimplementation of a
Postgres-backed queue, with an extra moving part and an extra process to keep alive.

The second constraint is operational. There is one person on this, part-time. Every
additional datastore is a backup story, a monitoring story, a local-dev story, and a thing
that can be down at 3am. Postgres is already non-negotiable — it holds the ledger, and when
Postgres is down the product is down anyway ([`architecture.md` §8](../architecture.md)). A
Redis outage that only stops probes would be a *new* class of partial failure to reason
about.

## Decision

Jobs run on **pg-boss** against the same Postgres 16 instance that holds the domain tables
and the ledger. Every enqueue that accompanies a domain write happens inside that write's
transaction. Workers are separate deployments (`probe-worker`, `anchor-cron`) with their own
restricted DB roles; pg-boss's `SKIP LOCKED` polling handles locking, retries, backoff,
priorities, and the cron schedule for anchoring. No Redis, no broker, no second datastore in
v0–v3.

## Alternatives considered

| Option | Why not |
|---|---|
| **BullMQ + Redis** | Genuinely the better queue on the merits: tens of thousands of jobs/sec instead of hundreds, sub-millisecond enqueue, per-queue rate limiting we would otherwise hand-roll for per-target-host probe limits, and *far* better observability — bull-board is a real dashboard and pg-boss has nothing comparable. It loses on the one property that matters most here: the enqueue cannot join the commitment transaction, so atomicity has to be rebuilt with an outbox. Paying for a second datastore and then reimplementing what the first one gave for free is the wrong order of operations. |
| **AWS SQS** | Effectively zero operational surface, effectively unlimited scale, at-least-once semantics that everyone already understands, and a dead-letter queue for free. Same atomicity gap as Redis, plus: FIFO/visibility-timeout semantics do not express "run this job at T-6h, then hourly, then every 5 minutes" without a scheduler on top, local development needs LocalStack or a live queue, and it couples the deploy to one cloud that nothing else in the stack uses. |
| **Temporal** | The strongest technical case of any alternative. The probe schedule *is* a durable-timer workflow, and Temporal solves durable execution properly: timers survive restarts, retries and heartbeats are first-class, workflow versioning handles the case where the schedule curve changes while thousands of commitments are mid-flight, and the visibility UI would answer "what is scheduled for this commitment" instantly. Rejected on cost, not correctness: it is an entire additional service to run (or a Temporal Cloud bill) plus a programming model to learn, for a schedule that is about fifty lines of backoff arithmetic. If the schedule ever grows into a real multi-step workflow with compensation, this is the thing to move to. |
| **Hand-rolled `SELECT … FOR UPDATE SKIP LOCKED` table** | Same transactional property, zero dependencies, and about a hundred lines. That is what pg-boss *is* — plus retries with exponential backoff, job archiving, dead-letter, singleton jobs, priorities and cron, all already written and tested. Writing our own would be choosing the maintenance burden over the dependency for no gain. |
| **pgmq** | The Postgres extension version of the same idea, with better message-queue semantics. Requires an extension Neon may or may not offer on the plan we are on, and gives up pg-boss's scheduling features, which are the ones we actually use. |

## Consequences

**Good:**
- **"Job enqueued but commitment rolled back" is structurally impossible.** That is the whole
  decision in one line.
- One datastore: one connection string, one backup, one thing to monitor, one container in
  local dev.
- Job rows sit next to domain rows, so a probe job can be joined directly to its
  `commitment` and `probe_run` when debugging why something never resolved.
- pg-boss's cron covers the 10-minute anchor job too, so there is no separate scheduler.
- Workers keep the same restricted DB roles for queue access as for data access — the probe
  worker's inability to read `account.email` is not weakened by giving it queue credentials
  ([`architecture.md` §4](../architecture.md)).

**Bad:**
- **Queue load and application load compete for one Postgres.** Polling workers, job archival
  and expiry churn `pgboss.job` constantly; that is dead-tuple pressure and autovacuum work
  landing on the same instance that serves profile SSR. Table bloat on the job table is the
  classic way Postgres-as-a-queue degrades, and it degrades the *app*, not just the queue.
- **Observability is thin.** There is no dashboard. "How deep is the queue, what is
  retrying, what is stuck" is a SQL query you write yourself, and queue metrics have to be
  exported by hand. This will be felt first during a deadline burst, which is exactly the
  worst time to be writing an ad-hoc query.
- **A long probe transaction holds a pooled connection.** Probes have a 10-second budget and
  run in batches of 32; if network I/O is ever performed inside the database transaction, a
  slow remote host occupies connections against Neon's limit and can starve the web tier.
  Hard rule, stated here because it is easy to violate later: **all probe network I/O happens
  outside the transaction**; the transaction opens only to insert `probe_run` and append the
  ledger entry.
- Constant polling keeps the Neon compute awake, which removes autosuspend savings and makes
  the idle cost of the queue non-zero.
- pg-boss's own maintenance passes take locks on the job tables; a maintenance stall shows up
  as probe latency with no obvious cause.

**Neutral:**
- At-least-once delivery either way. Probe jobs are already written to be idempotent — the
  `kept` transition is guarded by `WHERE status = 'open'`, so a duplicate delivery adds a
  harmless second observation ([`architecture.md` §6.2](../architecture.md)).
- Notification jobs share the instance but not the resolution path; nothing in a send can
  affect a state transition.

## Revisit when

- **Sustained throughput exceeds ~50 jobs/sec** (roughly 180k/hour, two orders of magnitude
  above the design point). Response: move the *probe* queue to Redis/BullMQ and keep
  commit-time enqueues on pg-boss behind an outbox — the atomicity argument only covers jobs
  created inside a domain transaction.
- **Queue contention shows up in application p95** — attributable lock waits or autovacuum on
  `pgboss.*` correlated with a rise in web-tier latency. Response: move pg-boss to its own
  schema on a separate Neon branch/instance before changing queue technology; the
  transactional-enqueue property is worth preserving longer than the single-instance property.
- **The probe schedule becomes a genuine multi-step workflow** — compensation, human-in-loop
  steps, long-running dispute adjudication. Response: reconsider Temporal, which was rejected
  on cost rather than on fit.
