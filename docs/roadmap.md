# pledge — Roadmap and Phases

**Version:** 1.0
**Date:** August 2026
**Depends on:** [`technical-spec.md` §12](./technical-spec.md),
[`architecture.md`](./architecture.md)

The technical spec has a four-row estimate table. This document turns it into phases with
**deliverables, exit criteria, and an explicit deferred list** — because the failure mode of
a spec this complete is that v2 features leak into v0 and nothing ships.

---

## 0. How to read the estimates

The spec estimates v0=2d, v1=1w, v2=2w, v3=2–3w. Those are **p50 estimates by an optimistic
estimator on greenfield work with novel components**, which is the single most reliably
underestimated category there is.

There is no pledge population prior to apply yet — [`calibration.md`](./calibration.md) §6
says the prior is bootstrapped from published software-estimation literature until real data
exists, and does not carry per-category figures. So the multipliers below are a **stated
assumption, not a fitted number**: median slip ~1.6x, p80 ~2.6x, taken from that literature's
usual range for greenfield work with novel components. Replace this table with a real fit
once ~200 resolved commitments exist.

| Phase | Stated (p50) | Calibrated p80 | What drives the tail |
|---|---|---|---|
| v0 | 2 days | ~5 days | first-time Drizzle + pg-boss + Auth.js wiring |
| v1 | 1 week | ~2.5 weeks | Chevrotain grammar iteration; canonicalisation edge cases |
| v2 | 2 weeks | ~5 weeks | Merkle audit paths and Rekor integration are genuinely fiddly |
| v3 | 2–3 weeks | ~6 weeks | cohorts touch every surface at once |

**These four phases should be the first four commitments on pledge itself.** Commit to the
p50, publish the p80, and let the record settle the argument. That is both the honest thing
and the best possible launch content.

**The gate that matters:** do not start phase N+1 until phase N's exit criteria are green.
Every criterion below is written to be checkable, not aspirational.

---

## Phase v0 — Prove the loop

**Goal:** one real commitment, resolved by a real probe, visible on a real public URL. Not a
product. A proof that the core mechanic works end to end.

### Deliverables

- Postgres schema for `account`, `commitment`, `done_spec`, `probe_run` — **with the role
  grants from [`architecture.md` §4](./architecture.md) in the first migration.**
- Auth.js + GitHub OAuth. Handle claimed from GitHub login.
- Two hardcoded probe kinds — `http(url).status`, `github.release(repo).tag` — as plain
  TypeScript functions. **No DSL, no parser.**
- `@pledge/safe-fetch` with the SSRF dispatcher. This is v0, not v1: shipping an unhardened
  probe fetcher even once is unacceptable.
- pg-boss with a fixed daily schedule. No backoff curve yet.
- Public profile at `/[handle]`, SSR, listing commitments with status.
- Resend email at commit and at resolution.

### Exit criteria

- [ ] A commitment created through the UI resolves to `kept` from an actual probe against a
      real repo, with zero manual DB edits.
- [ ] A test asserts **no route handler can write `status IN ('kept','missed')`** — grep the
      web package for those literals and fail the build if found outside tests.
- [ ] `@pledge/safe-fetch` rejects, with a test each: `127.0.0.1`, `169.254.169.254`,
      `10.0.0.1`, `[::1]`, a DNS name resolving to a private IP, and a redirect chain whose
      third hop is private.
- [ ] `/[handle]` is server-rendered, returns 200 to `curl` with JS disabled, and is indexed
      by a Lighthouse SEO score ≥ 90.
- [ ] Deadline arithmetic is correct in `Asia/Kolkata` — a commitment due "Sept 5" resolves
      against 2026-09-05T23:59+05:30, tested explicitly.
- [ ] One commitment on the deployed instance, made by you, publicly visible.

### Explicitly deferred out of v0

DSL · witnesses · amendments · ledger · calibration · receipts · OG images · cohorts ·
Telegram/WhatsApp · the backoff schedule · private commitments.

> **v0 anti-goal:** do not build the ledger in v0. It is tempting because it feels
> foundational, and it will consume the entire phase. The ledger is v1 and the schema is
> designed so adding it is an insert-only change, not a migration.

---

## Phase v1 — Make the record real

**Goal:** the commitment becomes an auditable object rather than a database row.

### Deliverables

- **`@pledge/spec`** — Chevrotain lexer + parser → CST → Zod-validated AST. Grammar per
  [`spec/done-spec-dsl.md`](./spec/done-spec-dsl.md).
- Canonicalisation (RFC 8785) + sha256 → `done_spec.hash`. `spec_version = 1` pinned.
- Template picker in the composer over 5 templates; DSL as the escape hatch.
- **Hash-chained ledger** — `ledger_entry`, `chain_head` serialisation, append-only trigger,
  transactional appends on every state change.
- **Amendments** — deadline moves and abandonment, reason required, rendered in the timeline.
- **Witnesses** — invite by email, accountless magic-link attestation
  ([ADR-0006](./adr/0006-accountless-witnesses.md)).
- **Baseline snapshot + novelty check** — target hash captured at commit; `unchanged_since_commitment`
  flag surfaced on the profile.
- Probe backoff curve: daily → hourly at T-72h → 5-minutely at T-1h → authoritative at
  deadline+0, with the `error ≠ fail` grace window.
- `next/og` cards for profile and commitment.
- `npx pledge-verify` doing **steps 1–2 only** (canonical hash + signature). Inclusion proofs
  land in v2.

### Exit criteria

- [ ] Round-trip property test: `parse → canonicalise → serialise → parse` is a fixed point
      for 500 generated specs.
- [ ] Two syntactically different but semantically identical specs produce the **same** hash;
      two semantically different specs never collide. Tested with a corpus.
- [ ] Ledger verification script walks the full chain from genesis and confirms every
      `entry_hash`. Runs in CI against a seeded DB.
- [ ] `UPDATE ledger_entry` and `DELETE FROM ledger_entry` both raise, tested.
- [ ] Killing the worker mid-probe leaves no partial state — commitment stays `open`, a
      re-run resolves it. Tested with a forced crash.
- [ ] A witness who has never visited pledge can attest from a link in one click, and cannot
      attest twice or after expiry.
- [ ] `npx pledge-verify` validates a real receipt on a machine with no pledge credentials.
- [ ] OG image renders correctly for: a kept commitment, a missed one, an amended one, and a
      handle with an emoji in it.

### Explicitly deferred out of v1

Calibration · forecast · Merkle · Rekor · cohorts · badges · chat notifications · private
commitments · the public API.

---

## Phase v2 — Make it an instrument

**Goal:** the forecast, which is the actual product differentiator.

### Deliverables

- **Feature extraction from the AST** — probe kind, distinct source count, third-party API
  involvement, foreign-repo references, historical difficulty of the probe class
  ([ADR-0007](./adr/0007-ast-derived-features.md)).
- **Python calibration sidecar** — nightly container, closed-form normal-normal conjugate fit
  in numpy, **censored likelihood for abandoned/unresolved**, exponential recency weighting
  (~9-month half-life). Writes `calibration_fit`.
- **Population prior** bootstrapped from a hand-seeded synthetic corpus until real data
  exists — documented as synthetic in the UI.
- **Inline forecast** in the composer, debounced on date change, computed in TypeScript from
  the stored fit.
- Calibration panel on the profile: on-time rate, median and p90 slip, best/worst category,
  **volume and raw claim text alongside** (never a context-free number).
- **Signed receipts** — payload per [`spec/receipt-format.md`](./spec/receipt-format.md),
  ed25519 signature at resolution time.
- **Merkle checkpoints + Rekor anchoring** — *gated on
  [ADR-0005](./adr/0005-defer-rekor-anchoring.md).* If that ADR is accepted, this ships behind
  a trigger and v2 ends two weeks earlier.
- `pledge-verify` steps 3–5.

### Exit criteria

- [ ] A user with **zero** resolved commitments receives a sane forecast from the population
      prior, labelled `confidence: low, n=0`.
- [ ] Simulation test: generate users with known true slip parameters, fit, and confirm the
      hierarchical model recovers them within tolerance and beats naive per-user averaging on
      users with n < 5. **This is the test that proves the moat exists.**
- [ ] Censoring test: a cohort where 30% of commitments are abandoned produces a fit whose
      `mu` is not biased optimistic relative to ground truth. Dropping censored rows must
      visibly fail this test.
- [ ] Forecast renders in < 100ms p95 in the composer, measured, with no sidecar in the
      request path.
- [ ] Sidecar failure for 3 consecutive nights degrades to stale parameters with no user-facing
      error and an operator alert.
- [ ] A receipt verifies on a clean machine with `npx pledge-verify` and no network access to
      `pledge.sh` (Rekor access only).
- [ ] Tampering with any field of a receipt — claim, deadline, evidence hash, outcome —
      causes verification to fail, tested field by field.

### Explicitly deferred out of v2

Cohorts · organizer reports · badges · public API · chat notifications · Go verifier.

---

## Phase v3 — Make it recur

**Goal:** the distribution mechanism. Individuals churn; cohorts renew.

### Deliverables

- Cohort object, organizer role, join flow, shared deadline.
- Cohort board — participant grid, live verified status.
- **Organizer post-event report** — of N participants, how many shipped a probe-verified
  artifact, with per-participant evidence links and an export. *This is the thing organizers
  pay for; build it first within the phase, not last.*
- Embeddable badge `/v1/badge/:handle.svg`, ETag-cached.
- Public API + PATs.
- Telegram and WhatsApp Cloud API notifications.
- Billing for the Cohort tier.

### Exit criteria

- [ ] Run one real cohort end to end — the Mumbai FOSS / Claude Code meetup pilot — with ≥ 10
      participants and a report generated with zero manual intervention.
- [ ] An organizer who has never used pledge can create a cohort, invite participants, and
      export a report without support contact. Watched, not assumed.
- [ ] Badge renders correctly in a GitHub README (GitHub proxies images through Camo — test
      against Camo specifically, not just a browser).
- [ ] Cohort visibility rules: a private cohort's participant list is not enumerable via the
      public API, tested.
- [ ] Rate limits hold under a cohort deadline spike — 200 participants, all probing in the
      final hour, without starving the daily queue.

---

## Cross-cutting: what must be true before public launch

Independent of phase. All of these gate *launch*, not development.

- [ ] **[Q-00](./open-questions.md) closed** — pre-launch personal/legal clearance (see NOTES.local.md)
      resolved in writing. This is the hard blocker.
- [ ] **[Q-01](./open-questions.md) decided** — the private/public calibration denominator.
      Decide before the visibility column ships with real data behind it.
- [ ] **[Q-06](./open-questions.md) decided** — evidence blob retention and takedown. Privacy
      policy and a retention limit for archived third-party page content
      ([`security.md`](./security.md) T-08).
- [ ] **[Q-05](./open-questions.md) decided** — bad-faith probing of targets the committer
      does not own, at 5-minute intervals. Rate limits are necessary, not sufficient; the
      leaning is domain verification for high-frequency probing, and it is *not yet decided*
      ([`security.md`](./security.md) T-07).
- [ ] `robots.txt` compliance verified for unverified target domains, and a documented
      opt-out at `pledge.sh/probe`.
- [ ] Key custody documented — where the checkpoint signing key lives, who can reach it, and
      what the rotation procedure is ([`security.md`](./security.md) T-06).

---

## Sequencing risks

| Risk | Phase | Mitigation |
|---|---|---|
| Ledger work leaks into v0 and eats the phase | v0 | It's on the deferred list. Schema is append-compatible; no migration cost to waiting |
| DSL grammar iteration is open-ended | v1 | Timebox to the 5 template shapes + the escape hatch. Grammar freeze at `spec_version = 1` |
| Rekor integration consumes v2 and the forecast never ships | v2 | Build calibration **first** within v2. Anchoring last, and only if ADR-0005 is rejected |
| Cohorts need surfaces that don't exist yet | v3 | Cohort board reuses the profile components. If they weren't built reusably in v0, that's the v3 tax |
| Calibration has no data to fit | v2 | Synthetic corpus + population prior. Label synthetic honestly in the UI |
