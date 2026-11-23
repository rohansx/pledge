"""Boot an app with its fakes behind the fault proxy, and run one scenario against it under a fault plan.

These run wherever the app runs: inside a sandbox for a scan, or on a laptop for the hand loop.
"""

from __future__ import annotations

import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from pledge.proxy import DEFAULT_ADMIN_PORT

BOOT_FILE = "pledge.boot.json"
STATE_DIR = ".pledge-run"
HEALTH_TIMEOUT_SECONDS = 30
ADMIN_URL = f"http://127.0.0.1:{DEFAULT_ADMIN_PORT}"


class BootError(RuntimeError):
    pass


def load_recipe(app_dir: Path) -> dict:
    """The boot recipe: which services to start, how the proxy routes to them, and where traffic goes."""
    path = app_dir / BOOT_FILE
    try:
        recipe = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise BootError(f"cannot read {path}: {exc}") from None
    if not isinstance(recipe, dict) or recipe.get("schema_version") != 1:
        raise BootError(f"{path}: schema_version must be 1")
    for key, kind in (("services", list), ("routes", dict), ("target", str)):
        if not isinstance(recipe.get(key), kind):
            raise BootError(f"{path}: {key} is required")
    return recipe


def _http(method: str, url: str, body: object = None, timeout: float = 10) -> dict:
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def _wait_healthy(name: str, url: str, process: subprocess.Popen, log_path: Path) -> None:
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise BootError(f"{name} exited with status {process.returncode}; see {log_path}")
        try:
            _http("GET", url, timeout=2)
            return
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.2)
    raise BootError(f"{name} was not healthy at {url} after {HEALTH_TIMEOUT_SECONDS}s; see {log_path}")


def _spawn(name: str, command: list[str], cwd: Path, env: dict[str, str], state: Path) -> tuple[subprocess.Popen, Path]:
    log_path = state / f"{name}.log"
    # A recipe says `python3`; use the interpreter that has pledge installed, which may be a virtualenv's.
    command = [sys.executable, *command[1:]] if command[0] == "python3" else command
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log_path.open("w"), stderr=subprocess.STDOUT, start_new_session=True)
    return process, log_path


def boot(app_dir: Path, extra_env: dict[str, str]) -> dict:
    """Start every service and the proxy, wait until each is healthy, and record their process ids."""
    app_dir = app_dir.resolve()
    recipe = load_recipe(app_dir)
    state = app_dir / STATE_DIR
    if (state / "pids.json").exists():
        raise BootError(f"already booted (found {state / 'pids.json'}); run `pledge down` first")
    state.mkdir(exist_ok=True)
    pids: dict[str, int] = {}
    try:
        for service in recipe["services"]:
            env = {**os.environ, **service.get("env", {}), **extra_env}
            process, log_path = _spawn(service["name"], service["command"], app_dir, env, state)
            pids[service["name"]] = process.pid
            _wait_healthy(service["name"], service["health"], process, log_path)
        routes = [f"{name}={route['listen']}={route['upstream']}" for name, route in recipe["routes"].items()]
        command = ["python3", "-m", "pledge.proxy", *(arg for route in routes for arg in ("--route", route))]
        process, log_path = _spawn("proxy", command, app_dir, dict(os.environ), state)
        pids["proxy"] = process.pid
        _wait_healthy("proxy", f"{ADMIN_URL}/healthz", process, log_path)
    except BaseException:
        _kill(pids)
        raise
    (state / "pids.json").write_text(json.dumps(pids))
    return {"services": pids, "target": recipe["target"]}


def _kill(pids: dict[str, int]) -> None:
    for pid in pids.values():
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass


def down(app_dir: Path) -> dict:
    path = app_dir.resolve() / STATE_DIR / "pids.json"
    pids = json.loads(path.read_text()) if path.exists() else {}
    _kill(pids)
    path.unlink(missing_ok=True)
    return {"stopped": sorted(pids)}


def run(app_dir: Path, scenario: str, faults_file: Path | None, seed: int, runs_dir: Path) -> dict:
    """One run: give the proxy this seed's fault plan, reset the fakes, let the engine drive and judge.

    Without `faults_file` the plan has no faults: a baseline run."""
    app_dir = app_dir.resolve()
    recipe = load_recipe(app_dir)
    faults = json.loads(faults_file.read_text())["faults"] if faults_file else []
    plan = {"schema_version": 1, "seed": seed, "faults": faults}
    _http("PUT", f"{ADMIN_URL}/plan", plan)  # the proxy validates it; a plan it cannot apply stops the run here
    for url in recipe.get("reset", []):
        _http("POST", url, {})

    with tempfile.TemporaryDirectory() as tmp:
        plan_path = Path(tmp) / "fault_plan.json"
        plan_path.write_text(json.dumps(plan))
        command = [
            sys.executable, "-m", "litetraffic", "verify", str(app_dir / ".pledge" / "scenarios" / scenario),
            "--target", recipe["target"], "--seed", str(seed), "--fault-plan", str(plan_path),
            "--output-dir", str(runs_dir), "--json",
        ]
        done = subprocess.run(command, capture_output=True, text=True, timeout=600)
    try:
        result = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError(f"engine produced no result (exit {done.returncode}): {done.stderr[-500:]}") from None
    if "run_id" not in result:
        raise RuntimeError(f"engine refused the run: {result.get('error', result)}")

    run_dir = runs_dir.resolve() / result["run_id"]
    injected = _http("GET", f"{ADMIN_URL}/log")["data"]["injected"]
    # Written after the engine sealed the run, so it is not in artifacts.json; kept apart under pledge/.
    (run_dir / "pledge").mkdir(exist_ok=True)
    (run_dir / "pledge" / "proxy_injected.json").write_text(json.dumps(injected, indent=2))
    return {"run_id": result["run_id"], "run_dir": str(run_dir), "seed": seed, "verdict": result["verdict"], "faults_injected": len(injected)}
