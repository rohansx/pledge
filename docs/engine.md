# The LiteTraffic engine boundary

Status: proposed. What Pledge needs from the engine, what the engine already does, and what
was added for Pledge.

The engine is the open-source LiteTraffic CLI (`rohansx/litetraffic`, Python plus k6).
Pledge calls it; it does not fork it.

## What Pledge needs, and where it comes from

| Pledge needs | Engine today | Gap |
|---|---|---|
| Validate every manifest before use | `inspect` validates a scenario bundle and prints what it would do | None |
| Seeded traffic, fixtures, assertions, verdict, report | `verify` | None |
| Run against a sandbox | `verify --e2b-sandbox-id ID --e2b-port PORT`, or a URL when run inside the sandbox | None |
| Bind a scenario to an approved target | `approve`, `verify --require-approval` | None |
| Refuse cloud metadata and link-local targets | Built into target validation | None |
| Redact declared secrets and minted tokens | Built into every artifact write | Proxy and fake-service logs are not engine artifacts yet |
| Read the app's final state | HTTP observations, including a second origin from `allowed_origins` | See "Reading the database" below |
| Check what a fake provider received | The same HTTP observation, pointed at the fake's call log | The fakes must expose their log over HTTP |
| Count kept and broken per pledge across seeds | `--repeat` gave one aggregate verdict | **Added:** `tally` |
| Record the fault plan a run executed under | Nothing | **Added:** `verify --fault-plan` |
| Inject faults | Nothing, by design | The fault proxy does this, not the engine |

## Added for Pledge

On branch `feat/pledge-engine` of the LiteTraffic repository. Not merged, not pushed.

- **`litetraffic tally RUN [RUN ...]`** counts, per assertion, how many runs it passed, failed
  or could not be judged in, and names the run, seed and fault plan digest of each failure.
  It works over any set of run directories of one scenario, so runs made on separate forks
  are counted together. `--repeat` summaries now carry the same counts.
- **`litetraffic verify --fault-plan FILE`** validates a fault plan (a seed plus an ordered
  list of `retry`, `duplicate_delivery`, `same_instant`, `reorder`, `delay` or `restart`
  faults, each with a target), refuses one whose seed is not the run's seed, and records it
  in the run directory with its digest. `diff` treats runs under different plans as
  incompatible. The engine records the plan. It does not apply it.

A pledge maps to one engine assertion. "Kept" is the assertion's pass count and "broken" its
fail count in a tally.

## Reading the database

The design calls reading the database directly the strongest check. The engine reads state
over HTTP only, and that is left as it is. Inside the sandbox, a small read-only state
reader runs each pledge's query and returns JSON, and the scenario lists its origin in
`allowed_origins`. This keeps database drivers out of the engine and gives every check the
same matchers, polling and redaction.

The state reader is a Pledge component still to build. Phase 1 checked its pledge against
the fake provider's call log instead. It is not in the
component list of the [architecture](./architecture.md) yet.

## Not done

- Fault plan `params` are recorded by the engine as written. The fault proxy defines and
  validates them, for every kind but `reorder` (see [sandbox design](./sandbox-design.md#fault-proxy)).
  The proxy's `duplicate` and `race` are the engine's `duplicate_delivery` and `same_instant`.
- Proxy and fake-service logs are not copied into the run directory, so they are not covered
  by the engine's redaction or its artifact checksums.
- The run does not record a snapshot id.
