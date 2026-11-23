"""Turn the engine's per-assertion tally into a verdict per pledge: kept, broken or inconclusive, as counts."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

PLEDGE_STATUSES = ("proposed", "proven", "approved", "retired")


class PledgeError(ValueError):
    pass


def load_pledges(app_dir: Path) -> list[dict]:
    """Every pledge file under .pledge/pledges, validated."""
    pledges = []
    for path in sorted((app_dir / ".pledge" / "pledges").glob("*.json")):
        try:
            pledge = json.loads(path.read_text())
        except ValueError as exc:
            raise PledgeError(f"{path}: not valid JSON: {exc}") from None
        check = pledge.get("check") if isinstance(pledge, dict) else None
        if (
            not isinstance(pledge, dict)
            or pledge.get("schema_version") != 1
            or not all(isinstance(pledge.get(key), str) and pledge[key] for key in ("id", "statement", "source"))
            or not isinstance(check, dict)
            or not all(isinstance(check.get(key), str) and check[key] for key in ("scenario", "assertion"))
            or pledge.get("status") not in PLEDGE_STATUSES
        ):
            raise PledgeError(f"{path}: needs schema_version 1, id, statement, source, check.scenario, check.assertion and a status of {', '.join(PLEDGE_STATUSES)}")
        pledges.append(pledge)
    return pledges


def tally(run_dirs: list[Path]) -> dict:
    command = [sys.executable, "-m", "litetraffic", "tally", *map(str, run_dirs), "--json"]
    done = subprocess.run(command, capture_output=True, text=True, timeout=120)
    try:
        counts = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError(f"engine tally failed (exit {done.returncode}): {done.stderr[-500:]}") from None
    if "assertions" not in counts:
        raise RuntimeError(f"engine tally refused: {counts.get('error', counts)}")
    return counts


def judge(pledges: list[dict], counts: dict, scenario: str) -> dict:
    """One row per pledge that this scenario checks. Only approved pledges can make the overall verdict `broken`."""
    rows = []
    for pledge in pledges:
        if pledge["check"]["scenario"] != scenario or pledge["status"] == "retired":
            continue
        entry = counts["assertions"].get(pledge["check"]["assertion"])
        if entry is None:
            rows.append({"id": pledge["id"], "result": "inconclusive", "reason": "the scenario has no such assertion", "status": pledge["status"]})
            continue
        result = "broken" if entry["fail"] else "kept" if entry["pass"] == counts["runs"] else "inconclusive"
        rows.append({
            "id": pledge["id"], "statement": pledge["statement"], "status": pledge["status"], "result": result,
            "kept": entry["pass"], "broken": entry["fail"], "unknown": entry["unknown"], "broken_in": entry["failed_runs"],
        })
    blocking = [row for row in rows if row["status"] == "approved"]
    overall = "broken" if any(row["result"] == "broken" for row in blocking) else "kept" if blocking and all(row["result"] == "kept" for row in blocking) else "inconclusive"
    return {"schema_version": 1, "scenario": scenario, "runs": counts["runs"], "verdict": overall, "pledges": rows}


def verdict(app_dir: Path, run_dirs: list[Path]) -> dict:
    scenarios = {json.loads((run_dir / "run.json").read_text())["scenario"] for run_dir in run_dirs}
    if len(scenarios) != 1:
        raise PledgeError("runs are from different scenarios")
    return judge(load_pledges(app_dir), tally(run_dirs), scenarios.pop())


def format_verdict(report: dict) -> list[str]:
    lines = [f"{report['verdict'].upper()}  scenario {report['scenario']}  {report['runs']} runs"]
    for row in report["pledges"]:
        if "kept" not in row:
            lines.append(f"  {row['id']}: inconclusive ({row['reason']})")
            continue
        lines.append(f"  {row['id']}: {row['result'].upper()}  kept {row['kept']}  broken {row['broken']}  unknown {row['unknown']}  [{row['status']}]")
        lines += [f"    broken on seed {run.get('seed', '?')}  {run.get('run_id', '?')}" for run in row["broken_in"]]
    return lines
