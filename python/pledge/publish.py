"""Send a scan's result to the Pledge API so the dashboard can show it.

What is sent is a summary built from the run directories: per-pledge counts, each seed's expected and actual
values, the fault plan and the timings. The evidence files themselves stay where they are.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_API = "https://app.pledge.sh"
TOKEN_FILE = Path.home() / ".config/workz/pledge.env"
MAX_VALUE_CHARS = 2000  # of one expected or actual value, as JSON


def _bounded(value: object) -> object:
    text = json.dumps(value)
    return value if len(text) <= MAX_VALUE_CHARS else text[: MAX_VALUE_CHARS - 20] + "... [cut]"


def _seed(run_dir: Path, result: dict, assertion: str) -> dict:
    row = next((row for row in result["assertions"] if row["id"] == assertion), None)
    entry: dict = {"seed": result["seed"], "run_id": result["run_id"], "status": row["status"] if row else "unknown"}
    if row is None:
        return entry
    # An observation carries expected/actual itself; a per-journey check carries them on its failing samples.
    sample = row if "expected" in row or "actual" in row else (row.get("failures") or [{}])[0]
    for key in ("expected", "actual"):
        if sample.get(key) is not None:
            entry[key] = _bounded(sample[key])
    if row.get("failed"):
        entry["failed"] = row["failed"]
    return entry


def _authoring(app_dir: Path) -> dict | None:
    path = app_dir / ".pledge-runs" / "author-report.json"
    if not path.is_file():
        return None
    report = json.loads(path.read_text())
    final = report["phases"][-1]["result"]
    return {
        "seconds": report["seconds"],
        "phases": [
            {"phase": phase["phase"], "model": phase["model"], **{key: phase["usage"][key] for key in ("requests", "tokens", "cache_read_tokens", "output_tokens", "commands", "seconds", "rejected_finishes")}}
            for phase in report["phases"]
        ],
        "summary": str(final.get("summary", ""))[:6000],
        "open_questions": [str(question)[:1000] for question in final.get("open_questions", [])][:20],
    }


def build_record(app_dir: Path, report: dict, run_dirs: list[Path], faults_file: Path | None, env: dict[str, str], app: str | None = None) -> dict:
    """The scan as the API's schema wants it. `report` is what `pledge.verdict.verdict` returned."""
    results = [json.loads((run_dir / "result.json").read_text()) for run_dir in run_dirs]
    runs = []
    for run_dir, result in zip(run_dirs, results):
        injected = run_dir / "pledge" / "proxy_injected.json"
        runs.append({
            "seed": result["seed"], "run_id": result["run_id"], "verdict": result["verdict"],
            "faults_injected": len(json.loads(injected.read_text())) if injected.is_file() else 0,
            "journeys": int(result.get("metrics", {}).get("iterations") or 0),
            "limitations": [str(item)[:500] for item in result.get("limitations", [])][:20],
        })
    pledges = [
        {
            "id": row["id"], "statement": row["statement"][:1000], "status": row["status"], "source": row["source"],
            "confidence": row["confidence"], "assertion": row["assertion"], "result": row["result"],
            "kept": row["kept"], "broken": row["broken"], "unknown": row["unknown"],
            "seeds": [_seed(run_dir, result, row["assertion"]) for run_dir, result in zip(run_dirs, results)],
        }
        for row in report["pledges"] if "kept" in row
    ]
    faults = None
    if faults_file is not None:
        document = json.loads(faults_file.read_text())
        faults = {"name": faults_file.stem, "description": str(document.get("description", ""))[:1000], "faults": [{"kind": f["kind"], "target": f["target"], "params": f.get("params", {})} for f in document["faults"]]}
    sandbox = report.get("sandbox")
    return {
        "schema_version": 1,
        "app": app or app_dir.resolve().name,
        "scenario": report["scenario"],
        "verdict": report["verdict"],
        "faults": faults,
        "env": env,
        "pledges": pledges,
        "runs": sorted(runs, key=lambda run: run["seed"]),
        "sandbox": sandbox and {key: sandbox[key] for key in ("template", "outbound_blocked", "seconds")},
        "authoring": _authoring(app_dir),
    }


def _token() -> str:
    if os.environ.get("PLEDGE_API_TOKEN"):
        return os.environ["PLEDGE_API_TOKEN"]
    try:
        for line in TOKEN_FILE.read_text().splitlines():
            name, _, value = line.partition("=")
            if name == "PLEDGE_API_TOKEN" and value.strip():
                return value.strip()
    except OSError:
        pass
    raise RuntimeError(f"PLEDGE_API_TOKEN is not set and {TOKEN_FILE} does not have it")


def publish(record: dict) -> dict:
    """POST the record; returns the stored summary with the dashboard URL."""
    api = os.environ.get("PLEDGE_API_URL", DEFAULT_API).rstrip("/")
    request = urllib.request.Request(
        f"{api}/api/scans", data=json.dumps(record).encode(), method="POST",
        headers={"content-type": "application/json", "authorization": f"Bearer {_token()}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            summary = json.load(response)["data"]
    except urllib.error.HTTPError as error:
        try:
            detail = json.load(error).get("error")
        except ValueError:
            detail = error.reason
        raise RuntimeError(f"the API refused the scan (HTTP {error.code}): {detail}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"could not reach {api}: {error.reason}") from None
    return {**summary, "url": f"{api}/#/scans/{summary['id']}"}
