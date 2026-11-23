# Cost and performance controls

Status: proposed. No numbers here are measured.

Tokens dominate the cost of a first scan and sandbox time dominates a pull request run, so
each has its own controls.

## Controls

- **Boot once, fork many.** The expensive install and boot happens once per commit. Proof
  runs and fault runs start from the snapshot.
- **Cache the repo profile.** Key it by commit. A pull request reuses it and re-reads only
  changed files.
- **Prompt caching.** The repo profile and route list are the same across phases, so they
  are cached, not resent at full price.
- **Right model for the step.** Strong model for authoring and proving, small model for boot
  retries and log reading.
- **Adaptive seeds.** Start each fault plan on a small number of seeds. Add more only when
  results disagree or a pledge breaks.
- **Diff-scoped runs.** A pull request reruns only scenarios whose routes or files it
  touches.
- **Hard budgets.** Every scan has a cap on tokens, sandbox minutes and wall-clock time, and
  reports partial results when it hits one.
- **Concurrency.** Parallel forks are limited by the E2B plan. E2B's billing page lists 10 concurrent
  sandboxes on Hobby and 100 on Pro (read 23 November 2026; the overview quoted 20 and 100).

## Metrics to instrument from the first scan

Pricing depends on these.

- [ ] Boot success rate, by stack
- [ ] Tokens per phase
- [ ] Sandbox minutes per first scan and per pull request run
- [ ] Share of pledges that are proven
- [ ] Share of pledges the founder approves
- [ ] Share of broken-pledge findings that reproduce on rerun
