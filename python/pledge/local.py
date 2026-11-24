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
HEALTH_TIMEOUT_SECONDS = 90
LOG_TAIL_LINES = 300
ADMIN_URL = f"http://127.0.0.1:{DEFAULT_ADMIN_PORT}"
BROWSER_STEPS = "browser.cjs"  # optional, next to a scenario's journeys.js
BROWSER_FILES = ("trace.zip", "video.webm", "screenshot.png")
BROWSER_TIMEOUT_SECONDS = 120
PLAYWRIGHT_MODULES = "/opt/pw/node_modules"  # where the sandbox has Playwright; see pledge.template


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


def _start_proxy(recipe: dict, app_dir: Path, state: Path) -> int:
    routes = [f"{name}={route['listen']}={route['upstream']}" for name, route in recipe["routes"].items()]
    command = ["python3", "-m", "pledge.proxy", *(arg for route in routes for arg in ("--route", route))]
    process, log_path = _spawn("proxy", command, app_dir, dict(os.environ), state)
    _wait_healthy("proxy", f"{ADMIN_URL}/healthz", process, log_path)
    return process.pid


def restart_proxy(app_dir: Path) -> None:
    """Replace the running proxy with one from the code on disk now. An app restored from a snapshot still runs
    the proxy it was saved with, which may be older than the package a scan just uploaded."""
    app_dir = app_dir.resolve()
    state = app_dir / STATE_DIR
    pids = json.loads((state / "pids.json").read_text())
    _kill({"proxy": pids["proxy"]})
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:  # its ports are free once the old one stops answering
        try:
            _http("GET", f"{ADMIN_URL}/healthz", timeout=1)
            time.sleep(0.1)
        except (urllib.error.URLError, OSError, ValueError):
            break
    pids["proxy"] = _start_proxy(load_recipe(app_dir), app_dir, state)
    (state / "pids.json").write_text(json.dumps(pids))


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
        pids["proxy"] = _start_proxy(recipe, app_dir, state)
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
    log = _http("GET", f"{ADMIN_URL}/log")["data"]
    injected = log["injected"]
    # Written after the engine sealed the run, so it is not in artifacts.json; kept apart under pledge/.
    (run_dir / "pledge").mkdir(exist_ok=True)
    (run_dir / "pledge" / "proxy_injected.json").write_text(json.dumps(injected, indent=2))
    (run_dir / "pledge" / "proxy_traffic.json").write_text(json.dumps(log.get("traffic", [])))
    # The end of each service's log, so a seed where the app misbehaved can be diagnosed after its sandbox is gone.
    (run_dir / "pledge" / "logs").mkdir(exist_ok=True)
    for service_log in (app_dir / STATE_DIR).glob("*.log"):
        lines = service_log.read_text(errors="replace").splitlines()[-LOG_TAIL_LINES:]
        (run_dir / "pledge" / "logs" / service_log.name).write_text("\n".join(lines) + "\n")
    _record_browser(app_dir / ".pledge" / "scenarios" / scenario / BROWSER_STEPS, run_dir)
    return {"run_id": result["run_id"], "run_dir": str(run_dir), "seed": seed, "verdict": result["verdict"], "faults_injected": len(injected)}


def _record_browser(steps: Path, run_dir: Path) -> None:
    """When a check failed for a journey and the scenario has browser steps, record a browser showing what that
    journey's user now sees. Best effort: a run's verdict never depends on it.

    It runs after the proxy log is saved, so the browser's own requests are not in the journey's recording.
    ponytail: one recording per run, of the first failing journey; record per failing check when two differ."""
    assertions = json.loads((run_dir / "result.json").read_text())["assertions"]
    journey = next((failure["logical_key"] for row in assertions if row["status"] == "fail" for failure in row.get("failures") or [] if failure.get("logical_key")), None)
    if not steps.is_file() or journey is None:
        return
    out = run_dir / "pledge" / "browser"
    out.mkdir(parents=True, exist_ok=True)
    command = ["node", str(Path(__file__).with_name("browser_runner.cjs")), str(steps), str(out)]
    env = {**os.environ, "NODE_PATH": PLAYWRIGHT_MODULES, "PLEDGE_JOURNEY": journey}
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=BROWSER_TIMEOUT_SECONDS, env=env)
        error = done.stderr[-2000:] if done.returncode else ""
    except (OSError, subprocess.TimeoutExpired) as exc:
        error = str(exc)[-2000:]
    files = sorted(name for name in BROWSER_FILES if (out / name).is_file())
    (out / "browser.json").write_text(json.dumps({"journey": journey, "files": files, "error": error}))
