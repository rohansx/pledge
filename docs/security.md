# Security and data handling

Status: proposed.

The system runs strangers' code and holds their source, so isolation and deletion are
product features, not hygiene.

## Risks and controls

| Risk | Control |
|---|---|
| Customer code attacks the platform | Each scan runs in its own microVM. The agent runner, API keys and GitHub token stay outside it |
| Customer code reaches the internet | Outbound access is closed after install. Only package registries are allowed before that |
| A test touches a real system | Third-party URLs point at fakes. Production secrets are never requested, and the sandbox gets generated test values |
| Source code retained too long | The sandbox and its snapshots are deleted on a schedule the customer sets. Only run evidence is kept |
| Secrets leak into evidence | The engine already replaces declared secrets and minted tokens with a redaction marker. Extend that to proxy and fake-service logs |
| A typed password is kept in a browser recording | A Playwright trace keeps what was typed in three places: the action, the page snapshots and the sign-in request. Playwright cannot leave them out, so the runner notes every value a password field held (and anything the steps wrap in `secret()`), and the trace is rewritten without them before it is stored; a trace that cannot be rewritten is deleted. Not caught: a value under 6 characters (so also the first five characters of a password typed key by key), a value that was transformed (base64, a hash), a password the page displays as text, and session tokens the app issues to the synthetic user. See `local.scrub_trace` |
| Instructions hidden in repo text | Repo content is treated as data, the tool set is narrow, and the agent has no network or cross-tenant reach |
| A scenario is pointed at production | Scans only target sandboxes Pledge created. The engine already refuses cloud metadata and link-local addresses and can bind a scenario to an approved target |
| One customer sees another's data | One sandbox, one evidence prefix and one token per customer. No shared sandboxes |

## Deployment options

1. **Default: Pledge's own E2B account.**
2. **Bring your own cloud.** For teams that will not let source leave their control, runs
   happen inside the customer's own E2B or cloud account, with the control plane seeing only
   verdicts and redacted evidence. Workers IO sells the same option as bring-your-own-cloud.

## Source code and the Anthropic API

Source code is sent to the Anthropic API during discovery and authoring. Say so plainly in
the security page, and check Anthropic's current data retention terms before promising
anything about it.
