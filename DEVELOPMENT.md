# Running pledge locally

v0 — the loop, end to end: sign in with GitHub, make a commitment, have a probe resolve it,
see it on a public profile. Everything below runs against a Docker Postgres with no real
third-party credentials.

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

This is v0 exit criterion #1 as a script. It creates a commitment through the same
transaction the API route uses, lets pg-boss hand the job to the worker's own handler, probes
`https://example.com` over the real network through `@pledge/safe-fetch`, and asserts the
commitment reached `kept` with a `probe_run` row and evidence. **It needs outbound network
access** and fails loudly rather than faking a pass without it. No manual DB edits anywhere.

---

## Running it

Four processes; you rarely need all four at once.

```bash
pnpm dev        # Next.js on :3000
pnpm worker     # probe worker — pg-boss, daily sweep at 03:00 UTC
pnpm notify     # drains notify.resolution and sends resolution mail
pnpm smoke      # one-shot end-to-end check, safe to re-run
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

Several tests need the Docker Postgres up and migrated: the grant tests, the resolution tests,
and the queue-contract test. They do not skip when the database is missing — a security test
that quietly passes when it cannot run is worse than no test.

---

## Layout

```
apps/web        Next.js app router — profile, commitment page, composer, /api/v1
apps/worker     probe worker: pg-boss, sweep + probe handlers, the two probe kinds
packages/db     Drizzle schema, migrations, role grants, shared Zod contracts, queue payload
packages/safe-fetch   the SSRF-hardened fetcher; the only way to fetch a user-supplied URL
```

Three seams worth knowing before you edit across them:

- **`packages/db/src/types.ts`** is the contract both apps compile against. It imports no
  database client, so it is browser-safe and form validation can share it.
- **`packages/db/src/queue.ts`** owns the probe-job payload. `apps/web` produces it inside the
  commitment's transaction; `apps/worker` consumes it. Both import the same definition, and
  `apps/worker/src/queue-contract.test.ts` asserts a round trip through Postgres — they had
  already drifted once, silently.
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
