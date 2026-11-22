# ADR-0013: Individual Pro first, organiser second — a sequencing decision, not a replacement

**Status:** Proposed
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`product-overview.md` §6](../product-overview.md),
[`product-overview.md` §9](../product-overview.md),
[`product-overview.md` §10](../product-overview.md) (individual churn, ranked High),
[`roadmap.md`](../roadmap.md) (phase v3),
[`open-questions.md`](../open-questions.md) (Q-03, Q-04),
[ADR-0008](./0008-calibration-over-all-visibilities.md),
[ADR-0011](./0011-calibration-rank-and-seasons.md)

> **Proposed, not Accepted.** It reverses the document's own self-declared most important
> decision, and the evidence is split.

## Context

[`product-overview.md` §6](../product-overview.md) opens: *"Individuals churn. Communities recur.
This is the single most important go-to-market decision in the document."* The paid unit is the
organiser; cohorts renew seasonally; the risk table ranks individual churn **High** and names
cohorts as its mitigation. The new direction's §6 inverts this — Pro subscriptions for individual
builders are primary, and cohorts reappear as *covenants*, listed under gamification.

**The churn argument is not just plausible, it now has a body count.** Every product in this
category that was individual-first is dead or gone:

| Product | Model | Status |
|---|---|---|
| Makerlog | Individual, self-reported, ~8k members | Dead. Both domains 301 to the founder's blog; org has zero public repos |
| Polywork | Individual "proof of work" timeline | Shut down, announced ~Jan 2025 |
| read.cv | Individual professional profile | Acquired by Perplexity, wound down; read-only Jan 2025, exports closed May 2025 |
| BuildInPublicLog | Individual, auto-tracked GitHub, streaks + leaderboard | Dead. Vercel `DEPLOYMENT_NOT_FOUND`, TLS expired Aug 2026 |
| WIP | Individual, ~$199/yr, self-reported, streaks | Alive, ~3,759 makers, reviewed in Jan 2026 as *"overpriced and underwhelming"* |
| Beeminder | Individual, but the paid unit is the **stake**, not the subscription | Alive, shipping integrations in 2026 |

That is a stronger version of §6's argument than §6 itself made, and it is newly available
evidence. The individual builder profile is a category with a graveyard in it. Note the one
survivor's shape: Beeminder monetises through pledges paid, not through a profile subscription —
*"you pay for Beeminder primarily through the pledges you pay"* — which is the model
[ADR-0014](./0014-charity-escrow-for-stakes.md) forecloses on principle.

**Against that, three facts about who is building this.**

The dominating constraint is nights-and-weekends build time, and it applies to *selling* as much
as to shipping. An organiser deal is a conversation, a scoping call, a branded page, participant
management, and a post-event report — a sales motion with a human in it, per event, repeated. Pro
is a Stripe checkout that runs while asleep. §6 chose the unit with better retention; it did not
weigh which unit a solo operator can actually transact.

The organiser product is also **further away**. The cohort board, participant management, and the
organiser report are phase v3 in [`roadmap.md`](../roadmap.md); Pro is a flag on an existing table
plus feature gates. Choosing the organiser as the paid unit means the first revenue is behind two
more phases.

And the flagship Pro feature is contested by our own docs.
[ADR-0008](./0008-calibration-over-all-visibilities.md) (Proposed) would make "private commitments"
mean private *details* with the outcome still in the denominator — a materially weaker pitch than
[`product-overview.md` §9](../product-overview.md) currently sells, and one requiring explanation
at the moment of purchase. If Pro is to be primary, its hook cannot be the feature that ADR-0008
may hollow out.

**The two are not exclusive, and the honest question is sequencing.** Covenants keep the cohort
motion alive as a product surface, which means the organiser bet is not abandoned by choosing Pro
first — it is deferred with its groundwork continuing. What a covenant does *not* include is the
thing organisers actually pay for: the credible post-event report. A group board with a shared
deadline is a feature; "of 80 submitted projects, 31 shipped a verified artefact" is a purchase
order.

## Decision

*(Proposed.)* Sequencing, with both bets live.

1. **Individual Pro is the first paid unit**, priced ~$5–9/mo. Its hook is **advanced calibration
   analytics and custom verification webhooks**, not private commitments — because the private-
   commitment pitch depends on [ADR-0008](./0008-calibration-over-all-visibilities.md) landing a
   particular way, and a paid tier must not be hostage to an open ADR.
2. **Covenants ship as a free feature** in the phase that would have carried cohorts. They are the
   cohort motion's product groundwork and its demand test, at zero sales cost.
3. **The organiser tier is not cancelled. It is gated on a demand signal** rather than built
   speculatively: the post-event report is the paid artefact, and it is built when an organiser
   asks for it, not before.
4. **[`product-overview.md` §6](../product-overview.md)'s sentence is amended, not deleted.** The
   claim that individuals churn and communities recur stands — the graveyard above supports it.
   What changes is which one is monetised *first*, and the amended text must say that the churn
   risk is now carried rather than mitigated.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep the organiser as the paid unit** (current §6) | The better long-run business, on evidence this ADR does not dispute: seasonal renewal is a structural fix for churn, and one hackathon brings dozens of profiles at once, which is a distribution mechanism Pro has no analogue of. Rejected on sequencing only — it is a per-deal sales motion at nights-and-weekends capacity, and it is two roadmap phases away. If a single organiser signs unsolicited before Pro ships, this alternative wins outright and the ADR should be rejected |
| **Both at once** | Rejected as capacity fiction. Two pricing pages, two support surfaces, two onboarding flows, and two churn models before the product has one paying user |
| **Neither. Stay free and defer monetisation entirely** | Defensible: [Q-03](../open-questions.md) (does the evaluator side ever materialise) is open, and pricing an unvalidated credential is guessing. Rejected because a free product with no purchase path never learns whether anyone values it, and "would you pay" is the only honest version of that question |
| **Money stakes as the monetisation** (Beeminder's model, the one survivor's) | The empirically validated model in this category, and the only one with a live example. Rejected on principle, in [ADR-0014](./0014-charity-escrow-for-stakes.md): the platform profiting from failure makes the referee misaligned, which is the exact structure this product criticises. Rejecting a working business model on principle is a real cost and should be recorded as one |
| **Pro hooked on private commitments** (current §9) | The intuitive hook and the one users ask for. Rejected because [ADR-0008](./0008-calibration-over-all-visibilities.md) may reduce it to private *content*, and a tier whose headline feature needs a nuance explained at checkout converts badly |

## Consequences

**Good:**
- Revenue becomes reachable in the current phase rather than after v3, which is the difference
  between learning something this year and not.
- Self-serve checkout has no sales motion, which matches the operator's actual capacity.
- Calibration analytics as the hook monetises the differentiator
  ([`product-overview.md` §4](../product-overview.md)) rather than a privacy toggle, and it is the
  feature a weekend clone cannot copy.
- Covenants test cohort demand for free. If nobody forms one, the organiser bet was worth
  deferring; if pods form spontaneously, the demand signal arrives without a sales call.

**Bad:**
- **The churn risk is now carried, not mitigated.** [`product-overview.md` §10](../product-overview.md)
  ranks individual churn **High** and names cohorts as the mitigation. Removing the mitigation
  while keeping the risk is the honest description of this ADR, and the graveyard table in Context
  is the evidence against it. The compounding-track-record argument in
  [`product-overview.md` §2](../product-overview.md) is the counter-argument, and it is a *theory*
  — no product in the table has demonstrated it.
- **Churn is slow to measure.** A monthly subscription needs 6+ months of cohorts before the churn
  curve says anything, so the revisit trigger below is genuinely slow to fire. In the meantime the
  decision cannot be evaluated, only defended.
- **Pro at $5–9/mo needs volume the product will not have for a year.** A hundred subscribers is
  under $1k/mo; a single organiser at $50–200/event reaches the same number with five deals.
  Choosing the low-ticket unit means the revenue signal is noisy for longer.
- **It puts pricing pressure on the growth loop.** Every public profile is a landing page and every
  shared receipt a backlink ([`product-overview.md` §9](../product-overview.md)); anything moved
  behind Pro reduces the surface that markets the product. Calibration analytics is exactly the
  screenshot people share, so gating the *deep* version while keeping the shareable version free
  is a line that will need policing on every release.
- **Covenants without a paid organiser artefact may train the wrong expectation.** A group that
  runs three free covenants and is then asked to pay for the report will read it as a rug pull.
  The report should be visibly Pro/Org from the first covenant, even while unbuilt.
- Demoting cohorts to a gamification feature risks the organiser product never being built at all —
  deferred-with-groundwork and quietly-abandoned look identical from inside for about a year.

**Neutral:**
- Nothing in the schema, the ledger, the probe path, or the receipt depends on which unit is
  monetised. This is reversible in a pricing page and a feature flag; the cost of being wrong is
  time, not migration.
- [ADR-0011](./0011-calibration-rank-and-seasons.md)'s covenant- and cohort-scoped boards are the
  same surface as the organiser board. Building it once serves both bets.

## Revisit when

- **Three unsolicited organiser enquiries arrive** — a hackathon, an accelerator, a meetup asking
  for a shared board or a post-event report, unprompted → build the organiser tier next and reject
  this ADR. That is the demand signal §6 was betting on, arriving on its own.
- **Pro monthly logo churn exceeds 8% averaged over any 3 consecutive months** once ≥30
  subscribers exist → the churn argument was right and the individual unit does not hold. Response
  is not a discount; it is flipping the sequence.
- **Pro conversion is below 2% of profiles with ≥5 resolved commitments** after 6 months → the
  hook is wrong. Test the private-commitment hook next, conditional on
  [ADR-0008](./0008-calibration-over-all-visibilities.md) being decided first.
- **Two quarters pass with covenants shipped and fewer than 5 formed** → the cohort motion has no
  organic demand, and the organiser bet should be closed explicitly rather than left deferred.
- **[ADR-0008](./0008-calibration-over-all-visibilities.md) is accepted** → re-read rule 1. The Pro
  hook must be re-stated in the same edit, because "private commitments" will then mean something
  narrower than the pricing table currently promises.
