"""Q-2: how long do snapshot, restore and fork take with a loaded Postgres, and are forks isolated from each other?"""
import json
import sys

import common  # noqa: F401 (loads the key)
from common import sh, timed
from e2b import Sandbox

ROWS = int(sys.argv[1]) if len(sys.argv) > 1 else 3_000_000
FORKS = 5
PSQL = "sudo -u postgres psql -Atc"

results: dict = {"rows": ROWS}
sandbox = Sandbox.create(timeout=1200)
others: list = []
snapshot_ids: list = []
print("sandbox", sandbox.sandbox_id)
try:
    with timed("apt install postgresql (native)", results):
        sh(sandbox, "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null 2>&1", timeout=600, check=True)
        # The package does not start the cluster in this image.
        sh(sandbox, "systemctl start postgresql; for i in $(seq 1 40); do pg_isready -q && break; sleep 0.5; done; pg_isready", check=True)
    with timed(f"load {ROWS} rows", results):
        sh(sandbox, f"{PSQL} \"create table orders as select n as id, md5(n::text) as ref, (n % 1000) as amount from generate_series(1,{ROWS}) n\" && {PSQL} 'checkpoint'", timeout=900, check=True)
    _, out, _ = sh(sandbox, f"{PSQL} \"select pg_size_pretty(pg_database_size('postgres')), count(*) from orders\"; df -h / | tail -1 | awk '{{print $3}}'; free -m | sed -n 2p | awk '{{print $3\" MiB used\"}}'")
    results["database"] = out.replace("\n", " | ")
    print(" ", results["database"])

    for mode in ("full", "filesystem"):
        with timed(f"create_snapshot mode={mode}", results):
            snapshot = sandbox.create_snapshot(mode=mode)
        snapshot_ids.append(snapshot.snapshot_id)
        with timed(f"Sandbox.create from {mode} snapshot", results):
            restored = Sandbox.create(snapshot.snapshot_id, timeout=300)
        others.append(restored)
        # A filesystem snapshot cold-boots, so Postgres has to start again before it answers.
        with timed(f"first query on {mode} restore", results):
            code, out, _ = sh(restored, f"for i in $(seq 1 60); do {PSQL} 'select count(*) from orders' 2>/dev/null && break; sleep 0.5; done")
        results[f"{mode} restore rows"] = out.splitlines()[-1] if out else f"exit {code}"

    with timed(f"fork x{FORKS} (running Postgres)", results):
        forks = sandbox.fork(count=FORKS, timeout=300)
    ok = [fork for fork in forks if not isinstance(fork, Exception)]
    others.extend(ok)
    results["forks started"] = f"{len(ok)}/{FORKS}"
    results["fork errors"] = [repr(fork)[:200] for fork in forks if isinstance(fork, Exception)]
    with timed(f"first query on each of {len(ok)} forks", results):
        counts = [sh(fork, f"{PSQL} 'select count(*) from orders'")[1] for fork in ok]
    results["fork rows"] = counts

    # Isolation: a write in one fork must not appear in the parent or a sibling.
    if len(ok) >= 2:
        sh(ok[0], f"{PSQL} 'delete from orders where id <= 1000'", check=True)
        results["isolation (fork0 after delete, fork1, parent)"] = [
            sh(box, f"{PSQL} 'select count(*) from orders'")[1] for box in (ok[0], ok[1], sandbox)
        ]
finally:
    for box in [sandbox, *others]:
        try:
            box.kill()
        except Exception as exc:  # noqa: BLE001
            print("kill failed", exc)
    for snapshot_id in snapshot_ids:
        try:
            Sandbox.delete_snapshot(snapshot_id)
        except Exception as exc:  # noqa: BLE001
            print("snapshot delete failed", exc)
print(json.dumps(results, indent=1))
