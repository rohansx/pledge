"""Deterministic checks on what an agent phase produced. Runs inside the sandbox, next to the app:

    python3 -m pledge.check boot APP_DIR
    python3 -m pledge.check author APP_DIR RUNS_DIR

Prints one JSON object: {"problems": [...], ...}. An empty `problems` list means the phase's output is
accepted. The agent never decides this; it only gets the problems back.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from fnmatch import fnmatchcase
from pathlib import Path
from urllib.parse import urlsplit

from pledge import local
from pledge.faults import PlanError, parse_plan
from pledge.verdict import REACHES, PledgeError, load_pledges

SOURCES = ("stated", "domain_template", "inferred")
CALLERS_FILE = ".pledge/callers.json"
CALLER_KINDS = tuple(reach for reach in REACHES if reach != "api_only")  # a route nothing shipped calls has no callers
REPEATS = ("retries", "double_submit", "redelivers")
ROUTE = re.compile(r"^[A-Z]+ /\S*$")
EXTERNAL_URL = re.compile(r"""https?://(?!(?:127\.0\.0\.1|localhost)(?![\w.-]))[^\s"'`]+""")
ID_SEGMENT = re.compile(r"/(\d+|[0-9a-fA-F-]{16,})(?=/|$)")
MAX_UNLISTED = 8 # of the requests a scenario made that callers.json does not cover, named per scenario


def check_boot(app_dir: Path) -> dict:
    """The recipe must boot the app from cold, and the app must answer through the proxy."""
    try:
        local.down(app_dir)
        booted = local.boot(app_dir, {})
    except (local.BootError, OSError, KeyError, TypeError, ValueError) as exc:
        return {"problems": [f"`pledge boot` failed: {type(exc).__name__}: {exc}"]}
    try:
        urllib.request.urlopen(booted["target"], timeout=5)
    except urllib.error.HTTPError:
        pass  # any HTTP answer, even a 404 on /, shows the app is reachable through the proxy
    except (urllib.error.URLError, OSError) as exc:
        return {"problems": [f"the app does not answer at target {booted['target']} through the proxy: {exc}"]}
    return {"problems": [], "target": booted["target"], "services": sorted(booted["services"])}


def _inspect(scenario: Path) -> tuple[dict | None, str]:
    done = subprocess.run([sys.executable, "-m", "litetraffic", "inspect", str(scenario), "--json"], capture_output=True, text=True, timeout=60)
    try:
        payload = json.loads(done.stdout)
    except ValueError:
        return None, done.stderr[-400:] or "no output"
    return (payload, "") if payload.get("ok") else (None, str(payload.get("error")))


def load_callers(app_dir: Path) -> tuple[dict[str, list[dict]], list[str]]:
    """The caller inventory as {"METHOD /path": [caller, ...]}, and what is wrong with the file.

    A caller must point at a file that exists in the repository, so none can be asserted without something a
    reviewer can open. Whether that file really makes the call is for the reviewer."""
    path = app_dir / CALLERS_FILE
    try:
        document = json.loads(path.read_text())
    except OSError:
        return {}, [f"{CALLERS_FILE} is missing: inventory the application's real callers before writing scenarios"]
    except ValueError as exc:
        return {}, [f"{CALLERS_FILE}: not valid JSON: {exc}"]
    if not isinstance(document, dict) or document.get("schema_version") != 1 or not isinstance(document.get("routes"), list):
        return {}, [f"{CALLERS_FILE}: needs schema_version 1 and a `routes` list"]
    routes: dict[str, list[dict]] = {}
    problems: list[str] = []
    for index, entry in enumerate(document["routes"]):
        route, callers = (entry.get("route"), entry.get("callers")) if isinstance(entry, dict) else (None, None)
        if not isinstance(route, str) or not ROUTE.match(route) or not isinstance(callers, list):
            problems.append(f"{CALLERS_FILE}: routes[{index}] needs `route` as 'METHOD /path' and a `callers` list (empty when nothing shipped calls it)")
            continue
        routes[route] = callers
        for caller in callers:
            if (
                not isinstance(caller, dict)
                or caller.get("kind") not in CALLER_KINDS
                or not all(isinstance(caller.get(key), str) and caller[key] for key in ("ref", "evidence"))
                or not all(isinstance(caller.get(key), bool) for key in REPEATS)
            ):
                problems.append(f"{CALLERS_FILE}: {route}: each caller needs kind ({', '.join(CALLER_KINDS)}), ref, evidence, and true or false for {', '.join(REPEATS)}")
                continue
            ref = (app_dir / caller["ref"].split(":")[0]).resolve()
            if not ref.is_relative_to(app_dir.resolve()) or not ref.is_file():
                problems.append(f"{CALLERS_FILE}: {route}: caller ref {caller['ref']} is not a file in the repository")
    return routes, problems


def _listed(routes: dict[str, list[dict]], method: str, path: str) -> bool:
    """Whether the inventory covers this request. Either side may be a pattern: a faults file targets `/items/*`.
    A `*` stands for one path segment only, so `POST /*` cannot stand in for a whole API."""
    theirs = path.split("/")
    for route in routes:
        listed_method, _, listed_path = route.partition(" ")
        ours = listed_path.split("/")
        if listed_method == method and len(ours) == len(theirs) and all(fnmatchcase(a, b) or fnmatchcase(b, a) for a, b in zip(ours, theirs)):
            return True
    return False


def _unlisted(app_dir: Path, run_dir: Path, routes: dict[str, list[dict]]) -> list[str]:
    """Requests the scenario sent to the application that the caller inventory says nothing about."""
    recipe = local.load_recipe(app_dir)
    port = urlsplit(recipe["target"]).port
    app_routes = {name for name, route in recipe["routes"].items() if route.get("listen") == port}
    traffic = run_dir / "pledge" / "proxy_traffic.json"
    entries = json.loads(traffic.read_text()) if traffic.is_file() else []
    seen = {(entry["method"], entry["path"].split("?")[0]) for entry in entries if entry.get("route") in app_routes}
    # Named with ids folded to `*`, so twenty users' requests to one route read as the one route they are.
    return sorted({f"{method} {ID_SEGMENT.sub('/*', path)}" for method, path in seen if not _listed(routes, method, path)})


def _browser_problems(steps: Path) -> list[str]:
    """Browser steps must at least parse, and must stay inside the sandbox, where nothing else answers."""
    name = f"scenario {steps.parent.name}: {steps.name}"
    try:
        done = subprocess.run(["node", "--check", str(steps)], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return [f"{name} could not be checked with node: {exc}"]
    problems = [f"{name} does not load: {done.stderr.strip()[-400:]}"] if done.returncode else []
    external = sorted(set(EXTERNAL_URL.findall(steps.read_text(errors="replace"))))
    if external:
        problems.append(f"{name} names URLs outside the sandbox, which is closed: {', '.join(external[:3])}")
    return problems


def check_author(app_dir: Path, runs_dir: Path) -> dict:
    """The caller inventory is well formed and covers what the scenarios call, every scenario validates, every
    pledge points at a real assertion, is only proposed and says which real caller can break it, every faults
    file is one the proxy can apply, and each scenario's baseline run reaches a verdict."""
    routes, problems = load_callers(app_dir)
    kinds = {caller.get("kind") for callers in routes.values() for caller in callers if isinstance(caller, dict)}
    assertions: dict[str, list[str]] = {}
    scenario_dirs = sorted(path for path in (app_dir / ".pledge" / "scenarios").glob("*") if path.is_dir())
    if not scenario_dirs:
        problems.append("no scenario found under .pledge/scenarios/")
    for scenario in scenario_dirs:
        payload, error = _inspect(scenario)
        if payload is None:
            problems.append(f"scenario {scenario.name}: the engine rejects it: {error}")
        else:
            assertions[scenario.name] = payload["assertions"]
        if (scenario / local.BROWSER_STEPS).is_file():
            problems += _browser_problems(scenario / local.BROWSER_STEPS)

    try:
        pledges = load_pledges(app_dir)
    except PledgeError as exc:
        pledges = []
        problems.append(str(exc))
    if not pledges and not any("pledges" in problem for problem in problems):
        problems.append("no pledge found under .pledge/pledges/")
    for pledge in pledges:
        check = pledge["check"]
        if pledge["status"] != "proposed":
            problems.append(f"pledge {pledge['id']}: status must be 'proposed'; only a human approves a pledge")
        if pledge["source"] not in SOURCES:
            problems.append(f"pledge {pledge['id']}: source must be one of {', '.join(SOURCES)}")
        # Older pledge files load without these two; a newly authored pledge must carry both.
        if pledge.get("reach") not in REACHES or not pledge.get("trigger", "").strip():
            problems.append(f"pledge {pledge['id']}: needs `reach` ({', '.join(REACHES)}) and `trigger`, one sentence naming the real-world cause")
        elif pledge["reach"] != "api_only" and routes and pledge["reach"] not in kinds:
            # ponytail: only that such a caller exists somewhere in the inventory. Tying a pledge to the one route
            # that threatens it needs a route on the pledge file; add it if mislabelled reaches show up.
            problems.append(f"pledge {pledge['id']}: reach is '{pledge['reach']}' but {CALLERS_FILE} lists no caller of that kind; if nothing shipped can cause it, the reach is 'api_only'")
        if check["scenario"] in assertions and check["assertion"] not in assertions[check["scenario"]]:
            problems.append(f"pledge {pledge['id']}: scenario {check['scenario']} declares no assertion {check['assertion']}")
        if check["scenario"] not in assertions and not any(f"scenario {check['scenario']}:" in problem for problem in problems):
            problems.append(f"pledge {pledge['id']}: there is no scenario {check['scenario']}")

    for path in sorted((app_dir / ".pledge" / "faults").glob("*.json")):
        try:
            plan = parse_plan({"schema_version": 1, "seed": 0, "faults": json.loads(path.read_text())["faults"]})
            # Said here, while the author can still fix it; `pledge run` would only refuse it at scan time.
            services = {service["name"] for service in local.load_recipe(app_dir)["services"]}
            for fault in plan.faults:
                if fault.kind == "restart" and fault.service not in services:
                    problems.append(f"faults file {path.name}: faults[{fault.index}] restarts {fault.service!r}, which {local.BOOT_FILE} does not list as a service")
        except (PlanError, local.BootError, ValueError, KeyError, TypeError) as exc:
            problems.append(f"faults file {path.name}: {exc}")
            continue
        for fault in plan.faults:
            # A fault on the application's own route stands for something a caller does, so the caller must be on record.
            # ponytail: the application's route is taken to be named `app`, as verdict.app_down takes it.
            if routes and fault.route == "app" and not _listed(routes, fault.method, fault.path):
                problems.append(f"faults file {path.name}: it repeats {fault.method} {fault.path}, a route {CALLERS_FILE} does not list (a `*` there stands for one path segment)")

    baseline = []
    if not problems:  # only run what already validates
        for scenario in scenario_dirs:
            try:
                run = local.run(app_dir, scenario.name, None, 1, runs_dir)
            except (RuntimeError, OSError, urllib.error.URLError) as exc:
                problems.append(f"scenario {scenario.name}: the baseline run could not start: {exc}")
                continue
            result = json.loads((Path(run["run_dir"]) / "result.json").read_text())
            failing = [row["id"] for row in result["assertions"] if row["status"] == "fail"]
            baseline.append({"scenario": scenario.name, "verdict": run["verdict"], "failing_assertions": failing, "run_id": run["run_id"]})
            if run["verdict"] in ("error", "inconclusive"):
                # The scenario itself did not work. A pass or a fail is a real answer; these are not.
                problems.append(f"scenario {scenario.name}: the baseline run (no faults) was {run['verdict']}: " + "; ".join(result.get("limitations", [])[:6]))
                continue
            unlisted = _unlisted(app_dir, Path(run["run_dir"]), routes)
            if unlisted:
                more = f" and {len(unlisted) - MAX_UNLISTED} more" if len(unlisted) > MAX_UNLISTED else ""
                problems.append(f"scenario {scenario.name}: it calls routes {CALLERS_FILE} does not list ({', '.join(unlisted[:MAX_UNLISTED])}{more}); add each with its real callers, or with an empty `callers` list if nothing shipped calls it")
    return {"problems": problems, "baseline": baseline, "scenarios": sorted(assertions), "pledges": [pledge["id"] for pledge in pledges], "routes": sorted(routes)}


def main(argv: list[str] | None = None) -> None:
    args = sys.argv[1:] if argv is None else argv
    if len(args) == 2 and args[0] == "boot":
        report = check_boot(Path(args[1]).resolve())
    elif len(args) == 3 and args[0] == "author":
        report = check_author(Path(args[1]).resolve(), Path(args[2]).resolve())
    else:
        raise SystemExit(__doc__)
    print(json.dumps(report))


if __name__ == "__main__":
    main()
