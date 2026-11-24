"""Spike: add a browser to an authored snapshot, so a scan can record what a user sees.

    python spikes/s4_browser_snapshot.py SNAPSHOT_ID

Starts from the saved, booted leadecho snapshot with outbound open (installs need it), installs Playwright
and Chromium, builds leadecho's dashboard and serves it on 13200 with /api going through the fault proxy,
then saves a new snapshot and prints its id. Scans from the new snapshot run closed, as before.
"""

import sys
import time

from e2b import Sandbox

from pledge.scan import _sh, load_key

PLAYWRIGHT = "1.56.1"
UI_PORT = 13200
NODE = "v22.14.0"  # the dashboard's Vite 7 and pnpm 11 need a newer Node than the template's 20.9
NODE_PATH = f"PATH=/opt/node-{NODE}-linux-x64/bin:$PATH"
STEPS = [
    ("app still answers", "curl -s -m 10 -o /dev/null -w '%{http_code}' http://127.0.0.1:18100/healthz", 30),
    ("playwright", f"set -o pipefail; mkdir -p /opt/pw && cd /opt/pw && npm init -y >/dev/null && npm install playwright@{PLAYWRIGHT} 2>&1 | tail -2 && npx playwright install --with-deps chromium 2>&1 | tail -3", 900),
    ("node", f"curl -fsSL https://nodejs.org/dist/{NODE}/node-{NODE}-linux-x64.tar.xz | tar -xJ -C /opt && {NODE_PATH} node --version", 300),
    ("dashboard deps", f"set -o pipefail; cd /work/app/dashboard && {NODE_PATH} npm install -g pnpm@11.2.2 2>&1 | tail -1 && {NODE_PATH} pnpm install --frozen-lockfile 2>&1 | tail -3", 900),
    ("dashboard build", f"set -o pipefail; cd /work/app/dashboard && {NODE_PATH} pnpm exec vite build 2>&1 | tail -3", 600),
    # vite preview serves the build, falls back to index.html for app routes and proxies /api like the dev server.
    # Started detached from Python: a shell `&` keeps the command's stream open and the call never returns.
    ("serve", f"""python3 -c "import subprocess,os; subprocess.Popen(['pnpm','exec','vite','preview','--port','{UI_PORT}','--strictPort','--host','127.0.0.1'], cwd='/work/app/dashboard', env=dict(os.environ, PATH='/opt/node-{NODE}-linux-x64/bin:'+os.environ['PATH'], API_URL='http://127.0.0.1:18100'), start_new_session=True, stdin=subprocess.DEVNULL, stdout=open('/work/dashboard.log','w'), stderr=subprocess.STDOUT)" && sleep 6 && curl -s -m 10 -o /dev/null -w '%{{http_code}}' http://127.0.0.1:{UI_PORT}/login && curl -s -m 10 -o /dev/null -w ' api:%{{http_code}}' http://127.0.0.1:{UI_PORT}/api/v1/auth/me""", 60),
    ("memory", "free -m | sed -n 2p; df -h / | tail -1", 30),
]


def main() -> None:
    load_key()
    sandbox = Sandbox.create(sys.argv[1], timeout=50 * 60)
    try:
        print("sandbox", sandbox.sandbox_id, flush=True)
        for name, command, timeout in STEPS:
            started = time.monotonic()
            print(f"[{name}] {_sh(sandbox, command, timeout).strip()}  ({time.monotonic() - started:.0f}s)", flush=True)
        sandbox.update_network({"deny_out": ["0.0.0.0/0"]})
        print("snapshot", sandbox.create_snapshot(mode="full").snapshot_id, flush=True)
    finally:
        sandbox.kill()


if __name__ == "__main__":
    main()
