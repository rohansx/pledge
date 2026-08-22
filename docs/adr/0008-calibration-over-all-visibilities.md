# ADR-0008: Calibration is computed over all visibilities

**Status:** Proposed — must be decided before the visibility column carries real data
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`security.md`](../security.md), [`architecture.md`](../architecture.md), [`calibration.md`](../calibration.md), [`product-overview.md`](../product-overview.md), [`open-questions.md`](../open-questions.md)

## Context

`commitment.visibility ∈ {public, unlisted, private}`
([`technical-spec.md` §3](../technical-spec.md)). Private commitments are the headline feature of
the Pro tier ([`product-overview.md` §9](../product-overview.md)) and the stated mitigation for
the "nobody actually wants a public failure record" risk. The profile owner chooses what is
shown.

Those two facts together open a hole large enough to invalidate the product. The attack is one
sentence: commit everything privately, publish only the ones you kept. The published calibration
is then computed over a sample the subject selected after seeing the outcome — which is exactly
the self-reporting the product forbids everywhere else, reintroduced through a paid feature.
This is [T-05a](../security.md) and it is ranked **fatal**, alongside probe gaming, because it
does not degrade one number: it retroactively invalidates every score on the platform, including
those of users who never did it. A reader cannot tell a laundered 92% from an honest one.

The relevant asymmetry is that laundering requires no technical skill, leaves no trace in the
ledger (a private commitment that is never published is a perfectly valid, correctly recorded
entry), and is indistinguishable from ordinary use of a feature the user paid for. Every other
open threat is at least visible to a determined reader; this one is not.

The timing constraint is what makes this urgent rather than merely important. The denominator is
not a display choice — it is baked into every fitted `mu_i`, every published receipt line, and
every OG card ever shared. Changing it later means recomputing and republishing every score on
the platform, and a mass revision of published numbers is itself a credibility event, which is
the precise thing this product cannot survive. **Decide before the visibility column ships with
real data behind it**, not before Pro launches.

This ADR is Proposed, not Accepted, because it trades against revenue and against the one
mitigation currently offered for the public-failure-record risk. It needs an explicit decision,
not a default.

## Decision

*(Proposed.)* Three rules that only work together, and none of which may ship without the other
two:

1. **Calibration is computed over all commitments regardless of visibility.** Private and
   unlisted commitments enter the fit, the censoring treatment, and the denominator exactly as
   public ones do.
2. **The profile displays `n_public / n_total`.** A reader sees "74% on-time across 35
   commitments, 12 shown" — the score and the fact that most of its inputs are hidden are
   rendered in the same breath, never separately.
3. **Public → private is forbidden, permanently.** A commitment may be created private and later
   made public; the reverse transition does not exist, in the API, in the schema, or in support
   tooling. Enforced as a DB-level check on the transition, not as an application convention.

Rule 2 is what makes rules 1 and 3 legible to someone who has never read this document.

## Alternatives considered

| Option | Why not |
|---|---|
| Compute calibration over public commitments only | The most intuitive rule and the one users would expect: your public profile reflects your public record. It also has a real privacy argument — a score influenced by work you never disclosed is a score you cannot audit in public. Rejected because it *is* the attack. It makes the published number a self-selected sample by construction, and the credential is then worth exactly what a self-reported one is worth, which is nothing. |
| Forbid private commitments entirely | Cleanest possible rule, zero ambiguity, nothing to explain. It kills the Pro tier's only differentiated feature and removes the stated mitigation for "nobody wants a public failure record" ([`product-overview.md` §10](../product-overview.md)) — a Medium risk that plausibly gates adoption harder than laundering does in year one. Defensible; rejected because it trades a fatal-but-mitigable threat for a probable adoption ceiling and a dead paid tier. |
| Two scores: a public-only score and a complete score | Superficially the honest compromise — show both, let the reader choose. In practice the public-only number is the one that ends up on the badge, the OG card, and the fellowship application, because it is always the flattering one. Two numbers where one is meaningless is worse than one number, and it invites "which score is the real one?" at every reading. |
| Private commitments counted, but only after a lock-in delay (e.g. visible in the denominator 30 days after resolution) | Softens the "my private work is being counted right now" objection and still closes the sample-selection hole eventually. Rejected as complexity that buys a month: it creates a window in which the displayed denominator is knowably wrong, and the rule becomes impossible to state in one line on the profile. |
| Cap the number of private commitments per account | Bounds the attack without removing the feature. But it bounds it at an arbitrary number, is trivially defeated by keeping the cap saturated with the slips, and turns a principle into a quota — a shape the rest of the system does not have anywhere. |

## Consequences

**Good:**
- The published score is computed over the complete population of the user's commitments. It
  means the same thing on every profile, which is the only condition under which comparing two
  profiles is meaningful.
- `n_public / n_total` makes hiding legible instead of invisible. A profile showing 3 of 40 tells
  the reader something true, and tells it without accusing anyone.
- The forbidden public→private transition also closes the simpler retroactive-deletion attack,
  where a user un-publishes a miss after it lands.
- Pro survives. Privacy of *content* is preserved — claim text, spec, and evidence stay hidden.
  Only the fact of a commitment and its outcome touch the denominator.

**Bad:**
- A user who wants a genuinely private commitment — a real, honest use case — still has it
  counted. Some will read that as a dark pattern, and the objection is not unreasonable. The
  honest framing is the only one available: pledge is a record, and opting out of the denominator
  is opting out of the record. That framing must appear at the point of setting visibility, not
  buried in terms.
- It weakens Pro's pitch. "Private commitments" now means private *details*, not private
  outcomes, and the difference will need explaining at the moment of purchase — the worst
  possible moment to explain a nuance.
- It probably suppresses experimental commitments. Users who would have privately committed to a
  risky idea may not commit at all, which biases the corpus toward safe work — a bias in the
  same direction as [T-05b](../security.md), and one this rule makes slightly worse.
- Rule 3 has no escape hatch. A user who publishes something they later regret — a claim naming a
  client, an employer, an unlaunched product — has no route back, and support will face that
  request. The answer is deletion of the account's public surface, not selective retraction, and
  that answer will not satisfy them.
- The rule must be enforced across the fit, the display, the API, the badge, and the receipt.
  Any surface that quietly filters by visibility reopens the hole.

**Neutral:**
- `unlisted` becomes a discoverability setting only — not indexed, not on the profile grid,
  reachable by link, counted like anything else.

## Revisit when

This is a decision, not an experiment. It should not be re-litigated on the basis that the rule
is unpopular, and it should not be softened incrementally. Two triggers only:

- **Pro conversion data shows the rule is the blocker.** Concretely: ≥50 Pro trials, and exit
  interviews or a cancellation-reason field identify the counted-denominator rule as the stated
  reason in >30% of non-conversions. Even then, the response is a different privacy product
  (private *content*, separate workspace, no public profile at all), not a filtered denominator.
- **A regulatory or contractual requirement makes counting a private commitment untenable** for
  a specific class of account — e.g. an Org tier customer under an NDA regime. That is a
  tenancy question, and the answer is a separate denominator scope per tenant, never a per-user
  opt-out inside a shared one.

Until one of those fires, the correct action on this ADR is to accept or reject it outright.
Leaving it Proposed while the visibility column accumulates rows is the one outcome that
guarantees the expensive migration.
