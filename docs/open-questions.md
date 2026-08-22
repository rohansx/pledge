# pledge — Open Questions

**Version:** 1.0
**Status:** Live register
**Date:** August 2026

Everything in this file is genuinely unresolved. A question leaves this register only by being
answered in an ADR under [`adr/`](./adr/), at which point its **Status** line points at that
ADR and the reasoning moves there.

Two rules for maintaining this document:

1. **Nothing gets softened.** If an option is bad, the consequence column says so. A question
   that has been reworded until it sounds tractable has been lost, not solved.
2. **A leaning is not a decision.** Where there is a leaning it is stated with its reason;
   where there is not, the entry says "undecided" rather than manufacturing one.

Ordered by severity, not by number. Q-00 is the only hard blocker — everything else is a
question the product can be built through, and several of them are questions the product will
be *killed* by if they resolve badly.

---

## Q-00 · Pre-launch personal/legal clearance

**Status:** Open
**Blocks:** Public launch under the author's name. Does **not** block development.
**Owner:** rohansx
**Raised:** 2026-08

There is an outstanding personal obligation that must be closed in writing before pledge — or
any side project — launches publicly under the author's name. Details are deliberately kept
out of this repository; they live in the untracked `NOTES.local.md` at the repo root.

**Decision deadline:** Before the first public URL, badge, receipt, or announcement —
whichever comes first. In practice that is before the end of v1
([`roadmap.md`](./roadmap.md) cross-cutting gates), because v1 is the phase that produces
shareable artifacts.

**This is the only hard blocker in the register.** Development continues at full speed against
it; distribution does not.

---

## Q-01 · The private/public calibration denominator

**Status:** Open — proposal drafted as
[ADR-0008](./adr/0008-calibration-over-all-visibilities.md)
**Blocks:** The `visibility` column shipping with real data behind it, and the Pro tier (whose
headline feature is private commitments)
**Owner:** rohansx
**Raised:** 2026-08

When a user can mark a commitment private, what is the denominator of their published
calibration — all commitments, or only the public ones?

**Why it is hard:** Both sides are load-bearing. Privacy is the answer to "nobody wants a
public failure record" ([`product-overview.md` §8](./product-overview.md)) and it is the thing
people will pay for. But if the published score is computed over only the public subset, the
user chooses their own sample — which is exactly the self-reporting the product exists to
eliminate, reintroduced through a paid feature. This is the laundering attack:

> Commit to ten things privately. Publish the four you kept. The profile reads 100%.

That failure is worse than not shipping privacy at all, because it is *sold* as a feature and
it invalidates every other profile on the site by association
([`security.md`](./security.md) T-05a).

**Options:**

| Option | Consequence |
|---|---|
| Calibration over **all** commitments; display `n_public / n_total`; public → private forbidden (the three-rule proposal) | Laundering closed. Reader sees "74% on-time across 35 commitments, 12 shown". Costs some privacy appeal — the count of your private misses is visible even when their content is not |
| Calibration over public commitments only | Simple, legible, and the product's central claim is dead. Not viable |
| Two scores: public-only and all-commitments, both displayed | Honest, but a reader who compares them learns the private-miss rate anyway, so it has the same privacy cost as option 1 with more surface area and more confusion |
| No private commitments at all | Removes the question and removes the Pro tier's reason to exist. Also removes the only mitigation for "nobody wants a public failure record" |
| Private commitments excluded from calibration but permanently marked as excluded (`n_excluded`) | Weakest form of option 1. A reader cannot distinguish "excluded because sensitive" from "excluded because missed" |

**Leaning:** The three-rule proposal (option 1). It is the only option that keeps both privacy
and the no-self-report invariant, and the cost — exposing counts but not content — is the
smallest honest price. It is a leaning, not a decision: it has not been tested against a real
Pro user's objection, and "my employer can count my misses" is a plausible reason to not
subscribe.

**Decision deadline:** Before the `visibility` column carries real data — v2 at the latest.
The forcing function is retrofitting cost: changing the denominator later means recomputing
and republishing every score on the site. A site-wide score correction is itself a credibility
event, which is precisely the thing the product cannot afford.

---

## Q-02 · Can a machine-checkable spec ever distinguish effort from output?

**Status:** Open — structurally, possibly permanently
**Blocks:** Nothing. It decays into a credibility problem instead, which is worse than a
blocker because there is no point at which it forces a decision
**Owner:** rohansx
**Raised:** 2026-08

Every done-spec predicate is satisfiable more cheaply than the thing it was written to stand
for. Is there any version of the DSL, the probe engine, or the surrounding social layer that
closes that gap — or is the gap permanent and the correct move to state it plainly?

**Why it is hard:** This is the deepest tension in the product, and both halves are true at
once. The product's value comes from *nothing being self-reported* — a machine checks external
state, so the outcome is not the user's opinion. But the machine only ever checks the
predicate the user wrote. `git tag v0.2.0 && git push --tags` satisfies a release spec in
seconds. A 3KB "coming soon" page satisfies a length floor. `commits.count >= 20` is twenty
whitespace commits. The full attack table is [`security.md`](./security.md) T-04.

The mitigations that exist raise the cost and do not close the gap:

| Mitigation | Raises cost | Does not stop |
|---|---|---|
| Semantic templates (content + length floors) | seconds → minutes | A ten-minute artifact that satisfies the template honestly |
| `> commit_time` freshness clause | free → must act after committing | Anything actually done after the commit, however small. Still the highest-value single mitigation |
| Novelty check vs. commit-time baseline | — | Any change that is not byte-identical |
| Probe class floor ([DSL §7](./spec/done-spec-dsl.md)) | — | A motivated user sitting just above the floor forever |
| Witness co-sign for `weak` specs | minutes → needs a colluding human | Genuine collusion ([`security.md`](./security.md) T-02) |

The honest architectural position, and the one the receipt format already states
([receipt-format §1](./spec/receipt-format.md)):

> pledge proves that **a stated condition became true after you promised it would**. It does
> not prove the condition was a fair test of the thing you claimed.

That is a strictly weaker claim than the marketing instinct wants to make, and it is the
correct one. Overstating it is how one viral counter-example retroactively voids every outcome
on the site.

**Options:**

| Option | Consequence |
|---|---|
| Accept the gap and be transparent about it — spec source always visible, verifier prints the scope limit, landing page never claims more | Keeps adoption. Product's defence becomes *transparency of scope*, not prevention. Loses anyone who wanted a hard credential |
| Require witness co-sign for every commitment | Closes solo gaming. Kills adoption — the ask goes from "write a spec" to "write a spec and recruit a human", and re-imports StickK's referee problem at 100% coverage instead of at the margin |
| Scope review by cohort organizers before a commitment counts toward a cohort report | Plausible where an organizer already exists and is already paid. Doesn't generalise to individual use, adds organizer workload, makes the organizer the arbiter of "real work" |
| Weight calibration by probe class — `strong` specs count more than `standard` | Cheap, already has the taxonomy from the DSL. Turns the class floor into a gradient rather than a cliff. Doesn't close the gap; makes padding less profitable |
| Post-hoc scope flagging by readers | Crowdsources the judgement pledge cannot automate. Introduces a brigading surface and a moderation burden that does not exist today |

**Leaning:** Accept and be transparent (option 1), with option 4 as a cheap addition because
the taxonomy already exists and weighting costs almost nothing. Options 2 and 3 are both
"solve it with humans", and the honest reading of that is that it moves the trust problem
rather than solving it.

**Design rule that follows, and it is not optional:** never render a `kept` badge without its
spec source reachable in one click. A context-free green check *is* the attack surface — it is
the artifact that carries an implied claim the system cannot support. This rule binds the
profile, the cohort board, the README badge, and the receipt viewer equally.

**Decision deadline:** None, and that is the danger. Nothing breaks on a date; the cost
accrues as unearned credibility until someone publicly demonstrates a cheap `kept`. The
practical deadline is *before the first badge is embeddable* — that is the moment a `kept`
starts travelling without its spec attached.

---

## Q-03 · Does the evaluator side ever materialise?

**Status:** Open
**Blocks:** Nothing directly. It determines whether pledge is a **credential** or a **personal
instrument** — two different products with two different roadmaps
**Owner:** rohansx
**Raised:** 2026-08

Do the people pledge assumes will *read* records — accelerator reviewers, hiring managers,
fellowship committees, hackathon judges — ever actually read them?

**Why it is hard:** Credentials are two-sided markets and the supply side stops producing when
nobody reads. That much is standard. The sharper diagnosis is that the demand-side problem is
not the one the product is built to solve:

> Evaluators do not lack **verification**. They can read the code, use the product, or talk to
> the person for twenty minutes — and for a single candidate that is cheap and better than any
> badge. What they lack is **attention at volume**: 400 applications, 90 seconds each.

pledge only fixes the attention problem if it is already ubiquitous enough that its absence is
informative. That is a chicken-and-egg condition, and it is the same condition every credential
startup has failed on.

**Options:**

| Option | Consequence |
|---|---|
| Bet on receipts having standalone utility — README badge, attachment on an application, link in a DM — so the product survives zero evaluator adoption | Removes the dependency entirely. The receipt is useful the moment one person looks at it, which is a much lower bar than an evaluator market. Ceiling is lower too: a nice artifact, not a credential |
| Pursue cohort organizers as the first evaluators | Strongest near-term path. They are already the paid unit ([`product-overview.md` §6](./product-overview.md)), they already need a post-event report they currently cannot produce, and their read of participants is exactly the volume-attention problem. Risk: organizer demand may not generalise to hiring |
| Drop the credential framing entirely; sell calibration as a personal or team estimation instrument | Honest fit with the differentiator — the forecast is valuable with an audience of one. Smaller story, probably a smaller business, and it makes most of the anchoring layer decorative |
| Build for evaluators directly — reviewer dashboards, ATS integration, applicant filtering | Expensive, and it is the classic mistake: building the demand-side surface before demand exists |

**Leaning:** Undecided between options 1 and 2, and they are not mutually exclusive — organizers
are the paid wedge, receipts are the fallback that makes zero evaluator adoption survivable.
Option 4 is ruled out for now. The important part is that **the fallback is real**: a receipt
is useful standalone, so this question resolving badly shrinks the product rather than ending
it.

**Decision deadline:** After v3 ships cohorts and two or three real events have run. Deciding
earlier means deciding without evidence, and the evidence — do organizers reuse the report,
does anyone click a receipt link — is exactly what v3 produces.

---

## Q-04 · Is the commit ritual too high-friction to ever reach commitment #1?

**Status:** Open
**Blocks:** Nothing today. It is the single most likely reason the product fails
**Owner:** rohansx
**Raised:** 2026-08

pledge asks for a deliberate, declarative act *before* the work, from a person volunteering to
be judged on the result. Will anyone do that more than once?

**Why it is hard:** The ask is close to the highest-friction thing a tool can request, and the
comparison case is brutal. GitHub's green squares work because the record is a **byproduct** of
the work — you do not decide to produce a contribution graph, it accumulates. pledge inverts
that: the record requires a separate act of will, taken at the moment of least information,
with a downside attached.

Then the self-selection problem compounds it: the people willing to publicly pre-commit are
already the people who ship — and they already have the artifact, which is the credential.
The population that most needs the calibration feedback is the population least likely to
perform the ritual.

**Options:**

| Option | Consequence |
|---|---|
| Keep the explicit ritual; reduce friction inside it (templates, one-line specs, sensible deadline defaults) | Preserves the pre-commitment moment, which is where the forecast intervention lives. Friction goes from high to slightly-less-high; the fundamental ask is unchanged |
| **Derive commitments passively** from planning artifacts users already produce — GitHub milestones with due dates, issues with deadlines, Linear cycles, project-board targets — making pledge an observer rather than a ritual | Fixes friction, adverse selection, and calibration cold-start in one move. Opens the team/B2B market, where estimate-vs-actual pairs already exist in bulk and nobody has to be recruited into a ritual. **Loses the pre-commitment moment** — see counter below |
| Hybrid: derive passively, prompt for an explicit forecast at derivation time | Attempts both. Risks being a notification tax on a workflow the user did not opt into, which is a worse first impression than a ritual they chose |
| Cohort-only commitments — the ritual happens once, at event registration, and the organizer supplies the deadline | Friction moves to the organizer, who is already motivated. Only works inside events; no path to individual use |

**The counter-argument to option 2, at full weight:** passive derivation loses the moment where
the user picks a date — and that moment is where the forecast renders, which is the entire
behavioural intervention and the product's differentiator
([`architecture.md` §6.1](./architecture.md), [`calibration.md`](./calibration.md)). A
milestone scraped from GitHub already has a date on it. Showing "you will probably slip this by
2.3x" after the fact is a report, not an intervention. Option 2 could fix adoption and gut the
thing worth adopting.

**Leaning:** Undecided, honestly. Option 2 is the strongest single answer to the most likely
failure mode and it has to be taken seriously; the counter-argument is not rhetorical.

**One piece of structural evidence, worth stating because it lowers the cost of being wrong:**
per [`architecture.md` §13](./architecture.md), if the answer turns out to be passive
derivation, the commit flow (§6.1) changes and **§6.2–6.5 — probe, resolve, anchor, verify —
survive intact.** The seams are in the right place. This question can be answered late without
throwing away the system.

**Decision deadline:** After v1 has ~20 real commitments from people who are not the author.
The forcing signal is the second-commitment rate: if users who commit once do not come back,
the ritual is the problem and option 2 is not optional.

---

## Q-05 · Bad-faith probing of third-party targets

**Status:** Open
**Blocks:** Public launch
**Owner:** rohansx
**Raised:** 2026-08

Someone commits to a done-spec whose target is a site they do not own, at 5-minute intervals,
in bad faith — using pledge as a scheduled nuisance-request generator aimed at a competitor.

**Why it is hard:** The rate-limiting controls in [`security.md`](./security.md) T-07 bound
*volume* — per-account caps, a per-target-host global cap across all accounts, an identifiable
UA, a fixed egress IP, a documented block path. None of them address *intent*, and volume that
is harmless in aggregate can still be targeted harassment. Meanwhile, probing hosts the
committer does not own is not an edge case to be designed out: "did the vendor ship the API
they promised" is a legitimate commitment shape, and requiring ownership everywhere would
delete it.

**Options:**

| Option | Consequence |
|---|---|
| Domain verification (DNS TXT record or well-known path) required for **high-frequency** probing of unverified hosts; unverified targets fall back to a low-frequency schedule | Keeps third-party targets legal at low rates, removes the amplification. Costs precision at the deadline boundary for unverified hosts — `resolved_at` gets coarser ([`architecture.md` §6.2](./architecture.md) earliest-observed rule) |
| Domain verification required for **all** third-party targets | Simple to reason about. Kills the "did the vendor ship" commitment shape entirely |
| No verification; rely on rate limits, abuse reports, and blocklisting | Cheapest today. Puts pledge in the position of running an unaccountable crawler and responding to complaints after the harm |
| Allowlist of probe-able third-party hosts | Unmaintainable, and arbitrary at the edges |

**Leaning:** Option 1. Domain verification for high-frequency probing of unverified hosts. It
targets the actual amplification vector — the final-hour 5-minute schedule — while leaving
low-rate third-party probing intact, and DNS TXT / well-known verification is a solved,
cheap-to-implement pattern.

**Decision deadline:** Before public launch. This is on the cross-cutting gate list in
[`roadmap.md`](./roadmap.md); it does not block development, but the first bad-faith user is a
legal and reputational problem that arrives without warning.

---

## Q-06 · Evidence blob retention and takedown

**Status:** Open
**Blocks:** Public launch
**Owner:** rohansx
**Raised:** 2026-08

Probes archive third-party response bodies as evidence. Those bodies may contain personal data,
copyrighted content, or material the target considers private. What is retained, for how long,
and how does someone get it removed?

**Why it is hard:** Evidence is what makes a resolution inspectable rather than asserted — a
reader who cannot see what the probe saw is back to trusting pledge. But archiving arbitrary
third-party pages makes pledge a small unaccountable web archive with all the obligations that
implies.

**The design property that makes this cheap, and it is worth stating explicitly:** verification
depends on the **body hash**, not the blob
([receipt-format §2.1](./spec/receipt-format.md)). Deleting a blob never invalidates a receipt.
Compliance costs storage, not credibility — which is a genuinely unusual position to be in and
should be used.

**Options:**

| Option | Consequence |
|---|---|
| 400-day retention, blobs served from a separate origin, `noindex`, non-enumerable, documented takedown path, never archive from a host returning `X-Robots-Tag: noarchive` | Bounded exposure, cheap compliance, evidence available for the window that matters. Old resolutions become hash-only — inspectable but not readable |
| Never archive bodies; store only hashes and matched spans | Minimal legal surface. Also minimal evidence: a reader can verify the hash matches nothing they can see, which mostly defeats the point |
| Indefinite retention | Simplest to build. Unbounded legal and storage exposure, and no answer to a takedown request that is not ad-hoc |
| Archive only for targets the committer has domain-verified | Clean rights story, and it composes with [Q-05](#q-05--bad-faith-probing-of-third-party-targets). Third-party evidence becomes hash-only, which is where most of the disputes will be |

**Leaning:** Option 1 — 400 days, separate origin, `noindex`, documented takedown, honour
`X-Robots-Tag: noarchive`. The retention number is a proposal, not a derived figure; it is
chosen to outlast a full annual cycle of cohorts plus a dispute window, and it should be
challenged.

**Decision deadline:** Before the first probe runs against a host the author does not own —
practically, before public launch. Related: [`security.md`](./security.md) T-08 and the privacy
policy gate in [`roadmap.md`](./roadmap.md).

---

## Decision log

| Q | Status | Blocks | Decide by |
|---|---|---|---|
| [Q-00](#q-00--pre-launch-personallegal-clearance) | Open | **Public launch** (hard blocker; development unaffected) | Before the first public artifact — end of v1 |
| [Q-01](#q-01--the-privatepublic-calibration-denominator) | Open ([ADR-0008](./adr/0008-calibration-over-all-visibilities.md) drafted) | `visibility` column with real data; Pro tier | Before the visibility column ships — v2 |
| [Q-02](#q-02--can-a-machine-checkable-spec-ever-distinguish-effort-from-output) | Open, structurally | Nothing. Decays into a credibility problem | Before the first embeddable badge |
| [Q-03](#q-03--does-the-evaluator-side-ever-materialise) | Open | Nothing. Determines credential vs. personal instrument | After v3 and 2–3 real cohorts |
| [Q-04](#q-04--is-the-commit-ritual-too-high-friction-to-ever-reach-commitment-1) | Open | Nothing. Most likely cause of failure | After ~20 non-author commitments in v1 |
| [Q-05](#q-05--bad-faith-probing-of-third-party-targets) | Open | Public launch | Before public launch |
| [Q-06](#q-06--evidence-blob-retention-and-takedown) | Open | Public launch | Before public launch |

Related registers: threat model in [`security.md`](./security.md), phase gates in
[`roadmap.md`](./roadmap.md), decisions already made in [`adr/`](./adr/).
