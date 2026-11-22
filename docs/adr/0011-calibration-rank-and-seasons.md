# ADR-0011: Calibration Rank as an absolute ladder, and seasons without a global leaderboard

**Status:** Proposed
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`product-overview.md` §8](../product-overview.md),
[`calibration.md` §7](../calibration.md) (display rule 7),
[`security.md`](../security.md) (T-05b),
[`open-questions.md`](../open-questions.md) (Q-02),
[`roadmap.md`](../roadmap.md) (phase v3),
[ADR-0007](./0007-ast-derived-features.md),
[ADR-0009](./0009-name-pledge-over-kept.md)

> **Proposed, not Accepted.** Two of the three components below are compatible with the existing
> exclusions and one is a genuine reversal. Do not ship the reversal and the compatible parts in
> the same release — that is how a reversal stops being visible.

## Context

[`product-overview.md` §8](../product-overview.md) excludes four things by name: money stakes at
launch, a leaderboard ranked by volume, streaks, and a shame wall. The new direction's §3 adds
Calibration Rank, quarterly seasons with a leaderboard, duels, covenants, and a reframed
graveyard. Most of that is compatible **in substance**, and it is worth separating carefully,
because a blanket "we reversed §8" would reverse things that were never in tension.

| New feature | §8 exclusion | Actually in tension? |
|---|---|---|
| Calibration Rank | "No leaderboard ranked by **volume**" | **No.** The exclusion is scoped to volume. Ranking on calibration accuracy is the opposite failure mode — 5 pledges at 80% shipping 4 outranks 50 pledged / 30 shipped |
| Quarterly seasons | "No streaks" | **No.** A streak punishes one bad week; a season resets a *scoreboard* on a fixed calendar and never touches the ledger. Different mechanism, opposite anxiety profile |
| Graveyard as archive with epitaph | "No shame wall" | **Partly.** A user's own dropped pledges on their own profile is not a wall. A *global* graveyard index is. The "up for adoption" flag turns the archive into a directory, which needs its own opt-in |
| Duels, covenants | — | Not excluded. Cohort boards are already the v3 shape ([`roadmap.md`](../roadmap.md)) |
| **Seasonal leaderboard** | "No leaderboard…", and [`calibration.md` §7](../calibration.md) rule 7 | **Yes. This is the real reversal.** |

Display rule 7 is unambiguous: *"Never render calibration as a rank or a percentile against other
users. That converts an instrument into a leaderboard, which the product explicitly refuses."*
That rule is in a section headed "Non-negotiable, because presentation is where a correct model
becomes a dishonest product". Any rank feature contradicts it, and it must be reversed explicitly
rather than edited away.

There is an honest narrowing available, and it is the substance of this ADR: **an absolute gated
ladder is not a percentile.** Drafter → Shipper → Calibrated → Oracle with fixed thresholds means
every user on the platform could be Oracle simultaneously. Nobody's tier moves because someone
else shipped. A percentile — "top 5% this season" — is zero-sum by construction, and is the thing
rule 7 was actually written against. The ladder can be defended; the seasonal leaderboard cannot,
on the current text.

**The new direction overclaims on gameability, and the calibration research says where.** Proper
scoring rules do make honest reporting individually optimal — but only *conditional on the
question set*. The builder chooses the question set. Sandbagging within a fixed set yields tiny
gains and overpromising tanks the score, both true; but twenty pledges of "push a commit this
week, 95% confident" produce a flawless calibration record and a top rank. This is
[`security.md`](../security.md) **T-05b**, trivial commitment padding, which is currently ranked
under a Fatal threat and mitigated only by display conventions. Attaching a public *rank* to the
score promotes T-05b from a display problem to the primary attack on the product's headline
number.

The mitigation the research identifies is already half-built. The duration model predicts the
binary event: `q̂^pop = Φ(−(mu_pop + βᵀx)/sigma_pop)` is what a *typical* builder's history implies
for this spec, computed from AST-derived features only ([ADR-0007](./0007-ast-derived-features.md)
— features come from the spec AST, never from user-supplied tags or difficulty labels, which is
exactly what makes them unspoofable here). A pledge whose `q̂^pop` is near 1 is trivial by
construction and contributes near-nothing to rank. This is a difficulty weight, it needs no new
statistics, and it is the reason the duration axis and the self-calibration axis must be fitted in
one pipeline rather than side by side.

Vocabulary, before it becomes ambiguous in half the variable names: **self-calibration** is the
builder's stated `p` against outcome. **Forecast calibration** is our model's prediction against
outcome ([`calibration.md` §8](../calibration.md)). Rank is built on the first.

## Decision

*(Proposed.)* Three parts, decided separately because they are not equally defensible.

1. **Calibration Rank ships as an absolute gated ladder.** Drafter → Shipper → Calibrated →
   Oracle, gated on fixed thresholds over the shrunken recalibration parameters (`a_i` near 0,
   `b_i` near 1) and a minimum `n_effective`. No percentile, no "top N%", no ordering against
   other users, no scarcity in the top tier. Contributions are weighted by difficulty via
   `q̂^pop`; a pledge the population model says is ~certain contributes ~nothing. Self-reported
   outcomes ([ADR-0010](./0010-self-reported-verification-tier.md)) contribute nothing at all.
2. **Seasons ship as a scoreboard reset, without a global leaderboard.** A season shows *your*
   seasonal record against *your* prior seasons and against the population distribution as an
   unnamed histogram with your position marked. Cohort- and covenant-scoped boards are permitted
   because they are opt-in, time-boxed, and small — that is the v3 cohort board, already planned.
   A platform-wide ranked list is **not** part of this decision and requires a further ADR.
3. **The graveyard is per-profile only.** Dropped pledges appear on the owner's profile with an
   optional epitaph. There is no global index, and "up for adoption" is a separate opt-in flag
   that publishes to a directory the owner explicitly chooses to enter.

[`calibration.md` §7](../calibration.md) rule 7 is amended, not deleted, to: *never render
calibration as a percentile or an ordering against other users; an absolute gated tier with
published thresholds is permitted.* Rules 1–6 stand unchanged, and rule 1 in particular — never a
single context-free number — means the tier is always rendered with `n` and the difficulty-weighted
denominator beside it.

## Alternatives considered

| Option | Why not |
|---|---|
| **No rank at all.** Keep rule 7 intact | The safest option and the current one. It keeps the product an instrument, which is [`product-overview.md` §4](../product-overview.md)'s explicit framing ("converts a nag into an instrument"), and it removes the T-05b escalation entirely. Rejected because the category evidence cuts the other way: craked.dev ships verified-shipping ranks today and Manifold gives every user a public calibration letter grade, so the ranked-identity surface exists whether pledge has one or not. A ladder is also a legible reason to return, which a pure instrument is not |
| **Percentile leaderboard, seasonal, as the new direction specifies** | The strongest growth mechanic in the set and the one most likely to produce shares. Rejected on rule 7's own argument plus a specific one: a zero-sum board makes it individually rational to pledge only what you are sure of, which suppresses exactly the risky pledges the calibration curve needs. It is also the surface where T-05b converts directly into standing |
| **Rank on keep rate** | The number users expect and the easiest to explain. Rejected: keep rate is a function of what you chose to attempt, so it ranks builders on how conservative their pledges were. It is also the number a padding attack moves most cheaply |
| **Rank on slip (`mu_i`)** | Rejected on four grounds, in descending strength. Slip is not scope-invariant, so ranking on it ranks builders on speed. Slip is already the coaching output that drives the suggested deadline, and Goodharting a diagnostic destroys it — the optimal play becomes padding every deadline, which zeroes the value of the deadline field. Proper-scoring-rule honesty has no analogue on the slip axis. And slip is more heavily censored ([`calibration.md` §4](../calibration.md)) than the binary axis, so it is the less defensible thing to attach a public tier to |
| **Rank, but hide the thresholds** so they cannot be optimised against | Rejected outright. An unpublished threshold on a credential product is the same shape as an unpublished done-spec, and [`../../CLAUDE.md`](../../CLAUDE.md)'s copy rule already forbids a badge whose criterion is not inspectable |

## Consequences

**Good:**
- The ladder gives the calibration model a user-legible output. Today `a_i` and `b_i` are a
  reliability curve; "Calibrated" is a thing a person can want.
- Difficulty weighting via `q̂^pop` is the first *mechanical* mitigation for T-05b. Every existing
  mitigation in [`security.md`](../security.md) is a display convention that depends on the reader
  paying attention.
- Absolute thresholds mean no scarcity, so the ladder cannot be laddered against — there is no
  incentive to suppress anyone else's record, and no reason for the top tier to become political.
- Seasons end the "my whole history is one number that only moves slowly" problem without a
  streak's fragility, and the ledger is untouched by the reset.

**Bad:**
- **A public tier makes T-05b the primary attack on the product**, and the difficulty weight is a
  mitigation, not a fix. `q̂^pop` is fitted from AST features, so it can only see what the AST
  encodes; two specs with identical ASTs and wildly different real difficulty score identically.
  [Q-02](../open-questions.md) — can a machine-checkable spec distinguish effort from output — is
  the unresolved question underneath this, and it stays unresolved. The rank ships on top of an
  open question.
- **The ladder pulls against [ADR-0009](./0009-name-pledge-over-kept.md).** A tier is a status you
  hold going forward; the ADR-0009 guard is that every surface leads with the record, not the
  promise. A rank badge above a ledger is the promise-shaped element winning the top of the page,
  and that is the ADR most likely to be quietly forgotten. If rank ships, the profile layout needs
  an explicit review against it.
- **Seasons are a timezone problem.** A quarter boundary is a deadline that applies to every user
  at once, and I-9 says deadline arithmetic is tested against `Asia/Kolkata`. A season closing at
  a UTC instant puts a builder in IST on a different calendar day from a builder in UTC-8, and the
  pledge that resolves inside that gap lands in the wrong season. The season boundary needs the
  same test treatment as a deadline: 23:30 and 00:15 IST, both directions across a UTC date
  boundary.
- **Duels have no verifiable notion of comparable scope.** "Two builders, comparable scope, same
  deadline" is unfalsifiable — the same problem as T-04, but now with an opponent who has an
  incentive to under-scope. Duels should not ship until the difficulty weight has been validated
  against real data, because `q̂^pop` is the only candidate definition of "comparable" the system
  has.
- The ladder needs a demotion rule, and demotion is the mechanic most likely to reproduce streak
  anxiety under a different name. Nothing in this ADR resolves what happens when an Oracle's
  `b_i` drifts below the Calibrated threshold mid-season.
- Rank cannot render before `n_effective` clears the confidence tiering in
  [`calibration.md` §7](../calibration.md) rule 6, so most users will see "unranked" for months.
  A cold-start ladder is a wall, not a hook.

**Neutral:**
- Covenants are the cohort board with a different name and a different buyer. Whether that is a
  gamification feature or the paid unit is [ADR-0013](./0013-individual-pro-over-organizer-gtm.md),
  not this one.
- Nothing here changes the ledger, the probe path, or the receipt. Rank is a derived view over
  `calibration_fit` and can be removed without a migration.

## Revisit when

- **The median `q̂^pop` of newly-created pledges rises by more than 0.10 in any quarter after rank
  ships** → the ladder is pulling the corpus toward trivial pledges. Response: raise the
  difficulty floor for rank eligibility, and if that does not move it within one further quarter,
  withdraw the ladder.
- **A platform-wide ranked list is proposed** → it is not covered by this ADR. Write a new one and
  re-argue rule 7 from the top; the argument in Context does not extend to it.
- **The forecast-calibration check in [`calibration.md` §8](../calibration.md) shows our own
  forecasts are miscalibrated** → the difficulty weight is derived from the same fit, so the rank
  is wrong in the same direction. Suspend rank display until the reliability diagram is clean.
  A product about calibration shipping a miscalibrated rank is the worst available headline.
- **Duels are proposed for build** → gate on `q̂^pop` having been validated against ≥200 real
  resolutions. Without that there is no definition of comparable scope and the feature is a
  handshake agreement with a scoreboard attached.
- **Any user asks what their rank is relative to others**, repeatedly and unprompted → the ladder
  is being read as a leaderboard regardless of its mechanics, and the reversal was larger in
  practice than it is on paper.
