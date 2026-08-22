# ADR-0009: Name the project pledge, not kept

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`product-overview.md`](../product-overview.md), [`technical-spec.md`](../technical-spec.md)

## Context

The project was designed and documented under the working name **kept**. It is now **pledge**,
at `pledge.sh`. The domain is acquired; the rename has already propagated through the docs.

The tension is real and worth writing down rather than glossing, because it is a positioning
problem and not a taste problem. *kept* is past tense. It names the **record** — the thing that
already happened, the outcome, the artifact an evaluator reads. That is precisely the product's
positioning: *GitHub's green squares measure activity; pledge measures follow-through*
([`product-overview.md` §2](../product-overview.md)). *pledge* is forward tense. It names the
**promise** — the moment of committing, the intention, the thing not yet done. And "the promise"
is the accountability-app framing the product explicitly rejects in
[`product-overview.md` §8](../product-overview.md), one section of which exists solely to say
there is no self-reported "I shipped" button and no nag.

So the name argues for the category the product is trying to leave. That is not a small cost.
Names do a large fraction of positioning work before anyone reads a word of copy, and a user who
arrives at `pledge.sh` primed for StickK will read the profile as a to-do list with extra steps.

Against that: the name is shorter, is pronounceable by a non-English speaker on first attempt,
and works as both noun and verb, which matters more than it sounds. `pledge verify receipt.json`
reads correctly as a command; `kept verify receipt.json` reads as a typo. The CLI, the npm scope
`@pledge/*`, the receipt `issuer` field, and the badge URL all inherit that ergonomic. `kept.sh`
was not available and the fallbacks were worse than the name.

The decision is therefore not "which name is better" but "is the positioning cost payable by
other means".

## Decision

Adopt **pledge** (`pledge.sh`) as the product name, and pay the positioning cost with a standing
guard rather than by absorbing it: **every surface leads with the record, not the promise.** The
landing headline is *"pledge — the record of what you shipped."* The public profile renders
resolved outcomes and the calibration panel above open commitments, never below. The word
*accountability* does not appear anywhere in the product, the marketing, or the docs except to
say what pledge is not. This guard is already normative as constraint 6 in
[`technical-spec.md` §1](../technical-spec.md) and is a copy-review criterion, not an
aspiration.

## Alternatives considered

| Option | Why not |
|---|---|
| Keep **kept** | The better positioning fit by a clear margin — past tense, names the artifact, and would have removed the need for the guard entirely. Rejected on ergonomics and availability: `kept.sh` was unavailable, the noun/verb collapse breaks in CLI usage (`kept verify` reads wrong, `kept kept` is worse), and "kept" as a bare noun is hard to say aloud without context — "it's called kept" reliably produces "kept what?". A name that needs a sentence of explanation in every spoken introduction is a tax paid daily. |
| A third, neutral name (coined or abstract) | Sidesteps the tense problem completely and would carry no wrong connotation. Rejected because a coined name carries *no* connotation at all, which for a pre-launch product with no marketing budget means the name does zero positioning work and every impression has to be bought or explained. The whole argument for "kept" was that a name can carry meaning; abandoning that gains nothing. |
| **pledge** as the company, **kept** as the record object ("your kept record", `GET /kept`) | Genuinely appealing, and it would have let both words do the job each is good at. Rejected as two names to establish instead of one, at a stage where establishing even one is uncertain. It also puts the past-tense word in the API surface and the forward-tense word on every share — the wrong way round, since the share is the thing a stranger sees first. Worth reconsidering if a second product ever justifies a parent brand. |
| Rename later, after validation | Defensible in the abstract, and the cost is genuinely lower before launch than after. But receipts, badges, and the verifier CLI are designed to be long-lived artifacts embedded in other people's READMEs and applications; a rename after those exist orphans them or forces a compatibility shim in the receipt format. The rename window closes at the first published receipt, which is early in v2. |

## Consequences

**Good:**
- Short, pronounceable, single-syllable, and unambiguous when spoken. `pledge.sh` is owned.
- Verb/noun ergonomics carry through the CLI, the package scope, the badge URL, and the receipt
  `issuer` field with no awkwardness.
- The rename is happening now, before receipts, badges, or the public API exist — the only
  window in which it is cheap.

**Bad:**
- **The name will pull copy toward the nag framing forever.** Every future landing page draft,
  every launch tweet, every onboarding email will have a natural gravitational pull toward
  "commit to your goals" phrasing, because that is what the word means. Resisting it is not a
  one-time fix; it is a recurring cost at every copy review, and it will be paid by whoever
  writes copy in a hurry — which is to say it will occasionally be lost.
- A fraction of arrivals will be pre-framed as an accountability app before reading anything,
  and some of them will bounce without ever reaching the sentence that corrects it. That
  fraction is unmeasured.
- The docs now carry a naming note and a rename history, which is friction for anyone reading
  them cold.
- Guard rules that live only in a spec section decay. Constraint 6 in
  [`technical-spec.md` §1](../technical-spec.md) has no automated enforcement, and there is no
  cheap test for "the landing page drifted toward motivation language".
- "pledge" is a common English word with existing product and charity associations, which makes
  search and trademark ground weaker than a coined name would have been.

**Neutral:**
- Product substance is unchanged. Nothing in the data model, the DSL, the ledger, or the
  calibration model depends on the name.
- `kept` survives as the outcome value in `commitment.status`, which is the one place the past
  tense is exactly right.

## Revisit when

- User research or onboarding-survey data shows arrivals expect an accountability or habit app.
  Concrete trigger: >25% of new signups, asked "what did you think this was before you read the
  page?", answer with a motivation/habit/goal framing. That means the guard is failing at the
  surface it was written to protect, and the response is stronger copy first, a rename only if
  copy cannot move the number.
- Any product surface ships the word *accountability* in a non-negating sentence. That is a
  guard breach, and it is a signal about the name's pull, not just a copy slip.
- Trademark or search conflict makes the name legally or practically unusable — a decision that
  would be forced rather than chosen, and one that gets harder every day after the first
  published receipt.
