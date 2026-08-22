# pledge — Threat Model

**Version:** 1.0
**Status:** Design
**Date:** August 2026

The technical spec covers SSRF in depth because it's the sharpest technical hazard. It is not
the most important threat. This document is the full model, ranked by *damage to the product's
core claim* rather than by CVSS.

**The asset being protected is not user data. It is the credibility of the record.** A
database breach would be bad. A demonstrated case of someone gaming a `kept` outcome and
showing it off would be worse, because it invalidates every other outcome retroactively.

---

## Threat ranking

| # | Threat | Impact on the claim | Status |
|---|---|---|---|
| T-04 | Probe gaming — satisfying the spec without doing the work | **Fatal** | Partially mitigated, structurally open |
| T-05 | Calibration laundering via visibility or trivial commitments | **Fatal** | Open — [Q-01](./open-questions.md), [Q-02](./open-questions.md) |
| T-01 | SSRF via probe targets | Severe (infra compromise → arbitrary record forgery) | Mitigated, must stay mitigated |
| T-06 | Signing key compromise | Severe (silent forgery of any record) | Design specified, not built |
| T-02 | Witness spoofing / collusion | Moderate–severe | Partially mitigated |
| T-03 | Ledger tampering by the operator | Moderate (the thing anchoring exists to prevent) | Mitigated by design |
| T-07 | Probe abuse — pledge as a DDoS amplifier | Moderate (reputational, legal) | Design specified |
| T-08 | Evidence blob PII / copyright exposure | Moderate (legal) | Open |
| T-09 | Account takeover | Standard | Standard mitigations |
| T-10 | Sybil handles inflating a track record | Low | Accepted |

---

## T-04 · Probe gaming

**The central unresolved tension of the product.** Every machine-checkable predicate is
satisfiable more cheaply than the thing it stands for.

### Attacks

| Attack | Example | Cost to attacker |
|---|---|---|
| Empty artifact | `git tag v0.2.0 && git push --tags` satisfies a release spec | seconds |
| Placeholder page | A "coming soon" page returns 200 with 3KB of body | minutes |
| Content stuffing | `text contains "Verify a receipt"` satisfied by a page containing only that string | minutes |
| Commit padding | `commits.count >= 20` met with 20 whitespace commits | minutes |
| Pre-built work | Commit to something already 95% done | free |
| Registry squatting | `npm publish` an empty package at the target version | minutes |

### Current mitigations, honestly rated

| Mitigation | Raises cost from → to | Actually stops |
|---|---|---|
| Semantic templates (content + length floor) | seconds → minutes | Bare status-code fakes |
| `> commit_time` freshness clause | free → must-act-after-committing | Pre-existing artifacts. **The highest-value single mitigation** |
| Novelty check vs. commit-time baseline | — | Byte-identical no-op passes only |
| Probe class floor ([DSL §7](./spec/done-spec-dsl.md)) | — | Excludes `trivial` from calibration |
| Witness co-sign for `weak` class | minutes → needs a colluding human | Solo trivial gaming |
| Raw spec source shown next to every outcome | — | Nothing technically; shifts judgement to the reader |

### What is not mitigated

Nothing above stops a determined actor from building a `standard`-class spec that is
technically satisfied by ten minutes of work. **The DSL cannot distinguish effort from
output, and should not pretend to.**

The honest architectural position:

> pledge proves *that a stated condition became true after you promised it would*. It does
> not prove the condition was a fair test. The receipt format states this explicitly
> ([receipt-format §1](./spec/receipt-format.md)), the verifier prints it, and every
> consuming surface must show the spec source next to the outcome.

The product's defence is transparency of scope, not prevention of gaming. That is a weaker
claim than the marketing instinct wants, and it must not be overstated on the landing page —
overstating it is how a single viral counter-example destroys the whole record.

**Design rule that follows:** never render a `kept` badge without its spec source reachable
in one click. A context-free green check is the vector.

---

## T-05 · Calibration laundering

Two independent variants, both currently open.

### T-05a · Visibility filtering

With Pro private commitments as specified, the attack is: commit everything privately, publish
only what you keep. The published calibration is then computed over a self-selected sample —
which is precisely the self-reporting the product forbids, reintroduced through a paid
feature.

**Proposed fix** ([ADR-0008](./adr/0008-calibration-over-all-visibilities.md)): calibration is
computed over *all* commitments regardless of visibility; the profile displays
`n_public / n_total`; public → private is forbidden. A reader then sees "74% on-time across 35
commitments, 12 shown."

**This must be decided before the visibility column carries real data.** Retrofitting means
recomputing and republishing every score, which is itself a credibility event.

### T-05b · Trivial commitment padding

Committing to easy things with generous deadlines produces a flattering curve.

Mitigations: probe class floor; volume and raw claim text always shown; never a single
context-free number; witnesses can flag scope. All partial. The class taxonomy is a proxy for
effort and a motivated user can sit just above the floor indefinitely.

**Accepted residual risk**, disclosed in the product. The counter-argument that makes this
tolerable: a padded record is *legible as padded* to any reader who looks at the claims, and
the product's entire design forces them to be visible. A record of 40 trivial commitments
reads worse than 8 real ones to the audience that matters.

---

## T-01 · SSRF

Probes fetch attacker-chosen URLs from inside the infrastructure. Full controls in
[`technical-spec.md` §5](./technical-spec.md).

### Controls

1. **Resolve-then-pin.** Custom `undici` dispatcher resolves DNS, validates every returned
   address against blocked ranges, connects to the validated IP. Closes the
   TOCTOU/rebinding window that a hostname-based blocklist leaves wide open.
2. **Blocked ranges:** private, loopback, link-local, unique-local, CGNAT, reserved,
   unspecified — v4 and v6, including v4-mapped-v6 (`::ffff:10.0.0.1`) and NAT64 prefixes.
3. **Manual redirects,** max 3, **full revalidation at every hop.**
4. **https only.** No `file:`, `gopher:`, `ftp:`, `data:`, no credentials in URL.
5. **No ambient credentials.** `http()` probes never carry cookies, tokens, or auth headers.
   `github.*` probes use the App installation token and hit `api.github.com` exclusively —
   never a user-supplied host.
6. **Network egress policy** at the infra layer, not just in code. The worker's egress rules
   deny RFC1918 and the metadata endpoint outright. Defence in depth: the code check is the
   primary control, the network policy is what saves you when the code check has a bug.
7. **Blast radius.** Separate deployment, column-restricted DB role
   ([`architecture.md` §4](./architecture.md)). An SSRF that achieves RCE in the worker still
   cannot read an email address or mint a session.

### Why control 7 is the one that matters

Controls 1–6 will eventually have a bypass — this class of defence always does. Control 7 is
what makes that bypass a contained incident rather than the end of the product. **If a
tradeoff ever forces choosing, keep the isolation.**

### Test corpus (v0 exit criterion)

`127.0.0.1` · `169.254.169.254` · `metadata.google.internal` · `10.0.0.1` · `[::1]` ·
`[::ffff:127.0.0.1]` · `0.0.0.0` · `2130706433` (decimal-encoded) · `0x7f000001` ·
a DNS name resolving to private space · a name with both a public and a private A record ·
a 3-hop redirect ending private · a `Location` header with a `file:` scheme.

---

## T-06 · Signing key compromise

An attacker with the checkpoint signing key can forge a receipt that passes steps 1–2 of
verification. Steps 3–5 still fail unless they can also write to Rekor as pledge — but many
consumers will stop at step 2.

### Controls

- Key lives in a KMS. `anchor-cron` holds the only credential; the web tier cannot reach it.
- The signing operation is scoped: `anchor-cron` can request a signature over a Merkle root,
  not over arbitrary bytes.
- The key's Sigstore certificate is itself in Rekor with an issuance timestamp, so a forged
  receipt claiming to predate the key's existence is detectable.
- **Rotation procedure documented before launch** (roadmap cross-cutting gate). Old keys stay
  published and valid for historical receipts; `key_id` in every receipt makes the mapping
  unambiguous.
- Verifier reports `key_trust: sigstore | pinned` distinctly, so a pinned-key verifier is
  never silently downgraded.

**Residual risk:** a compromise between rotation windows forges records that verify at step 2.
The disclosure procedure is: publish the compromised `key_id`, publish the compromise window,
and mark affected receipts on the site. This should be written before it's needed.

---

## T-02 · Witness spoofing and collusion

Witnesses attest via accountless magic link
([ADR-0006](./adr/0006-accountless-witnesses.md)) — necessary for adoption, and it weakens the
attestation.

| Attack | Control |
|---|---|
| Committer invites a controlled address | Witness identity (email or handle) is **public on the profile**. A reader can see who vouched |
| Link forwarded / replayed | Single-use, `witness.id`-scoped, HMAC'd, 14-day expiry, one attestation per witness, all recorded |
| Link intercepted in transit | Accepted risk of the accountless design. Attestations are non-destructive — a false attestation creates a `disputed`, not a `kept` |
| Genuine collusion | **Not mitigated.** Same failure mode as StickK's referee, which the product criticises |

**Stated honestly** ([`architecture.md` §13](./architecture.md)): witness co-sign
reintroduces the honor-system referee. What pledge adds is that the attestation is
*attributable and permanent* — a name is attached forever. That's a real improvement and not
a solution.

**Design consequence:** a witness attestation must never be able to produce `kept` on its own
for a spec whose probe failed. It can produce `disputed`. Only a probe produces `kept`. This
keeps the no-self-report invariant intact through the social layer.

---

## T-03 · Operator tampering

pledge itself is in the threat model. The entire anchoring layer exists for this.

| Attack | Detection |
|---|---|
| Backdate a commitment | Rekor's integration timestamp bounds when the entry could have existed |
| Alter a resolved outcome | `payload_sha256` mismatch (step 1); chain break (step 3) |
| Delete an embarrassing miss | Chain gap — `entry_hash[n]` no longer folds. Gapless `seq` is verifiable independently |
| Present different histories to different readers | Rekor STH consistency proofs — the split-view attack, step 5 |
| Rewrite before anchoring | **Possible** within the ≤10-minute window. Disclosed, bounded, computable from the receipt |

**Note the scope limit** — [ADR-0005](./adr/0005-defer-rekor-anchoring.md) argues nobody is
currently *asking* whether pledge fabricates records; the live doubt is T-04. This layer is
correct engineering aimed slightly left of the actual question, and it should be sequenced
accordingly.

---

## T-07 · Probe abuse

pledge makes authenticated-looking repeated requests to arbitrary targets. That is a DDoS
amplifier and a nuisance vector.

| Control | Detail |
|---|---|
| Per-account rate limit | Caps commitments and total probe volume per account |
| Per-target-host global limit | Across *all* accounts — 50 users cannot collectively hammer one host |
| Backoff curve | 5-minute intervals only in the final hour, only for the final-hour window |
| `robots.txt` | Honoured for **every** `http()` target today. The narrower "unless domain-verified as owned by the committer" rule depends on domain verification, which is unbuilt — see [Q-05](./open-questions.md) |
| Identifiable UA + fixed egress IP | `pledge-probe/0.1 (+https://pledge.sh/probe)`; an operator can block one IP |
| Public opt-out | `pledge.sh/probe` documents the bot and provides a request-to-block path |
| Abuse response | An unverified target host can be blocklisted; affected commitments become `disputed` with a reason, never silently `missed` |

Open question: someone committing in bad faith to probing a competitor's site. Rate limits
bound the volume; they don't address intent. **Domain verification for high-frequency probing
is the likely answer** — at 5-minute intervals, require the committer to prove control of the
target via DNS TXT or a well-known path. Not built; should be before public launch.

---

## T-08 · Evidence blobs

Archived response bodies from third-party sites may contain personal data, copyrighted
content, or material the target considers private.

Open. Minimum before launch:

- Retention limit (proposal: 400 days, then only the hash survives — verification depends on
  the hash, not the blob, per [receipt-format §2.1](./spec/receipt-format.md)).
- Blobs served from a separate origin, `noindex`, not enumerable.
- Takedown path. Removing a blob does not invalidate any receipt, which makes compliance
  cheap — a real design advantage worth stating.
- Never archive a body from a host that returned `X-Robots-Tag: noarchive`.

---

## T-09 · Account takeover

Standard. GitHub OAuth means GitHub is the trust root; a compromised GitHub account
compromises the pledge profile.

- Sessions via Auth.js, httpOnly, SameSite=Lax, short-lived.
- PATs scoped per account, hashed at rest, revocable, never able to produce `kept`.
- Handle changes are recorded as ledger entries — a profile cannot silently become someone
  else's.
- **A takeover cannot rewrite history.** Ledger entries are immutable, so the worst outcome is
  new false commitments, which are themselves permanently recorded.

---

## T-10 · Sybil handles

Create many handles, keep the flattering one. Cheap under GitHub OAuth.

**Accepted.** The mitigation is inherent: a record's value comes from its length and
continuity, and a fresh handle has neither. A 3-commitment profile is not a credential no
matter how clean. Explicitly displaying account age and commitment volume is sufficient.

Not worth identity verification, which would cost more adoption than the attack costs
credibility.

---

## Review triggers

Revisit this document when any of these change: a new source type in the DSL (new SSRF and
gaming surface); money stakes (turns gaming from reputational to financial fraud — a
different threat model entirely); org/SSO tier (multi-tenant authz becomes real); any
third-party consuming receipts programmatically (their trust assumptions become yours).
