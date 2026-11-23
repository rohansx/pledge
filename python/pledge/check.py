"""Deterministic checks on what an agent phase produced. Runs inside the sandbox, next to the app:

    python3 -m pledge.check boot APP_DIR
    python3 -m pledge.check author APP_DIR RUNS_DIR

Prints one JSON object: {"problems": [...], ...}. An empty `problems` list means the phase's output is
accepted. The agent never decides this; it only gets the problems back.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from pledge import local
from pledge.faults import PlanError, parse_plan
from pledge.verdict import PledgeError, load_pledges

SOURCES = ("stated", "domain_template", "inferred")


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


def check_author(app_dir: Path, runs_dir: Path) -> dict:
    """Every scenario validates, every pledge points at a real assertion and is only proposed, every faults
    file is one the proxy can apply, and each scenario's baseline run reaches a verdict."""
    problems: list[str] = []
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
        if check["scenario"] in assertions and check["assertion"] not in assertions[check["scenario"]]:
            problems.append(f"pledge {pledge['id']}: scenario {check['scenario']} declares no assertion {check['assertion']}")
        if check["scenario"] not in assertions and not any(f"scenario {check['scenario']}:" in problem for problem in problems):
            problems.append(f"pledge {pledge['id']}: there is no scenario {check['scenario']}")

    for path in sorted((app_dir / ".pledge" / "faults").glob("*.json")):
        try:
            parse_plan({"schema_version": 1, "seed": 0, "faults": json.loads(path.read_text())["faults"]})
        except (PlanError, ValueError, KeyError, TypeError) as exc:
            problems.append(f"faults file {path.name}: {exc}")

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
    return {"problems": problems, "baseline": baseline, "scenarios": sorted(assertions), "pledges": [pledge["id"] for pledge in pledges]}


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
