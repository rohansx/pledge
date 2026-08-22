# ADR-0007: AST-derived calibration features

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`calibration.md`](../calibration.md), [`spec/done-spec-dsl.md`](../spec/done-spec-dsl.md), [`technical-spec.md`](../technical-spec.md), [`security.md`](../security.md)

## Context

The calibration model regresses log slip ratio on a per-commitment feature vector `x_ij`
([`calibration.md` §2](../calibration.md)). The vector exists to separate "this user is
optimistic" from "this *kind of work* slips", which is what makes the reportable output —
*"you're optimistic by ~3x on anything requiring someone else's API"* — mean anything. Some
source of work-type information is therefore required. The only real question is where it comes
from.

The obvious source is the user. Every planning tool on earth asks for a category, a tag, or a
difficulty rating, and users are used to supplying one. It is cheap, expressive, and captures
things a machine cannot see.

It is also self-reported, and the first design constraint is that nothing self-reported is ever
authoritative ([`technical-spec.md` §1](../technical-spec.md)). That constraint is currently
enforced at the outcome layer — there is no "mark as done" endpoint, and `pledge_web` has no
code path that writes `status IN ('kept','missed')`
([`architecture.md` §5.3](../architecture.md)). But calibration is the differentiator, and a
score computed over user-chosen labels is a self-reported number wearing a statistical costume.
A user labelling their own work will, with no conscious intent to cheat, label every slip
"hard" and every hit "easy". The regression absorbs that labelling into `beta` and reports back
a flattering decomposition the user authored themselves.

The done-spec already carries the information in machine-readable form. It is a parsed,
canonicalised, content-addressed AST ([`spec/done-spec-dsl.md`](../spec/done-spec-dsl.md)) whose
hash is frozen at commit time and cannot be edited afterwards. Anything derived from it inherits
that immutability for free.

## Decision

The calibration feature vector is computed mechanically from the canonicalised done-spec AST at
commit time, and from nothing the user types as free-form metadata. The features are
`probe_class`, `n_distinct_sources`, `has_third_party_api`, `has_foreign_repo`,
`has_registry_publish`, `has_temporal_clause`, `est_days_bucket`, `class_difficulty` and
`is_cohort` — the table in [`calibration.md` §3](../calibration.md) is normative. Extraction is a
pure function of the AST plus account and cohort context, deterministic for a given
`spec_version`, and frozen alongside the spec hash, so the features that applied are the features
that were computable when the promise was made.

## Alternatives considered

| Option | Why not |
|---|---|
| User-selected categories ("frontend", "integration", "research") | Strictly better UX, and it captures real distinctions the AST is blind to — a two-source spec on unfamiliar tech is genuinely harder than a two-source spec on a codebase you wrote. But the label is chosen by the person the score is about, often after they know how the work felt, and it is the input with the highest leverage on the reported decomposition. Self-reporting reintroduced at the statistics layer. |
| User difficulty rating (1–5) at commit time | Elicited before the outcome, so less contaminated than post-hoc tagging, and it captures effort directly rather than by proxy. Still unfalsifiable, still authored by the subject, and it invites exactly the drift where a user learns which ratings produce a flattering `mu`. |
| LLM classification of the claim text | Reaches semantics the AST cannot, and is not user-chosen. Rejected on auditability: non-deterministic, not reproducible by a third party holding only the receipt, and it would have to be frozen at commit time with the model version pinned to be fair — shipping a versioned model dependency into the immutable half of the system. A feature vector that cannot be recomputed offline weakens [`spec/receipt-format.md`](../spec/receipt-format.md). |
| Hybrid: AST features drive the model, user tags are display-only annotation | **The strongest rejected option and the likely successor if this ADR is revisited.** Genuinely defensible: the score stays machine-derived and the user gets to tell readers "this was a research spike". It is not being built now for scope discipline, not principle — a display-only tag must stay display-only forever, including when the obvious next request is "filter my calibration by tag", which is the model reading user labels through a side door. Deferred until the display need is demonstrated. |
| No features at all — fit `mu_i` and `sigma_i` only | Simplest and honest. But it collapses "solo CLI tool" and "integrate a payment provider" into one distribution, producing a `mu` that describes neither, and deletes the sentence users actually screenshot. |

## Consequences

**Good:**
- The score is derived end-to-end from immutable, externally checkable inputs. The same argument
  that defends a `kept` outcome defends the calibration number.
- Features are recomputable from the receipt by anyone holding the spec source, with no database
  access and no model dependency.
- Extraction is a pure function over the AST: trivially testable, stable across refits, and
  identical for two users who wrote the same spec.
- Nothing extra is collected in the composer. Commit stays under 60 seconds.

**Bad:**
- The features are coarse. The AST sees the *shape* of a promise, never the effort behind it.
  `http("https://my-landing-page.com").text contains "coming soon"` and a real product launch can
  produce byte-identical feature vectors — the limitation
  [`spec/done-spec-dsl.md` §7](../spec/done-spec-dsl.md) states about probe classes, inherited
  wholesale.
- Unmodelled variance lands in `sigma_i`, so a user doing genuinely varied work reads as
  "inconsistent" when they may be well-calibrated within each kind of work they do.
- Worse UX than the alternative. Users will ask for categories, and the answer is a paragraph of
  reasoning rather than a feature.
- `class_difficulty` is a population mean lagged one fit cycle, so it is endogenous — learned
  from the same commitments it is used to explain. Tolerable at current volume, not forever.
- It does not close [T-05b](../security.md). Trivial-commitment padding is orthogonal to where the
  features come from, and this ADR must not be cited as if it mitigated that.

**Neutral:**
- `est_days_bucket` derives from the user's own chosen deadline, which is user-supplied. That is
  intentional and not a violation: the deadline is the thing being scored, not a label applied
  to it.

## Revisit when

- Feature-importance analysis over ≥500 resolved commitments shows the AST features jointly
  explain <5% of variance in `y` beyond `mu_i` alone. At that point the vector is imposing
  constraints and earning nothing, and the honest move is either the display-only-tags hybrid or
  dropping features entirely.
- A reproducible, offline-verifiable classifier exists that a receipt holder can re-run. That
  removes the auditability objection to the LLM option, though not the commit-time freezing
  requirement.
- Users are observed encoding work-type information into the `claim` free text at high rates —
  evidence that the display-only annotation is wanted and is currently being smuggled into a
  field nothing reads.
