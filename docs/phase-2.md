# Phase 2 result: the agent boots a repo and authors its pledges

Run on 23 November 2026: first on the demo shop, then twice on a real repository. Claude was given the demo shop with no
boot recipe, no scenario and no pledges, and produced all three. Code, not Claude, decided
when each phase was done.

## What was built

| Piece | Where | Notes |
|---|---|---|
| Agent loop | [`python/pledge/agent.py`](../python/pledge/agent.py) | One phase at a time, fresh context per phase, three sandbox-scoped tools plus `finish`, budgets on tokens, seconds and commands |
| Prompts and tool schemas | [`python/pledge/prompts.py`](../python/pledge/prompts.py) | The author prompt appends LiteTraffic's own scenario guide from the installed engine |
| Deterministic checks | [`python/pledge/check.py`](../python/pledge/check.py) | Runs inside the sandbox. Decides whether a phase's output is accepted |
| `pledge author` | [`python/pledge/author.py`](../python/pledge/author.py) | Runs the boot and author phases and brings back the repo with the authored files |

## Guardrails, as implemented

- **No verdict authority.** A phase ends only when `finish` is called and the checker
  accepts. A rejected `finish` returns the problems to Claude. Stopping without calling
  `finish` is not accepted either.
- **Boot is checked from cold.** The checker stops everything, boots from the recipe, and
  requires the app to answer through the proxy.
- **Authoring is checked by the engine.** Every scenario must pass `litetraffic inspect`,
  every pledge must name an assertion its scenario declares, every faults file must be one
  the proxy can apply, and each scenario's baseline must reach a verdict. A baseline that
  errors or is inconclusive goes back to Claude; a pass or a fail is accepted.
- **Claude cannot approve.** A pledge whose status is not `proposed` is rejected.
- **Writes stay in the repository.** `write_file` refuses any path outside `/work/app`.
- **Budgets.** Each phase has a cap on tokens, wall-clock time and commands. Hitting one
  ends the phase with an error.
- **Network.** Package registries are reachable during the boot phase only. Outbound is
  closed before the author phase and every run.
- **Keys stay outside.** The Anthropic and E2B keys live in the runner process. The sandbox
  never has them.
- **Repo text is data.** Stated in the prompt. The narrow tool set is the real limit.

The design's separate HTTP-request tool was not built: `run_command` with curl covers it.

## Result

Model `claude-opus-5-5` for both phases. The whole thing took 126 seconds.

| Phase | Requests | Tokens | Of which read from cache | Output | Commands | Time | `finish` rejected |
|---|---|---|---|---|---|---|---|
| Boot | 4 | 19,810 | 11,236 | 2,508 | 3 | 37 s | 0 |
| Author | 7 | 192,677 | 157,407 | 5,245 | 5 | 83 s | 0 |

Both phases were accepted on their first `finish`. The author phase is large because its
prompt carries the engine's 47,000-character scenario guide, which is why 82% of its tokens
were cache reads.

Claude wrote ([the files](./phase-2-authored)):

- **A boot recipe** using the built-in payments fake, with the app's provider URL pointed at
  the proxy.
- **One scenario**, `checkout`: 20 customers create an order with a random amount, pay for
  it retrying up to four times, then read the order back.
- **Eight pledges**, all `proposed`: two it marked `stated` (from the code's "safe to
  repeat" docstring and `INSERT OR IGNORE`), three `domain_template`, three `inferred`.
- **Two faults files**: lost replies on the payment endpoint, and lost replies on the app's
  own call to the provider.
- **Two open questions for a reviewer**, including that one low-confidence pledge is a
  product decision.

The baseline passed. Then each faults file was run on five forked seeds:

| App | Faults | Pledges broken |
|---|---|---|
| Shop as shipped | Lost payment replies | 3 of 8, on 5 of 5 seeds: charged at most once, charges equal paid orders, one payment record per order |
| Shop with `PAYMENTS_GUARD=1` | Lost payment replies | 0 of 8 |
| Shop with `PAYMENTS_GUARD=1` | Lost provider replies | 2 of 8, on 5 of 5 seeds: charged at most once, charges equal paid orders |

- **It found the planted bug unprompted.** The repository says nothing about a bug. Claude's
  pledges and its first faults file expose the double charge, and the guard fixes it.
- **It found a bug that was not planted.** When the provider's reply is lost, the provider
  has charged but the app believes it failed, answers 502 and leaves the order unpaid. The
  customer retries and is charged again. The guard does not help, because the order was
  never marked paid. In one run: 30 charges for 20 orders. Fixing it needs an idempotency
  key sent to the provider, which the app does not do.
- **The overall verdict was `inconclusive` every time.** That is the design working: none of
  the pledges is approved, so none can block. The table above is what a reviewer would see.

## Second repository: leadecho

Run twice on 23 November 2026 against `rohansx/leadecho`, a real application: a Go 1.25
backend of about 600 files with Postgres, Redis and several third-party services. Only
tracked files from a fresh clone went into the sandbox.

| Run | Boot | Author | Total | Scenarios | Pledges |
|---|---|---|---|---|---|
| 1 | 2.18M tokens, 47 commands, 8 min 5 s | 3.00M tokens, 7 min 8 s | 15 min 40 s | signup, billing, attribution | 11 |
| 2 | 4.30M tokens, 63 commands, 15 min | 1.75M tokens, 5 min 43 s | 21 min 8 s | billing-webhooks, mention-pipeline | 7 |

About 95% of those tokens were cache reads. Both phases were accepted on the first `finish`
in both runs, and every baseline passed. In the boot phase Claude installed Go, Postgres and
Redis and wrote its own fakes for the payment and email providers, which is the path the
demo shop never exercised.

The second run saved a snapshot of the booted sandbox, and its two scenarios were then
scanned from that snapshot under their fault files on five forked seeds each:

| Scenario | Faults | Result |
|---|---|---|
| billing-webhooks | retries on the webhook and checkout paths | 3 of 3 pledges kept on 5 of 5 seeds |
| mention-pipeline | retries on signals, lead creation and reply drafts | 3 of 4 kept; `one-lead-per-mention` broken on 5 of 5 seeds |

The broken pledge is a real defect, confirmed in the source. `POST /api/v1/leads` inserts a
lead without looking for an existing one, and the `leads` table has no unique constraint on
the mention, while other code paths that create leads do look first. A client that retries
after a lost reply ends up with two leads for one mention: 5 or 6 of 20 journeys per seed.
Claude flagged it as its own reading and asked a reviewer to confirm it is a rule.

Two things this shows that the shop could not: the two runs wrote different scenarios and
different pledges for the same repository, so authoring is not repeatable; and the boot
phase alone cost between 2 and 4 million tokens.

## What this does not show

- **Two repositories, three boots.** All three succeeded, but three attempts on two apps is
  not a boot success rate, and both apps were ones the same author wrote.
- **Authoring is not repeatable.** Two runs on leadecho produced different scenarios and
  pledges. Nothing yet says which set is better or how to merge them.
- **No Compose boot.** Claude installed leadecho's services natively. Booting through a
  repository's Compose file is untested.
- **Claude ran the faults itself before finishing**, and said so in its summary. Its job was
  to write pledges the app ought to keep, not to hunt bugs. The pledges read as ones a
  reviewer would accept, but whether it wrote them from the code or from what it saw break
  cannot be told from one run.
- **Nothing is proven.** No planted-bug step exists yet, so every pledge is only `proposed`.
- **Both phases use the strongest default model.** The design's cheaper model for boot
  retries and log reading is not split out.
- **No prompt-injection test.** The "repo text is data" guardrail has not been attacked.

## Run it

```sh
cd python && uv pip install --python .venv/bin/python -e '.[engine,scan,agent,dev]'
pledge author ../demo/shop --out /tmp/authored-shop     # needs ANTHROPIC_API_KEY and E2B_API_KEY
pledge scan /tmp/authored-shop --scenario checkout --faults /tmp/authored-shop/.pledge/faults/lost-payment-replies.json
```

`pledge author` leaves out any `.pledge/` directory and `pledge.boot.json` already in the
repository, so the agent always starts from the code alone.
