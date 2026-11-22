# ADR-0010: Admit a self-reported verification tier, and narrow I-1 rather than abandon it

**Status:** Proposed — the most consequential open decision in the docset
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`product-overview.md` §8](../product-overview.md),
[`architecture.md` §5.3](../architecture.md),
[`security.md`](../security.md) (T-04, T-05),
[`calibration.md` §4](../calibration.md),
[`spec/receipt-format.md` §3](../spec/receipt-format.md),
[`../../CLAUDE.md`](../../CLAUDE.md) (invariant I-1),
[`../../scripts/check-invariants.mjs`](../../scripts/check-invariants.mjs)

> **This ADR is Proposed, not Accepted.** It proposes reversing the one rule the codebase
> enforces at build time. Nothing downstream may assume it is settled, and
> [`../../scripts/check-invariants.mjs`](../../scripts/check-invariants.mjs) must not be touched
> until it is accepted or rejected. A Proposed ADR supersedes nothing; if accepted, the
> "superseded by" note goes on [`product-overview.md` §8](../product-overview.md)'s bullet, not
> on an ADR.

## Context

[`product-overview.md` §8](../product-overview.md) says: *"No self-reported 'I shipped' button.
Ever. It is the exact thing that makes every competitor worthless."* That is not a preference. It
is enforced in three places at once: the CHECK constraint in
[`architecture.md` §5.3](../architecture.md), the `pledge_web` / `pledge_probe` role split in
[`architecture.md` §4](../architecture.md), and a build-time grep
([`../../scripts/check-invariants.mjs`](../../scripts/check-invariants.mjs)) that fails CI if any
file under `apps/web` assigns `status: 'kept'` or `status: 'missed'`. That file's own header
calls the escape hatch a misunderstanding of the product.

The new product direction (§2.2) lists three visible tiers — machine-verified > peer-attested >
self-reported — and that third tier does not currently exist in any form.

**The case for the tier is a ceiling argument, and the verification research says the ceiling is
real.** Of the six rows in the new §2.2 table, only two work end to end today:

| Row | Reality as of 2026-08 |
|---|---|
| Code release (tag/release) | Built. `github.release()` + the `release_version` template. Zero user friction on public repos |
| Merged PR closing linked issues | The closing-issue link exists **only** in GraphQL (`PullRequest.closingIssuesReferences`) — not REST, not the `pull_request` webhook payload. The worker is REST-only. New catalogue row → `spec_version` bump |
| Deploy — Vercel | Account webhooks are **Pro/Enterprise teams only**. Hobby users — the primary persona — cannot create one at all. The alternative is a marketplace Integration build + review |
| Deploy — Netlify | Works on all plans, but per-site manual webhook config with a user-chosen secret. Medium friction |
| Deploy — Fly.io | **No deploy webhooks exist.** The only route is polling the Machines API with the user's full-power API token. Unacceptable, and should stay unacceptable |
| Launch — Product Hunt | v2 API ToS: *"must not be used for commercial purposes"* without written approval. Blocked |
| Revenue — Stripe | Requires the user to hand over a live-mode restricted key, or a Connect Extension registration. A credential-custody problem, not an integration problem — the highest-friction row in the table |
| Content — URL + content hash | **Does not work as an assertion.** A body hash over a real site is unstable across CDN edge, injected nonces, CSRF meta tags, Next.js build IDs, A/B assignment. Two honest probes minutes apart differ. It is correct as *evidence* (`bodySha256`, already stored) and a false-negative generator as a *criterion* |

So "receipts, not selfies" is, today, receipts for GitHub releases, HTTP liveness, and DNS — plus
peer attestation. Everything else in the table is aspirational, blocked, or a credential-custody
problem. Forcing a real commitment ("get the beta into 20 users' hands", "close the design
partner") into `http(url).status == 200` produces a spec that is checkable and false — which is
worse than a spec that is honest and weak.

**The case against is that the tier will become the default path**, and the evidence for that is
the category's own corpse. Makerlog is not a competitor; it is a **death** — `getmakerlog.com`
and `app.getmakerlog.com` both 301 to the founder's personal blog, the org has zero public repos,
the founder is at Microsoft. WIP is alive with self-reported logs, ~3,759 makers, streaks, and a
community thread openly proposing *paying to repair a broken streak*. The self-reported maker log
is the exact artefact that failed. Meanwhile Beeminder already verifies GitHub commits and
issues-closed against a deadline with a stake, live today, among ~50 integrations. The
machine-verified bar is not exotic; a competitor cleared it years ago.

**One correction to the new direction's own framing.** Its §2.2 table lists *peer attestation* as
the fallback for "anything else". Self-reported appears only in the tier-ordering sentence — it
has no row, no verification source, and no job the peer-attestation row does not already do.
Peer attestation is built end to end ([ADR-0006](./0006-accountless-witnesses.md)), needs no
witness account, and is already labelled weaker by construction. The ceiling argument therefore
justifies **two** tiers, not three. The third tier needs its own justification, and the only
honest one is friction: finding a witness costs a social favour, and some commitments have no
plausible witness.

**And there is a mathematical argument the product framing does not have.** A self-reported
outcome is chosen by the same person who chose the confidence `p`. `(p, K)` is then not a
forecast–outcome pair; it is one self-consistent statement. A self-reporter attains a Brier score
of zero by construction, with no observation having occurred. Self-reported resolutions are
therefore *definitionally* zero-information for the self-calibration fit, and must be excluded
from it **entirely** — not merely from the north-star metric and the rank. This is stronger than
the product argument because it is falsifiable: if self-reported outcomes were admitted to the
fit, every self-reporter would appear perfectly calibrated, and the calibration identity would
measure nothing.

## Decision

*(Proposed.)* Admit a third tier under five rules that ship together or not at all. Rule 4 is the
mechanism that makes the rest enforceable rather than aspirational.

1. **Three tiers, permanently marked.** `commitment.verification_tier ∈ {machine, peer, self}`,
   set at creation from the done-spec's probe classes, immutable thereafter. Rendered on the
   ledger row, the commitment page, the OG card, the badge, and the receipt — not in a tooltip,
   not on hover, and never collapsed into a single "kept" glyph.
2. **Self-reported outcomes are excluded from the calibration fit, from Calibration Rank
   ([ADR-0011](./0011-calibration-rank-and-seasons.md)), and from the north-star metric** — for
   the reason above, which is arithmetic, not policy.
3. **Profile-level cap with a profile-level mark.** Above a threshold fraction of self-reported
   resolutions, the *profile* carries the mark, not just the row: "31 of 44 resolutions
   self-reported." A concrete starting threshold of **25%** is proposed and is frankly arbitrary;
   what is not arbitrary is that the mark is on the aggregate, because a reader scanning a
   profile reads the aggregate.
4. **I-1 is narrowed by widening the status enum, not by weakening the check.** Self-reported
   outcomes are written as `self_kept` / `self_missed` — *different statuses*, not the same status
   written by a different actor. `apps/web` still never writes `kept` or `missed`, so the existing
   grep in [`../../scripts/check-invariants.mjs`](../../scripts/check-invariants.mjs) is unchanged
   and unweakened. The invariant restates as: **machine-verified and peer-attested outcomes are
   never written by `apps/web`.**
5. **A second assertion is added to the same check:** no code path anywhere may coerce `self_*` to
   `kept`/`missed` — no `status === 'self_kept' ? 'kept' : …`, no `.replace(/^self_/, '')`, no
   shared badge component that maps both arms to one label. That coercion is the only way rule 1
   dies, and it dies in a display helper, not in a route handler.

The CHECK constraint in [`architecture.md` §5.3](../architecture.md) gains the two new arms.
`pledge_web` needs **no new grant** — it already holds table-level UPDATE on `commitment` for
amendments and visibility. That is precisely why the grep, not the grant, was always the real
enforcement.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep the absolute rule.** No third tier, ever | The strongest option and the current one. It is the entire reason the ledger means anything, it is the sentence that separates pledge from WIP, and it is enforced by machinery that already works. It caps addressable commitments at what a probe or a witness can see — but the research shows that ceiling is higher than it looks once peer attestation is counted, because attestation has no domain restriction at all. Rejected here only on friction, and friction is a weaker reason than the one it overrides. **A reasonable person lands on this option** |
| **Two tiers: machine and peer only** — extend peer attestation to cover everything self-report would | The honest minimum, and it needs zero new code: [ADR-0006](./0006-accountless-witnesses.md) already ships accountless magic-link attestation. Its only failure case is a commitment with no plausible witness, which is rarer than it sounds for a product aimed at people who build in public. Genuinely close; rejected because "find someone to vouch" is a social cost paid at the worst moment, and unpaid social costs become abandoned drafts |
| **Self-report allowed, but only after the deadline and only as a dispute of a `missed`** | Bounds the tier to the case where the probe was wrong, which is the sympathetic case. Rejected: it collides with I-7 (a probe that could not observe is `error`, never `fail`), and the `disputed` status plus the witness handler already covers it. It also inverts the incentive — self-report becomes a way to overturn a machine observation, which is worse than a way to record an unobservable one |
| **Self-report allowed but excluded from the public profile entirely** (private notes only) | Removes the laundering risk completely. Also removes the point: a resolution nobody can see is a to-do item, and pledge is not a to-do app |
| **Let an LLM adjudicate ambiguous evidence and write the outcome** (new direction §4.3) | Out of scope here and flagged deliberately: a model writing a resolution is self-report at machine scale wearing a lab coat. It requires its own ADR and its default answer is no. See [ADR-0012](./0012-llm-in-the-pledge-creation-path.md) |

## Consequences

**Good:**
- The addressable commitment set stops being "whatever a probe can see". Commitments that are
  real and unobservable get recorded honestly instead of being contorted into a checkable proxy —
  which is itself a T-04 attack surface, since a contorted spec is a trivially-satisfiable one.
- The north-star metric (% of resolved pledges machine-verified) becomes a **real** metric with a
  denominator that can move. Under the absolute rule it is trivially 100% and measures nothing.
- The tier ladder gives the product a legible upgrade path to sell: "this one is self-reported —
  add a witness, or point it at a release tag."
- Rule 4 means the highest-value test in the codebase keeps passing unmodified. The invariant
  narrows in *scope* without narrowing in *strength*.

**Bad:**
- **The tier will be over-used, and the cap is the only thing standing against it.** Self-report
  is one click; a done-spec is a paragraph and a witness is a favour. Every product that offered
  both converged on the easy one. If the observed self-reported share exceeds ~40% of resolutions
  in the first 90 days, this ADR was wrong and the honest response is withdrawal, not a
  copy tweak.
- **`kept` stops meaning one thing.** Today a reader needs no vocabulary: a kept badge is a probe
  observation. After this there are two kinds of kept, and the difference is carried by a label —
  which is exactly the burden [`../../CLAUDE.md`](../../CLAUDE.md)'s copy rule ("never render a
  kept badge without the spec source one click away") already says the product must not push onto
  the reader. Every screenshot, every embed, every third-party rendering is a chance to lose the
  distinction.
- **It is a receipt-format break.** [`spec/receipt-format.md` §3](../spec/receipt-format.md)'s
  signed subset does not cover a tier field, and adding one to the signed subset changes what a
  signature attests. Every receipt issued before the change verifies under the old rules; a
  verifier must handle both. This is a versioned format migration, not a field addition.
- **T-05 gets worse and T-04 gets a new arm.** [`security.md`](../security.md) ranks calibration
  laundering **Fatal** already. A self-reported tier adds a path that requires no technical skill,
  leaves a perfectly valid ledger entry, and is indistinguishable from intended use — the same
  shape as T-05a, which is what makes T-05a untreatable. The threat model needs a new row and the
  ranking needs revisiting; do not accept this ADR without that edit.
- **The 25% cap is a quota**, and [ADR-0008](./0008-calibration-over-all-visibilities.md) rejected
  a cap on private commitments partly on the grounds that a quota is a shape the rest of the
  system does not have. That objection applies here unchanged, and this ADR does not have a better
  answer than "the aggregate mark is what a reader actually reads".
- Two extra status arms propagate into every query, every filter, every badge, the API, the
  ledger renderer, and the calibration extract. Each is a place the coercion in rule 5 can appear.

**Neutral:**
- The GraphQL work for `closingIssuesReferences`, the Netlify webhook receiver, and the Vercel
  Integration are unaffected by this decision — they raise the machine tier's ceiling whether or
  not a third tier exists, and doing them is the honest way to make this ADR matter less.

## Revisit when

- **Self-reported share exceeds 40% of resolutions over any rolling 90-day window** → withdraw the
  tier for new commitments, keep existing rows marked, and record the withdrawal as a new ADR. The
  tier was supposed to be the exception; at 40% it is the product.
- **Machine-verified share of resolutions falls below its pre-tier level in absolute count** →
  the tier is cannibalising rather than expanding. Same response.
- **The machine tier's ceiling rises materially** — GraphQL closing-issue links ship, a Netlify
  and a Vercel receiver ship, and a Stripe read-only attestation route exists → re-run the ceiling
  argument. If ≥5 of §2.2's rows work end to end, the friction case for tier 3 is much weaker and
  this ADR should be re-argued from scratch.
- **Any proposal appears to admit `self_*` outcomes into the calibration fit, the rank, or the
  north-star metric** → re-read the Brier argument in Context. It is arithmetic. There is no
  version of that proposal that is correct.
- **A reader, unprompted, mistakes a self-reported kept for a verified one** in a real
  conversation → rule 1's rendering has failed and the display, not the rule, is what needs
  changing first.
