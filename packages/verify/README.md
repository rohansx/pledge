# pledge-verify

Offline verification of a pledge receipt. The reference implementation of
[`docs/spec/receipt-format.md`](../../docs/spec/receipt-format.md) §4, **steps 1–2**.

```
npx pledge-verify receipt.json
npx pledge-verify receipt.json --key packages/verify/fixtures/fixture-key.pub
curl -s https://example.com/receipt.json | npx pledge-verify -
```

Exit codes: `0` verified, `1` rejected, `2` could not read the input.

## What it checks, and what it refuses to claim

| Step | Status |
|---|---|
| 1 — canonical hash | implemented: the §3 signed subset is rebuilt, canonicalised with RFC 8785 JCS, prefixed with `pledge.receipt.v1\x00`, and the receipt's ledger triple is refolded with the chain formula |
| 2 — ed25519 signature | implemented, over exactly those bytes; `key_id` is confirmed against `sha256(public_key)` |
| 3 — inclusion proof | **not performed.** v2 |
| 4 — transparency log entry | **not performed.** v2 |
| 5 — signed tree head | **not performed.** v2 |

Steps 3–5 are reported every run, as `not performed`, with the reason. They are never omitted
and never reported as passed, because a signed-but-unanchored receipt and a fully anchored one
are different claims (§4.1). Anchoring does not exist in v1, so **every** receipt today is
unanchored: signed, internally consistent, and **not independently timestamped**.

Three rules this tool will not break:

- **It never contacts the issuer.** No fetch, no DNS, no `issuer` lookup — a URL argument is
  refused with an explanation rather than downloaded. A verifier that phones home has
  recreated the trust dependency the receipt format exists to remove.
- **It fails closed.** Unknown `format`, unknown `alg`, malformed hash, unrecognised `status`,
  an unknown field inside the signed subset, a §2.1 pairing violation, or a `censored` flag
  that disagrees with what it is derived from — all rejections, never warnings.
- **It reports each step separately.** There is no single `VERIFIED` boolean.

It also prints §4.3's scope limit, every time: verification says the record is authentic. It
says nothing about whether the done-spec was a fair test of the claim. Judge that from
`done_spec.source` and the evidence, both of which are in the receipt so that you can.

## Key trust

`key_trust: none` is the honest default: the signature verifies against the key the receipt
carries, which proves internal consistency and nothing about who issued it. Pass `--key` with
the SPKI base64 you expect (or a file containing it) to get `key_trust: pinned`. Sigstore
certificate chaining — the second half of §4.2 step 2 — needs the anchoring work that
[ADR-0005](../../docs/adr/0005-defer-rekor-anchoring.md) has not accepted yet.

## Fixtures

`fixtures/` holds the conformance vectors (§8): a valid `kept`, a censored `missed`, an amended
commitment, a `disputed` carrying a witness attestation, one that violates the §2.1 pairing
rule while being correctly signed, and `fixtures/tampered/` — one receipt per field of the
signed subset, each with exactly that field edited and the original signature left in place.
Every one of them must fail. Regenerate with `pnpm --filter pledge-verify fixtures`; the output
is byte-identical unless the format changed, and a format change is a new `format` string.

## Notes for implementers

- **§4.2 step 1 cannot be implemented as written.** It says to compare a hash of the signed
  subset to `ledger.payload_sha256`, but §3 puts `ledger.payload_sha256` *inside* the subset,
  so no such value can exist. This implementation follows §3: `ledger.payload_sha256` is the
  ledger entry's payload hash — the value in `ledger_entry.payload_sha256`, cross-checkable
  against the public per-account ledger — and step 1 verifies that the ledger triple folds to
  `entry_hash` under the chain formula. See the header of `src/verify.ts`.
- Running the CLI needs Node ≥ 22.18 (`bin` is TypeScript, stripped at load). Within this
  workspace it resolves `@pledge/ledger` from source; publishing to npm needs that dependency
  vendored or bundled first.
