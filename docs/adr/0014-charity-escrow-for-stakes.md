# ADR-0014: If money stakes ever ship, escrow goes to a charity or a named beneficiary — never to pledge

**Status:** Proposed — stakes are out of scope, so this is a pre-commitment, not a build decision
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`product-overview.md` §8](../product-overview.md),
[`product-overview.md` §9](../product-overview.md),
[`architecture.md` §13](../architecture.md),
[`roadmap.md`](../roadmap.md),
[ADR-0013](./0013-individual-pro-over-organizer-gtm.md)

## Context

[`product-overview.md` §8](../product-overview.md) already defers money stakes: financial
commitment devices self-select the audience down to near-nothing, and stakes are at most an
optional v3 module. Nothing in the roadmap builds them. This ADR does not change that.

What it settles is the thing that gets decided badly *later*, under revenue pressure, when
stakes are being scoped and the obvious question is "where does the forfeited money go". The
answer is worth fixing now, while nobody has a number to protect, because the wrong answer is
structurally corrupting rather than merely unpopular: **a referee that profits when you fail is
not a referee.**

The competitor evidence is unambiguous on two of three, and the pivot brief's blanket claim needs
narrowing before it is repeated:

| Product | Where forfeits go |
|---|---|
| **Forfeit** | Their own FAQ: *"For now it is retained by Forfeit."* Redirect-to-friend/savings is described as future work |
| **Beeminder** | *"You pay for Beeminder primarily through the pledges you pay."* The 50% charity split is a **premium** feature — you pay more to have less of your forfeit kept |
| **StickK** | Friend, foe, one of 15+ 501(c)(3) charities, an anti-charity, **or** stickK. The platform is one of four options, not the default |

So "the platform keeps forfeited money" is true of Forfeit, true of Beeminder by design, and
**false as stated for StickK**. That correction matters because the sentence appears inside the
paragraph doing the most rhetorical work in the product's positioning; a hostile reader finds it
in one click, and a factual error there costs more than the argument gains.

Beeminder is also the category's one clear survivor, and its monetisation *is* the forfeit stream.
Rejecting that model on principle is rejecting the only validated business model in the category
— see [ADR-0013](./0013-individual-pro-over-organizer-gtm.md), where the same trade appears from
the revenue side. That is a real cost and this ADR does not pretend otherwise.

The dominating constraint here is the credibility of the record.
[`architecture.md` §13](../architecture.md) is already candid that the ledger is correct
engineering aimed slightly left of the live doubt; a forfeit stream would install a *second*
misalignment, this one at the incentive layer, where no amount of cryptography helps.

## Decision

*(Proposed.)* If money stakes are ever built:

1. **The beneficiary is a named third party** — a person the committer names, or a registered
   charity from a published list. **pledge is never a permitted beneficiary**, and is not an option
   in the picker.
2. **pledge takes no share of the escrow, and no revenue derived from it** — no cut, no
   "processing" percentage on the forfeit, no interest on the float. Revenue from stakes, if any,
   is a **flat fee charged at commitment time**, identical whether the commitment is kept or
   missed. The fee must not be a function of the outcome.
3. **Beneficiary is fixed at commitment time and is part of the signed payload**, so the
   destination cannot be changed after the outcome is known — the same rule the done-spec already
   has (I-4).
4. **A miss with a stake is rendered no differently from a miss without one.** The stake is not a
   badge, not a tier, and not an input to calibration or rank.

Until stakes are in scope, the only operative effect of this ADR is that any stakes proposal
naming pledge as a beneficiary is rejected without further discussion.

## Alternatives considered

| Option | Why not |
|---|---|
| **Platform keeps the forfeit** (Forfeit, Beeminder) | The only validated business model in the category, self-funding, no payout rail, no charity vetting, no third-party dependency, and it aligns the *user's* incentive perfectly well. Rejected because it misaligns ours: pledge would earn more from misses than from keeps, on a product whose entire claim is that it is a neutral recorder. The claim and the P&L would point in opposite directions, and users would be right to notice |
| **Anti-charity** (stickK's most effective mechanic, by their own data) | Genuinely the strongest motivator in the literature, and it routes money away from the platform, so it satisfies the principle. Rejected as a *default*: pledge would have to curate the list of organisations it considers repugnant, which makes the product's politics a feature. Permissible only as a user-named beneficiary under rule 1, where the user picked it and pledge published no list |
| **Refund on success, keep on failure, minus a fee** | The natural compromise. Rejected: any fee that is larger on a miss than on a keep reintroduces the misalignment at a smaller scale, and a small misalignment on this axis is not meaningfully better than a large one. Rule 2's flat commitment-time fee is the version of this that survives |
| **Interest on the escrow float** | Looks free. It is not: holding user funds pending an outcome is custody, which in India is payment-aggregator territory under the RBI PA/PG framework, with authorisation, net-worth, and escrow-account requirements attached. The compliance surface is disproportionate to a side project, and earning on the float still means earning from money that only exists because someone might fail |
| **No stakes, ever** — delete the option rather than constrain it | Cleanest, and close to the current position. Not chosen only because §8 already frames stakes as a possible v3 module and this ADR's job is to constrain that module, not to re-litigate whether it exists |

## Consequences

**Good:**
- pledge cannot profit from a miss. That is the one sentence that separates this from every
  stake-based competitor, and it is checkable by anyone reading the beneficiary field.
- The referee stays neutral, which keeps the resolution machinery's credibility intact. A probe
  worker owned by a party with a financial interest in the outcome is a probe worker nobody should
  believe.
- Deciding now costs nothing. Deciding later, with a revenue forecast on the table, would be
  decided differently.

**Bad:**
- **It forecloses the only validated monetisation in the category.** Beeminder is alive and
  funded by exactly the mechanism this ADR forbids. If Pro fails
  ([ADR-0013](./0013-individual-pro-over-organizer-gtm.md)) and the organiser tier never
  materialises, this ADR removes the fallback.
- **Escrow means custody, and custody means regulatory surface** — KYC on payers, an escrow
  account, refund handling, chargebacks, and a payout rail to charities that can issue receipts.
  For an Indian sole operator that is disproportionate to the feature, and it is the real reason
  stakes are hard, not the philosophy.
- A charity payout needs *verified* charities and a receipt trail, or the "your ₹2000 went to X"
  claim is itself unverifiable — which would be an unverified claim at the centre of a product
  about verified claims. The list has to be small, vetted, and auditable, and that is ongoing work
  nobody is scheduled to do.
- A named-individual beneficiary is a person-to-person transfer triggered by a third party's
  observation. That is a dispute surface with real money in it, and the appeal path is
  undefined — [ADR-0006](./0006-accountless-witnesses.md)'s witness flow was designed for
  reputational stakes only.
- Rule 4 means stakes buy the user motivation and nothing on the profile, which will read as a
  worse deal than competitors offer.

**Neutral:**
- Nothing is built either way. This ADR is a constraint on a future design, and its cost today is
  one file.

## Revisit when

- **Stakes enter a roadmap phase** → this ADR moves from Proposed to Accepted or Rejected *before*
  any schema work, not after. A `stake` column that ships without this settled will be settled by
  whoever writes the payout code.
- **A user asks to stake toward pledge itself** ("I want the money to go to you if I miss") → the
  answer is no, and rule 1 is why. It will be asked, and it will sound generous.
- **Any stakes proposal makes revenue a function of the outcome** — a percentage cut, an
  outcome-dependent fee, float interest → re-read this ADR before the discussion, not after.
- **A payment regulation change makes third-party escrow materially cheaper** for a small Indian
  operator → the custody objection in Consequences → Bad weakens, and stakes become more feasible
  without changing rule 1 or 2.
