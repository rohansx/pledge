# ADR-0005: Defer Merkle checkpoints and Rekor anchoring past v2

**Status:** Proposed
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`architecture.md` §6.4](../architecture.md),
[`security.md`](../security.md) (T-03, T-04),
[`spec/receipt-format.md` §5](../spec/receipt-format.md),
[`roadmap.md`](../roadmap.md) (phase v2),
[`technical-spec.md` §8](../technical-spec.md)

> **This ADR is Proposed, not Accepted.** It is the most contested decision in the docset and
> the counter-argument in §"Consequences → Bad" is strong enough that a reasonable person lands
> the other way. Nothing downstream should assume this is settled.

## Context

The verification algorithm has five steps ([`technical-spec.md` §8](../technical-spec.md),
[`spec/receipt-format.md` §4](../spec/receipt-format.md)). Steps 1–2 recompute the canonical
payload hash and verify pledge's ed25519 signature. Steps 3–5 walk a Merkle audit path to a
checkpoint root, fetch the Rekor entry, and verify Rekor's signed tree head. Steps 3–5 are what
make the record verifiable *against pledge itself*: they are the answer to "did pledge backdate
or fabricate this."

That question is T-03 in [`security.md`](../security.md), ranked **Moderate**. The threat ranked
**Fatal** is T-04, probe gaming — "does this probe mean anything." T-04 is the live doubt
anybody actually voices when shown the product. [`architecture.md` §13](../architecture.md)
already states the position plainly: the ledger is correct engineering aimed slightly to the
left of the actual question.

The cost side is concrete. [`roadmap.md`](../roadmap.md) calibrates v2 at 2 weeks p50 / ~5 weeks
p80, and names the driver of that tail explicitly: "Merkle audit paths and Rekor integration are
genuinely fiddly." v2 also contains the forecast — the differentiator, the thing without which
pledge is a probe-and-ledger commodity. The roadmap's own sequencing-risk table lists "Rekor
integration consumes v2 and the forecast never ships" as the phase's headline risk. The
dominating constraint is nights-and-weekends build time, and the failure mode being guarded
against is the one where the hardest, least-demanded component eats the phase that was supposed
to deliver the product's reason to exist.

The hash chain itself is not at issue. It is already in v1, it is cheap (`chain_head`
serialisation plus a sha256 per append), and it independently detects deletion and alteration
by anyone who does not also control every subsequent entry.

## Decision

Ship **verification steps 1–2 in v2**: signed receipts, ed25519 at resolution time, the
canonical-JSON payload hash, `npx pledge-verify` validating both offline. Keep the hash-chained
ledger exactly as specified in v1. **Gate Merkle checkpoint construction and Rekor submission
behind an explicit trigger** rather than building them in v2 as scheduled. Until a trigger
fires, every receipt is emitted with `anchor: null`, `anchor_pending: true` — a state the wire
format already defines and the verifier already has to handle
([`spec/receipt-format.md` §5.3](../spec/receipt-format.md)) — and `expected_anchor_by` is
omitted rather than promising a time nothing will honour. The `checkpoint` table and the
`rekor_*` columns ship empty; nothing in the schema changes when anchoring is turned on.

## Alternatives considered

| Option | Why not |
|---|---|
| **Build it all in v2 as specced** | The straightforwardly correct engineering position, and it is what the roadmap currently says. It makes "verifiable" true on day one, closes T-03 permanently, and means no receipt is ever second-class. It is rejected here only on sequencing: the roadmap's own p80 says v2 is ~5 weeks, the anchoring work is the tail, and the forecast is behind it. If v2 came in at p50 this alternative wins outright |
| **Drop cryptographic verifiability entirely** | Cheapest, and defensible for a product whose live doubt is T-04. Rejected: without step 2 there is nothing signed, receipts become screenshots, and the operator becomes the trust anchor — which is the exact structure the product criticises. Signing is cheap; it is only the *anchoring* that is expensive |
| **Anchor to a cheaper timestamping authority** (RFC 3161 TSA, or an OpenTimestamps calendar) | Genuinely cheaper than Rekor for the timestamping half, and OpenTimestamps needs no key custody at all. Rejected as a *substitute*: it timestamps a root without giving a public append-only log, so it defeats backdating but not the split-view attack ([`security.md`](../security.md) T-03), and it puts pledge outside the Sigstore ecosystem that makes `sigstore-js`, cosign, and a future Go verifier free. Worth reconsidering as a stopgap if a trigger fires while build time is still the binding constraint |
| **Anchor, but skip the Merkle tree** — submit every entry hash to Rekor individually | Removes the audit-path code, which is the fiddliest part. Rejected on cost and rate: one Rekor submission per resolution does not amortise, and the whole point of the 10-minute checkpoint is that one anchor covers every user |

## Consequences

**Good:**
- v2 ends roughly two weeks earlier and the calibration forecast — the differentiator — ships
  inside the phase it was scheduled in.
- Receipts still verify offline against a signature. Steps 1–2 already defeat field tampering by
  a third party, which is the tampering a receipt actually encounters in the wild.
- The hash chain, the append-only trigger, and gapless `seq` still make operator deletion
  detectable by anyone who has previously fetched a later entry.
- The `checkpoint` table, `rekor_*` columns, and `anchor_pending` handling all ship regardless,
  so turning anchoring on later is additive rather than a migration.

**Bad:**
- **"Verifiable" is the first word of the product's one-line pitch**
  ([`product-overview.md`](../product-overview.md): *"A verifiable record of what you said you'd
  ship and whether you shipped it"*). With steps 3–5 absent, verifiable means "signed by pledge",
  and pledge is the party with the incentive. That is a materially weaker claim than the pitch
  makes, and shipping the pitch unchanged would be the same overstatement
  [`security.md`](../security.md) T-04 warns against on gaming.
- **The gap in the historical record can never be closed.** This is the strongest argument
  against this ADR and it must not be softened: entries created before anchoring begins can only
  ever be anchored *retroactively*, at which point the Rekor integration timestamp proves when
  they were submitted, not when they occurred. Early adopters — the exact people whose records
  are the launch evidence — would hold receipts permanently weaker than everyone's later ones,
  and no amount of later work fixes it. A two-tier record on a product whose asset is the
  credibility of the record is a real, irreversible cost.
- The OSS receipt format is a distribution channel ([`technical-spec.md` §11](../technical-spec.md)).
  A format whose most interesting half is unimplemented is much less likely to be adopted or
  written about, and adoption is the mechanism by which the format becomes a standard rather
  than a JSON schema in one repo.
- T-03 stays open for the deferral window, and its "rewrite before anchoring" row expands from a
  disclosed ≤10-minute window to an undisclosed indefinite one. That row in
  [`security.md`](../security.md) has to be rewritten honestly if this ADR is accepted.
- Every receipt issued in the window carries `anchor_pending: true` forever, which is a slightly
  dishonest field name for "will not be anchored". If accepted, the verifier's output string in
  [`spec/receipt-format.md` §5.3](../spec/receipt-format.md) must be changed to say
  *not anchored*, not *not yet anchored*.

**Neutral:**
- Key custody for the checkpoint signing key ([`security.md`](../security.md) T-06) is still
  required, because step 2 needs a signing key regardless. Deferral does not remove that
  launch-gate item.
- `anchor-cron` still exists as a deployment target; it just has nothing to submit until a
  trigger fires.

## Revisit when

Any one of these fires. The first two are the honest tests of whether the demand is real; the
third is the case where the cost argument simply evaporates.

- **A third party asks to consume receipts programmatically** — a hackathon platform, an
  accelerator's application form, another tool wanting to read `pledge-verify` output. That is
  the first moment the format's weak half costs a deal.
- **An evaluator asks how they know pledge is not lying.** Not a hypothetical evaluator in a
  design doc — a real one, in a real conversation, unprompted. If this question is never asked,
  the premise of this ADR held.
- **v2's forecast work completes with time to spare** against the p80 in
  [`roadmap.md`](../roadmap.md). Then build anchoring inside v2 as originally specced and mark
  this ADR rejected.
- **The record crosses ~200 resolved public commitments.** The cost of the permanently-unanchored
  prefix grows with every entry; past roughly the point where the aggregate record becomes
  citable, the two-tier problem outweighs the schedule saving and this ADR should be rejected on
  its own terms.
