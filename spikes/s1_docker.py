"""Q-1: can Docker Compose run inside an E2B sandbox, and do running containers survive a fork?"""
import json

import common  # noqa: F401 (loads the key)
from common import sh, timed
from e2b import Sandbox

COMPOSE = """
services:
  db:
    image: postgres:16-alpine
    environment: { POSTGRES_PASSWORD: spike }
    ports: ["5432:5432"]
  app:
    image: traefik/whoami
    ports: ["8000:80"]
"""

results: dict = {}
sandbox = Sandbox.create(timeout=900)
forks = []
print("sandbox", sandbox.sandbox_id)
try:
    with timed("install docker (get.docker.com)", results):
        code, out, _ = sh(sandbox, "curl -fsSL https://get.docker.com | sh 2>&1 | tail -5", timeout=600)
        results["install exit"] = code
        print(out[-400:])
    code, out, _ = sh(sandbox, "systemctl is-active docker; docker version --format '{{.Server.Version}}' ; docker info --format '{{.Driver}} cgroup={{.CgroupDriver}}/{{.CgroupVersion}}' 2>&1 | tail -2")
    results["dockerd"] = out
    print(out)
    with timed("docker run hello-world", results):
        code, out, _ = sh(sandbox, "docker run --rm hello-world 2>&1 | grep -c 'Hello from Docker'", timeout=300)
        results["hello-world"] = (code, out)

    sandbox.files.write("/root/stack/compose.yml", COMPOSE)
    with timed("compose up (pull + start)", results):
        code, out, _ = sh(sandbox, "cd /root/stack && docker compose up -d 2>&1 | tail -4", timeout=600)
        results["compose exit"] = code
        print(out)
    code, out, _ = sh(sandbox, "sleep 6; docker compose -f /root/stack/compose.yml ps --format '{{.Service}}={{.State}}'; curl -s -m 5 localhost:8000 | head -2; "
                               "docker exec stack-db-1 psql -U postgres -Atc \"create table t as select generate_series(1,1000) n; select count(*) from t\"")
    results["stack check"] = out
    print(out)
    code, out, _ = sh(sandbox, "free -m | sed -n 2p")
    results["memory after stack"] = out

    with timed("fork x1 (containers running)", results):
        forks = sandbox.fork(count=1, timeout=300)
    fork = forks[0]
    if isinstance(fork, Exception):
        results["fork"] = f"failed: {fork!r}"
    else:
        code, out, _ = sh(fork, "docker ps --format '{{.Names}}={{.Status}}'; curl -s -m 5 localhost:8000 | head -1; "
                                "docker exec stack-db-1 psql -U postgres -Atc 'select count(*) from t'")
        results["fork check"] = (code, out)
        print("fork:", out)
finally:
    for item in [sandbox, *forks]:
        if not isinstance(item, Exception):
            try:
                item.kill()
            except Exception as exc:  # noqa: BLE001
                print("kill failed", exc)
print(json.dumps(results, indent=1))
