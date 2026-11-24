# Pledge dashboard: technical design

Status: proposed design, not built or measured. Date: 24 November 2026.

What exists today differs from this design in stack, sign-in and scope. The last section,
[Status against what is built](#status-against-what-is-built), lists the gaps.

## 1. Summary

The dashboard is a single-page web app that shows, for each connected repo, which pledges
were kept and which were broken, with the evidence. It reads everything from the Pledge
control-plane API and never talks to a sandbox directly.

Two screens carry the product and should be built first:

- **Finding detail:** one broken pledge, with expected versus actual, the sequence that
  caused it, and a replay command.
- **Live first scan:** the boot, author, prove and run phases updating as they happen.

One element appears on every screen that summarises a run, the run strip:

> 12,480 requests sent · 100% returned success · 2 pledges broken

## 2. Scope

In scope:

- Six tabs per repo: Overview, Findings, Pledges, Coverage, Runs, Settings
- GitHub sign-in and repo picker
- Live progress for a running scan
- The pull request comment format (rendered by the backend, specified here so it matches
  the dashboard)

Out of scope for the first version:

- Billing and plan management
- Organisation-level roll-ups across many repos
- Editing scenario manifests in the browser (they live in the repo and change through pull
  requests)
- Any estimate of money saved

## 3. Stack

| Layer | Choice | Reason |
|---|---|---|
| Build tool | Vite | Static output, no second server next to FastAPI |
| UI | React with TypeScript | Familiar, large component ecosystem |
| Routing | TanStack Router | Typed routes and search params |
| Server state | TanStack Query | Caching, refetch and loading states for API data |
| Live updates | Server-Sent Events | One-way stream from server is enough for run progress |
| Styling | Tailwind CSS | Fast to build, easy to keep consistent |
| Charts | Recharts | Enough for one trend line and small bars |
| API | FastAPI (existing control plane) | Dashboard is a client of the same API the CLI uses |
| Auth | GitHub OAuth through the GitHub App, session cookie | One integration for sign-in and repo access |
| Hosting | Static files served by FastAPI or a CDN | Nothing extra to run |

These are recommendations from general knowledge and have not been tested together for this
project.

## 4. Information architecture

```text
/login
/repos                               repo picker
/r/:repoId/overview
/r/:repoId/findings                  ?status=open|fixed|verified
/r/:repoId/findings/:findingId
/r/:repoId/pledges                   ?status=proposed|proven|approved|retired
/r/:repoId/pledges/:pledgeId
/r/:repoId/coverage
/r/:repoId/runs
/r/:repoId/runs/:runId               live view while the run is in progress
/r/:repoId/settings
```

Layout: a top bar with the repo switcher and branch selector, a left rail with the six tabs,
and the page content. A badge on Findings shows the count of open findings. A badge on
Pledges shows the count awaiting review.

## 5. Tabs

### 5.1 Overview

Purpose: answer "is it safe to ship?" in five seconds.

| Element | Content | Source |
|---|---|---|
| Headline verdict | "41 of 43 pledges kept on main", broken ones linked | `GET /repos/:id/overview` |
| Run strip | Requests sent, share that returned success, pledges broken, for the latest run | same |
| Impact counters | Bugs caught before production, pull requests checked, faults injected, approved pledges | same |
| Trend | Pledges kept per week, last 12 weeks | same |
| Latest activity | Last 5 runs and last 5 findings | same |

States:

- No scan yet: a single "Run first scan" action.
- Scan running: link to the live run view.
- All kept: show what was survived (seeds, faults, restarts) so a clean result still reads
  as work done.

### 5.2 Findings

Purpose: show every broken pledge and let the team act on it.

List view: one row per finding with the plain statement, the pledge it broke, "broke on 3 of
128 seeds", first seen, and status. Filter by status. Sort by newest.

Detail view:

| Section | Content |
|---|---|
| Statement | "A customer was charged twice for one payment." |
| Run strip | For the run that found it |
| Expected versus actual | The pledge's expected value and the actual records found |
| How it happened | Ordered timeline of events from the engine log and proxy log |
| How often | Broken count over total seeds, with the seed list |
| Smallest cause | The reduced fault plan, usually one fault |
| Replay | A copyable `pledge replay` command |
| Actions | Send to coding agent, mark fixed, rerun |

Finding status:

```text
open -> fix_proposed -> fixed_unverified -> verified
                                   \-> reopened (rerun broke again)
```

A finding shows "verified" only after a rerun on the fixing commit keeps the pledge on every
seed that broke before.

### 5.3 Pledges

Purpose: review queue and catalogue of what is protected.

List view columns: statement, status, source, confidence, proof, last result.

- Status: proposed, proven, approved, retired.
- Source: stated in code (with file and line), domain template, inferred.
- Proof: how many planted bugs the pledge caught, linked to each one.

Detail view: the check definition (read-only, with a link to the file in the repo), the
planted bugs and their diffs, and kept or broken across the last 20 runs.

Actions: approve, reject, retire. Editing a pledge opens a pull request against the repo;
the dashboard does not edit files in place.

Rule enforced by the API: only approved pledges can fail a pull request check. An unproven
pledge can be approved only with an explicit override that is recorded.

### 5.4 Coverage

Purpose: show what is and is not protected.

- **Route by pledge grid:** rows are API routes, columns are pledges, a filled cell means
  the pledge exercises that route.
- **Faults tried:** per route, which of retry, duplicate, same-instant, reorder, delay and
  restart have been run.
- **Gaps list:** routes that write to money, stock, credits or per-customer data and have
  no approved pledge.
- **Propose pledges:** starts an authoring job limited to the selected routes.

Coverage is computed by the backend from scenario manifests and the route list in the repo
profile. It measures routes exercised, not lines of code.

### 5.5 Runs

Purpose: history and detail of every scan and pull request check.

List columns: trigger (first scan, pull request, manual), commit, pull request, verdict,
seeds, faults, duration, cost.

Run detail:

- Run strip and per-pledge results
- Scenarios used and the traffic profile
- Fault plans, by seed
- Logs (engine, proxy, fake services), redacted
- Download of the standalone report

Live view, shown while a run is in progress:

| Phase | What the user sees |
|---|---|
| Boot | Steps completed: clone, install, database, migrations, health check |
| Author | Pledges appearing one by one as they are proposed |
| Prove | Each pledge moving to proven or unproven |
| Run | Seeds completed over total, pledges kept and broken so far |
| Verdict | The run strip and links to any findings |

### 5.6 Settings

- Repo connection and branch to track
- Boot recipe (read-only, with "re-run discovery")
- Fake services in use and their recorded calls
- Budgets: tokens, sandbox minutes, wall-clock time per scan
- Notifications: pull request comment, email, chat webhook
- Team members and roles
- Data: retention period, delete sandbox snapshots now, delete all run evidence

## 6. API contract

All routes are under `/api`, return JSON, and require a session cookie. Paths are proposals.

| Method and path | Purpose |
|---|---|
| `GET /me` | Current user and accessible repos |
| `GET /repos` | Connected repos with latest verdict |
| `GET /repos/:id/overview` | Everything the Overview tab needs in one call |
| `GET /repos/:id/findings` | List, filter by status |
| `GET /findings/:id` | Detail with evidence and timeline |
| `PATCH /findings/:id` | Change status |
| `POST /findings/:id/rerun` | Rerun the breaking seeds on a commit |
| `GET /repos/:id/pledges` | List, filter by status |
| `GET /pledges/:id` | Detail with proof and history |
| `PATCH /pledges/:id` | Approve, reject or retire |
| `GET /repos/:id/coverage` | Route by pledge grid, faults tried, gaps |
| `POST /repos/:id/coverage/propose` | Start an authoring job for selected routes |
| `GET /repos/:id/runs` | Run history |
| `POST /repos/:id/runs` | Start a scan |
| `GET /runs/:id` | Run detail |
| `GET /runs/:id/events` | Server-Sent Events stream for a live run |
| `GET /runs/:id/report` | Standalone report file |
| `GET /repos/:id/settings`, `PATCH /repos/:id/settings` | Read and update settings |
| `DELETE /repos/:id/evidence` | Delete stored run evidence |

### Live run events

Sent on `GET /runs/:id/events`:

| Event | Payload |
|---|---|
| `phase_started` | phase name |
| `phase_step` | phase name, step label, ok or failed |
| `pledge_proposed` | pledge id, statement, source |
| `pledge_proven` | pledge id, proven or unproven |
| `seed_finished` | seed, pledges kept, pledges broken |
| `run_finished` | verdict, run summary, finding ids |

The client applies events to the cached run in TanStack Query. If the stream drops, it
refetches `GET /runs/:id` and reconnects.

## 7. Core types

```ts
type PledgeStatus = "proposed" | "proven" | "approved" | "retired";
type PledgeSource = "code" | "template" | "inferred";
type Verdict = "kept" | "broken" | "inconclusive";
type FindingStatus =
  | "open" | "fix_proposed" | "fixed_unverified" | "verified" | "reopened";

interface RunSummary {          // the run strip
  requestsSent: number;
  requestsSucceeded: number;
  pledgesChecked: number;
  pledgesBroken: number;
  seeds: number;
  faultsInjected: number;
}

interface Pledge {
  id: string;
  statement: string;
  status: PledgeStatus;
  source: PledgeSource;
  sourceRef?: { file: string; line: number };
  confidence: "high" | "medium" | "low";
  plantedBugsCaught: number;
  lastVerdict?: Verdict;
}

interface Finding {
  id: string;
  pledgeId: string;
  statement: string;
  status: FindingStatus;
  runId: string;
  brokenSeeds: number[];
  totalSeeds: number;
  expected: unknown;
  actual: unknown;
  timeline: { at: number; actor: string; text: string }[];
  minimalFaultPlan: { fault: string; target: string }[];
  replayCommand: string;
}

interface Run {
  id: string;
  trigger: "first_scan" | "pull_request" | "manual";
  commit: string;
  pullRequest?: number;
  phase: "boot" | "author" | "prove" | "run" | "done" | "failed";
  verdict?: Verdict;
  summary?: RunSummary;
  durationSeconds?: number;
  costUsd?: number;
}
```

## 8. Shared components

| Component | Used in | Notes |
|---|---|---|
| RunStrip | Overview, Findings, Runs, pull request comment | Takes a `RunSummary`. Same wording everywhere |
| VerdictBadge | All lists | Kept, broken, inconclusive. Never colour alone; always a label |
| PledgeStatusBadge | Pledges, Coverage | Four states |
| SeedCount | Findings, Runs | "3 of 128 seeds" |
| Timeline | Finding detail | Ordered events with actor labels |
| ExpectedActual | Finding detail | Side-by-side values and records |
| CopyCommand | Finding detail, Runs | Replay command with copy button |
| PhaseProgress | Live run | Five phases, current one expanded |
| CoverageGrid | Coverage | Virtualised for repos with many routes |

## 9. Pull request comment

Rendered by the backend as Markdown. It uses the same wording as the dashboard.

```text
Pledge: 2 of 43 pledges broken

1,920 requests sent · 100% returned success · 2 pledges broken

Broken
- One charge per payment: broke on 3 of 32 seeds. View finding
- Stock never goes below zero: broke on 1 of 32 seeds. View finding

Kept: 41. Skipped (not touched by this change): 0.
```

Only approved pledges set the check to failed. Broken proposed or unproven pledges are
listed under a separate "For review" heading and do not fail the check.

## 10. Non-functional requirements

- **Access control:** every API call checks that the user can read the repo through the
  GitHub App. No cross-customer data in any response.
- **Redaction:** the dashboard shows only redacted evidence. It never receives raw secrets.
- **Performance targets (to validate):** Overview loads from one API call; lists paginate
  at 50 rows; the coverage grid virtualises rows.
- **Accessibility:** keyboard navigation for all actions, status shown as text and not
  colour alone, sufficient contrast in light and dark themes.
- **Empty and error states:** every tab has a designed state for no data, loading, and
  failed request.
- **Deep links:** every finding, pledge and run has a stable URL, because the pull request
  comment links to them.

## 11. Build order

| Order | Deliverable | Why first |
|---|---|---|
| 1 | Sign-in, repo picker, layout shell | Needed by everything |
| 2 | Live run view | First thing a new user sees |
| 3 | Finding detail and Findings list | The demo screen |
| 4 | Pull request comment | Where most engineers meet the product |
| 5 | Pledges list, detail and approve | Needed before any check can block a merge |
| 6 | Overview | Needs history from several runs to look right |
| 7 | Runs list and detail | Mostly reuses earlier components |
| 8 | Coverage | Most complex, least needed for a first sale |
| 9 | Settings beyond the minimum | Add as customers ask |

## 12. Open questions

- Does the live view need finer progress than phase steps, such as streaming the agent's
  actions?
- Should finding timelines be built by the engine or assembled by the backend from logs?
- How are routes discovered reliably enough for the coverage grid across frameworks?
- Is cost per run shown to customers or kept internal?
- Do teams want to approve pledges in the dashboard, in a pull request, or both?

---

## Status against what is built

Added 24 November 2026. This section is a comparison, not part of the design. The dashboard
at `app.pledge.sh` was built the day before this design was written.

### Where the two disagree

| Topic | This design | What exists |
|---|---|---|
| UI | React, TanStack Router and Query, Tailwind, Recharts | TypeScript with no framework, hand-written CSS taken from the landing page, hash routes |
| API | FastAPI, the control plane | A Node + TypeScript service with one table, in `apps/api` |
| Sign-in | GitHub OAuth through the GitHub App, session cookie | One shared access token. Keycloak was chosen earlier and put on hold |
| Unit of the dashboard | A connected repo, at `/r/:repoId/...` | An app name taken from published scans, at `#/a/<app>/...` |
| Where derived data is computed | The API: one call per tab | The browser, from every stored scan fetched whole |
| How data arrives | The control plane runs scans and streams events | The command line publishes a finished scan's summary |

### Tab by tab

| Tab | Built | Missing |
|---|---|---|
| Overview | Verdict sentence, counters, per-seed squares for every pledge, recent scans | Run strip, trend over weeks, "run first scan", pull requests checked |
| Findings | List and detail in one page: statement, seeds it broke on, expected against actual, the fault, a copyable replay command | Status lifecycle, timeline of how it happened, smallest fault plan, rerun, send to coding agent, a URL per finding |
| Pledges | List with filter, detail page, history across scans, source and confidence | Approve, reject and retire; proof from planted bugs; link to the file and line |
| Coverage | Nothing | All of it |
| Runs | Scan list and detail: per-pledge results, fault plan, per-seed runs | Live view, trigger and commit, logs, report download, cost in money |
| Settings | Sign out, theme, how to publish | Everything about a repo, budgets, notifications, team, data deletion |

Not in this design but built: an Agent runs page showing what Claude wrote for a repo, its
open questions and its token use per phase.

### What the backend cannot supply yet

These screens need things the product does not have, whatever the dashboard is written in:

- **Run strip.** Requests sent and the share that succeeded are in each run's engine
  metrics but are not published. A small change.
- **Live run.** Nothing runs scans server-side. The runner would have to push events to the
  API as it works, or the orchestrator has to exist.
- **Proof.** The prove phase (planted bugs) is Phase 3 and not started, so no pledge can be
  `proven` and "planted bugs caught" is always zero.
- **Smallest cause.** Shrinking a fault plan is Phase 3.
- **Timeline.** The proxy records which faults it injected but not an ordered story per
  journey, and the engine's events are per assertion.
- **Coverage.** The boot phase lists a repo's endpoints, but nothing maps a scenario's
  requests to routes.
- **Repos, commits, pull requests.** There is no GitHub App, so nothing knows a commit or a
  pull request.
- **`pledge replay`.** The command does not exist; the replay shown today is `pledge run`
  with a seed.
