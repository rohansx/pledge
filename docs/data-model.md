# Data model

Status: proposed.

Seven objects. Pledges and scenarios are files in the customer's repo so they can be
reviewed in a pull request, and run data is files in a run directory.

| Object | What it holds | Lives in |
|---|---|---|
| Repo profile | Stack, boot recipe, environment map, outbound calls, snapshot id, commit | Control plane |
| Pledge | Id, plain statement, the check (observer plus expected value), source, confidence, status | `.pledge/pledges/` in the repo |
| Scenario | The LiteTraffic manifest: actors, fixtures, schedule, assertions, budgets | `.pledge/scenarios/` in the repo |
| Fault plan | Seed and an ordered list of faults with their targets | Run directory |
| Run | Scenario digest, seed, fault plan, snapshot id, verdict | Run directory |
| Evidence | Event log, failing samples with expected and actual, proxy and fake-service logs, report, checksums | Run directory |
| Finding | A broken pledge, the seeds it broke on, the smallest fault plan that breaks it, a replay command | Report and pull request comment |

## File formats so far

Defined by hand in Phase 1 and validated by the `pledge` CLI. See the
[demo shop](../demo/shop) for one of each.

- **Pledge**, `.pledge/pledges/<id>.json`: `schema_version`, `id`, `statement`, `check`
  (`scenario` and `assertion`), `source`, `confidence`, `status`, and, since the caller
  inventory, `reach` (`ui`, `client`, `provider`, `internal` or `api_only`: which real caller
  can break it) and `trigger` (one sentence naming the real-world cause). Files without the
  two still load; their reach is shown as unknown.
- **Caller inventory**, `.pledge/callers.json`: for each route a scenario calls, who calls it
  (`kind` and a `ref` to a file in the repo) and whether that caller `retries`, can
  `double_submit` or `redelivers`. An empty `callers` list means nothing shipped calls the
  route. `pledge.check` validates it and compares it with the requests each baseline made.
- **Browser steps**, `.pledge/scenarios/<name>/browser.cjs`, optional: what the user of a
  broken journey does in the app's own frontend to see the damage. See
  `python/pledge/browser_runner.cjs` for the contract.
- **Faults**, `.pledge/faults/<name>.json`: a `faults` list. A run combines it with a seed
  into the fault plan the engine records.
- **Boot recipe**, `pledge.boot.json`: the services to start with their health checks, the
  proxy routes, the traffic target and the fakes to reset between runs. In the data model
  above this is part of the repo profile; in Phase 1 it is a file next to the app.

## Pledge states

```mermaid
stateDiagram-v2
  [*] --> proposed: Claude wrote it
  proposed --> proven: it broke on a planted bug
  proven --> approved: a human accepted it
  proposed --> retired
  proven --> retired
  approved --> retired
```

Only **approved** pledges can fail a pull request. A pledge that did not break on its
planted bug stays unproven: it can appear in a report but cannot block a merge.

## Why pledges and scenarios live in the customer's repo

The team owns them, changes to them show up in code review, and the product keeps working
if they leave the hosted service and run the open-source CLI.
