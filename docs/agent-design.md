# Agent design

Status: proposed. See [architecture](./architecture.md) for where the agent runner sits.

Claude runs as four short, separate phases, not one long session. Each phase starts with a
fresh context, gets only the previous phase's structured output, and must end by returning a
structured result.

## Phases

| Phase | Input | Output | Stops when |
|---|---|---|---|
| Discover and boot | The repo | Boot recipe, environment map, list of outbound calls | Health check passes |
| Author | Repo profile, route list | Scenario manifests and pledges, each with its source | Every manifest passes the engine's validator |
| Prove | One pledge | A planted bug as a patch, and whether the pledge broke | One pledge, one verdict |
| Explain | A broken pledge and its evidence | A plain-language finding and a minimal fault plan | Report section written |

## Tools

The agent gets a small fixed set, all scoped to one sandbox:

- run a command
- read a file
- write a file
- make an HTTP request inside the sandbox
- run the engine
- finish with a result

It has no tool that reaches the internet, GitHub or another customer's sandbox.

## Where pledges come from

Each pledge records its source, and the source sets its starting confidence:

1. **Stated in the code:** database constraints, existing tests, validation rules, comments
   and docs. Highest confidence.
2. **Domain templates:** known rules for payments, inventory, credits and tenancy, applied
   when the matching tables and routes exist.
3. **Inferred:** Claude's reading of what the code intends. Lowest confidence, always shown
   for review first.

Built so far: run a command, read a file, write a file, and finish. The HTTP request tool is
covered by running curl, and running the engine is a command. See [phase-2](./phase-2.md).

## Guardrails

- **No verdict authority.** Claude never decides pass or fail. It writes checks; the engine
  runs them.
- **Validation before use.** Every manifest goes through the engine's inspect step. Invalid
  output is returned to the agent, not run.
- **Budgets per phase.** Tokens, wall-clock time and command count are capped, and hitting a
  cap ends the phase with a partial result.
- **Repo text is data.** A README or code comment that says "ignore your instructions" is
  content to analyse, never an instruction. The narrow tool set limits the damage if this
  fails.
- **Proof gates trust.** An unproven pledge can appear in a report but cannot block a merge.

## Models

Use the strongest model for the author and prove phases, where judgment matters, and a
smaller, cheaper one for boot retries and log reading. Cache the repo profile in the prompt
across phases.

Check the Claude API docs for current models and pricing before fixing these choices.
