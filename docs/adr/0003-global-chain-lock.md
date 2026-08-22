# ADR-0003: One global hash chain, serialised by a row lock

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`architecture.md`](../architecture.md),
[`technical-spec.md`](../technical-spec.md),
[`spec/receipt-format.md`](../spec/receipt-format.md)

## Context

`ledger_entry` is a hash chain: entry *n* hashes the previous entry's hash together with its
own payload hash and its sequence number.

```ts
entryHash[n] = sha256(entryHash[n-1] || payloadSha256[n] || u64le(seq[n]))
```

A chain requires a **total order**. Two concurrent appends that both read the same
`entryHash[n-1]` produce a fork, and a forked chain is not a ledger — every receipt issued
after the fork is unverifiable, which destroys the only claim the product makes
([`spec/receipt-format.md`](../spec/receipt-format.md)). `seq` also has to be gapless, which
`bigserial` alone does not give: a sequence advances on rollback.

So appends are serialised explicitly. Every writer takes `SELECT … FROM chain_head FOR
UPDATE` on a single row, reads the head hash from it, inserts, and updates the row — all
inside the same transaction as the domain state change it records
([`architecture.md` §5.2](../architecture.md), invariant 5).

The numbers say this is not close. Appends happen on commitment creation, probe resolution,
witness attestation and amendment: low thousands per hour at the design volume, call it
1/second. The lock is held for one indexed row read, one sha256 over a payload under 2 KB,
one insert and one update — around a millisecond, and the transaction does no network I/O
while holding it (that rule is load-bearing; see Bad, below). One millisecond of hold gives
roughly 1000 appends/sec of theoretical ceiling, so the design point sits about three orders
of magnitude below the wall.

Against that, per-account chains would parallelise writes but multiply the audit surface:
one Merkle tree per account or a mapping layer between per-account chains and the global
anchor, a receipt format that names which chain it belongs to, and a whole class of ordering
bugs at the boundary between the two structures. That is real complexity purchased against
a bottleneck that is three orders of magnitude away.

There is also a property the global chain gives away for free, and it is worth stating
because it is easy to lose by accident: because every user's entries are interleaved into one
chain in real time, a user's entry is bracketed by *other people's* entries whose hashes were
fixed before and after it. Backdating one user's history would require rewriting everyone
else's. Per-account chains lose that; each account's history would then only be pinned by
whatever anchoring cadence exists above it.

## Decision

pledge keeps **one global hash chain** for all accounts. Every append acquires
`SELECT … FROM chain_head FOR UPDATE` on the single-row `chain_head` table, in the same
transaction as the state change it records. Per-account ledger views
(`GET /v1/accounts/:handle/ledger`) are filtered projections of the global chain; audit paths
are always computed over the global tree. Sharding the chain per-account is the documented
response to a contention trigger, not a thing we build now.

## Alternatives considered

| Option | Why not |
|---|---|
| **Per-account chains** | The obvious scaling answer, and genuinely better in three ways: appends for different users never contend, one user's slow transaction cannot stall anyone else's writes, and per-account audit paths are shorter. It loses today on complexity-per-unit-benefit — a second structure between the chains and the anchor, receipts that must identify their chain, and a new correctness surface where the two structures meet — and it gives up the real-time interleaving property above. It stays the planned response if contention ever appears ([`architecture.md` §12](../architecture.md)). |
| **`pg_advisory_xact_lock` instead of a row lock** | Cheaper in one respect: no `UPDATE` on a hot row, so no dead tuples and no autovacuum churn on `chain_head`. But the head hash has to come from somewhere — either from that same row (in which case the row lock is nearly free, since the page is permanently in shared buffers) or from `max(seq)` plus an index lookup, which is two mechanisms doing the job of one. An advisory lock is also invisible in the schema: nothing about the table tells a future reader that appends are serialised. If `chain_head` bloat ever measurably hurts, this is the first cheap fix — with a low `fillfactor` and aggressive autovacuum settings on that table tried first. |
| **`SERIALIZABLE` isolation with no explicit lock** | Postgres would detect the write conflict itself, and under low contention more transactions would proceed in parallel. Rejected because it converts contention into serialisation failures that every writer must retry correctly — the web tier, the probe worker, the witness handler and the amendment handler, each with its own retry logic. A retry bug in the probe worker silently discards an observation, which is exactly the failure this product cannot have. Explicit blocking is worse for throughput and much easier to be sure about. |
| **No chain; anchor every entry to Rekor individually** | Rekor is itself an append-only transparency log, so per-entry submission would give ordering and third-party verifiability with no lock at all. Rejected because it puts an external service in the resolution path — a Rekor outage would then block state transitions, violating the rule that only Postgres being down stops the product ([`architecture.md` §8](../architecture.md)) — and because per-entry submission is orders of magnitude more log traffic than a 10-minute Merkle root that amortises across all users. |
| **Append unordered, build the chain in a later batch** | Fully parallel writes; `anchor-cron` sorts and chains entries afterwards. Rejected because it breaks the invariant that the state change and its ledger append commit together: there would be a window in which a commitment is resolved but unledgered, receipts could not be issued until the batch ran, and "eventually consistent ledger" is precisely the property the product exists to not have. |

## Consequences

**Good:**
- `seq` is gapless and the chain cannot fork, by construction rather than by convention.
- One tree, one audit-path implementation, one checkpoint. The verifier stays about 200 lines.
- Appends are provably interleaved across users in real time — an anti-backdating property
  that holds even between anchors.
- The append code is the least clever code in the system, which is what you want in the part
  whose failure invalidates every receipt ever issued.

**Bad:**
- **It is a global write lock on every state change.** Commitment creation, probe resolution,
  witness attestation and amendment all queue behind one row. This is not a mild caveat — it
  is the shape of the system.
- **Any slow transaction holding the lock stalls all writes product-wide.** A worker that
  performs network I/O inside the transaction, a migration touching `chain_head`, or a lock
  ordering inversion turns one slow request into a site-wide write stall. Two rules follow
  and are easy to violate later: **never hold `chain_head` across network I/O**, and acquire
  it at the same point in every writer.
- **Write throughput is capped at roughly 1/lock-hold**, with no horizontal escape. Adding
  worker processes does not help; the ceiling moves only by shortening the hold or by
  sharding the chain.
- **`chain_head` is a permanently hot single row** — one HOT update per append, continuous
  dead-tuple generation and autovacuum attention on that table forever.
- **Contention is invisible until it is severe**, because lock waits do not show up in normal
  application error rates. A lock-wait metric and `log_lock_waits` have to be in place from
  the first deploy or the revisit trigger below is unmeasurable.
- Deadlock risk if a future writer takes `chain_head` after other row locks in a different
  order than existing writers do.

**Neutral:**
- Per-account ledger reads are a filtered scan of the global chain and need an index on
  `(account_id, seq)`; that is a read-side cost that per-account chains would not have.
- Anchoring is unaffected — a 10-minute Merkle root over a contiguous `seq` range is simpler
  over one chain than over many.

## Revisit when

- **Lock wait exceeds 5% of transaction time on the append path**, measured from
  `log_lock_waits` or a wait-event sample. Response: first shorten the hold (advisory lock,
  `fillfactor`, verify no I/O inside the transaction); shard only if that is not enough.
- **Sustained append rate reaches ~50/sec** (5% of the theoretical ceiling). Response: shard
  the chain per-account and accept the audit-path complexity — and version the receipt format
  before doing so, since receipts must then identify their chain.
- **A single append's lock hold exceeds ~5ms at p99.** Something is doing work inside the
  transaction that should not be. Fix the transaction, not the lock.
