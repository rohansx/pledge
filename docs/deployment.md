# Deployment

Status: live. Unlike the rest of `docs/`, this describes something that exists.

Pledge deploys to the self-hosted Dokploy server. Images are built on GitHub runners, never
on the server. Nothing is deployed to Vercel.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| API | Dokploy project `pledge`, application `api` | `ghcr.io/rohansx/pledge-api`, the FastAPI app in `python/pledge/api` under uvicorn, port 8080, serves `/api/*` |
| Pull request worker | Not deployed yet. Opt-in: Dokploy application `worker` | The API's image with the command `pledge worker`. Outside the pipeline until its secrets exist; see [the GitHub App](./github-app.md) |
| Dashboard | Dokploy project `pledge`, application `web` | `ghcr.io/rohansx/pledge-web`, nginx serving the React build, port 80, serves `/` and falls back to `index.html` for its routes |
| Landing page | Dokploy project `pledge`, application `site` | `ghcr.io/rohansx/pledge-site`, nginx serving the Astro build, on `pledge.sh`; `www.pledge.sh` redirects to it |
| Postgres | Dokploy project `shared-infra`, the shared cluster | Database `pledge`, owned by role `pledge`. One database per project; Pledge runs no Postgres of its own |
| Auth | Dokploy project `shared-infra`, Keycloak | **On hold.** Not wired to Pledge yet; see below |
| URLs | `https://pledge.sh` (landing), `https://app.pledge.sh` (dashboard and API) | DNS is on Vercel's nameservers, A records to the Dokploy server. `auth.pledge.sh` is reserved for Keycloak |

The dashboard and API share one host. Traefik routes `/api` to the API and everything else to the
dashboard, so the dashboard calls the API on its own origin and there is no CORS setup.

## Pipeline

`.github/workflows/ci.yml`:

1. **test**, on every pull request and every push to `main`: install, typecheck, unit
   tests, build.
2. **images**, on `main` only: build the API, dashboard and landing page images on GitHub runners and push
   them to GHCR, tagged with the commit SHA and `main`. The SHA is baked into each image.
3. **deploy**, on `main` only: `scripts/deploy.mjs` points each Dokploy application at the
   SHA-tagged image, triggers the deploy, then polls the public URLs until `/api/healthz`
   and each `/version.txt` report that SHA and the database check passes. If that does not
   happen within five minutes, or Dokploy reports a failed deployment, the job fails.

A push that changes only `docs/` or Markdown files does not run the pipeline.

The smoke test is the definition of "deployed": a green run means the new commit is the one
answering on the public URL and it can reach its database.

## Configuration

| Name | Kind | Where |
|---|---|---|
| `DOKPLOY_URL`, `DOKPLOY_API_KEY` | GitHub Actions secrets | Repository settings |
| `DOKPLOY_API_APP_ID`, `DOKPLOY_WEB_APP_ID`, `DOKPLOY_SITE_APP_ID`, `PUBLIC_URL`, `SITE_URL` | GitHub Actions variables | Repository settings |
| `PUBLIC_LOBBY_URL`, `PUBLIC_LOBBY_PROJECT_KEY` | GitHub Actions variables | Baked into the landing page at build time. Publishable values only; the Lobby secret key is never given to the build |
| `DATABASE_URL`, `PORT`, `PLEDGE_API_TOKEN` | Runtime environment of the API | Dokploy application `api`, never in git |

The API refuses to start without `DATABASE_URL`.

## Auth (on hold)

Sign-in will use the Keycloak instance already running in `shared-infra`. Nothing is wired
yet. When it is picked up:

- Create a `pledge` realm or client in Keycloak.
- The dashboard signs in with the authorization code flow and PKCE. As a static app it holds
  no client secret.
- The API verifies Keycloak-issued tokens on every request except `/api/healthz`.
- The deploy smoke test gains one check that an unauthenticated API call is refused.

Until then one shared access token stands in for sign-in. Every API request except the health check must
carry it as a bearer token; the dashboard asks for it once and keeps it in the browser's
local storage, and `pledge scan --publish` reads it from `PLEDGE_API_TOKEN`. Without the
token configured on the API, the scan routes answer 503 rather than opening up. `/api/healthz`
stays public.

This is a stopgap with known limits: one token for everyone, no per-person access, no
expiry, and no way to revoke it except by changing it in Dokploy and redeploying.

## Known limits

- The Dokploy API is called over plain HTTP from the GitHub runner, as the other projects on
  this server do. The key is a repository secret, but it crosses the network unencrypted.
- GitHub Actions are referenced by version tag, not pinned to commit SHAs.
- The API creates its two tables at startup with an idempotent statement. Every object is a JSON document in one of them. That holds while
  schema changes are additive; the first change that alters a column needs real migrations
  run in the pipeline before the deploy step.
- There is one environment. Every push to `main` goes to production.

## Running locally

```sh
pnpm install
DATABASE_URL=postgres://... PLEDGE_API_TOKEN=dev uvicorn pledge.api.app:app --port 8080   # API, from python/
pnpm --filter @pledge/web dev                               # dashboard on :5173, proxies /api to :8080
PLEDGE_API_URL=https://app.pledge.sh pnpm --filter @pledge/web dev   # same, against the deployed API
pnpm --filter @pledge/site dev                              # landing page on :4321
pnpm typecheck && pnpm test                                 # dashboard and landing page
python -m pytest python                                     # API, runner and the end-to-end loop
```
