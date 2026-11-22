# Deployment

Status: live. Unlike the rest of `docs/`, this describes something that exists.

Pledge deploys to the self-hosted Dokploy server. Images are built on GitHub runners, never
on the server. Nothing is deployed to Vercel.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API | Dokploy project `pledge`, application `api` | `ghcr.io/rohansx/pledge-api`, port 8080, serves `/api/*` |
| Dashboard | Dokploy project `pledge`, application `web` | `ghcr.io/rohansx/pledge-web`, nginx serving the Vite build, port 80, serves `/` |
| Postgres | Dokploy project `shared-infra`, the shared cluster | Database `pledge`, owned by role `pledge`. One database per project; Pledge runs no Postgres of its own |
| Auth | Dokploy project `shared-infra`, Keycloak | **On hold.** Not wired to Pledge yet; see below |
| URL | `https://pledge.187-127-185-75.sslip.io` | Placeholder host with a Let's Encrypt certificate until a real domain is chosen |

Both applications share one host. Traefik routes `/api` to the API and everything else to the
dashboard, so the dashboard calls the API on its own origin and there is no CORS setup.

## Pipeline

`.github/workflows/ci.yml`:

1. **test**, on every pull request and every push to `main`: install, typecheck, unit
   tests, build.
2. **images**, on `main` only: build the API and dashboard images on GitHub runners and push
   them to GHCR, tagged with the commit SHA and `main`. The SHA is baked into each image.
3. **deploy**, on `main` only: `scripts/deploy.mjs` points each Dokploy application at the
   SHA-tagged image, triggers the deploy, then polls the public URL until `/api/healthz`
   and `/version.txt` both report that SHA and the database check passes. If that does not
   happen within five minutes, or Dokploy reports a failed deployment, the job fails.

A push that changes only `docs/` or Markdown files does not run the pipeline.

The smoke test is the definition of "deployed": a green run means the new commit is the one
answering on the public URL and it can reach its database.

## Configuration

| Name | Kind | Where |
|---|---|---|
| `DOKPLOY_URL`, `DOKPLOY_API_KEY` | GitHub Actions secrets | Repository settings |
| `DOKPLOY_API_APP_ID`, `DOKPLOY_WEB_APP_ID`, `PUBLIC_URL` | GitHub Actions variables | Repository settings |
| `DATABASE_URL`, `PORT` | Runtime environment of the API | Dokploy application `api`, never in git |

The API refuses to start without `DATABASE_URL`.

## Auth (on hold)

Sign-in will use the Keycloak instance already running in `shared-infra`. Nothing is wired
yet. When it is picked up:

- Create a `pledge` realm or client in Keycloak.
- The dashboard signs in with the authorization code flow and PKCE. As a static app it holds
  no client secret.
- The API verifies Keycloak-issued tokens on every request except `/api/healthz`.
- The deploy smoke test gains one check that an unauthenticated API call is refused.

Until then the API exposes only `/api/healthz`, and nothing that needs protecting may be
added to it.

## Known limits

- The Dokploy API is called over plain HTTP from the GitHub runner, as the other projects on
  this server do. The key is a repository secret, but it crosses the network unencrypted.
- GitHub Actions are referenced by version tag, not pinned to commit SHAs.
- There are no database migrations yet. The first one needs a migration step in the pipeline
  before the deploy step.
- There is one environment. Every push to `main` goes to production.

## Running locally

```sh
pnpm install
DATABASE_URL=postgres://... pnpm --filter @pledge/api dev   # API on :8080
pnpm --filter @pledge/web dev                               # dashboard, proxies /api to :8080
pnpm typecheck && pnpm test
```
