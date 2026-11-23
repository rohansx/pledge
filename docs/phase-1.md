# Phase 1 result: the sandbox loop by hand

Run on 23 November 2026. One demo app, hand-written scenario, pledges and fault plan, no
Claude. The loop finds a real bug, and stops finding it when the bug is fixed.

## What was built

| Piece | Where | Notes |
|---|---|---|
| Demo shop | [`demo/shop/app.py`](../demo/shop/app.py) | Orders and payments on SQLite, standard library only. `POST /payments` charges the provider on every call. `SHOP_FIX=1` turns on the fix |
| Fault proxy | [`python/pledge/proxy.py`](../python/pledge/proxy.py) | Reverse proxy with one listener per route and an admin port. Applies the `retry` fault |
| Fake payment provider | [`python/pledge/fakes/payments.py`](../python/pledge/fakes/payments.py) | Accepts charges and records every call. Its call log is what the pledge is checked against |
| Scenario | [`demo/shop/.pledge/scenarios/checkout`](../demo/shop/.pledge/scenarios/checkout) | 20 customers place an order and pay, retrying when a reply is lost |
| Pledges | [`demo/shop/.pledge/pledges`](../demo/shop/.pledge/pledges) | `one-charge-per-order` and `customer-payment-succeeds` |
| Boot recipe | [`demo/shop/pledge.boot.json`](../demo/shop/pledge.boot.json) | Services, health checks, proxy routes. What the agent will write in Phase 2 |
| `pledge` CLI | [`python/pledge/cli.py`](../python/pledge/cli.py) | `boot`, `run`, `verdict`, `down`, and `scan` for E2B |
| Base template | [`python/pledge/template.py`](../python/pledge/template.py) | E2B template `pledge-base`: 2 vCPU, 2 GiB, Docker, k6, the engine. Built in 79 s |

## Result in E2B

`pledge scan demo/shop --scenario checkout --faults .../lost-payment-reply.json --seeds 5`.
The fault lets half of the payment requests reach the app and then loses the reply.

| App | Verdict | `one-charge-per-order` | `customer-payment-succeeds` |
|---|---|---|---|
| Buggy, under the fault | **Broken** | kept 0, broken 5 | kept 5 |
| Fixed, under the same fault | **Kept** | kept 5, broken 0 | kept 5 |
| Buggy, no faults (2 seeds) | Kept | kept 2 | kept 2 |

- **The bug is invisible without the fault.** The baseline passes on the buggy app, and even
  under the fault every customer ends up paid. Only the provider's ledger shows the second
  charge.
- **The evidence is expected against actual.** A broken run records
  `orders_charged_more_than_once` expected 0, actual 13, read from the fake provider's log.
- **A seed replays.** Seeds 1 to 5 injected 13, 8, 14, 14 and 9 lost replies on the buggy
  app and exactly the same on the fixed app. On the buggy app the number of double-charged
  orders equals the number of injected faults in every run.
- **Outbound was closed** for the whole scan, in the parent and in every fork.

| Step | Time |
|---|---|
| Create sandbox from the template | 0.9 s |
| Upload the app and the pledge package | 1.5 s |
| Boot app, fake and proxy | 9.6 s (5 s of it is the outbound check timing out, as intended) |
| Fork five ways | 2.1 s |
| Five runs in parallel, evidence downloaded | 13.2 s |
| **Total** | **29.4 s** |

## Decisions this settled

- **Fault plan parameters.** The plan's outer shape is LiteTraffic's. The proxy defines the
  rest: a `retry` fault has `target` as `ROUTE METHOD /path` (path may use wildcards) and
  `params` of `rate` (0 to 1) and `status` (a 5xx, default 504). The proxy refuses a plan
  with a kind it cannot apply, rather than ignoring it.
- **What "retry" means.** The request reaches the app, the app does its work, and the reply
  is replaced by a 5xx. The caller retries. The retry of the same request is let through.
- **How the seed selects requests.** By the order in which new matching requests arrive, not
  by their content. Journey keys carry the run id, so content would differ on every run and
  a seed would not replay.
- **Pledge file format.** `schema_version`, `id`, `statement`, `check` (a scenario and one
  of its assertions), `source`, `confidence`, `status`. A pledge is one engine assertion.
- **Only approved pledges block.** A broken pledge that is `proposed` or `proven` is
  reported but does not make the verdict `broken`.
- **The pledge package is uploaded per scan**, not baked into the template, so a change to
  the proxy or a fake needs no rebuild.

## What this does not show

- **Only the `retry` fault exists.** Duplicate delivery, same-instant requests, reorder,
  delay and restart are not built.
- **No direct database check.** The pledge reads the fake provider's log. The read-only
  state reader for the app's own database is not built, so Q-5 is still open.
- **The app is a toy.** SQLite, one process, no dependencies to install, no Compose file.
  Booting a real repository is Phase 2.
- **The fix is not complete.** The fixed shop checks "already paid" before charging, which
  handles a retry that arrives after the first attempt finished. Two payment requests at the
  same instant would still both charge. That is the bug the same-instant fault is for.
- **Proxy logs are outside the sealed evidence.** The list of injected faults is saved under
  `pledge/` in the run directory after the engine has written its checksums.
- **Hand-written inputs.** Nothing here tests whether Claude can write the scenario, the
  pledges or the boot recipe.

## Run it

```sh
cd python && uv venv .venv && uv pip install --python .venv/bin/python -e '.[engine,scan,dev]'

# on this machine (needs k6 v2.2.0)
cd ../demo/shop
pledge boot .                                   # add --env SHOP_FIX=1 for the fixed shop
pledge run . --scenario checkout --faults .pledge/faults/lost-payment-reply.json --seed 1
pledge verdict . runs/run_*
pledge down .

# in E2B (needs E2B_API_KEY, or ~/.config/workz/e2b.env)
pledge scan demo/shop --scenario checkout --faults demo/shop/.pledge/faults/lost-payment-reply.json --seeds 5
```

`pledge verdict` and `pledge scan` exit 0 when every approved pledge is kept, 1 when one is
broken, 2 when inconclusive and 3 on an error.
