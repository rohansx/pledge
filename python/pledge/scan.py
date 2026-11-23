"""`pledge scan`: boot the app once in an E2B sandbox, fork it per seed, run each fork under its own fault
plan, bring the evidence back, and judge the pledges across all of them.

This runs outside the sandbox and is the only module that talks to E2B. The customer's code never sees the
E2B key: it stays in this process.
"""

from __future__ import annotations

import io
import json
import os
import tarfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from pledge.template import TEMPLATE
from pledge.verdict import verdict

KEY_FILE = Path.home() / ".config/workz/e2b.env"
DENY_ALL = ["0.0.0.0/0"]
SANDBOX_SECONDS = 15 * 60
APP, PACKAGE, RUNS = "/work/app", "/opt/pledge", "/work/runs"
PLEDGE = f"cd /work && PYTHONPATH={PACKAGE} python3 -m pledge.cli"
SKIP = {".pledge-run", "__pycache__", ".venv", "node_modules", ".git"}
MAX_EVIDENCE_BYTES = 64 * 1024 * 1024


def load_key() -> None:
    """E2B_API_KEY from the environment, else from the key file kept outside the repository."""
    if os.environ.get("E2B_API_KEY"):
        return
    try:
        lines = KEY_FILE.read_text().splitlines()
    except OSError:
        raise RuntimeError(f"E2B_API_KEY is not set and {KEY_FILE} is not readable") from None
    for line in lines:
        name, _, value = line.partition("=")
        if name == "E2B_API_KEY" and value.strip():
            os.environ["E2B_API_KEY"] = value.strip()
            return
    raise RuntimeError(f"{KEY_FILE} has no E2B_API_KEY")


def _tar(directory: Path) -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        archive.add(directory, arcname=".", filter=lambda item: None if Path(item.name).name in SKIP or item.name.endswith((".db", ".pyc")) else item)
    return buffer.getvalue()


def _sh(sandbox, command: str, timeout: int = 300) -> str:
    """Run a command as root; raise with the output's tail if it fails."""
    from e2b import CommandExitException

    try:
        return sandbox.commands.run(command, timeout=timeout, user="root").stdout
    except CommandExitException as exc:
        raise RuntimeError(f"in sandbox, `{command[:70]}` exited {exc.exit_code}: {(exc.stdout + exc.stderr)[-600:]}") from None


def _upload(sandbox, directory: Path, destination: str) -> None:
    sandbox.files.write("/tmp/upload.tgz", _tar(directory), user="root")
    _sh(sandbox, f"mkdir -p {destination} && tar -xzf /tmp/upload.tgz -C {destination} && rm /tmp/upload.tgz")


def _one_run(fork, scenario: str, faults: str | None, seed: int, runs_dir: Path) -> dict:
    """Run one seed in one fork and bring its run directory back."""
    fork.update_network({"deny_out": DENY_ALL})  # a fork must be as closed as its parent, whatever it inherited
    flags = f"--faults {APP}/{faults} " if faults else ""
    summary = json.loads(_sh(fork, f"{PLEDGE} run app --scenario {scenario} {flags}--seed {seed} --runs-dir {RUNS}").strip().splitlines()[-1])
    _sh(fork, f"tar -czf /tmp/evidence.tgz -C {RUNS} {summary['run_id']}")
    evidence = bytes(fork.files.read("/tmp/evidence.tgz", format="bytes", user="root"))
    if len(evidence) > MAX_EVIDENCE_BYTES:
        raise RuntimeError(f"evidence for seed {seed} is {len(evidence)} bytes, over the {MAX_EVIDENCE_BYTES} limit")
    with tarfile.open(fileobj=io.BytesIO(evidence), mode="r:gz") as archive:
        # The sandbox ran untrusted code: the "data" filter refuses paths that leave runs_dir, links and devices.
        archive.extractall(runs_dir, filter="data")
    return {**summary, "run_dir": str(runs_dir / summary["run_id"])}


def scan(app_dir: Path, scenario: str, faults_file: Path | None, seeds: int, env: dict[str, str], runs_dir: Path) -> dict:
    from e2b import Sandbox

    if not 1 <= seeds <= 8:
        raise ValueError("--seeds must be 1 to 8 (the E2B Hobby plan allows 10 sandboxes at once)")
    app_dir, runs_dir = app_dir.resolve(), runs_dir.resolve()
    faults = None
    if faults_file is not None:
        try:
            faults = faults_file.resolve().relative_to(app_dir).as_posix()
        except ValueError:
            raise ValueError("--faults must be a file inside the app directory, so that it is uploaded with it") from None
    load_key()
    runs_dir.mkdir(parents=True, exist_ok=True)

    timings: dict[str, float] = {}
    started = clock = time.monotonic()

    def lap(name: str) -> None:
        nonlocal clock
        timings[name] = round(time.monotonic() - clock, 2)
        clock = time.monotonic()

    # Closed from the first second: this app needs nothing from the internet to boot.
    # ponytail: an app that installs dependencies needs registries allowed during boot, then update_network.
    sandbox = Sandbox.create(TEMPLATE, timeout=SANDBOX_SECONDS, network={"deny_out": DENY_ALL})
    forks: list = []
    try:
        lap("create sandbox")
        _upload(sandbox, Path(__file__).resolve().parent, f"{PACKAGE}/pledge")
        _upload(sandbox, app_dir, APP)
        lap("upload")
        boot_env = " ".join(f"--env {name}={value}" for name, value in env.items())
        _sh(sandbox, f"{PLEDGE} boot app {boot_env}")
        egress = _sh(sandbox, "curl -s -m 5 -o /dev/null -w '%{http_code}' https://example.com/ || true").strip()
        lap("boot")
        forks = sandbox.fork(count=seeds, timeout=SANDBOX_SECONDS)
        failed = [fork for fork in forks if isinstance(fork, Exception)]
        if failed:
            raise RuntimeError(f"{len(failed)} of {seeds} forks failed to start: {failed[0]!r}")
        lap(f"fork x{seeds}")
        with ThreadPoolExecutor(max_workers=seeds) as pool:
            runs = list(pool.map(lambda pair: _one_run(pair[1], scenario, faults, pair[0], runs_dir), enumerate(forks, start=1)))
        lap("runs (parallel)")
    finally:
        for box in [sandbox, *forks]:
            if not isinstance(box, Exception):
                try:
                    box.kill()
                except Exception:  # noqa: BLE001 - a sandbox that will not die still expires on its timeout
                    pass
    report = verdict(app_dir, [Path(run["run_dir"]) for run in runs])
    timings["total"] = round(time.monotonic() - started, 2)
    return {**report, "sandbox": {"template": TEMPLATE, "outbound_blocked": egress in ("000", ""), "seconds": timings}, "run_dirs": [run["run_dir"] for run in runs]}
