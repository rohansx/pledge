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

## Network

Outbound access is open to package registries during install, then closed. The app can then
reach only the fake services inside the sandbox, so a test can never charge a real card or
send a real email.

## Fault proxy

Every inbound request from the synthetic users and every outbound call from the app passes
through it. A fault plan is a seed plus a list of faults:

| Fault | What the proxy does | Bug it exposes |
|---|---|---|
| Retry | Times out the response so the caller sends the request again | Double charge, duplicate order |
| Duplicate delivery | Sends the same webhook twice | Work done twice |
| Same-instant requests | Holds two requests and releases them together | Oversold stock, double spend of credits |
| Reorder | Delivers two events in the wrong order | Wrong final state |
| Delay | Slows one dependency | Timeouts handled badly |
| Restart | Asks the supervisor to kill and restart the app mid-request | Half-finished writes |

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
