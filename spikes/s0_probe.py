"""What is a default E2B sandbox? Machine shape, privileges, and what is preinstalled."""
import time

import common  # noqa: F401 (loads the key)
from common import sh
from e2b import Sandbox

started = time.monotonic()
sandbox = Sandbox.create(timeout=300)
print(f"create: {time.monotonic() - started:.2f}s  id={sandbox.sandbox_id}")
try:
    for label, command in [
        ("os", "grep PRETTY_NAME /etc/os-release; uname -r"),
        ("shape", "nproc; free -m | sed -n 2p; df -h / | tail -1"),
        ("default user", "su user -c 'whoami; sudo -n true && echo passwordless-sudo'"),
        ("docker", "command -v docker dockerd containerd runc podman || echo none"),
        ("kernel features", "ls /sys/fs/cgroup | head -5; grep -c overlay /proc/filesystems; lsmod 2>/dev/null | grep -cE 'overlay|br_netfilter|nf_tables|iptable'"),
        ("runtimes", "for b in python3 node psql redis-server k6 git curl iptables nft; do printf '%s=' $b; command -v $b || echo -; done"),
        ("egress", "curl -s -m 10 -o /dev/null -w '%{http_code}' https://registry.npmjs.org/"),
        ("init", "ps -p 1 -o comm=; systemctl is-system-running 2>&1 | head -1"),
    ]:
        code, out, took = sh(sandbox, command)
        print(f"-- {label} (exit {code}, {took}s)\n{out}")
finally:
    sandbox.kill()
