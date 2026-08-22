# pledge — Product Overview

**One line:** A verifiable record of what you said you'd ship and whether you shipped it.

**Status:** Concept / pre-build
**Author:** Rohan Sharma (rohansx)
**Date:** August 2026
**Companion doc:** [`technical-spec.md`](./technical-spec.md)

> **Naming note:** this document was originally written under the working name *kept*. The
> project is now **pledge** (`pledge.sh`). Product substance is unchanged. See
> [ADR-0009](./adr/0009-name-pledge-over-kept.md) for the rename and the positioning guard
> that comes with it.

---

## 1. The problem

Shipping claims have become unfalsifiable.

In the AI-tooling era, "I shipped a product this weekend" costs nothing to say and almost
nothing to fake. A screenshot, a landing page, a repo with three commits and a README written
by a model — all of it looks identical to real execution from the outside.

This creates two distinct pains:

**For builders:** you actually do ship, fast and repeatedly, and you have no artifact that
proves it. Every fellowship application, every VC intro, every hiring conversation is you
asserting "I execute quickly" with nothing behind the claim but a GitHub graph that measures
commits, not outcomes.

**For evaluators:** accelerators, fellowship reviewers, hackathon organizers, and hiring
managers screen on execution speed and follow-through, and currently have no primitive for
it. They fall back on proxies — Twitter follower counts, HN front-page hits, self-reported
timelines.

The existing accountability category doesn't solve this. StickK-lineage tools rely on an
honor-system referee, so weeks can pass between quietly giving up and any consequence
landing. ShipChain-style tools are literally a self-reported "I shipped today" button.
Beeminder survives precisely because it has a data layer — it pulls from 40+ external
services rather than trusting the user — but it's built for quantified habits, not discrete
shipping commitments, and it's aimed at motivation rather than credential.

**The gap:** nobody is building the *record*. Everyone is building the *nag*.

---

## 2. The reframe

pledge is not an accountability app. It is a **credential system for execution.**

The distinction matters enormously for retention. A motivation tool loses value the moment
motivation dips — which is exactly when users churn, and why this category is a graveyard. A
track record *compounds*: the longer you use it, the more your profile is worth, and the
higher the switching cost. You keep using pledge for the same reason you keep using GitHub —
not because it motivates you, but because leaving means abandoning your history.

Positioning line: **GitHub's green squares measure activity. pledge measures follow-through.**

---

## 3. Core object: the commitment

A commitment is a small, immutable, machine-checkable promise:

```
target:    github.com/rohansx/tethr
claim:     "v0.2 released with Kaggle T4 autoscaling"
done when: a GitHub release tagged v0.2.* exists on this repo
deadline:  2026-09-05T23:59+05:30
witnesses: @naman, @chris
stake:     none
```

Four properties make it different from a to-do:

1. **Done is defined before the work starts, in machine-checkable terms.** Not "ship tethr
   v0.2" (vibes) but "a release tag matching `v0.2.*` exists" (a probe).
2. **The definition of done is immutable once committed.** Its hash goes into the ledger. You
   cannot quietly redefine success after the fact — the single most common failure mode of
   self-reported shipping.
3. **Verification is external.** A probe runs against GitHub, DNS, HTTP, a package registry,
   or an app store. Optionally a named human co-signs.
4. **The outcome is permanent.** Misses stay on the record. That is not punishment — it is
   what makes the kept ones credible. A profile with a 100% hit rate and no history of misses
   reads as either trivial commitments or a deleted log.

---

## 4. The standout feature: calibration

*(Statistical design lives in [`calibration.md`](./calibration.md).)*

Most tools score you on a streak — a binary, brittle number that punishes a single bad week
and gives you nothing to learn from.

pledge scores you on **calibration**: how accurate your estimates are, not just whether you
hit them.

Every resolved commitment produces one datapoint: *estimated duration vs. actual duration.*
Across a history, pledge computes a personal slip distribution and surfaces:

```
rohansx · shipping calibration

  on-time rate         74%   (26 of 35)
  median slip ratio    1.3x
  p90 slip ratio       2.6x
  worst category       "integration with third-party API" (2.9x median)
  best category        "CLI tool, solo, no external deps" (1.0x median)

  You are well-calibrated on solo Rust work and
  optimistic by ~3x on anything requiring someone else's API.
```

Then the feature that makes it a tool rather than a scoreboard — **the forecast**:

> You're committing to ship this by **Sept 5** (11 days).
> Based on 35 prior commitments, that's roughly a **38% chance** of landing on time.
> Your calibrated 80% date is **Sept 18**.
> Commit anyway, or move the date?

### Why this is the right feature

**It inverts the shame dynamic that kills this category.** In every existing accountability
tool, a miss is a failure — it breaks your streak, it costs you money, it goes on the wall of
shame. Users churn to escape the shame. In pledge, *a miss is a datapoint*. You literally
cannot have a calibration curve without misses. The product gets more valuable the more
honest you are about failing, which is an unusual and very durable incentive alignment.

**It converts a nag into an instrument.** Nobody needs another thing telling them to work
harder. Every technical person alive wants to know their real velocity, and none of them
know it. Calibration is the first honest answer to "how long does this actually take me?"

**It's the thing an evaluator actually wants.** "This person hits 74% of self-set deadlines
and slips a median of 1.3x" is a far more useful signal than a streak count, and it is not
something a candidate can assert about themselves credibly.

**It's technically interesting and hard to clone.** Naive implementations will average slip
ratios and produce garbage on small samples. Doing it well means a hierarchical Bayesian
model with partial pooling toward a population prior, so a user with three commitments gets a
sane forecast that sharpens as data accumulates. That's a real moat over a weekend clone.

**It generates a data flywheel.** Aggregate, anonymized calibration data across thousands of
commitments is a publishable asset nobody else has: *"Hackathon participants slip 2.4x on
'integrate payments'. Solo CLI tools are the only category builders estimate accurately."*
That's a content engine and a recurring reason for press.

**Known weakness, stated honestly:** calibration is gameable by committing to trivial work
with generous deadlines. Mitigations: display commitment volume and the raw commitment text
next to the score so a reader can judge scope; require probe complexity above a floor for a
commitment to count toward calibration; let witnesses flag scope; never show calibration as a
single context-free number. The unresolved part is [Q-02](./open-questions.md).

---

## 5. Secondary feature: the portable receipt

When a commitment resolves, pledge emits a **signed, self-verifying receipt** — a small JSON
artifact containing the commitment, the done-spec hash, the probe evidence, timestamps, and —
when the entry has been anchored — a Sigstore/Rekor inclusion proof. Wire format:
[`spec/receipt-format.md`](./spec/receipt-format.md). An unanchored receipt is a defined state
(`anchor_pending`), and whether anchoring ships at all is open
([ADR-0005](./adr/0005-defer-rekor-anchoring.md), Proposed). Without it, "verify without
trusting pledge" narrows to "verify the signature pledge applied" — a materially weaker claim.

Anyone can verify it *without trusting pledge*:

```
$ pledge verify receipt.json
ok  signature valid (ed25519, key logged to Rekor 2026-09-04T14:22Z)
ok  inclusion proof valid against Rekor log index 84713221
ok  done-spec hash matches committed spec (unchanged since 2026-08-25)
ok  probe evidence: HTTP 200, body sha256 4f2a..., observed 2026-09-04T14:21Z
    RESULT: kept, 1 day early
```

This is what makes pledge infrastructure rather than a website. A receipt can be dropped into
a fellowship application, a README badge, an acquisition data room, or a directory listing,
and verified by a third party who has never heard of pledge. It also means other platforms —
hackathon organizers, launch directories, accelerator portals — can consume pledge
attestations instead of competing with them.

This layer is a direct reuse of the hash-chained-evidence-ledger pattern already proven in
CloakPipe.

---

## 6. Distribution: cohorts

Individuals churn. Communities recur. This is the single most important go-to-market decision
in the document.

pledge's paid unit is not the individual builder — it's the **organizer**. Anyone running a
time-boxed building event spins up a cohort:

- hackathons (a shared deadline is the entire premise of the format)
- accelerator and fellowship cohorts
- build-in-public sprints and "ship 12 things in 12 months" challenges
- internal engineering teams running a delivery quarter
- university project cohorts

A cohort gets a shared board, a common deadline, per-participant verified outcomes, and — the
part organizers actually want — an **automatic, credible post-event report**: how many of N
teams actually shipped a working artifact, verified by probe rather than by demo-day theatre.
Right now every hackathon organizer reports "80 projects submitted" with no idea how many
were real.

Seasonal cohorts mean demand renews itself rather than decaying, which is the structural fix
for this category's churn problem.

**Pilot:** Mumbai FOSS / Claude Code meetup ship challenge. Dogfood first: the first public
commitment on pledge should be the commitment to ship pledge.

---

## 7. What the platform looks like

**Public profile — `pledge.sh/rohansx`** *(the product's front door and its entire marketing
engine)*
Calibration summary at the top, then a reverse-chronological ledger of commitments: claim,
deadline, outcome, evidence link, verification badge. Misses shown, not hidden.
Auto-generated OG image so every share renders as a card.

**Commitment composer**
Plain-language claim → pick a done-spec template (repo release, URL live, package published,
app store listing, PR merged) → set deadline → the forecast appears inline and challenges the
date → add witnesses → commit. Under 60 seconds.

**Live commitment page**
Countdown, current probe status, progress signals from linked repos, witness list, amendment
history if any.

**Amendments, not edits**
You can move a deadline, but the move is recorded as an amendment with a reason and a
timestamp. Nothing is deleted. The slip is visible. Honest revision is allowed; silent
revision is not.

**Cohort board**
Grid of participants, shared deadline, live verified status, organizer's post-event report
export.

**Verifier CLI + open receipt format**
Open source. This is what makes the claim "verifiable" true rather than marketing.

**Notifications**
Email + Telegram/WhatsApp. Ping at commit, T-72h, T-12h, and outcome. Witnesses pinged at
commit and outcome only — they are a social obligation, not a support burden.

---

## 8. What pledge deliberately does not do

- **No money stakes at launch.** Financial commitment devices self-select the audience down
  to near-nothing; users who find stakes motivating stay, everyone else leaves fast. Stakes
  can be an optional v3 module. They are not the product.
- **No leaderboard ranked by volume.** Ranking by commitment count rewards spam. Cohort
  boards are scoped and time-boxed; there is no global ranking.
- **No streaks.** A streak is a brittle binary that punishes one bad week and teaches
  nothing. Calibration is strictly better.
- **No shame wall.** Misses are on your own profile as data, in context, next to your
  calibration curve. They are not aggregated into a public graveyard.
- **No self-reported "I shipped" button.** Ever. It is the exact thing that makes every
  competitor worthless.

---

## 9. Business model

| Tier | Who | Price | What |
|---|---|---|---|
| Free | Individual builders | ₹0 | Unlimited commitments, public profile, calibration, receipts, badge |
| Pro | Serious individuals | ~$5/mo | Private commitments, custom domain profile, API access, deeper calibration breakdowns |
| Cohort | Event organizers | ~$50–200/event | Cohort board, branded page, participant management, verified post-event report |
| Org | Teams / accelerators | annual | SSO, private cohorts, portfolio calibration view, data export |

The free tier is the growth engine — every public profile is a landing page, every shared
receipt is a backlink, every cohort brings dozens of new profiles at once.

> **Unresolved:** Pro's private commitments, as currently specified, let a user commit
> privately and publish only the kept ones — which launders the calibration score. See
> [Q-01](./open-questions.md). Must be settled before Pro ships.

---

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Probes are gameable (a placeholder page also returns 200) | High | Layer probes with witness co-sign; record response body hashes; require semantic checks; novelty check against commit-time snapshot ([security.md](./security.md) T-04) |
| Calibration gamed with trivial commitments | High | Show volume + raw commitment text alongside score; probe-complexity floor; never a single context-free number |
| Individual churn (the category's endemic problem) | High | Cohorts as the primary unit; credential framing over motivation framing |
| Nobody actually wants a public failure record | Medium | Private-by-default commitments in Pro; owner chooses what's public, but cannot edit what's already public |
| The evaluator side never materializes | High | Receipts are useful standalone (README badge, application attachment) even with zero evaluator adoption. [Q-03](./open-questions.md) |
| Cold start on calibration | Medium | Population prior via partial pooling; forecast usable from commitment #1 |
| The commit ritual self-selects for people who already ship | High | [Q-04](./open-questions.md) — passive derivation from existing planning artifacts |

---

## 11. Build order

Phases with exit criteria: [`roadmap.md`](./roadmap.md).

- **v0** — commitment object + HTTP/GitHub probe + public profile + email notifications.
  Dogfood with one real commitment.
- **v1** — done-spec DSL with templates, witnesses, amendments, hash-chained ledger, OG cards.
- **v2** — calibration engine + forecast, signed receipts, verifier CLI. Rekor anchoring is
  scheduled here but **not settled**: [ADR-0005](./adr/0005-defer-rekor-anchoring.md) proposes
  gating it behind a trigger and is Proposed, not accepted.
- **v3** — cohorts, organizer reports, badges, public API.

**Open note:** a pre-launch personal/legal clearance remains unresolved and should be closed
before this or any other side project is publicly launched under your name. Tracked as
[Q-00](./open-questions.md), with details in the untracked `NOTES.local.md` — it blocks public
launch, not development.
