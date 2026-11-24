"""Boot an app with its fakes behind the fault proxy, and run one scenario against it under a fault plan.

These run wherever the app runs: inside a sandbox for a scan, or on a laptop for the hand loop.
"""

from __future__ import annotations

import html
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path
from urllib.parse import quote, quote_plus

from pledge.faults import MAX_HOLD_MS, PlanError, engine_kind, parse_plan
from pledge.proxy import DEFAULT_ADMIN_PORT

BOOT_FILE = "pledge.boot.json"
STATE_DIR = ".pledge-run"
ENV_FILE = "env.json"  # the extra environment `boot` was given, so a restarted service gets it again
HEALTH_TIMEOUT_SECONDS = 90
RESTART_COMMAND_TIMEOUT_SECONDS = 120
LOG_TAIL_LINES = 300
ADMIN_URL = f"http://127.0.0.1:{DEFAULT_ADMIN_PORT}"
BROWSER_STEPS = "browser.cjs"  # optional, next to a scenario's journeys.js
BROWSER_FILES = ("trace.zip", "video.webm", "screenshot.png")
BROWSER_TIMEOUT_SECONDS = 120
PLAYWRIGHT_MODULES = "/opt/pw/node_modules"  # where the sandbox has Playwright; see pledge.template
SECRETS_MARK = "PLEDGE_SECRETS "  # browser_runner.cjs ends its stdout with this and a JSON list
MIN_SECRET_CHARS = 6
MASK = b"********"


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


def _wait_healthy(name: str, url: str, process: subprocess.Popen | None, log_path: Path) -> None:
    """`process` is None for a service this module did not spawn (one the recipe's own `restart` command runs)."""
    deadline = time.monotonic() + HEALTH_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        if process is not None and process.poll() is not None:
            raise BootError(f"{name} exited with status {process.returncode}; see {log_path}")
        try:
            _http("GET", url, timeout=2)
            return
        except (urllib.error.URLError, OSError, ValueError):
            time.sleep(0.2)
    raise BootError(f"{name} was not healthy at {url} after {HEALTH_TIMEOUT_SECONDS}s; see {log_path}")


def _wait_gone(url: str, seconds: float = 10) -> None:
    """Until nothing answers at `url`: its port is free once the old process stops answering."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            _http("GET", url, timeout=1)
            time.sleep(0.1)
        except (urllib.error.URLError, OSError, ValueError):
            return


def _spawn(name: str, command: list[str], cwd: Path, env: dict[str, str], state: Path, log_mode: str = "w") -> tuple[subprocess.Popen, Path]:
    log_path = state / f"{name}.log"
    # A recipe says `python3`; use the interpreter that has pledge installed, which may be a virtualenv's.
    command = [sys.executable, *command[1:]] if command[0] == "python3" else command
    process = subprocess.Popen(command, cwd=cwd, env=env, stdout=log_path.open(log_mode), stderr=subprocess.STDOUT, start_new_session=True)
    return process, log_path


def _start_proxy(recipe: dict, app_dir: Path, state: Path) -> int:
    routes = [f"{name}={route['listen']}={route['upstream']}" for name, route in recipe["routes"].items()]
    # --app-dir is how the proxy gets a service restarted: it runs `pledge restart` on this directory.
    command = ["python3", "-m", "pledge.proxy", "--app-dir", str(app_dir), *(arg for route in routes for arg in ("--route", route))]
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
    _wait_gone(f"{ADMIN_URL}/healthz")
    pids["proxy"] = _start_proxy(load_recipe(app_dir), app_dir, state)
    (state / "pids.json").write_text(json.dumps(pids))


def restart_service(app_dir: Path, name: str) -> dict:
    """Kill one service of a booted app the way a crash would (SIGKILL, no chance to finish), start it again
    and return once it is healthy. The `restart` fault's control hook: the proxy runs `pledge restart`.

    A service this module spawned is killed by process group, so everything its command started in that
    group dies with it (a start script's database included). A service that lives elsewhere, such as a
    container the command started detached, survives a kill of the command; its recipe entry then needs a
    `restart` command of its own, for example ["sh", "-c", "docker kill db && docker start db"], which is run
    instead. ponytail: without that field a container is not restarted; teach this docker when recipes use it."""
    app_dir = app_dir.resolve()
    state = app_dir / STATE_DIR
    service = next((service for service in load_recipe(app_dir)["services"] if service["name"] == name), None)
    if service is None:
        raise BootError(f"{BOOT_FILE} has no service named {name!r}")
    pids_path = state / "pids.json"
    if not pids_path.exists():
        raise BootError(f"not booted (no {pids_path})")
    pids = json.loads(pids_path.read_text())
    log_path = state / f"{name}.log"
    env_path = state / ENV_FILE
    env = {**os.environ, **service.get("env", {}), **(json.loads(env_path.read_text()) if env_path.exists() else {})}
    process = None
    if "restart" in service:
        try:
            done = subprocess.run(service["restart"], cwd=app_dir, env=env, capture_output=True, text=True, timeout=RESTART_COMMAND_TIMEOUT_SECONDS)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise BootError(f"{name}: restart command failed: {exc}") from None
        if done.returncode:
            raise BootError(f"{name}: restart command exited {done.returncode}: {(done.stderr or done.stdout)[-300:]}")
    else:
        _kill({name: pids[name]}, signal.SIGKILL)
        _wait_gone(service["health"])
        process, log_path = _spawn(name, service["command"], app_dir, env, state, log_mode="a")  # keep what it logged before it died
        pids[name] = process.pid
        pids_path.write_text(json.dumps(pids))
    _wait_healthy(name, service["health"], process, log_path)
    return {"restarted": name}


def boot(app_dir: Path, extra_env: dict[str, str]) -> dict:
    """Start every service and the proxy, wait until each is healthy, and record their process ids."""
    app_dir = app_dir.resolve()
    recipe = load_recipe(app_dir)
    state = app_dir / STATE_DIR
    if (state / "pids.json").exists():
        raise BootError(f"already booted (found {state / 'pids.json'}); run `pledge down` first")
    state.mkdir(exist_ok=True)
    env_path = state / ENV_FILE
    env_path.touch(mode=0o600)  # may hold the customer's secrets; they are in the services' environment anyway
    env_path.write_text(json.dumps(extra_env))
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
        env_path.unlink(missing_ok=True)
        raise
    (state / "pids.json").write_text(json.dumps(pids))
    return {"services": pids, "target": recipe["target"]}


def _kill(pids: dict[str, int], how: signal.Signals = signal.SIGTERM) -> None:
    for pid in pids.values():
        try:
            os.killpg(pid, how)
        except ProcessLookupError:
            pass


def down(app_dir: Path) -> dict:
    path = app_dir.resolve() / STATE_DIR / "pids.json"
    pids = json.loads(path.read_text()) if path.exists() else {}
    _kill(pids)
    path.unlink(missing_ok=True)
    path.with_name(ENV_FILE).unlink(missing_ok=True)
    return {"stopped": sorted(pids)}


def run(app_dir: Path, scenario: str, faults_file: Path | None, seed: int, runs_dir: Path) -> dict:
    """One run: give the proxy this seed's fault plan, reset the fakes, let the engine drive and judge.

    Without `faults_file` the plan has no faults: a baseline run."""
    app_dir = app_dir.resolve()
    recipe = load_recipe(app_dir)
    faults = json.loads(faults_file.read_text())["faults"] if faults_file else []
    plan = {"schema_version": 1, "seed": seed, "faults": faults}
    try:
        restarts = {fault.service for fault in parse_plan(plan).faults if fault.kind == "restart"}
    except PlanError as exc:
        raise RuntimeError(f"fault plan: {exc}") from None
    unknown = restarts - {service["name"] for service in recipe["services"]}
    if unknown:
        raise RuntimeError(f"fault plan restarts {sorted(unknown)}, which {BOOT_FILE} does not list as a service")
    _http("PUT", f"{ADMIN_URL}/plan", plan)  # the proxy validates it; a plan it cannot apply stops the run here
    for url in recipe.get("reset", []):
        _http("POST", url, {})

    with tempfile.TemporaryDirectory() as tmp:
        plan_path = Path(tmp) / "fault_plan.json"
        # The engine only records the plan, under its own names for two of the kinds.
        plan_path.write_text(json.dumps({**plan, "faults": [{**fault, "kind": engine_kind(fault["kind"])} for fault in faults]}))
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
    log = _http("GET", f"{ADMIN_URL}/log", timeout=MAX_HOLD_MS / 1000 + 30)["data"]  # it waits for late second deliveries
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
    failed = [entry for entry in injected if entry["kind"] == "restart" and entry.get("error")]
    if failed:  # the rest of the run hit a dead service: what it shows is not evidence about the app
        raise RuntimeError(f"{failed[0]['service']} did not come back after the restart fault: {failed[0]['error']}")
    _record_browser(app_dir / ".pledge" / "scenarios" / scenario / BROWSER_STEPS, run_dir)
    return {"run_id": result["run_id"], "run_dir": str(run_dir), "seed": seed, "verdict": result["verdict"], "faults_injected": len(injected)}


def _record_browser(steps: Path, run_dir: Path) -> None:
    """When a check failed for a journey and the scenario has browser steps, record a browser showing what that
    journey's user now sees. Best effort: a run's verdict never depends on it.

    It runs after the proxy log is saved, so the browser's own requests are not in the journey's recording.
    ponytail: one recording per run, of the first failing journey; record per failing check when two differ."""
    assertions = json.loads((run_dir / "result.json").read_text())["assertions"]
    journey = next((failure["logical_key"] for row in assertions if row["status"] == "fail" for failure in row.get("failures") or [] if failure.get("logical_key")), None)
    if steps.is_file() and journey is not None:
        record_browser(steps, run_dir / "pledge" / "browser", journey)


def record_browser(steps: Path, out: Path, journey: str) -> dict:
    """Run a scenario's browser steps as `journey`'s user and keep the recording in `out`, with typed secrets masked."""
    out.mkdir(parents=True, exist_ok=True)
    command = ["node", str(Path(__file__).with_name("browser_runner.cjs")), str(steps), str(out)]
    env = {**os.environ, "NODE_PATH": os.environ.get("PLEDGE_PLAYWRIGHT_MODULES", PLAYWRIGHT_MODULES), "PLEDGE_JOURNEY": journey}
    secrets: list[str] | None = None
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=BROWSER_TIMEOUT_SECONDS, env=env)
        error = done.stderr[-2000:] if done.returncode else ""
        # The runner's last word on stdout is what was typed into password fields. It is used here and kept nowhere.
        told = [line for line in done.stdout.splitlines() if line.startswith(SECRETS_MARK)]
        secrets = [str(item) for item in json.loads(told[-1][len(SECRETS_MARK):])] if told else None
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        error = str(exc)[-2000:]
    trace = out / "trace.zip"
    if trace.is_file():
        try:
            if secrets is None:
                raise ValueError("the runner did not say what was typed")
            scrub_trace(trace, secrets)
        except (ValueError, OSError, zipfile.BadZipFile) as exc:
            # A trace that could not be masked may hold a password as typed. No trace is better than that one.
            trace.unlink()
            error = (error + f"\ntrace.zip dropped, it could not be masked: {exc}").strip()
    for secret in _maskable(secrets or []):
        error = error.replace(secret, MASK.decode())
    files = sorted(name for name in BROWSER_FILES if (out / name).is_file())
    info = {"journey": journey, "files": files, "error": error}
    (out / "browser.json").write_text(json.dumps(info))
    return info


def _maskable(secrets: list[str]) -> list[str]:
    """Longest first, so a password goes before its own prefixes, which typing key by key also reports.

    A secret's ASCII stretches are masked on their own as well: a page that is not UTF-8 submits `ü` as `%FC`,
    a spelling nothing here predicts, and the rest of the password would otherwise stay readable around it."""
    parts = {part for secret in secrets for part in (secret, *re.split(r"[^\x00-\x7f]+", secret))}
    return sorted((part for part in parts if len(part) >= MIN_SECRET_CHARS), key=len, reverse=True)


def scrub_trace(trace: Path, secrets: list[str]) -> None:
    """Rewrite a Playwright trace with every spelling of each typed secret replaced.

    Playwright cannot leave an action's parameters out of a trace, and the value is in more places than the
    action: the page snapshots after it and the body of the request that submits it. So the trace is recorded
    whole and every file in it is rewritten here.

    ponytail: byte replacement of the spellings a value takes as text. It does not find a secret that was
    transformed (base64 in a Basic header, a hash), one shorter than MIN_SECRET_CHARS (masking "abc" everywhere
    would wreck the trace), or one drawn as pixels in the screenshots and the video (a password field draws
    dots, unless the page has a show-password toggle and the steps click it). Tokens and cookies the app hands
    the synthetic user are left in. Typed key by key, every prefix of MIN_SECRET_CHARS or more is masked too
    (the snapshots between keys hold them), so a password that starts with a common word blanks that word
    wherever the trace has it, `type="password"` included, and its first five characters stay readable. Parse the trace's JSON instead if any of these starts to matter."""
    spellings: list[bytes] = []
    for secret in _maskable(secrets):
        once = json.dumps(secret)[1:-1]
        raw = json.dumps(secret, ensure_ascii=False)[1:-1]  # as JavaScript writes it: non-ASCII left alone
        forms = [secret, once, raw, json.dumps(once)[1:-1], json.dumps(raw, ensure_ascii=False)[1:-1], quote(secret, safe=""), quote_plus(secret), html.escape(secret)]
        spellings += [form.encode() for form in dict.fromkeys(sorted(forms, key=len, reverse=True))]
    if not spellings:
        return
    masked = trace.with_name(trace.name + ".masked")
    with zipfile.ZipFile(trace) as source, zipfile.ZipFile(masked, "w", zipfile.ZIP_DEFLATED) as target:
        for item in source.infolist():
            data = source.read(item)
            for spelling in spellings:
                data = data.replace(spelling, MASK)
            target.writestr(item.filename, data)
    masked.replace(trace)
