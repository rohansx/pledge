# pledge Receipt — Wire Format Specification

**Format version:** `pledge.receipt.v1`
**Status:** Draft — normative from v2
**Licence:** the format specification is public domain; `pledge-verify` is MIT
**Audience:** anyone consuming pledge attestations. You are not expected to trust pledge, and
this document exists so you don't have to.

---

## 1. What a receipt claims

Exactly this, and nothing more:

> At time `committed_at`, an entity controlling account `handle` published an immutable
> predicate `done_spec`. At time `observed_at`, an observation of external systems evaluated
> that predicate to `outcome`. Both facts were entered into an append-only log at positions
> `seq`, and that log's state at `tree_size` was committed to a public transparency log at
> `log_index` at time `anchored_at`.

Read what that does **not** claim:

- Not that the work was hard, meaningful, or matched the prose in `claim`.
- Not that `handle` corresponds to any legal person.
- Not that the predicate was a good proxy for the promise.

A verifier that reports "VERIFIED" is reporting that pledge did not fabricate or backdate the
record. Whether the record is *worth* anything is a judgement the reader makes from
`done_spec.source`, `probe_class`, and the evidence — all of which are in the receipt
precisely so that judgement is possible.

This section is normative for implementers of consuming UIs: **do not render a receipt as a
green checkmark alone.** Render the spec source next to it.

---

## 2. Document

```json
{
  "format": "pledge.receipt.v1",
  "issuer": "https://pledge.sh",

  "commitment": {
    "id": "01J8ZK9Q0000000000000000",
    "handle": "rohansx",
    "claim": "v0.2 released with Kaggle T4 autoscaling",
    "committed_at": "2026-08-25T09:14:22Z",
    "deadline_original": "2026-09-05T18:29:00Z",
    "deadline_effective": "2026-09-05T18:29:00Z",
    "visibility": "public",
    "cohort_slug": null
  },

  "done_spec": {
    "spec_version": 1,
    "hash": "sha256:9c1f8e...",
    "source": "github.release(\"rohansx/tethr\").tag matches \"v0.2.*\"",
    "probe_class": "standard"
  },

  "outcome": {
    "status": "kept",
    "resolved_at": "2026-09-04T14:21:07Z",
    "resolved_by": "probe",
    "days_estimated": 11.4,
    "days_actual": 10.2,
    "slip_ratio": 0.895,
    "unchanged_since_commitment": false
  },

  "amendments": [],

  "evidence": [
    {
      "source": "github:release:rohansx/tethr",
      "observed_at": "2026-09-04T14:21:07Z",
      "resolved_ip": "140.82.121.6",
      "status": 200,
      "headers": { "content-type": "application/json", "etag": "W/\"a1b2\"" },
      "body_sha256": "sha256:4f2a91...",
      "body_bytes": 3312,
      "matches": [{ "op": "matches", "pattern": "v0.2.*", "value": "v0.2.1" }],
      "blob_url": "https://ev.pledge.sh/ev/2026/09/04/0a1b….json"
    }
  ],

  "attestations": [],

  "ledger": {
    "entry_seq": 84713,
    "entry_hash": "sha256:7de0...",
    "prev_hash": "sha256:11bc...",
    "payload_sha256": "sha256:c3f1...",
    "audit_path": [
      { "side": "right", "hash": "sha256:aa11..." },
      { "side": "left",  "hash": "sha256:bb22..." }
    ],
    "checkpoint": {
      "merkle_root": "sha256:e91d...",
      "tree_size": 84960,
      "signed_at": "2026-09-04T14:30:00Z"
    }
  },

  "anchor": {
    "log": "rekor.sigstore.dev",
    "log_index": 84713221,
    "uuid": "24296fb2...",
    "integrated_at": "2026-09-04T14:30:11Z"
  },

  "signature": {
    "alg": "ed25519",
    "public_key": "MCowBQYDK2VwAyEA...",
    "key_id": "sha256:0d3c...",
    "value": "base64:1a2b3c..."
  }
}
```

### 2.1 Field rules

| Field | Rule |
|---|---|
| `format` | Exact string match. A verifier MUST reject unknown values rather than guessing |
| `issuer` | Informational. **MUST NOT** be fetched during verification (§4.1) |
| `deadline_original` vs `deadline_effective` | Differ iff `amendments` is non-empty. A consumer showing only one MUST show `original` |
| `outcome.resolved_by` | `"probe"` \| `"witness"` \| `"withdrawal"`. Pairing is constrained, and a verifier MUST reject violations: `kept` and `missed` require `"probe"` — **no other value may accompany them**; `"witness"` may accompany only `disputed`; `"withdrawal"` only `abandoned`. A `missed` produced by the authoritative deadline+0 run is still `"probe"`, because it rests on an observation that the done-condition was false ([`../architecture.md` §6.3](../architecture.md)) |
| `outcome.days_actual` | `null` when `status ∈ {missed, abandoned}` and no completion was ever observed — this is **right-censored**, not zero. See §6 |
| `evidence[].blob_url` | Convenience only. Verification uses `body_sha256`; a dead blob URL does not invalidate a receipt |
| `anchor` | `null` with `"anchor_pending": true` when the receipt predates its checkpoint (§5.3) |
| `attestations[]` | Present only for witness-involved outcomes; each carries its own `ledger_seq` |

All timestamps are RFC 3339 in **UTC with a literal `Z`**. All hashes are
`"<alg>:<lowercase-hex>"`. All binary values are unpadded base64url.

---

## 3. What is signed

The signature covers a **canonical subset**, not the whole document. Fields outside the
subset (`issuer`, `blob_url`, `anchor`, anything added in a later minor revision) can change
without invalidating a signature.

```
signed_bytes = "pledge.receipt.v1\x00" || JCS(subset)

subset = {
  commitment: { id, handle, claim, committed_at,
                deadline_original, deadline_effective, visibility, cohort_slug },
  done_spec:  { spec_version, hash, source, probe_class },
  outcome:    { status, resolved_at, resolved_by,
                days_estimated, days_actual, slip_ratio,
                unchanged_since_commitment },
  amendments: [ { kind, old_value, new_value, reason, created_at, ledger_seq } ],
  evidence:   [ { source, observed_at, resolved_ip, status, headers,
                  body_sha256, body_bytes, matches } ],
  attestations: [ { witness_ref, verdict, note, signed_at, ledger_seq } ],
  ledger:     { entry_seq, entry_hash, prev_hash, payload_sha256 }
}
```

JCS is RFC 8785. Array order is significant and MUST be preserved: `evidence` in canonical
AST source order, `amendments` and `attestations` by ascending `ledger_seq`.

The domain-separation prefix is mandatory. Without it a receipt signature and a checkpoint
signature could theoretically be confused, and this is free to prevent.

---

## 4. Verification algorithm

Five steps. Steps 1–2 are **required**; 3–5 are required only when `anchor` is non-null.

### 4.1 Rules for any conforming verifier

Three non-negotiables:

- **Never contact `issuer`.** Everything needed is in the receipt plus the public log. A
  verifier that phones home has recreated the trust dependency the format exists to remove.
- **Fail closed.** Unknown `format`, unknown `alg`, malformed hash, or an unrecognised
  `status` is a rejection, not a warning.
- **Report each step separately.** "VERIFIED" as a single boolean discards the distinction
  between a signed-but-unanchored receipt and a fully anchored one, and those mean genuinely
  different things.

### 4.2 Steps

**1 — Recompute the payload hash.** Extract the subset from §3, serialise with JCS, prefix,
sha256. Compare to `ledger.payload_sha256`. *Detects: any tampering with claim, spec,
outcome, evidence, or amendment history.*

**2 — Verify the signature.** Verify `signature.value` over `signed_bytes` with
`signature.public_key`. Confirm `key_id == sha256(public_key)`. Then confirm the key is a
pledge signing key — by its Sigstore certificate, itself logged in Rekor, chaining to the
Fulcio root. *Detects: a forged receipt from a non-pledge key.*

> A verifier MAY accept a pinned public key instead (air-gapped use). It MUST then report
> `key_trust: "pinned"` rather than `"sigstore"`.

**3 — Walk the audit path.** Starting from `ledger.entry_hash`, fold each `audit_path`
element per RFC 6962 §2.1 in order, respecting `side`. The result MUST equal
`ledger.checkpoint.merkle_root`. *Detects: an entry that is not actually in the log — i.e. a
receipt for a commitment pledge never recorded.*

**4 — Fetch the Rekor entry** at `anchor.log_index`. Confirm the logged body commits to
`ledger.checkpoint.merkle_root` and `tree_size`. *Detects: a checkpoint pledge signed but
never published — the backdating attack.*

**5 — Verify Rekor's signed tree head**, and confirm the entry's inclusion in the current
STH. *Detects: a compromised or split-view log.*

### 4.3 Output

```
$ pledge verify receipt.json
ok  payload hash matches ledger entry            (step 1)
ok  ed25519 signature valid, key trusted via Sigstore
    key_id sha256:0d3c… logged to Rekor 2026-08-01T00:00:00Z
ok  inclusion proof: entry 84713 → root e91d… (tree_size 84960)
ok  Rekor entry 84713221 commits to that root, integrated 2026-09-04T14:30:11Z
ok  Rekor signed tree head valid

    handle           rohansx
    claim            "v0.2 released with Kaggle T4 autoscaling"
    done when        github.release("rohansx/tethr").tag matches "v0.2.*"
    probe class      standard
    committed        2026-08-25T09:14Z    deadline 2026-09-05T18:29Z (never amended)
    RESULT           kept — observed 2026-09-04T14:21Z, 1.2 days early

    note: this proves the record is authentic and was not backdated.
          it does not judge whether the done-spec was a fair test of the claim.
```

That closing note is part of the specified output. Verifiers SHOULD print an equivalent.

---

## 5. Timing, anchoring, and honest gaps

### 5.1 The three timestamps

`resolved_at` < `checkpoint.signed_at` ≤ `anchor.integrated_at`. A verifier MUST reject a
receipt where these are out of order.

### 5.2 Anchoring lag

Checkpoints are built every 10 minutes ([`architecture.md` §6.4](../architecture.md)). The
window between resolution and anchoring is a real, bounded gap during which pledge could
theoretically alter an entry. It is disclosed rather than hidden: the receipt carries both
timestamps and the lag is computable.

### 5.3 Unanchored receipts

```json
"anchor": null,
"anchor_pending": true,
"expected_anchor_by": "2026-09-04T14:40:00Z"
```

Steps 1–2 still apply and still mean something: the record is signed by pledge and internally
consistent. Steps 3–5 are skipped, and the verifier MUST report:

```
--  not yet anchored (expected by 2026-09-04T14:40Z)
    this receipt is signed but not yet independently timestamped.
    re-fetch after the expected time for full verification.
```

### 5.4 What a receipt cannot prove

Enumerated so no consuming UI overstates it:

- That the observed external state was *caused* by the committer's work.
- That the target wasn't a placeholder — see `unchanged_since_commitment`, which is a hint,
  not a proof.
- That an unresolved commitment ever completed (`days_actual: null`, §6).
- That `handle` maps to a person, or that one person controls only one handle.

---

## 6. Censored outcomes

`days_actual: null` on a `missed` or `abandoned` receipt means **the completion was never
observed**, not that it took zero days and not that it never happened. Formally: the true
duration is right-censored at `resolved_at`.

Any consumer computing statistics across receipts MUST treat these as censored observations.
Dropping them biases every derived figure optimistic, which is exactly the bias pledge exists
to correct — and a third party computing "average slip from public receipts" by ignoring the
nulls would publish a number that is wrong in pledge's favour. See
[`calibration.md`](../calibration.md) §4.

`outcome.censored: true` is emitted alongside `days_actual: null` to make this
unmissable for implementers who skim.

---

## 7. Extension and versioning

- **Additive only within `v1`.** New optional fields outside the signed subset MAY appear. A
  verifier MUST ignore unknown fields outside the subset and MUST reject unknown fields
  *inside* it.
- Any change to the signed subset, JCS profile, hash algorithm, or verification steps → new
  `format` string. There is no negotiation and no downgrade.
- `pledge.receipt.v1` verification support is permanent. The verifier keeps every version's
  code path; it is a few hundred lines and its permanence is the point.

## 8. Reference implementation

`packages/verify` — `npx pledge-verify <file|url>`. Dependencies: `@noble/ed25519`,
`@noble/hashes`, `sigstore-js`, and a JCS implementation. No pledge-specific network access.

Conformance vectors live in `packages/verify/fixtures/`: a valid anchored receipt, a valid
unanchored one, a censored `missed`, an amended commitment, a `disputed` outcome carrying a
witness attestation, a receipt whose `resolved_by` violates the §2.1 pairing rule, and
one deliberately tampered instance per signed field. A third-party implementation is
conforming if it agrees on all of them.
