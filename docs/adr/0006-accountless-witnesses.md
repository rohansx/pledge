# ADR-0006: Accountless witnesses via signed magic link

**Status:** Accepted
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`security.md`](../security.md) (T-02),
[`architecture.md` §4](../architecture.md), [`architecture.md` §13](../architecture.md),
[`technical-spec.md` §9](../technical-spec.md),
[`spec/done-spec-dsl.md` §7](../spec/done-spec-dsl.md),
[`roadmap.md`](../roadmap.md) (phase v1)

## Context

Witnesses exist for one narrow job: `weak`-class specs — a single source with no content
assertion — do not count toward calibration on their own, and a witness co-sign is what lets
them count ([`spec/done-spec-dsl.md` §7](../spec/done-spec-dsl.md)). Beyond that they add human
context to a record that is otherwise entirely machine-observed.

The witness is not a user of pledge and has no reason to become one. They get nothing from the
transaction; they are doing the committer a favour, usually once, usually in under a minute,
usually from a phone. Every signup step placed in front of that favour is a step at which the
favour does not happen. This is not a conversion-rate concern — a witness feature with a 15%
completion rate is a feature that does not exist, and the `weak`-class calibration floor then
silently excludes a whole class of legitimate commitments.

The constraint pulling the other way is the product's core invariant:
[`architecture.md` §1](../architecture.md) — there is **no write path from a user to their own
outcome**. A witness is a human input to a system that is defined by not trusting human inputs
about outcomes. Any design where an accountless caller can reach through a link and produce a
`kept` has quietly reintroduced self-reporting, since nothing about an emailed link proves the
recipient is not the committer.

Build-time also matters. Accounts for witnesses would mean a second onboarding flow, a second
identity model, and profile pages for people who never come back — all in v1, the phase that
already contains the DSL, the ledger, and amendments.

## Decision

Witnesses attest through a **single-use HMAC'd magic link and never create an account**. The
link is scoped to exactly one `witness.id`, expires after 14 days, and permits exactly one
attestation. A witness attestation **can never produce `kept`**. Only a probe produces `kept`
([`architecture.md` §6.3](../architecture.md)). A witness whose verdict contradicts the probe
outcome produces `disputed`, which is a terminal, publicly-rendered display state — not a
workflow, not something an operator quietly clears. Witness identity is public on the profile
next to the attestation, permanently.

That second sentence is the load-bearing one. It is what keeps the no-self-report invariant
intact through the social layer, and it is the reason the weak identity assurance of an
accountless link is tolerable at all: the worst outcome a forged link can produce is a visible
dispute, never a manufactured success.

## Alternatives considered

| Option | Why not |
|---|---|
| **Require a pledge account to witness** | The strongest identity story available: OAuth-verified GitHub handle, a real profile behind the vouch, no link-interception surface, and the witness becomes a potential user — which is a genuine growth argument, since witnesses are by construction people who care about the committer shipping. Rejected on adoption: the witness receives no value and is doing a favour, and signup in front of a favour is where favours die. Worth re-testing if witnessing ever becomes something a user does repeatedly rather than once |
| **GitHub OAuth on the attestation page, no pledge account created** | A real middle path — authenticate the witness's identity without onboarding them, and the vouch is then tied to a verified handle rather than an email the committer typed in. Rejected for v1 on scope and reach: it forces every witness to have a GitHub account (excludes the co-founder, the designer, the organizer), and it is an additional OAuth flow in the phase that already carries the DSL and the ledger. This is the alternative most likely to be revisited |
| **Email reply-to-confirm** (witness replies to the notification, inbound parsing confirms) | Zero clicks, and reply-from-address is a slightly better identity signal than link-possession. Rejected: inbound email parsing is a new attack surface and a new infrastructure dependency, `From:` is trivially spoofable without DMARC enforcement on the witness's domain, and structured verdicts out of free-text replies is its own project |
| **Signed attestations with a witness-held key** | Cryptographically the right answer, and it would make attestations independently verifiable inside the receipt rather than merely recorded. Rejected outright: key management for a person doing a one-minute favour is a non-starter |
| **Drop witnesses entirely** | Tempting, and it would shrink v1. Rejected because it strands `weak`-class specs below the calibration floor with no path up, which pushes users toward writing specs that game the class taxonomy rather than describing their work |

## Consequences

**Good:**
- A witness who has never heard of pledge can attest in one click from an email on a phone. That
  is a v1 exit criterion in [`roadmap.md`](../roadmap.md), stated as such because it is the only
  thing that makes the feature real.
- No second onboarding flow, no witness identity model, no profile pages for non-users.
- The invariant survives the social layer intact. A witness cannot manufacture a success, so the
  whole feature can be wrong without invalidating any `kept` on the platform.
- Attestations are attributable and permanent — the witness's identity sits on the public profile
  forever, which makes a careless vouch cost the voucher something.

**Bad:**
- **Identity assurance is weak.** The link proves possession of an inbox, and the committer chose
  the address. There is no verified handle behind the vouch unless the witness happens to have an
  account already.
- **Link interception is an accepted risk**, stated as such in [`security.md`](../security.md)
  T-02. Anyone with read access to the witness's inbox within 14 days can attest as them.
  Single-use, `witness.id` scoping, and expiry bound the blast radius; they do not eliminate it.
- **Genuine collusion is not mitigated at all.** A committer who asks a friend to vouch gets a
  vouch. This is precisely the honor-system referee failure the product criticises in StickK, and
  the accountless design does not improve on it —
  [`architecture.md` §13](../architecture.md) and [`security.md`](../security.md) T-02 both say so
  in those words, and this ADR does not claim otherwise. Public attribution is a real but partial
  mitigation: it makes the vouch permanent and attached to a name, which raises the social cost
  without changing the mechanics.
- Two humans who both want a `kept` on a `weak`-class spec can produce one. The probe still has
  to pass, so the collusion buys calibration eligibility, not a fabricated outcome — a smaller
  prize, but a real one.

**Neutral:**
- `witness` and `witness_attestation` rows are written by a dedicated handler, not by the general
  route-handler path, so the DB-role and no-`kept`-literal constraints in
  [`architecture.md` §5.3](../architecture.md) apply to it unchanged.
- Non-response is the common case and is not a failure. A witness who never clicks leaves the
  commitment resolving on probe evidence alone, which is the default behaviour anyway.

## Revisit when

- **Witness attestations start gating money.** If a stakes module ships and an attestation can
  release or forfeit funds, the threat model changes entirely — collusion acquires a payoff,
  interception acquires a motive, and accountless attestation is no longer defensible. Require
  verified identity before that feature ships, not after.
- **Attestations start gating cohort outcomes** an organizer pays for. Same argument at lower
  stakes: once a third party is making decisions on a vouch, the vouch needs an identity behind
  it. Escalate to the GitHub-OAuth-without-account option first.
- **A witness attests on more than ~3 commitments.** Repeat witnessing means the account
  objection ("they get nothing, they come once") no longer holds for that person, and the growth
  argument for accounts starts to win.
- **Any observed case of link forwarding producing a contested attestation.** One real instance
  moves this from an accepted risk to a bug.
