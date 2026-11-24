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

Updated 24 November 2026, after the dashboard and API were rebuilt to this design. This
section is a comparison, not part of the design.

### Followed

| Topic | State |
|---|---|
| Stack | React with TypeScript, TanStack Router and Query, Tailwind, Recharts, built with Vite. The API is FastAPI. Live updates are Server-Sent Events |
| Information architecture | The routes in section 4, as real paths. Top bar with the repo switcher, left rail with the six tabs, badges on Findings and Pledges |
| API contract | The paths in section 6, computed server-side: one call per tab |
| Run strip | On Overview, the repo picker, Findings, Runs and in the pull request comment, in the same words |
| Rules | Only an approved pledge makes a run broken. Approving an unproven pledge needs an override, recorded with a note. A finding is verified only by a later run under the fault plan that broke it. A pledge's standing is the worst of its latest conclusive result under each fault plan, and the headline, the pledge list and the open findings are read off that one computation. A check that passed on a seed where the fault plan injected nothing, or failed without reading a value, counts as unknown. A run not heard from for two hours reads as failed, "abandoned". Authoring time counts only on the first scan |

### Different from the design

| Topic | This design | What exists |
|---|---|---|
| Sign-in | GitHub OAuth through the GitHub App, session cookie | One shared access token, sent as a bearer header and kept in the browser. It sits behind one function in the API and one module in the dashboard, so GitHub sign-in replaces those two |
| Repos | Connected through GitHub | Created when the command line first publishes a run under a name. No branch selector, no commits |
| Starting a scan | `POST /repos/:id/runs` starts one | The same call registers a run the command line is making. The runner then posts events to `POST /runs/:id/events` and its result to `POST /runs/:id/result`, two routes the design does not list |
| Hosting | Static files served by FastAPI or a CDN | A separate nginx container serves the dashboard; the proxy routes `/api` to FastAPI |
| Replay | `pledge replay` | That command does not exist. The replay shown is `pledge run` with a breaking seed |
| "Returned success" | Share of requests that returned success | Share that the scenario did not count as an unexpected failure. A reply replaced by an injected fault is the fault working, so it is not counted against the app |

### Tab by tab

| Tab | Built | Missing |
|---|---|---|
| Overview | Headline with broken pledges linked, run strip, the four impact counters, trend, latest runs and findings, states for no scan and a running scan | The trend needs runs in two different weeks before it draws. "Run first scan" is instructions, not a button |
| Findings | List with status filter. Detail with statement, run strip, expected versus actual per seed, how often, the whole fault plan, replay command, status changes, history, a prompt to hand a coding agent | Timeline of how it happened, smallest cause, rerun from the dashboard |
| Pledges | List with status filter and the design's columns. Detail with facts, latest check, history over 20 runs. Approve with override and note, reject, retire | Proof from planted bugs, file and line of a stated source, opening a pull request to edit |
| Coverage | An honest empty state | All of it. `GET /repos/:id/coverage` answers `available: false` |
| Runs | List with run strip per run. Detail with per-pledge results, fault plan, per-seed table, what Claude wrote and its cost in tokens, the pull request comment as it would be posted. Live view of the five phases over the event stream | Commit and pull request, cost in money, logs and report download |
| Settings | Repo, how to send runs, account | Everything else in 5.6 |

### What the backend still cannot supply

- **Proof.** The prove phase is not built, so no pledge is `proven` and every approval is an
  override.
- **Smallest cause and timeline.** Nothing shrinks a fault plan, and the proxy does not
  record an ordered story per journey. The API returns empty lists for both, never a guess.
- **Coverage.** Nothing maps a scenario's requests onto a repo's routes.
- **Repos, commits, pull requests.** There is no GitHub App.
- **Server-side scans and reruns.** There is no orchestrator. `POST /findings/:id/rerun`
  answers 501.
- **First scans span several runs.** A run has one scenario, so authoring that writes three
  scenarios finishes the live run with the first baseline and sends the others as runs of
  their own.
