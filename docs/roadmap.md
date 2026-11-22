# pledge — Roadmap and Phases

**Version:** 2.0
**Date:** August 2026
**Status:** v0 and v1 complete locally (commit 8cc6f1b). Phases below are FORWARD from current state.

The v0.1 MVP design (new direction, August 2026) recuts the product line for public launch.
v0 and v1 are built and green; the phases below map what ships first and what remains.

**These four phases themselves should be the first four public commitments on pledge**. Commit
to the p50, publish the p80, and let the record settle the argument.

---

## 0. How to read the estimates

v0 (2d est., shipped) and v1 (1w est., shipped) have a real baseline now: `git log --all
--format="%an %s" | wc -l` shows 5 commits over ~4 weeks part-time. The estimates below for
v0.1 → v3 are **p50 re-estimates by the original author on work already half-shaped**. No
longer purely greenfield; no longer unknown components; but LLM integration (new C-3) and
two-axis calibration (new) are novel.

Multiplier: p80 ~2.0x for v0.1 (small, known scope), ~2.5x for v2 (Merkle/Rekor), ~3x for v3
(touches every surface). These are stated assumptions; replace with a real fit once ~200
resolved commitments exist.

| Phase | Status | Stated (p50) | Calibrated p80 | What drives the tail |
|---|---|---|---|---|
| v0 | ✓ SHIPPED | 2 days | ~5 days | ~~first-time Drizzle~~ done |
| v1 | ✓ SHIPPED | 1 week | ~2.5 weeks | ~~grammar iteration~~ done |
| v0.1 MVP | **IN PROGRESS** | 1 week | ~2 weeks | confidence field; Scope Negotiator LLM integration (C-3); badge endpoint |
| v2 | planned | 2 weeks | ~5 weeks | Merkle audit paths, Rekor integration, two-axis calibration (ADR-0011) |
| v3 | planned | 2–3 weeks | ~6 weeks | cohorts and organizer surfaces (C-4) |

---

## Phase v0.1 — Deploy the core loop

**Goal:** public launch. Commit, resolve, calibrate, share — the five-minute loop.
Confidence-first: the confidence field unblocks the entire calibration identity, so it ships
first despite being tiny. Scope Negotiator is the flagship feature but it is a new LLM
dependency (C-3 flagged); include it if integrated, mark it optional if integration overruns.

### Deliverables

**Core (required for launch):**
- **`confidence` field** in schema: numeric at commitment time, input to forecast and rank.
  Schema migration + form field + UI display.
- **Calibration basics** — one-axis model (slip), already designed in
  [`calibration.md` §2](./calibration.md). Read-only display on profile: on-time rate, median slip,
  calibration curve (reliability diagram). No leaderboard yet (v2/ADR-0011).
- **Badge endpoint** — `/api/v1/badge/:handle.svg` returning an embeddable SVG with on-time %.
  Cache with ETag per commit; re-render on resolution only.
- All of **v0 + v1** (already shipped): DSL, ledger, amendments, witnesses, OG cards, receipts.

**Optional (required for "Scope Negotiator" positioning, ships v0.2 if overruns):**
- **Scope Negotiator** — LLM at pledge creation converts fuzzy intent → done-spec AST +
  suggested deadline (new C-3 dependency). Calls an LLM endpoint outside the transaction
  (advisory, non-blocking). Surfaces user's historical slip for this category.
  Requires: LLM provider integration (Anthropic SDK), prompt engineering, evidence-bundle
  lookup for historical context.

### Exit criteria

- [ ] `pnpm schema` and a fresh migration add `confidence numeric` to `commitment`. Existing
      commitments have confidence NULL, rendered as "not set" in the UI.
- [ ] Commitment form includes a confidence field (0–100 slider). Confidence is required for
      new commitments, optional display for existing.
- [ ] `/[handle]` profile shows: on-time count / total count, median slip (if n ≥ 3),
      calibration curve as a reliability diagram with n annotated. Sourced from the one-axis
      fit (designed, not yet implemented).
- [ ] `/api/v1/badge/:handle.svg` returns a 200 with `Content-Type: image/svg+xml`, 
      `Cache-Control: public, max-age=3600`, and an ETag based on the handle's latest resolution.
      SVG displays on-time % as a shield or percentage badge. Embeddable in GitHub README.
- [ ] Scope Negotiator (if shipped): pledge creation flow offers an optional "Refine with AI"
      step that calls `POST /api/v1/negotiate`, returns a suggested done-spec AST + deadline
      + confidence. User can accept, edit, or skip. Tests verify: no LLM call if user skips;
      call failure does not block commitment; output is parsed by `@pledge/spec` (I-6).
- [ ] One public pledge created end to end via pledge.sh, resolved via a real probe, with
      confidence set and rendered on the profile. Visible at `pledge.sh/[your-handle]`.
- [ ] Build and tests pass: `pnpm build && pnpm test && pnpm ledger:verify`.

### Explicitly deferred out of v0.1

Calibration Rank · Seasons / leaderboard · Two-axis calibration (self-calibration/confidence-vs-outcome) ·
Duels, covenants, graveyard · Private pledges · Money stakes · API / PATs · Rekor anchoring ·
MCP server · Scope Negotiator (if LLM integration not ready).

> **v0.1 anti-goal:** do not ship a half-baked Scope Negotiator. If LLM integration slips,
> move it to v0.2 and ship v0.1 with the confidence field + calibration basics + badge instead.
> Better to launch without the flagship than to ship a feature that breaks on edge cases.

---

## Phase v2 — Make it an instrument

**Goal:** the two-axis calibration model. Forecast, difficulty-weighted rank, dual metrics
(slip + self-calibration).

Depends on: v0.1 production data (~200 resolved commitments minimum before fitting begins).

### Deliverables

**One-axis fit (ready to ship, scaffolding in place in v0.1):**
- Feature extraction from AST: probe kind, distinct sources, third-party API involvement,
  foreign-repo references. Per [`adr/0007-ast-derived-features.md`](./adr/0007-ast-derived-features.md).
- Python calibration sidecar (nightly job): censored normal-normal conjugate fit, exponential
  recency weighting (~9-month half-life). Writes `calibration_fit` (schema TBD).
- Per-builder hierarchical priors: `mu_i`, `sigma_i` for slip; `a_i`, `b_i` for
  self-calibration (§4.2 of calibration.md, per hierarchical logistic recalibration).

**Two-axis fit (NEW, sketched in calibration.md §1–2, _not_ in one-axis sidecar yet):**
- Self-calibration axis: `K_ij` = "on-time binary" fitted against builder's `p_ij` (stated
  confidence). Produces reliability curve and Brier score. Hierarchical logistic recalibration
  with Cox recalibration intercept/slope per builder.
- **Exclude self-reported outcomes from the fit entirely** (calibration.md §5.1, ADR-0010).
  Self-reported rows are written as `status IN ('self_kept', 'self_missed')`, never converted
  to 'kept'/'missed' (enforcement via second `check-invariants` assertion).

**Leaderboard (ADR-0011, PROPOSED):**
- Calibration Rank (ungameable): rank on Brier Skill Score `BSS_i = 1 - BS_i / BS_ref_i`
  where reference is the population duration model at this pledge's AST features. Trivial
  sandbagging yields negative rank; overpromising tanks you.
- Seasonal reset (quarterly): leaderboard resets, ledger survives.
- Display: lead with self-calibration axis (honesty), slip as the coaching input.

**Forecast (inline, pre-computed):**
- Inline forecast in the composer debounced on date change, computed in TypeScript from the
  stored fit. Surfaces `q̂_ij` (predicted on-time %) + historical slip + suggested deadline.
- "You estimated 90%, you're landing 65% on release-sized pledges. We suggest Sept 20 instead
  of Sept 15." (the coaching line from calibration.md §1, available at n=0 using population
  prior).

**Verification (receipts):**
- Signed receipts per [`spec/receipt-format.md` §3](./spec/receipt-format.md): payload + ed25519
  signature at resolution time.
- `pledge-verify` steps 3–5 (if ADR-0005 rejected; deferred if ADR-0005 accepted).

### Exit criteria

- [ ] A user with zero resolved commitments receives a sane forecast from the population prior,
      labelled `confidence: low, n=0`.
- [ ] Simulation test: generate 100 users with known true slip parameters, fit the model,
      confirm the hierarchical model recovers them within 20% and beats naive per-user
      averaging on n < 5 (this is the test that proves the moat exists).
- [ ] Censoring test (critical, F-4): fit with the censored likelihood (abandoned commitments
      excluded), then drop censored rows and fit again. The drop-rows fit **must show**
      optimistic bias (higher mu) **and higher variance**. If it does not, the censoring is not
      being exercised correctly (calibration.md §4).
- [ ] Forecast renders in < 100ms p95 in the composer, with no sidecar in the request path.
- [ ] Sidecar failure for 3 consecutive nights degrades to stale parameters with no user-facing
      error and an ops alert (PagerDuty or equivalent).
- [ ] A receipt verifies on a clean machine with `npx pledge-verify` (no network, no database,
      no credentials).
- [ ] Tampering with any field of a receipt (claim, deadline, confidence, outcome) causes
      verification to fail, tested field by field.
- [ ] Calibration Rank exists on profile, with an explanation of the formula and no builder
      name/handle ranking without explicit opt-in (privacy-first).

### Explicitly deferred out of v2

Cohorts · organizer reports · private pledges · public API · Rekor anchoring (per ADR-0005);
MCP server · Gamification (duels, graveyard, trophies) — those ship in v2.5 / v3.

---

## Phase v3 — Make it recur

**Goal:** organizer and cohort surfaces. Distribution via building communities, not individuals
alone.

### Deliverables

- Cohort object, organizer role, join flow, shared deadline.
- Cohort leaderboard — participants, real-time machine-verified status, total on-time count.
- **Organizer post-event report** — of N participants, how many shipped a machine-verified
  artifact, with per-participant evidence links and a downloadable CSV/PDF. *This is the thing
  organizers pay for; build it first within the phase.*
- Gamification surfaces per [`product-overview.md` §3](./product-overview.md): Calibration Rank
  leaderboard (seasonal), duels (two builders, comparable scope), covenants (3–8 toward shared
  deadline), graveyard (dropped projects, "up for adoption" flag, epitaph).
- Proof-of-Ship trophies: evidence trophies (visual distinction for machine-verified),
  slip-honesty marks (annotating slip before deadline earns "called it early").
- Billing for Cohort tier (Pro subscriptions remain individual-focused, per ADR-0013).

### Exit criteria

- [ ] Run one real cohort end to end — the Mumbai FOSS / Claude Code meetup pilot — with ≥ 10
      participants, ≥ 80% machine-verified, and an organizer report generated with zero manual
      intervention.
- [ ] An organizer who has never used pledge can create a cohort, invite participants, and
      export a report without support contact. Watched, not assumed.
- [ ] Calibration Rank leaderboard is public and opt-in per builder. Seasonal reset tested
      (Feb → May → Aug → Nov → repeat).
- [ ] Duel mechanics tested: two builders, comparable scope (±20% estimated days by AST
      features), same deadline, separate leaderboards for duels vs. individual rank.
- [ ] Rate limits hold under a cohort deadline spike — 200 participants probing in the final
      hour, without starving the daily background queue.

### Explicitly deferred out of v3

Private pledges · public API · MCP server · Go verifier · advanced cohort analytics.

---

## Cross-cutting: what must be true before public launch (v0.1)

Independent of phase. These gate *launch*, not development.

- [ ] **[Q-00](./open-questions.md) closed** — pre-launch personal/legal clearance (NOTES.local.md
      or equivalent) resolved in writing. This is the hard blocker.
- [ ] **[Q-01](./open-questions.md) decided** — private/public calibration denominator.
- [ ] **[Q-05](./open-questions.md) decided** — bad-faith probing of targets you don't own.
      Rate limits in place, domain verification gated on high-frequency probes.
- [ ] **[Q-06](./open-questions.md) decided** — evidence blob retention and takedown policy.
- [ ] **ADR-0010** (self-reported tier) **decided**. If accepted, self-reported outcomes are
      written as `status IN ('self_kept', 'self_missed')` and excluded from calibration fits
      (implementation in v0.1 or v2, not in v0.1 MVP if time-boxed).
- [ ] `robots.txt` compliance verified; opt-out at `pledge.sh/probe` documented.
- [ ] Key custody and rotation procedure for receipt signing keys documented.

---

## Sequencing risks

| Risk | Phase | Mitigation |
|---|---|---|
| Confidence field blocks calibration and badge | v0.1 | Ship it first; it is ~2 hours. |
| Scope Negotiator LLM integration slips | v0.1 | Move to v0.2 if it overruns; v0.1 launches without it. |
| Calibration fit has no data to fit | v2 | Population prior bootstrapped from synthetic corpus, labelled as synthetic in UI. Fit only after ~50 real commitments. |
| Censoring (abandoned commitments) breaks the fit | v2 | Censoring test (F-4) is a gate criterion, not a nice-to-have. |
| Sidecar failure cascades to the user | v2 | Stale-fit degradation with an ops alert, no user-facing error. |
| Cohorts need surfaces that don't exist yet | v3 | Cohort board reuses profile components. If they weren't built reusably in v0.1, v3 pays the tax. |
| Self-reported tier abuse (C-1 contradiction) | v0.1–v2 | Exclusion from calibration is non-negotiable (math: BS = 0 by construction). Visual marking required. Build-time check tightened. |
| LLM on the creation path (C-3 reversal) | v0.1 | Architecture.md §6.1 has the design; LLM output is parsed by @pledge/spec and content-addressed. Fails gracefully if LLM is down. |

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
