# pledge — Architecture

**Version:** 1.0
**Status:** Design
**Date:** August 2026
**Depends on:** [`technical-spec.md`](./technical-spec.md) (stack choices),
[`product-overview.md`](./product-overview.md) (why any of this exists)

This document answers *how the pieces fit*: components, trust boundaries, the five flows that
matter, the consistency model, and what happens when each dependency fails. The technical
spec picks the technologies; this one explains the shape.

---

## 1. The architectural thesis

One sentence, because everything below follows from it:

> **The only trustworthy state transition is one that came from outside the user's control,
> and the record of that transition must survive the operator being untrustworthy too.**

Three consequences, and they are the entire architecture:

1. There is **no write path from a user to their own outcome — with a narrowing proposal.**
   Users write *intent* (commitments, amendments, witness invites). `machine_verified` and
   `peer_attested` outcomes are written only by the probe worker and witnesses; a user who is
   the committer cannot directly produce these ([ADR-0006](./adr/0006-accountless-witnesses.md)).
   [ADR-0010](./adr/0010-self-reported-verification-tier.md) *proposes* introducing a third
   tier, `self_reported`, where the builder can mark an outcome themselves — but only if they
   choose to, and with permanent visibility that they did (§5.3, §6.3). This is a hard
   invariant today; the narrowing is an explicit proposal.
2. Anything that determines an outcome runs in a **separate blast radius** from anything that
   holds a session. Probe workers touch untrusted network I/O against attacker-chosen URLs;
   they must not be able to read `account.email` or mint a session.
3. The record is **append-only and externally anchored**, so "pledge fabricated this" is a
   falsifiable claim rather than a matter of reputation.
4. **An LLM that proposes specs runs outside the transaction and is optional.** The spec it
   produces is parsed and hashed by the app tier, so the hash — not the LLM's integrity — is
   the contract. Manual spec entry bypasses the LLM entirely (§6.1).

Everything that looks like over-engineering below is one of these four. Everything that
isn't one of these four should be cut — see [ADR-0005](./adr/0005-defer-rekor-anchoring.md)
for one thing that arguably isn't.

---

## 2. System context

```
        ┌──────────┐   commits, amends      ┌─────────────────┐
        │ Builder  │ ─────────────────────► │                 │
        └──────────┘   reads own profile    │                 │
                                            │                 │
        ┌──────────┐   co-signs via         │                 │
        │ Witness  │ ─── magic link ──────► │     pledge      │
        └──────────┘   (no account)         │                 │
                                            │                 │
        ┌──────────┐   creates cohort,      │                 │
        │Organizer │ ─── pulls report ────► │                 │
        └──────────┘                        │                 │
                                            │                 │
        ┌──────────┐   reads public         │                 │
        │Evaluator │ ◄── profile / receipt ─┤                 │
        └──────────┘   verifies offline     └────────┬────────┘
             │                                       │
             │  pledge-verify (no pledge access)     │ probes (read-only, unauthenticated)
             ▼                                       ▼
        ┌──────────────┐                    ┌────────────────────────────┐
        │ Rekor (public│◄── anchors ────────│ GitHub · npm · crates.io   │
        │ transparency)│                    │ arbitrary HTTP targets     │
        └──────────────┘                    └────────────────────────────┘
```

The evaluator path is the one that makes this infrastructure rather than a website: an
evaluator can verify a receipt using only the receipt and public Rekor. They never talk to
pledge. If pledge is offline, dead, or lying, a previously-issued receipt still verifies.

**Note the asymmetry:** builders, witnesses, and organizers are *users*. Evaluators are not —
they have no account, no login, and no reason to visit. Any architecture that requires
evaluator sign-up has already failed ([Q-03](./open-questions.md)).

---

## 3. Container view

```
                       ┌──────────────────────────────────────────┐
   public internet ───►│  web (Next.js on Vercel)                 │
                       │  · SSR profiles, ISR 60s                 │
                       │  · composer + inline forecast            │
                       │  · /api/v1/* route handlers              │
                       │  · next/og image generation              │
                       │  · Auth.js sessions ◄── holds PII        │
                       └───────────┬──────────────────────────────┘
                                   │ SQL (pooled)
                                   ▼
                       ┌──────────────────────────────────────────┐
                       │  Postgres 16 (Neon)                      │
                       │  · domain tables                         │
                       │  · ledger_entry (append-only)            │
                       │  · pg-boss queues                        │
                       │  · calibration_fit (written by sidecar)  │
                       └───┬──────────────┬───────────────┬───────┘
                           │              │               │
        ┌──────────────────▼───┐  ┌───────▼──────────┐  ┌─▼─────────────────┐
        │ probe-worker         │  │ anchor-cron      │  │ calibration       │
        │ (Node, own deploy)   │  │ (Node, /10 min)  │  │ (Python, nightly) │
        │ · restricted DB role │  │ · Merkle build   │  │ · read-only role  │
        │ · egress via fixed IP│  │ · sign + Rekor   │  │   + fit table     │
        │ · @pledge/safe-fetch │  │ · KMS signing key│  │ · no network      │
        └───────┬──────────────┘  └───────┬──────────┘  └───────────────────┘
                │ untrusted HTTP          │ HTTPS
                ▼                         ▼
        ┌───────────────────┐     ┌─────────────────┐
        │ arbitrary targets │     │ Rekor public log│
        │ + R2 evidence     │     └─────────────────┘
        └───────────────────┘
```

### Why these are separate processes and not one

| Component | Separate because | Would be fine merged if |
|---|---|---|
| `probe-worker` | Handles attacker-chosen URLs. A parser bug or SSRF bypass in the same process as Auth.js sessions is a full account-takeover primitive. **Never merge this one.** | Never |
| `anchor-cron` | Holds the only key that can sign checkpoints. Key isolation is the whole point. | Signing moves to a KMS with per-call auth and the web tier can't reach it — still not worth it |
| `calibration` | Different language, different failure mode, and it must be allowed to fail without taking the app down. | It were TypeScript and fast — but see [ADR-0004](./adr/0004-python-sidecar-for-calibration.md) |

Everything else lives in the Next.js app. Resist adding a fourth service.

---

## 4. Trust boundaries

Four zones. Data crossing inward gets validated; capability crossing outward gets minimised.

```
  ZONE 0 — hostile                ZONE 1 — semi-trusted        ZONE 2 — trusted
  ─────────────────               ────────────────────         ─────────────────
  probe targets                   authenticated user input     app tier
  witness magic-link callers      GitHub webhook payloads       Postgres
  unauthenticated readers         inbound deploy webhooks      R2
  receipt-format consumers        OAuth profile data
                                                               ZONE 3 — sealed
                                                               ─────────────────
                                                               checkpoint signing key
                                                               (KMS, anchor-cron only)
```

**Zone 0 → 1 controls.** Probe responses are never parsed as anything but bytes + status +
whitelisted headers. No HTML parsing, no JSON deserialisation of target responses into typed
objects, no following of `Location` without IP revalidation. GitHub webhooks verify HMAC
before touching the body. Magic links are single-use, scoped to one `witness.id`, and expire.

**Inbound deploy webhooks (proposed future).** If deploy webhooks are adopted (Vercel,
Netlify), they enter at the Zone 0 → 1 boundary. They require: HMAC signature verification
before touching the payload, webhook ID + timestamp revalidation against a non-replayed set,
and strict parsing that rejects unexpected fields. For v0.1, **deploy events are discovered
via polling, not pushed webhooks**, because Vercel account webhooks are Pro-only (excluding
the primary persona) and Fly has no deploy webhook support. Polling is the safe path until
platform support is uniform.

**Zone 1 → 2 controls.** Every route handler validates with the shared Zod schema before the
value reaches Drizzle. The DSL is parsed and canonicalised before hashing — a spec that
doesn't parse never reaches the database.

**Zone 2 → 3.** Only `anchor-cron` holds credentials for the signing key, and it can only
request signatures over a Merkle root, never over arbitrary bytes. The web tier cannot sign
anything. Receipt *serving* uses a signature computed at resolution time and stored; the
serving path never needs the key.

### The DB role split (the load-bearing detail)

```sql
-- web tier
GRANT SELECT, INSERT, UPDATE ON account, commitment, done_spec, amendment,
      witness, cohort TO pledge_web;
GRANT SELECT ON ledger_entry, checkpoint, calibration_fit TO pledge_web;
GRANT INSERT ON ledger_entry TO pledge_web;   -- append only, see §5.3

-- probe worker: cannot see who anyone is
GRANT SELECT (id, done_spec_hash, deadline, status, committed_at)
      ON commitment TO pledge_probe;
GRANT SELECT ON done_spec TO pledge_probe;
GRANT INSERT ON probe_run TO pledge_probe;
GRANT INSERT ON ledger_entry TO pledge_probe;
-- deliberately NOT granted: account, witness, any email column

-- calibration: read resolved facts, write fits
GRANT SELECT ON commitment, done_spec, probe_run TO pledge_calib;
GRANT INSERT, UPDATE, DELETE ON calibration_fit TO pledge_calib;
```

A column-level grant is what turns "the worker shouldn't read emails" from a code review
comment into a property of the system. Write these grants in the first migration, not later —
retrofitting least privilege never happens.

---

## 5. Data model in depth

Schema is in [`technical-spec.md` §3](./technical-spec.md). What matters here is the
invariants and the new tier tracking.

**Schema additions for the new direction:**

- `commitment.confidence numeric` — the builder's stated probability estimate (0–100 or 0–1,
  normalized on write). Elicited at pledge creation, stored immutably.
- `commitment.verification_tier text` — PROPOSED for ADR-0010. One of `machine_verified`,
  `peer_attested`, `self_reported`. Set at resolution time, immutable after. Determines
  whether the outcome enters the calibration fit.
- `resolution` as a first-class object (or a computed view) — bundles outcome, evidence, and
  tier. Currently evidence lives scattered across `probe_run.evidence` (jsonb), `probe_run.evidence_blob_key` (R2),
  and `witness_attestation`. Under the new model this coheres as: a resolved commitment has
  exactly one `resolution` record capturing outcome + evidence bundle + tier + resolved_at.

**Evidence bundle structure (new):**

```json
{
  "kind": "probe_result" | "witness_attestation" | "self_report",
  "probes": [
    {
      "probe_kind": "http_status" | "github_release_tag" | "dns" | ...,
      "ran_at": "2026-08-30T...",
      "outcome": "pass" | "fail" | "error",
      "evidence": { "status": 200, "body_sha256": "...", "matches": [...] },
      "evidence_blob_key": "r2://...",
      "duration_ms": 1234
    }
  ],
  "witness_attestations": [
    {
      "witness_email": "...",
      "verdict": "attested" | "disputed",
      "note": "...",
      "signed_at": "2026-08-30T..."
    }
  ]
}
```

### 5.1 The three-layer object

```
   done_spec           immutable, content-addressed, shared
      │                (two users committing to the same spec share one row)
      │ hash
      ▼
   commitment          mutable status, immutable claim + spec + committed_at
      │
      ├─► amendment    append-only; deadline lives here after the first move
      ├─► probe_run    append-only observations
      └─► witness      → witness_attestation (append-only)
```

`commitment.deadline` holds the *current* deadline for query convenience, but the
authoritative history is `amendment`. Any UI showing a deadline must also show whether it
moved. A commitment whose deadline moved twice and landed on time is a materially different
signal from one that never moved — hiding that would make pledge exactly the thing it
criticises.

### 5.2 Ledger invariants

1. `seq` is gapless and monotonic. Enforced by `chain_head` serialisation (§6.1), not by
   `bigserial` — sequences have gaps on rollback.
2. `entry_hash[n] = sha256(entry_hash[n-1] || payload_sha256[n] || u64le(seq[n]))`.
3. `entry_hash[0]`'s `prev_hash` is 32 zero bytes.
4. No `UPDATE` and no `DELETE`. Ever. Enforced by grant + a `BEFORE UPDATE OR DELETE` trigger
   that raises.
5. A domain-state change and its ledger append are in **one transaction**. If the append
   fails, the state change rolls back. There is no "eventually consistent ledger."

```sql
CREATE TRIGGER ledger_append_only
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();
```

The trigger is not paranoia about attackers — it's paranoia about a future migration script
written at 1am.

### 5.3 The no-self-report invariant (current) and self-report tier proposal

**CURRENT (in force).** The product's core claim is enforced here or nowhere:

```sql
ALTER TABLE commitment ADD CONSTRAINT status_transitions_are_earned CHECK (
  status = 'open'
  OR (status IN ('kept','missed','disputed') AND resolved_at IS NOT NULL)
  OR (status = 'abandoned')
);
```

The constraint alone isn't sufficient — it can't tell *who* set the status. The real
enforcement is that `pledge_web` has no code path that writes `status IN ('kept','missed')`.
Resolution is written exclusively by `probe-worker` and the witness-attestation handler.

**Test this directly.** A test that asserts "no route handler can produce a `kept` status"
is the single highest-value test in the codebase, because it's the one whose failure
invalidates the entire product rather than one feature.

**PROPOSED NARROWING.** [ADR-0010](./adr/0010-self-reported-verification-tier.md) proposes
introducing a `verification_tier ∈ {machine_verified, peer_attested, self_reported}` column
on resolutions. Under this proposal, the no-self-report invariant narrows from an absolute
to: **`machine_verified` and `peer_attested` resolutions are never written by `pledge_web`.**
Self-reported resolutions, if introduced, would be:

- Permanently and visibly marked with their tier
- Excluded from the north-star metric (% machine-verified outcomes)
- Excluded from calibration fits entirely (a self-report is not a forecast–outcome pair)
- Excluded from calibration rank

If this ADR is accepted, the `pledge_web` / `pledge_probe` DB role split shifts from
"no status IN ('kept','missed')" to "no status IN ('kept','missed') with tier in
('machine_verified', 'peer_attested')". I-1 in [`CLAUDE.md`](../CLAUDE.md) would be
narrowed accordingly. This change must go through an explicit recorded reversal, not
silently into code.

### 5.4 Visibility and the calibration denominator

`commitment.visibility ∈ {public, unlisted, private}`.

**This is unresolved.** [ADR-0008](./adr/0008-calibration-over-all-visibilities.md) is
*Proposed*, not accepted — do not build against it as though it were settled.

The hole it addresses: Pro sells private commitments and lets the owner choose what is
public, so the play is to commit everything privately and publish only the kept ones. That is
self-reporting reintroduced through a paid feature.

ADR-0008's proposal, which stands or falls as a set of three:

- Calibration is computed over **all** commitments regardless of visibility.
- The profile shows `n_public / n_total`.
- Public → private is forbidden; once a commitment is public it stays public.

Whatever is decided, decide it **before the visibility column carries real data** —
retrofitting the denominator means recomputing and republishing every score, which is itself
a credibility event. See [Q-01](./open-questions.md).

---

## 6. The five flows

### 6.1 Commit

The flow now has an optional Scope Negotiator step **outside the transaction**:

```
 composer        LLM (optional)        web                          postgres
    │                                    │                              │
    │ fuzzy intent (free text)           │                              │
    ├────────────────────────────────────┤ (optional, non-blocking)     │
    │◄─── proposed spec draft ───────────┤ LLM proposes, user edits     │
    │ (can skip, write spec manually)    │                              │
    │                                    │                              │
    │  spec text + date (chosen by user) │                              │
    ├────────────────────────────────────►│ parse (Chevrotain)           │
    │                                    │ canonicalise → sha256        │
    │                                    │ Zod-validate AST             │
    │                                    │ derive features from AST     │
    │◄───────────── forecast ────────────┤ read calibration_fit, arith. │
    │   (debounced, no write yet)        │                              │
    │                                    │                              │
    │  confirm + confidence + deadline   │                              │
    ├────────────────────────────────────►│ BEGIN                        │
    │                                    ├─ upsert done_spec ──────────►│
    │                                    ├─ SELECT chain_head FOR UPDATE│
    │                                    ├─ insert commitment ─────────►│
    │                                    │  (with confidence, tier)     │
    │                                    ├─ append ledger_entry ───────►│
    │                                    ├─ update chain_head ─────────►│
    │                                    ├─ enqueue probe schedule ────►│ (pg-boss, same txn)
    │                                    ├─ enqueue baseline snapshot ─►│
    │                                    │ COMMIT                       │
    │◄──────────── id + forecast ────────┤                              │
```

Four things worth noticing:

- **The Scope Negotiator (LLM) is outside the transaction and optional.** The flow is: fuzzy
  intent → LLM proposes done-spec AST → web tier parses it (Chevrotain) → user edits → commits.
  If the user skips the LLM step and writes the spec manually, the flow is unblocked and unchanged.
  The LLM output is not trusted directly; it is parsed by `packages/spec` and content-addressed,
  so the hash is the contract, not the LLM's word.
- **Confidence is elicited and stored immutably at commit time.** Used for self-calibration
  computation and for the new verification tier model (ADR-0010).
- **The forecast is computed before any write.** It's a pure function of the AST features and
  the user's stored fit. This is what lets it render while the date picker is open, which is
  the entire behavioural intervention ([`technical-spec.md` §10](./technical-spec.md)).
- **The baseline snapshot is enqueued at commit time**, not at first probe. It captures what
  the target looked like *before* the work, which is what makes the novelty check meaningful
  (§6.2).
- **pg-boss enqueues inside the transaction.** Because the queue is the same Postgres, "job
  enqueued but commitment rolled back" is structurally impossible. This is the main reason to
  use pg-boss over an external broker ([ADR-0002](./adr/0002-postgres-for-queue.md)).

### 6.2 Probe

```
 pg-boss ──► probe-worker
                │
                ├─ load done_spec.ast (no account data available — §4)
                ├─ walk AST, collecting distinct sources
                ├─ for each source:
                │     resolve DNS → validate every A/AAAA against BLOCKED ranges
                │     connect to the pinned IP (not the hostname)
                │     cap body at 5MB, total budget 10s
                │     manual redirect, max 3, revalidate IP at each hop
                ├─ memoise per source (status + text fetched once)
                ├─ evaluate boolean
                ├─ build evidence { status, headers⊂, body_sha256, matches[], resolved_ip }
                ├─ novelty: body_sha256 == baseline_sha256 ?
                │     → flag unchanged_since_commitment
                ├─ archive body → R2
                └─ BEGIN
                     insert probe_run
                     if pass and status = 'open':
                        status ← 'kept', resolved_at ← earliest passing ran_at
                     append ledger_entry(probe_result [, resolved])
                   COMMIT
```

**Idempotency.** Probe jobs must be safely re-runnable — pg-boss can deliver twice. The
transition to `kept` is guarded by `WHERE status = 'open'`, so a duplicate delivery inserts a
second `probe_run` (harmless, it's an observation log) and no second resolution.

**The earliest-pass rule.** `resolved_at` is the earliest *passing* probe's `ran_at`, not the
time the worker noticed. Someone who ships at 02:00 and gets probed at 03:00 is credited at
02:00 only if a probe actually ran at 02:00 — which is why the schedule tightens to 5-minute
intervals in the final hour. Be honest in the UI: this is "earliest observed", not "earliest
true". Copy should say *observed*, never *shipped at*.

**Mandatory deadline probe.** `K` (did the done-condition hold on the deadline?) has ambiguity
equal to the probe interval if no probe is scheduled exactly at `deadline+0`. A probe 6 hours
after the deadline cannot answer whether the commitment held at the deadline. **Every open
commitment must have a probe scheduled at `deadline+0` precisely.** This is not a timing
preference; it is a requirement for the binary calibration axis to be well-defined.

### 6.3 Resolve

Three + one writers can move a commitment out of `open`, and only the first can produce a
machine-verified success. Under ADR-0010 (self-reported tier), each resolution records a
`verification_tier`:

| Writer | Outcome | Tier | When |
|---|---|---|---|
| `probe-worker` | `kept` | `machine_verified` | any passing probe |
| `probe-worker` | `missed` | `machine_verified` | the authoritative `deadline+0` run **observes false** |
| `probe-worker` | `disputed` | `machine_verified` | the target was unobservable at `deadline+0` past the grace window (§8), or the target host is blocklisted ([`security.md`](./security.md) T-07) |
| witness handler | `disputed` | `peer_attested` | attestation contradicts probe outcome |
| witness handler | `kept` | `peer_attested` | (PROPOSED) attestation affirms probe outcome or spec for a commitment with no probe |
| amendment handler | `abandoned` | — | user withdraws, reason required |
| user self-report (PROPOSED ADR-0010) | `kept` or `missed` | `self_reported` | user clicks "mark as kept/missed" button; excluded from calibration |

**If self-report tier is accepted:**

- A commitment can only reach `self_reported` status if the builder elects it explicitly.
- `self_reported` outcomes are **never counted** in the north-star metric (% machine-verified).
- `self_reported` outcomes are **excluded entirely from calibration fits** — a self-chosen
  outcome is not a forecast–outcome pair and Brier score is undefined.
- The UI permanently marks self-reported outcomes with a distinct visual treatment.

`missed` is deliberately *not* produced by intermediate failures — a probe failing at T-48h
means nothing, and marking it would be the "nag" behaviour the product rejects.

`disputed` is a terminal display state, not a workflow. Both records stay visible. There is
no admin who "resolves" a dispute silently — if a human adjudicates, that adjudication is
itself a ledger entry.

### 6.4 Anchor

```
 every 10 min:
   SELECT entries WHERE seq > last_checkpoint.tree_size ORDER BY seq
   build RFC 6962 Merkle tree over entry_hash values
   root ← tree root
   sig  ← KMS.sign(ed25519, canonical(root ‖ tree_size ‖ timestamp))
   rekor ← sigstore.submit(sig, root)
   insert checkpoint(root, tree_size, rekor_log_index, rekor_uuid, sig)
```

Anchoring is **asynchronous to resolution**. A commitment resolves immediately; its receipt
becomes *anchored* up to 10 minutes later. Receipts requested before anchoring return
`anchor: null` with `anchor_pending: true` and remain valid for signature-only verification.
The verifier must handle this — see [`spec/receipt-format.md`](./spec/receipt-format.md) §5.

This is also the layer [ADR-0005](./adr/0005-defer-rekor-anchoring.md) proposes deferring.
If deferred, everything above stays true except the `rekor_*` columns stay null and
verification stops at step 2.

### 6.5 Verify (the flow that doesn't touch us)

```
  evaluator                pledge-verify              Rekor
      │  receipt.json          │                        │
      ├───────────────────────►│                        │
      │                        │ 1. recompute payload   │
      │                        │    sha256 via RFC 8785 │
      │                        │ 2. verify ed25519 sig  │
      │                        │ 3. walk audit_path     │
      │                        │    → checkpoint root   │
      │                        ├── GET log entry ──────►│
      │                        │◄── entry + STH ────────┤
      │                        │ 4. root matches?       │
      │                        │ 5. verify STH sig      │
      │◄─── verdict ───────────┤                        │
```

pledge appears nowhere in this diagram after the receipt is handed over. That property is
the product's entire technical claim, and it is worth protecting against any change that
would require a call back to `pledge.sh` to verify.

---

## 7. Consistency and ordering

**Chain serialisation.** All ledger appends take `SELECT ... FROM chain_head FOR UPDATE`.
This is a global write lock on the append path. At the design volume (thousands of appends
per hour, each ~1ms of lock hold) that supports roughly three orders of magnitude of
headroom, and it eliminates every ordering bug that a per-account chain would introduce.
[ADR-0003](./adr/0003-global-chain-lock.md).

**Per-account views are projections.** `GET /v1/accounts/:handle/ledger` filters the global
chain by `account_id`. The audit path still walks the global tree, so a user's entries are
provably interleaved in real time with everyone else's — which is itself a useful
anti-backdating property.

**Clock discipline.** Every timestamp is `timestamptz`, stored UTC, generated by Postgres
`now()` inside the transaction — never by application code, never by a worker's local clock.
Probe `ran_at` is the one exception (it's an observation of an external event) and is
recorded by the worker but bounded: a `ran_at` more than 60s from transaction time is
rejected as clock skew.

**Timezone display.** Stored UTC, rendered in the committer's zone. An off-by-one-day
deadline on a deadline product is unrecoverable reputationally. Deadline tests run against
`Asia/Kolkata` specifically because a UTC+5:30 offset breaks naive date arithmetic in a way
UTC+1 does not.

---

## 8. Failure modes

The table is the useful part of this document. Every dependency, what breaks, and what the
user sees.

| Dependency down | Blast radius | Degradation | User-visible |
|---|---|---|---|
| **Rekor** | anchoring only | `anchor-cron` retries with backoff; checkpoints queue up | Receipts show `anchor_pending`. Nothing else changes |
| **Calibration sidecar** | nightly fit | App serves yesterday's `calibration_fit` row | Forecast slightly stale. No error surfaced |
| **`calibration_fit` empty (cold start)** | new users | Fall back to population prior | Forecast shown with `confidence: low` and n=0 disclosed |
| **Probe target down** | one commitment | `outcome = 'error'`, not `'fail'` — errors never resolve a commitment | Commitment page shows "couldn't reach target", last-good timestamp |
| **Probe target down at `deadline+0`** | resolution correctness | **Do not mark missed.** Retry for a grace window (default 60 min), then `disputed` with reason `target_unreachable_at_deadline` | Honest: "we could not verify at the deadline" |
| **R2** | evidence archival | Probe still runs; `evidence_blob_key` null, hash still recorded and ledgered | Evidence link missing on that run. Verification unaffected — the hash is in the ledger |
| **GitHub API rate limit** | github probes | Backoff + use the installation token's higher limit; never fall back to unauthenticated for a resolution-critical run | Probe delayed, not failed |
| **Postgres** | everything | Nothing works. Accept it — Neon's availability is the product's availability | Full outage |
| **pg-boss backlog** | probe latency | Final-hour jobs get a higher priority class so backlog delays daily probes, not deadline probes | Slightly late non-critical probes |
| **Resend / Telegram** | notifications | Queue and retry; notifications are never in the resolution path | Late email |

Two principles hidden in that table, worth stating outright:

1. **`error` ≠ `fail`.** A probe that couldn't reach the target has observed nothing. Only an
   observation that the done-condition is *false* is a failure. Collapsing these would let a
   network blip mark someone as having missed — the single most reputation-destroying bug
   this product could ship.
2. **Nothing in the notification path can affect resolution.** They are separate queues with
   separate failure handling, and no resolution transition awaits a send.

---

## 9. Deployment topology

| Env | Web | DB | Workers | Notes |
|---|---|---|---|---|
| local | `next dev` | Docker Postgres 16 | `tsx watch worker.ts` | Probes hit a local fixture server, not the internet. Never point local at real targets |
| preview | Vercel preview | Neon branch | **none** | Preview deploys must not run probes — they'd double-probe production commitments |
| prod | Vercel | Neon primary | Fly.io / Railway container, fixed egress IP | Fixed IP is required for the target-side allowlisting story |

**The preview rule is not cosmetic.** Two environments probing the same commitment produce
two `probe_run` rows from different resolved IPs and can race the `kept` transition. Worker
deploys are gated on `PLEDGE_ROLE=worker` being explicitly set, which is set nowhere but prod.

**Migrations.** Drizzle Kit, forward-only. Never a `DROP COLUMN` on a ledger-adjacent table;
add a new column and stop writing the old one. The ledger's whole value is that history isn't
rewritten, and that includes schema history.

---

## 10. Package layout

```
pledge/
  apps/
    web/                  Next.js — UI + /api/v1 route handlers
    worker/               probe-worker + anchor-cron entrypoints
    calibration/          Python: fit.py, features.py, Dockerfile
  packages/
    spec/                 @pledge/spec      — lexer, parser, AST, canonicalise, evaluate  [MIT]
    safe-fetch/           @pledge/safe-fetch — SSRF-hardened undici dispatcher            [MIT]
    ledger/               chain append, Merkle, audit path                                [private]
    db/                   Drizzle schema + migrations + role grants                       [private]
    verify/               pledge-verify CLI                                               [MIT]
  docs/
```

The two MIT packages are load-bearing for distribution, not just tidiness: `@pledge/safe-fetch`
solves a real, widely-botched Node problem and is the kind of thing that gets linked from
security write-ups. `@pledge/spec` being open is what lets a third party verify that a
done-spec means what the receipt claims it means.

**Boundary rule:** `packages/spec` must have zero dependencies on `packages/db`. The parser
and evaluator have to be runnable in a browser (for composer-time preview) and in the
verifier CLI (with no database at all).

---

## 11. API surface

Full route list in [`technical-spec.md` §9](./technical-spec.md). Architectural notes:

- **Public reads are unauthenticated and edge-cached.** Profile, ledger, badge, checkpoint.
  These carry no session and should survive a traffic spike from a shared receipt without
  touching the origin.
- **Writes are session (web) or PAT (API).** PATs are scoped per-account, never per-org, and
  cannot create a `kept` status because no endpoint does.
- **`POST /v1/forecast` is a read.** It writes nothing, takes a spec + date, and returns
  probability and calibrated dates. It's rate-limited per session but not authenticated
  beyond that — it's also the natural public demo.
- **`GET /v1/checkpoints/latest` is deliberately public and uncached-at-edge.** A third party
  monitoring for split-view attacks needs the real current root, not a CDN copy.

---

## 12. Scaling triggers

Nothing here is built now. These are the tripwires that say *now*.

| Trigger | Response | Not before |
|---|---|---|
| Chain append lock contention > 5% of txn time | Shard the chain per-account; audit paths get more complex | ~50 appends/sec sustained |
| Probe volume > 1M/hr | Extract the worker; it's already isolated. Language change optional | 3 orders of magnitude away |
| Vercel egress material vs. revenue | Move web to a Hetzner box + Docker Compose. Hosting change, not architecture change | Real bills exist |
| Receipts consumed by third-party platforms at scale | Go verifier binary in the Sigstore ecosystem | Someone actually asks |
| Calibration fit > 10 min nightly | Incremental fit over changed users only | Thousands of active users |

The correct number of these to pre-build is zero.

---

## 13. What this architecture does not solve

Stated plainly, because an architecture doc that only lists strengths is marketing.

- **It cannot tell whether a commitment was meaningful.** Every probe is satisfiable by
  something smaller than what was promised. Novelty checks and semantic templates raise the
  cost of faking; they don't close the gap. See [`security.md`](./security.md) T-04 and
  [Q-02](./open-questions.md).
- **Witness co-sign reintroduces the honor-system referee** that the product criticises in
  StickK. The architecture makes attestations *attributable and permanent*, which is a real
  improvement, but it is not a solution to the same problem by different means.
- **An LLM in the request path adds a new synchronous third-party dependency** on the write
  path. Latency, cost, failure modes, and prompt-injection surface are all real costs. The
  Scope Negotiator is specified as outside the transaction and optional (manual entry bypasses
  it), which bounds the risk — but this is a genuine architectural debt. See [`security.md`](./security.md)
  T-09 (new).
- **Self-reported resolutions (if ADR-0010 is accepted) are a bypass of the entire probe-gaming
  threat model.** The cost is that self-reported outcomes must be permanently marked, excluded
  from calibration and the north-star metric, and rendered with distinct visual treatment. But
  they are a bypass nonetheless. See [`security.md`](./security.md) T-04 update.
- **Cryptographic verifiability answers "did pledge fabricate this", which nobody is
  currently asking.** The trust question in the field is "does this probe mean anything." The
  ledger is correct engineering aimed slightly to the left of the actual doubt.
  ([ADR-0005](./adr/0005-defer-rekor-anchoring.md).)
- **Nothing here reduces the friction of the commit ritual**, which is the most likely reason
  the product fails ([Q-04](./open-questions.md)). If the answer to Q-04 is "derive
  commitments from existing planning artifacts", most of §6.1 changes and §6.2–6.5 survive
  intact — which is a good sign the seams are in the right places.
