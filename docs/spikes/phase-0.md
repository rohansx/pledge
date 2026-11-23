# Phase 0 spike results

Run on 23 November 2026 against E2B Cloud with the Python SDK `e2b` 2.64.0. The scripts are in
[`spikes/`](../../spikes/); each one prints the numbers quoted here. Every figure is a
single run on the default sandbox, so treat them as orders of magnitude, not benchmarks.

## Verdict

The sandbox design holds. Nothing found here forces a change of approach.

| Question | Answer |
|---|---|
| Q-1. Can Docker Compose run inside a sandbox? | **Yes.** And running containers survive a fork. |
| Q-2. How fast is a fork with a loaded Postgres? | **About 3 to 5 seconds**, for one fork or five. |
| Q-2. How is snapshot storage billed? | **Not stated** in E2B's docs or pricing. Disk is listed as free. |
| Can outbound be closed after install? | **Yes**, and in-sandbox services stay reachable. |
| Q-4. Can an SDK with a hard-coded address be redirected? | **Yes**, without touching the app's code. One SDK needed an extra step. |

## The default sandbox

`s0_probe.py`. Debian 12, kernel 6.1, 2 vCPU, **473 MiB RAM**, 22 GB disk, systemd as init,
passwordless sudo. Python 3.11 and Node 20 are present. Docker, Postgres, Redis and k6 are
not. A sandbox is created in about half a second.

473 MiB is too little for a real stack. CPU and memory are set when a template is built,
not when a sandbox is created, so the base template has to declare them. E2B's docs say
sandboxes can have 1 to 8 vCPUs and 1 to 8 GiB.

## Q-1: Docker Compose

`s1_docker.py`.

| Step | Time |
|---|---|
| Install Docker (`get.docker.com`) | 20.8 s |
| `docker run hello-world` | 2.0 s |
| `docker compose up` for Postgres 16 and a small HTTP service, including image pulls | 8.7 s |
| Fork with both containers running | 4.4 s |

Docker 29.10 runs under systemd with the overlayfs driver and cgroup v2. Both services came
up, the HTTP service answered and Postgres accepted writes.

In the fork, `docker ps` showed both containers still up with the same container id, the
HTTP service answered, and the 1,000 rows written before the fork were there. A fork copies
memory, so nothing restarted.

Memory was the limit: with that small stack running, 30 MiB of the 473 was free. E2B's own
Docker guide recommends at least 2 vCPU and 2 GB.

**Decision.** The base template ships Docker. The engine, k6, the fault proxy and the fakes
run natively from the template; the customer's app runs however its repository defines it,
with Compose when it has a Compose file. This removes the "every service must run natively"
risk that would have narrowed the supported stacks.

## Q-2: snapshot and fork with a loaded Postgres

`s2_snapshot.py`. Postgres 15 installed natively, one table of 3,000,000 rows (226 MB
database, 2.1 GB used on disk).

| Operation | Time |
|---|---|
| `create_snapshot`, full (memory and disk) | 4.6 s |
| New sandbox from the full snapshot | 4.7 s |
| First query on it | 0.9 s |
| `create_snapshot`, filesystem only | 0.4 s |
| New sandbox from the filesystem snapshot | 4.7 s |
| First query on it | none within 30 s |
| `fork(count=5)` of the running sandbox | 2.8 s |
| First query on all five forks, one after another | 4.0 s |

- All five forks started and each saw all 3,000,000 rows.
- **Forks are isolated.** Deleting 1,000 rows in one fork left the parent and a sibling at
  3,000,000.
- `fork` takes one snapshot and starts every copy from it, so five forks cost about the same
  wall-clock time as one.
- A filesystem-only snapshot cold-boots. Postgres did not come back within 30 seconds on
  that restore, because nothing starts it at boot in this image. Use full snapshots. A
  filesystem snapshot would need every service enabled at boot and a wait for readiness.

"Boot once, fork many" works as designed: the fork is a few seconds against a boot that
installs dependencies and loads data.

**Billing.** From E2B's pricing and billing pages, read the same day:

- Running sandboxes are billed per second: $0.000014 per vCPU-second and $0.0000045 per
  GiB-second of RAM. Compute billing stops when a sandbox is paused, killed or times out.
- Disk is listed as free and included in every plan.
- No price, allowance or retention period is stated for snapshots. Paused sandboxes are kept
  indefinitely.

So a 2 vCPU, 2 GiB sandbox costs about $0.13 an hour, and snapshot storage is an unknown to
confirm with E2B before pricing depends on it.

**Plan limits** from the same pages: Hobby allows 10 concurrent sandboxes and 1 hour of
continuous runtime; Pro allows 100 and 24 hours. This differs from the 20 and 100 quoted in
[cost and performance](../cost-and-performance.md).

## Closing outbound access

`s3_network.py`, parts A and B.

With `allow_out` set to four registry hostnames and `deny_out` set to all traffic:

| Destination | Result |
|---|---|
| `registry.npmjs.org`, `pypi.org` | Reachable |
| `example.com`, and the raw address `1.1.1.1` | Blocked |
| `pip install` and `npm install` | Succeeded, 11.6 s |

Then `update_network` with only `deny_out` for all traffic, on the running sandbox:

| Check | Result |
|---|---|
| `registry.npmjs.org`, `example.com` | Blocked |
| DNS lookup | No answer |
| A service on `127.0.0.1` inside the sandbox | Reachable |
| Running commands through the SDK | Still works |

The rules are enforced on E2B's host, outside the sandbox, so code inside cannot remove
them. Domain rules match the HTTP Host header on port 80 and the TLS server name on port
443; other ports are filtered by address only. `update_network` replaces the whole rule set,
it does not merge.

## Q-4: SDKs that hard-code the provider's address

`s3_network.py` part C and `s3b_bundled_ca.py`. With outbound closed, three things were set
up inside the sandbox: a fake HTTPS server on `127.0.0.1:443`, a hosts entry pointing
`api.stripe.com` at it, and a certificate for that name signed by a certificate authority
created in the sandbox. Then five clients called `https://api.stripe.com/v1/customers`.

| Client | Hosts entry only | CA in system store | Plus CA env vars | CA appended to bundled files |
|---|---|---|---|---|
| curl | Fails | Works | Works | |
| Node `fetch` (Node 20.9) | Fails | Works | Works | |
| Stripe Node SDK 23.2 | Fails | Works | Works | |
| Python `requests` | Fails | Fails | Works | |
| Stripe Python SDK 17.1 | Fails | Fails | Fails | Works |

The fake logged the requests from each client that got through, including the real Stripe
SDKs, which used their normal code paths and saw a normal response.

- **No DNS server and no TLS-stripping proxy are needed.** A hosts entry and a trusted
  certificate authority are enough.
- **Trust has to be installed in three places:** the system store, the environment variables
  `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE` and `NODE_EXTRA_CA_CERTS`, and any CA file a library
  ships inside its own package.
- Stripe's Python SDK is the third kind. It ships its own CA file and ignores the system
  store and the environment. Appending the sandbox CA to every CA file under `site-packages`
  made it work, with no change to the app.

This is per-provider work for the fakes, not a platform feature. E2B's per-host rules only
add headers, they cannot redirect a host elsewhere.

## Not tested

- Trust inside containers. An app running under Compose needs the hosts entry and the CA
  inside its container, through `extra_hosts` and a mounted certificate. Expected to work,
  not run.
- Runtimes other than Python and Node. Java keeps its own trust store, and a Go binary built
  with pinned certificates could not be redirected this way at all.
- Fork and snapshot time on a larger machine or with a database of several gigabytes.
- Whether a fork under real request load is as quick as a fork of an idle sandbox.
- Certificate pinning. An SDK that pins its provider's certificate would defeat this
  approach. Neither Stripe SDK does.
