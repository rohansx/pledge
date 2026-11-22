# pledge — Product Overview

**One-liner:** A verifiable shipping ledger for builders. Say what you'll ship, when. We verify it with receipts, not selfies. Your track record becomes your credential.

**Status:** v0 & v1 built (locally); v0.2 → v0.3+ design phase  
**Author:** Rohan Sharma (rohansx)  
**Date:** August 2026  
**Companion docs:** [`technical-spec.md`](./technical-spec.md), [`architecture.md`](./architecture.md), [`calibration.md`](./calibration.md)

---

## What changed from v0.2 and why

The original pledge (v0.2) focused on a single positioning: an immutable, hash-chained shipping record aimed at *evaluators*—accelerators, fellowship reviewers, hiring managers. It was built to answer one question: *Did this person really ship that, or are they asserting it?* The answer came with cryptographic proof.

The pivot to v0.3 recognizes four changes:

1. **Verification is now tiered.** v0.2 rejected self-reported outcomes entirely ("No self-reported 'I shipped' button. Ever."). Competitors like Beeminder already do machine-verified shipping against deadlines with a stake, live, today. The new model preserves machine verification as the gold tier, but adds peer attestation and a visibly-weaker self-reported tier. This reversal is argued in [ADR-0010](./adr/0010-self-reported-verification-tier.md) (Proposed).

2. **Gamification now includes a leaderboard.** v0.2 explicitly rejected "No leaderboard ranked by volume". The new model adds Calibration Rank (ranked on accuracy, not volume) and quarterly seasons. This reversal is argued in [ADR-0011](./adr/0011-calibration-rank-and-seasons.md) (Proposed).

3. **An LLM now sits in the pledge-creation request path.** v0.2 had no LLM anywhere; ADR-0004 locked Python to nightly. The new Scope Negotiator interviews you at pledge time and converts a fuzzy intention into a checkable contract. This reversal is argued in [ADR-0012](./adr/0012-llm-in-the-pledge-creation-path.md) (Proposed).

4. **The primary paid unit is now the individual builder, not the organizer.** v0.2 called this "the single most important go-to-market decision", reasoning that individuals churn but communities recur. The pivot inverts it: Pro subscriptions for individual builders are primary; team covenants become a gamification feature. This reversal is argued in [ADR-0013](./adr/0013-individual-pro-over-organizer-gtm.md) (Proposed).

All four ADRs record the prior position honestly and argue the tradeoff. This section exists so you know the product did not drift—it pivoted, deliberately.

What survives: the done-spec DSL (now the Scope Negotiator's output), the append-only ledger, evidence bundles, receipts, peer attestation (the existing witness mechanism), SSRF hardening, the error-vs-fail distinction, amendments-not-edits, and the IST/timezone discipline.

---

## The problem

Builders make public commitments constantly ("v1 by Friday", "shipping next month") and there is no system of record for whether they kept them.

Existing tools fail in three ways:

- **Habit-stake apps** (Forfeit, StickK, Beeminder) verify through photos, GPS, surveillance, or external data integrations. The platform profits when you fail, creating a perverse incentive. They're built for gym habits.
- **Maker communities** (WIP, Makerlog) are public but self-reported. "Fixed typo" counts the same as "shipped v1". Daily streaks burn users out.
- **Prediction trackers** (Fatebook) nail calibration but are private, self-resolved, unverified, and disconnected from shipping artifacts.

Nobody has fused: *verified shipping + public ledger + calibration identity*.

**Note:** Beeminder (~50+ machine-verified integrations including GitHub commits and issues-closed) occupies part of this space today. Beeminder is built for recurring quantified goals; pledge is built for discrete shipping commitments and the builder identity that accrues across years of them. They solve different problems and can coexist.

---

## Core concepts

### The pledge

A pledge is a small, immutable, machine-checkable promise:

```
what:      Ship clipxd v1.0 — public repo release + landing page live
scope:     GitHub release tagged v1.0 on rohansx/clipxd + 
           landing page returning 200 at clipxd.dev
deadline:  Sept 15, 2026, 23:59 IST
confidence: 85%  (the builder's estimate)
visibility: public
stake:     reputation-only (v0.1)
```

Four properties make it different from a to-do:

1. **Done is defined before the work starts, in machine-checkable terms.** Not "ship v1" (vibes) but "a release tag exists + the URL returns 200" (a probe).
2. **The scope is immutable once published.** Its hash goes into the ledger. You cannot quietly redefine success after the fact.
3. **Verification is external.** A probe runs against GitHub, DNS, HTTP, a package registry, or a service API. Optionally named peers co-sign.
4. **The outcome is permanent.** Slips stay on the record. That is not punishment — it is what makes the kept ones credible.

### Verification: receipts, not honor system

Every pledge resolves into an evidence bundle with a visible verification tier:

| Tier | How |  Example |
|---|---|---|
| **Machine-verified** | Webhook + probe at deadline or on-demand. External state is directly observed. | GitHub release tag exists; HTTP check returns 200 |
| **Peer-attested** | N named builders co-sign via magic-link; no account required. Weaker by construction, visibly marked. | Three peers attest: "I saw it ship" |
| **Self-reported** | The committer marks it kept. Zero information — but it is recorded and labelled as such. See [ADR-0010](./adr/0010-self-reported-verification-tier.md) (Proposed). | Used only when external verification is impossible (e.g., a private deployment) |

The ledger shows the tier next to every outcome. North-star metric: **% of resolved pledges that are machine-verified** (not a vanity number; it measures our success at being hard to fake).

### The ledger

Append-only public record. Every pledge: kept, slipped (with slip duration recorded), or dropped. Nothing deletable after resolution; annotate, never erase. Embeddable badge, profile card, JSON API. The ledger is the product; it gets more valuable with age.

Amendments (moving a deadline) are recorded as separate ledger entries with a reason. Honest revision is allowed; silent revision is not.

### Calibration identity

Keep rate is a weak signal (it depends on what you chose to attempt). The platform computes a **personal calibration curve** instead:

```
rohansx · shipping calibration

on-time rate           74%   (26 of 35 resolved)
median slip ratio      1.3x
p90 slip ratio         2.6x
worst category         "integration with third-party API" (2.9x median)
best category          "CLI tool, solo, no external deps" (1.0x median)

self-calibration       well-calibrated (Brier score 0.16 vs 0.25 population)
difficulty-adjusted    comparable to the population on similarly-scoped work
```

Then the forward-looking feature — **the forecast**:

> You're committing to ship by **Sept 15** (11 days).  
> Your history on release-sized pledges says roughly a **38% chance** of on-time delivery.  
> Your calibrated 80% date is **Sept 22**.  
> Commit at 80%, move the date, or re-scope?

---

## The standout feature: calibration (two-axis model)

Calibration is the most technically interesting thing pledge does, and it is the reason builders come back. It is also the thing most likely to be misunderstood, so the model is documented in full in [`calibration.md`](./calibration.md).

**The two axes:**

1. **Duration axis** — *estimated vs. actual slip* — already in v0.2. Models your slip distribution (median, p90, category-specific). Powers the forecast. Feeds the difficulty-adjusted weighting that makes the rank ungameable.

2. **Self-calibration axis** — *confidence vs. outcome* — new in v0.3. For each pledge, you state a probability `p` ("I'm 85% confident"). The outcome is either observed TRUE (kept) or FALSE (missed/dropped). Across your history, a Bayesian hierarchical model estimates your reliability curve — when you say 85%, how often are you right? Produces a Brier score and reads as: "Overconfident in the large", "Extreme estimates are not earned", or "Perfectly calibrated."

The two axes are linked: the duration model already predicts the binary event, so the system computes:

| Quantity | Meaning |
|---|---|
| `p` vs outcome | **Self-calibration** — is your confidence in yourself justified? |
| `p` vs duration forecast | **Overconfidence gap** — scope negotiator coaching line |
| Duration forecast vs outcome | **Slip** — the original axis, unchanged |

**Calibration Rank** (§3.1 below) ranks on self-calibration, never on slip. It is ungameable: sandbagging (saying 40% for something you'd keep 100%) yields tiny gains; overpromising (saying 95% for something you'd miss 50%) tanks you fast.

**Known weakness, stated honestly:** The binary axis is less censored than the slip axis (you must resolve to contribute a datapoint, but no deadline-slip observations are dropped), which makes it the more defensible thing to attach a public tier to. **BUT** self-reported outcomes are zero-information (the committer chose both `p` and the outcome, so the pair is self-consistent by construction). Self-reported pledges must be excluded from the calibration fit entirely, not merely from rank and the north-star metric. This is mathematically stronger than a product argument and it is falsifiable. [ADR-0010](./adr/0010-self-reported-verification-tier.md) proposes how the tiered model can exist without destroying the guarantee.

---

## Secondary features

### Receipts

When a pledge resolves, pledge emits a **signed, self-verifying receipt** — a small JSON artifact containing the pledge, the done-spec hash, the probe evidence, timestamps, and (when anchored) a Sigstore/Rekor inclusion proof. Wire format: [`spec/receipt-format.md`](./spec/receipt-format.md).

Anyone can verify it *without trusting pledge*:

```
$ pledge verify receipt.json
ok  signature valid (ed25519)
ok  done-spec hash matches committed spec (unchanged since 2026-08-25)
ok  probe evidence: GitHub release v1.0 published 2026-09-14T18:42Z
    RESULT: kept, 1 day early
```

This is what makes pledge infrastructure rather than a website. A receipt can be dropped into a README badge, a fellowship application, an acquisition data room, or a CV, and verified by a third party who has never heard of pledge.

### Peer attestation

Witnesses need no account. At pledge creation you name 2–3 peers; they receive a magic-link, click it once to attest, and are done. No signup, no login. Witnesses are a social obligation, not a support burden — they receive exactly two emails: at commitment and at outcome.

This is the existing mechanism in v0.1, now surfaced as a verification tier rather than purely as a social signal.

---

## Distribution and identity

### Individual builders, not cohorts (primary)

Individuals churn, but a **public track record compounds**. The longer you use pledge, the more your profile is worth, and the higher the switching cost. You keep using it for the same reason you keep using GitHub — not because it motivates you, but because leaving means abandoning your history.

**Public profile** — `pledge.sh/rohansx` — is the product's front door and entire marketing engine. Calibration summary at the top, then a reverse-chronological ledger: claim, deadline, outcome, evidence link, verification badge. Misses shown, not hidden. Auto-generated OG image so every share renders as a card.

### Calibration Rank

**(See [ADR-0011](./adr/0011-calibration-rank-and-seasons.md), Proposed.)**

Rank builders on **self-calibration accuracy, never on volume**. Five tiers:

- **Drafter** — <10 resolved pledges or calibration confidence interval too wide to rank meaningfully
- **Shipper** — 10+ resolved, on-time rate >60%, self-calibrated within 0.2 (Brier score diff)
- **Calibrated** — 30+ resolved, on-time rate >50% (slip is allowed, accuracy is the gate), perfectly calibrated (Brier score within 0.05 of optimal)
- **Oracle** — 100+ resolved, Brier Skill Score in top tier (fixed threshold, no percentile ranking), consistent across scope categories
- **Emeritus** — retired, no new pledges in 90+ days (preserves historical rank, no longer competing)

Explicit anti-patterns excluded: no ranking by volume (encourages spam), no daily check-ins, no streak freezes, no platform-kept forfeits.

### Seasons, not streaks

**(See [ADR-0011](./adr/0011-calibration-rank-and-seasons.md), Proposed.)**

Quarterly cohorts with a leaderboard. Seasonal record resets; the ledger never does. Seasons end streak anxiety ("I missed one deadline, my entire history is ruined") while keeping the competitive element.

---

## Gamification

**(See [ADR-0011](./adr/0011-calibration-rank-and-seasons.md), Proposed.)**

Constraints: no daily streaks, no losing mechanics that profit the platform, nothing that rewards volume over accuracy. Everything rewards being right about yourself.

### Ship cards

When a pledge resolves, pledge auto-generates a shareable card:

```
🚀 Shipped clipxd v1.0
   scope: GitHub release + landing page live
   kept · 1 day early
   verified: GitHub webhook
   
   rohansx · on-time rate 74% · 35 total pledges
   
   [pledge.sh/rohansx/pledge/12345]
```

Cards are the growth loop: makers share them, followers see the link to the builder's profile.

### Evidence trophies

Visual distinction for machine-verified resolutions. Self-reported outcomes are never marked with a trophy — they are recorded, visible, and explicitly weaker.

### Slip honesty marks

If you amend a deadline *before* the original deadline passes and the amendment includes a reason ("API integration took longer than expected"), you earn an **"called it early"** mark. Rewards honesty about failure before the deadline hits.

### Duels

Two builders, comparable scope (pledge complexity weighted by AST features), same deadline, head-to-head. Both outcomes recorded, both visible. Low-stakes friendly competition.

### Covenants

A group of 3–8 pledging toward a shared date. Built for study pods, meetup cohorts, and "ship 12 things in 12 months" challenges. Shared board with per-member verified status.

### The graveyard, reframed

Dropped projects get a public archive page with an epitaph, not a wall of shame. Optional "up for adoption" flag so someone else can take it.

---

## AI-native layer

**(See [ADR-0012](./adr/0012-llm-in-the-pledge-creation-path.md), Proposed.)**

AI's job is contract negotiation and calibration, not nagging.

### Scope Negotiator (flagship)

At pledge creation an LLM interviews you and converts a fuzzy intention into a checkable contract.

User writes: *"ship v1 of clipxd by mid sept"*

LLM returns:

> GitHub release tagged `v1.0` on `rohansx/clipxd` + landing page returning 200 at `clipxd.dev`, both by **Sept 15 23:59 IST**.  
> Verification: GitHub release webhook + HTTP check.  
> Your history on release-sized pledges shows a **median 5-day slip**. To hit Sept 15 at your stated 85% confidence, move to **Sept 22**. Or keep Sept 15 at **60% confidence**?

The negotiated spec becomes the verification contract. The DSL lives in the commitment; the spec version pins the evaluator that will execute it.

### Calibration coach

Pre-pledge estimate correction from your own history: "On API-integration work you slip 3x; on CLI work you slip 1.1x."  
Post-resolution retros: "You said 85%, landed at 87% — you're well-calibrated. But your slip on third-party deps was 2.4x vs your estimate of 1.5x."

### Evidence adjudicator

When webhook evidence is ambiguous (release tagged but deploy failed, or a URL returns 200 but with an old cached build), the model reads the evidence bundle and proposes a resolution with reasoning attached to the ledger entry. Human appeal path on top.

### Agent-readable ledger

MCP server + JSON API so coding agents can read pledge histories and propose commitments on behalf of builders (with explicit consent).

---

## Who it's for

**Primary:** indie hackers and OSS builders who build in public. Ship velocity and public track record are currency.

**Secondary:** build-in-public pods, hackathons, meetup cohorts (covenants). Organizers love automated, credible post-event reports ("12 of 20 teams actually shipped a working artifact, verified by probe").

**Later:** hiring signal for technical recruiting, collaboration signal for open source, fellowship/accelerator screening.

Explicitly NOT for: habits, fitness, generic life goals (use Beeminder). Personal motivation (use a different tool).

---

## Monetization

**(See [ADR-0013](./adr/0013-individual-pro-over-organizer-gtm.md), Proposed.)**

| Tier | Who | What | Price |
|---|---|---|---|
| **Free** | Individual builders | Unlimited public pledges, public profile, calibration, receipts, ship cards | $0 |
| **Pro** | Serious individuals | Private pledges, custom domain profile, API access, deeper calibration breakdowns, advanced evidence tiers | ~$5/mo |
| **Covenant** | Groups / organizers | Shared board for 3–8, co-sign shortcuts, email digest for group outcomes | $15/mo or ~$100/season |
| **Org** | Teams / accelerators | SSO, private covenants, org-wide calibration view, data export, API quota bump | annual |

The free tier is the growth engine — every public profile is a landing page, every shared card is a backlink, every covenant brings dozens of new profiles at once.

Private pledges in Pro are gated: once a pledge is published (moved to a specific deadline), it is immutable and counts toward calibration. A user cannot commit privately and publish only the kept ones. (This is an unresolved problem in v0.2's spec and must be settled before Pro ships — see [open-questions.md](./open-questions.md).)

Money stakes, if ever introduced: escrow to charity or a named beneficiary, **never** the platform.

---

## MVP cut (v0.1)

Ship a tight loop fast:

1. Auth via GitHub; profile = ledger page
2. Create pledge: scope + deadline + confidence + GitHub verification + HTTP check
3. Auto-resolution via webhooks; evidence bundle stored and inspectable
4. Calibration basics: on-time rate, slip stats, simple calibration chart
5. Ship cards + README badge
6. Scope Negotiator (single LLM flow at pledge creation)

**Defer:** seasons, duels, covenants, graveyard, dual-axis calibration curves, money, MCP server, private pledges, API, org features.

**North-star metric:** % of resolved pledges that are machine-verified (not self-reported or peer-attested). This is the measure of how hard we are to fake and how much the system actually trusts the ledger.

---

## Known weaknesses

| Weakness | Mitigation |
|---|---|
| **Probes are gameable** (a placeholder page also returns 200) | Layer probes with witness co-sign; record response body hashes; require semantic checks; novelty check against commit-time snapshot ([security.md](./security.md) T-04) |
| **Binary axis is less censored than slip** (you must resolve to observe the outcome, but deadline-slip observations can be right-censored) | Self-reported outcomes are excluded from the calibration fit entirely. Machine-verified and peer-attested outcomes only. [ADR-0010](./adr/0010-self-reported-verification-tier.md) |
| **Calibration gamed with trivial commitments** | Show volume + raw commitment text alongside score; probe-complexity floor; never a single context-free number; difficulty-weighted rank |
| **Individual churn** | Credential framing over motivation framing; public track record as switching cost; seasons over streaks |
| **Nobody actually wants a public failure record** | Private-by-default pledges in Pro; owner chooses visibility, but cannot edit what's already public |
| **The evaluator side never materializes** | Receipts are useful standalone (README badge, application attachment) even with zero evaluator adoption |
| **Cold start on calibration** | Population prior via partial pooling; forecast usable from pledge #1 |
| **Self-selection** (the commit ritual selects for people who already ship) | Likely answer is passive derivation from existing planning artifacts ([open-questions.md](./open-questions.md) Q-04) |

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Probes are gameable (placeholder page, throwaway tag) | High | Webhook + semantic checks; novelty check; witness co-sign layer; response body hash stored |
| Calibration gamed with trivial work | High | Show volume + text; probe-complexity floor; difficulty weighting; never context-free |
| Vercel/Netlify deploy verification is hard | High | Account webhooks are Pro/Enterprise only on Vercel. Netlify is accessible to all. Fly has no deploy webhooks. Scope negotiator flags this at pledge time |
| Self-reported tier is abused | High | Excluded from calibration fit; never ranked; visibly marked as weaker |
| Individual churn (endemic to this category) | High | Credential not motivation; public ledger as switching cost; seasons; covenants as secondary unit |
| Content-hash stability (CDN edge, A/B, personalization) | High | Use `.text contains` + length floor as assertion; hash only as evidence. Mismatch is a substance observation (fail, not error) |
| Confidence elicitation bias (social, anchoring) | Medium | Scope Negotiator suggests calibrated date first; builder chooses confidence *after* seeing the suggestion |
| Timebase ambiguity at deadline boundary | Medium | Mandatory probe scheduled at deadline boundary; no ambiguity window wider than probe interval |
| "Merged PR closes issues" needs GraphQL | Medium | Worker has no GraphQL client. Would add one call shape, one new `github.pr().closes_issues` field, bumps spec_version |
| Cold start on a new builder | Medium | Population prior; forecast is usable at n=0 using population params |

---

## What pledge deliberately does not do

- **No motivation tech.** Not a nag, not a reminder, not a motivational quote. If you need to be reminded to ship, pledge is the wrong product.
- **No money stakes at launch.** Financial commitment devices self-select down to near-nothing; users who find stakes motivating stay, everyone else leaves fast. Stakes can be an optional v3 module. Not the product.
- **No daily check-ins.** Designed-in friction from daily login loops.
- **No streak freezes or skip days.** These are admissions that streaks are the wrong metric; calibration is strictly better.
- **No shame wall.** Misses are on your own profile as data, in context, next to your calibration curve. They are not aggregated into a public graveyard. (The graveyard is an opt-in epitaph for dropped projects.)
- **No leaderboard ranked by volume.** Ranking by commitment count rewards spam. Calibration Rank is ranked on accuracy. Seasons are time-boxed. (This is the reversal recorded in [ADR-0011](./adr/0011-calibration-rank-and-seasons.md).)
- **No platform-kept forfeits.** If a builder stakes money, it goes to charity or a named beneficiary, not to us. We do not profit when they fail.
- **No passive derivation at launch.** v0.1 requires explicit pledge creation. ([Q-04](./open-questions.md) proposes deriving from calendar, issues, or planning tools; v0.2+.)

---

## Open problems

These are the things most likely to sink the product. See [`open-questions.md`](./open-questions.md) for details.

- **Q-00:** Prior-inventions disclosure (hard blocker; gates public launch, not development).
- **Q-01:** Private pledges can't count toward calibration without laundering the score.
- **Q-02:** Effort-vs-output gap — every probe is satisfiable by something smaller than promised. Novelty checks and semantic templates raise the cost of faking; they don't close the gap.
- **Q-03:** Evaluator-side adoption — cryptographic verifiability answers "did pledge fabricate this", which nobody is currently asking.
- **Q-04:** Commit-ritual friction — writing a done-spec before starting work self-selects for people who already ship.
- **Q-05:** Bad-faith probing — a builder creates pledges on targets they don't control to farm calibration.
- **Q-06:** Evidence retention — how long to keep webhook bodies, probe logs, intermediate states.

---

## Decisions already made

Do not "improve" these without a new ADR. **New pivots are in ADR-0010..0013 (Proposed); do not assume they are settled.**

| ADR | Decision |
|---|---|
| [0001](./adr/0001-typescript-over-rust.md) | TypeScript end to end |
| [0002](./adr/0002-postgres-for-queue.md) | pg-boss on the same Postgres |
| [0003](./adr/0003-global-chain-lock.md) | One global advisory lock serialises chain appends |
| [0004](./adr/0004-python-sidecar-for-calibration.md) | Python exists only for the nightly fit; no request path calls it |
| [0006](./adr/0006-accountless-witnesses.md) | Witnesses need no account |
| [0007](./adr/0007-ast-derived-features.md) | Calibration features derived from spec AST, never from user tags |
| [0009](./adr/0009-name-pledge-over-kept.md) | Name is forward-looking; product is backward-looking |
| **[0010](./adr/0010-self-reported-verification-tier.md)** | **Proposed:** self-reported tier, excluded from fit |
| **[0011](./adr/0011-calibration-rank-and-seasons.md)** | **Proposed:** calibration rank, seasonal leaderboard |
| **[0012](./adr/0012-llm-in-the-pledge-creation-path.md)** | **Proposed:** Scope Negotiator LLM at creation time |
| **[0013](./adr/0013-individual-pro-over-organizer-gtm.md)** | **Proposed:** individual builders primary, not organizers |

[ADR-0005](./adr/0005-defer-rekor-anchoring.md) (defer Rekor anchoring) and
[ADR-0008](./adr/0008-calibration-over-all-visibilities.md) (calibrate over all
visibilities) remain **Proposed, not accepted**. Do not assume either outcome.
