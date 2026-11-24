"""`pledge author`: the first two agent phases of a first scan, on a repository Pledge has not seen.

Claude boots the app in a sandbox and writes the boot recipe, then, with a fresh context, writes scenarios,
pledges and faults files. Each phase ends only when deterministic checks accept its output. The result is
a copy of the repository with those files added, the baseline runs, and a report of what each phase cost.
"""

from __future__ import annotations

import io
import json
import sys
import tarfile
import time
from pathlib import Path

from pledge import agent
from pledge.scan import APP, DENY_ALL, PACKAGE, RUNS, SANDBOX_SECONDS, _sh, _upload, load_key
from pledge.template import TEMPLATE

# Open during the boot phase only, so the agent can install dependencies. Closed before anything is run.
INSTALL_HOSTS = [
    "registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "deb.debian.org", "security.debian.org",
    "registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com", "ghcr.io", "pkg-containers.githubusercontent.com",
    "proxy.golang.org", "sum.golang.org", "go.dev", "dl.google.com", "storage.googleapis.com",
    "github.com", "codeload.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
    "apt.postgresql.org", "deb.nodesource.com", "static.crates.io", "index.crates.io", "rubygems.org",
]
# A first scan starts from the repository alone: anything already authored is left behind.
AUTHORED = {".pledge", "pledge.boot.json"}
WRAPPER = f'#!/bin/sh\nPYTHONPATH={PACKAGE} exec python3 -m pledge.cli "$@"\n'


def _download(sandbox, remote_dir: str, local_dir: Path) -> None:
    _sh(sandbox, f"mkdir -p {remote_dir} && tar -czf /tmp/out.tgz --exclude=.pledge-run --exclude=node_modules --exclude=.venv --exclude='*.db' --exclude=__pycache__ -C {remote_dir} .")
    data = bytes(sandbox.files.read("/tmp/out.tgz", format="bytes", user="root"))
    local_dir.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        archive.extractall(local_dir, filter="data")  # the sandbox ran untrusted code; refuse paths that escape


def author(app_dir: Path, out_dir: Path, live=None) -> dict:
    """`live`, a `pledge.publish.LiveRun`, receives each phase and step as it happens."""
    import anthropic
    from e2b import Sandbox

    app_dir, out_dir = app_dir.resolve(), out_dir.resolve()
    if out_dir.exists() and any(out_dir.iterdir()):
        raise ValueError(f"{out_dir} is not empty")
    load_key()
    agent.load_key()
    client = anthropic.Anthropic()

    def log(message: str) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)
        phase, _, step = message.partition(": ")
        if live and phase in ("boot", "author") and step:
            live.event("phase_step", phase=phase, label=step[:160], ok="not accepted" not in step)

    started = time.monotonic()
    # The E2B Hobby plan stops a sandbox after one hour.
    sandbox = Sandbox.create(TEMPLATE, timeout=55 * 60, network={"allow_out": INSTALL_HOSTS, "deny_out": DENY_ALL})
    phases: list[agent.PhaseResult] = []
    try:
        log(f"sandbox {sandbox.sandbox_id}")
        _upload(sandbox, Path(__file__).resolve().parent, f"{PACKAGE}/pledge")
        _upload(sandbox, app_dir, APP, skip=AUTHORED)
        sandbox.files.write("/usr/local/bin/pledge", WRAPPER, user="root")
        _sh(sandbox, "chmod +x /usr/local/bin/pledge")

        boot = agent.run_phase(client, sandbox, agent.boot_phase(), log)
        phases.append(boot)
        sandbox.update_network({"deny_out": DENY_ALL})  # installs are done; nothing from here on may reach out
        log("boot accepted; outbound closed")

        recipe = sandbox.files.read(f"{APP}/pledge.boot.json", user="root")
        if live:
            live.phase("author")
        authored = agent.run_phase(client, sandbox, agent.author_phase(boot.result, recipe), log)
        phases.append(authored)
        log("author accepted")

        _download(sandbox, APP, out_dir)
        _download(sandbox, RUNS, out_dir / ".pledge-runs")
        if live:
            from pledge.verdict import load_pledges

            for pledge in load_pledges(out_dir):
                live.event("pledge_proposed", id=pledge["id"], statement=pledge["statement"][:300], source=pledge["source"])
        # Boot once, fork many: the booted app, with everything the agent installed, is saved so that scans
        # start from it instead of installing again (and so that they can run with outbound closed).
        snapshot_id = sandbox.create_snapshot(mode="full").snapshot_id
        log(f"snapshot {snapshot_id}")
    finally:
        try:
            sandbox.kill()
        except Exception:  # noqa: BLE001 - it still expires on its timeout
            pass
    report = {
        "schema_version": 1,
        "out_dir": str(out_dir),
        "snapshot_id": snapshot_id,
        "seconds": round(time.monotonic() - started, 1),
        "phases": [phase.to_json() for phase in phases],
        "baseline": phases[-1].check.get("baseline", []),
        "scenarios": phases[-1].check.get("scenarios", []),
        "pledges": phases[-1].check.get("pledges", []),
    }
    (out_dir / ".pledge-runs").mkdir(exist_ok=True)
    (out_dir / ".pledge-runs" / "author-report.json").write_text(json.dumps(report, indent=2))
    return report


def format_report(report: dict) -> list[str]:
    lines = [f"authored into {report['out_dir']} in {report['seconds']}s", f"  snapshot: {report['snapshot_id']}"]
    for phase in report["phases"]:
        usage = phase["usage"]
        lines.append(
            f"  {phase['phase']}: {usage['requests']} requests, {usage['tokens']} tokens "
            f"({usage['cache_read_tokens']} read from cache, {usage['output_tokens']} output), "
            f"{usage['commands']} commands, {usage['seconds']}s, {usage['rejected_finishes']} finish rejected"
        )
    lines.append(f"  scenarios: {', '.join(report['scenarios'])}")
    lines.append(f"  pledges: {', '.join(report['pledges'])}")
    for run in report["baseline"]:
        flagged = f"  (failing: {', '.join(run['failing_assertions'])}; needs review)" if run["failing_assertions"] else ""
        lines.append(f"  baseline {run['scenario']}: {run['verdict']}{flagged}")
    return lines
