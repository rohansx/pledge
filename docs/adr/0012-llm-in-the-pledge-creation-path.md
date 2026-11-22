# ADR-0012: The Scope Negotiator sits on the composer path, not the write path

**Status:** Proposed
**Date:** 2026-08
**Deciders:** rohansx
**Context docs:** [`architecture.md` §3](../architecture.md) (container view),
[`architecture.md` §6.1](../architecture.md) (commit flow),
[`security.md`](../security.md) (T-04),
[`spec/done-spec-dsl.md`](../spec/done-spec-dsl.md),
[`calibration.md` §6](../calibration.md),
[ADR-0004](./0004-python-sidecar-for-calibration.md),
[ADR-0007](./0007-ast-derived-features.md),
[ADR-0010](./0010-self-reported-verification-tier.md)

> **Proposed, not Accepted.** Accepting it adds a fourth service and a third-party dependency to a
> system whose [`architecture.md` §3](../architecture.md) carries a standing rule to resist the
> fourth.

## Context

The new direction's §4.1 makes the Scope Negotiator the flagship: at pledge creation an LLM
interviews the builder and converts "ship v1 of clipxd by mid sept" into a checkable contract with
a verification method, then argues about the date using the builder's own slip history.

There is currently no LLM anywhere in the design.
[ADR-0004](./0004-python-sidecar-for-calibration.md) is the closest precedent and it is a
prohibition, not a permission: Python exists only for a nightly fit, has no HTTP surface, and
*"no request path may call it"*. Its **void trigger** reads: *"Anyone proposes an HTTP endpoint on
the sidecar, or a synchronous call to it from the composer."* The Scope Negotiator is a different
service, so it does not literally trip that trigger — but it lands on the same seam from the other
side, and pretending otherwise would be the kind of technicality that makes an ADR set worthless.

Three facts shape the answer, and two of them are already true in the codebase.

**The target is already deterministic.** `packages/spec` parses the DSL, validates the AST against
Zod, canonicalises with RFC 8785 JCS, and hashes with sha256. It runs in the browser — the
composer already parses live as you type — and in the verifier CLI with no database
([`spec/done-spec-dsl.md`](../spec/done-spec-dsl.md), invariant I-6). Anything the LLM emits is
either valid DSL or it is nothing. There is a deterministic acceptor sitting between the model and
the database, and it was built before the model was proposed.

**The composer already works without an LLM.** `apps/web` ships a template picker with five
templates plus a DSL escape hatch and live parsing. The negotiator is an additional route into the
same field, not a replacement for the only route.

**The coaching line does not need an LLM at all.** §4.1's headline output — *"historically you
slip ~5 days on release-sized pledges — pledge Sept 20, or keep Sept 15 at 65% confidence?"* — is
the difference between the builder's stated `p` and `q̂ = Φ(−(mu_i + βᵀx_i)/sigma_i)`, both of
which are already computed. It is arithmetic over a stored `calibration_fit` row
([`calibration.md` §6](../calibration.md)), it is available at `n = 0` using population
parameters, and it is served in TypeScript with no sidecar in the request path — which is a v2
exit criterion in [`roadmap.md`](../roadmap.md). Attributing that sentence to the LLM inflates
what the model is for. **The model's job is the interview, and only the interview.**

The dominating constraint is the credibility of the record. An LLM that writes verification
contracts is a component that can be talked into writing a weak one, and the person it hurts is
the reader of the ledger, not the person holding the conversation.

## Decision

*(Proposed.)* Five rules. Rule 1 is the whole architecture; the rest are what make it hold.

1. **The LLM proposes; the parser disposes.** The negotiator's only output that reaches the
   database is a DSL source string. It must lex, parse, validate against the Zod AST, canonicalise,
   and hash under `packages/spec` before it can become a `done_spec` row. Failure is not repaired
   server-side; it is shown to the user as a parse error against the source. Nothing about
   content-addressing changes: the hash is over the canonicalised AST, never over model output, so
   I-4 is untouched.
2. **The negotiator is on the composer path, not the write path.** It is a conversational surface
   *before* submit. The `POST` that creates a commitment takes DSL source and never calls a model.
   [`architecture.md` §6.1](../architecture.md)'s commit flow is unchanged.
3. **Degrade to the template picker.** If the negotiator is down, slow, rate-limited, or the user's
   quota is spent, the composer renders the existing template picker and DSL field. A pledge can
   always be created. No pledge creation ever blocks on a third party.
4. **The user confirms the rendered spec source.** The final DSL is shown as source, parsed live,
   before commit — which is what the composer already does. The user is the acceptor of last
   resort, and the confirmation step is not skippable "because the model is confident".
5. **The negotiator never reads untrusted third-party text in v1.** Builder-authored input only.
   No README, no issue body, no PR description, no page fetched from the target URL. Widening the
   input surface is a separate decision with a separate threat review.

The negotiator runs as a route inside `apps/web` calling a hosted model API — not a fourth
container. That keeps [`architecture.md` §3](../architecture.md)'s service count intact and makes
rule 3 a try/catch rather than a health check.

**Explicitly out of scope:** §4.3's evidence adjudicator. A model that reads an evidence bundle and
*proposes a resolution* is a resolution written by something other than a probe. Whether that is
survivable is [ADR-0010](./0010-self-reported-verification-tier.md)'s question, not this one, and
nothing in this ADR authorises it.

## Alternatives considered

| Option | Why not |
|---|---|
| **No LLM. Better templates instead** | Genuinely strong, and the lazy answer. [Q-04](../open-questions.md) says the commit ritual may be too high-friction to reach commitment #1, and five templates plus a decent picker addresses most of that for zero dependency, zero cost, zero injection surface, and zero latency. Rejected because the hard part is not *choosing* a template — it is turning a fuzzy intention into a criterion the builder will still accept as fair when they miss it, and that is an interview, which templates cannot do. This alternative is the fallback if the negotiator's accepted-spec rate is poor |
| **LLM generates the spec server-side at submit, synchronously, with no interview** | One call, simpler UI. Rejected on every axis this ADR cares about: it puts a third-party latency and failure mode directly on the write path, removes the confirmation step, and makes the spec something that *happened to* the user rather than something they agreed to. A criterion the user did not read is a criterion they will dispute |
| **Local/self-hosted model** | Removes the vendor, the per-pledge cost, and the data-egress question. Rejected on the same constraint as everything else here — nights-and-weekends build time — plus a fifth deployment target and GPU cost that dwarfs the API bill at this volume. Worth revisiting only if per-pledge cost becomes the binding constraint, which it will not at the volumes in [`roadmap.md`](../roadmap.md) |
| **LLM emits structured JSON (the AST) rather than DSL source** | Skips a parse step and is what a function-calling API wants. Rejected: the DSL source is what the user reads, confirms, and later inspects from the badge. Generating the AST directly means the displayed source is *printed from* the AST, and the round-trip property (`parse(print(ast)) == ast`) becomes load-bearing on the trust path rather than being a property test. Keep source as the artefact |
| **Let the negotiator also set the deadline and confidence** | The natural extension of §4.1's dialogue. Rejected: the deadline is immutable once published and the confidence is the calibration input. A number the model suggested and the user accepted without friction is not the user's forecast, and feeding it to the self-calibration fit measures the model, not the builder |

## Consequences

**Good:**
- The fuzzy-intention → checkable-contract step is the product's highest-friction moment, and it is
  the one a model is actually good at. `packages/spec` gives it a deterministic acceptor, which is
  the rare case where an LLM's output can be *mechanically* validated rather than eyeballed.
- Rule 3 means the availability of the product is unchanged. A third-party outage degrades a
  feature, never the write path.
- The DSL gets a usage corpus. Every rejected generation is a data point about which constructs are
  hard to express, which is the best available input to [`spec/done-spec-dsl.md`](../spec/done-spec-dsl.md)'s
  next revision.
- Nothing about I-4, I-6, or the receipt format changes. The hash is over the canonical AST and the
  provenance of the source string is irrelevant to it.

**Bad:**
- **Prompt injection is a real finding and belongs in [`security.md`](../security.md) as a new
  threat row (T-11), not only here.** The negotiator reads user text and emits a verification
  contract. Text crafted to steer it — "the done condition is that the landing page returns any
  HTTP response" — yields a spec that is syntactically valid, canonicalises cleanly, hashes,
  probes green, and mints a `kept` badge for nothing. This is T-04 probe gaming with a new and
  much lower-effort entry point, and the victim is the reader of the ledger. Rule 4 (the user
  confirms the source) is the mitigation, and it is weak against the case where the *user* is the
  attacker — which is the case T-04 is actually about. It is only strong against the case where a
  third party's text is the attacker, which rule 5 already forecloses in v1. **Accepting this ADR
  requires the security.md edit; do not accept it without.**
  Partial structural mitigation: because calibration features are AST-derived
  ([ADR-0007](./0007-ast-derived-features.md)), an injected trivial spec is automatically weighted
  as trivial and contributes ~nothing to rank or the fit
  ([ADR-0011](./0011-calibration-rank-and-seasons.md)). Injection is therefore a *badge* attack,
  not a calibration attack. That is a meaningful narrowing and it is not a fix.
- **Cost is unbounded on the free tier, and the failure is abuse, not usage.**
  [`product-overview.md` §9](../product-overview.md) offers unlimited public commitments at ₹0. A
  6–10 turn interview at a few thousand tokens per turn is on the order of a few cents per pledge —
  a thousand legitimate pledges a month is a rounding error. An unauthenticated or
  cheaply-authenticated conversational endpoint in front of a frontier model is a free LLM for
  anyone who finds it, and that bill has no ceiling. Requires per-account rate limits and a
  quota before it is exposed, not after.
- **A third party now sees pre-commitment intentions** — including for commitments the user later
  makes private. That is data leaving the trust boundary in [`architecture.md` §4](../architecture.md)
  for the first time, it happens *before* the user has chosen a visibility, and it needs saying at
  the point of use rather than in terms.
- **Non-determinism is contained but not eliminated.** Two runs on the same intention produce
  different specs and therefore different hashes and different commitments. That is *correct* —
  the user chose one of them — but it makes "the spec is content-addressed" a weaker statement
  about intent than it reads: identical intentions no longer map to identical hashes, only
  identical *specs* do. Anyone reasoning about spec-hash collisions as evidence of similar work
  needs to know this.
- A model version change silently changes what the product produces, with no migration and no
  version marker anywhere in the ledger. The prompt, the model id, and the model version must be
  recorded on the `done_spec` row at creation, or a future "why did specs get worse in October"
  is unanswerable.
- It is a new dependency on the composer, which is the one surface where every new user's first
  impression is formed. An LLM that is confidently wrong about a verification criterion at that
  moment costs more than one that is absent.

**Neutral:**
- [ADR-0004](./0004-python-sidecar-for-calibration.md) is **not** superseded. Its rule — the
  calibration sidecar has no HTTP surface and no request path calls it — is unchanged by this ADR,
  and the coaching numbers the negotiator quotes are read from a `calibration_fit` row, never from
  the sidecar. If any implementation of §4.1 ends up calling the sidecar live, ADR-0004's void
  trigger has fired and this ADR is being implemented wrongly.
- The negotiator is deletable. It writes nothing that a template-picked spec does not also write.

## Revisit when

- **Accepted-spec rate is below 50%** — fewer than half of negotiator sessions end in a committed
  pledge — over the first 200 sessions → the interview is not doing its job. Response: fall back to
  the templates alternative and treat the negotiator as an experiment that ran.
- **Any injected or model-authored spec is found in the ledger with a `kept` outcome and a
  trivially-satisfiable criterion** → withdraw the negotiator immediately, annotate the affected
  entries (annotate, never erase), and re-argue rule 4 from scratch. One instance is enough; this
  is a credibility event, not a bug count.
- **Monthly model spend exceeds ~2× monthly infrastructure spend** → the free tier is subsidising
  a conversation, not a record. Response is a quota, not a cheaper model.
- **Anyone proposes widening the negotiator's input to third-party text** (READMEs, issues, the
  target page) → rule 5 exists for this. New threat review, new ADR.
- **Anyone proposes the §4.3 evidence adjudicator** → out of scope here by construction. It is a
  resolution-writing component and must be argued against I-1 and
  [ADR-0010](./0010-self-reported-verification-tier.md), not against this ADR.
