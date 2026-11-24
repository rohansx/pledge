# Sandbox design

Status: proposed. Several points here depend on unverified E2B behaviour; see
[open questions](./open-questions.md).

Each scan gets its own E2B sandbox. The three E2B features the design depends on are custom
templates, snapshots and outbound network rules. The E2B SDK reference documents creating a
snapshot and starting new sandboxes from it, pausing on timeout, and switching internet
access off.

## Base template

One template per supported stack, starting with Node or Python plus Postgres and Redis. It
carries the runtimes, the database servers, k6, the LiteTraffic engine, the fault proxy and
a process supervisor.

The [Phase 0 spikes](./spikes/phase-0.md) settled three things about it: it also ships
Docker, so an app with a Compose file runs as its repository defines; it must declare at
least 2 GiB of RAM, because the default sandbox has 473 MiB; and it should take full
snapshots, since a filesystem-only snapshot cold-boots and services do not come back on
their own.

## Network

Outbound access is open to package registries during install, then closed. The app can then
reach only the fake services inside the sandbox, so a test can never charge a real card or
send a real email.

## Fault proxy

Every inbound request from the synthetic users and every outbound call from the app passes
through it. A fault plan is a seed plus a list of faults:

| Fault | What the proxy does | Bug it exposes |
|---|---|---|
| Retry (`retry`) | Lets the upstream do the work, then replaces the reply with a 5xx so the caller sends the request again | Double charge, duplicate order |
| Duplicate delivery (`duplicate`) | Returns the real reply, and delivers the same request a second time | Work done twice by a webhook or queue consumer |
| Same-instant requests (`race`) | Sends the one request twice at the same instant and returns the first reply | Oversold stock, double spend of credits |
| Delay (`delay`) | Holds the reply | Timeouts handled badly, overlapping retries |
| Restart (`restart`) | Has one service killed and started again while the request is in flight | Half-finished writes |
| Reorder | Delivers two events in the wrong order | Wrong final state |

All but reorder are built ([`faults.py`](../python/pledge/faults.py), [`proxy.py`](../python/pledge/proxy.py)).

Every fault has a `target`, `ROUTE METHOD /path` with wildcards in the path, and a `rate` from 0
to 1. Each fault counts the new requests its target covers, and the seed, the fault's place in
the plan and that count decide whether it fires. So a seed replays the same pattern, and adding
a fault to a plan does not move the others. A request the client repeats unchanged is not a new
request. When several faults fire on one request all are applied, one per kind.

| Kind | `params` besides `rate` |
|---|---|
| `retry` | `status`, a 5xx, default 504 |
| `duplicate` | `delay_ms` after the first reply, default 0; `mode`: `after` (default) or `concurrent`, which sends the second while the first is in flight |
| `race` | none |
| `delay` | `ms`, required, 1 to 60000 |
| `restart` | `service`, required, a service of the boot recipe; `after_ms` before the kill, default 0; `max` restarts per run, default 1 |

LiteTraffic records the plan and calls two kinds `duplicate_delivery` and `same_instant`. The
proxy accepts both spellings and `pledge run` hands the engine its own.

**Why `race` sends one request twice.** The other model holds two different requests and
releases them together. A journey sends its requests one after another, so two of the same
journey are never in flight to be held, and two from different journeys act on different
orders or accounts, which the scenario's ordinary concurrency already covers. A double click
and two workers taking one job are both the same request arriving twice at one instant. That
is also deterministic to inject: no waiting for a partner that may not come.

**How a restart works.** The proxy does not own the processes, so it cannot restart one. It is
started with `--app-dir` and runs `pledge restart APP_DIR SERVICE`
([`local.restart_service`](../python/pledge/local.py)), which reads `.pledge-run/pids.json`,
sends SIGKILL to the service's process group, starts the recipe's command again with the same
environment, and returns when the health check passes. Meanwhile the proxy holds every new
request. Requests already inside the killed service lose their connection and get a 502, as in
a real crash. The kill comes `after_ms` after the matching request was sent on; for an exact
moment, target the call the service makes to a dependency in the middle of its work: the
dependency does its part, and the service is dead before the reply reaches it. The restart, how
long it took and any error are in the run's `pledge/proxy_injected.json`; a service that does
not come back fails the run rather than producing a verdict.

Limits: the kill takes the whole process group, so a start script that also launched the
database loses that too. A container the command started detached is not in the group and
survives; give that service a `restart` command in the recipe, for example
`["sh", "-c", "docker kill db && docker start db"]`, and it is run instead of the kill.

**What is recorded.** `pledge/proxy_injected.json` has one entry per injected fault.
`pledge/proxy_traffic.json` has every request with `kinds`, the faults applied to it, and a
second delivery as its own line with `copy: true` and no returned status, since nobody received
that reply. The journey recording tells each in plain words.

## Fake services

A fake accepts the calls the app makes to a real provider, answers plausibly, records every
call, and can send webhooks back.

Start with hand-written fakes for the two or three providers the first design partners use,
and let Claude generate the rest from the calls it found in discovery.

## Observing the data

Pledges are checked by reading the app's final state.

- Reading the database directly is the strongest check.
- Reading through the app's API is the fallback when the schema is unclear.
- The fake services' call logs are a second source: "one charge per payment" is checked
  against what the fake payment provider actually received.

## Seeded, not deterministic

The seed fixes the traffic schedule and the fault plan. It does not fix thread timing inside
the app, so a race may show on some runs and not others. That is why each fault plan runs on
many forks and the verdict is a count.
