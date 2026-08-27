# Running pledge locally

v0 and v1 — the loop, end to end: sign in with GitHub, write a done-spec in the DSL, invite a
witness, amend the deadline, have a probe resolve it, see it on a public profile with every
state change on a hash-chained ledger, and export a signed receipt anyone can verify offline.
Everything below runs against a Docker Postgres with no real third-party credentials.

Normative rules for changing any of this live in [`CLAUDE.md`](./CLAUDE.md). Read the
invariants before you touch the probe worker, the queue, or anything that writes `status`.

---

## Prerequisites

| Tool | Version | Note |
|---|---|---|
| Node | ≥ 22 | `process.loadEnvFile` and native `fetch` are both assumed |
| pnpm | 11.2.2 | pinned by `packageManager`; `corepack enable` picks it up |
| Docker | any recent | for the Postgres in `docker-compose.yml` |

No global installs beyond those. Everything else is in the lockfile.

---

## First run

```bash
pnpm install
cp .env.example .env.local        # the defaults are enough for everything but OAuth and mail
pnpm db:up                        # Postgres on host port 5433, waits until healthy
pnpm db:migrate                   # schema + role grants + local role logins
pnpm db:seed                      # optional: one account, three commitments
```

`pnpm db:up` shifts the container's 5432 to host **5433**, because a system Postgres commonly
already owns 5432. If 5433 is taken too, change it in `docker-compose.yml` and in both
`DATABASE_URL*` values together.

`pnpm db:migrate` creates `pledge_web` and `pledge_probe` as `NOLOGIN` roles — a password
belongs in an environment, not a migration — then attaches the passwords from your
`.env.local` to them, but only outside `NODE_ENV=production`.

### Then prove it works

```bash
pnpm smoke
```

This is the whole v1 loop as a script — seven steps, no shortcuts around any of them:

1. expands one of the five §9 **templates**, compiles it through the real DSL, and creates the
   commitment through the same `insertCommitment` + `enqueueProbeJob` transaction the API route
   uses, with a **witness invited**
2. recomputes the `commitment_created` entry's hash from its stored payload
3. captures the **baseline snapshot** over the real network, before anything can resolve
4. **moves the deadline** with a reason, in `Asia/Kolkata`, and checks the `amended` entry
5. lets pg-boss hand the job to the worker's own handler, probes over the real network through
   `@pledge/safe-fetch`, and asserts `kept` plus `probe_result` and `resolved` entries
6. walks the **entire chain from genesis** — the same call `pnpm ledger:verify` makes
7. builds and signs a **receipt**, then verifies it with `pledge-verify` **in a separate
   process with every `DATABASE_URL*`, `PLEDGE_*`, `WITNESS_*`, `AUTH_*`, `RESEND_*` and
   `GITHUB_*` variable stripped from its environment**

**It needs outbound network access** and fails loudly rather than faking a pass without it. An
`error` outcome is reported as "could not observe", never as a failed done-condition (I-7) —
the message says which. No manual DB edits anywhere.

The receipt is left in a temp directory and its path is printed, so you can re-verify it by
hand:

```bash
npx pledge-verify /tmp/pledge-smoke-XXXX/receipt.json
```

---

## Running it

Four processes; you rarely need all four at once.

```bash
pnpm dev        # Next.js on :3000
pnpm worker     # probe worker — pg-boss, sweep every 5 minutes
pnpm notify     # drains notify.resolution and sends resolution mail
pnpm smoke      # one-shot end-to-end check of the whole v1 loop, safe to re-run
```

The sweep runs every five minutes, not daily: the backoff curve tightens to five-minutely in
the final hour before a deadline, and the sweep is the only thing that applies it, so the tick
has to be at least as fine as the finest band.

Two one-shot commands you will want:

```bash
pnpm ledger:verify                             # walk the chain from genesis, recompute every hash
pnpm --filter @pledge/db receipt <id> > r.json # build and sign one receipt
npx pledge-verify r.json                       # ...and check it, offline, with no credentials
```

**`pnpm worker` must have run once against a fresh database before the first commitment can
be created.** pg-boss owns its schema and `pgboss.job.name` is a foreign key to
`pgboss.queue.name`, so until the worker has created the `probe` queue, the enqueue inside the
commit transaction raises and rolls the commitment back. That is the correct failure — a
commitment whose probe was never scheduled would sit `open` forever — but it surprises people
on a clean checkout. `pnpm smoke` creates the queues too, so running it first is enough.

The worker refuses to start unless `PLEDGE_ROLE=worker`. Set it for that command only:

```bash
PLEDGE_ROLE=worker pnpm worker      # bash/zsh
env PLEDGE_ROLE=worker pnpm worker  # fish
```

That gate is not ceremony. A preview deployment running probes would double-probe live
commitments from an unpinned egress IP.

---

## Environment

`.env.local` is git-ignored. `.env.example` documents every value; the ones that need a real
credential:

| Variable | Where to get it | Needed for |
|---|---|---|
| `AUTH_SECRET` | `openssl rand -base64 32` | any sign-in; the placeholder works locally |
| `AUTH_GITHUB_ID` / `AUTH_GITHUB_SECRET` | github.com/settings/developers → New OAuth App. Callback URL `${NEXT_PUBLIC_BASE_URL}/api/auth/callback/github` | signing in. Without these the app boots and renders; only the OAuth redirect fails |
| `GITHUB_APP_TOKEN` | github.com/settings/tokens — fine-grained PAT, public-repo read | the `github_release_tag` probe. Raises the API limit from 60/hr to 5000/hr. The worker refuses to start without it and will not fall back to unauthenticated for a resolution-critical run |
| `RESEND_API_KEY` | resend.com/api-keys | real mail. Anything not starting `re_` degrades to a log line, deliberately — the loop must complete on placeholders |
| `WITNESS_LINK_SECRET` | `openssl rand -base64 32` | HMAC over witness magic links. Its own variable, not a reuse of `AUTH_SECRET`, so rotating one does not force rotating the other. Rotating it invalidates every outstanding link, which is the correct behaviour for a leak |
| `PLEDGE_SIGNING_KEY` | `openssl genpkey -algorithm ed25519 -outform DER \| base64 -w0` | signing receipts. Optional outside production: an ephemeral key is generated and the process says so. In production a missing key is a startup failure — an ephemeral key silently invalidates every receipt already handed out, and the failure surfaces as a stranger's verifier saying FORGED |

`DATABASE_URL` is the owner/app connection. `DATABASE_URL_PROBE` is the `pledge_probe` role,
which has **no privilege at all** on `account`. Never point the worker at `DATABASE_URL`: that
isolation is the control that survives an SSRF bypass, and the code would keep working, which
is exactly why it is worth stating.

---

## Tests

```bash
pnpm test           # invariant check + vitest, all packages
pnpm typecheck      # tsc --noEmit everywhere
pnpm lint
pnpm build          # invariant check + next build + tsc
pnpm check:invariants
```

`pnpm test` and `pnpm build` both run `scripts/check-invariants.mjs` first. It greps `apps/web`
for assignments of `kept` or `missed` to a `status` field and fails the build if it finds one.
If it ever fires, remove the write — do not narrow the check, and do not exempt the file.

Several tests need the Docker Postgres up and migrated: the grant tests, the resolution and
crash tests, the receipt tests, and both wire-contract tests. They do not skip when the
database is missing — a security test that quietly passes when it cannot run is worse than no
test.

`vitest` runs test **files** one at a time (`fileParallelism: false` in the root
`vitest.config.ts`). That is not a preference: ADR-0003 puts every ledger append behind one
global `chain_head FOR UPDATE`, and `apps/worker/src/crash.test.ts` holds that lock for
seconds on purpose. Any DB-touching file running beside it queues on the lock and blows its
timeout. Do not restate or override the setting in a per-project config.

---

## Layout

```
apps/web        Next.js app router — profile, commitment page, DSL composer, witnesses,
                amendments, OG cards, /api/v1
apps/worker     probe worker: pg-boss, sweep + probe handlers, the observation layer,
                the spec evaluator, the two v0 probe kinds
packages/db     Drizzle schema, migrations, role grants, shared Zod contracts, queue payload,
                the ledger append helper, the receipt builder
packages/spec   the done-spec DSL: lexer, parser, AST, canonicalise, print, classify,
                evaluate, templates. No Node-only imports — it runs in the browser (I-6)
packages/ledger the chain formula, canonical JSON, payload schemas, ed25519 signing
packages/verify pledge-verify — the offline verifier. No network, no credentials, no db
packages/safe-fetch   the SSRF-hardened fetcher; the only way to fetch a user-supplied URL
```

Five seams worth knowing before you edit across them:

- **`packages/db/src/types.ts`** is the contract both apps compile against. It imports no
  database client, so it is browser-safe and form validation can share it.
- **`packages/db/src/queue.ts`** owns the probe-job payload. `apps/web` produces it inside the
  commitment's transaction; `apps/worker` consumes it. Both import the same definition, and
  `apps/worker/src/queue-contract.test.ts` asserts a round trip through Postgres — they had
  already drifted once, silently.
- **`done_spec.ast`** is jsonb. `apps/web` writes a compiled AST into it and `apps/worker`
  parses it back with `@pledge/spec`'s own schema — typecheck sees neither side of that.
  `apps/worker/src/spec-wire.test.ts` round-trips a real compiled spec through Postgres and
  asserts the printed source and the content-address survive.
- **`probe_run.evidence`** is jsonb too, written by the worker and read by the receipt builder,
  and its digest goes onto the permanent chain. The same test asserts the digest on the chain
  covers the bytes that are actually stored — otherwise "the evidence was not edited
  afterwards" is a check of nothing.
- **`notify.resolution`** is a queue the worker writes and cannot read back. `pledge_probe`
  has no grant on `account`, so the tier that fetches strangers' URLs cannot learn anyone's
  email. `pnpm notify` is the app-tier consumer that joins the two.

---

## Troubleshooting

**`relation "pgboss.queue" does not exist` / a commit 500s.** The worker has never run. Run
`pnpm smoke` or `PLEDGE_ROLE=worker pnpm worker` once.

**`Refusing to start: PLEDGE_ROLE is web`.** Working as designed. See above.

**A probe resolved `disputed`, not `missed`.** Also working as designed. `disputed` means the
target could not be observed at the deadline. Only an observation that the done-condition is
false produces `missed`; a network failure never does.

**`permission denied for table account` in the worker.** Also working as designed — check you
have not pointed `DATABASE_URL_PROBE` at the owner role.

**`pnpm smoke` reports outcome `error`.** No outbound network. The script is not lying to you;
that is what an unobservable target looks like.

**`pnpm smoke` fails at the amendment step with `not_open`.** Something resolved the commitment
before the deadline could be moved — a resolved commitment is not amendable, deliberately.
Check that the baseline step ran; the smoke captures the baseline itself precisely so the first
probe is not what captures it.

**`new row for relation "probe_run" violates check constraint "probe_run_kind_known"`.**
Migration 0002 has not been applied. Run `pnpm db:migrate`.

**A receipt fails to verify after a restart.** `PLEDGE_SIGNING_KEY` is unset, so each process
generated its own ephemeral key. The warning tells you the value to pin in `.env.local`.
