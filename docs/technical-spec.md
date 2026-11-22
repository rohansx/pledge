# pledge — Technical Specification

**Version:** 0.2 (design, TypeScript stack)
**Author:** Rohan Sharma (rohansx)
**Date:** August 2026
**Domain:** pledge.sh
**Companion doc:** [`product-overview.md`](./product-overview.md)

> **Revision note (v0.1 → v0.2):** the original spec proposed Rust + axum. That was a stack
> choice made by habit rather than by the problem. This workload is CRUD, SSR, IO-bound HTTP,
> and a nightly stats fit — nothing compute-bound. The binding constraint is
> nights-and-weekends build time, not throughput. This version is TypeScript-first, with a
> Python sidecar where the math genuinely warrants it. Recorded as
> [ADR-0001](./adr/0001-typescript-over-rust.md).

**This document is the stack-and-component spec.** Adjacent docs go deeper:

| For | Read |
|---|---|
| How the pieces fit, trust boundaries, flows, failure modes | [`architecture.md`](./architecture.md) |
| DSL grammar, canonicalisation, versioning | [`spec/done-spec-dsl.md`](./spec/done-spec-dsl.md) |
| Receipt wire format + verification algorithm | [`spec/receipt-format.md`](./spec/receipt-format.md) |
| Threat model beyond SSRF | [`security.md`](./security.md) |
| Statistical model, censoring, validation | [`calibration.md`](./calibration.md) |
| Phases with exit criteria | [`roadmap.md`](./roadmap.md) |

---

## 1. Design constraints

1. **Nothing self-reported is ever authoritative.** Every state transition originates from an
   external observation (a probe) or a signed human attestation. There is no "mark as done"
   endpoint. This is the product.
2. **The ledger is append-only and externally verifiable.** A receipt must be verifiable by a
   third party with no database access and no trust in the operator.
3. **Done-specs are immutable and content-addressed.** The hash of the canonicalised spec is
   written to the ledger at commit time.
4. **Probes are untrusted network I/O.** Hardened path, SSRF defences, strict timeouts, zero
   ambient credentials.
5. **One language for v0 and v1.** Second languages must earn their place at a clean seam.
6. **Positioning guard:** the product name is forward-looking; the product is
   backward-looking. Every surface should lead with the *record*, not the promise. Landing
   headline: *"pledge — the record of what you shipped."*

---

## 2. Stack

| Layer | Choice | Rationale |
|---|---|---|
| App + API | **TypeScript, Next.js (App Router)** | Public profiles are the growth engine and need SSR, SEO, and dynamic OG images — Next's core competence. Collapses frontend and backend into one codebase |
| DB | **Postgres 16 + Drizzle ORM** | Ledger, jsonb evidence, and the job queue all live in one place. Drizzle over Prisma for raw-SQL escape hatches (needed for `SKIP LOCKED` and Merkle queries) |
| Jobs | **pg-boss** | Postgres-backed queue. Probe volume is thousands/hour, not millions. No broker, no Redis |
| Auth | **Auth.js + GitHub OAuth** | You need the GitHub App for probes anyway; identity comes free |
| HTTP client | **undici** with a custom hardened dispatcher | Fine-grained control over DNS resolution and redirects — mandatory for SSRF defence (§5) |
| DSL parser | **Chevrotain** | Proper lexer/parser with a typed CST; better than regex, lighter than a full compiler toolchain |
| Crypto | **@noble/ed25519, @noble/hashes** | Audited, zero-dependency, works in Node and edge runtimes |
| Transparency log | **sigstore-js** | Official JS Sigstore client. Same anchoring pattern proven in CloakPipe |
| Calibration | **Python sidecar** (numpy/scipy → NumPyro later) | The only place TS is genuinely the wrong tool. See §7 |
| Verifier CLI | **`npx pledge-verify`** (v1), Go binary (v2, optional) | See §8 |
| Email | **Resend** + react-email | Templates in the same language as everything else |
| Chat notify | **Telegram Bot API, WhatsApp Cloud API** | India-first; builders here live on WhatsApp |
| Hosting | **Vercel + Neon** | Zero ops to start. Migration path to a single Hetzner box + Docker if egress costs bite |
| Object storage | **Cloudflare R2** | Probe evidence blobs. No egress fees |

**Language count: 1 for v0/v1, 2 from v2.** That is the whole point of this revision.

---

## 3. Data model

Drizzle schema, expressed as SQL for clarity. Invariants and rationale in
[`architecture.md` §5](./architecture.md).

```sql
account(id uuid pk, handle citext unique, email citext, github_id bigint,
        created_at timestamptz, plan text)

-- immutable, content-addressed
done_spec(hash bytea pk,          -- sha256 of canonical JSON
          dsl_source text,        -- original user-authored text
          ast jsonb,              -- parsed + canonicalised
          spec_version smallint)

commitment(id uuid pk,
           account_id uuid references account,
           cohort_id uuid null references cohort,
           claim text,
           done_spec_hash bytea references done_spec,
           committed_at timestamptz,
           deadline timestamptz,
           estimated_days numeric,
           confidence numeric,      -- NEW: builder's stated probability (0–100 or 0–1)
           visibility text,        -- public | unlisted | private
           status text,            -- open | kept | missed | abandoned | disputed
           verification_tier text, -- NEW (ADR-0010 proposal): machine_verified | 
                                    -- peer_attested | self_reported
           resolved_at timestamptz null,
           actual_days numeric null,
           slip_ratio numeric null)

-- deadline moves are recorded, never applied destructively
amendment(id uuid pk, commitment_id uuid, kind text,  -- deadline_moved | abandoned
          old_value jsonb, new_value jsonb, reason text,
          created_at timestamptz, ledger_seq bigint)

probe_run(id uuid pk, commitment_id uuid,
          probe_kind text, ran_at timestamptz,
          outcome text,             -- pass | fail | error
          evidence jsonb,           -- status, header subset, body_sha256, matches
          evidence_blob_key text,   -- R2 object key for full captured body
          duration_ms int)

witness(id uuid pk, commitment_id uuid, account_id uuid null,
        email citext, notified_at timestamptz)
witness_attestation(id uuid pk, witness_id uuid, verdict text,
                    note text, signed_at timestamptz, ledger_seq bigint)

ledger_entry(seq bigserial pk,
             account_id uuid,
             entry_type text,       -- commitment_created | probe_result
                                    -- | witness_attested | amended | resolved
             payload jsonb,
             payload_sha256 bytea,
             prev_hash bytea,
             entry_hash bytea,
             created_at timestamptz)

checkpoint(id uuid pk, merkle_root bytea, tree_size bigint,
           rekor_log_index bigint, rekor_uuid text,
           signed_at timestamptz, signature bytea)

cohort(id uuid pk, organizer_id uuid, slug citext unique, name text,
       starts_at timestamptz, deadline timestamptz, visibility text)
```

**Chaining.** One global chain; per-account views are filtered projections. Each entry:

```ts
const payloadHash = sha256(canonicalJSON(payload));          // RFC 8785 JCS
const entryHash   = sha256(concat(prevHash, payloadHash, u64le(seq)));
```

Appends happen inside the same Postgres transaction as the state change, with
`SELECT ... FOR UPDATE` on a single-row `chain_head` table to serialise. At this volume a
global write lock on chain append is completely fine and removes an entire class of ordering
bug. Recorded as [ADR-0003](./adr/0003-global-chain-lock.md).

**Anchoring.** As specced: every 10 minutes a cron job builds a Merkle tree over new entries,
signs the root with the service ed25519 key, and submits to Rekor via sigstore-js. One anchor
amortises across all users. Whether this ships at all is **open** —
[ADR-0005](./adr/0005-defer-rekor-anchoring.md) is Proposed, not accepted, and proposes gating
it behind a trigger. The `checkpoint` table and the `rekor_*` columns ship either way; if the
ADR is accepted they stay empty.

---

## 4. The done-spec DSL

Users mostly pick templates; the DSL is the escape hatch and the auditable artifact. Full
grammar and semantics: [`spec/done-spec-dsl.md`](./spec/done-spec-dsl.md).

```
github.release("rohansx/tethr").tag matches "v0.2.*"

http("https://pledge.sh").status == 200
  and http("https://pledge.sh").text contains "Verify a receipt"
  and http("https://pledge.sh").text.length > 2000

npm("cloakpipe").latest_version >= "0.4.0"

github.pr("rohansx/sift", 214).state == "merged"

all(
  http("https://chhaap.in/order").status == 200,
  github.commits("rohansx/chhaap").since(commit_time).count >= 20
)
```

**Implementation.** Chevrotain lexer + parser → CST → a small visitor producing a typed AST
validated with **Zod**. Zod does double duty: it validates the AST shape and generates the
TypeScript types for the evaluator, so parser and evaluator can't drift.

```ts
const HttpSource = z.object({
  kind: z.literal("http"),
  url: z.string().url(),
  field: z.enum(["status", "text", "text.length", "header"]),
});
type Node = z.infer<typeof SpecNode>;
```

**Canonicalisation** → sort object keys, normalise literals, resolve defaults, serialise with
RFC 8785 JSON Canonicalisation Scheme, sha256. **That hash is the contract.** Any change
yields a different hash, i.e. a different commitment. You cannot silently redefine done.

**Versioning.** `spec_version` pins evaluation semantics; old commitments always evaluate
under the rules in force when they were made.

---

## 5. Probe engine

**Scheduling.** Backoff curve per open commitment: daily until T-72h, hourly until T-6h,
every 5 minutes in the final hour, one authoritative run at deadline+0. GitHub webhooks
trigger opportunistic probes (e.g., a release event immediately triggers a `github.release()`
check). **Deploy webhooks (Vercel, Netlify) are polled, not pushed, for v0.1** — Vercel
account webhooks are Pro-only (excluding the primary persona), Fly has no deploy webhooks,
and Netlify supports all plans. Polling is the safe path until platform support is uniform.

```ts
// worker.ts — pg-boss handles locking, retries, and backoff
await boss.work("probe", { batchSize: 32 }, async (jobs) => {
  const results = await Promise.allSettled(
    jobs.map((j) => evaluateSpec(j.data.commitmentId))
  );
  await persistAndAppendToLedger(results);
});
```

`evaluateSpec` walks the AST, memoising fetches per source within a run (so `.status` and
`.text` on the same URL cost one request), and emits both a boolean and a structured evidence
record.

### SSRF defence (non-negotiable)

Probes fetch arbitrary user-supplied URLs. In Node this needs deliberate work — `fetch` will
happily hit `169.254.169.254`.

```ts
import { Agent } from "undici";
import ipaddr from "ipaddr.js";

const BLOCKED = ["private", "loopback", "linkLocal", "uniqueLocal",
                 "carrierGradeNat", "reserved", "unspecified"];

const safeAgent = new Agent({
  connect: {
    lookup: (hostname, opts, cb) => {
      dns.lookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err, "", 0);
        const ok = addrs.filter(a =>
          BLOCKED.indexOf(ipaddr.parse(a.address).range()) === -1);
        if (!ok.length) return cb(new Error("SSRF: blocked address range"), "", 0);
        cb(null, ok[0].address, ok[0].family);   // pin the validated IP
      });
    },
  },
  bodyTimeout: 10_000,
  headersTimeout: 5_000,
});
```

Plus, all mandatory:

- **Redirects handled manually**, max 3, re-validating the resolved IP at every hop (defeats
  DNS rebinding).
- 5 MB body cap, 10s total budget.
- Fixed egress IP; UA `pledge-probe/0.1 (+https://pledge.sh/probe)`; respects `robots.txt`
  for domains not verified as owned by the committer. *Domain verification does not exist
  yet* — it is the leaning under [Q-05](./open-questions.md), not a built mechanism. Until it
  ships, `robots.txt` is honoured for **every** `http()` target.
- **Never** attaches credentials, cookies, or auth headers to `http()` probes.
- Per-account probe rate limits; per-target-host global limit.
- Probe workers run as a **separate deployment** from the web app, so a probe-path bug can't
  reach user session data.

### Evidence capture

Each run records timestamp, resolved IP, status, whitelisted response headers, body sha256,
the specific substrings that matched, and an R2 key for the archived body. The evidence hash
enters the ledger; the blob supports dispute resolution.

### Anti-gaming

A `200 OK` from a placeholder satisfies a naive spec. Countermeasures:

- Templates default to **semantic** checks (content match + minimum body length), never bare
  status codes.
- **Novelty check:** snapshot the target's body hash at commit time. If the probe passes
  against a byte-identical page, it's flagged `unchanged_since_commitment` and rendered as
  such on the profile.
- Weak probe classes require witness co-sign to count toward calibration.

See [`security.md`](./security.md) T-04 for the full gaming threat model — this is the
product's deepest unresolved tension, not merely a hardening detail.

---

## 6. Resolution state machine

```
   created ──► open ──┬── probe pass (any time) ──► kept
                      ├── deadline+0 probe observes FALSE ──► missed
                      ├── deadline+0 probe cannot observe ──► disputed
                      ├── amend(abandon) ──► abandoned
                      └── witness contradicts probe ──► disputed
```

- **kept** stamps the *earliest* passing probe, so hourly polling doesn't cost credit for
  shipping at 2am. Only a probe produces `kept` — never a witness
  ([ADR-0006](./adr/0006-accountless-witnesses.md)).
- **missed** only on the authoritative deadline+0 run, and only when that run's outcome is
  `fail` — an *observation* that the done-condition is false. An `error` at deadline+0 is
  retried for a grace window and then becomes `disputed`, never `missed`
  ([`architecture.md` §8](./architecture.md)).
- **disputed** goes to human review; both records stay in the ledger and the profile shows
  the dispute rather than hiding it.
- **abandoned** is labelled distinctly — honest withdrawal should read better than silent
  failure. For calibration it is a **right-censored** observation at `resolved_at`, not a
  miss and not a zero ([`calibration.md` §4](./calibration.md)).

Every transition appends a ledger entry in the same transaction.

---

## 7. Calibration engine (Python sidecar)

The one place a second language earns its keep. Hand-rolling hierarchical Bayesian numerics
in TypeScript would be slow to write and easy to get subtly wrong.
[ADR-0004](./adr/0004-python-sidecar-for-calibration.md). Full model:
[`calibration.md`](./calibration.md).

**Seam:** a container running nightly on a cron. Reads resolved commitments from Postgres,
writes fitted per-user parameters back to a `calibration_fit` table. No HTTP service, no
runtime coupling. If it fails, the app serves yesterday's parameters.

**Model.** Slip ratios are right-skewed; work in log space.

```
y_ij = log(actual_days / estimated_days)

y_ij ~ Normal(mu_i + beta·x_ij, sigma_i^2)
mu_i  ~ Normal(mu_pop, tau^2)          # partial pooling across users
sigma_i ~ HalfNormal(sigma_pop)
```

**Why hierarchical:** a user with three commitments has no usable personal estimate. Partial
pooling shrinks them toward the population mean, so the forecast is sane from commitment #1
and sharpens with data. Naive per-user averaging is the failure mode a weekend clone will
ship.

**Censoring:** abandoned and never-completed commitments are right-censored, not missing.
Dropping them biases the fit optimistic — precisely the bias the product exists to correct.
Use a censored likelihood (`scipy.stats.norm.logsf` for the censored terms).

**Features `x_ij`:** derived from the done-spec AST, not user tags — probe kind, count of
distinct external sources, whether third-party APIs are involved, whether other people's
repos are referenced, historical difficulty of that probe class. Machine-derived features
can't be gamed by mislabelling. [ADR-0007](./adr/0007-ast-derived-features.md).

**Implementation order:** start with the closed-form normal-normal conjugate fit in numpy —
no sampling, runs in milliseconds, and is genuinely adequate until category features matter.
Graduate to NumPyro only when the feature vector justifies it.

**Serving.** The forecast endpoint is a table lookup plus arithmetic in TypeScript, so it
runs inline in the composer with no added latency:

```ts
const p = normalCdf((Math.log(estDays) - fit.mu - dot(fit.beta, x)) / fit.sigma);
const calibratedDate = addDays(committedAt,
  estDays * Math.exp(fit.mu + dot(fit.beta, x) + fit.sigma * probit(0.8)));
```

**Recency weighting:** exponential decay, ~9-month half-life. People do get better at
estimating.

---

## 7.5. The Scope Negotiator (LLM on the commit path)

**Purpose:** At pledge creation, convert a fuzzy builder intent ("ship v1 of clipxd by mid
September") into a checkable contract (spec + date + confidence). The LLM proposes, the
builder refines, the app parses and commits. This is **not** a general-purpose coding LLM;
it is a scoped contract negotiator.

**Architecture — outside the transaction and optional:**

```
1. Builder writes intent → LLM generates proposed spec AST
2. App tier: Chevrotain parses the LLM output (NOT trusted directly)
3. Builder previews + edits the spec
4. On confirm: parse again (Chevrotain), canonicalise, hash
5. Commit the hash to the ledger
```

The LLM output is **parsed before it is stored** — if the parse fails, the proposal is
rejected and the builder is told to edit it. A re-parse at commit time ensures the hash
corresponds to a valid spec. The invariant is: **the hash is the contract, not the LLM's
word.** Two LLM outputs that parse to the same AST hash to the same commitment.

**Failure modes and surfaces:**

| Failure | Mitigation |
|---|---|
| LLM latency on create | Proposal generation is debounced; builder can skip the LLM and write manually |
| LLM cost | Cost per proposal is bounded; the builder only pays if they accept (opt-in, not forced) |
| LLM unavailable | Manual spec entry is always available and unblocked |
| Prompt injection (craft an intent to make the LLM emit a trivial spec) | Parser validates the AST shape before storing; a trivial spec hashes to the same hash as any other trivial spec. Visible on the profile. Ranked lower in calibration if the class taxonomy is applied ([ADR-0007](./adr/0007-ast-derived-features.md)) |
| Prompt injection (steer the LLM to propose a large-scope spec on purpose to then trivially satisfy it) | Same as above: visible, hashed, ranked by class |
| Prompt injection (extract user data from the system prompt) | System prompt is read-only; the LLM sees only the builder's own statement, history, and calibration cues. It has no database access, no way to access other builders' data |

**Calibration coaching (optional post-resolution):**

After a commitment resolves, a second LLM call can synthesize the builder's own history:
"On pledges your size with a third-party API, you historically slip 5.2 days. Your last
three releases slipped 4, 3, 2 days — you are improving. For pledges this size going
forward, assume 4.5 days and add that to your date, or keep the date and lower your
confidence from 80% to 62%." This is purely advisory and happens async after resolution,
not on the write path.

**Design rule:** The LLM is a convenience, not a guard. A manually-written spec with an
LLM-quality proposal beats an LLM-generated spec the builder did not review. The fastest
path to a commitment is: skip the LLM, write a 20-character spec, commit. The LLM is the
path for builders who want guidance on scope or deadline.

---

## 8. Receipts and verification

Receipt payload contains commitment, outcome, evidence, ledger audit path, Rekor anchor, and
ed25519 signature. Normative wire format:
[`spec/receipt-format.md`](./spec/receipt-format.md).

**v1 — `npx pledge-verify receipt.json`.** Zero install friction, uses `@noble/ed25519` and
`sigstore-js`, ~200 lines. Ship this.

**v2 — optional Go binary.** If a standalone binary is ever demanded, build it in **Go, not
Rust**: cosign and Rekor are Go-native and `sigstore-go` is the reference client, so you'd be
swimming with the current. But don't build it until someone asks.

Verification steps (identical in either client):

1. Recompute `payload_sha256` from commitment + outcome + evidence via RFC 8785 canonical
   JSON.
2. Verify the ed25519 signature; the signing key's certificate is itself in Rekor.
3. Walk `audit_path` from `entry_hash` to `checkpoint_root`.
4. Fetch the Rekor entry at `log_index`; confirm it commits to that root.
5. Verify Rekor's signed tree head.

Steps 4–5 are what make backdating or fabrication by pledge *detectable* rather than a matter
of reputation, and they are the basis for the word "verifiable." They do not make it
impossible: the window between resolution and the next checkpoint is a real gap in which an
entry could be rewritten, bounded at ≤10 minutes and computable from the receipt
([`security.md`](./security.md) T-03, [`spec/receipt-format.md` §5.2](./spec/receipt-format.md)).

> **Scope note:** [ADR-0005](./adr/0005-defer-rekor-anchoring.md) argues steps 3–5 solve a
> trust problem nobody has yet, and proposes shipping steps 1–2 in v2 with anchoring behind a
> trigger. Read it before building the Merkle layer.

---

## 9. API surface

Next.js Route Handlers under `app/api/v1/`.

```
POST   /v1/commitments                 create (response includes the forecast)
GET    /v1/commitments/:id
POST   /v1/commitments/:id/amendments  move deadline / abandon (reason required)
GET    /v1/commitments/:id/receipt     signed receipt, only when resolved

POST   /v1/forecast                    dry-run: spec + deadline → probability, dates
GET    /v1/accounts/:handle            profile + calibration summary
GET    /v1/accounts/:handle/ledger     paginated chain with audit paths

POST   /v1/cohorts                     organizer creates
POST   /v1/cohorts/:slug/join
GET    /v1/cohorts/:slug/report        verified post-event report

GET    /v1/badge/:handle.svg           embeddable badge, 5-min ETag cache
POST   /webhooks/github                GitHub App events
GET    /v1/checkpoints/latest          public: current root + Rekor pointer
```

Public reads unauthenticated and edge-cached. Writes via Auth.js session (web) or PAT (API).
Witness attestation via signed magic link — **witnesses must not need an account**, or
witness adoption dies on contact. [ADR-0006](./adr/0006-accountless-witnesses.md).

Zod schemas shared between route handlers and client forms; one definition, validated on both
sides.

---

## 10. Frontend notes

- Public profile: SSR with ISR (`revalidate: 60`). It's the SEO and sharing surface and must
  be crawlable and fast.
- Dynamic OG images per commitment and per profile via `next/og` (satori). Every share
  renders a card with claim, outcome, and calibration line. This is the primary organic loop
  — treat it as a feature, not decoration.
- **The forecast must render while the user is picking a date**, not after submit. Being told
  "38% chance" at the moment of choosing *is* the behavioural intervention. Debounced call to
  `/v1/forecast` on date change.
- Timezones: store UTC, always display and accept input in the committer's local zone. An
  off-by-one-day deadline bug on a product about deadlines is unrecoverable reputationally.
  Use `@date-fns/tz`; write tests against IST specifically.

---

## 11. Open source split

| Open (MIT) | Closed / hosted |
|---|---|
| `@pledge/spec` — DSL parser + evaluator | Calibration model + fitted parameters |
| Receipt format specification | Cohort management, billing |
| `pledge-verify` CLI | Notification pipeline |
| `@pledge/safe-fetch` — SSRF-hardened undici dispatcher | Web frontend |

`@pledge/safe-fetch` is worth extracting deliberately: SSRF-safe fetching in Node is a real,
widely-botched problem, and a standalone package is independently useful. That's the
workz/sift pattern — the OSS artifact *is* the distribution channel.

---

## 12. Milestones

| Stage | Scope | Est. |
|---|---|---|
| v0 | commitment CRUD, `http()` + `github.release()` probes, public profile, email notify | 2 days |
| v1 | full DSL, witnesses, amendments, hash-chained ledger, OG cards, `npx pledge-verify` | 1 week |
| v2 | calibration sidecar + inline forecast, receipts, Merkle checkpoints + Rekor anchoring *(gated on [ADR-0005](./adr/0005-defer-rekor-anchoring.md), which is Proposed)* | 2 weeks |
| v3 | cohorts, organizer reports, badges, public API, WhatsApp/Telegram notify | 2–3 weeks |

Roughly half the v0.1 estimates, which is the actual argument for this stack.

These estimates are exactly the kind of claim the product exists to check. They should be the
first four commitments on pledge itself. Exit criteria per phase:
[`roadmap.md`](./roadmap.md).

---

## 13. When to revisit the stack

Reasons to move part of this to Rust or Go later, in order of likelihood:

1. **Probe volume exceeds ~1M/hour** — the worker becomes the bottleneck. Extract only the
   worker; it's already a separate deployment.
2. **Vercel egress or function costs become material** — move to a Hetzner box with Docker
   Compose. This is a hosting change, not a language change.
3. **The verifier becomes the product** — if other platforms start consuming receipts at
   scale, a Go binary in the Sigstore ecosystem is the right artifact.

None of these are true on day one, and building for them now would cost weeks you don't have.
