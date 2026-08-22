# done-spec DSL — Language Specification

**Spec version:** 1
**Status:** Draft — normative from v1
**Package:** `@pledge/spec` (MIT)
**Stability:** Once `spec_version = 1` ships, its evaluation semantics are frozen forever.
Commitments always evaluate under the rules in force when they were made.

---

## 1. What this language is for

A done-spec is a **predicate over external observable state**, authored before the work
starts, hashed, and never changed. The hash is the contract. If the hash changes, it is a
different commitment.

Design constraints, in priority order:

1. **Total.** Every expression terminates. No loops, no recursion, no user-defined functions.
2. **Pure and observation-only.** Evaluation performs read-only network I/O and nothing else.
   No writes, no side effects, no state carried between runs except the commit-time baseline.
3. **Deterministic given observations.** Two evaluators with the same observed responses must
   produce the same boolean and the same evidence record.
4. **Readable by a non-author.** An evaluator reading a profile must be able to tell what was
   promised without running anything. This rules out regex-heavy or point-free designs.
5. **Small.** The grammar below is roughly the maximum size that stays auditable. Resist
   growth; add templates instead of syntax.

Users mostly never write this. They pick a template. The DSL exists so that the template's
meaning is *inspectable* and the escape hatch is *possible*.

---

## 2. Grammar

EBNF. Chevrotain implements this directly.

```ebnf
spec        = expr ;

expr        = or_expr ;
or_expr     = and_expr { "or" and_expr } ;
and_expr    = not_expr { "and" not_expr } ;
not_expr    = [ "not" ] primary ;
primary     = comparison
            | "(" expr ")"
            | combinator ;

combinator  = ( "all" | "any" ) "(" expr { "," expr } [ "," ] ")" ;

comparison  = accessor comp_op literal
            | accessor ;                    (* bare accessor must be boolean-typed *)

comp_op     = "==" | "!=" | ">" | ">=" | "<" | "<="
            | "contains" | "matches" | "starts_with" | "ends_with" ;

accessor    = source { "." field } { call } ;

source      = "http"     "(" string ")"
            | "github"   "." gh_source
            | "npm"      "(" string ")"
            | "crates"   "(" string ")"
            | "pypi"     "(" string ")"
            | "dns"      "(" string ")" ;

gh_source   = "release"  "(" string ")"
            | "pr"       "(" string "," integer ")"
            | "issue"    "(" string "," integer ")"
            | "commits"  "(" string ")"
            | "file"     "(" string "," string ")"
            | "workflow" "(" string "," string ")" ;

call        = "." ident "(" [ arg { "," arg } ] ")" ;
arg         = literal | "commit_time" | "deadline" ;

field       = ident ;
literal     = string | integer | decimal | boolean | version ;
version     = "v"? digit { digit | "." | "-" | ident } ;   (* semver-ish, string-compared
                                                              unless both sides parse as semver *)
string      = '"' { char } '"' ;                            (* no interpolation, ever *)
ident       = letter { letter | digit | "_" } ;
```

**Deliberately absent:** variables, let-bindings, arithmetic, user functions, lambdas, string
concatenation, arbitrary regex (see §4.3), time arithmetic beyond the two named instants.

---

## 3. Sources and fields

Each source produces one **fetch** per evaluation run, memoised. Accessing `.status` and
`.text` on the same `http()` URL costs one request.

### 3.1 `http(url)`

| Field | Type | Notes |
|---|---|---|
| `.status` | int | final status after ≤3 manual redirects |
| `.text` | string | body decoded as UTF-8, replacement chars on invalid bytes |
| `.text.length` | int | length in **bytes**, not code points |
| `.header(name)` | string | lowercased name; only from the whitelist in §6.2 |
| `.final_url` | string | after redirects; comparing this catches parking-page redirects |
| `.json(path)` | string \| int \| bool | JSON pointer (RFC 6901). Errors if body isn't JSON |

`url` must be `https://` (or `http://` only for `.onion`, which is rejected anyway by the
SSRF layer — so effectively https-only).

### 3.2 `github.*`

Authenticated through the pledge GitHub App installation. Never through a user's token — an
observation made with the committer's own credentials is not an external observation.

| Source | Fields |
|---|---|
| `github.release("owner/repo")` | `.tag`, `.name`, `.body`, `.published_at`, `.is_prerelease`, `.asset_count` |
| `github.pr("owner/repo", n)` | `.state` (`open`/`closed`/`merged`), `.merged_at`, `.additions`, `.deletions`, `.review_count` |
| `github.issue("owner/repo", n)` | `.state`, `.closed_at`, `.label_names` |
| `github.commits("owner/repo")` | `.count`, `.latest_sha`, `.latest_at` — with `.since(t)`, `.on_branch(s)`, `.by(s)` |
| `github.file("owner/repo", "path")` | `.exists`, `.sha`, `.size`, `.text` |
| `github.workflow("owner/repo", "name")` | `.latest_conclusion`, `.latest_at`, `.success_count` with `.since(t)` |

`github.release(repo)` resolves to the **latest** release. To pin, use `.tag matches "..."`.

### 3.3 Registries

| Source | Fields |
|---|---|
| `npm("pkg")` | `.latest_version`, `.published_at`, `.version_count`, `.unpacked_size` |
| `crates("pkg")` | `.latest_version`, `.published_at`, `.downloads` |
| `pypi("pkg")` | `.latest_version`, `.published_at`, `.release_count` |

### 3.4 `dns(name)`

| Field | Type |
|---|---|
| `.a` | list of strings — compared with `contains` |
| `.cname` | string |
| `.txt` | list of strings |
| `.resolves` | bool |

DNS is the one source that legitimately returns private-range answers (someone's homelab). It
is **observation only** — the SSRF layer blocks *connecting*, not *resolving*, so `dns()` may
report a private address without pledge ever contacting it.

### 3.5 Named instants

Two, and only two:

- `commit_time` — `commitment.committed_at`, frozen at creation
- `deadline` — the **original** deadline, not the amended one

`deadline` referring to the original is deliberate. A spec like
`github.commits(r).since(commit_time).count >= 20` must not silently gain a wider window when
the deadline moves. Amendments move the resolution time; they never change what was promised.

---

## 4. Operators

### 4.1 Type rules

| Operator | Left | Right |
|---|---|---|
| `==` `!=` | any | same type |
| `>` `>=` `<` `<=` | int, decimal, version, timestamp | same type |
| `contains` | string, list | string |
| `starts_with` `ends_with` | string | string |
| `matches` | string | glob pattern (§4.3) |

Version comparison: if both operands parse as semver, compare semantically
(`"v0.10.0" > "v0.9.0"` is **true**). Otherwise compare as strings and emit a lint warning at
compose time. This asymmetry is a footgun, so the composer shows the resolved comparison mode
before you commit.

### 4.2 Boolean semantics

`and` / `or` are **not** short-circuiting at the fetch layer. All sources referenced anywhere
in the spec are fetched, always, even if an earlier conjunct already determined the result.

This is intentional: evidence completeness beats request economy. A receipt showing "we
checked all four conditions and here is what each returned" is worth far more than one
showing "we stopped after the first failure." At this volume the extra requests are free.

`all(a, b, c)` ≡ `a and b and c`. `any(...)` ≡ `or`. The combinator form exists purely for
readability of long specs.

### 4.3 `matches` is glob, not regex

Supported: `*` (any run of chars), `?` (one char), `[abc]`, `[a-z]`, `{alt1,alt2}`.

Regex is excluded on purpose:

- ReDoS on attacker-influenced input is a real availability risk, and the input here is a
  remote page body.
- Regex is write-only. An evaluator reading `v0.2.*` understands it; reading
  `^v0\.2\.\d+(-rc\.\d+)?$` they skim past it.
- Glob covers every real template case.

If a genuine need for regex appears, it enters as `spec_version = 2` with a linear-time engine
(RE2-class), never as a patch to v1.

---

## 5. Canonicalisation

**The hash is the contract.** This section is normative and any deviation is a breaking change.

```
parse(source) → CST → visit → AST → canonicalise → JCS bytes → sha256 → done_spec.hash
```

Canonicalisation steps, in order:

1. **Desugar.** `all(...)`/`any(...)` → nested binary `and`/`or`, left-associated. `not not x`
   → `x`.
2. **Normalise sources.** Lowercase scheme and host; strip default ports; strip a trailing
   `/` from an otherwise-empty path; preserve query string order (query order can be
   semantically meaningful to a target). Lowercase `owner/repo`. Reject URLs with credentials,
   fragments, or non-https schemes.
3. **Normalise literals.** Integers as JSON numbers with no leading zeros; decimals to
   shortest round-tripping form; versions kept as authored strings (comparison mode is
   recorded as an explicit AST field, not inferred at eval time); strings NFC-normalised.
4. **Sort commutative operand pairs.** For `and`/`or` only, order the two operands by their
   own canonical serialisation. This makes `a and b` and `b and a` the same hash. Comparison
   operands are **not** sorted — `x > 5` and `5 < x` are different ASTs by design, because
   normalising them would make error messages incomprehensible.
5. **Drop source text.** `dsl_source` is stored for display; it is **not** in the hash. Two
   users who write the same spec with different whitespace share a `done_spec` row.
6. **Serialise** with RFC 8785 JSON Canonicalisation Scheme.
7. **Prefix and hash.** `sha256("pledge.donespec.v1\x00" || jcs_bytes)`.

The domain-separation prefix means a done-spec hash can never be confused with a ledger
payload hash or a receipt hash, even if the JSON happened to coincide.

### 5.1 The two properties that must hold

Both are property-tested in CI ([`roadmap.md`](../roadmap.md) v1 exit criteria):

- **Determinism:** `canonicalise(parse(s))` is a fixed point. Re-serialising and re-parsing
  yields byte-identical output.
- **Semantic injectivity:** two specs that differ in any observable behaviour produce
  different hashes. Two that differ only in whitespace, operand order under `and`/`or`, or
  `all()` vs `and` produce the same hash.

---

## 6. Evaluation

### 6.1 Result

```ts
type Evaluation = {
  outcome: "pass" | "fail" | "error";
  observations: Observation[];      // one per distinct source, in canonical AST order
  subresults: { node_path: string; value: boolean }[];
};
```

**`error` is not `fail`.** If any source could not be observed — timeout, DNS failure, 5xx,
rate limit, SSRF block — the whole evaluation is `error`, regardless of whether the other
conjuncts would have decided it. An `error` never resolves a commitment
([`architecture.md` §8](../architecture.md)).

The one exception: if the spec would be `fail` *even assuming the unobservable source
returned its most favourable value*, the result is `fail`. This is sound and avoids an
adversary DoSing one source to escape a certain miss.

### 6.2 Evidence

Per observation:

```json
{
  "source": "http:https://pledge.sh",
  "observed_at": "2026-09-04T14:21:07Z",
  "resolved_ip": "104.21.x.x",
  "status": 200,
  "headers": { "content-type": "text/html; charset=utf-8",
               "last-modified": "...", "etag": "...", "content-length": "18422" },
  "body_sha256": "4f2a...",
  "body_bytes": 18422,
  "matches": [{ "op": "contains", "needle": "Verify a receipt", "found_at": 4120 }],
  "blob_key": "ev/2026/09/04/…",
  "unchanged_since_commitment": false
}
```

Header whitelist: `content-type`, `content-length`, `last-modified`, `etag`, `location`,
`server`. Nothing else is stored — response headers from arbitrary targets are a PII risk
pledge has no reason to take.

`matches` records **where** a needle was found, which is what makes a receipt readable by a
human rather than just verifiable by a machine.

### 6.3 Novelty

At commit time, one baseline observation per source is captured and stored. On any passing
run, if `body_sha256 == baseline_sha256` for every source, the run is flagged
`unchanged_since_commitment`.

That flag does not change the outcome. It is rendered on the profile next to the commitment,
because "this passed against a page that has not changed one byte since you promised to build
it" is information the reader deserves and pledge should not silently swallow.

---

## 7. Probe classes and the calibration floor

Every spec is assigned a **class** derived from its AST, used both for the calibration feature
vector ([`calibration.md`](../calibration.md)) and for the anti-gaming floor.

| Class | Definition | Counts toward calibration? |
|---|---|---|
| `trivial` | single source, single comparison, status-only or `.resolves` | **No** |
| `weak` | single source, no content assertion | Only with witness co-sign |
| `standard` | content assertion, or ≥2 distinct sources | Yes |
| `strong` | ≥2 distinct sources including ≥1 third-party, or a `.since(commit_time)` count | Yes, weighted up |

The class is computed at commit time and stored on the commitment, so the rules that applied
are frozen alongside the spec. Reclassifying old commitments retroactively would be exactly
the kind of silent redefinition the product exists to prevent.

> **Honest limitation:** class is a proxy for effort, not a measure of it.
> `http("https://my-landing-page.com").text contains "coming soon"` is `standard` and took
> four minutes. See [`security.md`](../security.md) T-04 and
> [Q-02](../open-questions.md) — the DSL cannot close this gap and should not pretend to.

---

## 8. Versioning

`spec_version` is stored per `done_spec` row and pins evaluation semantics permanently.

Rules for a future `spec_version = 2`:

- New sources, fields, or operators → minor addition, but **v1 specs still evaluate under v1
  rules.** The evaluator dispatches on version; there is no migration.
- Any change to canonicalisation, comparison semantics, or the error/fail boundary → new
  version, mandatory.
- The v1 evaluator is never deleted. It is a few hundred lines and its permanence is the
  reason the record means anything a decade out.

---

## 9. Templates

The five v1 templates, with the canonical spec each expands to. Users see the left column.

| Template | Expands to |
|---|---|
| **Release a version** | `github.release(R).tag matches T and github.release(R).published_at > commit_time` |
| **URL is live with content** | `http(U).status == 200 and http(U).text contains C and http(U).text.length > 2000` |
| **Publish a package** | `npm(P).latest_version >= V and npm(P).published_at > commit_time` |
| **Merge a PR** | `github.pr(R, N).state == "merged"` |
| **Sustained work** | `github.commits(R).since(commit_time).count >= N` |

Every template includes a `> commit_time` freshness clause where the source supports one. A
release that already existed when you committed should never satisfy a promise to make it —
and this is the single most likely accidental (rather than adversarial) false pass.
